import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { ProxyAgent } from "undici"

import { ensureDir } from "../utils/fs.js"
import { openProxyDb } from "../db/proxy.js"
import { ensureV2rayCore } from "./v2ray-core.js"
import { buildV2rayHttpProxyConfig } from "./v2ray.js"
import { ensureMihomoCore } from "./mihomo-core.js"
import { startMihomoHttpProxy } from "./mihomo.js"
import { loadSubscriptionNodes } from "./subscription.js"
import { c, createLogger } from "../utils/log.js"

const log = createLogger("代理")

function normalizeProxyFail(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim()
  if (!s) return ""
  const lower = s.toLowerCase()

  if (lower === "fetch failed") return "网络请求失败(fetch failed)"
  if (lower === "timeout" || lower.includes("timed out")) return "请求超时(timeout)"
  if (lower.includes("aborterror")) return "请求已中止(AbortError)"

  if (lower.startsWith("bad_response")) {
    const status = /status=(\d+)/i.exec(s)?.[1] || ""
    const html = /html=(\d+)/i.exec(s)?.[1] || ""
    const body = /body=(.*)$/i.exec(s)?.[1] || ""
    const bodyShort = body ? String(body).slice(0, 80) : ""
    if (html === "1") return `返回HTML/疑似拦截(status=${status || "?"} body=${bodyShort})`
    return `响应异常(status=${status || "?"} body=${bodyShort})`
  }

  if (/^status=\d+$/i.test(s)) return `HTTP状态异常(${s})`

  if (lower.includes("core not available")) {
    if (lower.includes("v2ray")) return "v2ray 核心不可用(core not available)"
    if (lower.includes("mihomo")) return "mihomo 核心不可用(core not available)"
    return `核心不可用(${s})`
  }

  return s
}

function toBool(v, fallback = false) {
  if (v == null || v === "") return fallback
  const s = String(v).toLowerCase()
  if (["1", "true", "yes", "y", "on"].includes(s)) return true
  if (["0", "false", "no", "n", "off"].includes(s)) return false
  return fallback
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
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
  const normalized = String(httpProxy || "").trim()
  if (!normalized) return null
  try {
    return new ProxyAgent(normalized.includes("://") ? normalized : `http://${normalized}`)
  } catch {
    return null
  }
}

function looksLikeHtml(text, contentType = "") {
  const t = String(text || "").trimStart()
  if (!t) return false
  if (/text\/html/i.test(String(contentType || ""))) return true
  return t.startsWith("<") || /<html/i.test(t.slice(0, 200))
}

function looksLikeJson(text) {
  const t = String(text || "").trimStart()
  return t.startsWith("{") || t.startsWith("[")
}

async function testProxy(proxyUrl, { testUrl = "", timeoutMs = 8_000, headers = null } = {}) {
  const dispatcher = createHttpProxyAgent(proxyUrl)
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8000))
  const start = Date.now()
  try {
    const res = await fetch(String(testUrl || ""), {
      redirect: "follow",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        accept: "application/json,*/*",
        ...(headers || {})
      }
    })
    const text = await res.text().catch(() => "")
    const ms = Date.now() - start
    const ct = String(res.headers.get("content-type") || "")
    const html = looksLikeHtml(text, ct)
    const jsonish = looksLikeJson(text)

    // Treat 403/404/424 as "proxy works" when body isn't HTML (often upstream blocks by UID/path).
    const okStatus = [200, 400, 403, 404, 424].includes(Number(res.status))
    const ok = !html && (jsonish || okStatus)

    return {
      ok,
      status: Number.isFinite(Number(res.status)) ? Number(res.status) : null,
      ms: Number.isFinite(ms) ? ms : null,
      error: ok ? null : `bad_response status=${res.status} html=${html ? 1 : 0} body=${String(text || "").slice(0, 120)}`
    }
  } catch (e) {
    const ms = Date.now() - start
    return {
      ok: false,
      status: null,
      ms: Number.isFinite(ms) ? ms : null,
      error: e?.name === "AbortError" ? "timeout" : (e?.message || String(e))
    }
  } finally {
    clearTimeout(tid)
  }
}

function nextPorts(basePort, count) {
  const start = Math.max(1024, toInt(basePort, 17890))
  return Array.from({ length: count }, (_, i) => start + i)
}

function toPickStrategy(v, fallback = "spread") {
  const s = String(v ?? "").trim().toLowerCase()
  if (!s) return fallback
  if (["first", "head"].includes(s)) return "first"
  if (["spread", "stride", "even"].includes(s)) return "spread"
  return fallback
}

function nodeKey(n) {
  if (!n) return ""
  return [
    n.type || "",
    n.host || "",
    n.port || "",
    n.id || n.password || n.method || ""
  ].join("|")
}

async function cleanupLegacyProxyJsonFiles() {
  const dir = path.resolve("data", "proxy")
  if (!fs.existsSync(dir)) return
  const entries = await fsp.readdir(dir, { withFileTypes: true })

  const isLegacy = (name) => (
    /^v2ray\.\d+\.json$/i.test(name) ||
    /^debug\.v2ray(\.\d+)?\.json$/i.test(name)
  )

  await Promise.all(entries.map(async (e) => {
    if (!e.isFile()) return
    if (!isLegacy(e.name)) return
    try {
      await fsp.unlink(path.join(dir, e.name))
    } catch {
      // best-effort
    }
  }))
}

