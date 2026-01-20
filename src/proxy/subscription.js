import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"

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

function looksLikeBase64(text = "") {
  const s = String(text || "").trim()
  if (!s) return false
  if (/^https?:\/\//i.test(s)) return false
  // Base64 subscriptions are usually long.
  if (s.length < 16) return false
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s)
}

function decodeBase64ToUtf8(s) {
  try {
    const buf = Buffer.from(String(s).replace(/\s+/g, ""), "base64")
    const txt = buf.toString("utf8")
    return txt && txt.trim() ? txt : null
  } catch {
    return null
  }
}

function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase()
  return ["1", "true", "yes", "y", "on"].includes(s)
}

async function curlFetch(url, { timeoutMs = 15_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    // Allow some extra wall time for curl's internal retries.
    const maxTimeSec = Math.max(seconds, seconds * 3 + 5)
    const args = [
      "-fsSL",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "--http1.1",
      "--retry", "5",
      "--retry-delay", "2",
      "--retry-all-errors",
      "--connect-timeout", "8",
      "--retry-max-time", String(maxTimeSec),
      "--max-time", String(maxTimeSec),
      url
    ]
    const child = spawn("curl", args, { windowsHide: true })
    const bufs = []
    const errBufs = []
    const tid = setTimeout(() => {
      try { child.kill() } catch {}
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

async function fetchText(url, { timeoutMs = 15_000 } = {}) {
  const normalizedUrl = normalizeHttpUrl(url)
  const maxAttempts = 6
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(normalizedUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Some subscription sites reset connections for unknown/empty UA.
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    if (attempt < maxAttempts) {
      const backoff = Math.min(8000, 500 * Math.pow(2, attempt - 1))
      await new Promise((r) => setTimeout(r, backoff))
    }
  }

  // Fallback: curl sometimes works better with certain subscription sites.
  let curlErr = null
  try {
    return await curlFetch(normalizedUrl, { timeoutMs })
  } catch (e) {
    curlErr = e
  }

  if (lastErr && curlErr) {
    throw new AggregateError(
      [lastErr, curlErr],
      `Subscription fetch failed: ${normalizedUrl}`
    )
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

function parseVmessUri(uri) {
  const raw = String(uri || "").trim()
  const b64 = raw.replace(/^vmess:\/\//i, "").trim()
  const jsonText = decodeBase64ToUtf8(b64)
  if (!jsonText) return null
  let obj
  try {
    obj = JSON.parse(jsonText)
  } catch {
    return null
  }
  const host = String(obj.add || obj.host || "").trim()
  const port = Number(obj.port || 0)
  const id = String(obj.id || "").trim()
  if (!host || !Number.isFinite(port) || port <= 0 || !id) return null
  const tag = String(obj.ps || "").trim() || `vmess:${host}:${port}`
  return {
    type: "vmess",
    tag,
    host,
    port,
    id,
    alterId: Number(obj.aid || 0) || 0,
    security: String(obj.scy || obj.cipher || "auto").trim() || "auto",
    net: String(obj.net || "tcp").trim() || "tcp",
    tls: String(obj.tls || "").trim(),
    sni: String(obj.sni || obj.serverName || "").trim(),
    allowInsecure: toBool(obj.allowInsecure ?? obj.allow_insecure ?? obj.skipCertVerify ?? obj["skip-cert-verify"]),
    wsHost: String(obj.host || "").trim(),
    wsPath: String(obj.path || "").trim()
  }
}

function parseSsUri(uri) {
  const raw = String(uri || "").trim()
  // ss://base64(method:pass)@host:port#name  OR ss://method:pass@host:port#name
  const noScheme = raw.replace(/^ss:\/\//i, "")
  const [beforeHash, hash = ""] = noScheme.split("#")
  const tag = decodeURIComponent(hash || "").trim()

  let main = beforeHash
  // strip plugin params
  const qIdx = main.indexOf("?")
  if (qIdx >= 0) main = main.slice(0, qIdx)

  // if no '@', credentials are base64 in whole part
  let credsPart
  let hostPart
  if (main.includes("@")) {
    ;[credsPart, hostPart] = main.split("@")
  } else {
    const decoded = decodeBase64ToUtf8(main)
    if (!decoded || !decoded.includes("@")) return null
    ;[credsPart, hostPart] = decoded.split("@")
  }

  // creds can be base64 too
  if (looksLikeBase64(credsPart) && !credsPart.includes(":")) {
    const decoded = decodeBase64ToUtf8(credsPart)
    if (decoded) credsPart = decoded
  }

  const [method = "", password = ""] = String(credsPart || "").split(":")
  const [host = "", portRaw = ""] = String(hostPart || "").split(":")
  const port = Number(portRaw)
  if (!host || !Number.isFinite(port) || port <= 0 || !method || !password) return null

  return {
    type: "ss",
    tag: tag || `ss:${host}:${port}`,
    host,
    port,
    method,
    password
  }
}

function parseUriCommon(uri) {
  try {
    const u = new URL(String(uri))
    const type = u.protocol.replace(":", "").toLowerCase()
    const tag = decodeURIComponent((u.hash || "").replace(/^#/, "")).trim()
    const host = u.hostname
    const port = Number(u.port || 0)
    const user = decodeURIComponent(u.username || "")
    const password = decodeURIComponent(u.password || "")
    const params = Object.fromEntries(u.searchParams.entries())
    return { type, tag, host, port, user, password, params }
  } catch {
    return null
  }
}

function parseVlessUri(uri) {
  const u = parseUriCommon(uri)
  if (!u || u.type !== "vless") return null
  if (!u.host || !Number.isFinite(u.port) || u.port <= 0 || !u.user) return null
  const net = String(u.params.type || "tcp").trim() || "tcp"
  const security = String(u.params.security || "").trim()
  return {
    type: "vless",
    tag: u.tag || `vless:${u.host}:${u.port}`,
    host: u.host,
    port: u.port,
    id: u.user,
    encryption: String(u.params.encryption || "none").trim() || "none",
    flow: String(u.params.flow || "").trim(),
    net,
    tls: security,
    sni: String(u.params.sni || u.params.serverName || "").trim(),
    allowInsecure: toBool(u.params.allowInsecure ?? u.params.allow_insecure ?? u.params.insecure),
    wsHost: String(u.params.host || "").trim(),
    wsPath: String(u.params.path || "").trim(),
    grpcServiceName: String(u.params.serviceName || "").trim()
  }
}

function parseTrojanUri(uri) {
  const u = parseUriCommon(uri)
  if (!u || u.type !== "trojan") return null
  if (!u.host || !Number.isFinite(u.port) || u.port <= 0 || !u.user) return null
  const net = String(u.params.type || "tcp").trim() || "tcp"
  const security = String(u.params.security || "tls").trim() || "tls"
  return {
    type: "trojan",
    tag: u.tag || `trojan:${u.host}:${u.port}`,
    host: u.host,
    port: u.port,
    password: u.user,
    net,
    tls: security,
    sni: String(u.params.sni || u.params.peer || "").trim(),
    allowInsecure: toBool(u.params.allowInsecure ?? u.params.allow_insecure ?? u.params.insecure),
    wsHost: String(u.params.host || "").trim(),
    wsPath: String(u.params.path || "").trim(),
    grpcServiceName: String(u.params.serviceName || "").trim()
  }
}

function parseClashYaml(text) {
  let doc
  try {
    doc = yaml.load(text)
  } catch {
    return []
  }
  const proxies = Array.isArray(doc?.proxies) ? doc.proxies : []
  const out = []
  for (const p of proxies) {
    const type = String(p?.type || "").toLowerCase()
    const name = String(p?.name || "").trim()
    const host = String(p?.server || "").trim()
    const port = Number(p?.port || 0)
    if (!type || !host || !Number.isFinite(port) || port <= 0) continue
    const allowInsecure = Boolean(p?.["skip-cert-verify"] ?? p?.skipCertVerify ?? p?.allowInsecure)

    if (type === "vmess") {
      out.push({
        type: "vmess",
        tag: name || `vmess:${host}:${port}`,
        host,
        port,
        id: String(p?.uuid || "").trim(),
        alterId: Number(p?.alterId || 0) || 0,
        security: String(p?.cipher || "auto").trim() || "auto",
        net: String(p?.network || "tcp").trim() || "tcp",
        tls: p?.tls ? "tls" : "",
        sni: String(p?.servername || p?.sni || "").trim(),
        allowInsecure,
        wsHost: String(p?.["ws-opts"]?.headers?.Host || "").trim(),
        wsPath: String(p?.["ws-opts"]?.path || "").trim(),
        clash: p
      })
      continue
    }

    if (type === "vless") {
      out.push({
        type: "vless",
        tag: name || `vless:${host}:${port}`,
        host,
        port,
        id: String(p?.uuid || "").trim(),
        encryption: String(p?.encryption || "none").trim() || "none",
        flow: String(p?.flow || "").trim(),
        net: String(p?.network || "tcp").trim() || "tcp",
        tls: p?.tls ? "tls" : "",
        sni: String(p?.servername || p?.sni || "").trim(),
        allowInsecure,
        wsHost: String(p?.["ws-opts"]?.headers?.Host || "").trim(),
        wsPath: String(p?.["ws-opts"]?.path || "").trim(),
        grpcServiceName: String(p?.["grpc-opts"]?.["grpc-service-name"] || "").trim(),
        clash: p
      })
      continue
    }

    if (type === "trojan") {
      out.push({
        type: "trojan",
        tag: name || `trojan:${host}:${port}`,
        host,
        port,
        password: String(p?.password || "").trim(),
        net: String(p?.network || "tcp").trim() || "tcp",
        tls: "tls",
        sni: String(p?.sni || p?.servername || "").trim(),
        allowInsecure,
        wsHost: String(p?.["ws-opts"]?.headers?.Host || "").trim(),
        wsPath: String(p?.["ws-opts"]?.path || "").trim(),
        grpcServiceName: String(p?.["grpc-opts"]?.["grpc-service-name"] || "").trim(),
        clash: p
      })
      continue
    }

    if (type === "ss" || type === "shadowsocks") {
      out.push({
        type: "ss",
        tag: name || `ss:${host}:${port}`,
        host,
        port,
        method: String(p?.cipher || p?.method || "").trim(),
        password: String(p?.password || "").trim(),
        clash: p
      })
      continue
    }

    // Advanced protocols: keep as canonical w/ clash passthrough (for mihomo/sing-box adapters).
    if (type === "hysteria2" || type === "hy2") {
      out.push({
        type: "hysteria2",
        tag: name || `hy2:${host}:${port}`,
        host,
        port,
        password: String(p?.password || p?.auth || p?.["auth-str"] || "").trim(),
        tls: p?.tls ? "tls" : "",
        sni: String(p?.sni || p?.servername || "").trim(),
        allowInsecure,
        clash: p
      })
      continue
    }

    if (type === "tuic") {
      out.push({
        type: "tuic",
        tag: name || `tuic:${host}:${port}`,
        host,
        port,
        id: String(p?.uuid || "").trim(),
        password: String(p?.password || "").trim(),
        tls: p?.tls ? "tls" : "",
        sni: String(p?.sni || p?.servername || "").trim(),
        allowInsecure,
        clash: p
      })
      continue
    }
  }
  return out.filter((n) => n && n.type && n.host && n.port)
}

function parseNodeFromUriLine(line) {
  const s = String(line || "").trim()
  if (!s) return null
  if (/^vmess:\/\//i.test(s)) return parseVmessUri(s)
  if (/^vless:\/\//i.test(s)) return parseVlessUri(s)
  if (/^trojan:\/\//i.test(s)) return parseTrojanUri(s)
  if (/^ss:\/\//i.test(s)) return parseSsUri(s)
  return null
}

export function nodeKey(n) {
  if (!n) return ""
  return [
    n.type || "",
    n.host || "",
    n.port || "",
    n.id || n.password || n.method || ""
  ].join("|")
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

export function parseSubscriptionText(txt = "") {
  const raw = String(txt || "").trim()
  if (!raw) return []

  // Clash YAML.
  if (/^\s*(proxies|proxy-groups)\s*:/m.test(raw)) {
    return dedupeNodes(parseClashYaml(raw))
  }

  // Plain / base64 list.
  let body = raw
  if (looksLikeBase64(body) && !body.includes("://")) {
    const decoded = decodeBase64ToUtf8(body)
    if (decoded) body = decoded
  }

  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const all = []
  for (const line of lines) {
    const node = parseNodeFromUriLine(line)
    if (node) all.push(node)
  }
  return dedupeNodes(all)
}

export async function loadSubscriptionNodes(
  urls,
  {
    timeoutMs = 15_000,
    cacheDir,
    cacheTtlSec = 0,
    useCacheOnFail = true
  } = {}
) {
  const list = toList(urls)
  const all = []
  const errs = []
  const resolvedCacheDir =
    normalizeCacheDir(process.env.PROXY_SUB_CACHE_DIR || cacheDir || "")
  const resolvedCacheTtlSec = Number(process.env.PROXY_SUB_CACHE_TTL_SEC || cacheTtlSec) || 0
  const resolvedUseCacheOnFail = toBool(
    process.env.PROXY_SUB_USE_CACHE_ON_FAIL ?? (useCacheOnFail ? "1" : "0")
  )

  for (const url of list) {
    let txt
    const cachePath = path.join(resolvedCacheDir, `${sha1Hex(normalizeHttpUrl(url))}.txt`)

    try {
      txt = await fetchText(url, { timeoutMs })
      // Save cache on success.
      if (txt && txt.trim()) await writeCacheFile(cachePath, txt)
    } catch (e) {
      errs.push({ url, error: e })
      const causeMsg = e?.cause?.message ? ` (cause=${e.cause.message})` : ""
      const msg = e instanceof AggregateError
        ? `${e.message}; causes=${e.errors?.map((x) => x?.message || String(x)).join(" | ")}`
        : `${e?.message || String(e)}${causeMsg}`
      if (resolvedUseCacheOnFail) {
        const cached = await readCacheFile(cachePath, { ttlSec: resolvedCacheTtlSec })
        if (cached) {
          console.warn(`[proxy] subscription fetch failed; using cache: ${url} (${msg})`)
          txt = cached
        } else {
          console.warn(`[proxy] subscription fetch failed: ${url} (${msg})`)
          continue
        }
      } else {
        console.warn(`[proxy] subscription fetch failed: ${url} (${msg})`)
        continue
      }
    }

    // Clash YAML.
    if (/^\s*(proxies|proxy-groups)\s*:/m.test(txt)) {
      all.push(...parseClashYaml(txt))
      continue
    }

    // Plain / base64 list.
    let body = String(txt || "").trim()
    if (looksLikeBase64(body) && !body.includes("://")) {
      const decoded = decodeBase64ToUtf8(body)
      if (decoded) body = decoded
    }

    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

    for (const line of lines) {
      const node = parseNodeFromUriLine(line)
      if (node) all.push(node)
    }
  }

  const out = dedupeNodes(all)

  if (!out.length && errs.length) {
    throw new AggregateError(
      errs.map((x) => x.error),
      `All subscription urls failed (${errs.length}/${list.length})`
    )
  }
  return out
}
