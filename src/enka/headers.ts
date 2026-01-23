import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

import { projectRoot } from "../config.js"
import { loadAppConfig } from "../user-config.js"

const require = createRequire(import.meta.url)
const yaml = require("js-yaml")

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

function nonEmptyStr(v) {
  const s = String(v ?? "").trim()
  return s ? s : ""
}

function guessYunzaiRoot() {
  // Typical layout: <YunzaiRoot>/temp/LimitedPanelAPI
  return path.resolve(projectRoot, "..", "..")
}

let _pluginUasPromise = null

async function loadPluginUserAgents() {
  if (_pluginUasPromise) return await _pluginUasPromise
  _pluginUasPromise = (async () => {
    const yunzaiRoot = guessYunzaiRoot()
    const out = { miao: "", zzz: "" }

    // miao-plugin: system profile exports enkaApi.userAgent
    try {
      const p = path.join(yunzaiRoot, "plugins", "miao-plugin", "config", "system", "profile_system.js")
      if (fs.existsSync(p)) {
        const mod = await import(pathToFileURL(p).href)
        out.miao = nonEmptyStr(mod?.enkaApi?.userAgent) || nonEmptyStr(mod?.mggApi?.userAgent) || ""
      }
    } catch {
      // ignore
    }

    // ZZZ-Plugin: prefer user config, fallback to defSet
    try {
      const candidates = [
        path.join(yunzaiRoot, "plugins", "ZZZ-Plugin", "config", "config.yaml"),
        path.join(yunzaiRoot, "plugins", "ZZZ-Plugin", "defSet", "config.yaml")
      ]
      for (const p of candidates) {
        if (!fs.existsSync(p)) continue
        const txt = fs.readFileSync(p, "utf8")
        const obj = yaml.load(txt) || {}
        const ua = nonEmptyStr(obj?.enka?.userAgent)
        if (ua) {
          out.zzz = ua
          break
        }
      }
    } catch {
      // ignore
    }

    return out
  })()

  return await _pluginUasPromise
}

export async function resolveEnkaUserAgent(game) {
  const g = String(game || "").trim().toLowerCase()

  const envKey = `ENKA_UA_${String(g).toUpperCase()}`
  const envUa = nonEmptyStr(process.env[envKey]) || nonEmptyStr(process.env.ENKA_UA)
  if (envUa) return envUa

  // Optional project-level override (WebUI can edit config.yaml)
  const { data: cfg } = loadAppConfig({ ensureUser: false })
  const cfgUa = nonEmptyStr(cfg?.enka?.userAgent)
  if (cfgUa) return cfgUa

  const { miao, zzz } = await loadPluginUserAgents()
  if (g === "zzz") return zzz || miao || BROWSER_UA
  return miao || BROWSER_UA
}

