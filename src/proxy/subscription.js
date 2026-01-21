import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { ProxyAgent } from "undici"
import { ensureLimitedPanelRsBinary } from "../rust/runner.js"
import { createLogger } from "../utils/log.js"

const log = createLogger("代理")

function toList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (value == null || value === "") return []
  return String(value)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase()
  return ["1", "true", "yes", "y", "on"].includes(s)
}

function normalizeHttpProxyUrl(raw) {
  const s = String(raw || "").trim()
  if (!s) return ""
  if (s.includes("://")) return s
  return `http://${s}`
}

function safeUrlForLog(url) {
  try {
    const u = new URL(String(url))
    u.username = ""
    u.password = ""
    return u.toString()
  } catch {
    return String(url || "")
  }
}

function createHttpProxyAgent(httpProxy) {
  const normalized = normalizeHttpProxyUrl(httpProxy)
  if (!normalized) return null
  try {
    return new ProxyAgent(normalized)
  } catch {
    return null
  }
}

async function curlFetch(url, { timeoutMs = 15_000, insecureSkipVerify = false, httpProxy } = {}) {
  return await new Promise((resolve, reject) => {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    // Allow some extra wall time for curl's internal retries.
    const maxTimeSec = Math.max(seconds, seconds * 3 + 5)
    const normalizedProxy = normalizeHttpProxyUrl(httpProxy)
    const args = [
      "-fsSL",
      ...(insecureSkipVerify ? ["-k"] : []),
      ...(normalizedProxy ? ["-x", normalizedProxy] : []),
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "--http1.1",
      "--retry",
      "5",
      "--retry-delay",
      "2",
      "--retry-all-errors",
      "--connect-timeout",
      "8",
      "--retry-max-time",
      String(maxTimeSec),
      "--max-time",
      String(maxTimeSec),
      url
    ]
    const child = spawn("curl", args, { windowsHide: true })
    const bufs = []
    const errBufs = []
    const tid = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs + 2000)
    child.stdout.on("data", (d) => bufs.push(d))
    child.stderr.on("data", (d) => errBufs.push(d))
    child.on("error", (e) => {
      clearTimeout(tid)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(tid)
      const out = Buffer.concat(bufs).toString("utf8")
      if (code === 0 && out.trim()) return resolve(out)
      const err = Buffer.concat(errBufs).toString("utf8")
      reject(new Error(`curl failed (${code}): ${err || out || "empty"}`))
    })
  })
}

function normalizeHttpUrl(raw) {
  const s = String(raw || "").trim()
  if (!s) return s
  try {
    // Ensure the URL is properly percent-encoded (some providers reject non-ASCII paths).
    return new URL(s).toString()
  } catch {
    return s
  }
}

async function fetchText(url, { timeoutMs = 15_000, insecureSkipVerify = false, httpProxy, maxAttempts = 6, curlFallback = true } = {}) {
  const normalizedUrl = normalizeHttpUrl(url)
  const dispatcher = createHttpProxyAgent(httpProxy)
  if (dispatcher) log.debug(`订阅拉取使用 HTTP 代理：${safeUrlForLog(httpProxy)}`)
  // If user explicitly requests insecure TLS, skip undici fetch (still validates TLS) and go straight to curl -k.
  if (insecureSkipVerify) {
    return await curlFetch(normalizedUrl, { timeoutMs, insecureSkipVerify: true, httpProxy })
  }
  const attempts = Math.max(1, Number(maxAttempts) || 6)
  let lastErr = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(normalizedUrl, {
        redirect: "follow",
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          // Some subscription sites reset connections for unknown/empty UA.
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "*/*"
        }
      })
      const text = await res.text()
      if (!res.ok) {
        const bodyShort = String(text || "").slice(0, 300)
        // Retry on transient server errors.
        if (res.status >= 500 && attempt < maxAttempts) {
          lastErr = new Error(`Subscription HTTP ${res.status}: ${bodyShort}`)
        } else {
          throw new Error(`Subscription HTTP ${res.status}: ${bodyShort}`)
        }
      } else {
        return text
      }
    } catch (e) {
      lastErr = e
    } finally {
      clearTimeout(tid)
    }

    if (attempt < attempts) {
      const backoff = Math.min(8000, 500 * Math.pow(2, attempt - 1))
      await new Promise((r) => setTimeout(r, backoff))
    }
  }

  if (!curlFallback) {
    throw lastErr || new Error(`Subscription fetch failed: ${normalizedUrl}`)
  }

  // Fallback: curl sometimes works better with certain subscription sites.
  let curlErr = null
  try {
    return await curlFetch(normalizedUrl, { timeoutMs, insecureSkipVerify, httpProxy })
  } catch (e) {
    curlErr = e
  }

  if (lastErr && curlErr) {
    throw new AggregateError([lastErr, curlErr], `Subscription fetch failed: ${normalizedUrl}`)
  }
  throw curlErr || lastErr || new Error(`Subscription fetch failed: ${normalizedUrl}`)
}

function sha1Hex(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex")
}

function normalizeCacheDir(cacheDir) {
  const raw = String(cacheDir || "").trim()
  if (!raw) return path.resolve("data", "proxy", "subscription-cache")
  return path.isAbsolute(raw) ? raw : path.resolve(raw)
}

