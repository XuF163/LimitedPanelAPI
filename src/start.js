#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { projectRoot, paths } from "./config.js"
import { loadAppConfig } from "./user-config.js"
import { cmdMetaSync } from "./meta/sync.js"
import { cmdSampleCollect } from "./samples/collect.js"
import { collectPlayerDataSamples } from "./samples/collect-playerdata.js"
import { cmdPresetGenerate } from "./preset/generate.js"
import { openScanDb } from "./db/sqlite.js"
import { ensureProxyPool } from "./proxy/pool.js"

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

function hasAnySamples(game) {
  const dir = paths.samplesDir(game)
  if (!fs.existsSync(dir)) return false
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  return files.length > 0
}

function hasMeta(game) {
  if (game === "zzz") return true
  const root = game === "gs" ? paths.metaGs : paths.metaSr
  return fs.existsSync(path.join(root, "artifact", "data.json")) && fs.existsSync(path.join(root, "character", "data.json"))
}

async function ensureMeta(game, { force = false } = {}) {
  if (game === "zzz") return
  if (!force && hasMeta(game)) return
  console.log(`[auto] meta:sync --game ${game}`)
  await cmdMetaSync([ "--game", game ])
}

async function ensureSamples(game, { force = false } = {}) {
  const { data: cfg } = loadAppConfig()

  const enkaUids = envList("ENKA_UIDS", cfg?.samples?.enka?.uids || [])
  const sampleMode = (process.env.SAMPLE_MODE || cfg?.samples?.mode || (enkaUids.length ? "enka" : "playerdata")).toLowerCase()
  const alwaysSample = envBool("SAMPLE_ALWAYS", cfg?.samples?.alwaysSample ?? true)

  if (game === "zzz" && sampleMode !== "enka") {
    throw new Error(`GAME=zzz only supports SAMPLE_MODE=enka for now`)
  }

  if (!force && !alwaysSample && hasAnySamples(game)) return

  if (sampleMode === "enka") {
    const delayMs = envNum("ENKA_DELAY_MS", cfg?.samples?.enka?.delayMs ?? 30_000)
    const jitterMs = envNum("ENKA_JITTER_MS", cfg?.samples?.enka?.jitterMs ?? 2_000)
    const concurrency = Math.max(1, Math.min(50, envNum("ENKA_CONCURRENCY", cfg?.samples?.enka?.concurrency ?? 1)))
    const maxCount = envNum("ENKA_MAX_COUNT", cfg?.samples?.enka?.maxCount ?? 20)
    const cfgSaveRawFile = cfg?.samples?.enka?.saveRawFile ?? cfg?.samples?.enka?.saveRaw ?? false
    const saveRaw = envBool("ENKA_NO_RAW", false) ? false : cfgSaveRawFile

    // Prefer explicit uid list; fallback to range/count.
    const uidStart = envNum("ENKA_UID_START", cfg?.samples?.enka?.uidStart ?? null)
    const uidEnd = envNum("ENKA_UID_END", cfg?.samples?.enka?.uidEnd ?? null)
    const countCfg = envNum("ENKA_COUNT", null)

    const argv = [ "--game", game ]

    if (enkaUids.length > 0) {
      console.log(`[auto] sample:collect (enka) uids=${enkaUids.length} delayMs=${delayMs} saveRaw=${saveRaw}`)
      argv.push("--uids", enkaUids.join(","))
    } else if (Number.isFinite(uidStart) && (Number.isFinite(uidEnd) || Number.isFinite(countCfg))) {
      const effectiveMax = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 20
      if (Number.isFinite(uidEnd)) {
        // Retry due transient failures first (from sqlite state), then continue range scanning.
        const retryFirst = envNum("ENKA_RETRY_FIRST", cfg?.samples?.enka?.retryFirst ?? 0)
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

      const countRaw = Math.max(0, countCfg)
      if (countRaw <= 0) {
        throw new Error(`Invalid Enka count (uidStart=${uidStart} count=${countCfg})`)
      }
      const count = Math.min(countRaw, effectiveMax)
      console.log(`[auto] sample:collect (enka) uidStart=${uidStart} count=${count} (raw=${countRaw}) delayMs=${delayMs} saveRaw=${saveRaw}`)
      argv.push("--uidStart", String(uidStart), "--count", String(count), "--maxCount", String(count))
    } else {
      throw new Error("SAMPLE_MODE=enka requires ENKA_UIDS or (ENKA_UID_START + ENKA_UID_END/ENKA_COUNT) or config.samples.enka")
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
  const uid = process.env.PRESET_UID || cfg?.preset?.uid || defaultPresetUid
  const name = process.env.PRESET_NAME || cfg?.preset?.name || "极限面板"
  const limitChars = envNum("PRESET_LIMIT_CHARS", cfg?.preset?.limitChars ?? 0)
  const outPath = path.join(paths.outDir(game), `${uid}.json`)
  const alwaysGenerate = envBool("PRESET_ALWAYS", cfg?.preset?.alwaysGenerate ?? true)

  if (!force && !alwaysGenerate && fs.existsSync(outPath)) return

  console.log(`[auto] preset:generate --game ${game} --uid ${uid}`)
  const argv = [
    "--game", game,
    "--uid", uid,
    "--name", name,
    "--out", outPath
  ]
  if (limitChars > 0) argv.push("--limitChars", String(limitChars))
  await cmdPresetGenerate(argv)
}

async function main() {
  const { data: cfg, userPath } = loadAppConfig()

  const game = (process.env.GAME || cfg?.game || "gs").toLowerCase()
  if (!["gs", "sr", "zzz"].includes(game)) throw new Error(`Unsupported GAME=${game}`)

  const port = envNum("PORT", cfg?.server?.port ?? 4567)
  process.env.PORT = String(port)

  const force = envBool("FORCE", false)
  const noServer = envBool("NO_SERVER", !(cfg?.server?.enabled ?? true))

  console.log(`[auto] project=${projectRoot}`)
  console.log(`[auto] config=${userPath}`)
  console.log(`[auto] out=${paths.outDir(game)}`)
  console.log(`[auto] port=${port} force=${force}`)

  // Optional proxy pool (v2ray-core). This sets PROXY_URLS for Enka fetchers.
  const proxyPool = await ensureProxyPool(cfg)
  const cleanupProxyPool = async () => {
    try {
      await proxyPool?.close?.()
    } catch {}
  }
  // Best-effort cleanup on signals.
  process.on("SIGINT", () => { cleanupProxyPool(); process.exit(130) })
  process.on("SIGTERM", () => { cleanupProxyPool(); process.exit(143) })

  try {
    if (proxyPool?.enabled) {
      const proxyUrls = Array.isArray(proxyPool.proxyUrls) ? proxyPool.proxyUrls : []
      if (proxyUrls.length > 0) {
        process.env.PROXY_URLS = proxyUrls.join(",")
        console.log(`[auto] proxy pool: ${proxyUrls.length}`)
      } else {
        delete process.env.PROXY_URLS
        console.log(`[auto] proxy pool: none`)
      }
    }

    if (cfg?.meta?.autoSync ?? true) {
      await ensureMeta(game, { force })
    }
    await ensureSamples(game, { force })
    await ensurePreset(game, { force })
  } finally {
    // Proxies are only needed during sampling; close them after preset generation.
    await cleanupProxyPool()
  }

  // Start HTTP server after preset is ready.
  if (noServer) return
  await import("./server.js")
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
