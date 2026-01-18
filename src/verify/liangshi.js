import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { projectRoot } from "../config.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { calcGsBuildMark } from "../score/gs.js"
import { calcSrBuildMark } from "../score/sr.js"

const require = createRequire(import.meta.url)
const yaml = require("js-yaml")

function parseArgs(argv) {
  const args = { uid: "100000000", games: [ "gs", "sr" ] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--uid") args.uid = String(argv[++i] || args.uid)
    else if (a === "--games") args.games = String(argv[++i] || "").split(/[,\s]+/).filter(Boolean)
  }
  return args
}

async function readJson(filePath) {
  const txt = await fsp.readFile(filePath, "utf8")
  return JSON.parse(txt)
}

function readLiangshiPanelModel(yunzaiRoot) {
  try {
    const p = path.join(yunzaiRoot, "plugins", "liangshi-calc", "config", "config.yaml")
    if (!fs.existsSync(p)) return 1
    const raw = fs.readFileSync(p, "utf8")
    const cfg = yaml.load(raw) || {}
    const v = cfg.panelmodel
    if (typeof v === "number") return v
    if (typeof v === "string" && v.trim()) return v.trim()
    return 1
  } catch {
    return 1
  }
}

export async function cmdVerifyLiangshi(argv) {
  const args = parseArgs(argv)
  const uid = String(args.uid)
  const games = (args.games || []).map((g) => String(g).toLowerCase()).filter(Boolean)

  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  const panelModel = readLiangshiPanelModel(yunzaiRoot)

  const metaCache = {}
  for (const game of games) {
    if (!["gs", "sr"].includes(game)) {
      console.warn(`[skip] unsupported game=${game}`)
      continue
    }

    const ourPath = path.join(projectRoot, "out", game, `${uid}.json`)
    const basePath = path.join(yunzaiRoot, "plugins", "liangshi-calc", "replace", "data", String(panelModel), "PlayerData", game, `${uid}.json`)

    if (!fs.existsSync(ourPath)) {
      console.warn(`[missing] our ${game}: ${ourPath}`)
      continue
    }
    if (!fs.existsSync(basePath)) {
      console.warn(`[missing] liangshi ${game}: ${basePath}`)
      continue
    }

    const our = await readJson(ourPath)
    const base = await readJson(basePath)

    const ourAvatars = our?.avatars || {}
    const baseAvatars = base?.avatars || {}
    const ids = Object.keys(ourAvatars).filter((id) => baseAvatars[id])

    if (!metaCache[game]) {
      metaCache[game] = game === "gs" ? await loadGsMeta() : await loadSrMeta()
    }
    const meta = metaCache[game]

    console.log(`== verify liangshi game=${game} uid=${uid} panelmodel=${panelModel} ==`)
    console.log(`avatars: ours=${Object.keys(ourAvatars).length} liangshi=${Object.keys(baseAvatars).length} common=${ids.length}`)

    for (const id of ids) {
      const a = ourAvatars[id]
      const b = baseAvatars[id]
      if (!a?.artis || !b?.artis) continue

      if (game === "gs") {
        const am = await calcGsBuildMark(meta, { charId: Number(a.id || id), charName: a.name, elem: a.elem, weapon: a.weapon, cons: a.cons, artis: a.artis })
        const bm = await calcGsBuildMark(meta, { charId: Number(b.id || id), charName: b.name, elem: b.elem, weapon: b.weapon, cons: b.cons, artis: b.artis })
        const diff = Math.round((am.mark - bm.mark) * 10) / 10
        console.log(`${id} ${a.name}: ours=${am.mark} liangshi=${bm.mark} diff=${diff}`)
      } else {
        const am = calcSrBuildMark(meta, { charId: Number(a.id || id), charName: a.name, artis: a.artis })
        const bm = calcSrBuildMark(meta, { charId: Number(b.id || id), charName: b.name, artis: b.artis })
        const diff = Math.round((am.mark - bm.mark) * 10) / 10
        console.log(`${id} ${a.name}: ours=${am.mark} liangshi=${bm.mark} diff=${diff}`)
      }
    }
  }
}
