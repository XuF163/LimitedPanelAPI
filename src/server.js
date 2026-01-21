import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { paths, projectRoot } from "./config.js"
import { loadAppConfig } from "./user-config.js"
import { cmdMetaSync } from "./meta/sync.js"
import { openProxyDb } from "./db/proxy.js"
import { openScanDb } from "./db/sqlite.js"
import { loadSubscriptionNodes, nodeKey as subscriptionNodeKey, parseSubscriptionTextAsync } from "./proxy/subscription.js"
import { createLogger } from "./utils/log.js"

const log = createLogger("服务")

const require = createRequire(import.meta.url)
const yaml = require("js-yaml")
const execFileAsync = promisify(execFile)

async function execText(file, args = [], { timeoutMs = 5000 } = {}) {
  const { stdout } = await execFileAsync(file, args, {
    windowsHide: true,
    timeout: Math.max(100, Number(timeoutMs) || 5000),
    maxBuffer: 1024 * 1024
  })
  return String(stdout || "").trim()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function formatLocalDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

async function findListeningPids(port) {
  const p = Number(port)
  if (!Number.isFinite(p) || p <= 0) return []

  // Windows: PowerShell Get-NetTCPConnection.
  if (process.platform === "win32") {
    try {
      const script = `
$p = ${p};
$ids = @();
try {
  $ids = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess;
} catch {}
if ($ids) { $ids | Sort-Object -Unique }
`.trim()
      const out = await execText("powershell", [ "-NoProfile", "-Command", script ], { timeoutMs: 5000 })
      return out
        .split(/\r?\n/)
        .map((s) => Number(String(s || "").trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    } catch {
      return []
    }
  }

  // Other platforms: best-effort (no-op).
  return []
}

async function getProcessName(pid) {
  const id = Number(pid)
  if (!Number.isFinite(id) || id <= 0) return ""

  if (process.platform === "win32") {
    try {
      const script = `
$procId = ${id};
try { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } catch { "" }
`.trim()
      return await execText("powershell", [ "-NoProfile", "-Command", script ], { timeoutMs: 5000 })
    } catch {
      return ""
    }
  }

  return ""
}

async function killPid(pid) {
  const id = Number(pid)
  if (!Number.isFinite(id) || id <= 0) return false

  if (process.platform === "win32") {
    try {
      await execText("taskkill", [ "/PID", String(id), "/T", "/F" ], { timeoutMs: 5000 })
      return true
    } catch {
      // Fallback: try process.kill
      try {
        process.kill(id)
        return true
      } catch {
        return false
      }
    }
  }

  try {
    process.kill(id)
    return true
  } catch {
    return false
  }
}

async function tryFreePort(port) {
  const pids = await findListeningPids(port)
  if (!pids.length) return { ok: false, killed: 0, pids: [] }

  let killed = 0
  for (const pid of Array.from(new Set(pids))) {
    const name = String(await getProcessName(pid)).trim().toLowerCase()
    // Be conservative: only auto-kill Node processes on this port.
    if (name && name !== "node" && name !== "node.exe") continue

    const ok = await killPid(pid)
    if (ok) killed++
  }

  // Give the OS a moment to release the port.
  if (killed > 0) await sleep(400)
  return { ok: killed > 0, killed, pids }
}

async function listenOnce(server, port, host) {
  return await new Promise((resolve, reject) => {
    const onErr = (err) => {
      cleanup()
      reject(err)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      server.off("error", onErr)
      server.off("listening", onListening)
    }
    server.once("error", onErr)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  })
  res.end(body)
}

function sendFile(res, filePath) {
  const stat = fs.statSync(filePath)
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": stat.size
  })
  fs.createReadStream(filePath).pipe(res)
}

function sendText(res, code, text, { contentType = "text/plain; charset=utf-8" } = {}) {
  const body = String(text ?? "")
  res.writeHead(code, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body)
  })
  res.end(body)
}

