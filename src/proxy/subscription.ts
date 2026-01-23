import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { ProxyAgent } from "undici"
import { createRequire } from "node:module"
import { createLogger } from "../utils/log.js"

const log = createLogger("代理")
const require = createRequire(import.meta.url)
const yaml = require("js-yaml")

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

async function curlFetch(url, { timeoutMs = 15_000, insecureSkipVerify = false, httpProxy }: any = {}) {
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

async function fetchText(
  url,
  { timeoutMs = 15_000, insecureSkipVerify = false, httpProxy, maxAttempts = 6, curlFallback = true }: any = {}
) {
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

function stripBom(text) {
  const s = String(text || "")
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function looksLikeBase64(text) {
  const s = String(text || "").trim()
  if (s.length < 32) return false
  if (s.includes("\n") || s.includes("\r")) return false
  if (/[^A-Za-z0-9+/=_-]/.test(s)) return false
  return true
}

function safeBase64Decode(text) {
  const s = String(text || "").trim()
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/")
    const buf = Buffer.from(normalized, "base64")
    const out = buf.toString("utf8")
    return out && out.trim() ? out : null
  } catch {
    return null
  }
}

function maybeDecodeSubscriptionText(rawText) {
  const txt0 = stripBom(String(rawText || "")).trim()
  if (!txt0) return ""
  if (/^(vmess|vless|trojan|ss|ssr|hysteria2|tuic):\/\//i.test(txt0)) return txt0
  if (/^\s*(proxies|proxy-groups|proxy-providers)\s*:/im.test(txt0)) return txt0
  // Common: base64 of lines.
  if (looksLikeBase64(txt0)) {
    const decoded = safeBase64Decode(txt0)
    if (decoded && /:\/\//.test(decoded)) return decoded
  }
  return txt0
}

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function decodeHashTag(raw) {
  const s = String(raw || "")
  const i = s.indexOf("#")
  if (i < 0) return { base: s, tag: "" }
  const base = s.slice(0, i)
  const hash = s.slice(i + 1)
  try {
    return { base, tag: decodeURIComponent(hash) }
  } catch {
    return { base, tag: hash }
  }
}

function parseVmess(uri) {
  const { base, tag } = decodeHashTag(uri)
  const payload = String(base || "").slice("vmess://".length)
  const decoded = safeBase64Decode(payload)
  if (!decoded) return null
  let obj
  try {
    obj = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const host = String(obj.add || obj.host || "").trim()
  const port = Number(obj.port || 0)
  const id = String(obj.id || "").trim()
  if (!host || !Number.isFinite(port) || port <= 0 || !id) return null
  const net = String(obj.net || "tcp").trim() || "tcp"
  const tls = String(obj.tls || "").trim()
  const sni = String(obj.sni || obj.servername || "").trim()
  const wsHost = String(obj.host || "").trim()
  const wsPath = String(obj.path || "").trim()
  const grpcServiceName = String(obj.path || "").trim()

  return {
    type: "vmess",
    tag: tag || String(obj.ps || "").trim() || "",
    host,
    port,
    id,
    alterId: Number(obj.aid || 0) || 0,
    security: String(obj.scy || obj.security || "auto").trim() || "auto",
    net,
    tls: tls ? String(tls).toLowerCase() : "",
    sni,
    allowInsecure: false,
    ...(net === "ws" ? { wsHost, wsPath } : {}),
    ...(net === "grpc" ? { grpcServiceName } : {})
  }
}

function parseVlessOrTrojan(uri, scheme) {
  const { base, tag } = decodeHashTag(uri)
  let u
  try {
    u = new URL(base)
  } catch {
    return null
  }
  const host = String(u.hostname || "").trim()
  const port = Number(u.port || 0)
  if (!host || !Number.isFinite(port) || port <= 0) return null

  const params = u.searchParams
  const net = String(params.get("type") || params.get("network") || "tcp").trim() || "tcp"
  const security = String(params.get("security") || "").trim().toLowerCase()
  const tls =
    security === "tls" ? "tls" :
    security === "reality" ? "reality" :
    ""
  const sni = String(params.get("sni") || params.get("servername") || "").trim()
  const wsHost = String(params.get("host") || "").trim()
  const wsPath = String(params.get("path") || "").trim()
  const grpcServiceName = String(params.get("serviceName") || params.get("service") || "").trim()

  if (scheme === "vless") {
    const id = String(decodeURIComponent(u.username || "") || "").trim()
    if (!id) return null
    const encryption = String(params.get("encryption") || "none").trim() || "none"
    const flow = String(params.get("flow") || "").trim()
    const realityPublicKey = String(params.get("pbk") || "").trim()
    const realityShortId = String(params.get("sid") || "").trim()
    return {
      type: "vless",
      tag: tag || String(u.hash || "").replace(/^#/, "") || "",
      host,
      port,
      id,
      encryption,
      ...(flow ? { flow } : {}),
      net,
      tls,
      sni,
      allowInsecure: false,
      ...(net === "ws" ? { wsHost, wsPath } : {}),
      ...(net === "grpc" ? { grpcServiceName } : {}),
      ...(tls === "reality"
        ? { realityPublicKey, realityShortId }
        : {})
    }
  }

  if (scheme === "trojan") {
    const password = String(decodeURIComponent(u.username || "") || "").trim()
    if (!password) return null
    return {
      type: "trojan",
      tag: tag || "",
      host,
      port,
      password,
      net,
      tls: "tls",
      sni: sni || "",
      allowInsecure: false,
      ...(net === "ws" ? { wsHost, wsPath } : {}),
      ...(net === "grpc" ? { grpcServiceName } : {})
    }
  }

  return null
}

function splitAtLast(s, ch) {
  const i = String(s || "").lastIndexOf(ch)
  if (i < 0) return [String(s || ""), ""]
  return [s.slice(0, i), s.slice(i + 1)]
}

function parseSs(uri) {
  const { base, tag } = decodeHashTag(uri)
  const rest = String(base || "").slice("ss://".length)
  if (!rest) return null

  // ss://<base64(method:pass@host:port)> or ss://method:pass@host:port
  let decoded = rest
  if (!rest.includes("@")) {
    const tryDecode = safeBase64Decode(rest)
    if (tryDecode && tryDecode.includes("@")) decoded = tryDecode
  }

  const [userinfo, hostport] = splitAtLast(decoded, "@")
  if (!userinfo || !hostport) return null
  const [method, password] = (() => {
    const [m, p] = splitAtLast(userinfo, ":")
    return [m, p]
  })()
  const methodTrim = String(method || "").trim()
  const passTrim = String(password || "").trim()
  if (!methodTrim || !passTrim) return null

  let host = ""
  let port = 0
  const hp = String(hostport || "").trim()
  if (hp.startsWith("[")) {
    const close = hp.indexOf("]")
    if (close > 0) {
      host = hp.slice(1, close)
      const p = hp.slice(close + 1).replace(/^:/, "")
      port = Number(p || 0)
    }
  } else {
    const [h, p] = splitAtLast(hp, ":")
    host = String(h || "").trim()
    port = Number(p || 0)
  }
  if (!host || !Number.isFinite(port) || port <= 0) return null

  return {
    type: "ss",
    tag: tag || "",
    host,
    port,
    method: methodTrim,
    password: passTrim
  }
}

function nodeFromClashProxy(p) {
  const proxy = p && typeof p === "object" ? p : null
  if (!proxy) return null
  const type = String(proxy.type || "").trim()
  const server = String(proxy.server || "").trim()
  const port = Number(proxy.port || 0)
  const name = String(proxy.name || "").trim()
  if (!type || !server || !Number.isFinite(port) || port <= 0) return null
  const net = String(proxy.network || "tcp").trim() || "tcp"

  const common = {
    type: type.toLowerCase(),
    tag: name,
    host: server,
    port,
    net,
    tls: proxy.tls ? "tls" : "",
    sni: String(proxy.sni || proxy.servername || "").trim(),
    wsHost: String(proxy?.["ws-opts"]?.headers?.Host || "").trim(),
    wsPath: String(proxy?.["ws-opts"]?.path || "").trim(),
    grpcServiceName: String(proxy?.["grpc-opts"]?.["grpc-service-name"] || "").trim(),
    // Keep original proxy object for mihomo (best protocol coverage).
    clash: proxy
  }

  if (common.type === "vmess") {
    return {
      ...common,
      id: String(proxy.uuid || "").trim(),
      alterId: Number(proxy.alterId || 0) || 0,
      security: String(proxy.cipher || "auto").trim() || "auto"
    }
  }
  if (common.type === "vless") {
    return {
      ...common,
      id: String(proxy.uuid || "").trim(),
      encryption: String(proxy.encryption || "none").trim() || "none",
      flow: String(proxy.flow || "").trim() || ""
    }
  }
  if (common.type === "trojan") {
    return {
      ...common,
      password: String(proxy.password || "").trim()
    }
  }
  if (common.type === "ss") {
    return {
      ...common,
      method: String(proxy.cipher || "").trim(),
      password: String(proxy.password || "").trim()
    }
  }

  // Advanced protocols: keep as clash passthrough.
  return common
}

function parseSubscriptionTextJs(txt = "") {
  const raw = maybeDecodeSubscriptionText(txt)
  if (!raw) return []

  // Clash YAML
  if (/^\s*(proxies|proxy-groups|proxy-providers)\s*:/im.test(raw)) {
    try {
      const obj = yaml.load(raw) || {}
      const proxies = Array.isArray(obj?.proxies) ? obj.proxies : []
      const nodes = proxies.map(nodeFromClashProxy).filter(Boolean)
      return Array.isArray(nodes) ? nodes : []
    } catch (e) {
      log.warn(`Clash YAML 解析失败：${e?.message || String(e)}`)
      return []
    }
  }

  const lines = splitLines(raw)
  const out = []
  for (const line0 of lines) {
    const line = String(line0 || "").trim()
    if (!line) continue
    if (line.startsWith("vmess://")) out.push(parseVmess(line))
    else if (line.startsWith("vless://")) out.push(parseVlessOrTrojan(line, "vless"))
    else if (line.startsWith("trojan://")) out.push(parseVlessOrTrojan(line, "trojan"))
    else if (line.startsWith("ss://")) out.push(parseSs(line))
  }
  return out.filter(Boolean)
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

export async function parseSubscriptionTextAsync(txt = "", { rustBin }: any = {}) {
  // v2: Rust parser removed; JS parser only.
  return dedupeNodes(parseSubscriptionTextJs(txt))
}

export async function loadSubscriptionNodes(
  urls,
  {
    timeoutMs = 15_000,
    cacheDir,
    cacheTtlSec = 0,
    useCacheOnFail = true,
    insecureSkipVerify = false,
    httpProxy = ""
  }: any = {}
) {
  const list = toList(urls)
  if (!list.length) return []

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
      all.push(...parseSubscriptionTextJs(txt))
    } catch (e) {
      errs.push({ url, error: e })
      const msg = e?.message || String(e)
      log.warn(`订阅解析失败：${url} (${msg})`)
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
