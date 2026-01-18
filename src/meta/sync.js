import fs from "node:fs"
import path from "node:path"
import { metaRepo, paths } from "../config.js"
import { runCmd } from "../utils/exec.js"

function gitNoProxyArgs() {
  // Disable git's proxy settings regardless of global/system configs.
  // - `http.proxy` / `https.proxy`: libcurl proxy settings
  // - `core.gitproxy`: for git:// protocol (still safe to clear)
  return [
    "-c", "http.proxy=",
    "-c", "https.proxy=",
    "-c", "core.gitproxy="
  ]
}

function gitNoProxyEnv() {
  // Also clear common proxy env vars, in case user's environment sets them.
  // NOTE: git/libcurl honors both upper/lowercase on some platforms.
  return {
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    no_proxy: "*"
  }
}

async function runGit(args, options = {}) {
  return await runCmd("git", [...gitNoProxyArgs(), ...args], {
    ...options,
    env: { ...(options.env || {}), ...gitNoProxyEnv() }
  })
}

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
    await runGit([ "-C", targetDir, "fetch", "--depth=1", "origin", branch ])
    await runGit([ "-C", targetDir, "reset", "--hard", `origin/${branch}` ])
    return
  }

  if (fs.existsSync(targetDir)) {
    throw new Error(`Meta dir exists but is not a git repo: ${targetDir}`)
  }
  await runGit([ "clone", "-b", branch, metaRepo.url, targetDir, "--depth=1" ])
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

