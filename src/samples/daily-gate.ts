import fs from "node:fs"
import path from "node:path"
import { openScanDb } from "../db/sqlite.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { calcGsBuildMark } from "../score/gs.js"
import { calcSrBuildMark } from "../score/sr.js"
import { calcZzzAvatarMark } from "../score/zzz.js"
import { ensureZzzSource, resolveZzzLocalPluginRoot, resolveZzzMapDir } from "../zzz/source.js"

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

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}

export function formatLocalDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function normalizeGame(game) {
  const g = String(game || "").trim().toLowerCase()
  if (g === "gs" || g === "sr" || g === "zzz") return g
  return "gs"
}

function getGateConfig(cfg: any = {}, game) {
  const g = normalizeGame(game)
  const gate = cfg?.samples?.enka?.dailyGate || {}
  const enabled = envBool("ENKA_DAILY_GATE_ENABLED", Boolean(gate?.enabled ?? false))
  const upper = g.toUpperCase()

  const thresholdCfg =
    (gate?.threshold && typeof gate.threshold === "object" ? gate.threshold[g] : gate?.threshold) ?? null
  const threshold = envNum(`ENKA_DAILY_GATE_THRESHOLD_${upper}`, thresholdCfg)

  return {
    enabled,
    threshold: Number.isFinite(Number(threshold)) ? Number(threshold) : null
  }
}

function readAvatarMark(avatar) {
  if (!avatar) return null
  if (typeof avatar._mark === "number") return avatar._mark
  const m = avatar?._mark?.mark
  if (typeof m === "number") return m
  if (typeof avatar?.mark === "number") return avatar.mark
  return null
}

function isGateDoneRow(row, { threshold }: any = {}) {
  if (!row || !row.done) return false
  const detail = parseJsonSafe(row.detail_json)
  if (Number.isFinite(threshold) && detail && detail.threshold != null) {
    const stored = Number(detail.threshold)
    if (Number.isFinite(stored) && stored !== threshold) return false
  }
  return true
}

async function listMetaCharacterIds(game, cfg) {
  const g = normalizeGame(game)
  if (g === "gs") {
    const meta = await loadGsMeta()
    return Object.keys(meta?.character?.byId || {})
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  }
  if (g === "sr") {
    const meta = await loadSrMeta()
    return Object.keys(meta?.character?.byId || {})
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  }
  if (g === "zzz") {
    // Best-effort: if zzz plugin resources are missing, treat as no meta list (gate disabled for zzz).
    try {
      await ensureZzzSource(cfg).catch(() => null)
    } catch {}
    const mapDir = resolveZzzMapDir(cfg)
    const candidate1 = path.join(mapDir, "PartnerId2Data.json")
    const localRoot = resolveZzzLocalPluginRoot(cfg)
    const candidate2 = path.join(localRoot, "resources", "map", "PartnerId2Data.json")
    const p = fs.existsSync(candidate1) ? candidate1 : (fs.existsSync(candidate2) ? candidate2 : null)
    if (!p) return []
    const byId = parseJsonSafe(fs.readFileSync(p, "utf8")) || {}
    return Object.keys(byId)
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  }
  return []
}

async function calcAvatarMark(game, avatar, { meta }: any = {}) {
  const g = normalizeGame(game)
  const cached = readAvatarMark(avatar)
  if (Number.isFinite(cached)) return cached

  if (g === "gs") {
    const charId = Number(avatar?.id)
    if (!Number.isFinite(charId)) return null
    const ret = await calcGsBuildMark(meta, {
      charId,
      charName: avatar?.name,
      elem: avatar?.elem,
      weapon: avatar?.weapon,
      cons: avatar?.cons,
      artis: avatar?.artis
    })
    return Number.isFinite(ret?.mark) ? ret.mark : null
  }

  if (g === "sr") {
    const charId = Number(avatar?.id)
    if (!Number.isFinite(charId)) return null
    const ret = calcSrBuildMark(meta, {
      charId,
      charName: avatar?.name,
      artis: avatar?.artis
    })
    return Number.isFinite(ret?.mark) ? ret.mark : null
  }

  if (g === "zzz") {
    const ret = calcZzzAvatarMark(avatar)
    return Number.isFinite(ret?.mark) ? ret.mark : null
  }

  return null
}

export async function shouldSkipEnkaScanToday(game, cfg, { force = false }: any = {}) {
  const g = normalizeGame(game)
  const { enabled, threshold } = getGateConfig(cfg, g)
  if (force || !enabled || !Number.isFinite(threshold)) return false

  const day = formatLocalDay(new Date())
  const db = openScanDb()
  try {
    const row = db.getDailyGate?.(g, day)
    return isGateDoneRow(row, { threshold })
  } finally {
    db.close()
  }
}

export async function updateDailyGateFromPreset(game, cfg, { presetUid, presetPath, force = false }: any = {}) {
  const g = normalizeGame(game)
  const { enabled, threshold } = getGateConfig(cfg, g)
  if (!enabled || !Number.isFinite(threshold)) return null

  const day = formatLocalDay(new Date())

  const db = openScanDb()
  try {
    const prev = db.getDailyGate?.(g, day)
    if (!force && isGateDoneRow(prev, { threshold })) return prev
  } finally {
    db.close()
  }

  const filePath =
    presetPath ||
    (presetUid ? path.join(process.cwd(), "out", g, `${presetUid}.json`) : null)

  if (!filePath || !fs.existsSync(filePath)) return null

  const preset = parseJsonSafe(fs.readFileSync(filePath, "utf8"))
  const avatars = preset?.avatars && typeof preset.avatars === "object" ? preset.avatars : {}

  const metaCharIds = await listMetaCharacterIds(g, cfg)
  const totalChars = metaCharIds.length

  let meta = null
  if (g === "gs") meta = await loadGsMeta()
  else if (g === "sr") meta = await loadSrMeta()

  const missing = []
  const below = []
  let qualified = 0

  for (const charId of metaCharIds) {
    const a = avatars[String(charId)] || null
    if (!a) {
      missing.push({ charId })
      continue
    }
    const mark = await calcAvatarMark(g, a, { meta })
    if (Number.isFinite(mark) && mark >= threshold) {
      qualified++
      continue
    }
    below.push({ charId, mark: Number.isFinite(mark) ? mark : null })
  }

  const done = totalChars > 0 && qualified === totalChars
  const detail = {
    threshold,
    presetUid: presetUid != null ? String(presetUid) : null,
    presetPath: filePath,
    generatedAt: preset?._generatedAt ?? null,
    missing,
    below
  }

  const now = Date.now()
  const row = {
    game: g,
    day,
    done: done ? 1 : 0,
    done_at: done ? now : null,
    total_chars: totalChars,
    qualified_chars: qualified,
    detail_json: JSON.stringify(detail)
  }

  const db2 = openScanDb()
  try {
    db2.setDailyGate?.(g, day, {
      done: Boolean(row.done),
      doneAt: row.done_at,
      totalChars: row.total_chars,
      qualifiedChars: row.qualified_chars,
      detailJson: row.detail_json
    })
  } finally {
    db2.close()
  }

  return row
}
