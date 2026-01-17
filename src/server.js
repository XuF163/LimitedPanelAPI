import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import { paths } from "./config.js"

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true })
  }

  // GET /presets/gs/100000000.json
  const m = /^\/presets\/(gs|sr)\/(\d+)\.json$/.exec(url.pathname)
  if (req.method === "GET" && m) {
    const game = m[1]
    const uid = m[2]
    const filePath = path.join(paths.outDir(game), `${uid}.json`)
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "not_found", file: filePath })
    return sendFile(res, filePath)
  }

  return sendJson(res, 404, { error: "not_found" })
})

const port = Number(process.env.PORT || 4567)
server.listen(port, "0.0.0.0", () => {
  console.log(`listening: http://127.0.0.1:${port}`)
})

