import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadAppConfig } from "../user-config.js"
import { ensureZzzSource } from "../zzz/source.js"

function ensureGlobalLogger() {
  if (globalThis.logger) return
  const passthrough = (v) => String(v)
  globalThis.logger = {
    warn: console.warn.bind(console),
    debug: () => {},
    mark: console.log.bind(console),
    blue: passthrough,
    green: passthrough,
    red: passthrough
  }
}

async function loadZzzEnkaFormatter() {
  ensureGlobalLogger()
  const { data: cfg } = loadAppConfig()
  const resolved = await ensureZzzSource(cfg).catch((e) => {
    throw new Error(`ZZZ 源缺失，无法加载 formatter.js：${e?.message || String(e)}`)
  })
  const filePath = path.join(resolved.pluginRoot, "model", "Enka", "formater.js")
  return await import(pathToFileURL(filePath).href)
}

export function extractEnkaZzzAvatarList(data) {
  return data?.PlayerInfo?.ShowcaseDetail?.AvatarList || []
}

export async function enkaZzzToMysAvatars(avatarList) {
  const mod = await loadZzzEnkaFormatter()
  const Enka2Mys = mod?.Enka2Mys
  if (typeof Enka2Mys !== "function") return []
  const ret = Enka2Mys(avatarList, true)
  return Array.isArray(ret) ? ret : (ret ? [ ret ] : [])
}
