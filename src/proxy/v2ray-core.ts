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
    const res = await fetch(url, { redirect: "follow", signal: controller.signal })
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
    // Expand-Archive -Force overwrites.
    await runCmd("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`
    ])
    return
  }
  // Fallback: try unzip.
  await runCmd("unzip", ["-o", zipPath, "-d", destDir])
}

export async function ensureV2rayCore({
  binDir,
  downloadUrl
}: any = {}) {
  const resolvedBinDir = path.resolve(binDir || path.join(process.cwd(), "bin", "v2ray"))
  const exeName = isWin() ? "v2ray.exe" : "v2ray"
  const exePath = path.join(resolvedBinDir, exeName)
  const geoip = path.join(resolvedBinDir, "geoip.dat")
  const geosite = path.join(resolvedBinDir, "geosite.dat")

  if (fs.existsSync(exePath) && fs.existsSync(geoip) && fs.existsSync(geosite)) {
    return { exePath, binDir: resolvedBinDir }
  }

  if (!downloadUrl) {
    throw new Error("proxy.v2ray.downloadUrl 必填，用于下载 v2ray-core")
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "limitedpanel-v2ray-"))
  const zipPath = path.join(tmpRoot, "v2ray.zip")
  const extractDir = path.join(tmpRoot, "extract")

  try {
    log.info(`下载 v2ray-core：${downloadUrl}`)
    await downloadToFile(downloadUrl, zipPath)
    await extractZip(zipPath, extractDir)

    // Zip layout typically: v2ray.exe, v2ctl.exe, geoip.dat, geosite.dat in root.
    const candidates = [
      path.join(extractDir, exeName),
      path.join(extractDir, "v2ray-windows-64", exeName),
      path.join(extractDir, "v2ray", exeName)
    ]
    const foundExe = candidates.find((p) => fs.existsSync(p))
    if (!foundExe) throw new Error("解压后未找到 v2ray 可执行文件")

    const foundGeoip = [
      path.join(extractDir, "geoip.dat"),
      path.join(extractDir, "v2ray-windows-64", "geoip.dat"),
      path.join(extractDir, "v2ray", "geoip.dat")
    ].find((p) => fs.existsSync(p))

    const foundGeosite = [
      path.join(extractDir, "geosite.dat"),
      path.join(extractDir, "v2ray-windows-64", "geosite.dat"),
      path.join(extractDir, "v2ray", "geosite.dat")
    ].find((p) => fs.existsSync(p))

    if (!foundGeoip || !foundGeosite) {
      throw new Error("压缩包内缺少 geoip.dat / geosite.dat")
    }

    await ensureDir(resolvedBinDir)
    await fsp.copyFile(foundExe, exePath)
    await fsp.copyFile(foundGeoip, geoip)
    await fsp.copyFile(foundGeosite, geosite)

    return { exePath, binDir: resolvedBinDir }
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
