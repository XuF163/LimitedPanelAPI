import { cmdSampleCollect } from "../samples/collect.js"
import { shouldSkipEnkaScanToday } from "../samples/daily-gate.js"
import { openScanDb } from "../db/sqlite.js"
import { loadAppConfig } from "../user-config.js"
import { createLogger } from "../utils/log.js"
import { recordRecent, setAdaptiveStatus, setScannerGameRunning } from "./state.js"

const log = createLogger("runtime-scanner")

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

function toList(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (v == null || v === "") return []
  return String(v).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
}

function getGameCfg(cfg, game) {
  const enkaCfg = cfg?.samples?.enka || {}
  const gameCfg = enkaCfg?.[game] || {}
  return { enkaCfg, gameCfg }
}

function getUidSelector(cfg, game) {
  const { enkaCfg, gameCfg } = getGameCfg(cfg, game)
  const upper = String(game || "").toUpperCase()
  let uids = toList(gameCfg?.uids ?? enkaCfg?.uids ?? [])
  uids = toList(process.env[`ENKA_UIDS_${upper}`] || process.env.ENKA_UIDS || uids)

  const uidStart = envNum(`ENKA_UID_START_${upper}`, envNum("ENKA_UID_START", Number(gameCfg?.uidStart ?? enkaCfg?.uidStart ?? NaN)))
  const uidEnd = envNum(`ENKA_UID_END_${upper}`, envNum("ENKA_UID_END", Number(gameCfg?.uidEnd ?? enkaCfg?.uidEnd ?? NaN)))
  const countCfg = envNum(`ENKA_COUNT_${upper}`, envNum("ENKA_COUNT", Number(gameCfg?.count ?? enkaCfg?.count ?? NaN)))

  return {
    uids,
    uidStart: Number.isFinite(uidStart) ? uidStart : null,
    uidEnd: Number.isFinite(uidEnd) ? uidEnd : null,
    countCfg: Number.isFinite(countCfg) ? countCfg : null
  }
}

function normalizeGameSelector(game) {
  const g = String(game || "all").trim().toLowerCase()
  if (!g || g === "all") return [ "gs", "sr", "zzz" ]
  if ([ "gs", "sr", "zzz" ].includes(g)) return [ g ]
  throw new Error("invalid_game")
}

function makeAbortError() {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

class ScannerManager {
  tasks = new Map() // game -> { controller, promise }
  uidsCursor = new Map() // game -> idx

  isRunning(game) {
    return this.tasks.has(game)
  }

  async start({ game = "all" } = {}) {
    const games = normalizeGameSelector(game)
    await Promise.all(games.map((g) => this.startGame(g)))
    return { ok: true }
  }

  async stop({ game = "all" } = {}) {
    const games = normalizeGameSelector(game)
    await Promise.all(games.map((g) => this.stopGame(g)))
    return { ok: true }
  }

  async startGame(game) {
    const g = String(game).toLowerCase()
    if (this.tasks.has(g)) return

    const controller = new AbortController()
    setScannerGameRunning(g, true)
    const promise = this.runLoop(g, controller.signal)
      .catch((e) => {
        const msg = e?.name === "AbortError" ? null : (e?.message || String(e))
        if (msg) log.warn(`scanner stopped: game=${g} err=${msg}`)
        setScannerGameRunning(g, false, { error: msg })
      })
      .finally(() => {
        this.tasks.delete(g)
        setScannerGameRunning(g, false)
      })

    this.tasks.set(g, { controller, promise })
  }

  async stopGame(game) {
    const g = String(game).toLowerCase()
    const t = this.tasks.get(g)
    if (!t) return
    try {
      t.controller.abort()
    } catch {}
    try {
      await t.promise
    } catch {}
  }

  async runLoop(game, signal) {
    const g = String(game).toLowerCase()
    if (![ "gs", "sr", "zzz" ].includes(g)) throw new Error("invalid_game")

    while (true) {
      if (signal?.aborted) throw makeAbortError()

      const { data: cfg } = loadAppConfig({ ensureUser: false })

      // Only enka scanning is supported here (playerdata sampling is still handled by startup flow/CLI).
      const mode = String(process.env.SAMPLE_MODE || cfg?.samples?.mode || "enka").toLowerCase()
      if (g !== "zzz" && mode !== "enka") {
        throw new Error("sample_mode_not_enka")
      }

      if (await shouldSkipEnkaScanToday(g, cfg, { force: false })) {
        log.info(`daily gate reached, stop: game=${g}`)
        return
      }

      const { uids, uidStart, uidEnd, countCfg } = getUidSelector(cfg, g)
      const maxCount = envNum("ENKA_MAX_COUNT", Number(cfg?.samples?.enka?.maxCount ?? 20)) || 20
      const delayMs = envNum("ENKA_DELAY_MS", Number(cfg?.samples?.enka?.delayMs ?? 20_000)) || 20_000
      const jitterMs = envNum("ENKA_JITTER_MS", Number(cfg?.samples?.enka?.jitterMs ?? 2_000)) || 2_000

      const cfgSaveRawFile = cfg?.samples?.enka?.saveRawFile ?? cfg?.samples?.enka?.saveRaw ?? false
      const saveRaw = envBool("ENKA_NO_RAW", false) ? false : Boolean(cfgSaveRawFile)

      let argv = [ "--game", g, "--delayMs", String(delayMs), "--jitterMs", String(jitterMs), "--maxCount", String(maxCount) ]
      if (!saveRaw) argv.push("--no-raw")
      let afterRun = null

      if (uids.length > 0) {
        // For explicit lists, scan in batches using an in-memory cursor.
        // This loop runs continuously until stop is called.
        const idx = Number(this.uidsCursor.get(g) || 0) || 0
        const batch = uids.slice(idx, idx + maxCount)
        if (batch.length === 0) {
          log.info(`uid list finished, stop: game=${g}`)
          return
        }
        this.uidsCursor.set(g, idx + batch.length)
        argv = [ "--game", g, "--uids", batch.join(","), "--delayMs", String(delayMs), "--jitterMs", String(jitterMs), "--maxCount", String(batch.length) ]
        if (!saveRaw) argv.push("--no-raw")
      } else if (uidStart != null && uidEnd != null) {
        const cursorName = `enka:${g}:${uidStart}-${uidEnd}`
        const db = openScanDb()
        let start = uidStart
        try {
          const cur = db.getCursor(cursorName, uidStart)
          if (Number.isFinite(cur?.next_uid)) start = Number(cur.next_uid) || uidStart
        } finally {
          db.close()
        }
        const countRaw = Math.max(0, uidEnd - start + 1)
        if (countRaw <= 0) {
          log.info(`range finished, stop: game=${g}`)
          return
        }
        const count = Math.min(countRaw, maxCount)
        argv.push("--uidStart", String(start), "--count", String(count), "--maxCount", String(count))
        afterRun = async () => {
          const db2 = openScanDb()
          try {
            db2.setCursor(cursorName, start + count)
          } finally {
            db2.close()
          }
        }
      } else if (uidStart != null && countCfg != null) {
        const count = Math.min(Math.max(1, countCfg), maxCount)
        argv.push("--uidStart", String(uidStart), "--count", String(count), "--maxCount", String(count))
      } else {
        throw new Error("missing_uid_selector")
      }

      await cmdSampleCollect(argv, {
        signal,
        onRecent: (kind) => recordRecent(kind),
        onAdaptive: (snap) => setAdaptiveStatus(snap)
      })
      if (afterRun) await afterRun()
    }
  }
}

export const scannerManager = new ScannerManager()
