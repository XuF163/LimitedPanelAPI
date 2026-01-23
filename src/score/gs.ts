import { Format } from "#miao"

const starEff = { 1: 0.21, 2: 0.36, 3: 0.6, 4: 0.9, 5: 1 }

export function calcGsMainAttr(meta, mainId, level, star) {
  const key = meta.artifact.mainIdMap[mainId]
  if (!key) return null
  const attrKey = Format.isElem(key, "gs") ? "dmg" : key
  const attrCfg = meta.artifact.attrMap[attrKey]
  if (!attrCfg?.value) return null
  const posEff = [ "hpPlus", "atkPlus", "defPlus" ].includes(key) ? 2 : 1
  const eff = starEff[star || 5] || 1
  return {
    id: mainId,
    key,
    value: attrCfg.value * (1.2 + 0.34 * (level || 0)) * posEff * eff
  }
}

export function calcGsSubAttrs(meta, attrIds = []) {
  const tmp = new Map()
  for (const id of attrIds || []) {
    const cfg = meta.artifact.attrIdMap[id]
    if (!cfg) continue
    const { key, value } = cfg
    const attrCfg = meta.artifact.attrMap[key]
    if (!key || !attrCfg) continue
    if (!tmp.has(key)) tmp.set(key, { key, upNum: 0, eff: 0, value: 0 })
    const ds = tmp.get(key)
    const mult = attrCfg.format === "pct" ? 100 : 1
    ds.value += value * mult
    ds.upNum++
    ds.eff += (value / attrCfg.value) * mult
  }
  return Array.from(tmp.values())
}

export function calcGsArti(meta, arti, idx) {
  const star = arti.star || 5
  const level = arti.level || 0
  const main = calcGsMainAttr(meta, arti.mainId, level, star)
  const attrs = calcGsSubAttrs(meta, arti.attrIds || [])
  if (!main) return null
  return {
    ...arti,
    idx,
    main,
    attrs
  }
}

export function buildArtisHelper(meta, artisMap = {}) {
  const mainAttr: any = {}
  const setCount: Record<string, number> = {}
  for (const idx of [ 1, 2, 3, 4, 5 ]) {
    const ds = artisMap[idx] || artisMap[String(idx)]
    const key = meta.artifact.mainIdMap?.[ds?.mainId]
    if (key) mainAttr[idx] = key
    const setName = ds?.setName || meta.artifact.artifactPieceByName.get(ds?.name)?.setName || ""
    if (setName) setCount[setName] = (setCount[setName] || 0) + 1
  }

  const setAbbrs = []
  for (const [ setName, countRaw ] of Object.entries(setCount)) {
    if (countRaw < 2) continue
    const count = countRaw >= 4 ? 4 : 2
    const abbr = meta.artifact.setAbbr?.[setName] || setName
    setAbbrs.push(`${abbr}${count}`)
    setAbbrs.push(`${setName}${count}`)
  }

  const isAttr = (attr, pos = "") => {
    const dmgIdx = 4
    const toList = (v, fallback = []) => {
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
      if (v == null || v === "") return fallback
      if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean)
      return [ String(v) ].map((s) => s.trim()).filter(Boolean)
    }
    const attrs = toList(attr, [])
    const positions = toList(pos, [ "3", "4", "5" ])
    for (const p of positions) {
      const idx = Number(p)
      const posAttr = mainAttr[idx]
      if (attrs.includes(posAttr)) continue
      if (idx === dmgIdx && attrs.includes("dmg") && Format.isElem(posAttr, "gs")) continue
      return false
    }
    return true
  }

  const is = (check, pos = "") => {
    if (pos) return isAttr(check, pos)
    const checks = (check || "").split(",").map((s) => s.trim()).filter(Boolean)
    for (const c of checks) {
      if (setAbbrs.includes(c)) return true
    }
    return false
  }

  return {
    is,
    isAttr,
    getMainAttr: () => ({ ...mainAttr })
  }
}

