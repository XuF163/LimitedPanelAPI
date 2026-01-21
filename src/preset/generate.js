import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { paths } from "../config.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { buildGsCharCfg, calcGsBuildMark } from "../score/gs.js"
import { calcSrBuildMark, getSrWeights } from "../score/sr.js"
import { calcZzzAvatarMark, buildZzzExtremeEquipList } from "../score/zzz.js"
import { buildZzzBestWeapon } from "../zzz/weapon.js"
import { ensureZzzSource } from "../zzz/source.js"
import { loadAppConfig } from "../user-config.js"
import { ensureDir, writeJson } from "../utils/fs.js"
import { createLogger } from "../utils/log.js"

const log = createLogger("预设")

function parseArgs(argv) {
  const args = {
    game: "gs",
    uid: "100000000",
    name: "极限面板",
    out: "",
    limitChars: 0,
    quiet: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i]
    else if (a === "--uid") args.uid = argv[++i]
    else if (a === "--name") args.name = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--limitChars") args.limitChars = Number(argv[++i])
    else if (a === "--quiet") args.quiet = true
  }
  return args
}

async function readJsonl(filePath) {
  const txt = await fsp.readFile(filePath, "utf8")
  return txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function pickTopSubKeys(meta, charCfg, banKey, count = 4) {
  const candidates = meta.artifact.subAttr
    .filter((k) => k !== banKey)
    .map((k) => ({ k, fw: Number(charCfg?.attrs?.[k]?.fixWeight || 0) }))
    .filter((d) => d.fw > 0)
    .sort((a, b) => b.fw - a.fw || a.k.localeCompare(b.k))

  const picked = []
  for (const c of candidates) {
    if (picked.length >= count) break
    if (picked.includes(c.k)) continue
    picked.push(c.k)
  }
  // 兜底补满
  for (const k of meta.artifact.subAttr) {
    if (picked.length >= count) break
    if (k === banKey) continue
    if (!picked.includes(k)) picked.push(k)
  }
  return picked.slice(0, count)
}

function genExtremeAttrIds(meta, keys) {
  const [ top, ...rest ] = keys
  const ids = []
  const topId = meta.artifact.maxAppendIdByKey[top]
  if (!topId) return []
  ids.push(...Array(6).fill(topId))
  for (const k of rest.slice(0, 3)) {
    const id = meta.artifact.maxAppendIdByKey[k]
    if (id) ids.push(id)
  }
  return ids
}

function pickBestMainKeyGs(meta, charCfg, idx, elem) {
  const list = Array.isArray(meta?.artifact?.mainAttr?.[idx]) ? meta.artifact.mainAttr[idx] : []
  if (!list.length) return null

  let bestKey = null
  let bestW = -1
  for (const k of list) {
    const key = String(k || "").trim()
    if (!key) continue
    const w = Number(charCfg?.attrs?.[key]?.fixWeight || 0)
    if (w > bestW) {
      bestW = w
      bestKey = key
    }
  }

  // Goblet special: if best is "dmg", map to element key for mainId selection.
  if (idx === 4 && bestKey === "dmg") {
    const e = String(elem || "").trim()
    const knownElems = [ "pyro", "hydro", "electro", "cryo", "anemo", "geo", "dendro" ]
    if (knownElems.includes(e)) return e

    // Fallback for traveler/unknown (e.g. elem=multi): pick any elemental goblet mainKey.
    for (const [ idStr, key ] of Object.entries(meta?.artifact?.mainIdMap || {})) {
      const id = Number(idStr)
      if (!Number.isFinite(id)) continue
      if (Math.floor(id / 1000) !== 15) continue
      const k = String(key || "").trim()
      if (knownElems.includes(k)) return k
    }

    // Meta should always have pyro; keep a deterministic fallback anyway.
    return "pyro"
  }
  return bestKey
}

function pickBestMainIdGs(meta, charCfg, idx, elem, fallbackMainId) {
  const expectedGroup = idx === 3 ? 10 : (idx === 4 ? 15 : (idx === 5 ? 13 : null))
  const bestKey = pickBestMainKeyGs(meta, charCfg, idx, elem)
  if (!bestKey || expectedGroup == null) return fallbackMainId

  const pairs = Object.entries(meta?.artifact?.mainIdMap || {})
  for (const [ idStr, key ] of pairs) {
    const id = Number(idStr)
    if (!Number.isFinite(id)) continue
    if (Math.floor(id / 1000) !== expectedGroup) continue
    if (String(key || "").trim() !== bestKey) continue
    return id
  }
  return fallbackMainId
}

async function selectBestSample(meta, charId) {
  const file = path.join(paths.samplesDir("gs"), `${charId}.jsonl`)
  if (!fs.existsSync(file)) return null
  const rows = await readJsonl(file)
  let best = null
  let bestMark = -1
  for (const r of rows) {
    const mark = await calcGsBuildMark(meta, {
      charId: Number(r.charId),
      charName: r.charName,
      elem: r.elem,
      weapon: r.weapon,
      cons: 6,
      artis: r.artis
    })
    if (mark.mark > bestMark) {
      bestMark = mark.mark
      best = { ...r, _mark: mark }
    }
  }
  return best
}

function pickTopSubKeysSr(meta, weights = {}, banKey, count = 4) {
  const candidates = meta.artifact.subAttr
    .filter((k) => k !== banKey)
    .map((k) => ({ k, w: Number(weights?.[k] || 0) }))
    .filter((d) => d.w > 0)
    .sort((a, b) => b.w - a.w || a.k.localeCompare(b.k))

  const picked = []
  for (const c of candidates) {
    if (picked.length >= count) break
    if (picked.includes(c.k)) continue
    picked.push(c.k)
  }
  // 兜底补满
  for (const k of meta.artifact.subAttr) {
    if (picked.length >= count) break
    if (k === banKey) continue
    if (!picked.includes(k)) picked.push(k)
  }
  return picked.slice(0, count)
}

function genExtremeAttrIdsSr(meta, keys) {
  const [ top, ...rest ] = keys
  const ids = []
  const topId = meta.artifact.subIdByKey[top]
  if (!topId) return []
  ids.push(`${topId},6,0`)
  for (const k of rest.slice(0, 3)) {
    const id = meta.artifact.subIdByKey[k]
    if (id) ids.push(`${id},1,0`)
  }
  return ids
}

async function selectBestSampleSr(meta, charId) {
  const file = path.join(paths.samplesDir("sr"), `${charId}.jsonl`)
  if (!fs.existsSync(file)) return null
  const rows = await readJsonl(file)
  let best = null
  let bestMark = -1
  const charName = meta.character.byId?.[charId]?.name || ""
  for (const r of rows) {
    const mark = calcSrBuildMark(meta, {
      charId: Number(r.charId),
      // Always prefer meta name. Old samples might contain mojibake charName and break weights lookup.
      charName,
      artis: r.artis
    })
    if (mark.mark > bestMark) {
      bestMark = mark.mark
      best = { ...r, _mark: mark }
    }
  }
  return best
}

async function selectBestSampleZzz(charId) {
  const file = path.join(paths.samplesDir("zzz"), `${charId}.jsonl`)
  if (!fs.existsSync(file)) return null
  const rows = await readJsonl(file)
  let best = null
  let bestMark = -1
  for (const r of rows) {
    const avatar = r?.avatar
    if (!avatar?.equip) continue
    const mark = calcZzzAvatarMark(avatar)
    if (mark.mark > bestMark) {
      bestMark = mark.mark
      best = { ...r, _mark: mark }
    }
  }
  return best
}

export async function cmdPresetGenerate(argv) {
  const args = parseArgs(argv)

  if (args.game === "gs") {
    const meta = await loadGsMeta()
    const outPath = args.out || path.join(paths.outDir("gs"), `${args.uid}.json`)
    await ensureDir(path.dirname(outPath))

    const sampleDir = paths.samplesDir("gs")
    if (!fs.existsSync(sampleDir)) {
      throw new Error(`缺少样本目录：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }
    const charIds = fs
      .readdirSync(sampleDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map((d) => d.name.replace(/\.jsonl$/, ""))
      .filter((s) => /^\d+$/.test(s))

    const ids = args.limitChars > 0 ? charIds.slice(0, args.limitChars) : charIds
    if (ids.length === 0) {
      throw new Error(`未找到任何样本文件：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }

    const result = {
      uid: String(args.uid),
      name: args.name,
      level: "",
      word: "",
      face: "",
      card: "",
      sign: "",
      info: false,
      _generatedAt: Date.now(),
      avatars: {}
    }

    for (const id of ids) {
      const charId = Number(id)
      const charMeta = meta.character.byId[charId]
      if (!charMeta) continue

      const best = await selectBestSample(meta, charId)
      if (!best) continue

      const weaponName = best.weapon?.name || ""
      const weapon = {
        name: weaponName,
        level: 90,
        promote: 6,
        affix: 5
      }

      const resolvedElem = String(best.elem || charMeta.elem || "").trim()

      const baseBuild = {
        charId,
        charName: charMeta.name,
        charAbbr: charMeta.abbr,
        elem: resolvedElem,
        cons: 6,
        weapon,
        artis: best.artis
      }

      const weightRet = await calcGsBuildMark(meta, baseBuild)
      const detail = await meta.character.getDetailByName(charMeta.name)
      const charCfg = buildGsCharCfg(meta, detail?.baseAttr, weightRet.weight)

      const artisOut = {}
      for (const idx of [ 1, 2, 3, 4, 5 ]) {
        const piece = best.artis[idx]
        if (!piece) continue
        const mainId = idx >= 3
          ? pickBestMainIdGs(meta, charCfg, idx, resolvedElem, piece.mainId)
          : piece.mainId
        const mainKey = meta.artifact.mainIdMap[mainId]
        const keys = pickTopSubKeys(meta, charCfg, mainKey, 4)
        const attrIds = genExtremeAttrIds(meta, keys)
        artisOut[idx] = {
          level: 20,
          star: 5,
          name: piece.name,
          mainId,
          attrIds
        }
      }

      const avatar = {
        name: charMeta.name,
        id: charId,
        elem: resolvedElem,
        level: 100,
        promote: 6,
        fetter: 10,
        costume: 0,
        cons: 6,
        talent: { a: 10, e: 10, q: 10 },
        weapon,
        artis: artisOut,
        _source: "enka",
        _time: Date.now(),
        _update: Date.now(),
        _talent: Date.now()
      }

      result.avatars[String(charId)] = avatar

      const extremeMark = await calcGsBuildMark(meta, {
        charId,
        charName: charMeta.name,
        elem: resolvedElem,
        cons: 6,
        weapon,
        artis: artisOut
      })
      avatar._mark = { mark: extremeMark.mark }
      if (!args.quiet) log.info(`${charId} ${charMeta.name}：样本=${best._mark.mark} 极限=${extremeMark.mark}`)
    }

    await writeJson(outPath, result, 2)
    if (args.quiet) log.info(`已写入：${outPath} 角色=${Object.keys(result.avatars).length}`)
    else log.info(`已写入：${outPath}`)
    return
  }

  if (args.game === "sr") {
    const meta = await loadSrMeta()
    const outPath = args.out || path.join(paths.outDir("sr"), `${args.uid}.json`)
    await ensureDir(path.dirname(outPath))

    const sampleDir = paths.samplesDir("sr")
    if (!fs.existsSync(sampleDir)) {
      throw new Error(`缺少样本目录：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }
    const charIds = fs
      .readdirSync(sampleDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map((d) => d.name.replace(/\.jsonl$/, ""))
      .filter((s) => /^\d+$/.test(s))

    const ids = args.limitChars > 0 ? charIds.slice(0, args.limitChars) : charIds
    if (ids.length === 0) {
      throw new Error(`未找到任何样本文件：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }

    const result = {
      uid: String(args.uid),
      name: args.name,
      level: "",
      word: "",
      face: "",
      card: "",
      sign: "",
      info: false,
      _generatedAt: Date.now(),
      avatars: {}
    }

    for (const id of ids) {
      const charId = Number(id)
      const charMeta = meta.character.byId[charId]
      if (!charMeta) continue

      const best = await selectBestSampleSr(meta, charId)
      if (!best) continue

      const weights = best._mark?.weights && Object.keys(best._mark.weights).length ? best._mark.weights : getSrWeights(meta, { charId, charName: charMeta.name })

      const weapon = {
        id: Number(best.weapon?.id || 0),
        level: 80,
        promote: 6,
        affix: 5
      }

      const artisOut = {}
      for (const idx of [ 1, 2, 3, 4, 5, 6 ]) {
        const piece = best.artis?.[idx] || best.artis?.[String(idx)]
        if (!piece) continue
        const mainKey = meta.artifact.mainIdx?.[String(idx)]?.[String(piece.mainId)] || null
        const keys = pickTopSubKeysSr(meta, weights, mainKey, 4)
        const attrIds = genExtremeAttrIdsSr(meta, keys)
        artisOut[idx] = {
          level: 15,
          star: 5,
          id: Number(piece.id || 0),
          mainId: Number(piece.mainId || 0),
          attrIds
        }
      }

      const avatar = {
        name: charMeta.name,
        id: charId,
        elem: charMeta.elem,
        level: 80,
        promote: 6,
        cons: 6,
        talent: { a: 6, e: 10, q: 10, t: 10 },
        weapon,
        artis: artisOut,
        _source: "enka",
        _time: Date.now(),
        _update: Date.now(),
        _talent: Date.now()
      }

      result.avatars[String(charId)] = avatar

      const extremeMark = calcSrBuildMark(meta, {
        charId,
        charName: charMeta.name,
        artis: artisOut
      })
      avatar._mark = { mark: extremeMark.mark }
      if (!args.quiet) log.info(`${charId} ${charMeta.name}：样本=${best._mark.mark} 极限=${extremeMark.mark}`)
    }

    await writeJson(outPath, result, 2)
    if (args.quiet) log.info(`已写入：${outPath} 角色=${Object.keys(result.avatars).length}`)
    else log.info(`已写入：${outPath}`)
    return
  }

  if (args.game === "zzz") {
    const { data: cfg } = loadAppConfig()
    await ensureZzzSource(cfg)

    const outPath = args.out || path.join(paths.outDir("zzz"), `${args.uid}.json`)
    await ensureDir(path.dirname(outPath))

    const sampleDir = paths.samplesDir("zzz")
    if (!fs.existsSync(sampleDir)) {
      throw new Error(`缺少样本目录：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }
    const charIds = fs
      .readdirSync(sampleDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map((d) => d.name.replace(/\.jsonl$/, ""))
      .filter((s) => /^\d+$/.test(s))

    const ids = args.limitChars > 0 ? charIds.slice(0, args.limitChars) : charIds
    if (ids.length === 0) {
      throw new Error(`未找到任何样本文件：${sampleDir}（请先运行：node src/cli.js sample:collect ...）`)
    }

    const result = {
      uid: String(args.uid),
      name: args.name,
      level: "",
      word: "",
      face: "",
      card: "",
      sign: "",
      info: false,
      _generatedAt: Date.now(),
      avatars: {}
    }

    for (const id of ids) {
      const charId = Number(id)
      const best = await selectBestSampleZzz(charId)
      if (!best?.avatar) continue

      const baseAvatar = best.avatar
      const extremeEquip = buildZzzExtremeEquipList(baseAvatar)
      const weaponPick = await buildZzzBestWeapon(baseAvatar)
      const outName = String(baseAvatar?.name_mi18n || baseAvatar?.full_name_mi18n || "")

      const outAvatar = {
        name: outName,
        name_mi18n: String(baseAvatar?.name_mi18n || outName),
        full_name_mi18n: String(baseAvatar?.full_name_mi18n || outName),
        id: charId,
        level: 60,
        element_type: baseAvatar?.element_type,
        avatar_profession: baseAvatar?.avatar_profession,
        rarity: baseAvatar?.rarity,
        rank: baseAvatar?.rank,
        weapon: weaponPick?.weapon || baseAvatar?.weapon || null,
        equip: extremeEquip,
        _source: "enka",
        _time: Date.now(),
        _update: Date.now()
      }

      result.avatars[String(charId)] = outAvatar

      const extremeMark = calcZzzAvatarMark({ ...baseAvatar, equip: extremeEquip })
      outAvatar._mark = { mark: extremeMark.mark }
      if (!args.quiet) log.info(`${charId} ${outAvatar.name}：样本=${best._mark.mark} 极限=${extremeMark.mark}${weaponPick?.signature ? " 专武" : ""}`)
    }

    await writeJson(outPath, result, 2)
    if (args.quiet) log.info(`已写入：${outPath} 角色=${Object.keys(result.avatars).length}`)
    else log.info(`已写入：${outPath}`)
    return
  }

  throw new Error(`不支持的 --game：${args.game}`)
}
