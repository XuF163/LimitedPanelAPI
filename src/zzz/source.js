import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProxyAgent } from "undici"
import { projectRoot } from "../config.js"
import { runCmd } from "../utils/exec.js"
import { ensureDir } from "../utils/fs.js"

function toBool(v, fallback = false) {
  if (v == null || v === "") return fallback
  const s = String(v).toLowerCase()
  if (["1", "true", "yes", "y", "on"].includes(s)) return true
  if (["0", "false", "no", "n", "off"].includes(s)) return false
  return fallback
}

function resolveFromProject(p) {
  const raw = String(p || "").trim()
  if (!raw) return ""
  if (path.isAbsolute(raw)) return raw
  return path.resolve(projectRoot, raw)
}

function getYunzaiRoot() {
  // LimitedPanelAPI is located at: <YunzaiRoot>/temp/LimitedPanelAPI
  return path.resolve(projectRoot, "..", "..")
}

function normalizeSourceType(v) {
  const s = String(v || "").trim().toLowerCase()
  if (!s) return "yunzai-plugin"
  if (["yunzai", "yunzai-plugin", "local", "plugin"].includes(s)) return "yunzai-plugin"
  if (["github", "git", "repo"].includes(s)) return "github"
  return s
}

export function resolveZzzPluginRoot(cfg = {}) {
  const sourceType = normalizeSourceType(process.env.ZZZ_SOURCE_TYPE || cfg?.zzz?.source?.type || "yunzai-plugin")
  if (sourceType === "github") {
    const dir =
      process.env.ZZZ_GITHUB_DIR ||
      cfg?.zzz?.source?.github?.dir ||
      "./resources/zzz-plugin"
    return { sourceType, pluginRoot: resolveFromProject(dir) }
  }

  const pluginDir =
    process.env.ZZZ_PLUGIN_DIR ||
    cfg?.zzz?.source?.pluginDir ||
    path.join(getYunzaiRoot(), "plugins", "ZZZ-Plugin")
  return { sourceType: "yunzai-plugin", pluginRoot: path.resolve(pluginDir) }
}

export function resolveZzzLocalPluginRoot(cfg = {}) {
  const pluginDir =
    process.env.ZZZ_PLUGIN_DIR ||
    cfg?.zzz?.source?.pluginDir ||
    path.join(getYunzaiRoot(), "plugins", "ZZZ-Plugin")
  return path.resolve(pluginDir)
}

export function resolveZzzMapDir(cfg = {}) {
  const { pluginRoot } = resolveZzzPluginRoot(cfg)
  return path.join(pluginRoot, "resources", "map")
}

export function resolveZzzFormatterPath(cfg = {}) {
  const { pluginRoot } = resolveZzzPluginRoot(cfg)
  return path.join(pluginRoot, "model", "Enka", "formater.js")
}

function requiredZzzFiles(pluginRoot) {
  return [
    path.join(pluginRoot, "resources", "map", "EquipScore.json"),
    path.join(pluginRoot, "resources", "map", "Property2Name.json"),
    path.join(pluginRoot, "resources", "map", "EquipBaseValue.json"),
    path.join(pluginRoot, "resources", "map", "WeaponId2Data.json"),
    path.join(pluginRoot, "resources", "map", "PartnerId2Data.json"),
    path.join(pluginRoot, "model", "Enka", "formater.js")
  ]
}

function hasZzzPluginFiles(pluginRoot) {
  const files = requiredZzzFiles(pluginRoot)
  return files.every((p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
}

function gitNoProxyArgs() {
  return [
    "-c", "http.proxy=",
    "-c", "https.proxy=",
    "-c", "core.gitproxy="
  ]
}

function gitNoProxyEnv() {
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

function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function isWin() {
  return process.platform === "win32"
}

async function downloadToFile(url, filePath, { timeoutMs = 120_000, retries = 2 } = {}) {
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { redirect: "follow", signal: controller.signal })
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        throw new Error(`Download HTTP ${res.status}: ${String(txt).slice(0, 200)}`)
      }
      await ensureDir(path.dirname(filePath))
      const buf = Buffer.from(await res.arrayBuffer())
      await fsp.writeFile(filePath, buf)
      return
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    } finally {
      clearTimeout(tid)
    }
  }
  throw lastErr || new Error(`Download failed: ${url}`)
}

async function extractZip(zipPath, destDir) {
  await ensureDir(destDir)
  if (isWin()) {
    await runCmd("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`
    ])
    return
  }
  await runCmd("unzip", ["-o", zipPath, "-d", destDir])
}

function stripGitSuffix(repoUrl) {
  return String(repoUrl || "").trim().replace(/\.git$/i, "").replace(/\/$/, "")
}

function buildGithubZipUrl(repoUrl, ref) {
  const repo = stripGitSuffix(repoUrl)
  const r = String(ref || "").trim()
  const zipRef = r.startsWith("refs/") ? r : `refs/heads/${r || "main"}`
  return `${repo}/archive/${zipRef}.zip`
}

