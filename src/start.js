#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { projectRoot, paths } from "./config.js"
import { loadAppConfig } from "./user-config.js"
import { cmdMetaSync } from "./meta/sync.js"
import { cmdSampleCollect } from "./samples/collect.js"
import { collectPlayerDataSamples } from "./samples/collect-playerdata.js"
import { shouldSkipEnkaScanToday, updateDailyGateFromPreset } from "./samples/daily-gate.js"
import { cmdPresetGenerate } from "./preset/generate.js"
import { openScanDb } from "./db/sqlite.js"
import { ensureProxyPool } from "./proxy/pool.js"
import { startServer } from "./server.js"

function toList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((s) => s.trim()).filter(Boolean)
  }
  if (value == null || value === "") return []
  return String(value)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function envBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === "") return fallback
  if ([ "1", "true", "yes", "y", "on" ].includes(String(raw).toLowerCase())) return true
  if ([ "0", "false", "no", "n", "off" ].includes(String(raw).toLowerCase())) return false
  return fallback
}

function envNum(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function envList(name, fallback = []) {
  const raw = process.env[name]
  if (raw == null || raw === "") return toList(fallback)
  return toList(raw)
}

function toFiniteNumber(v) {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function getEnkaUidSelector(cfg, game) {
  const enkaCfg = cfg?.samples?.enka || {}
  const gameCfg = enkaCfg?.[game] || {}
  const upper = String(game || "").toUpperCase()

  // Backward compatible priority:
  // - env per-game (ENKA_UIDS_GS) > env global (ENKA_UIDS) > config per-game (samples.enka.gs) > config legacy (samples.enka)
  let uids = envList("ENKA_UIDS", gameCfg?.uids ?? enkaCfg?.uids ?? [])
  uids = envList(`ENKA_UIDS_${upper}`, uids)

  const cfgUidStart = toFiniteNumber(gameCfg?.uidStart ?? enkaCfg?.uidStart ?? null)
  let uidStart = envNum("ENKA_UID_START", cfgUidStart)
  uidStart = envNum(`ENKA_UID_START_${upper}`, uidStart)

  const cfgUidEnd = toFiniteNumber(gameCfg?.uidEnd ?? enkaCfg?.uidEnd ?? null)
  let uidEnd = envNum("ENKA_UID_END", cfgUidEnd)
  uidEnd = envNum(`ENKA_UID_END_${upper}`, uidEnd)

  let countCfg = envNum("ENKA_COUNT", null)
  countCfg = envNum(`ENKA_COUNT_${upper}`, countCfg)

  const configured = uids.length > 0 || (Number.isFinite(uidStart) && (Number.isFinite(uidEnd) || Number.isFinite(countCfg)))

  return { uids, uidStart, uidEnd, countCfg, configured }
}

function getAutoSampleMode(cfg, game) {
  const { configured: enkaConfigured } = getEnkaUidSelector(cfg, game)
  const cfgModeRaw = (process.env.SAMPLE_MODE || cfg?.samples?.mode || (enkaConfigured ? "enka" : "playerdata")).toLowerCase()
  const sampleMode = game === "zzz" ? "enka" : cfgModeRaw
  return { sampleMode, enkaConfigured }
}

function hasAnySamples(game) {
  const dir = paths.samplesDir(game)
  if (!fs.existsSync(dir)) return false
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  return files.length > 0
}

function normalizeMetaSourceType(t) {
  const s = String(t || "").trim().toLowerCase()
  if ([ "miao-plugin", "miaoplugin", "miao" ].includes(s)) return "miao-plugin"
  return "cnb"
}

function readMetaMarker(metaRoot) {
  try {
    const p = path.join(metaRoot, ".meta-source.json")
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function hasMeta(game, cfg) {
  if (game === "zzz") return true
  const root = game === "gs" ? paths.metaGs : paths.metaSr

  const mustHave =
    game === "gs"
      ? [ path.join(root, "artifact", "data.json"), path.join(root, "character", "data.json") ]
      : [ path.join(root, "artifact", "meta.json"), path.join(root, "character", "data.json") ]

  if (!mustHave.every((p) => fs.existsSync(p))) return false

  // Require a meta marker so switching meta.source.type will take effect automatically.
  const desiredType = normalizeMetaSourceType(cfg?.meta?.source?.type || "cnb")
  const marker = readMetaMarker(root)
  if (!marker || normalizeMetaSourceType(marker?.type) !== desiredType) return false

  return true
}

async function ensureMeta(game, { force = false } = {}) {
  const { data: cfg } = loadAppConfig({ ensureUser: false })
  if (game === "zzz") return
  if (!force && hasMeta(game, cfg)) return
  console.log(`[auto] meta:sync --game ${game}`)
  await cmdMetaSync([ "--game", game ])
}

async function ensureSamples(game, { force = false, maxCountOverride = null } = {}) {
  const { data: cfg } = loadAppConfig()

  const { uids: enkaUids, uidStart, uidEnd, countCfg, configured: enkaConfigured } = getEnkaUidSelector(cfg, game)
  const cfgModeRaw = (process.env.SAMPLE_MODE || cfg?.samples?.mode || (enkaConfigured ? "enka" : "playerdata")).toLowerCase()
  const sampleMode = game === "zzz" ? "enka" : cfgModeRaw
  const alwaysSample = envBool("SAMPLE_ALWAYS", cfg?.samples?.alwaysSample ?? true)

  if (!force && !alwaysSample && hasAnySamples(game)) return

  if (sampleMode === "enka") {
    if (await shouldSkipEnkaScanToday(game, cfg, { force })) {
      console.log(`[auto] sample:collect (enka) skipped game=${game} (daily gate reached)`)
      return
    }

    const delayMs = envNum("ENKA_DELAY_MS", cfg?.samples?.enka?.delayMs ?? 20_000)
    const jitterMs = envNum("ENKA_JITTER_MS", cfg?.samples?.enka?.jitterMs ?? 2_000)
    const concurrency = Math.max(1, Math.min(50, envNum("ENKA_CONCURRENCY", cfg?.samples?.enka?.concurrency ?? 1)))
    const maxCount =
      (Number.isFinite(Number(maxCountOverride)) && Number(maxCountOverride) > 0)
        ? Number(maxCountOverride)
        : envNum("ENKA_MAX_COUNT", cfg?.samples?.enka?.maxCount ?? 20)
    const cfgSaveRawFile = cfg?.samples?.enka?.saveRawFile ?? cfg?.samples?.enka?.saveRaw ?? false
    const saveRaw = envBool("ENKA_NO_RAW", false) ? false : cfgSaveRawFile

    // Prefer explicit uid list; fallback to range/count.
    if (!enkaConfigured) {
      const upper = String(game || "").toUpperCase()
      console.warn(
        `[auto] sample:collect (enka) skipped game=${game} (no uid list/range configured; set ENKA_UIDS_${upper}/ENKA_UID_START_${upper} or config.samples.enka.${game})`
      )
      return
    }

    const argv = [ "--game", game ]

    if (enkaUids.length > 0) {
      if (game === "zzz") {
        const ok = enkaUids.filter((u) => /^\d{8}$/.test(String(u)))
        if (ok.length === 0) {
          console.warn(`[auto] sample:collect (enka) skipped game=zzz (ENKA_UIDS must be 8-digit)`)
          return
        }
        if (ok.length !== enkaUids.length) {
          console.warn(`[auto] sample:collect (enka) game=zzz filtered invalid uids: kept=${ok.length}/${enkaUids.length}`)
        }
        console.log(`[auto] sample:collect (enka) uids=${ok.length} delayMs=${delayMs} saveRaw=${saveRaw}`)
        argv.push("--uids", ok.join(","))
      } else {
      console.log(`[auto] sample:collect (enka) uids=${enkaUids.length} delayMs=${delayMs} saveRaw=${saveRaw}`)
      argv.push("--uids", enkaUids.join(","))
      }
    } else if (Number.isFinite(uidStart) && (Number.isFinite(uidEnd) || Number.isFinite(countCfg))) {
      const effectiveMax = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 20
      if (Number.isFinite(uidEnd)) {
        // Retry due transient failures first (from sqlite state), then continue range scanning.
        const retryFirst = envNum("ENKA_RETRY_FIRST", cfg?.samples?.enka?.retryFirst ?? 0)
        const rescanCfg = cfg?.samples?.enka?.rescan || {}
        const rescanEnabled = envBool("ENKA_RESCAN_ENABLED", Boolean(rescanCfg?.enabled ?? false))
        const rescanAfterSec = envNum("ENKA_RESCAN_AFTER_SEC", Number(rescanCfg?.afterSec ?? 0))
        const rescanFirst = envNum("ENKA_RESCAN_FIRST", Number(rescanCfg?.first ?? 0))
        let remainingMax = effectiveMax
        if (retryFirst > 0) {
          const db = openScanDb()
          let due = []
          try {
            due = db.listDueRetryUids(Math.min(retryFirst, remainingMax), { game })
          } finally {
            db.close()
          }
          if (due.length > 0) {
            const retryArgv = [ "--game", game, "--uids", due.join(","), "--delayMs", String(delayMs), "--jitterMs", String(jitterMs) ]
            if (concurrency > 1) retryArgv.push("--concurrency", String(concurrency))
            if (!saveRaw) retryArgv.push("--no-raw")
            console.log(`[auto] sample:collect (enka) retry=${due.length}/${retryFirst} remainingMax=${remainingMax}`)
            await cmdSampleCollect(retryArgv)
            remainingMax = Math.max(0, remainingMax - due.length)
          }
        }

        // Periodic rescan: re-fetch oldest successful UIDs in the configured range,
        // so samples and extreme panels can be refreshed over time.
        if (remainingMax > 0 && rescanEnabled && rescanAfterSec > 0 && rescanFirst > 0) {
          const db = openScanDb()
          let stale = []
          try {
            stale = db.listStaleUids(Math.min(rescanFirst, remainingMax), {
              game,
              minAgeMs: rescanAfterSec * 1000,
              uidMin: uidStart,
              uidMax: uidEnd
            })
          } finally {
            db.close()
          }
          if (stale.length > 0) {
            const rescanArgv = [ "--game", game, "--uids", stale.join(","), "--delayMs", String(delayMs), "--jitterMs", String(jitterMs) ]
            if (concurrency > 1) rescanArgv.push("--concurrency", String(concurrency))
            if (!saveRaw) rescanArgv.push("--no-raw")
            console.log(`[auto] sample:collect (enka) rescan=${stale.length}/${rescanFirst} afterSec=${rescanAfterSec} remainingMax=${remainingMax}`)
            await cmdSampleCollect(rescanArgv)
            remainingMax = Math.max(0, remainingMax - stale.length)
          }
        }
        if (remainingMax <= 0) return

        const resetCursor = envBool("ENKA_CURSOR_RESET", false) || force
        const cursorName = `enka:${game}:${uidStart}-${uidEnd}`

        let start = uidStart
        if (!resetCursor) {
          const db = openScanDb()
          try {
            const cur = db.getCursor(cursorName, uidStart)
            if (Number.isFinite(cur?.next_uid)) start = Number(cur.next_uid) || uidStart
          } finally {
            db.close()
          }
        }

        if (game === "zzz") {
          const okStart = start >= 10_000_000 && start <= 99_999_999
          const okEnd = uidEnd >= 10_000_000 && uidEnd <= 99_999_999
          if (!okStart || !okEnd) {
            console.warn(`[auto] sample:collect (enka) skipped game=zzz (uidStart/uidEnd must be 8-digit)`)
            return
          }
        }

        const countRaw = Math.max(0, uidEnd - start + 1)
        if (countRaw <= 0) {
          console.log(`[auto] sample:collect (enka) range done (cursor=${start} end=${uidEnd})`)
          return
        }
        const count = Math.min(countRaw, remainingMax)

        console.log(`[auto] sample:collect (enka) uidStart=${start} count=${count} (end=${uidEnd}) delayMs=${delayMs} saveRaw=${saveRaw} cursor=${cursorName}`)
        argv.push("--uidStart", String(start), "--count", String(count), "--maxCount", String(count))

        argv.push("--delayMs", String(delayMs), "--jitterMs", String(jitterMs))
        if (concurrency > 1) argv.push("--concurrency", String(concurrency))
        if (!saveRaw) argv.push("--no-raw")
        await cmdSampleCollect(argv)

        const db2 = openScanDb()
        try {
          db2.setCursor(cursorName, start + count)
        } finally {
          db2.close()
        }
        return
      }

      if (game === "zzz") {
        const okStart = uidStart >= 10_000_000 && uidStart <= 99_999_999
        if (!okStart) {
          console.warn(`[auto] sample:collect (enka) skipped game=zzz (uidStart must be 8-digit)`)
          return
        }
      }

      const countRaw = Math.max(0, countCfg)
      if (countRaw <= 0) {
        throw new Error(`Invalid Enka count (uidStart=${uidStart} count=${countCfg})`)
      }
      const count = Math.min(countRaw, effectiveMax)
      console.log(`[auto] sample:collect (enka) uidStart=${uidStart} count=${count} (raw=${countRaw}) delayMs=${delayMs} saveRaw=${saveRaw}`)
      argv.push("--uidStart", String(uidStart), "--count", String(count), "--maxCount", String(count))
    }

    argv.push("--delayMs", String(delayMs), "--jitterMs", String(jitterMs))
    if (concurrency > 1) argv.push("--concurrency", String(concurrency))
    if (!saveRaw) argv.push("--no-raw")
    await cmdSampleCollect(argv)
    return
  }

  const playerDataDir = process.env.PLAYERDATA_DIR || cfg?.samples?.playerdata?.dir || ""
  const maxFiles = envNum("PLAYERDATA_MAX_FILES", cfg?.samples?.playerdata?.maxFiles ?? 0)

  console.log(`[auto] sample:collect (playerdata) dir=${playerDataDir || "(auto)"} maxFiles=${maxFiles || "all"}`)
  const ret = await collectPlayerDataSamples({
    game,
    playerDataDir: playerDataDir || undefined,
    maxFiles: maxFiles || 0
  })
  console.log(`[auto] samples written: chars=${ret.writtenChars} rows=${ret.writtenRows}`)
}

async function ensurePreset(game, { force = false } = {}) {
  const { data: cfg } = loadAppConfig()

  const defaultPresetUid = game === "zzz" ? "10000000" : "100000000"
  const uid =
    game === "zzz"
      ? (process.env.PRESET_UID_ZZZ || cfg?.preset?.uidZzz || defaultPresetUid)
      : (process.env.PRESET_UID || cfg?.preset?.uid || defaultPresetUid)
  const name = process.env.PRESET_NAME || cfg?.preset?.name || "极限面板"
  const limitChars = envNum("PRESET_LIMIT_CHARS", cfg?.preset?.limitChars ?? 0)
  const outPath = path.join(paths.outDir(game), `${uid}.json`)
  const alwaysGenerate = envBool("PRESET_ALWAYS", cfg?.preset?.alwaysGenerate ?? true)

  const updateGate = async () => {
    try {
      const row = await updateDailyGateFromPreset(game, cfg, { presetUid: uid, presetPath: outPath, force: false })
      if (!row) return
      const done = Boolean(row.done)
      const total = Number(row.total_chars || 0) || 0
      const qualified = Number(row.qualified_chars || 0) || 0
      console.log(`[preset] gate game=${game} done=${done ? 1 : 0} qualified=${qualified}/${total} day=${row.day || ""}`.trim())
    } catch (e) {
      console.warn(`[preset] gate update failed game=${game}: ${e?.message || String(e)}`)
    }
  }

  if (!force && !alwaysGenerate && fs.existsSync(outPath)) {
    await updateGate()
    return
  }

  console.log(`[auto] preset:generate --game ${game} --uid ${uid}`)
  const argv = [
    "--game", game,
    "--uid", uid,
    "--name", name,
    "--out", outPath
  ]
  if (limitChars > 0) argv.push("--limitChars", String(limitChars))
  await cmdPresetGenerate(argv)
  await updateGate()
}

async function main() {
  const { data: cfg, userPath } = loadAppConfig()

  const games = [ "gs", "sr", "zzz" ]

  const port = envNum("PORT", cfg?.server?.port ?? 4567)
  process.env.PORT = String(port)

  const force = envBool("FORCE", false)
  const noServer = envBool("NO_SERVER", !(cfg?.server?.enabled ?? true))

  console.log(`[auto] project=${projectRoot}`)
  console.log(`[auto] config=${userPath}`)
  console.log(`[auto] games=${games.join(",")}`)
  console.log(`[auto] out=${path.join(projectRoot, "out")}`)
  console.log(`[auto] port=${port} force=${force}`)

  // Start HTTP server early so WebUI is available while auto tasks run.
  if (!noServer) {
    await startServer({ port })
  }

  // Optional proxy pool (v2ray-core). This dynamically updates PROXY_URLS for Enka fetchers.
  const preservedProxyUrlsEnv = String(process.env.PROXY_URLS || "").trim()
  const setProxyUrlsEnv = (urls) => {
    const list = Array.isArray(urls) ? urls.map(String).map((s) => s.trim()).filter(Boolean) : []
    if (list.length > 0) process.env.PROXY_URLS = list.join(",")
    else if (preservedProxyUrlsEnv) process.env.PROXY_URLS = preservedProxyUrlsEnv
    else delete process.env.PROXY_URLS
  }

  const proxyPoolPromise = ensureProxyPool(cfg, {
    onUpdate: (urls) => setProxyUrlsEnv(urls)
  })
    .then((pool) => {
      if (pool?.enabled) console.log(`[auto] proxy pool: ${Array.isArray(pool.proxyUrls) ? pool.proxyUrls.length : 0}`)
      return pool
    })
    .catch((e) => {
      console.warn(`[auto] proxy pool failed; continue without proxy: ${e?.message || String(e)}`)
      setProxyUrlsEnv([])
      return null
    })

  const cleanupProxyPool = async () => {
    try {
      const pool = await proxyPoolPromise
      await pool?.close?.()
    } catch {}
  }
  // Best-effort cleanup on signals.
  process.on("SIGINT", () => { cleanupProxyPool(); process.exit(130) })
  process.on("SIGTERM", () => { cleanupProxyPool(); process.exit(143) })

  try {
    if (cfg?.meta?.autoSync ?? true) {
      for (const g of [ "gs", "sr" ]) {
        await ensureMeta(g, { force }).catch((e) => console.warn(`[auto] meta:sync failed game=${g}: ${e?.message || String(e)}`))
      }
    }

    const enkaGames = []
    for (const g of games) {
      const { sampleMode, enkaConfigured } = getAutoSampleMode(cfg, g)
      if (sampleMode === "enka" && enkaConfigured) enkaGames.push(g)
    }

    // If multiple games are scanning Enka, do a round-robin scan so we don't finish gs first
    // and only then start sr/zzz. This also helps keep progress visible across games.
    if (enkaGames.length >= 2) {
      const maxCount = envNum("ENKA_MAX_COUNT", cfg?.samples?.enka?.maxCount ?? 20)
      const cc = Math.max(1, Math.min(50, envNum("ENKA_CONCURRENCY", cfg?.samples?.enka?.concurrency ?? 1)))
      const stepCount = Math.max(50, Math.min(1000, envNum("ENKA_RR_STEP", cc * 10)))
      console.log(`[auto] enka round-robin: games=${enkaGames.join(",")} maxCount=${maxCount} stepCount=${stepCount}`)

      // Enable sqlite-backed per-proxy rate limit so delayMs does not reset between games.
      if (!process.env.ENKA_PROXY_RATE_LIMIT) process.env.ENKA_PROXY_RATE_LIMIT = "sqlite"

      const remaining = Object.fromEntries(enkaGames.map((g) => [g, maxCount]))
      while (true) {
        let did = false
        for (const g of games) {
          const rem = Number(remaining[g] || 0)
          if (rem <= 0) continue
          const per = Math.min(stepCount, rem)
          await ensureSamples(g, { force, maxCountOverride: per }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
          remaining[g] = Math.max(0, rem - per)
          did = true
        }
        if (!did) break
        if (enkaGames.every((g) => Number(remaining[g] || 0) <= 0)) break
      }

      // Non-Enka games (playerdata) still run once.
      for (const g of games) {
        if (enkaGames.includes(g)) continue
        await ensureSamples(g, { force }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
      }

      for (const g of games) {
        await ensurePreset(g, { force }).catch((e) => console.warn(`[auto] preset failed game=${g}: ${e?.message || String(e)}`))
      }
    } else {
      for (const g of games) {
        await ensureSamples(g, { force }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
        await ensurePreset(g, { force }).catch((e) => console.warn(`[auto] preset failed game=${g}: ${e?.message || String(e)}`))
      }
    }
  } finally {
    // Proxies are only needed during sampling; close them after preset generation.
    await cleanupProxyPool()
  }

  // In "no server" mode we exit after one auto run.
  if (noServer) return

  // Background jobs (best-effort): meta auto-update + periodic refresh (samples -> preset).
  const bootAt = Date.now()
  let lastMetaUpdateAt = bootAt
  let lastRefreshAt = bootAt
  let running = false

  const tickMs = Math.max(10_000, envNum("AUTO_TICK_MS", 30_000))

  const runMetaUpdate = async () => {
    const { data: cfg2 } = loadAppConfig({ ensureUser: false })
    const mu = cfg2?.meta?.autoUpdate || {}
    const enabled = envBool("META_AUTO_UPDATE", Boolean(mu?.enabled ?? false))
    if (!enabled) return

    const intervalSec = Math.max(60, envNum("META_AUTO_UPDATE_INTERVAL_SEC", Number(mu?.intervalSec ?? 86400)))
    const intervalMs = intervalSec * 1000
    const runOnStart = envBool("META_AUTO_UPDATE_RUN_ON_START", Boolean(mu?.runOnStart ?? false))
    if (!runOnStart && Date.now() - lastMetaUpdateAt < intervalMs) return

    console.log(`[auto] meta:autoUpdate begin intervalSec=${intervalSec}`)
    await cmdMetaSync([ "--game", "all" ])
    lastMetaUpdateAt = Date.now()
    console.log(`[auto] meta:autoUpdate done`)
  }

  const runRefresh = async () => {
    const { data: cfg2 } = loadAppConfig({ ensureUser: false })
    const ar = cfg2?.preset?.autoRefresh || {}
    const enabled = envBool("PRESET_AUTO_REFRESH", Boolean(ar?.enabled ?? false))
    if (!enabled) return

    const intervalSec = Math.max(60, envNum("PRESET_AUTO_REFRESH_INTERVAL_SEC", Number(ar?.intervalSec ?? 3600)))
    const intervalMs = intervalSec * 1000
    const runOnStart = envBool("PRESET_AUTO_REFRESH_RUN_ON_START", Boolean(ar?.runOnStart ?? false))
    const forceRefresh = envBool("PRESET_AUTO_REFRESH_FORCE", Boolean(ar?.force ?? true))
    if (!runOnStart && Date.now() - lastRefreshAt < intervalMs) return

    console.log(`[auto] preset:autoRefresh begin games=${games.join(",")} intervalSec=${intervalSec} force=${forceRefresh}`)

    // Optional proxy pool only for this refresh cycle.
    const preservedProxyUrlsEnvRefresh = String(process.env.PROXY_URLS || "").trim()
    const setProxyUrlsEnvRefresh = (urls) => {
      const list = Array.isArray(urls) ? urls.map(String).map((s) => s.trim()).filter(Boolean) : []
      if (list.length > 0) process.env.PROXY_URLS = list.join(",")
      else if (preservedProxyUrlsEnvRefresh) process.env.PROXY_URLS = preservedProxyUrlsEnvRefresh
      else delete process.env.PROXY_URLS
    }
    const poolPromise = ensureProxyPool(cfg2, {
      onUpdate: (urls) => setProxyUrlsEnvRefresh(urls)
    })
      .then((p) => {
        if (p?.enabled) console.log(`[auto] proxy pool: ${Array.isArray(p.proxyUrls) ? p.proxyUrls.length : 0}`)
        return p
      })
      .catch((e) => {
        console.warn(`[auto] proxy pool failed; continue without proxy: ${e?.message || String(e)}`)
        setProxyUrlsEnvRefresh([])
        return null
      })

    let pool = null
    try {
      // Ensure meta exists; meta updates are handled by meta.autoUpdate.
      if (cfg2?.meta?.autoSync ?? true) {
        for (const mg of [ "gs", "sr" ]) {
          await ensureMeta(mg, { force: false }).catch((e) => console.warn(`[auto] meta:sync failed game=${mg}: ${e?.message || String(e)}`))
        }
      }

      const enkaGames = []
      for (const g of games) {
        const { sampleMode, enkaConfigured } = getAutoSampleMode(cfg2, g)
        if (sampleMode === "enka" && enkaConfigured) enkaGames.push(g)
      }

      if (enkaGames.length >= 2) {
        const maxCount = envNum("ENKA_MAX_COUNT", cfg2?.samples?.enka?.maxCount ?? 20)
        const cc = Math.max(1, Math.min(50, envNum("ENKA_CONCURRENCY", cfg2?.samples?.enka?.concurrency ?? 1)))
        const stepCount = Math.max(50, Math.min(1000, envNum("ENKA_RR_STEP", cc * 10)))
        console.log(`[auto] enka round-robin: games=${enkaGames.join(",")} maxCount=${maxCount} stepCount=${stepCount}`)

        if (!process.env.ENKA_PROXY_RATE_LIMIT) process.env.ENKA_PROXY_RATE_LIMIT = "sqlite"

        const remaining = Object.fromEntries(enkaGames.map((g) => [g, maxCount]))
        while (true) {
          let did = false
          for (const g of games) {
            const rem = Number(remaining[g] || 0)
            if (rem <= 0) continue
            const per = Math.min(stepCount, rem)
            await ensureSamples(g, { force: forceRefresh, maxCountOverride: per }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
            remaining[g] = Math.max(0, rem - per)
            did = true
          }
          if (!did) break
          if (enkaGames.every((g) => Number(remaining[g] || 0) <= 0)) break
        }

        for (const g of games) {
          if (enkaGames.includes(g)) continue
          await ensureSamples(g, { force: forceRefresh }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
        }

        for (const g of games) {
          await ensurePreset(g, { force: forceRefresh }).catch((e) => console.warn(`[auto] preset failed game=${g}: ${e?.message || String(e)}`))
        }
      } else {
        for (const g of games) {
          await ensureSamples(g, { force: forceRefresh }).catch((e) => console.warn(`[auto] sample failed game=${g}: ${e?.message || String(e)}`))
          await ensurePreset(g, { force: forceRefresh }).catch((e) => console.warn(`[auto] preset failed game=${g}: ${e?.message || String(e)}`))
        }
      }

      lastRefreshAt = Date.now()
      console.log(`[auto] preset:autoRefresh done games=${games.join(",")}`)
    } finally {
      try {
        pool = await poolPromise
        await pool?.close?.()
      } catch {}
    }
  }

  const tick = async () => {
    if (running) return
    running = true
    try {
      await runMetaUpdate().catch((e) => console.warn(`[auto] meta:autoUpdate failed: ${e?.message || String(e)}`))
      await runRefresh().catch((e) => console.warn(`[auto] preset:autoRefresh failed: ${e?.message || String(e)}`))
    } finally {
      running = false
    }
  }

  // Keep timers from being kept alive by accident? The HTTP server already keeps the loop alive.
  setInterval(() => { tick().catch(() => {}) }, tickMs).unref?.()
  // One immediate check (will still honor runOnStart/interval).
  tick().catch(() => {})
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
