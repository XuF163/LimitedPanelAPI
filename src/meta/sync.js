import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { metaRepo as defaultMetaRepo, paths, projectRoot } from "../config.js"
import { loadAppConfig } from "../user-config.js"
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

function nonEmptyStr(value) {
  if (value == null) return ""
  const s = String(value).trim()
  return s
}

function resolvePathMaybeRelative(p, baseDir) {
  const s = nonEmptyStr(p)
  if (!s) return ""
  return path.isAbsolute(s) ? s : path.resolve(baseDir, s)
}

function parseArgs(argv) {
  const args = { game: "all" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i] || "all"
  }
  return args
}

function guessYunzaiRoot() {
  // Typical layout: <YunzaiRoot>/temp/LimitedPanelAPI
  // If you run this project elsewhere, configure meta.source.miaoPlugin.dir explicitly.
  return path.resolve(projectRoot, "..", "..")
}

function guessInstalledMiaoPluginDir() {
  return path.join(guessYunzaiRoot(), "plugins", "miao-plugin")
}

async function syncFromCnb(game, cfg) {
  const targetDir = game === "gs" ? paths.metaGs : paths.metaSr

  const cnbCfg = cfg?.meta?.source?.cnb || {}
  const repo = nonEmptyStr(cnbCfg.repo) || defaultMetaRepo.url
  const branch = nonEmptyStr(cnbCfg?.branch?.[game]) || defaultMetaRepo.branch(game)

  if (fs.existsSync(path.join(targetDir, ".git"))) {
    try {
      await runGit([ "-C", targetDir, "remote", "set-url", "origin", repo ])
    } catch {}
    await runGit([ "-C", targetDir, "fetch", "--depth=1", "origin", branch ])
    await runGit([ "-C", targetDir, "reset", "--hard", `origin/${branch}` ])
    return { repo, branch }
  }

  if (fs.existsSync(targetDir)) {
    // Switching source types (e.g. from miao-plugin copy to cnb git clone) may leave a non-git dir here.
    fs.rmSync(targetDir, { recursive: true, force: true })
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  await runGit([ "clone", "-b", branch, repo, targetDir, "--depth=1" ])
  return { repo, branch }
}

function resolveMiaoPluginSource(cfg) {
  const mpCfg = cfg?.meta?.source?.miaoPlugin || cfg?.meta?.source?.miaoplugin || {}

  const explicitDir = resolvePathMaybeRelative(mpCfg.dir, projectRoot)
  if (explicitDir) {
    return { kind: "dir", dir: explicitDir, managed: false }
  }

  const guessDir = guessInstalledMiaoPluginDir()
  if (fs.existsSync(path.join(guessDir, "resources", "meta-gs"))) {
    return { kind: "dir", dir: guessDir, managed: false }
  }

  const gitCfg = mpCfg.git || {}
  const dir = resolvePathMaybeRelative(gitCfg.dir || "./resources/miao-plugin", projectRoot)
  const repo = nonEmptyStr(gitCfg.repo) || "https://github.com/yoimiya-kokomi/miao-plugin.git"
  const refRaw = nonEmptyStr(gitCfg.ref)
  const ref = refRaw || "master"
  return { kind: "git", dir, repo, ref, refIsDefault: !refRaw, managed: true }
}

async function ensureMiaoPluginRepo(miao) {
  if (!miao?.dir) throw new Error("Invalid miao-plugin repo dir")

  if (fs.existsSync(path.join(miao.dir, ".git"))) {
    try {
      await runGit([ "-C", miao.dir, "remote", "set-url", "origin", miao.repo ])
    } catch {}
    try {
      await runGit([ "-C", miao.dir, "fetch", "--depth=1", "origin", miao.ref ])
    } catch (e) {
      if (!miao.refIsDefault) throw e
      // Common default branch name fallback
      await runGit([ "-C", miao.dir, "fetch", "--depth=1", "origin", "main" ])
      miao.ref = "main"
    }
    await runGit([ "-C", miao.dir, "reset", "--hard", "FETCH_HEAD" ])
    return
  }

  if (fs.existsSync(miao.dir)) {
    fs.rmSync(miao.dir, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(miao.dir), { recursive: true })

  // Clone default branch with depth=1, then fast-switch to desired ref (branch/tag) via fetch+reset.
  await runGit([ "clone", "--depth=1", miao.repo, miao.dir ])
  try {
    await runGit([ "-C", miao.dir, "fetch", "--depth=1", "origin", miao.ref ])
  } catch (e) {
    if (!miao.refIsDefault) throw e
    await runGit([ "-C", miao.dir, "fetch", "--depth=1", "origin", "main" ])
    miao.ref = "main"
  }
  await runGit([ "-C", miao.dir, "reset", "--hard", "FETCH_HEAD" ])
}

async function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`Source dir not found: ${srcDir}`)
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  await fsp.cp(srcDir, destDir, { recursive: true, force: true })
}

async function syncFromMiaoPlugin(game, cfg) {
  const miao = resolveMiaoPluginSource(cfg)
  if (miao.kind === "git") {
    await ensureMiaoPluginRepo(miao)
  }

  const sourceRoot = miao.dir
  const srcMetaDir = path.join(sourceRoot, "resources", `meta-${game}`)
  const destMetaDir = game === "gs" ? paths.metaGs : paths.metaSr

  await copyDir(srcMetaDir, destMetaDir)
  return miao
}

async function writeMetaMarker(game, marker) {
  const targetDir = game === "gs" ? paths.metaGs : paths.metaSr
  const p = path.join(targetDir, ".meta-source.json")
  const body = JSON.stringify(marker, null, 2)
  try {
    await fsp.writeFile(p, body, "utf8")
  } catch {}
}

async function syncOne(game, cfg) {
  const typeRaw = nonEmptyStr(cfg?.meta?.source?.type) || "cnb"
  const type = typeRaw.toLowerCase()

  if (type === "miao-plugin" || type === "miaoplugin" || type === "miao") {
    const miao = await syncFromMiaoPlugin(game, cfg)
    await writeMetaMarker(game, {
      type: "miao-plugin",
      updatedAt: new Date().toISOString(),
      miaoPlugin: {
        kind: miao?.kind || "dir",
        dir: miao?.dir || ""
      }
    })
    return
  }

  const cnb = await syncFromCnb(game, cfg)
  await writeMetaMarker(game, {
    type: "cnb",
    updatedAt: new Date().toISOString(),
    cnb: {
      repo: cnb?.repo || "",
      branch: cnb?.branch || ""
    }
  })
}

export async function cmdMetaSync(argv) {
  const { data: cfg } = loadAppConfig()
  const { game } = parseArgs(argv)
  const games = game === "all" ? [ "gs", "sr" ] : [ game ]
  for (const g of games) {
    if (!["gs","sr"].includes(g)) throw new Error(`Invalid --game: ${g}`)
    await syncOne(g, cfg)
  }
  console.log("meta synced:", games.join(","))
}

