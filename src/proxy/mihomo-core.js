import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCmd } from "../utils/exec.js"
import { ensureDir } from "../utils/fs.js"
import { createLogger } from "../utils/log.js"

const log = createLogger("代理")

function isWin() {
  return process.platform === "win32"
}

async function downloadToFile(url, filePath, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // GitHub API requires a UA for some environments.
        "user-agent": "LimitedPanelAPI"
      }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`Download HTTP ${res.status}: ${String(txt).slice(0, 200)}`)
    }
    await ensureDir(path.dirname(filePath))
    const buf = Buffer.from(await res.arrayBuffer())
    await fsp.writeFile(filePath, buf)
  } finally {
    clearTimeout(tid)
  }
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

async function resolveMihomoDownloadUrlAuto() {
  const api = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(api, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "LimitedPanelAPI",
        "accept": "application/vnd.github+json"
      }
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`GitHub API HTTP ${res.status}: ${String(txt).slice(0, 200)}`)
    }
    const data = await res.json()
    const assets = Array.isArray(data?.assets) ? data.assets : []
    const candidates = assets
      .map((a) => ({
        name: String(a?.name || ""),
        url: String(a?.browser_download_url || "")
      }))
      .filter((a) => a.url && /\.zip$/i.test(a.name || ""))

    // Common naming patterns:
    // - mihomo-windows-amd64-v3-vX.Y.Z.zip
    // - mihomo-windows-amd64-vX.Y.Z.zip
    const preferred = candidates.find((a) => /windows.*amd64/i.test(a.name) && /v3/i.test(a.name))
      || candidates.find((a) => /windows.*amd64/i.test(a.name))
      || candidates[0]
    if (!preferred?.url) throw new Error("No suitable mihomo windows-amd64 zip asset found in latest release")
    return preferred.url
  } finally {
    clearTimeout(tid)
  }
}

async function findExeRecursive(dir, { maxDepth = 4 } = {}) {
  const items = await fsp.readdir(dir, { withFileTypes: true })
  for (const it of items) {
    if (it.isFile()) {
      const name = it.name.toLowerCase()
      if (name === "mihomo.exe" || (name.startsWith("mihomo") && name.endsWith(".exe"))) {
        return path.join(dir, it.name)
      }
    }
  }
  if (maxDepth <= 0) return null
  for (const it of items) {
    if (!it.isDirectory()) continue
    const found = await findExeRecursive(path.join(dir, it.name), { maxDepth: maxDepth - 1 })
    if (found) return found
  }
  return null
}

export async function ensureMihomoCore({
  binDir,
  downloadUrl
} = {}) {
  const resolvedBinDir = path.resolve(binDir || path.join(process.cwd(), "bin", "mihomo"))
  const exeName = isWin() ? "mihomo.exe" : "mihomo"
  const exePath = path.join(resolvedBinDir, exeName)

  if (fs.existsSync(exePath)) {
    return { exePath, binDir: resolvedBinDir }
  }

  let url = String(downloadUrl || "").trim()
  if (!url || url === "auto") {
    url = await resolveMihomoDownloadUrlAuto()
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "limitedpanel-mihomo-"))
  const zipPath = path.join(tmpRoot, "mihomo.zip")
  const extractDir = path.join(tmpRoot, "extract")
  try {
    log.info(`下载 mihomo：${url}`)
    await downloadToFile(url, zipPath)
    await extractZip(zipPath, extractDir)

    const foundExe = await findExeRecursive(extractDir)
    if (!foundExe) throw new Error("mihomo executable not found after extract")

    await ensureDir(resolvedBinDir)
    await fsp.copyFile(foundExe, exePath)
    try {
      if (!isWin()) await fsp.chmod(exePath, 0o755)
    } catch {
      // best-effort
    }
    return { exePath, binDir: resolvedBinDir }
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
