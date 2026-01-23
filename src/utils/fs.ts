import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function readJson(filePath) {
  const txt = await fsp.readFile(filePath, "utf8")
  return JSON.parse(txt)
}

export async function writeJson(filePath, data, space = 2) {
  await ensureDir(path.dirname(filePath))
  await fsp.writeFile(filePath, JSON.stringify(data, null, space), "utf8")
}

export async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath))
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8")
}

export function exists(filePath) {
  return fs.existsSync(filePath)
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

