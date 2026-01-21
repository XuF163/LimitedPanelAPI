import fs from "node:fs/promises"
import { loadGsMeta } from "../meta/gs.js"
import { calcGsBuildMark } from "./gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { calcSrBuildMark } from "./sr.js"
import { createLogger } from "../utils/log.js"

const log = createLogger("评分")

function parseArgs(argv) {
  const args = { game: "gs", file: "", charId: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i]
    else if (a === "--file") args.file = argv[++i]
    else if (a === "--charId") args.charId = Number(argv[++i])
  }
  return args
}

export async function cmdScoreCalc(argv) {
  const args = parseArgs(argv)
  if (!args.file) throw new Error("--file 必填")

  if (!["gs", "sr"].includes(args.game)) throw new Error(`暂仅支持 --game gs|sr（当前：${args.game}）`)
  const meta = args.game === "sr" ? await loadSrMeta() : await loadGsMeta()
  const txt = await fs.readFile(args.file, "utf8")
  const data = JSON.parse(txt)
  const avatars = data.avatars || {}

  const ids = args.charId ? [ String(args.charId) ] : Object.keys(avatars)
  for (const id of ids) {
    const a = avatars[id]
    if (!a?.artis) continue
    if (args.game === "sr") {
      const ret = calcSrBuildMark(meta, {
        charId: Number(a.id || id),
        charName: a.name,
        artis: a.artis
      })
      log.info(`${id} ${a.name}：评分=${ret.mark}`)
    } else {
      const ret = await calcGsBuildMark(meta, {
        charId: Number(a.id || id),
        charName: a.name,
        elem: a.elem,
        weapon: a.weapon,
        cons: a.cons,
        artis: a.artis
      })
      log.info(`${id} ${a.name}：评分=${ret.mark}`)
    }
  }
}
