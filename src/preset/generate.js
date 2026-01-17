import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { paths } from "../config.js"
import { loadGsMeta } from "../meta/gs.js"
import { buildGsCharCfg, calcGsBuildMark } from "../score/gs.js"
import { ensureDir, writeJson } from "../utils/fs.js"

function parseArgs(argv) {
  const args = {
    game: "gs",
    uid: "100000000",
    name: "极限面板",
    out: "",
    limitChars: 0
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i]
    else if (a === "--uid") args.uid = argv[++i]
    else if (a === "--name") args.name = argv[++i]
    else if (a === "--out") args.out = argv[++i]
    else if (a === "--limitChars") args.limitChars = Number(argv[++i])
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

export async function cmdPresetGenerate(argv) {
  const args = parseArgs(argv)
  if (args.game !== "gs") throw new Error("Only --game gs is supported for now")

  const meta = await loadGsMeta()
  const outPath = args.out || path.join(paths.outDir("gs"), `${args.uid}.json`)
  await ensureDir(path.dirname(outPath))

  const sampleDir = paths.samplesDir("gs")
  if (!fs.existsSync(sampleDir)) {
    throw new Error(`Missing samples dir: ${sampleDir} (run: node src/cli.js sample:collect ...)`)
  }
  const charIds = fs
    .readdirSync(sampleDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => d.name.replace(/\.jsonl$/, ""))
    .filter((s) => /^\d+$/.test(s))

  const ids = args.limitChars > 0 ? charIds.slice(0, args.limitChars) : charIds

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

    const baseBuild = {
      charId,
      charName: charMeta.name,
      charAbbr: charMeta.abbr,
      elem: charMeta.elem,
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
      const mainKey = meta.artifact.mainIdMap[piece.mainId]
      const keys = pickTopSubKeys(meta, charCfg, mainKey, 4)
      const attrIds = genExtremeAttrIds(meta, keys)
      artisOut[idx] = {
        level: 20,
        star: 5,
        name: piece.name,
        mainId: piece.mainId,
        attrIds
      }
    }

    const avatar = {
      name: charMeta.name,
      id: charId,
      elem: charMeta.elem,
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
      elem: charMeta.elem,
      cons: 6,
      weapon,
      artis: artisOut
    })
    console.log(`${charId} ${charMeta.name}: sample=${best._mark.mark} extreme=${extremeMark.mark}`)
  }

  await writeJson(outPath, result, 2)
  console.log(`written: ${outPath}`)
}
