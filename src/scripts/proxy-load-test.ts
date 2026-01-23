import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..", "..")

function nowMs() {
  return Date.now()
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

async function emptyDir(dir) {
  if (!fs.existsSync(dir)) return
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  await Promise.all(entries.map(async (e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return fsp.rm(p, { recursive: true, force: true })
    return fsp.unlink(p)
  }))
}

async function countJsonlLines(dir) {
  if (!fs.existsSync(dir)) return { files: 0, lines: 0 }
  const files = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => path.join(dir, d.name))

  let total = 0
  for (const file of files) {
    const stream = fs.createReadStream(file)
    for await (const chunk of stream) {
      const s = chunk.toString("utf8")
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) total++
      }
    }
  }
  return { files: files.length, lines: total }
}

function scanStats({ game, startMs, endMs, dbPath }) {
  if (!fs.existsSync(dbPath)) return null
  const db = new DatabaseSync(dbPath)
  try {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM enka_uid
      WHERE game = ?
        AND last_checked_at BETWEEN ? AND ?
    `).get(game, startMs, endMs)

    const groupRows = db.prepare(`
      SELECT status, permanent, COUNT(*) AS cnt
      FROM enka_uid
      WHERE game = ?
        AND last_checked_at BETWEEN ? AND ?
      GROUP BY status, permanent
      ORDER BY cnt DESC
    `).all(game, startMs, endMs)

    const rawRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM enka_raw
      WHERE game = ?
        AND fetched_at BETWEEN ? AND ?
    `).get(game, startMs, endMs)

    return {
      total: Number(totalRow?.total || 0),
      byStatus: groupRows || [],
      rawRows: Number(rawRow?.cnt || 0)
    }
  } finally {
    db.close()
  }
}

async function countPresetAvatars(game, uid) {
  const outPath = path.join(projectRoot, "out", game, `${uid}.json`)
  if (!fs.existsSync(outPath)) return { outPath, avatars: 0 }
  const raw = JSON.parse(await fsp.readFile(outPath, "utf8"))
  const avatars = raw?.avatars ? Object.keys(raw.avatars).length : 0
  return { outPath, avatars }
}

function runStart({ game, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/start.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
        GAME: game,
        NO_SERVER: "1"
      },
      stdio: "inherit"
    })
    child.on("error", reject)
    child.on("exit", (code) => resolve(code || 0))
  })
}

async function main() {
  const game = String(process.env.GAME || "gs").toLowerCase()
  if (!["gs", "sr", "zzz"].includes(game)) throw new Error(`Unsupported GAME=${game}`)

  const subUrl = String(process.env.SUB_URL || process.env.PROXY_SUB_URLS || "").trim()
  if (!subUrl) throw new Error("Missing SUB_URL / PROXY_SUB_URLS (subscription link)")

  const uidStart = toInt(process.env.UID_START, 100000001)
  const count = toInt(process.env.COUNT, 2000)
  const delayMs = toInt(process.env.DELAY_MS, 1200)
  const poolSize = Math.max(1, Math.min(50, toInt(process.env.PROXY_POOL_SIZE, 20)))
  const probeCount = Math.max(poolSize, Math.min(300, toInt(process.env.PROXY_PROBE_COUNT, 120)))
  const testTimeoutMs = Math.max(1000, toInt(process.env.PROXY_TEST_TIMEOUT_MS, 5000))
  const testUrl = String(process.env.PROXY_TEST_URL || `https://enka.network/api/${game === "sr" ? "hsr/" : ""}uid/100000001`)

  const dbPath = path.resolve(
    process.env.SCAN_DB_PATH ||
      process.env.PROXYTEST_DB_PATH ||
      path.join(projectRoot, "data", `scan.proxytest.${game}.sqlite`)
  )
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { if (fs.existsSync(p)) await fsp.rm(p, { force: true }) } catch {}
  }

  const samplesDir = path.join(projectRoot, "data", "samples", game)
  await ensureDir(samplesDir)
  await emptyDir(samplesDir)

  const targetUid = game === "zzz" ? "10000000" : "100000000"

  console.log(`\n===== proxy load test =====`)
  console.log(`game=${game} uidStart=${uidStart} count=${count} delayMs=${delayMs} (concurrency=adaptive)`)
  console.log(`proxyPoolSize=${poolSize} proxyProbeCount=${probeCount} proxyTestUrl=${testUrl} proxyTestTimeoutMs=${testTimeoutMs}`)
  console.log(`scanDb=${dbPath}`)

  const startMs = nowMs()
  // Ensure dist build exists (tests run the compiled output).
  if (!fs.existsSync(path.join(projectRoot, "dist", "start.js"))) {
    throw new Error("Missing dist/start.js. Run: npm run build")
  }
  const code = await runStart({
    game,
    env: {
      // proxy
      PROXY_ENABLED: "1",
      PROXY_REQUIRED: "1",
      PROXY_SUB_URLS: subUrl,
      PROXY_POOL_SIZE: String(poolSize),
      PROXY_PROBE_COUNT: String(probeCount),
      PROXY_TEST_URL: testUrl,
      PROXY_TEST_TIMEOUT_MS: String(testTimeoutMs),

      // scan
      SAMPLE_MODE: "enka",
      ENKA_UID_START: String(uidStart),
      ENKA_UID_END: String(uidStart + count - 1),
      ENKA_MAX_COUNT: String(count),
      ENKA_DELAY_MS: String(delayMs),
      ENKA_JITTER_MS: "0",
      ENKA_CURSOR_RESET: "1",

      SCAN_DB_PATH: dbPath,

      // output
      PRESET_UID: targetUid,
      PRESET_ALWAYS: "1"
    }
  })
  const endMs = nowMs()

  const stats = scanStats({ game, startMs, endMs, dbPath })
  const sampleCount = await countJsonlLines(samplesDir)
  const presetCount = await countPresetAvatars(game, targetUid)

  const result = {
    game,
    uidStart,
    count,
    delayMs,
    proxy: { poolSize, probeCount, testUrl, testTimeoutMs },
    exitCode: code,
    startMs,
    endMs,
    durationSec: Math.round((endMs - startMs) / 1000),
    scan: stats,
    samples: sampleCount,
    preset: presetCount,
    scanDbPath: dbPath
  }

  const outPath = path.join(projectRoot, "out", `proxy-load-test.${game}.${Date.now()}.json`)
  await ensureDir(path.dirname(outPath))
  await fsp.writeFile(outPath, JSON.stringify(result, null, 2), "utf8")

  console.log("\n===== result =====")
  console.log(JSON.stringify(result, null, 2))
  console.log(`written: ${outPath}`)
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