function pickCandidates(nodes, probeCount, { strategy = "spread", offset = 0 } = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const n = list.length
  const k = Math.max(0, Math.min(n, toInt(probeCount, 0)))
  if (k <= 0) return []
  if (strategy === "first") return list.slice(0, k)

  // Spread candidates across the whole subscription list to avoid being stuck on a bad prefix.
  // Example: n=404, k=20 => indices 0,20,40,...,380
  const step = Math.max(1, Math.floor(n / k))
  const out = []
  const used = new Set()
  for (let i = 0; i < n && out.length < k; i++) {
    const idx = (offset + i * step) % n
    if (used.has(idx)) continue
    used.add(idx)
    out.push(list[idx])
  }
  // If modulo caused repeats (rare), fill remaining from head.
  for (let i = 0; i < n && out.length < k; i++) {
    if (used.has(i)) continue
    used.add(i)
    out.push(list[i])
  }
  return out
}

export async function ensureProxyPool(cfg: any = {}, { onUpdate = null }: any = {}) {
  const enabled = toBool(process.env.PROXY_ENABLED, cfg?.proxy?.enabled ?? false)
  if (!enabled) {
    try { onUpdate?.([]) } catch {}
    return { enabled: false, proxyUrls: [], close: async () => {} }
  }

  const required = toBool(process.env.PROXY_REQUIRED, cfg?.proxy?.required ?? false)
  const corePref = String(process.env.PROXY_CORE || cfg?.proxy?.core || "v2ray").trim().toLowerCase()
  const keepConfigFiles = toBool(
    process.env.PROXY_KEEP_CONFIG_FILES,
    cfg?.proxy?.keepConfigFiles ?? cfg?.proxy?.v2ray?.keepConfigFiles ?? cfg?.proxy?.mihomo?.keepConfigFiles ?? false
  )

  const v2rayDownloadUrl =
    process.env.V2RAY_DOWNLOAD_URL ||
    cfg?.proxy?.v2ray?.downloadUrl ||
    "https://github.com/v2fly/v2ray-core/releases/download/v5.44.1/v2ray-windows-64.zip"

  const v2rayBinDir = process.env.V2RAY_BIN_DIR || cfg?.proxy?.v2ray?.binDir || "./bin/v2ray"
  const v2rayLogLevel = process.env.V2RAY_LOG_LEVEL || cfg?.proxy?.v2ray?.logLevel || "warning"

  const mihomoDownloadUrl = process.env.MIHOMO_DOWNLOAD_URL || cfg?.proxy?.mihomo?.downloadUrl || "auto"
  const mihomoBinDir = process.env.MIHOMO_BIN_DIR || cfg?.proxy?.mihomo?.binDir || "./bin/mihomo"
  const mihomoLogLevel = process.env.MIHOMO_LOG_LEVEL || cfg?.proxy?.mihomo?.logLevel || "warning"

  const basePort = toInt(process.env.PROXY_BASE_PORT || process.env.V2RAY_BASE_PORT, cfg?.proxy?.basePort ?? cfg?.proxy?.v2ray?.basePort ?? 17890)
  const cfgMaxNodesRaw = cfg?.proxy?.subscription?.maxNodes
  const cfgMaxNodesStr = String(cfgMaxNodesRaw ?? "").trim().toLowerCase()
  const isAutoPool = cfgMaxNodesStr === "auto" || Number(cfgMaxNodesRaw) === 0
  const poolSizeRaw = isAutoPool
    ? toInt(process.env.PROXY_POOL_SIZE, 30)
    : toInt(process.env.PROXY_POOL_SIZE, cfgMaxNodesRaw ?? 3)
  const poolSize = Math.max(1, Math.min(50, poolSizeRaw))
  const probeCount = Math.max(poolSize, Math.min(500, toInt(process.env.PROXY_PROBE_COUNT, cfg?.proxy?.subscription?.probeCount ?? 50)))
  const probeRounds = Math.max(1, Math.min(10, toInt(process.env.PROXY_PROBE_ROUNDS, cfg?.proxy?.subscription?.probeRounds ?? 3)))
  const probeMaxTotalCfg = toInt(process.env.PROXY_PROBE_MAX_TOTAL, cfg?.proxy?.subscription?.probeMaxTotal ?? 0)
  const probeMaxTotalDefault = Math.max(probeCount * probeRounds, poolSize * 50)
  const probeMaxTotal = Math.max(0, Math.min(5000, probeMaxTotalCfg > 0 ? probeMaxTotalCfg : probeMaxTotalDefault))
  // Use an API endpoint that returns JSON (even for 4xx) to avoid false positives from HTML landing/WAF pages.
  const testUrl = process.env.PROXY_TEST_URL || cfg?.proxy?.subscription?.testUrl || "https://enka.network/api/uid/100000001"
  const testTimeoutMs = Math.max(1000, toInt(process.env.PROXY_TEST_TIMEOUT_MS, cfg?.proxy?.subscription?.testTimeoutMs ?? 8000))
  const startConcurrencyCfg = toInt(process.env.PROXY_START_CONCURRENCY, cfg?.proxy?.subscription?.startConcurrency ?? 6)
  const startConcurrencyEnvSet = process.env.PROXY_START_CONCURRENCY != null && String(process.env.PROXY_START_CONCURRENCY).trim() !== ""
  // If user didn't override and they want a big pool, scale up probing concurrency to avoid "stuck" feeling.
  const startConcurrencyDefault = (poolSize >= 10 && !startConcurrencyEnvSet && Number(startConcurrencyCfg) === 6)
    ? Math.min(20, Math.max(6, Math.ceil(poolSize / 2)))
    : startConcurrencyCfg
  const startConcurrency = Math.max(1, Math.min(20, startConcurrencyDefault))
  const startupMs = Math.max(200, Math.min(5000, toInt(process.env.PROXY_STARTUP_MS, cfg?.proxy?.subscription?.startupMs ?? 700)))
  const testHeaders = {
    // enka.network returns HTML 403 for empty/unknown UA; use same style as our enka fetchers.
    "user-agent": process.env.PROXY_TEST_UA || cfg?.enka?.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    accept: "application/json"
  }

  const subTimeoutMs = Math.max(1000, toInt(process.env.PROXY_SUB_TIMEOUT_MS, cfg?.proxy?.subscription?.timeoutMs ?? 15_000))
  const subCacheDir = process.env.PROXY_SUB_CACHE_DIR || cfg?.proxy?.subscription?.cacheDir || "./data/proxy/subscription-cache"
  const subCacheTtlSec = Math.max(0, toInt(process.env.PROXY_SUB_CACHE_TTL_SEC, cfg?.proxy?.subscription?.cacheTtlSec ?? 0))
  const subUseCacheOnFail = toBool(process.env.PROXY_SUB_USE_CACHE_ON_FAIL, cfg?.proxy?.subscription?.useCacheOnFail ?? true)

  const subUrls = [
    ...((cfg?.proxy?.subscription?.urls && Array.isArray(cfg.proxy.subscription.urls)) ? cfg.proxy.subscription.urls : []),
    ...String(process.env.PROXY_SUB_URLS || "").split(/[,;\s]+/).filter(Boolean)
  ].filter(Boolean)

  // v2: runtime maintenance (dynamic refill / health-check)
  const maintainEnabled = toBool(process.env.PROXY_MAINTAIN_ENABLED, cfg?.proxy?.subscription?.maintain?.enabled ?? true)
  const maintainMs = Math.max(
    5_000,
    Math.min(10 * 60_000, toInt(process.env.PROXY_MAINTAIN_MS, cfg?.proxy?.subscription?.maintain?.intervalMs ?? 30_000))
  )
  const healthCheckEnabled = toBool(process.env.PROXY_HEALTHCHECK_ENABLED, cfg?.proxy?.subscription?.healthCheck?.enabled ?? true)
  const healthCheckMs = Math.max(
    5_000,
    Math.min(10 * 60_000, toInt(process.env.PROXY_HEALTHCHECK_MS, cfg?.proxy?.subscription?.healthCheck?.intervalMs ?? 60_000))
  )
  const healthCheckTimeoutMs = Math.max(
    1000,
    Math.min(
      120_000,
      toInt(
        process.env.PROXY_HEALTHCHECK_TIMEOUT_MS,
        cfg?.proxy?.subscription?.healthCheck?.timeoutMs ?? Math.max(testTimeoutMs, 15_000)
      )
    )
  )
  const healthCheckConcurrency = Math.max(
    1,
    Math.min(20, toInt(process.env.PROXY_HEALTHCHECK_CONCURRENCY, cfg?.proxy?.subscription?.healthCheck?.concurrency ?? 5))
  )
  const healthFailThreshold = Math.max(
    1,
    Math.min(10, toInt(process.env.PROXY_HEALTHCHECK_FAIL_THRESHOLD, cfg?.proxy?.subscription?.healthCheck?.failThreshold ?? 2))
  )
  const refillCooldownMs = Math.max(
    5_000,
    Math.min(10 * 60_000, toInt(process.env.PROXY_REFILL_COOLDOWN_MS, cfg?.proxy?.subscription?.maintain?.refillCooldownMs ?? 10_000))
  )

  // Fast-start target:
  // - When maintain is enabled, we don't need to block startup on probing every candidate.
  // - Once we have `minReady` usable local proxies, we can return early and let refill/health-check
  //   keep the pool healthy in the background.
  const minReadyRaw = (() => {
    const env = process.env.PROXY_MIN_READY
    if (env != null && String(env).trim() !== "") return Number(env)
    if (cfg?.proxy?.subscription?.minReady != null) return Number(cfg.proxy.subscription.minReady)
    return NaN
  })()
  // Default to 1 so Enka sampling can start ASAP; pool maintenance will fill the rest.
  const minReadyDefault = maintainEnabled ? 1 : poolSize
  const minReady = Number.isFinite(minReadyRaw) && minReadyRaw >= 0
    ? Math.max(0, Math.min(poolSize, Math.trunc(minReadyRaw)))
    : minReadyDefault
  const fastStartEnabled = maintainEnabled && minReady > 0 && minReady < poolSize
  const initialTargetSize = fastStartEnabled ? minReady : poolSize

  const proxyDb = (() => {
    try {
      const dbPath = process.env.PROXY_DB_PATH || cfg?.proxy?.db?.path
      return openProxyDb({ ...(dbPath ? { dbPath } : {}) })
    } catch (e) {
      log.warn(`打开代理 DB 失败，将继续运行但不落库：${e?.message || String(e)}`)
      return null
    }
  })()

  // Reduce workspace file spam by removing legacy generated v2ray config JSON files.
  // NOTE: actual running configs will be placed in OS temp dir unless keepConfigFiles=true.
  if (!keepConfigFiles) {
    await cleanupLegacyProxyJsonFiles().catch(() => {})
  }

  let nodes
  if (!subUrls.length) {
    nodes = proxyDb?.listNodes?.() || []
    if (!nodes.length) {
      try { proxyDb?.close?.() } catch {}
      if (required) {
        throw new Error(
          "已启用代理，但未配置订阅(proxy.subscription.urls / PROXY_SUB_URLS)，且代理 DB 为空。"
        )
      }
      log.warn("已启用代理，但未配置订阅且代理 DB 为空；将不使用代理继续。")
      return { enabled: true, proxyUrls: [], close: async () => {} }
    }
    log.warn(`未配置订阅，将使用代理 DB 中的节点：${nodes.length}`)
  } else {
    try {
      nodes = await loadSubscriptionNodes(subUrls, {
        timeoutMs: subTimeoutMs,
        cacheDir: subCacheDir,
        cacheTtlSec: subCacheTtlSec,
        useCacheOnFail: subUseCacheOnFail,
        insecureSkipVerify: Boolean(cfg?.proxy?.subscription?.insecureSkipVerify ?? false),
        httpProxy: cfg?.proxy?.subscription?.httpProxy
      })
    } catch (e) {
      nodes = proxyDb?.listNodes?.() || []
      if (nodes.length) {
        const msg = e?.message || String(e)
        log.warn(`订阅拉取失败，回退代理 DB 节点(${nodes.length})：${msg}`)
      } else {
        try { proxyDb?.close?.() } catch {}
        const msg = e?.message || String(e)
        const hint =
          `订阅拉取失败；` +
          `可尝试：重试 / 增大 proxy.subscription.timeoutMs / 使用 percent-encoded URL；` +
          `或先执行预热缓存：node dist/scripts/subscription-prefetch.js (cacheDir=${subCacheDir})。`
        throw new Error(`${msg}；${hint}`, { cause: e })
      }
    }
  }
  if (!nodes.length) {
    try { proxyDb?.close?.() } catch {}
    if (required) throw new Error("订阅解析成功但无可用节点")
    log.warn("订阅解析成功但无可用节点；将不使用代理继续。")
    return { enabled: true, proxyUrls: [], close: async () => {} }
  }

  log.info(`可用节点：${nodes.length}`)
  // Persist parsed nodes for reuse (e.g., WebUI import / fallback if subscription becomes unavailable).
  if (subUrls.length && proxyDb?.insertNode) {
    for (const n of nodes) {
      try {
        const k = nodeKey(n)
        if (!k) continue
        proxyDb.insertNode({ key: k, node: n })
      } catch {}
    }
  }

  const normalizeType = (n) => String(n?.type || "").trim().toLowerCase()
  const hasClashReality = (n) => {
    const c = n?.clash
    if (!c || typeof c !== "object") return false
    // Common keys used by Clash/Mihomo for Reality:
    // - reality-opts / reality-opts.public-key / reality-opts.short-id
    return Boolean(c?.["reality-opts"] || c?.realityOpts || c?.reality || c?.pbk || c?.["public-key"])
  }
  const needsMihomoForNode = (n) => {
    const t = normalizeType(n)
    if (["hysteria2", "hy2", "tuic", "hysteria", "tuicv5"].includes(t)) return true
    const tls = String(n?.tls || "").trim().toLowerCase()
    if (tls === "reality") return true
    if (hasClashReality(n)) return true
    return false
  }
  const supportsV2rayNode = (n) => {
    const t = normalizeType(n)
    if (!["vmess", "vless", "trojan", "ss"].includes(t)) return false
    // v2ray builder does not support Reality yet.
    if (t === "vless" && needsMihomoForNode(n)) return false
    return true
  }
  const coreForNode = (n) => {
    if (corePref === "mihomo") return "mihomo"
    if (corePref === "v2ray") return "v2ray"
    // auto
    if (needsMihomoForNode(n)) return "mihomo"
    if (supportsV2rayNode(n)) return "v2ray"
    return "mihomo"
  }

  let v2rayCore = null
  let mihomoCore = null
  const wantV2ray = nodes.some((n) => coreForNode(n) === "v2ray")
  const wantMihomo = nodes.some((n) => coreForNode(n) === "mihomo")

  if (wantV2ray) {
    try {
      v2rayCore = await ensureV2rayCore({ binDir: v2rayBinDir, downloadUrl: v2rayDownloadUrl })
    } catch (e) {
      const msg = e?.message || String(e)
      if (required || corePref === "v2ray") throw e
      log.warn(`v2ray-core 不可用，跳过 v2ray 节点：${msg}`)
      v2rayCore = null
    }
  }
  if (wantMihomo) {
    try {
      mihomoCore = await ensureMihomoCore({ binDir: mihomoBinDir, downloadUrl: mihomoDownloadUrl })
    } catch (e) {
      const msg = e?.message || String(e)
      if (required || corePref === "mihomo") throw e
      log.warn(`mihomo 不可用，跳过 mihomo-only 节点：${msg}`)
      mihomoCore = null
    }
  }

  const maxProbe = Math.max(1, Math.min(nodes.length, probeMaxTotal || nodes.length))
  const ports = nextPorts(basePort, Math.min(20000, maxProbe + 50))
  const freePorts = []
  let portIdx = 0
  const allocPort = () => {
    if (freePorts.length) return freePorts.shift()
    const p = ports[portIdx++]
    if (p != null) return p
    // Fallback: keep increasing from basePort.
    return Math.max(1024, basePort) + portIdx
  }

  const procs: any[] = []
  const proxyUrls: string[] = []
  const tempFiles = new Set<string>()
  const tempDirs = new Set<string>()
  const healthFailCountByUrl = new Map<string, number>()
  const runningNodeKeys = new Set<string>()
  let closed = false
  let lastError = ""
  let lastRefillAt = 0
  let lastRebuildAt = 0
  let refillPromise = null
  let maintainTimer = null
  let healthTimer = null
  const notify = (force = false) => {
    if (typeof onUpdate !== "function") return
    try {
      // Always pass a snapshot; callers may mutate their own copy.
      onUpdate(proxyUrls.slice(), { force })
    } catch {}
  }

  const startOne = async (node, port) => {
    const core = coreForNode(node)
    const proxyUrl = `http://127.0.0.1:${port}`
    let attemptId = null
    let lastTest = null

    if (core === "mihomo") {
      if (!mihomoCore?.exePath) {
        attemptId = proxyDb?.insertAttempt?.({ localPort: port, node, config: { core }, testUrl })
        proxyDb?.finishAttempt?.(attemptId, { ok: false, error: "mihomo core not available" })
        return { ok: false, proxyUrl, test: { ok: false, error: "mihomo core not available" } }
      }
      const started = await startMihomoHttpProxy({
        exePath: mihomoCore.exePath,
        node,
        port,
        logLevel: mihomoLogLevel,
        keepConfigFiles,
        runDir: path.resolve(".")
      })
      attemptId = proxyDb?.insertAttempt?.({ localPort: port, node, config: { core, ...started.config }, testUrl })
      if (!keepConfigFiles) {
        tempFiles.add(started.cfgPath)
        tempDirs.add(started.homeDir)
      }
      await new Promise((r) => setTimeout(r, startupMs))
      const test = await testProxy(proxyUrl, { testUrl, timeoutMs: testTimeoutMs, headers: testHeaders })
      lastTest = test
      if (!test.ok) {
        await started.cleanup().catch(() => {})
        proxyDb?.finishAttempt?.(attemptId, { ok: false, status: test.status, ms: test.ms, error: test.error || "mihomo health-check failed" })
        return { ok: false, proxyUrl, test }
      }
      proxyDb?.finishAttempt?.(attemptId, { ok: true, status: test.status, ms: test.ms })
      return {
        ok: true,
        child: started.child,
        port,
        cfgPath: started.cfgPath,
        proxyUrl,
        node,
        test,
        cleanup: started.cleanup
      }
    }

    // v2ray-core
    if (!v2rayCore?.exePath) {
      attemptId = proxyDb?.insertAttempt?.({ localPort: port, node, config: { core }, testUrl })
      proxyDb?.finishAttempt?.(attemptId, { ok: false, error: "v2ray core not available" })
      return { ok: false, proxyUrl, test: { ok: false, error: "v2ray core not available" } }
    }
    const cfgObj = buildV2rayHttpProxyConfig(node, { listen: "127.0.0.1", port, logLevel: v2rayLogLevel })
    attemptId = proxyDb?.insertAttempt?.({ localPort: port, node, config: { core, ...cfgObj }, testUrl })
    const runDir = path.resolve(".")
    const cfgDir = keepConfigFiles
      ? path.join(runDir, "data", "proxy")
      : path.join(os.tmpdir(), "ExtremePanelAPI", "v2ray")
    await ensureDir(cfgDir)
    const cfgPath = keepConfigFiles
      ? path.join(cfgDir, `v2ray.${port}.json`)
      : path.join(cfgDir, `v2ray.${process.pid}.${port}.${Date.now()}.json`)
    await fsp.writeFile(cfgPath, JSON.stringify(cfgObj, null, 2), "utf8")
    if (!keepConfigFiles) tempFiles.add(cfgPath)

    // v2ray-core CLI has differed across major versions; try a few common variants.
    const argVariants = [
      ["run", "-config", cfgPath],
      ["run", "-c", cfgPath],
      ["-config", cfgPath],
      ["-c", cfgPath]
    ]

    for (const args of argVariants) {
      const child = spawn(v2rayCore.exePath, args, {
        cwd: v2rayCore.binDir,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true
      })
      child.unref()

      await new Promise((r) => setTimeout(r, startupMs))
      const test = await testProxy(proxyUrl, { testUrl, timeoutMs: testTimeoutMs, headers: testHeaders })
      lastTest = test
      if (!test.ok) {
        try { child.kill() } catch {}
        continue
      }

      proxyDb?.finishAttempt?.(attemptId, { ok: true, status: test.status, ms: test.ms })
      const cleanup = async () => {
        try { child.kill() } catch {}
        if (!keepConfigFiles) {
          try { await fsp.unlink(cfgPath) } catch {}
          tempFiles.delete(cfgPath)
        }
      }
      return { ok: true, child, port, cfgPath, proxyUrl, node, test, cleanup }
    }

    proxyDb?.finishAttempt?.(attemptId, {
      ok: false,
      status: lastTest?.status ?? null,
      ms: lastTest?.ms ?? 0,
      error: lastTest?.error || "v2ray core started but health-check failed"
    })
    if (!keepConfigFiles) {
      try { await fsp.unlink(cfgPath) } catch {}
      tempFiles.delete(cfgPath)
    }
    return { ok: false, proxyUrl, test: lastTest || { ok: false, status: null, ms: 0, error: "v2ray core started but health-check failed" } }
  }

  const pickStrategy = toPickStrategy(process.env.PROXY_PICK_STRATEGY, cfg?.proxy?.subscription?.pickStrategy ?? "spread")
  const candidates = []
  const pickedKeys = new Set()
  const nTotal = Math.max(1, nodes.length)
  const targetCandidates = Math.min(nTotal, maxProbe)
  // Build candidates progressively. The default probeCount/probeRounds are often too small
  // for real-world subscriptions where only a subset is usable for Enka JSON checks.
  // We keep sampling "spread" rounds until we have enough candidates or we exhaust the list.
  const roundCap = Math.max(probeRounds, Math.min(200, Math.ceil(targetCandidates / Math.max(1, probeCount))))
  for (let round = 0; round < roundCap && candidates.length < targetCandidates; round++) {
    const offset = round % nTotal
    const roundNodes = pickCandidates(nodes, Math.min(probeCount, nTotal), { strategy: pickStrategy, offset })
    for (const n of roundNodes) {
      const k = nodeKey(n)
      if (!k || pickedKeys.has(k)) continue
      pickedKeys.add(k)
      candidates.push(n)
      if (candidates.length >= targetCandidates) break
    }
  }
  if (candidates.length < targetCandidates && nodes.length > candidates.length) {
    // Fallback: fill from head if spread sampling couldn't reach all unique nodes.
    for (const n of nodes) {
      const k = nodeKey(n)
      if (!k || pickedKeys.has(k)) continue
      pickedKeys.add(k)
      candidates.push(n)
      if (candidates.length >= targetCandidates) break
    }
  }
  const targetNote = fastStartEnabled
    ? `目标池 ${initialTargetSize}/${poolSize}`
    : `目标池 ${poolSize}`
  log.info(
    `${c.blue("开始探测")}：候选 ${c.cyan(`${candidates.length}/${nodes.length}`)} ` +
      `${c.cyan(targetNote)} core=${c.cyan(corePref)}`
  )
  let nodeIdx = 0
  let stop = false
  let tried = 0
  let active = 0
  let lastFinishAt = Date.now()
  let lastProgressAt = 0
  let lastProgressStr = ""
  let lastFail = ""
  const progressEveryMs = Math.max(1000, Math.min(60_000, toInt(process.env.PROXY_PROGRESS_MS, cfg?.proxy?.subscription?.progressMs ?? 5000)))

  const logProgress = (force = false) => {
    const now = Date.now()
    if (!force && now - lastProgressAt < progressEveryMs) return
    lastProgressAt = now
    const idleSec = Math.max(0, Math.round((now - lastFinishAt) / 1000))
    const sep = c.gray(" | ")
    const ok = `${proxyUrls.length}/${poolSize}`
    const triedStr = `${tried}/${candidates.length}`
    const assigned = `${Math.min(nodeIdx, candidates.length)}/${candidates.length}`
    const idleStr = `${idleSec}s`
    const idleColored = idleSec >= 10 ? c.yellow(idleStr) : c.gray(idleStr)
    const fail = lastFail ? `最近失败：${c.red(lastFail)}` : ""
    const msg = (
      `${c.blue("探测进度")}：` +
      `${c.green("可用")} ${c.green(ok)}` +
      `${sep}${c.cyan("已测")} ${c.cyan(triedStr)}` +
      `${sep}${c.cyan("已分配")} ${c.cyan(assigned)}` +
      `${sep}${c.magenta("并发")} ${c.magenta(String(active))}` +
      `${sep}${c.gray("空闲")} ${idleColored}` +
      `${fail ? `${sep}${fail}` : ""}`
    ).trim()
    if (!force && msg === lastProgressStr) return
    lastProgressStr = msg
    log.info(msg)
  }

  // Ensure we keep printing progress even if a worker gets stuck in startOne().
  const progressTimer = setInterval(() => {
    logProgress(false)
  }, progressEveryMs)
  progressTimer.unref?.()
  logProgress(true)
  notify(true)

  const removeProxyUrl = async (proxyUrl, reason = "") => {
    const idx = procs.findIndex((p) => p?.proxyUrl === proxyUrl)
    if (idx < 0) return false
    const p = procs[idx]
    procs.splice(idx, 1)
    const uidx = proxyUrls.indexOf(proxyUrl)
    if (uidx >= 0) proxyUrls.splice(uidx, 1)
    try {
      if (typeof p.cleanup === "function") await p.cleanup()
      else p.child?.kill?.()
    } catch {}
    try {
      const k = nodeKey(p?.node)
      if (k) runningNodeKeys.delete(k)
    } catch {}
    if (Number.isFinite(Number(p?.port)) && Number(p.port) > 0) freePorts.push(Number(p.port))
    healthFailCountByUrl.delete(proxyUrl)
    if (reason) lastError = String(reason)
    notify(false)
    return true
  }

  const healthCheckOnce = async () => {
    if (closed) return
    if (!healthCheckEnabled) return
    const urls = proxyUrls.slice()
    if (!urls.length) return

    let i = 0
    const w = async () => {
      while (!closed) {
        const cur = i++
        if (cur >= urls.length) return
        const url = urls[cur]
        const test = await testProxy(url, { testUrl, timeoutMs: healthCheckTimeoutMs, headers: testHeaders })
        if (test.ok) {
          healthFailCountByUrl.set(url, 0)
          continue
        }
        const n = (healthFailCountByUrl.get(url) || 0) + 1
        healthFailCountByUrl.set(url, n)
        if (n >= healthFailThreshold) {
          const reason = normalizeProxyFail(test.error || `status=${test.status}`) || `status=${test.status}`
          log.warn(
            `${c.yellow("健康检查失败")}：移除 ${c.cyan(safeUrlForLog(url))} ` +
              `（失败 ${n}/${healthFailThreshold}${reason ? `，原因：${reason}` : ""}）`
          )
          await removeProxyUrl(url, reason)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(healthCheckConcurrency, urls.length) }, () => w()))
  }

  const refillToTarget = async ({ resetIfExhausted = true } = {}) => {
    if (closed) return
    if (!maintainEnabled) return
    if (proxyUrls.length >= poolSize) return
    const now = Date.now()
    if (now - lastRefillAt < refillCooldownMs) return

    if (nodeIdx >= candidates.length && resetIfExhausted) {
      // allow retrying candidates: node quality changes over time
      nodeIdx = 0
    }
    if (nodeIdx >= candidates.length) return

    if (refillPromise) return await refillPromise
    lastRefillAt = now
    const refillWorker = async () => {
      while (!closed && proxyUrls.length < poolSize) {
        const cur = nodeIdx++
        if (cur >= candidates.length) return
        const node = candidates[cur]
        const k = nodeKey(node)
        if (k) {
          if (runningNodeKeys.has(k)) continue
          runningNodeKeys.add(k)
        }
        const port = allocPort()
        tried++
        try {
          const res: any = await startOne(node, port)
          lastFinishAt = Date.now()
          if (!res.ok) {
            if (k) runningNodeKeys.delete(k)
            continue
          }
          if (proxyUrls.length >= poolSize) {
            try {
              if (typeof res.cleanup === "function") await res.cleanup()
              else res.child?.kill?.()
            } catch {}
            if (k) runningNodeKeys.delete(k)
            return
          }
          const kk = nodeKey(res.node)
          if (kk && kk !== k) {
            runningNodeKeys.add(kk)
            if (k) runningNodeKeys.delete(k)
          }
          procs.push({
            child: res.child,
            port: res.port ?? port,
            cfgPath: res.cfgPath,
            proxyUrl: res.proxyUrl,
            node: res.node,
            test: res.test,
            cleanup: res.cleanup
          })
          proxyUrls.push(res.proxyUrl)
          log.info(`${c.green("代理池补齐")}：${c.cyan(res.proxyUrl)}（${res.test.ms}ms status=${res.test.status}）`)
          notify(false)
        } catch (e) {
          lastError = e?.message || String(e)
          if (k) runningNodeKeys.delete(k)
        }
      }
    }

    refillPromise = Promise.all(Array.from({ length: Math.min(startConcurrency, 5) }, () => refillWorker()))
      .catch(() => {})
      .finally(() => { refillPromise = null })
    await refillPromise
  }

  const worker = async () => {
    while (!stop) {
      if (proxyUrls.length >= initialTargetSize) {
        stop = true
        return
      }
      const cur = nodeIdx++
      if (cur >= candidates.length) return

      const node = candidates[cur]
      const nk = nodeKey(node)
      if (nk) {
        if (runningNodeKeys.has(nk)) continue
        runningNodeKeys.add(nk)
      }
      const port = allocPort()
      try {
        active++
        const res: any = await startOne(node, port)
        active--
        tried++
        lastFinishAt = Date.now()
        logProgress(false)
        if (!res.ok) {
          if (nk) runningNodeKeys.delete(nk)
          lastFail = normalizeProxyFail(
            res?.test?.error || (res?.test?.status != null ? `status=${res.test.status}` : "不可用")
          ).slice(0, 120)
          continue
        }

        // Keep as many usable nodes as possible (up to poolSize); drop the rest.
        if (proxyUrls.length >= poolSize) {
          try {
            if (typeof res.cleanup === "function") await res.cleanup()
            else res.child?.kill?.()
          } catch {}
          if (nk) runningNodeKeys.delete(nk)
          stop = true
          return
        }

        const rk = nodeKey(res.node)
        if (rk && rk !== nk) {
          runningNodeKeys.add(rk)
          if (nk) runningNodeKeys.delete(nk)
        }
        procs.push({
          child: res.child,
          port: res.port ?? port,
          cfgPath: res.cfgPath,
          proxyUrl: res.proxyUrl,
          node: res.node,
          test: res.test,
          cleanup: res.cleanup
        })
        proxyUrls.push(res.proxyUrl)
        log.info(
          `${c.green("可用")}：${c.cyan(res.proxyUrl)} ` +
            `type=${c.cyan(res.node?.type || "")} tag=${c.cyan(res.node?.tag || "")} ` +
            `（${res.test.ms}ms status=${res.test.status}）`
        )
        logProgress(true)
        notify(false)
        if (proxyUrls.length >= initialTargetSize) {
          stop = true
          return
        }
      } catch (e) {
        active = Math.max(0, active - 1)
        lastFinishAt = Date.now()
        const errMsg = e?.message || String(e)
        lastFail = normalizeProxyFail(errMsg).slice(0, 120)
        log.warn(`${c.yellow("启动失败")}：${c.red(errMsg)}`)
        logProgress(false)
        if (nk) runningNodeKeys.delete(nk)
      }
    }
  }

  await Promise.all(Array.from({ length: startConcurrency }, () => worker()))
  clearInterval(progressTimer)
  logProgress(true)
  notify(true)

  if (required && proxyUrls.length === 0) {
    // Ensure cleanup before throw.
    for (const p of procs) {
      try {
        if (typeof p.cleanup === "function") await p.cleanup()
        else p.child?.kill?.()
      } catch {}
    }
    for (const cfgPath of tempFiles) {
      try { await fsp.unlink(cfgPath) } catch {}
    }
    for (const dir of tempDirs) {
      try { await fsp.rm(dir, { recursive: true, force: true }) } catch {}
    }
    try { proxyDb?.close?.() } catch {}
    throw new Error(
      `proxy enabled but no usable node found (testUrl=${testUrl}). ` +
      `Hint: testUrl should be an API that returns JSON (e.g. https://enka.network/api/uid/100000001).`
    )
  }

  const close = async () => {
    closed = true
    try { clearInterval(maintainTimer) } catch {}
    try { clearInterval(healthTimer) } catch {}
    for (const p of procs) {
      try {
        if (typeof p.cleanup === "function") await p.cleanup()
        else p.child?.kill?.()
      } catch {}
      try {
        const k = nodeKey(p?.node)
        if (k) runningNodeKeys.delete(k)
      } catch {}
    }
    for (const cfgPath of tempFiles) {
      try { await fsp.unlink(cfgPath) } catch {}
    }
    for (const dir of tempDirs) {
      try { await fsp.rm(dir, { recursive: true, force: true }) } catch {}
    }
    try { proxyDb?.close?.() } catch {}
  }

  const status = () => ({
    enabled: true,
    running: !closed,
    targetSize: poolSize,
    usable: proxyUrls.length,
    tried,
    candidates: candidates.length,
    lastError: lastError || lastFail || null
  })

  const rebuild = async () => {
    if (closed) return { ok: false, error: "closed" }

    // Drop all current proxies.
    for (const url of proxyUrls.slice()) {
      await removeProxyUrl(url, "rebuild")
    }

    // Reload nodes from subscription (or DB fallback), then rebuild candidates.
    let newNodes = []
    if (subUrls.length) {
      try {
        newNodes = await loadSubscriptionNodes(subUrls, {
          timeoutMs: subTimeoutMs,
          cacheDir: subCacheDir,
          cacheTtlSec: subCacheTtlSec,
          useCacheOnFail: subUseCacheOnFail,
          insecureSkipVerify: Boolean(cfg?.proxy?.subscription?.insecureSkipVerify ?? false),
          httpProxy: cfg?.proxy?.subscription?.httpProxy
        })
      } catch (e) {
        lastError = e?.message || String(e)
        newNodes = proxyDb?.listNodes?.() || []
      }
    } else {
      newNodes = proxyDb?.listNodes?.() || []
    }
    if (Array.isArray(newNodes) && newNodes.length) {
      nodes = newNodes
      if (subUrls.length && proxyDb?.insertNode) {
        for (const n of nodes) {
          try {
            const k = nodeKey(n)
            if (!k) continue
            proxyDb.insertNode({ key: k, node: n })
          } catch {}
        }
      }
      candidates.length = 0
      pickedKeys.clear()
      const nTotal2 = Math.max(1, nodes.length)
      const maxProbe2 = Math.max(1, Math.min(nodes.length, probeMaxTotal || nodes.length))
      const targetCandidates2 = Math.min(nTotal2, maxProbe2)
      const roundCap2 = Math.max(probeRounds, Math.min(200, Math.ceil(targetCandidates2 / Math.max(1, probeCount))))
      for (let round = 0; round < roundCap2 && candidates.length < targetCandidates2; round++) {
        const offset = round % nTotal2
        const roundNodes = pickCandidates(nodes, Math.min(probeCount, nTotal2), { strategy: pickStrategy, offset })
        for (const n of roundNodes) {
          const k = nodeKey(n)
          if (!k || pickedKeys.has(k)) continue
          pickedKeys.add(k)
          candidates.push(n)
          if (candidates.length >= targetCandidates2) break
        }
      }
      if (candidates.length < targetCandidates2 && nodes.length > candidates.length) {
        for (const n of nodes) {
          const k = nodeKey(n)
          if (!k || pickedKeys.has(k)) continue
          pickedKeys.add(k)
          candidates.push(n)
          if (candidates.length >= targetCandidates2) break
        }
      }
      nodeIdx = 0
    }

    // Force a refill run immediately.
    lastRefillAt = 0
    await refillToTarget({ resetIfExhausted: true })
    notify(true)
    return { ok: true, usable: proxyUrls.length, targetSize: poolSize }
  }

  if (maintainEnabled && !closed) {
    let refillInFlight = false
    let healthInFlight = false

    const refillTick = async () => {
      if (closed) return
      if (refillInFlight) return
      refillInFlight = true
      try {
        await refillToTarget({ resetIfExhausted: true })
      } catch (e) {
        lastError = e?.message || String(e)
      } finally {
        refillInFlight = false
      }
    }

    const healthTick = async () => {
      if (closed) return
      if (!healthCheckEnabled) return
      if (healthInFlight) return
      healthInFlight = true
      try {
        await healthCheckOnce()
      } catch (e) {
        lastError = e?.message || String(e)
      } finally {
        healthInFlight = false
      }
    }

    // Separate timers so health-check respects its own interval even when maintain is enabled.
    maintainTimer = setInterval(() => { if (!closed) refillTick().catch(() => {}) }, maintainMs)
    maintainTimer.unref?.()

    if (healthCheckEnabled) {
      healthTimer = setInterval(() => { if (!closed) healthTick().catch(() => {}) }, healthCheckMs)
      healthTimer.unref?.()
    }

    // Kick once immediately so we don't wait a full interval before refilling.
    refillTick().catch(() => {})
    if (healthCheckEnabled) healthTick().catch(() => {})
  }
  if (healthCheckEnabled && !closed && !maintainEnabled) {
    healthTimer = setInterval(() => { if (!closed) healthCheckOnce().catch(() => {}) }, healthCheckMs)
    healthTimer.unref?.()
  }

  // Keep running; user fetch will use these local proxy URLs.
  return { enabled: true, proxyUrls, close, status, rebuild }
}
