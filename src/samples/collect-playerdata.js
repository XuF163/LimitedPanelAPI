import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { projectRoot, paths } from "../config.js"
import { ensureDir } from "../utils/fs.js"

function defaultPlayerDataDir(game) {
  // Repo layout assumption (this project lives under: <YunzaiRoot>/temp/LimitedPanelAPI)
  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  return path.join(yunzaiRoot, "data", "PlayerData", game)
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function normalizeWeapon(raw = {}) {
  return {
    id: toInt(raw?.id, 0) || undefined,
    name: String(raw?.name || ""),
    level: toInt(raw?.level, 1),
    promote: toInt(raw?.promote, 0),
    affix: toInt(raw?.affix, 1)
  }
}

function slotsByGame(game) {
  if (game === "sr") return [ 1, 2, 3, 4, 5, 6 ]
  return [ 1, 2, 3, 4, 5 ]
}

function normalizeArtisMap(raw = {}, game) {
  const out = {}
  for (const idx of slotsByGame(game)) {
    const ds = raw?.[idx] || raw?.[String(idx)]
    if (!ds) continue
    if (game === "sr") {
      out[idx] = {
        level: toInt(ds?.level, 0),
        star: toInt(ds?.star, 5),
        id: toInt(ds?.id, 0),
        mainId: toInt(ds?.mainId, 0),
        attrIds: Array.isArray(ds?.attrIds) ? ds.attrIds : []
      }
    } else {
      out[idx] = {
        level: toInt(ds?.level, 0),
        star: toInt(ds?.star, 5),
        name: String(ds?.name || ""),
        setName: String(ds?.setName || ""),
        mainId: toInt(ds?.mainId, 0),
        attrIds: Array.isArray(ds?.attrIds) ? ds.attrIds : []
      }
    }
  }
  return out
}

function hasRequiredArtis(artisMap, game) {
  return slotsByGame(game).every((k) => {
    const ds = artisMap[k] || artisMap[String(k)]
    if (!ds?.mainId) return false
    if (!Array.isArray(ds?.attrIds) || ds.attrIds.length <= 0) return false
    if (game === "sr") return Boolean(ds?.id)
    return Boolean(ds?.name)
  })
}

async function loadJsonSafe(filePath) {
  try {
    const txt = await fsp.readFile(filePath, "utf8")
    return JSON.parse(txt)
  } catch {
    return null
  }
}

/**
 * Build samples from local Yunzai PlayerData cache.
 *
 * Output:
 *   data/samples/<game>/<charId>.jsonl
 */
export async function collectPlayerDataSamples({
  game = "gs",
  playerDataDir = defaultPlayerDataDir(game),
  maxFiles = 0
} = {}) {
  if (!["gs", "sr"].includes(game)) {
    throw new Error(`Unsupported game for PlayerData sampling: ${game}`)
  }
  const srcDir = playerDataDir
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Missing PlayerData dir: ${srcDir} (set PLAYERDATA_DIR or use ENKA_UIDS)`)
  }

  const sampleDir = paths.samplesDir(game)
  await ensureDir(sampleDir)

  // Clear previous samples to avoid unbounded growth.
  for (const f of fs.readdirSync(sampleDir, { withFileTypes: true })) {
    if (!f.isFile()) continue
    if (!f.name.endsWith(".jsonl")) continue
    fs.unlinkSync(path.join(sampleDir, f.name))
  }

  const byCharId = new Map()
  const files = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /^\d{6,10}\.json$/i.test(d.name))
    .map((d) => d.name)
    .slice(0, maxFiles > 0 ? maxFiles : undefined)

  const now = Date.now()
  let scannedFiles = 0
  let scannedAvatars = 0
  for (const name of files) {
    scannedFiles++
    const filePath = path.join(srcDir, name)
    const raw = await loadJsonSafe(filePath)
    const uid = toInt(raw?.uid, toInt(name.replace(/\.json$/i, ""), 0))
    const avatars = raw?.avatars || {}

    for (const ds of Object.values(avatars)) {
      if (!ds?.id) continue
      scannedAvatars++
      const artis = normalizeArtisMap(ds?.artis || {}, game)
      if (!hasRequiredArtis(artis, game)) continue

      const rec = {
        uid,
        fetchedAt: now,
        charId: toInt(ds?.id, 0),
        charName: String(ds?.name || ""),
        elem: String(ds?.elem || ""),
        weapon: normalizeWeapon(ds?.weapon || {}),
        artis
      }

      const charId = rec.charId
      if (!byCharId.has(charId)) byCharId.set(charId, [])
      byCharId.get(charId).push(rec)
    }
  }

  let writtenChars = 0
  let writtenRows = 0
  for (const [ charId, rows ] of byCharId.entries()) {
    if (!rows.length) continue
    writtenChars++
    writtenRows += rows.length
    const outPath = path.join(sampleDir, `${charId}.jsonl`)
    const txt = rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    await fsp.writeFile(outPath, txt, "utf8")
  }

  return { srcDir, sampleDir, scannedFiles, scannedAvatars, writtenChars, writtenRows }
}
