import fs from "node:fs/promises"
import { loadGsMeta } from "../meta/gs.js"
import { calcGsBuildMark } from "./gs.js"

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
  if (args.game !== "gs") throw new Error("Only --game gs is supported for now")
  if (!args.file) throw new Error("--file is required")

  const meta = await loadGsMeta()
  const txt = await fs.readFile(args.file, "utf8")
  const data = JSON.parse(txt)
  const avatars = data.avatars || {}

  const ids = args.charId ? [ String(args.charId) ] : Object.keys(avatars)
  for (const id of ids) {
    const a = avatars[id]
    if (!a?.artis) continue
    const ret = await calcGsBuildMark(meta, {
      charId: Number(a.id || id),
      charName: a.name,
      elem: a.elem,
      weapon: a.weapon,
      cons: a.cons,
      artis: a.artis
    })
    console.log(`${id} ${a.name} mark=${ret.mark}`)
  }
}

