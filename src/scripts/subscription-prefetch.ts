import { loadAppConfig } from "../user-config.js"
import { loadSubscriptionNodes } from "../proxy/subscription.js"

function toInt(v: any, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toBool(v: any, fallback = false) {
  if (v == null || v === "") return fallback
  const s = String(v).toLowerCase()
  if (["1", "true", "yes", "y", "on"].includes(s)) return true
  if (["0", "false", "no", "n", "off"].includes(s)) return false
  return fallback
}

async function main() {
  const { data: cfg, userPath } = loadAppConfig()
  const urls = Array.isArray(cfg?.proxy?.subscription?.urls) ? cfg.proxy.subscription.urls.map(String).filter(Boolean) : []
  if (!urls.length) throw new Error(`No subscription urls configured in ${userPath} (proxy.subscription.urls)`)

  const timeoutMs = Math.max(1000, toInt(process.env.PROXY_SUB_TIMEOUT_MS, cfg?.proxy?.subscription?.timeoutMs ?? 30_000))
  const cacheDir = process.env.PROXY_SUB_CACHE_DIR || cfg?.proxy?.subscription?.cacheDir || "./data/proxy/subscription-cache"
  const cacheTtlSec = Math.max(0, toInt(process.env.PROXY_SUB_CACHE_TTL_SEC, cfg?.proxy?.subscription?.cacheTtlSec ?? 0))
  const useCacheOnFail = toBool(process.env.PROXY_SUB_USE_CACHE_ON_FAIL, cfg?.proxy?.subscription?.useCacheOnFail ?? true)

  console.log(`[prefetch] config=${userPath}`)
  console.log(`[prefetch] urls=${urls.length} timeoutMs=${timeoutMs} cacheDir=${cacheDir} cacheTtlSec=${cacheTtlSec} useCacheOnFail=${useCacheOnFail}`)

  const nodes = await loadSubscriptionNodes(urls, {
    timeoutMs,
    cacheDir,
    cacheTtlSec,
    useCacheOnFail,
    insecureSkipVerify: Boolean(cfg?.proxy?.subscription?.insecureSkipVerify ?? false)
  })
  console.log(`[prefetch] nodes parsed: ${nodes.length}`)
}

main().catch((err: any) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})

