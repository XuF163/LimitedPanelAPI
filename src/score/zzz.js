import fs from "node:fs"
import path from "node:path"
import { projectRoot } from "../config.js"

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const percentPropIds = new Set([
  11102, 12102, 12202, 13102,
  20103, 21103, 23103, 30502, 31402,
  31503, 31603, 31703, 31803, 31903
])

function formatValue(propId, value) {
  if (percentPropIds.has(Number(propId))) {
    const v = Number(value)
    const fixed = v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)
    return `${fixed}%`
  }
  return String(Math.trunc(Number(value) || 0))
}

let cached = null

function loadMaps() {
  if (cached) return cached
  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  const mapDir = path.join(yunzaiRoot, "plugins", "ZZZ-Plugin", "resources", "map")

  const equipScoreByName = readJson(path.join(mapDir, "EquipScore.json"))
  const property2Name = readJson(path.join(mapDir, "Property2Name.json"))
  const baseValueData = readJson(path.join(mapDir, "EquipBaseValue.json"))

  const nameToId = {}
  for (const [ id, arr ] of Object.entries(property2Name)) {
    const fullName = arr?.[1]
    if (fullName) nameToId[String(fullName)] = Number(id)
  }
  const idToName = (id) => property2Name?.[String(id)]?.[1] || ""

  cached = { equipScoreByName, property2Name, baseValueData, nameToId, idToName }
  return cached
}

const predefinedRuleWeights = {
  "主C·双爆": {
    "生命值百分比": 0,
    "攻击力百分比": 0.75,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 1,
    "暴击伤害": 1,
    "穿透率": 1,
    "穿透值": 0.25,
    "能量自动回复": 0,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  },
  "主C·异常": {
    "生命值百分比": 0,
    "攻击力百分比": 0.75,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 0,
    "暴击伤害": 0,
    "穿透率": 1,
    "穿透值": 0.25,
    "能量自动回复": 0,
    "异常精通": 1,
    "异常掌控": 1,
    "属性伤害加成": 1
  },
  "命破·双爆": {
    "生命值百分比": 0.5,
    "攻击力百分比": 0.25,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 1,
    "暴击伤害": 1,
    "穿透率": 0,
    "穿透值": 0,
    "能量自动回复": 0,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  },
  "辅助·双爆": {
    "生命值百分比": 0,
    "攻击力百分比": 0.75,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 1,
    "暴击伤害": 1,
    "穿透率": 0.75,
    "穿透值": 0.25,
    "能量自动回复": 1,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  },
  "辅助·攻击": {
    "生命值百分比": 0,
    "攻击力百分比": 1,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 1,
    "暴击伤害": 0.75,
    "穿透率": 0.75,
    "穿透值": 0.25,
    "能量自动回复": 1,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  },
  "辅助·异常": {
    "生命值百分比": 0,
    "攻击力百分比": 0.75,
    "防御力百分比": 0,
    "冲击力": 0,
    "暴击率": 0,
    "暴击伤害": 0,
    "穿透率": 0.75,
    "穿透值": 0.25,
    "能量自动回复": 1,
    "异常精通": 1,
    "异常掌控": 1,
    "属性伤害加成": 1
  },
  "冲击·双爆": {
    "生命值百分比": 0,
    "攻击力百分比": 0.75,
    "防御力百分比": 0,
    "冲击力": 1,
    "暴击率": 1,
    "暴击伤害": 1,
    "穿透率": 0.75,
    "穿透值": 0.25,
    "能量自动回复": 0,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  },
  "冲击·攻击": {
    "生命值百分比": 0,
    "攻击力百分比": 1,
    "防御力百分比": 0,
    "冲击力": 1,
    "暴击率": 1,
    "暴击伤害": 0.75,
    "穿透率": 0.75,
    "穿透值": 0.25,
    "能量自动回复": 0,
    "异常精通": 0,
    "异常掌控": 0,
    "属性伤害加成": 1
  }
}

function mergeWeightNameMap(dst, src) {
  for (const [ k, v ] of Object.entries(src || {})) {
    if (k === "rules") continue
    const n = toNum(v, NaN)
    if (!Number.isFinite(n)) continue
    dst[k] = Math.max(toNum(dst[k], 0), n)
  }
}

