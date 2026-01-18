import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const defaultScanDbPath = path.join(projectRoot, "data", "scan.reliability.sqlite")

function nowMs() {
  return Date.now()
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

async function emptyDir(dir) {
  if (!fs.existsSync(dir)) return
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  await Promise.all(entries.map(async (e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      await fsp.rm(p, { recursive: true, force: true })
      return
    }
    await fsp.unlink(p)
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

function runStart({ game, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ "src/start.js" ], {
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

async function runGame({ game, uidStart, count, delayMs }) {
  const uid = game === "zzz" ? "10000000" : "100000000"
  const samplesDir = path.join(projectRoot, "data", "samples", game)
  await ensureDir(samplesDir)
  await emptyDir(samplesDir)

  const concurrency = Math.max(1, Math.min(50, Number(process.env.CONCURRENCY || process.env.ENKA_CONCURRENCY || 2) || 2))

  console.log(`\n===== reliability test: game=${game} count=${count} uidStart=${uidStart} delayMs=${delayMs} concurrency=${concurrency} =====`)

  const startMs = nowMs()
  const scanDbPath = path.resolve(process.env.SCAN_DB_PATH || defaultScanDbPath)
  const code = await runStart({
    game,
    env: {
      SAMPLE_MODE: "enka",
      ENKA_UID_START: String(uidStart),
      ENKA_COUNT: String(count),
      ENKA_MAX_COUNT: String(count),
      ENKA_DELAY_MS: String(delayMs),
      ENKA_JITTER_MS: "0",
      ENKA_CURSOR_RESET: "1",
      ENKA_CONCURRENCY: String(concurrency),
      SCAN_DB_PATH: scanDbPath,
      PRESET_UID: uid,
      PRESET_ALWAYS: "1"
    }
  })
  const endMs = nowMs()

  const stats = scanStats({ game, startMs, endMs, dbPath: scanDbPath })
  const sampleCount = await countJsonlLines(samplesDir)
  const presetCount = await countPresetAvatars(game, uid)

  return {
    game,
    uidStart,
    count,
    delayMs,
    concurrency,
    exitCode: code,
    startMs,
    endMs,
    durationSec: Math.round((endMs - startMs) / 1000),
    scan: stats,
    samples: sampleCount,
    preset: presetCount
  }
}

async function main() {
  const uidStart = Number(process.env.UID_START || 100000001)
  const count = Number(process.env.COUNT || 20)
  const delayMs = Number(process.env.DELAY_MS || 1500)
  const scanDbPath = path.resolve(process.env.SCAN_DB_PATH || defaultScanDbPath)

  // Fresh DB for this run.
  for (const p of [ scanDbPath, `${scanDbPath}-wal`, `${scanDbPath}-shm` ]) {
    try { if (fs.existsSync(p)) await fsp.rm(p, { force: true }) } catch {}
  }

  const results = []
  results.push(await runGame({ game: "gs", uidStart, count, delayMs }))
  results.push(await runGame({ game: "sr", uidStart, count, delayMs }))

  const summaryPath = path.join(projectRoot, "out", `reliability-summary.${Date.now()}.json`)
  await ensureDir(path.dirname(summaryPath))
  await fsp.writeFile(summaryPath, JSON.stringify(results, null, 2), "utf8")

  console.log("\n===== summary =====")
  console.log(JSON.stringify(results, null, 2))
  console.log(`written: ${summaryPath}`)
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