function firstExistingFile(filePaths) {
  for (const p of filePaths) {
    if (!p) continue
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function isLoopback(remoteAddress) {
  const ip = String(remoteAddress || "").toLowerCase()
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("::ffff:127.")
  )
}

async function readBody(req, { maxBytes = 1024 * 1024 } = {}) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new Error(`Body too large (${size} bytes)`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function authUi(req, cfg) {
  const ui = cfg?.server?.ui || {}
  const enabled = Boolean(ui.enabled ?? true)
  const allowRemote = Boolean(ui.allowRemote ?? false)
  const token = String(process.env.UI_TOKEN || ui.token || "").trim()

  if (!enabled) return { ok: false, code: 404, error: "ui_disabled" }

  const remote = req.socket?.remoteAddress
  const loopback = isLoopback(remote)
  if (!allowRemote && !loopback) {
    return { ok: false, code: 403, error: "ui_loopback_only" }
  }

  if (token) {
    const got = String(req.headers["x-ui-token"] || "").trim() || String(new URL(req.url || "/", "http://x").searchParams.get("token") || "").trim()
    if (got !== token) {
      return { ok: false, code: 401, error: "ui_token_required" }
    }
  }

  return { ok: true }
}

function readYamlFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = yaml.load(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if ([ "1", "true", "yes", "y", "on" ].includes(s)) return true
    if ([ "0", "false", "no", "n", "off" ].includes(s)) return false
  }
  return fallback
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toStr(v, fallback = "") {
  if (v == null) return fallback
  return String(v)
}

function normalizeMetaSourceType(t) {
  const s = String(t || "").trim().toLowerCase()
  if ([ "miao-plugin", "miaoplugin", "miao" ].includes(s)) return "miao-plugin"
  return "cnb"
}

function normalizeSamplesMode(m, fallback = "playerdata") {
  const s = String(m || "").trim().toLowerCase()
  return [ "playerdata", "enka" ].includes(s) ? s : fallback
}

function normalizeEnkaFetcherMode(m, fallback = "rust") {
  const s = String(m || "").trim().toLowerCase()
  if ([ "rust", "rs", "auto", "js" ].includes(s)) return "rust"
  return fallback
}

function normalizeSubParserMode(m, fallback = "rust") {
  const s = String(m || "").trim().toLowerCase()
  if ([ "rust", "rs", "auto", "js" ].includes(s)) return "rust"
  return fallback
}

function normalizeSimpleConfigPayload(input, effectiveCfg = {}) {
  const serverPort = Math.max(1, Math.min(65535, toInt(input?.server?.port, toInt(effectiveCfg?.server?.port, 4567))))
  const serverHost = toStr(input?.server?.host, toStr(effectiveCfg?.server?.host, "0.0.0.0")).trim() || "0.0.0.0"
  const serverEnabled = toBool(input?.server?.enabled, toBool(effectiveCfg?.server?.enabled, true))

  const uiAllowRemote = toBool(input?.server?.ui?.allowRemote, toBool(effectiveCfg?.server?.ui?.allowRemote, false))
  const uiToken = toStr(input?.server?.ui?.token, toStr(effectiveCfg?.server?.ui?.token, "")).trim()

  const metaType = normalizeMetaSourceType(input?.meta?.source?.type ?? input?.meta?.sourceType ?? effectiveCfg?.meta?.source?.type ?? "cnb")
  const miaoDir = toStr(input?.meta?.source?.miaoPlugin?.dir, toStr(effectiveCfg?.meta?.source?.miaoPlugin?.dir, "")).trim()

  const samplesMode = normalizeSamplesMode(input?.samples?.mode, normalizeSamplesMode(effectiveCfg?.samples?.mode, "playerdata"))
  const playerdataDir = toStr(input?.samples?.playerdata?.dir, toStr(effectiveCfg?.samples?.playerdata?.dir, "")).trim()

  const toMaybeInt = (v) => {
    if (v == null) return null
    if (typeof v === "string" && v.trim() === "") return null
    return toInt(v, null)
  }
  const normalizeUids = (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    const out = []
    for (const v of arr) {
      const n = toInt(v, null)
      if (n == null || n <= 0) continue
      out.push(n)
    }
    return out
  }
  const hasSelector = (b) => Boolean(b?.uidStart != null || b?.uidEnd != null || (Array.isArray(b?.uids) && b.uids.length > 0))

  // Enka uid selectors are configured per-game: samples.enka.<game>.{uids,uidStart,uidEnd}
  // Backward-compatible: keep reading legacy samples.enka.{uids,uidStart,uidEnd} as fallback for gs/sr.
  const enkaIn = input?.samples?.enka || {}
  const legacyIn = {
    uids: normalizeUids(enkaIn?.uids),
    uidStart: toMaybeInt(enkaIn?.uidStart),
    uidEnd: toMaybeInt(enkaIn?.uidEnd)
  }
  const enkaGs = {
    uids: normalizeUids(enkaIn?.gs?.uids ?? legacyIn.uids),
    uidStart: toMaybeInt(enkaIn?.gs?.uidStart ?? legacyIn.uidStart),
    uidEnd: toMaybeInt(enkaIn?.gs?.uidEnd ?? legacyIn.uidEnd)
  }
  const enkaSr = {
    uids: normalizeUids(enkaIn?.sr?.uids ?? legacyIn.uids),
    uidStart: toMaybeInt(enkaIn?.sr?.uidStart ?? legacyIn.uidStart),
    uidEnd: toMaybeInt(enkaIn?.sr?.uidEnd ?? legacyIn.uidEnd)
  }
  const enkaZzz = {
    uids: normalizeUids(enkaIn?.zzz?.uids),
    uidStart: toMaybeInt(enkaIn?.zzz?.uidStart),
    uidEnd: toMaybeInt(enkaIn?.zzz?.uidEnd)
  }

  const ensureZzz8Digits = (n, label) => {
    if (n == null) return
    if (!(n >= 10_000_000 && n <= 99_999_999)) {
      throw new Error(`invalid zzz uid (${label}): must be 8-digit, got=${n}`)
    }
  }
  ensureZzz8Digits(enkaZzz.uidStart, "uidStart")
  ensureZzz8Digits(enkaZzz.uidEnd, "uidEnd")

  const enkaMaxCount = Math.max(1, toInt(enkaIn?.maxCount, toInt(effectiveCfg?.samples?.enka?.maxCount, 20)))
  const enkaFetcher = normalizeEnkaFetcherMode(enkaIn?.fetcher, normalizeEnkaFetcherMode(effectiveCfg?.samples?.enka?.fetcher, "auto"))
  const enkaConcurrency = Math.max(1, Math.min(50, toInt(enkaIn?.concurrency, toInt(effectiveCfg?.samples?.enka?.concurrency, 1))))

  const hasGsEnka = hasSelector(enkaGs)
  const hasSrEnka = hasSelector(enkaSr)
  const hasZzzEnka = hasSelector(enkaZzz)

  const presetUidDefault = "100000000"
  const presetUid = toStr(input?.preset?.uid, toStr(effectiveCfg?.preset?.uid, presetUidDefault)).trim() || presetUidDefault
  const presetName = toStr(input?.preset?.name, toStr(effectiveCfg?.preset?.name, "极限面板")).trim() || "极限面板"

  const zzzSourceType = toStr(input?.zzz?.source?.type, toStr(effectiveCfg?.zzz?.source?.type, "yunzai-plugin")).trim() || "yunzai-plugin"
  const zzzPluginDir = toStr(input?.zzz?.source?.pluginDir, toStr(effectiveCfg?.zzz?.source?.pluginDir, "")).trim()

  const proxyEnabled = toBool(input?.proxy?.enabled, toBool(effectiveCfg?.proxy?.enabled, false))
  const proxySubParser = normalizeSubParserMode(
    input?.proxy?.subscription?.parser,
    normalizeSubParserMode(effectiveCfg?.proxy?.subscription?.parser, "auto")
  )

  const minimal = {
    server: {
      host: serverHost,
      port: serverPort,
      enabled: serverEnabled
    },
    meta: {
      source: {
        type: metaType
      }
    },
    samples: {
      mode: samplesMode
    },
    preset: {
      uid: presetUid,
      name: presetName
    },
    zzz: {
      source: {
        type: zzzSourceType
      }
    },
    proxy: {
      enabled: proxyEnabled
    }
  }

  if (proxySubParser !== "auto" || input?.proxy?.subscription?.parser != null) {
    minimal.proxy.subscription = {
      parser: proxySubParser
    }
  }

  if (uiAllowRemote || uiToken) {
    minimal.server.ui = {
      allowRemote: uiAllowRemote,
      token: uiToken
    }
  }

  if (metaType === "miao-plugin") {
    minimal.meta.source.miaoPlugin = { dir: miaoDir }
  }

  if (samplesMode === "playerdata") {
    minimal.samples.playerdata = { dir: playerdataDir }
    // Allow saving Enka uid selectors even when GS/SR sampling is PlayerData (so user can pre-configure).
    // Note: ZZZ sampling always uses Enka; GS/SR will only use these when samples.mode=enka.
    if (hasGsEnka || hasSrEnka || hasZzzEnka) {
      minimal.samples.enka = {
        maxCount: enkaMaxCount,
        fetcher: enkaFetcher,
        concurrency: enkaConcurrency,
        ...(hasGsEnka ? { gs: enkaGs } : {}),
        ...(hasSrEnka ? { sr: enkaSr } : {}),
        ...(hasZzzEnka ? { zzz: enkaZzz } : {})
      }
    }
  } else {
    minimal.samples.enka = {
      maxCount: enkaMaxCount,
      fetcher: enkaFetcher,
      concurrency: enkaConcurrency,
      gs: enkaGs,
      sr: enkaSr,
      zzz: enkaZzz
    }
  }

  if (zzzSourceType === "yunzai-plugin" && zzzPluginDir) {
    minimal.zzz.source.pluginDir = zzzPluginDir
  }

  return minimal
}

function mergeDeep(target, source) {
  if (!source || typeof source !== "object") return target
  if (!target || typeof target !== "object") return source
  const out = Array.isArray(target) ? target.slice() : { ...target }
  for (const [ k, v ] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const uiIndexPath = path.join(__dirname, "webui", "index.html")
const uiIndexHtml = (() => {
  try {
    return fs.readFileSync(uiIndexPath, "utf8")
  } catch {
    return null
  }
})()

let metaSyncing = false

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const { data: cfg, userPath, defaultPath } = loadAppConfig({ ensureUser: true })

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true })
  }

  // Web UI (config editor)
  if (url.pathname === "/ui" || url.pathname === "/ui/") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })
    if (!uiIndexHtml) return sendJson(res, 500, { error: "ui_missing", file: uiIndexPath })
    return sendText(res, 200, uiIndexHtml, { contentType: "text/html; charset=utf-8" })
  }

  if (url.pathname === "/api/config") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method === "GET") {
      const kind = String(url.searchParams.get("kind") || "user").toLowerCase()
      const filePath = kind === "default" ? defaultPath : userPath
      const raw = (() => {
        try { return fs.readFileSync(filePath, "utf8") } catch { return "" }
      })()
      return sendJson(res, 200, { kind, file: filePath, yaml: raw })
    }

    if (req.method === "PUT" || req.method === "POST") {
      ;(async () => {
        const body = await readBody(req, { maxBytes: 2 * 1024 * 1024 })
        const contentType = String(req.headers["content-type"] || "")
        let txt = body
        if (/application\/json/i.test(contentType)) {
          const obj = JSON.parse(body || "{}")
          txt = String(obj?.yaml ?? obj?.text ?? "")
        }
        // Validate YAML (do not normalize user formatting: write back raw text if valid).
        let parsed
        try {
          parsed = yaml.load(txt)
        } catch (e) {
          return sendJson(res, 400, { error: "invalid_yaml", message: e?.message || String(e) })
        }
        if (!parsed || typeof parsed !== "object") {
          return sendJson(res, 400, { error: "invalid_yaml_root", message: "YAML root must be a mapping/object" })
        }

        const tmpPath = `${userPath}.tmp`
        await fsp.writeFile(tmpPath, txt, "utf8")
        await fsp.rename(tmpPath, userPath)

        return sendJson(res, 200, { ok: true, file: userPath })
      })().catch((e) => {
        return sendJson(res, 500, { error: "write_failed", message: e?.message || String(e) })
      })
      return
    }

    return sendJson(res, 405, { error: "method_not_allowed" })
  }

  // WebUI: parsed config JSON
  // GET /api/config-json?kind=user|default|merged
  if (url.pathname === "/api/config-json") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" })

    const kind = String(url.searchParams.get("kind") || "merged").toLowerCase()
    if (kind === "merged") {
      return sendJson(res, 200, { kind, file: userPath, json: cfg })
    }
    if (kind === "default") {
      return sendJson(res, 200, { kind, file: defaultPath, json: readYamlFileSafe(defaultPath) })
    }
    // user
    return sendJson(res, 200, { kind: "user", file: userPath, json: readYamlFileSafe(userPath) })
  }

  // WebUI: save minimal config (form-based)
  // PUT /api/config-simple?mode=replace|merge
  if (url.pathname === "/api/config-simple") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "PUT" && req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" })

    ;(async () => {
      const mode = String(url.searchParams.get("mode") || "replace").toLowerCase()
      const body = await readBody(req, { maxBytes: 256 * 1024 })
      const obj = JSON.parse(body || "{}")

      const minimal = normalizeSimpleConfigPayload(obj, cfg)

      let finalObj = minimal
      if (mode === "merge") {
        const cur = readYamlFileSafe(userPath)
        finalObj = mergeDeep(cur, minimal)
      }

      const outYaml = yaml.dump(finalObj, { noRefs: true, lineWidth: 120 })

      const tmpPath = `${userPath}.tmp`
      await fsp.writeFile(tmpPath, outYaml, "utf8")
      await fsp.rename(tmpPath, userPath)

      return sendJson(res, 200, { ok: true, file: userPath, mode })
    })().catch((e) => {
      return sendJson(res, 400, { error: "save_failed", message: e?.message || String(e) })
    })
    return
  }

  // WebUI: meta sync (gs/sr)
  // POST /api/meta/sync?game=gs|sr|all
  if (url.pathname === "/api/meta/sync") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" })
    if (metaSyncing) return sendJson(res, 409, { error: "meta_sync_in_progress" })

    const game = String(url.searchParams.get("game") || "all").toLowerCase()
    if (!["gs", "sr", "all"].includes(game)) return sendJson(res, 400, { error: "invalid_game" })

    metaSyncing = true
    ;(async () => {
      await cmdMetaSync([ "--game", game ])
      return sendJson(res, 200, { ok: true, game })
    })().catch((e) => {
      return sendJson(res, 500, { error: "meta_sync_failed", message: e?.message || String(e) })
    }).finally(() => {
      metaSyncing = false
    })
    return
  }

  // WebUI: meta info
  // GET /api/meta/info
  if (url.pathname === "/api/meta/info") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" })

    const readMarker = (root) => {
      try {
        const p = path.join(root, ".meta-source.json")
        if (!fs.existsSync(p)) return null
        return JSON.parse(fs.readFileSync(p, "utf8"))
      } catch {
        return null
      }
    }

    return sendJson(res, 200, {
      ok: true,
      syncing: metaSyncing,
      gs: { root: paths.metaGs, marker: readMarker(paths.metaGs) },
      sr: { root: paths.metaSr, marker: readMarker(paths.metaSr) }
    })
  }

  // WebUI: daily scan gate status (scan_daily_gate)
  // GET /api/samples/gate?game=gs|sr|zzz|all
  if (url.pathname === "/api/samples/gate") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" })

    const q = String(url.searchParams.get("game") || "all").toLowerCase()
    const games = q === "all" ? [ "gs", "sr", "zzz" ] : [ q ]
    if (!games.every((g) => [ "gs", "sr", "zzz" ].includes(g))) {
      return sendJson(res, 400, { error: "invalid_game" })
    }

    const day = formatLocalDay(new Date())

    const parseJsonSafe = (text) => {
      try { return JSON.parse(String(text)) } catch { return null }
    }

    const db = openScanDb()
    try {
      const gates = {}
      for (const g of games) {
        const row = db.getDailyGate?.(g, day)
        gates[g] = row
          ? {
              game: row.game,
              day: row.day,
              done: Boolean(row.done),
              doneAt: row.done_at ?? null,
              totalChars: row.total_chars ?? null,
              qualifiedChars: row.qualified_chars ?? null,
              detail: parseJsonSafe(row.detail_json)
            }
          : null
      }
      return sendJson(res, 200, { ok: true, day, gates })
    } finally {
      db.close()
    }
  }

  // WebUI: proxy nodes summary
  // GET /api/proxy/nodes/summary
  if (url.pathname === "/api/proxy/nodes/summary") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" })

    try {
      const dbPath = process.env.PROXY_DB_PATH || cfg?.proxy?.db?.path
      const db = openProxyDb({ ...(dbPath ? { dbPath } : {}) })
      try {
        return sendJson(res, 200, { ok: true, count: db.countNodes?.() ?? 0, dbPath: db.dbPath })
      } finally {
        try { db.close?.() } catch {}
      }
    } catch (e) {
      return sendJson(res, 500, { error: "proxy_db_open_failed", message: e?.message || String(e) })
    }
  }

  // WebUI: proxy import (subscription urls / raw text)
  // POST /api/proxy/import
  if (url.pathname === "/api/proxy/import") {
    const auth = authUi(req, cfg)
    if (!auth.ok) return sendJson(res, auth.code, { error: auth.error })

    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" })

    ;(async () => {
      const body = await readBody(req, { maxBytes: 5 * 1024 * 1024 })
      const contentType = String(req.headers["content-type"] || "")
      const payload = (() => {
        if (/application\/json/i.test(contentType)) {
          return JSON.parse(body || "{}")
        }
        return { rawText: body }
      })()

      const rawUrls = payload?.subscriptionUrls ?? payload?.urls ?? payload?.subscription ?? ""
      const rawText = String(payload?.rawText ?? payload?.text ?? payload?.nodesText ?? "").trim()
      const saveUrlsToConfig = toBool(payload?.saveUrlsToConfig ?? payload?.saveToConfig ?? true, true)

      const subUrls = (Array.isArray(rawUrls) ? rawUrls : String(rawUrls || "").split(/[,;\s]+/))
        .map((s) => String(s || "").trim())
        .filter(Boolean)

      if (subUrls.length === 0 && !rawText) {
        return sendJson(res, 400, { error: "missing_input", message: "Provide subscriptionUrls or rawText" })
      }

      // 1) Parse nodes (best-effort)
      const nodes = []
      let subscriptionError = null
      if (subUrls.length) {
        try {
          const timeoutMs = Number(cfg?.proxy?.subscription?.timeoutMs ?? 30_000)
          const cacheDir = cfg?.proxy?.subscription?.cacheDir || "./data/proxy/subscription-cache"
          const cacheTtlSec = Number(cfg?.proxy?.subscription?.cacheTtlSec ?? 0)
          const useCacheOnFail = cfg?.proxy?.subscription?.useCacheOnFail ?? true
          nodes.push(
            ...(await loadSubscriptionNodes(subUrls, {
              timeoutMs,
              cacheDir,
              cacheTtlSec,
              useCacheOnFail,
              insecureSkipVerify: Boolean(cfg?.proxy?.subscription?.insecureSkipVerify ?? false),
              parser: cfg?.proxy?.subscription?.parser
            }))
          )
        } catch (e) {
          subscriptionError = e?.message || String(e)
        }
      }
      if (rawText) {
        nodes.push(...(await parseSubscriptionTextAsync(rawText, { parser: cfg?.proxy?.subscription?.parser })))
      }

      // 2) Dedupe and insert into DB (do not show existing)
      const deduped = []
      const seen = new Set()
      for (const n of nodes) {
        const k = subscriptionNodeKey(n)
        if (!k || seen.has(k)) continue
        seen.add(k)
        deduped.push(n)
      }

      let inserted = 0
      let skippedExisting = 0
      const insertedPreview = []

      let dbPath = null
      let nodeTotal = null
      try {
        const cfgDbPath = process.env.PROXY_DB_PATH || cfg?.proxy?.db?.path
        const db = openProxyDb({ ...(cfgDbPath ? { dbPath: cfgDbPath } : {}) })
        dbPath = db.dbPath
        try {
          for (const n of deduped) {
            const k = subscriptionNodeKey(n)
            if (!k) continue
            const ret = db.insertNode?.({ key: k, node: n })
            if (ret?.inserted) {
              inserted++
              if (insertedPreview.length < 50) {
                insertedPreview.push({
                  type: String(n?.type || ""),
                  tag: String(n?.tag || ""),
                  host: String(n?.host || ""),
                  port: Number(n?.port || 0) || 0
                })
              }
            } else {
              skippedExisting++
            }
          }
          nodeTotal = db.countNodes?.() ?? null
        } finally {
          try { db.close?.() } catch {}
        }
      } catch (e) {
        return sendJson(res, 500, { error: "proxy_db_open_failed", message: e?.message || String(e) })
      }

      // 3) Optionally save subscription urls to user config (dedupe urls)
      let configUpdated = false
      let urlsAdded = 0
      let urlsTotal = null
      if (saveUrlsToConfig && subUrls.length) {
        const cur = readYamlFileSafe(userPath)
        if (!cur.proxy || typeof cur.proxy !== "object") cur.proxy = {}
        if (!cur.proxy.subscription || typeof cur.proxy.subscription !== "object") cur.proxy.subscription = {}
        const curUrls = Array.isArray(cur.proxy.subscription.urls) ? cur.proxy.subscription.urls.map(String).map((s) => s.trim()).filter(Boolean) : []
        const set = new Set(curUrls)
        for (const u of subUrls) {
          const s = String(u || "").trim()
          if (!s || set.has(s)) continue
          set.add(s)
          curUrls.push(s)
          urlsAdded++
        }
        cur.proxy.subscription.urls = curUrls
        urlsTotal = curUrls.length

        const outYaml = yaml.dump(cur, { noRefs: true, lineWidth: 120 })
        const tmpPath = `${userPath}.tmp`
        await fsp.writeFile(tmpPath, outYaml, "utf8")
        await fsp.rename(tmpPath, userPath)
        configUpdated = true
      }

      return sendJson(res, 200, {
        ok: true,
        parsed: deduped.length,
        inserted,
        skippedExisting,
        insertedPreview,
        subscriptionError,
        configUpdated,
        urlsAdded,
        urlsTotal,
        nodeTotal,
        dbPath
      })
    })().catch((e) => {
      return sendJson(res, 500, { error: "proxy_import_failed", message: e?.message || String(e) })
    })
    return
  }

  // GET /gs/hyperpanel  (default extreme panel)
  // GET /sr/hyperpanel
  // GET /zzz/hyperpanel
  const hp = /^\/(gs|sr|zzz)\/hyperpanel$/.exec(url.pathname)
  if (req.method === "GET" && hp) {
    const game = hp[1]
    const defaultPresetUid = String(process.env.PRESET_UID || cfg?.qa?.uid || cfg?.preset?.uid || "100000000")
    const defaultPresetUidZzz = String(process.env.PRESET_UID_ZZZ || cfg?.qa?.uidZzz || "10000000")
    const uidCandidates =
      game === "zzz"
        ? [
            defaultPresetUidZzz,
            String(cfg?.preset?.uid || ""),
            "10000000"
          ]
        : [
            defaultPresetUid,
            "100000000"
          ]

    const resolved = firstExistingFile(
      uidCandidates
        .map((uid) => String(uid || "").trim())
        .filter(Boolean)
        .map((uid) => path.join(paths.outDir(game), `${uid}.json`))
    )
    if (!resolved) {
      return sendJson(res, 404, {
        error: "not_found",
        game,
        hint: "Generate preset first (out/<game>/<uid>.json), then retry.",
        tried: uidCandidates.map((uid) => path.join(paths.outDir(game), `${uid}.json`))
      })
    }
    return sendFile(res, resolved)
  }

  // GET /presets/gs/100000000.json
  const m = /^\/presets\/(gs|sr|zzz)\/(\d+)\.json$/.exec(url.pathname)
  if (req.method === "GET" && m) {
    const game = m[1]
    const uid = m[2]
    const filePath = path.join(paths.outDir(game), `${uid}.json`)
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "not_found", file: filePath })
    return sendFile(res, filePath)
  }

  return sendJson(res, 404, { error: "not_found" })
})