export function getZzzWeightsByAvatar(metaAvatar) {
  const { equipScoreByName, nameToId, baseValueData } = loadMaps()

  const nameKeys = [
    metaAvatar?.full_name_mi18n,
    metaAvatar?.name_mi18n,
    // Fallbacks for objects that don't follow ZZZ-Plugin's field naming.
    metaAvatar?.full_name,
    metaAvatar?.name
  ].map((s) => String(s || "")).filter(Boolean)

  let entry = null
  for (const k of nameKeys) {
    if (equipScoreByName?.[k] != null) {
      entry = equipScoreByName[k]
      break
    }
  }

  const rules = []
  const overrides = {}
  if (Array.isArray(entry)) {
    rules.push(...entry)
  } else if (entry && typeof entry === "object") {
    if (Array.isArray(entry.rules)) rules.push(...entry.rules)
    mergeWeightNameMap(overrides, entry)
  } else {
    rules.push("主C·双爆")
  }

  const weightNameMap = {}
  for (const r of rules) {
    mergeWeightNameMap(weightNameMap, predefinedRuleWeights[r] || {})
  }
  mergeWeightNameMap(weightNameMap, overrides)

  const weightById = {}
  for (const [ propName, v ] of Object.entries(weightNameMap)) {
    if (propName === "属性伤害加成") continue
    const propId = /^\d+$/.test(propName) ? Number(propName) : nameToId[propName]
    if (!propId) continue
    // Only keep substats supported by baseValueData (sub roll table).
    if (baseValueData?.[String(propId)] == null) continue
    weightById[propId] = toNum(v, 0)
  }

  return weightById
}

function getEnhanceCount(baseValueData, propId, baseStr) {
  const baseValue = toNum(baseValueData?.[String(propId)], NaN)
  if (!Number.isFinite(baseValue) || baseValue <= 0) return 0
  const raw = String(baseStr || "").replace("%", "")
  const value = toNum(raw, 0)
  return Math.trunc(value / baseValue - 1 || 0)
}

function theoreticalMaxCount(baseValueData, weightById, mainPropId) {
  const candidates = Object.keys(baseValueData || {})
    .map((k) => Number(k))
    .filter((id) => Number.isFinite(id) && id !== Number(mainPropId) && toNum(weightById?.[id], 0) > 0)
    .sort((a, b) => toNum(weightById[b], 0) - toNum(weightById[a], 0))
    .slice(0, 4)

  if (candidates.length <= 0) return 0
  let max = toNum(weightById[candidates[0]], 0) * 6
  for (const id of candidates.slice(1)) {
    max += toNum(weightById[id], 0)
  }
  return max
}

export function calcZzzAvatarMark(metaAvatar) {
  const { baseValueData } = loadMaps()
  const weights = getZzzWeightsByAvatar(metaAvatar)
  const equipList = Array.isArray(metaAvatar?.equip) ? metaAvatar.equip : []

  let sum = 0
  for (const equip of equipList) {
    const mainPropId = equip?.main_properties?.[0]?.property_id
    const max = theoreticalMaxCount(baseValueData, weights, mainPropId)
    if (max <= 0) continue
    let actual = 0
    for (const p of equip?.properties || []) {
      const propId = Number(p?.property_id)
      const w = toNum(weights?.[propId], 0)
      if (w <= 0) continue
      const count = getEnhanceCount(baseValueData, propId, p?.base)
      actual += w * (count + 1)
    }
    sum += actual / max
  }

  const mark = Math.round(sum * 10000) / 100
  return { mark, weights }
}

export function buildZzzExtremeEquipList(metaAvatar) {
  const { baseValueData, idToName } = loadMaps()
  const { weights } = calcZzzAvatarMark(metaAvatar)
  const equipList = Array.isArray(metaAvatar?.equip) ? metaAvatar.equip : []

  const out = []
  for (const equip of equipList) {
    const mainPropId = Number(equip?.main_properties?.[0]?.property_id)
    const candidates = Object.keys(baseValueData || {})
      .map((k) => Number(k))
      .filter((id) => Number.isFinite(id) && id !== mainPropId && toNum(weights?.[id], 0) > 0)
      .sort((a, b) => toNum(weights[b], 0) - toNum(weights[a], 0))

    const picked = []
    for (const id of candidates) {
      if (picked.length >= 4) break
      if (!picked.includes(id)) picked.push(id)
    }
    for (const id of Object.keys(baseValueData || {}).map(Number)) {
      if (picked.length >= 4) break
      if (id === mainPropId) continue
      if (!picked.includes(id)) picked.push(id)
    }
    const topId = picked[0]

    const properties = picked.slice(0, 4).map((propId) => {
      const rolls = propId === topId ? 6 : 1
      const baseValue = toNum(baseValueData?.[String(propId)], 0)
      const value = baseValue * rolls
      return {
        property_name: idToName(propId),
        property_id: propId,
        base: formatValue(propId, value),
        level: rolls,
        valid: false,
        system_id: 0,
        add: Math.max(0, rolls - 1)
      }
    })

    out.push({
      ...equip,
      level: 15,
      properties
    })
  }
  return out
}
