import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadAppConfig } from "../user-config.js"
import { ensureZzzSource, resolveZzzLocalPluginRoot, resolveZzzMapDir } from "./source.js"

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function toNum(value, fallback = NaN) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function rarityRank(rarity) {
  if (rarity === "S") return 3
  if (rarity === "A") return 2
  if (rarity === "B") return 1
  return 0
}

function expandNameTokens(name) {
  const raw = String(name || "").trim()
  if (!raw) return []

  const parts = raw
    .replace(/[「」【】]/g, " ")
    .replace(/[·&]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const out = new Set([ raw, ...parts ])
  // Avoid too-short tokens (e.g. "雅") unless it's the full name itself.
  return [ ...out ].filter((s) => s.length >= 2 || s === raw)
}

let _mapsCache
function loadZzzMaps() {
  if (_mapsCache) return _mapsCache

  const { data: cfg } = loadAppConfig()
  let mapDir = resolveZzzMapDir(cfg)
  let required = [
    path.join(mapDir, "WeaponId2Data.json"),
    path.join(mapDir, "PartnerId2Data.json")
  ]
  let missing = required.filter((p) => !fs.existsSync(p))
  if (missing.length) {
    const localRoot = resolveZzzLocalPluginRoot(cfg)
    const fallbackDir = path.join(localRoot, "resources", "map")
    required = [
      path.join(fallbackDir, "WeaponId2Data.json"),
      path.join(fallbackDir, "PartnerId2Data.json")
    ]
    missing = required.filter((p) => !fs.existsSync(p))
    if (missing.length) {
      const hint =
        `[zzz] missing map files under: ${mapDir}\n` +
        `missing: ${missing.join(", ")}\n` +
        `hint: set config zzz.source.type=github (or install Yunzai/plugins/ZZZ-Plugin)`
      throw new Error(hint)
    }
    mapDir = fallbackDir
  }

  const weaponById = readJson(path.join(mapDir, "WeaponId2Data.json"))
  const partnerById = readJson(path.join(mapDir, "PartnerId2Data.json"))

  _mapsCache = { mapDir, weaponById, partnerById }
  return _mapsCache
}

export function findZzzSignatureWeaponId(metaAvatar) {
  const { weaponById, partnerById } = loadZzzMaps()
  const dash = "\u2014\u2014"

  const avatarId = toNum(metaAvatar?.id, NaN)
  const partner = Number.isFinite(avatarId) ? partnerById?.[String(avatarId)] : null

  const rawNames = [
    metaAvatar?.full_name_mi18n,
    metaAvatar?.name_mi18n,
    partner?.full_name,
    partner?.name
  ].map((s) => String(s || "").trim()).filter(Boolean)

  const tokens = new Set<string>()
  for (const n of rawNames) {
    for (const t of expandNameTokens(n)) tokens.add(t)
  }

  const profession = Number.isFinite(toNum(metaAvatar?.avatar_profession, NaN))
    ? toNum(metaAvatar?.avatar_profession, NaN)
    : toNum(partner?.WeaponType, NaN)

  const candidates: any[] = []
  for (const w of Object.values(weaponById || {}) as any) {
    const text = [ w?.Desc, w?.Desc3 ].filter(Boolean).join("\n")
    if (!text || !text.includes(dash)) continue

    let matched = false
    for (const n of tokens) {
      if (text.includes(dash + n) || text.includes(dash + " " + n)) {
        matched = true
        break
      }
    }
    if (!matched) continue

    if (Number.isFinite(profession) && w?.Profession != null && toNum(w.Profession, NaN) !== profession) continue
    candidates.push(w)
  }

  if (candidates.length) {
    candidates.sort((a, b) =>
      rarityRank(b?.Rarity) - rarityRank(a?.Rarity) ||
      toNum(b?.Id, 0) - toNum(a?.Id, 0)
    )
    return toNum(candidates[0]?.Id, null)
  }

  // Fallback: if no quote-style match, use any mention of the name token in desc.
  let best: any = null
  for (const w of Object.values(weaponById || {}) as any) {
    const text = [ w?.Desc, w?.Desc3 ].filter(Boolean).join("\n")
    if (!text) continue
    if (Number.isFinite(profession) && w?.Profession != null && toNum(w.Profession, NaN) !== profession) continue
    for (const n of tokens) {
      if (!n) continue
      if (!text.includes(n)) continue
      if (!best || rarityRank(w?.Rarity) > rarityRank(best?.Rarity)) best = w
      break
    }
  }
  return best ? toNum(best?.Id, null) : null
}

let _formatterPromise
async function loadZzzEnkaFormatter() {
  if (_formatterPromise) return await _formatterPromise
  const { data: cfg } = loadAppConfig()
  const resolved = await ensureZzzSource(cfg).catch((e) => {
    throw new Error(`[zzz] missing source for formatter.js: ${e?.message || String(e)}`)
  })
  const filePath = path.join(resolved.pluginRoot, "model", "Enka", "formater.js")
  _formatterPromise = import(pathToFileURL(filePath).href)
  return await _formatterPromise
}

export async function buildZzzWeaponById(weaponId, { level = 60, upgradeLevel = 5, breakLevel = 5 } = {}) {
  const id = toNum(weaponId, NaN)
  if (!Number.isFinite(id)) return null

  const mod = await loadZzzEnkaFormatter()
  const Weapon = mod?.Weapon
  const enkaWeapon = {
    Id: id,
    Level: Math.max(1, Math.min(60, toNum(level, 60))),
    UpgradeLevel: Math.max(1, Math.min(5, toNum(upgradeLevel, 5))),
    BreakLevel: Math.max(0, Math.min(5, toNum(breakLevel, 5)))
  }

  try {
    if (typeof Weapon?.main === "function") return Weapon.main(enkaWeapon)
    if (typeof Weapon === "function") {
      const w = new Weapon(enkaWeapon)
      return w?.main?.() || null
    }
  } catch {}
  return null
}

export async function buildZzzBestWeapon(metaAvatar, { preferSignature = true } = {}) {
  const signatureWeaponId = preferSignature ? findZzzSignatureWeaponId(metaAvatar) : null
  if (signatureWeaponId) {
    const weapon = await buildZzzWeaponById(signatureWeaponId)
    if (weapon) return { weapon, signature: true, signatureWeaponId }
  }

  const fallbackId = toNum(metaAvatar?.weapon?.id, NaN)
  if (Number.isFinite(fallbackId)) {
    const weapon = await buildZzzWeaponById(fallbackId)
    if (weapon) return { weapon, signature: false, signatureWeaponId }
  }

  return { weapon: metaAvatar?.weapon || null, signature: false, signatureWeaponId }
}