async function syncGithubZip({ repo, ref, dir }) {
  const targetDir = path.resolve(dir)
  const zipUrl = buildGithubZipUrl(repo, ref)
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "limitedpanel-zzz-"))
  const zipPath = path.join(tmpRoot, "repo.zip")
  const extractDir = path.join(tmpRoot, "extract")

  try {
    const proxyCandidates = [
      ...String(process.env.PROXY_URLS || "")
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim()
    ].filter(Boolean)

    let lastErr = null
    const tryList = [ null, ...proxyCandidates ]
    for (const proxyUrl of tryList) {
      try {
        if (proxyUrl) {
          console.log(`[zzz] downloading (via proxy): ${zipUrl} -> ${proxyUrl}`)
          const controller = new AbortController()
          const tid = setTimeout(() => controller.abort(), 120_000)
          try {
            const agent = new ProxyAgent(proxyUrl)
            const res = await fetch(zipUrl, { redirect: "follow", signal: controller.signal, dispatcher: agent })
            if (!res.ok) {
              const txt = await res.text().catch(() => "")
              throw new Error(`Download HTTP ${res.status}: ${String(txt).slice(0, 200)}`)
            }
            await ensureDir(path.dirname(zipPath))
            const buf = Buffer.from(await res.arrayBuffer())
            await fsp.writeFile(zipPath, buf)
          } finally {
            clearTimeout(tid)
          }
        } else {
          console.log(`[zzz] downloading: ${zipUrl}`)
          await downloadToFile(zipUrl, zipPath)
        }
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        continue
      }
    }
    if (lastErr) throw lastErr

    await extractZip(zipPath, extractDir)

    const entries = await fsp.readdir(extractDir, { withFileTypes: true })
    const root = entries.find((d) => d.isDirectory())
    if (!root) throw new Error("zip extracted but no directory found")
    const extractedRoot = path.join(extractDir, root.name)

    // Overwrite only within projectRoot to avoid accidental deletion of user paths.
    if (!isSubPath(projectRoot, targetDir)) {
      throw new Error(`refuse to overwrite non-project dir: ${targetDir}`)
    }

    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    await ensureDir(path.dirname(targetDir))
    await fsp.cp(extractedRoot, targetDir, { recursive: true, force: true })
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

async function syncGitRepo({ repo, ref, dir }) {
  const targetDir = path.resolve(dir)
  const gitDir = path.join(targetDir, ".git")

  if (fs.existsSync(gitDir)) {
    await runGit(["-C", targetDir, "fetch", "--depth=1", "origin", ref])
    await runGit(["-C", targetDir, "reset", "--hard", `origin/${ref}`])
    return
  }

  if (fs.existsSync(targetDir)) {
    if (!isSubPath(projectRoot, targetDir)) {
      throw new Error(`refuse to overwrite non-project dir: ${targetDir}`)
    }
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {})
  }

  await ensureDir(path.dirname(targetDir))
  await runGit(["clone", "-b", ref, repo, targetDir, "--depth=1"])
}

export async function ensureZzzSource(cfg = {}, { force = false } = {}) {
  const { sourceType, pluginRoot } = resolveZzzPluginRoot(cfg)
  if (sourceType !== "github") {
    if (hasZzzPluginFiles(pluginRoot)) return { sourceType, pluginRoot }
    const hint =
      `ZZZ-Plugin files not found under: ${pluginRoot}\n` +
      `- Install/update local plugin: <YunzaiRoot>/plugins/ZZZ-Plugin\n` +
      `- Or set config: zzz.source.type=github (auto pull from GitHub)`
    throw new Error(hint)
  }

  const repo =
    process.env.ZZZ_GITHUB_REPO ||
    cfg?.zzz?.source?.github?.repo ||
    "https://github.com/ZZZure/ZZZ-Plugin.git"

  const ref =
    process.env.ZZZ_GITHUB_REF ||
    cfg?.zzz?.source?.github?.ref ||
    "main"

  const autoSync = toBool(
    process.env.ZZZ_GITHUB_AUTO_SYNC,
    cfg?.zzz?.source?.github?.autoSync ?? true
  )

  const ready = hasZzzPluginFiles(pluginRoot)
  if (!force && ready && !autoSync) return { sourceType, pluginRoot }

  // If already a git repo and autoSync is enabled, update in-place; otherwise keep existing files.
  const hasGit = fs.existsSync(path.join(pluginRoot, ".git"))
  if (!force && ready && hasGit && autoSync) {
    try {
      console.log(`[zzz] git update: ${repo}#${ref} -> ${pluginRoot}`)
      await syncGitRepo({ repo, ref, dir: pluginRoot })
      return { sourceType, pluginRoot }
    } catch (e) {
      console.warn(`[zzz] git update failed; fallback to zip: ${e?.message || String(e)}`)
    }
  }

  // Prefer zip download for initial bootstrap (more reliable than git under unstable networks).
  console.log(`[zzz] sync source (zip): ${repo}#${ref} -> ${pluginRoot}`)
  try {
    await syncGithubZip({ repo, ref, dir: pluginRoot })
  } catch (e) {
    // Fallback to local plugin if available (common in Yunzai environments).
    const localRoot = resolveZzzLocalPluginRoot(cfg)
    if (hasZzzPluginFiles(localRoot)) {
      console.warn(`[zzz] github sync failed; fallback to local plugin: ${localRoot} (${e?.message || String(e)})`)
      return { sourceType: "yunzai-plugin", pluginRoot: localRoot }
    }
    throw e
  }

  if (!hasZzzPluginFiles(pluginRoot)) {
    const missing = requiredZzzFiles(pluginRoot).filter((p) => !fs.existsSync(p))
    throw new Error(`[zzz] synced but required files still missing: ${missing.join(", ")}`)
  }

  return { sourceType, pluginRoot }
}
