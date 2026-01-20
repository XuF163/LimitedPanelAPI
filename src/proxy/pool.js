import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { ProxyAgent } from "undici"

import { ensureDir } from "../utils/fs.js"
import { openProxyDb } from "../db/proxy.js"
import { ensureV2rayCore } from "./v2ray-core.js"
import { buildV2rayHttpProxyConfig } from "./v2ray.js"
import { ensureMihomoCore } from "./mihomo-core.js"
import { startMihomoHttpProxy } from "./mihomo.js"
import { loadSubscriptionNodes } from "./subscription.js"
import { ensureLimitedPanelRsBinary } from "../rust/runner.js"

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

function normalizeProberMode(v) {
  const s = String(v || "").trim().toLowerCase()
  if ([ "rust", "rs" ].includes(s)) return "rust"
  if (s === "auto") return "auto"
  return "js"
}

async function testProxyJs(proxyUrl, { testUrl, timeoutMs = 8_000, headers } = {}) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  const dispatcher = new ProxyAgent(proxyUrl)
  const t0 = Date.now()
  try {
    const res = await fetch(testUrl, { dispatcher, signal: controller.signal, redirect: "follow", headers })
    const text = await res.text().catch(() => "")
    const dt = Date.now() - t0
    const body = String(text || "").trim()
    const isHtml = body.startsWith("<")
    const isJson = body.startsWith("{") || body.startsWith("[")

    // For node usability we require "not HTML" to avoid 429/ban/WAF pages.
    // We accept common API error statuses (400/403/404/424) as long as body is JSON.
    const okStatus = [200, 400, 403, 404, 424]
    const ok = !isHtml && isJson && okStatus.includes(res.status)
    return { ok, status: res.status, ms: dt }
  } catch (e) {
    const dt = Date.now() - t0
    return { ok: false, status: null, ms: dt, error: e?.message || String(e) }
  } finally {
    clearTimeout(tid)
    dispatcher.close?.()
  }
}

let cachedRustBinPromise = null
async function getRustBin() {
  if (!cachedRustBinPromise) cachedRustBinPromise = ensureLimitedPanelRsBinary()
  return await cachedRustBinPromise
}

async function testProxyRust(proxyUrl, { testUrl, timeoutMs = 8_000, headers } = {}) {
  const rustBin = await getRustBin()
  const ua = headers?.["user-agent"] || headers?.["User-Agent"] || ""
  const accept = headers?.accept || headers?.Accept || "application/json"

  const args = [
    "probe-pool",
    "--proxy-urls", String(proxyUrl || ""),
    "--test-url", String(testUrl || ""),
    "--timeout-ms", String(timeoutMs),
    "--concurrency", "1",
    "--max-body-bytes", "65536",
    "--accept", String(accept || "application/json")
  ]
  if (ua) args.push("--user-agent", String(ua))

  const child = spawn(rustBin, args, { stdio: [ "ignore", "pipe", "pipe" ] })

  const killTimer = setTimeout(() => {
    try { child.kill() } catch {}
  }, Math.max(1_000, timeoutMs + 1_000))

  let stderr = ""
  child.stderr?.on("data", (d) => { stderr += String(d || "") })

  let parsed = null
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const s = String(line || "").trim()
      if (!s) continue
      try {
        parsed = JSON.parse(s)
      } catch {}
      break
    }
  } finally {
    rl.close()
  }

  const code = await new Promise((resolve) => child.once("close", resolve))
  clearTimeout(killTimer)

  if (parsed && typeof parsed === "object") {
    return {
      ok: Boolean(parsed.ok),
      status: parsed.status == null ? null : Number(parsed.status),
      ms: Number.isFinite(Number(parsed.ms)) ? Number(parsed.ms) : null,
      error: parsed.error ? String(parsed.error) : null
    }
  }

  return {
    ok: false,
    status: null,
    ms: null,
    error: `rust probe failed (code=${code}): ${String(stderr || "").trim().slice(0, 200)}`
  }
}