export async function getGsAttrWeight(meta, ctx) {
  const charName = ctx?.charName
  const charAbbr = ctx?.charAbbr || charName
  const weapon = ctx?.weapon || { name: "", affix: 1 }
  const attr = ctx?.attr || {}
  const artisHelper = ctx?.artisHelper || buildArtisHelper(meta, ctx?.artisMap || {})

  const rule = (title, attrWeight) => ({ title, attrWeight })

  const weaponCfg = {
    磐岩结绿: { attr: "hp", abbr: "绿剑", max: 30, min: 15 },
    猎人之径: { attr: "mastery" },
    薙草之稻光: { attr: "recharge", abbr: "薙刀" },
    护摩之杖: { attr: "hp", abbr: "护摩", max: 18, min: 10 }
  }

  const def = (attrWeight) => {
    const title = []
    const weight = { ...(attrWeight || {}) }

    const check = (key, max = 75, maxPlus = 75, isWeapon = true) => {
      const original = weight[key] || 0
      if (original >= max) return false
      const plus = isWeapon ? (maxPlus * (1 + (weapon.affix || 1) / 5)) / 2 : maxPlus
      weight[key] = Math.min(Math.round(original + plus), max)
      return true
    }

    const weaponCheck = (key, maxAffixAttr = 20, minAffixAttr = 10, max = 100) => {
      const original = weight[key] || 0
      if (original === max) return false
      const affix = weapon.affix || 1
      const plus = minAffixAttr + ((maxAffixAttr - minAffixAttr) * (affix - 1)) / 4
      weight[key] = Math.min(Math.round(original + plus), max)
      return true
    }

    const wn = weapon?.name || ""
    if ((weight.atk || 0) > 0 && weaponCfg[wn]) {
      const wCfg = weaponCfg[wn]
      if (weaponCheck(wCfg.attr, wCfg.max || 20, wCfg.min || 10)) title.push(wCfg.abbr || wn)
    }

    const maxWeight = Math.max(weight.atk || 0, weight.hp || 0, weight.def || 0, weight.mastery || 0)
    if (artisHelper.is("绝缘4") && check("recharge", maxWeight, 75, false)) title.push("绝缘4")

    const t = title.length > 0 ? title.join("") : "通用"
    return { title: `${charAbbr}-${t}`, attrWeight: weight }
  }

  const defaultAttrWeight = { atk: 75, cpct: 100, cdmg: 100, dmg: 100, phy: 100 }
  const baseWeight = meta.artifact.usefulAttr?.[charName] || defaultAttrWeight

  const charRule = (await meta.character.getArtisRule(charName)) || (({ def }) => def(baseWeight))

  const ret = charRule({ attr, rule, def, artis: artisHelper, weapon, cons: ctx?.cons, elem: ctx?.elem })
  if (!ret?.attrWeight) return def(baseWeight)
  return ret
}

export function buildGsCharCfg(meta, charBaseAttr, attrWeight) {
  const attrs = {}
  const baseAttr = charBaseAttr || { hp: 14000, atk: 230, def: 700 }
  for (const [ key, attr ] of Object.entries(meta?.artifact?.attrMap as any) as any) {
    const baseKey = attr.base || ""
    const weight = attrWeight[baseKey || key]
    if (!weight || weight * 1 === 0) continue
    const ret = { ...attr, weight, fixWeight: weight, mark: weight / attr.value }
    if (baseKey) {
      const plus = baseKey === "atk" ? 520 : 0
      ret.mark = (weight / meta.artifact.attrMap[baseKey].value / (baseAttr[baseKey] + plus)) * 100
      ret.fixWeight = (weight * attr.value / meta.artifact.attrMap[baseKey].value / (baseAttr[baseKey] + plus)) * 100
    }
    attrs[key] = ret
  }
  const posMaxMark = getMaxMark(meta, attrs)
  return { attrs, posMaxMark }
}

export function getMaxAttr(attrs, list, maxLen = 1, banAttr = "") {
  const tmp = []
  for (const attr of list) {
    if (attr === banAttr) continue
    if (!attrs[attr]) continue
    tmp.push({ attr, mark: attrs[attr].fixWeight })
  }
  tmp.sort((a, b) => b.mark - a.mark)
  return tmp.slice(0, maxLen).map((d) => d.attr)
}