async function readCacheFile(cachePath, { ttlSec = 0 } = {}) {
  try {
    const st = await fsp.stat(cachePath)
    if (ttlSec > 0) {
      const ageMs = Date.now() - st.mtimeMs
      if (ageMs > ttlSec * 1000) return null
    }
    const txt = await fsp.readFile(cachePath, "utf8")
    return txt && txt.trim() ? txt : null
  } catch {
    return null
  }
}

async function writeCacheFile(cachePath, text) {
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true })
    await fsp.writeFile(cachePath, text, "utf8")
  } catch {
    // best-effort
  }
}

async function parseSubscriptionTextRust(txt = "", { rustBin } = {}) {
  const bin = rustBin || (await ensureLimitedPanelRsBinary())
  const child = spawn(bin, ["sub-parse", "--stdin"], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true
  })

  child.stdin.end(String(txt || ""), "utf8")

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const exitCodePromise = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  })

  const nodes = []
  for await (const line of rl) {
    const s = String(line || "").trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s)
      if (obj && typeof obj === "object") nodes.push(obj)
    } catch {
      // ignore invalid jsonl line
    }
  }

  const code = await exitCodePromise
  if (code !== 0) throw new Error(`rust sub-parse failed (code=${code})`)
  return Array.isArray(nodes) ? nodes : []
}

export function nodeKey(n) {
  if (!n) return ""
  return [n.type || "", n.host || "", n.port || "", n.id || n.password || n.method || ""].join("|")
}

function dedupeNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const seen = new Set()
  const out = []
  for (const n of list) {
    const key = nodeKey(n)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

export async function parseSubscriptionTextAsync(txt = "", { rustBin } = {}) {
  const bin = rustBin || (await ensureLimitedPanelRsBinary())
  const nodes = await parseSubscriptionTextRust(txt, { rustBin: bin })
  return dedupeNodes(nodes)
}

export async function loadSubscriptionNodes(
  urls,
  {
    timeoutMs = 15_000,
    cacheDir,
    cacheTtlSec = 0,
    useCacheOnFail = true,
    insecureSkipVerify = false,
    httpProxy = "",
    parser: _parser = "auto"
  } = {}
) {
  const list = toList(urls)
  if (!list.length) return []

  const rustBin = await ensureLimitedPanelRsBinary()
  const all = []
  const errs = []

  const resolvedCacheDir = normalizeCacheDir(process.env.PROXY_SUB_CACHE_DIR || cacheDir || "")
  const resolvedCacheTtlSec = Number(process.env.PROXY_SUB_CACHE_TTL_SEC || cacheTtlSec) || 0
  const resolvedUseCacheOnFail = toBool(
    process.env.PROXY_SUB_USE_CACHE_ON_FAIL ?? (useCacheOnFail ? "1" : "0")
  )
  const resolvedInsecureSkipVerify = toBool(
    process.env.PROXY_SUB_INSECURE_SKIP_VERIFY ?? (insecureSkipVerify ? "1" : "0")
  )
  const resolvedHttpProxy = normalizeHttpProxyUrl(process.env.PROXY_SUB_HTTP_PROXY || httpProxy || "")

  for (const url of list) {
    let txt
    const cachePath = path.join(resolvedCacheDir, `${sha1Hex(normalizeHttpUrl(url))}.txt`)
    const cached = resolvedUseCacheOnFail ? await readCacheFile(cachePath, { ttlSec: resolvedCacheTtlSec }) : null
    const hasCache = Boolean(cached && String(cached).trim())

    const fastTimeoutMs = Math.max(1000, Number(process.env.PROXY_SUB_FAST_TIMEOUT_MS || 8000) || 8000)
    const fetchTimeoutMs = hasCache ? Math.min(timeoutMs, fastTimeoutMs) : timeoutMs
    const fetchMaxAttempts = hasCache ? 1 : 6
    const fetchCurlFallback = !hasCache

    try {
      txt = await fetchText(url, {
        timeoutMs: fetchTimeoutMs,
        insecureSkipVerify: resolvedInsecureSkipVerify,
        httpProxy: resolvedHttpProxy,
        maxAttempts: fetchMaxAttempts,
        curlFallback: fetchCurlFallback
      })
      // Save cache on success.
      if (txt && txt.trim()) await writeCacheFile(cachePath, txt)
    } catch (e) {
      errs.push({ url, error: e })
      const causeMsg = e?.cause?.message ? ` (cause=${e.cause.message})` : ""
      const msg =
        e instanceof AggregateError
          ? `${e.message}; causes=${e.errors?.map((x) => x?.message || String(x)).join(" | ")}`
          : `${e?.message || String(e)}${causeMsg}`
      if (resolvedUseCacheOnFail) {
        if (cached) {
          log.warn(`订阅拉取失败，使用缓存：${url} (${msg})`)
          txt = cached
        } else {
          log.warn(`订阅拉取失败：${url} (${msg})`)
          continue
        }
      } else {
        log.warn(`订阅拉取失败：${url} (${msg})`)
        continue
      }
    }

    try {
      all.push(...(await parseSubscriptionTextRust(txt, { rustBin })))
    } catch (e) {
      errs.push({ url, error: e })
      const msg = e?.message || String(e)
      log.warn(`订阅解析失败(rust)：${url} (${msg})`)
    }
  }

  const out = dedupeNodes(all)

  if (!out.length && errs.length) {
    throw new AggregateError(
      errs.map((x) => x.error),
      `订阅全部失败（${errs.length}/${list.length}）`
    )
  }
  return out
}