let serverStarted = false
let serverStartPromise = null

export async function startServer({ port, host } = {}) {
  if (serverStarted) return server
  if (serverStartPromise) return await serverStartPromise

  serverStartPromise = (async () => {
    const { data: cfg0 } = loadAppConfig()
    const resolvedPort = Number(port ?? process.env.PORT ?? cfg0?.server?.port ?? 4567)
    const resolvedHost = String(host ?? process.env.HOST ?? cfg0?.server?.host ?? "0.0.0.0")

    try {
      await listenOnce(server, resolvedPort, resolvedHost)
    } catch (e) {
      if (e?.code === "EADDRINUSE") {
        log.warn(`端口占用：${resolvedHost}:${resolvedPort}，尝试清理旧进程...`)
        const freed = await tryFreePort(resolvedPort)
        if (!freed.ok) {
          throw new Error(
            `listen EADDRINUSE: ${resolvedHost}:${resolvedPort} (pid=${freed.pids?.join(",") || "?"}). ` +
              `请关闭旧进程或修改 server.port。`,
            { cause: e }
          )
        }
        await listenOnce(server, resolvedPort, resolvedHost)
      } else {
        throw e
      }
    }

    serverStarted = true

    // Record a simple lock file to aid debugging.
    const lockPath = path.join(paths.dataDir, "server.lock.json")
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      fs.writeFileSync(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            port: resolvedPort,
            host: resolvedHost,
            projectRoot,
            startedAt: Date.now()
          },
          null,
          2
        ),
        "utf8"
      )
      const cleanup = () => {
        try { fs.unlinkSync(lockPath) } catch {}
      }
      process.once("exit", cleanup)
      process.once("SIGINT", cleanup)
      process.once("SIGTERM", cleanup)
    } catch {}

    log.info(`已监听：http://127.0.0.1:${resolvedPort} (host=${resolvedHost})`)
    return server
  })()

  return await serverStartPromise
}