export function getMaxMark(meta, attrs) {
  const ret = {}
  for (let idx = 1; idx <= 5; idx++) {
    let totalMark = 0
    let mMark = 0
    let mAttr = ""
    if (idx === 1) {
      mAttr = "hpPlus"
    } else if (idx === 2) {
      mAttr = "atkPlus"
    } else {
      mAttr = getMaxAttr(attrs, meta.artifact.mainAttr[idx])[0]
      mMark = attrs[mAttr].fixWeight
      totalMark += attrs[mAttr].fixWeight * 2
    }
    const sAttr = getMaxAttr(attrs, meta.artifact.subAttr, 4, mAttr)
    sAttr.forEach((a, aIdx) => {
      totalMark += attrs[a].fixWeight * (aIdx === 0 ? 6 : 1)
    })
    ret[idx] = totalMark
    ret[`m${idx}`] = mMark
  }
  return ret
}

export function calcGsArtiMark(meta, charCfg, idx, arti, elem) {
  const mAttr = arti.main
  const sAttr = arti.attrs
  const { attrs, posMaxMark } = charCfg
  const key = mAttr?.key
  if (!key) return 0

  let ret = 0
  let fixPct = 1
  const i = idx * 1
  if (i >= 3) {
    let mainKey = key
    if (key !== "recharge") {
      if (i === 4 && Format.sameElem(elem, key, "gs")) mainKey = "dmg"
      fixPct = Math.max(0, Math.min(1, (attrs[mainKey]?.weight || 0) / posMaxMark[`m${i}`]))
      if ([ "atk", "hp", "def" ].includes(mainKey) && (attrs[mainKey]?.weight || 0) >= 75) fixPct = 1
    }
    ret += (attrs[mainKey]?.mark || 0) * (mAttr.value || 0) / 4
  }

  for (const ds of sAttr || []) {
    ret += (attrs[ds.key]?.mark || 0) * (ds.value || 0)
  }
  return (ret * (1 + fixPct)) / 2 / posMaxMark[i] * 66
}

export async function calcGsBuildMark(meta, build) {
  const charId = build.charId
  const charMeta = meta.character.byId[charId] || {}
  const charName = build.charName || charMeta.name
  const charAbbr = charMeta.abbr || charName
  const elem = build.elem || charMeta.elem || ""

  const detail = await meta.character.getDetailByName(charName)
  const baseAttr = detail?.baseAttr

  const artisMap = build.artis || {}
  const parsed = {}
  for (const idx of [ 1, 2, 3, 4, 5 ]) {
    const ds = artisMap[idx] || artisMap[String(idx)]
    if (!ds?.mainId || !ds?.attrIds) continue
    parsed[idx] = calcGsArti(meta, ds, idx)
  }

  const aggAttr = {}
  for (const idx of Object.keys(parsed)) {
    const arti = parsed[idx]
    if (!arti) continue
    const add = (k, v) => {
      if (!k || !Number.isFinite(v)) return
      aggAttr[k] = (aggAttr[k] || 0) + v
    }
    const mk = arti.main?.key
    if (mk) add(mk, arti.main.value)
    for (const s of arti.attrs || []) add(s.key, s.value)
  }

  const artisHelper = buildArtisHelper(meta, artisMap)
  const { attrWeight } = await getGsAttrWeight(meta, {
    charName,
    charAbbr,
    elem,
    cons: build.cons ?? 6,
    weapon: build.weapon || { name: "", affix: 1 },
    attr: aggAttr,
    artisHelper,
    artisMap
  })
  const charCfg = buildGsCharCfg(meta, baseAttr, attrWeight)

  let total = 0
  const pieces = {}
  for (const idx of [ 1, 2, 3, 4, 5 ]) {
    const arti = parsed[idx]
    if (!arti) continue
    const mark = calcGsArtiMark(meta, charCfg, idx, arti, elem)
    pieces[idx] = mark
    total += mark
  }

  return {
    mark: Number(total.toFixed(1)),
    pieces: Object.fromEntries(Object.entries(pieces as any).map(([k, v]: any) => [ k, Number(v.toFixed(2)) ])),
    weight: attrWeight
  }
}