async function testProxy(proxyUrl, { testUrl, timeoutMs = 8_000, headers } = {}) {
  const mode = normalizeProberMode(process.env.PROXY_PROBER || "js")
  if (mode !== "js") {
    try {
      return await testProxyRust(proxyUrl, { testUrl, timeoutMs, headers })
    } catch (e) {
      const msg = e?.message || String(e)
      if (mode === "rust") throw e
      console.warn(`[proxy] rust prober unavailable; fallback to js: ${msg}`)
    }
  }
  return await testProxyJs(proxyUrl, { testUrl, timeoutMs, headers })
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

export async function ensureProxyPool(cfg = {}, { onUpdate } = {}) {
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
  const desiredConcurrency = Math.max(0, toInt(process.env.ENKA_CONCURRENCY, cfg?.samples?.enka?.concurrency ?? 0))
  const cfgMaxNodesRaw = cfg?.proxy?.subscription?.maxNodes
  const cfgMaxNodesStr = String(cfgMaxNodesRaw ?? "").trim().toLowerCase()
  const isAutoPool = cfgMaxNodesStr === "auto" || Number(cfgMaxNodesRaw) === 0
  const poolSizeRaw = isAutoPool && desiredConcurrency > 0
    ? desiredConcurrency
    : toInt(process.env.PROXY_POOL_SIZE, cfgMaxNodesRaw ?? 3)
  const poolSize = Math.max(1, Math.min(50, poolSizeRaw))
  if (!isAutoPool && desiredConcurrency > 0 && poolSize < desiredConcurrency) {
    console.warn(
      `[proxy] poolSize=${poolSize} < samples.enka.concurrency=${desiredConcurrency}; ` +
      `consider set proxy.subscription.maxNodes=auto or a larger number to meet throughput requirements.`
    )
  }
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

  const proxyDb = (() => {
    try {
      const dbPath = process.env.PROXY_DB_PATH || cfg?.proxy?.db?.path
      return openProxyDb({ ...(dbPath ? { dbPath } : {}) })
    } catch (e) {
      console.warn(`[proxy] open proxy db failed; continue without db: ${e?.message || String(e)}`)
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
          "proxy enabled but no subscription urls configured (proxy.subscription.urls / PROXY_SUB_URLS) and proxy db is empty"
        )
      }
      console.warn("[proxy] enabled but no subscription urls configured (and proxy db empty); continue without proxy")
      return { enabled: true, proxyUrls: [], close: async () => {} }
    }
    console.warn(`[proxy] no subscription urls; using ${nodes.length} nodes from proxy db`)
  } else {
    try {
      nodes = await loadSubscriptionNodes(subUrls, {
        timeoutMs: subTimeoutMs,
        cacheDir: subCacheDir,
        cacheTtlSec: subCacheTtlSec,
        useCacheOnFail: subUseCacheOnFail,
        insecureSkipVerify: Boolean(cfg?.proxy?.subscription?.insecureSkipVerify ?? false),
        parser: cfg?.proxy?.subscription?.parser
      })
    } catch (e) {
      nodes = proxyDb?.listNodes?.() || []
      if (nodes.length) {
        const msg = e?.message || String(e)
        console.warn(`[proxy] subscription fetch failed; fallback to proxy db nodes (${nodes.length}): ${msg}`)
      } else {
        try { proxyDb?.close?.() } catch {}
        const msg = e?.message || String(e)
        const hint =
          `subscription fetch failed; ` +
          `try rerun / increase proxy.subscription.timeoutMs / use percent-encoded URL, ` +
          `or prewarm cache via: node scripts/subscription-prefetch.js (cacheDir=${subCacheDir}).`
        throw new Error(`${msg}; ${hint}`, { cause: e })
      }
    }
  }
  if (!nodes.length) {
    try { proxyDb?.close?.() } catch {}
    if (required) throw new Error("subscription parsed but no supported nodes found")
    console.warn("[proxy] subscription parsed but no supported nodes found; continue without proxy")
    return { enabled: true, proxyUrls: [], close: async () => {} }
  }

  console.log(`[proxy] nodes parsed: ${nodes.length}`)
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
      console.warn(`[proxy] v2ray-core unavailable; skipping v2ray nodes: ${msg}`)
      v2rayCore = null
    }
  }
  if (wantMihomo) {
    try {
      mihomoCore = await ensureMihomoCore({ binDir: mihomoBinDir, downloadUrl: mihomoDownloadUrl })
    } catch (e) {
      const msg = e?.message || String(e)
      if (required || corePref === "mihomo") throw e
      console.warn(`[proxy] mihomo unavailable; skipping mihomo-only nodes: ${msg}`)
      mihomoCore = null
    }
  }

  const maxProbe = Math.max(1, Math.min(nodes.length, probeMaxTotal || nodes.length))
  const ports = nextPorts(basePort, Math.min(20000, maxProbe + 50))

  const procs = []
  const proxyUrls = []
  const tempFiles = new Set()
  const tempDirs = new Set()
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
      return { ok: true, child, cfgPath, proxyUrl, node, test, cleanup }
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
  console.log(`[proxy] probing: candidates=${candidates.length}/${nodes.length} targetPool=${poolSize} core=${corePref}`)
  let nodeIdx = 0
  let portIdx = 0
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
    const msg =
      `[proxy] probing progress: ok=${proxyUrls.length}/${poolSize} ` +
      `tried=${tried}/${candidates.length} ` +
      `assigned=${Math.min(nodeIdx, candidates.length)}/${candidates.length} ` +
      `active=${active} ` +
      `idleSec=${idleSec} ` +
      `${lastFail ? `lastFail=${lastFail}` : ""}`.trim()
    if (!force && msg === lastProgressStr) return
    lastProgressStr = msg
    console.log(msg)
  }

  // Ensure we keep printing progress even if a worker gets stuck in startOne().
  const progressTimer = setInterval(() => {
    logProgress(false)
  }, progressEveryMs)
  progressTimer.unref?.()
  logProgress(true)
  notify(true)

  const worker = async () => {
    while (!stop) {
      if (proxyUrls.length >= poolSize) {
        stop = true
        return
      }
      const cur = nodeIdx++
      if (cur >= candidates.length) return

      const node = candidates[cur]
      const port = ports[portIdx++]
      try {
        active++
        const res = await startOne(node, port)
        active--
        tried++
        lastFinishAt = Date.now()
        logProgress(false)
        if (!res.ok) {
          lastFail = String(res?.test?.error || (res?.test?.status != null ? `status=${res.test.status}` : "unusable")).slice(0, 120)
          continue
        }

        // Keep as many usable nodes as possible (up to poolSize); drop the rest.
        if (proxyUrls.length >= poolSize) {
          try {
            if (typeof res.cleanup === "function") await res.cleanup()
            else res.child?.kill?.()
          } catch {}
          stop = true
          return
        }

        procs.push({
          child: res.child,
          cfgPath: res.cfgPath,
          proxyUrl: res.proxyUrl,
          node: res.node,
          test: res.test,
          cleanup: res.cleanup
        })
        proxyUrls.push(res.proxyUrl)
        console.log(`[proxy] ok ${res.proxyUrl} ${res.node.type} ${res.node.tag} (${res.test.ms}ms status=${res.test.status})`)
        logProgress(true)
        notify(false)
        if (proxyUrls.length >= poolSize) {
          stop = true
          return
        }
      } catch (e) {
        active = Math.max(0, active - 1)
        lastFinishAt = Date.now()
        lastFail = String(e?.message || e).slice(0, 120)
        console.warn(`[proxy] start failed: ${e?.message || e}`)
        logProgress(false)
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
  }

  // Keep running; user fetch will use these local proxy URLs.
  return { enabled: true, proxyUrls, close }
}
