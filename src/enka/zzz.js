import path from "node:path"
import { pathToFileURL } from "node:url"
import { enka } from "../config.js"
import { loadAppConfig } from "../user-config.js"
import { ensureZzzSource } from "../zzz/source.js"
import { resolveEnkaUserAgent } from "./headers.js"

export class EnkaHttpError extends Error {
  constructor(uid, status, body) {
    super(`Enka HTTP ${status} uid=${uid}`)
    this.name = "EnkaHttpError"
    this.uid = uid
    this.status = status
    this.body = body
  }
}

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
    throw new Error(`[zzz] missing source for formatter.js: ${e?.message || String(e)}`)
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

async function fetchOne(url, { userAgent, timeoutMs, dispatcher } = {}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    })
    const text = await res.text()
    return { res, text }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchEnkaZzz(uid, options = {}) {
  const userAgent = options.userAgent || (await resolveEnkaUserAgent("zzz")) || enka.userAgent
  const timeoutMs = options.timeoutMs ?? enka.timeoutMs
  const dispatcher = options.dispatcher

  const bases = [
    "https://enka.network/api/zzz/uid/",
    "https://profile.microgg.cn/api/zzz/uid/"
  ]

  let lastErr = null
  for (const base of bases) {
    const url = new URL(String(uid), base).toString()
    try {
      const { res, text } = await fetchOne(url, { userAgent, timeoutMs, dispatcher })
      if (!res.ok) throw new EnkaHttpError(uid, res.status, text)
      if (text.trim().startsWith("<")) throw new Error(`Enka returned HTML for uid=${uid}`)
      const data = JSON.parse(text)
      return { data, text }
    } catch (e) {
      lastErr = e
      continue
    }
  }
  throw lastErr || new Error(`Enka fetch failed uid=${uid}`)
}
