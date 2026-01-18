import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { ProxyAgent } from "undici"

import { ensureDir } from "../utils/fs.js"
import { ensureV2rayCore } from "./v2ray-core.js"
import { buildV2rayHttpProxyConfig } from "./v2ray.js"
import { loadSubscriptionNodes } from "./subscription.js"

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

async function testProxy(proxyUrl, { testUrl, timeoutMs = 8_000, headers } = {}) {
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

export async function ensureProxyPool(cfg = {}) {
  const enabled = toBool(process.env.PROXY_ENABLED, cfg?.proxy?.enabled ?? false)
  if (!enabled) return { enabled: false, proxyUrls: [], close: async () => {} }

  const required = toBool(process.env.PROXY_REQUIRED, cfg?.proxy?.required ?? false)

  const downloadUrl =
    process.env.V2RAY_DOWNLOAD_URL ||
    cfg?.proxy?.v2ray?.downloadUrl ||
    "https://github.com/v2fly/v2ray-core/releases/download/v5.44.1/v2ray-windows-64.zip"

  const binDir = process.env.V2RAY_BIN_DIR || cfg?.proxy?.v2ray?.binDir || "./bin/v2ray"
  const logLevel = process.env.V2RAY_LOG_LEVEL || cfg?.proxy?.v2ray?.logLevel || "warning"
  const basePort = toInt(process.env.V2RAY_BASE_PORT, cfg?.proxy?.v2ray?.basePort ?? 17890)
  const poolSize = Math.max(1, Math.min(50, toInt(process.env.PROXY_POOL_SIZE, cfg?.proxy?.subscription?.maxNodes ?? 3)))
  const probeCount = Math.max(poolSize, Math.min(500, toInt(process.env.PROXY_PROBE_COUNT, cfg?.proxy?.subscription?.probeCount ?? 50)))
  const probeRounds = Math.max(1, Math.min(10, toInt(process.env.PROXY_PROBE_ROUNDS, cfg?.proxy?.subscription?.probeRounds ?? 3)))
  // Use an API endpoint that returns JSON (even for 4xx) to avoid false positives from HTML landing/WAF pages.
  const testUrl = process.env.PROXY_TEST_URL || cfg?.proxy?.subscription?.testUrl || "https://enka.network/api/uid/100000001"
  const testTimeoutMs = Math.max(1000, toInt(process.env.PROXY_TEST_TIMEOUT_MS, cfg?.proxy?.subscription?.testTimeoutMs ?? 8000))
  const startConcurrency = Math.max(1, Math.min(20, toInt(process.env.PROXY_START_CONCURRENCY, cfg?.proxy?.subscription?.startConcurrency ?? 6)))
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

  if (!subUrls.length) {
    if (required) throw new Error("proxy enabled but no subscription urls configured (proxy.subscription.urls / PROXY_SUB_URLS)")
    console.warn("[proxy] enabled but no subscription urls configured; continue without proxy")
    return { enabled: true, proxyUrls: [], close: async () => {} }
  }

  const { exePath, binDir: resolvedBin } = await ensureV2rayCore({ binDir, downloadUrl })

  let nodes
  try {
    nodes = await loadSubscriptionNodes(subUrls, {
      timeoutMs: subTimeoutMs,
      cacheDir: subCacheDir,
      cacheTtlSec: subCacheTtlSec,
      useCacheOnFail: subUseCacheOnFail
    })
  } catch (e) {
    const msg = e?.message || String(e)
    const hint =
      `subscription fetch failed; ` +
      `try rerun / increase proxy.subscription.timeoutMs / use percent-encoded URL, ` +
      `or prewarm cache via: node scripts/subscription-prefetch.js (cacheDir=${subCacheDir}).`
    throw new Error(`${msg}; ${hint}`, { cause: e })
  }
  if (!nodes.length) {
    if (required) throw new Error("subscription parsed but no supported nodes found")
    console.warn("[proxy] subscription parsed but no supported nodes found; continue without proxy")
    return { enabled: true, proxyUrls: [], close: async () => {} }
  }

  console.log(`[proxy] nodes parsed: ${nodes.length}`)

  const ports = nextPorts(basePort, Math.min(2000, probeCount * probeRounds + 10))
  const procs = []
  const proxyUrls = []

  const startOne = async (node, port) => {
    const cfgObj = buildV2rayHttpProxyConfig(node, { listen: "127.0.0.1", port, logLevel })
    const runDir = path.resolve(".")
    const cfgDir = path.join(runDir, "data", "proxy")
    await ensureDir(cfgDir)
    const cfgPath = path.join(cfgDir, `v2ray.${port}.json`)
    await fsp.writeFile(cfgPath, JSON.stringify(cfgObj, null, 2), "utf8")

    const proxyUrl = `http://127.0.0.1:${port}`

    // v2ray-core CLI has differed across major versions; try a few common variants.
    const argVariants = [
      ["run", "-config", cfgPath],
      ["run", "-c", cfgPath],
      ["-config", cfgPath],
      ["-c", cfgPath]
    ]

    for (const args of argVariants) {
      const child = spawn(exePath, args, {
        cwd: resolvedBin,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true
      })
      // Do not keep Node event loop alive just because proxy processes are running.
      // We'll still kill them via returned close() or process-exit cleanup.
      child.unref()

      // Wait a bit, then test.
      await new Promise((r) => setTimeout(r, startupMs))
      const test = await testProxy(proxyUrl, { testUrl, timeoutMs: testTimeoutMs, headers: testHeaders })
      if (!test.ok) {
        try { child.kill() } catch {}
        continue
      }

      return { ok: true, child, cfgPath, proxyUrl, node, test }
    }

    return { ok: false, proxyUrl, test: { ok: false, status: null, ms: 0, error: "v2ray core started but health-check failed" } }
  }

  const pickStrategy = toPickStrategy(process.env.PROXY_PICK_STRATEGY, cfg?.proxy?.subscription?.pickStrategy ?? "spread")
  const candidates = []
  const pickedKeys = new Set()
  for (let round = 0; round < probeRounds; round++) {
    const offset = round % Math.max(1, nodes.length)
    const roundNodes = pickCandidates(nodes, probeCount, { strategy: pickStrategy, offset })
    for (const n of roundNodes) {
      const k = nodeKey(n)
      if (!k || pickedKeys.has(k)) continue
      pickedKeys.add(k)
      candidates.push(n)
    }
  }
  let nodeIdx = 0
  let portIdx = 0
  let stop = false

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
        const res = await startOne(node, port)
        if (!res.ok) continue

        // Keep as many usable nodes as possible (up to poolSize); drop the rest.
        if (proxyUrls.length >= poolSize) {
          try { res.child.kill() } catch {}
          stop = true
          return
        }

        procs.push({ child: res.child, cfgPath: res.cfgPath, proxyUrl: res.proxyUrl, node: res.node, test: res.test })
        proxyUrls.push(res.proxyUrl)
        console.log(`[proxy] ok ${res.proxyUrl} ${res.node.type} ${res.node.tag} (${res.test.ms}ms status=${res.test.status})`)
        if (proxyUrls.length >= poolSize) {
          stop = true
          return
        }
      } catch (e) {
        console.warn(`[proxy] start failed: ${e?.message || e}`)
      }
    }
  }

  await Promise.all(Array.from({ length: startConcurrency }, () => worker()))

  if (required && proxyUrls.length === 0) {
    // Ensure cleanup before throw.
    for (const p of procs) {
      try { p.child.kill() } catch {}
    }
    throw new Error(
      `proxy enabled but no usable node found (testUrl=${testUrl}). ` +
      `Hint: testUrl should be an API that returns JSON (e.g. https://enka.network/api/uid/100000001).`
    )
  }

  const close = async () => {
    for (const p of procs) {
      try { p.child.kill() } catch {}
    }
  }

  // Keep running; user fetch will use these local proxy URLs.
  return { enabled: true, proxyUrls, close }
}
