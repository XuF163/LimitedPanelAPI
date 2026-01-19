import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import { paths } from "./config.js"
import { loadAppConfig } from "./user-config.js"

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

function firstExistingFile(filePaths) {
  for (const p of filePaths) {
    if (!p) continue
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

const { data: cfg } = loadAppConfig()
const port = Number(process.env.PORT || cfg?.server?.port || 4567)
const host = String(process.env.HOST || cfg?.server?.host || "0.0.0.0")

const defaultPresetUid = String(process.env.PRESET_UID || cfg?.qa?.uid || cfg?.preset?.uid || "100000000")
const defaultPresetUidZzz = String(process.env.PRESET_UID_ZZZ || cfg?.qa?.uidZzz || "10000000")

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true })
  }

  // GET /gs/hyperpanel  (default extreme panel)
  // GET /sr/hyperpanel
  // GET /zzz/hyperpanel
  const hp = /^\/(gs|sr|zzz)\/hyperpanel$/.exec(url.pathname)
  if (req.method === "GET" && hp) {
    const game = hp[1]
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

server.listen(port, host, () => {
  console.log(`listening: http://127.0.0.1:${port} (host=${host})`)
})

