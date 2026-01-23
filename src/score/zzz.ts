import fs from "node:fs"
import path from "node:path"
import { loadAppConfig } from "../user-config.js"
import { resolveZzzLocalPluginRoot, resolveZzzMapDir } from "../zzz/source.js"

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

function elementType2propId(elementType) {
  const idx = toNum(elementType, NaN) - 200
  const id = [ 31503, 31603, 31703, 31803, undefined, 31903 ][idx]
  return Number.isFinite(id) ? id : 0
}

let cached = null

function loadMaps() {
  if (cached) return cached
  const { data: cfg } = loadAppConfig()
  let mapDir = resolveZzzMapDir(cfg)

  let required = [
    path.join(mapDir, "EquipScore.json"),
    path.join(mapDir, "Property2Name.json"),
    path.join(mapDir, "EquipBaseValue.json"),
    path.join(mapDir, "EquipMainStats.json")
  ]
  let missing = required.filter((p) => !fs.existsSync(p))
  if (missing.length) {
    const localRoot = resolveZzzLocalPluginRoot(cfg)
    const fallbackDir = path.join(localRoot, "resources", "map")
    required = [
      path.join(fallbackDir, "EquipScore.json"),
      path.join(fallbackDir, "Property2Name.json"),
      path.join(fallbackDir, "EquipBaseValue.json"),
      path.join(fallbackDir, "EquipMainStats.json")
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

  const equipScoreByName = readJson(path.join(mapDir, "EquipScore.json"))
  const property2Name = readJson(path.join(mapDir, "Property2Name.json"))
  const baseValueData = readJson(path.join(mapDir, "EquipBaseValue.json"))
  const mainStats = readJson(path.join(mapDir, "EquipMainStats.json"))

  const nameToId = {}
  for (const [ id, arr ] of Object.entries(property2Name)) {
    const fullName = arr?.[1]
    if (fullName) nameToId[String(fullName)] = Number(id)
  }
  const idToName = (id) => property2Name?.[String(id)]?.[1] || ""

  cached = { equipScoreByName, property2Name, baseValueData, mainStats, nameToId, idToName }
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

const ruleChecks = {
  "主C·双爆": (p) => {
    const ATK = toNum(p?.ATK, 0)
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    const AnomalyMastery = toNum(p?.AnomalyMastery, 0)
    const AnomalyProficiency = toNum(p?.AnomalyProficiency, 0)
    return ATK > 2400 && CRITRate * 2 + CRITDMG >= 2.2 && AnomalyMastery < 150 && AnomalyProficiency < 200
  },
  "主C·异常": (p) => {
    const ATK = toNum(p?.ATK, 0)
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    const AnomalyMastery = toNum(p?.AnomalyMastery, 0)
    const AnomalyProficiency = toNum(p?.AnomalyProficiency, 0)
    if (CRITRate * 2 + CRITDMG >= 2) return false
    if (ATK < 2400) return false
    if (AnomalyMastery >= 180 && AnomalyProficiency >= 200) return true
    if (AnomalyMastery >= 120 && AnomalyProficiency >= 300) return true
    if (AnomalyMastery >= 150 && AnomalyProficiency >= 250) return true
    return false
  },
  "命破·双爆": () => true,
  "辅助·双爆": (p) => {
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    const AnomalyProficiency = toNum(p?.AnomalyProficiency, 0)
    return CRITRate * 2 + CRITDMG >= 1.5 && AnomalyProficiency < 200
  },
  "辅助·攻击": (p) => {
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    return CRITRate * 2 + CRITDMG >= 1.5
  },
  "辅助·异常": (p) => {
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    const AnomalyProficiency = toNum(p?.AnomalyProficiency, 0)
    return CRITRate * 2 + CRITDMG < 2 && AnomalyProficiency >= 200
  },
  "冲击·双爆": (p) => {
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    return CRITRate * 2 + CRITDMG >= 1.5
  },
  "冲击·攻击": (p) => {
    const ATK = toNum(p?.ATK, 0)
    const CRITRate = toNum(p?.CRITRate, 0)
    const CRITDMG = toNum(p?.CRITDMG, 0)
    return ATK > 2000 && CRITRate * 2 + CRITDMG >= 1
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

function defaultRulesByProfession(avatarProfession) {
  const p = toNum(avatarProfession, 0)
  // professionEnum in ZZZ-Plugin:
  // 1 强攻, 2 击破, 3 异常, 4 支援, 5 防护, 6 命破
  if (p === 1) return [ "主C·双爆" ]
  if (p === 2) return [ "冲击·双爆", "冲击·攻击" ]
  if (p === 3) return [ "主C·异常", "辅助·异常" ]
  if (p === 4 || p === 5) return [ "辅助·双爆", "辅助·异常" ]
  if (p === 6) return [ "命破·双爆" ]
  return [ "主C·双爆" ]
}

function getInitialPropsForRuleChecks(metaAvatar) {
  const props = Array.isArray(metaAvatar?.properties) ? metaAvatar.properties : []
  const out = {
    ATK: 1000,
    CRITRate: 0.5,
    CRITDMG: 1,
    AnomalyMastery: 100,
    AnomalyProficiency: 100
  }

  for (const p of props) {
    const name = String(p?.property_name || "").trim()
    const raw = String(p?.final ?? p?.base ?? "").trim()
    if (!name || !raw) continue

    if (name === "攻击力") {
      out.ATK = toNum(raw.replace("%", ""), out.ATK)
      continue
    }

    if (name === "暴击率") {
      const v = toNum(raw.replace("%", ""), NaN)
      if (Number.isFinite(v)) out.CRITRate = raw.includes("%") ? v / 100 : v
      continue
    }

    if (name === "暴击伤害") {
      const v = toNum(raw.replace("%", ""), NaN)
      if (Number.isFinite(v)) out.CRITDMG = raw.includes("%") ? v / 100 : v
      continue
    }

    if (name === "异常掌控") {
      const v = toNum(raw.replace("%", ""), NaN)
      if (Number.isFinite(v)) out.AnomalyMastery = v
      continue
    }

    if (name === "异常精通") {
      const v = toNum(raw.replace("%", ""), NaN)
      if (Number.isFinite(v)) out.AnomalyProficiency = v
      continue
    }
  }

  return out
}

function pickRuleName(rules, initialProps) {
  const list = Array.isArray(rules) ? rules.map(String) : []
  if (list.length === 1) return list[0]
  for (const name of list) {
    const fn = ruleChecks?.[name]
    if (typeof fn === "function") {
      try {
        if (fn(initialProps)) return name
      } catch {}
    }
  }
  for (const name of list) {
    if (predefinedRuleWeights?.[name]) return name
  }
  return list[0] || "主C·双爆"
}

function formatWeightNameMapToId(weightNameMap, nameToId, metaAvatar) {
  const weightById = {}
  for (const [ propName, v ] of Object.entries(weightNameMap || {})) {
    if (propName === "rules") continue
    const n = toNum(v, NaN)
    if (!Number.isFinite(n)) continue
    let propId = 0
    if (/^\d+$/.test(propName)) {
      propId = Number(propName)
    } else if (propName === "属性伤害加成") {
      propId = elementType2propId(metaAvatar?.element_type)
    } else {
      propId = nameToId[propName] || 0
    }
    if (!propId) continue
    weightById[propId] = n
  }
  return weightById
}

function getAvatarBaseProperties(metaAvatar) {
  const props = Array.isArray(metaAvatar?.properties) ? metaAvatar.properties : []
  // Fallback defaults: keep non-zero so we can derive flat weights from % weights
  // even when samples were collected without full `properties` fields.
  const out = { HP: 20000, ATK: 1000, DEF: 800 }
  for (const p of props) {
    const id = Number(p?.property_id)
    const raw = String(p?.final ?? p?.base ?? "").replace("%", "")
    const v = toNum(raw, 0)
    if (id === 111 && v > 0) out.HP = v
    if (id === 121 && v > 0) out.ATK = v
    if (id === 131 && v > 0) out.DEF = v
  }
  return out
}

function ensureFlatWeightsFromPercents(weightByIdAll, baseValueData, metaAvatar) {
  const base = getAvatarBaseProperties(metaAvatar)
  for (const [ small, big, key ] of [ [ 11103, 11102, "HP" ], [ 12103, 12102, "ATK" ], [ 13103, 13102, "DEF" ] ]) {
    if (weightByIdAll?.[big] == null) continue
    if (weightByIdAll?.[small] != null) continue
    const baseSmall = toNum(baseValueData?.[String(small)], NaN)
    const baseBig = toNum(baseValueData?.[String(big)], NaN)
    const baseStat = toNum(base?.[key], NaN)
    if (!Number.isFinite(baseSmall) || baseSmall <= 0) continue
    if (!Number.isFinite(baseBig) || baseBig <= 0) continue
    if (!Number.isFinite(baseStat) || baseStat <= 0) continue
    weightByIdAll[small] = +(baseSmall * 100 / (baseBig * baseStat) * weightByIdAll[big]).toFixed(2)
  }
}

function getZzzWeightBundle(metaAvatar) {
  const { equipScoreByName, nameToId, baseValueData } = loadMaps()

  const nameKeys = [
    metaAvatar?.full_name_mi18n,
    metaAvatar?.name_mi18n,
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

  const defWeight = entry ?? defaultRulesByProfession(metaAvatar?.avatar_profession)
  const initialProps = getInitialPropsForRuleChecks(metaAvatar)

  let ruleName = "默认"
  let weightNameMap = null

  if (Array.isArray(defWeight)) {
    ruleName = pickRuleName(defWeight, initialProps)
    weightNameMap = predefinedRuleWeights?.[ruleName] || predefinedRuleWeights["主C·双爆"] || {}
  } else if (defWeight && typeof defWeight === "object") {
    const rules = Array.isArray(defWeight.rules) ? defWeight.rules : []
    if (rules.length) {
      ruleName = pickRuleName(rules, initialProps)
      weightNameMap = { ...(predefinedRuleWeights?.[ruleName] || {}), ...defWeight }
    } else {
      ruleName = "自定义"
      weightNameMap = defWeight
    }
  } else {
    ruleName = "主C·双爆"
    weightNameMap = predefinedRuleWeights["主C·双爆"] || {}
  }

  const weightByIdAll = formatWeightNameMapToId(weightNameMap, nameToId, metaAvatar)
  ensureFlatWeightsFromPercents(weightByIdAll, baseValueData, metaAvatar)

  const weightByIdSub = {}
  for (const [ id, v ] of Object.entries(weightByIdAll)) {
    if (baseValueData?.[String(id)] == null) continue
    weightByIdSub[Number(id)] = toNum(v, 0)
  }

  return { ruleName, weightByIdAll, weightByIdSub }
}

export function getZzzWeightsByAvatar(metaAvatar) {
  return getZzzWeightBundle(metaAvatar).weightByIdSub
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
  const { weightByIdSub: weights } = getZzzWeightBundle(metaAvatar)
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
  const { baseValueData, mainStats, idToName } = loadMaps()
  const { weightByIdAll, weightByIdSub } = getZzzWeightBundle(metaAvatar)
  const equipList = Array.isArray(metaAvatar?.equip) ? metaAvatar.equip : []

  const out = []
  for (const equip of equipList) {
    const part = Number(equip?.equipment_type)
    const oldMainPropId = Number(equip?.main_properties?.[0]?.property_id)
    let mainPropId = oldMainPropId

    // 456号位：主词条在可能范围内选择权重最高者，保证主词条得分满分
    if (part >= 4) {
      const allowed = mainStats?.[String(part)]
      if (Array.isArray(allowed) && allowed.length) {
        let bestId = null
        let bestW = -1
        for (const id of allowed.map(Number)) {
          const w = toNum(weightByIdAll?.[id], 0)
          if (w > bestW) {
            bestW = w
            bestId = id
          }
        }
        if (bestId != null && bestW > 0) mainPropId = Number(bestId)
      }
    }

    const candidates = Object.keys(baseValueData || {})
      .map((k) => Number(k))
      .filter((id) => Number.isFinite(id) && id !== mainPropId && toNum(weightByIdSub?.[id], 0) > 0)
      .sort((a, b) => toNum(weightByIdSub[b], 0) - toNum(weightByIdSub[a], 0))

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
      main_properties: (() => {
        const first = Array.isArray(equip?.main_properties) ? equip.main_properties[0] : null
        const main = {
          ...(first || {}),
          property_name: idToName(mainPropId),
          property_id: mainPropId
        }
        main.base ??= "0"
        main.level ??= 1
        main.valid ??= false
        main.system_id ??= 0
        main.add ??= 0
        return [ main ]
      })(),
      properties
    })
  }
  return out
}
