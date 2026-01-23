import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { paths, projectRoot } from "../config.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { calcGsBuildMark } from "../score/gs.js"
import { calcSrBuildMark } from "../score/sr.js"
import { calcZzzAvatarMark } from "../score/zzz.js"
import { loadAppConfig } from "../user-config.js"
import { createLogger } from "../utils/log.js"

const log = createLogger("校验")

function toNum(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toList(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (v == null || v === "") return []
  return String(v)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function percentile(sorted, p) {
  const arr = Array.isArray(sorted) ? sorted : []
  if (!arr.length) return null
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * arr.length)))
  return arr[idx]
}

async function readJson(filePath) {
  const txt = await fsp.readFile(filePath, "utf8")
  return JSON.parse(txt)
}

function parseArgs(argv) {
  const args = {
    game: "gs",
    uid: "",
    threshold: null,
    limit: 0,
    quiet: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = String(argv[++i] || args.game)
    else if (a === "--uid") args.uid = String(argv[++i] || args.uid)
    else if (a === "--threshold") args.threshold = toNum(argv[++i], null)
    else if (a === "--limit") args.limit = Math.max(0, toInt(argv[++i], 0))
    else if (a === "--quiet") args.quiet = true
  }
  return args
}

function defaultThreshold(cfg, game) {
  const fallback = game === "zzz" ? 590 : 300
  const v = cfg?.samples?.enka?.dailyGate?.threshold?.[game]
  const n = toNum(v, fallback)
  return n > 0 ? n : fallback
}

export async function cmdVerifyPreset(argv) {
  const args = parseArgs(argv)
  const game = String(args.game || "").trim().toLowerCase()
  if (!["gs", "sr", "zzz"].includes(game)) {
    throw new Error(`Unsupported --game: ${game}`)
  }

  const uid = String(args.uid || (game === "zzz" ? "10000000" : "100000000")).trim()
  const outPath = path.join(paths.outDir(game), `${uid}.json`)
  if (!fs.existsSync(outPath)) {
    throw new Error(`Missing preset: ${outPath} (run: node dist/cli.js preset:generate --game ${game} --uid ${uid})`)
  }

  const { data: cfg } = loadAppConfig({ ensureUser: false })
  const threshold = args.threshold == null ? defaultThreshold(cfg, game) : toNum(args.threshold, defaultThreshold(cfg, game))

  const ds = await readJson(outPath)
  const avatars = ds?.avatars || {}
  const ids = Object.keys(avatars)
  const limitedIds = args.limit > 0 ? ids.slice(0, args.limit) : ids

  const meta = game === "gs" ? await loadGsMeta() : (game === "sr" ? await loadSrMeta() : null)

  const rows = []
  for (const id of limitedIds) {
    const a = avatars[id]
    if (!a) continue
    const charId = toInt(a?.id ?? id, NaN)
    const name = String(a?.name || a?.name_mi18n || a?.full_name_mi18n || id)
    const mark = (() => {
      if (game === "gs") {
        return calcGsBuildMark(meta, {
          charId,
          charName: String(a?.name || name),
          elem: String(a?.elem || ""),
          weapon: a?.weapon || null,
          cons: toInt(a?.cons, 0),
          artis: a?.artis || {}
        }).then((r) => r?.mark ?? null)
      }
      if (game === "sr") {
        return Promise.resolve(calcSrBuildMark(meta, { charId, charName: String(a?.name || name), artis: a?.artis || {} })?.mark ?? null)
      }
      return Promise.resolve(calcZzzAvatarMark(a)?.mark ?? null)
    })()

    const m = await mark
    rows.push({
      id: String(id),
      name,
      mark: typeof m === "number" && Number.isFinite(m) ? Number(m.toFixed(1)) : null
    })
  }

  const marks = rows.map((r) => r.mark).filter((n) => typeof n === "number" && Number.isFinite(n))
  marks.sort((a, b) => a - b)
  const min = marks.length ? marks[0] : null
  const p50 = percentile(marks, 50)
  const p90 = percentile(marks, 90)
  const mean = marks.length ? Number((marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(3)) : null

  const failed = rows
    .filter((r) => typeof r.mark !== "number" || !Number.isFinite(r.mark) || r.mark < threshold)
    .sort((a, b) => (Number(a.mark) || 0) - (Number(b.mark) || 0))

  const pass = failed.length === 0 && marks.length > 0
  const summary = {
    game,
    uid,
    outPath,
    threshold,
    total: rows.length,
    withMark: marks.length,
    pass,
    stats: { min, p50, p90, mean },
    failed: failed.slice(0, 20)
  }

  if (!args.quiet) {
    log.info(`预设：game=${game} uid=${uid} 阈值=${threshold} 通过=${pass ? 1 : 0}`)
    log.info(`统计：角色=${summary.total} 有评分=${summary.withMark} min=${min} p50=${p50} p90=${p90} mean=${mean}`)
    if (summary.failed.length) {
      log.warn(`未达标(top${summary.failed.length})：${summary.failed.map((r) => `${r.name}(${r.id}):${r.mark}`).join("; ")}`)
    }
  }

  if (!pass) {
    process.exitCode = 1
  }
  return summary
}
