import fs from "node:fs"
import path from "node:path"
import { metaRepo, paths } from "../config.js"
import { runCmd } from "../utils/exec.js"

function parseArgs(argv) {
  const args = { game: "all" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i] || "all"
  }
  return args
}

async function syncOne(game) {
  const targetDir = game === "gs" ? paths.metaGs : paths.metaSr
  const branch = metaRepo.branch(game)

  if (fs.existsSync(path.join(targetDir, ".git"))) {
    await runCmd("git", [ "-C", targetDir, "fetch", "--depth=1", "origin", branch ])
    await runCmd("git", [ "-C", targetDir, "reset", "--hard", `origin/${branch}` ])
    return
  }

  if (fs.existsSync(targetDir)) {
    throw new Error(`Meta dir exists but is not a git repo: ${targetDir}`)
  }
  await runCmd("git", [ "clone", "-b", branch, metaRepo.url, targetDir, "--depth=1" ])
}

export async function cmdMetaSync(argv) {
  const { game } = parseArgs(argv)
  const games = game === "all" ? [ "gs", "sr" ] : [ game ]
  for (const g of games) {
    if (!["gs","sr"].includes(g)) throw new Error(`Invalid --game: ${g}`)
    await syncOne(g)
  }
  console.log("meta synced:", games.join(","))
}

