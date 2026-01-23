import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { loadAppConfig } from "../user-config.js"
import { cmdMetaSync } from "../meta/sync.js"
import { cmdSampleCollect } from "../samples/collect.js"
import { cmdPresetGenerate } from "../preset/generate.js"
import { ensureProxyPool } from "../proxy/pool.js"
import { projectRoot } from "../config.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { calcGsBuildMark } from "../score/gs.js"
import { calcSrBuildMark } from "../score/sr.js"
import { calcZzzAvatarMark } from "../score/zzz.js"
import { findZzzSignatureWeaponId } from "../zzz/weapon.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function nowMs() {
  return Date.now()
}

function toList(v, fallback = []) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (v == null || v === "") return fallback
  return String(v)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function toBool(v, fallback = false) {
  if (v == null || v === "") return fallback
  if (typeof v === "boolean") return v
  const s = String(v).trim().toLowerCase()
  if ([ "1", "true", "yes", "y", "on" ].includes(s)) return true
  if ([ "0", "false", "no", "n", "off" ].includes(s)) return false
  return fallback
}

async function resetSqliteFile(filePath) {
  for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try { if (fs.existsSync(p)) await fsp.rm(p, { force: true }) } catch {}
  }
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

async function listJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => d.name)
}

async function readJson(filePath) {
  const txt = await fsp.readFile(filePath, "utf8")
  return JSON.parse(txt)
}

function computeDiffStats(values = []) {
  const arr = values.map((v) => Math.abs(Number(v) || 0)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = arr.length
  const sum = arr.reduce((a, b) => a + b, 0)
  const mean = n ? sum / n : 0
  const pct = (p) => (n ? arr[Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)))] : 0)
  return {
    n,
    meanAbs: Number(mean.toFixed(3)),
    p50Abs: Number(pct(50).toFixed(3)),
    p90Abs: Number(pct(90).toFixed(3)),
    p95Abs: Number(pct(95).toFixed(3)),
    maxAbs: Number((n ? arr[n - 1] : 0).toFixed(3))
  }
}

function hasZzzExtremePattern(equipList) {
  const equips = Array.isArray(equipList) ? equipList : []
  if (equips.length < 6) return false
  for (const equip of equips) {
    const props = Array.isArray(equip?.properties) ? equip.properties : []
    if (props.length < 4) return false
    const lvls = props.slice(0, 4).map((p) => Number(p?.level)).filter((n) => Number.isFinite(n))
    if (lvls.length < 4) return false
    lvls.sort((a, b) => b - a)
    if (lvls[0] !== 6) return false
    if (lvls[1] !== 1 || lvls[2] !== 1 || lvls[3] !== 1) return false
  }
  return true
}

async function verifyZzzPreset({ uid, minMark, requireSignature, requirePattern }) {
  const outPath = path.join(projectRoot, "out", "zzz", `${uid}.json`)
  if (!fs.existsSync(outPath)) throw new Error(`Missing our panel: ${outPath}`)

  const our = await readJson(outPath)
  const avatars = our?.avatars || {}
  const ids = Object.keys(avatars)

  const rows = []
  let passCount = 0
  for (const id of ids) {
    const a = avatars[id]
    if (!a) continue

    const mark = calcZzzAvatarMark(a)?.mark ?? null
    const markOk = typeof mark === "number" && Number.isFinite(mark) && mark >= minMark

    const patternOk = requirePattern ? hasZzzExtremePattern(a?.equip) : true

    const sigId = requireSignature ? findZzzSignatureWeaponId(a) : null
    // If we can't determine a signature weapon from current map data, do not fail the check.
    const sigOk = requireSignature ? (sigId ? (Number(a?.weapon?.id) === Number(sigId)) : true) : true

    const ok = Boolean(markOk && patternOk && sigOk)
    if (ok) passCount++

    rows.push({
      id,
      name: a?.name,
      mark,
      markOk,
      patternOk,
      sigOk,
      sigId: sigId ?? null,
      weaponId: a?.weapon?.id ?? null,
      weaponName: a?.weapon?.name ?? null
    })
  }

  const passRate = rows.length ? passCount / rows.length : 0
  const worst = rows
    .filter((r) => !r.markOk || !r.patternOk || !r.sigOk)
    .sort((x, y) => (Number(y.mark) || 0) - (Number(x.mark) || 0))
    .slice(0, 10)

  return {
    game: "zzz",
    uid,
    outPath,
    total: rows.length,
    passCount,
    passRate: Number(passRate.toFixed(4)),
    minMark,
    requireSignature,
    requirePattern,
    worst,
    rows
  }
}

let _miaoAvatarPromise
async function getMiaoAvatar() {
  if (_miaoAvatarPromise) return await _miaoAvatarPromise
  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  const p = path.join(yunzaiRoot, "plugins", "miao-plugin", "models", "Avatar.js")
  _miaoAvatarPromise = import(pathToFileURL(p).href).then((m) => m?.default)
  return await _miaoAvatarPromise
}

async function calcMiaoArtisMark(game, avatarDs) {
  if (!avatarDs?.artis) return null
  const Avatar = await getMiaoAvatar()
  if (typeof Avatar !== "function") return null
  try {
    const av = new Avatar(avatarDs, game)
    const ret = av.getArtisMark(false)
    const mark = typeof ret?._mark === "number" ? ret._mark : Number(ret?.mark)
    return Number.isFinite(mark) ? mark : null
  } catch {
    return null
  }
}

async function compareWithLiangshi({ game, uid, tolerance }) {
  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  const require = (await import("node:module")).createRequire(import.meta.url)
  const yaml = require("js-yaml")

  const cfgPath = path.join(yunzaiRoot, "plugins", "liangshi-calc", "config", "config.yaml")
  let panelModel = 1
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8")
      const cfg = yaml.load(raw) || {}
      panelModel = cfg.panelmodel || 1
    }
  } catch {}

  const ourPath = path.join(projectRoot, "out", game, `${uid}.json`)
  const basePath = path.join(yunzaiRoot, "plugins", "liangshi-calc", "replace", "data", String(panelModel), "PlayerData", game, `${uid}.json`)

  if (!fs.existsSync(ourPath)) throw new Error(`Missing our panel: ${ourPath}`)
  if (!fs.existsSync(basePath)) throw new Error(`Missing liangshi panel: ${basePath}`)

  const our = await readJson(ourPath)
  const base = await readJson(basePath)

  const ourAvatars = our?.avatars || {}
  const baseAvatars = base?.avatars || {}
  const ids = Object.keys(ourAvatars).filter((id) => baseAvatars[id])

  const meta = game === "gs" ? await loadGsMeta() : await loadSrMeta()

  const diffs = []
  const rows = []
  for (const id of ids) {
    const a = ourAvatars[id]
    const b = baseAvatars[id]
    if (!a?.artis || !b?.artis) continue

    if (game === "gs") {
      const am = await calcGsBuildMark(meta, { charId: Number(a.id || id), charName: a.name, elem: a.elem, weapon: a.weapon, cons: a.cons, artis: a.artis })
      const bm = await calcGsBuildMark(meta, { charId: Number(b.id || id), charName: b.name, elem: b.elem, weapon: b.weapon, cons: b.cons, artis: b.artis })
      const diff = Number((am.mark - bm.mark).toFixed(1))
      diffs.push(diff)
      rows.push({ id, name: a.name, ours: am.mark, liangshi: bm.mark, diff })
    } else {
      const am = calcSrBuildMark(meta, { charId: Number(a.id || id), charName: a.name, artis: a.artis })
      const bm = calcSrBuildMark(meta, { charId: Number(b.id || id), charName: b.name, artis: b.artis })
      const diff = Number((am.mark - bm.mark).toFixed(1))
      diffs.push(diff)
      rows.push({ id, name: a.name, ours: am.mark, liangshi: bm.mark, diff })
    }
  }

  const abs = diffs.map((d) => Math.abs(d))
  const stats = computeDiffStats(diffs)
  const passCount = abs.filter((d) => d <= tolerance).length
  const passRate = stats.n ? passCount / stats.n : 0

  return {
    game,
    uid,
    panelModel,
    ourPath,
    liangshiPath: basePath,
    common: stats.n,
    tolerance,
    passRate: Number(passRate.toFixed(4)),
    passCount,
    diffStats: stats,
    diffs: rows
  }
}

async function compareWithLiangshiMiaoThreshold({ game, uid, threshold }) {
  const yunzaiRoot = path.resolve(projectRoot, "..", "..")
  const require = (await import("node:module")).createRequire(import.meta.url)
  const yaml = require("js-yaml")

  const cfgPath = path.join(yunzaiRoot, "plugins", "liangshi-calc", "config", "config.yaml")
  let panelModel = 1
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8")
      const cfg = yaml.load(raw) || {}
      panelModel = cfg.panelmodel || 1
    }
  } catch {}

  const ourPath = path.join(projectRoot, "out", game, `${uid}.json`)
  const basePath = path.join(yunzaiRoot, "plugins", "liangshi-calc", "replace", "data", String(panelModel), "PlayerData", game, `${uid}.json`)

  if (!fs.existsSync(ourPath)) throw new Error(`Missing our panel: ${ourPath}`)
  if (!fs.existsSync(basePath)) throw new Error(`Missing liangshi panel: ${basePath}`)

  const our = await readJson(ourPath)
  const base = await readJson(basePath)

  const ourAvatars = our?.avatars || {}
  const baseAvatars = base?.avatars || {}
  const ids = Object.keys(ourAvatars).filter((id) => baseAvatars[id])

  const rows = []
  let eligible = 0
  let qualified = 0
  let baseAbove = 0
  let ourAbove = 0

  for (const id of ids) {
    const a = ourAvatars[id]
    const b = baseAvatars[id]
    if (!a?.artis || !b?.artis) continue

    const bm = await calcMiaoArtisMark(game, b)
    const am = await calcMiaoArtisMark(game, a)
    if (bm == null || am == null) continue

    const eligibleOne = bm >= threshold
    const qualifiedOne = eligibleOne && am >= threshold
    if (eligibleOne) eligible++
    if (qualifiedOne) qualified++
    if (bm >= threshold) baseAbove++
    if (am >= threshold) ourAbove++

    rows.push({
      id,
      name: a.name || b.name || id,
      ours: Number(am.toFixed(1)),
      liangshi: Number(bm.toFixed(1)),
      eligible: eligibleOne,
      qualified: qualifiedOne
    })
  }

  const qualifyRate = eligible ? qualified / eligible : 0
  const worst = rows
    .filter((r) => r.eligible && !r.qualified)
    .sort((x, y) => (y.liangshi - y.ours) - (x.liangshi - x.ours))
    .slice(0, 10)

  return {
    game,
    uid,
    panelModel,
    ourPath,
    liangshiPath: basePath,
    common: rows.length,
    threshold,
    eligible,
    qualified,
    qualifyRate: Number(qualifyRate.toFixed(4)),
    baseAbove,
    ourAbove,
    worst,
    rows
  }
}

async function runGameScan({ game, uidStart, maxUids, batchSize, stepSize, delayMs, targetCharFiles, scanDbPath }) {
  const samplesDir = path.join(projectRoot, "data", "samples", game)
  await ensureDir(samplesDir)
  const resetSamples = toBool(process.env.QA_RESET_SAMPLES, true)
  if (resetSamples) await emptyDir(samplesDir)

  const proxyCount = String(process.env.PROXY_URLS || "").split(",").filter(Boolean).length || 0

  let nextUid = uidStart
  let scanned = 0
  let stableNoGain = 0
  let lastCharFiles = (await listJsonlFiles(samplesDir)).length

  // Allow a "verify-only" mode that reuses existing samples without scanning.
  if (maxUids <= 0) {
    return {
      game,
      uidStart,
      scanned: 0,
      durationSec: 0,
      sampleChars: lastCharFiles,
      scanDbPath
    }
  }

  const t0 = nowMs()
  while (scanned < maxUids) {
    const remaining = maxUids - scanned
    const count = Math.min(stepSize || batchSize, remaining)

    let eta = ""
    if (delayMs > 0 && proxyCount > 0) {
      const approxRps = proxyCount / (delayMs / 1000)
      const estSec = Math.max(1, Math.round(count / Math.max(0.01, approxRps)))
      eta = ` eta~${estSec}s`
    }
    console.log(`[qa] game=${game} batch start uid=${nextUid} count=${count} scanned=${scanned}/${maxUids}${eta}`)
    const startedAt = nowMs()
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.round((nowMs() - startedAt) / 1000)
      console.log(`[qa] game=${game} batch running elapsedSec=${elapsedSec} scanned=${scanned}/${maxUids} (this batch count=${count})`)
    }, 30_000)

    try {
      await cmdSampleCollect([
        "--game", game,
        "--uidStart", String(nextUid),
        "--count", String(count),
        "--maxCount", String(count),
        "--delayMs", String(delayMs),
        "--jitterMs", "0",
        "--quiet",
        "--no-raw"
      ])
    } finally {
      clearInterval(heartbeat)
    }

    scanned += count
    nextUid += count

    const files = await listJsonlFiles(samplesDir)
    const charFiles = files.length
    const gained = Math.max(0, charFiles - lastCharFiles)
    lastCharFiles = charFiles

    console.log(`[qa] game=${game} scanned=${scanned}/${maxUids} sampleChars=${charFiles} gained=${gained}`)

    if (targetCharFiles > 0 && charFiles >= targetCharFiles) break

    if (gained <= 0) stableNoGain++
    else stableNoGain = 0
    if (stableNoGain >= 3) break
  }

  const t1 = nowMs()
  return {
    game,
    uidStart,
    scanned,
    durationSec: Math.round((t1 - t0) / 1000),
    sampleChars: lastCharFiles,
    scanDbPath
  }
}

async function main() {
  const { data: cfg } = loadAppConfig()
  const qa = cfg?.qa || {}
  const qaScan = qa?.scan || {}
  const qaVerify = qa?.verify || {}
  const qaVerifyGs = qaVerify?.gs || {}
  const qaVerifySr = qaVerify?.sr || {}
  const qaScanGs = qaScan?.gs || {}
  const qaScanSr = qaScan?.sr || {}
  const qaVerifyZzz = qaVerify?.zzz || {}
  const qaScanZzz = qaScan?.zzz || {}

  const gamesRaw = process.env.GAMES || qa?.games || "gs,sr"
  const games = toList(gamesRaw, ["gs", "sr"])
    .map((g) => g.toLowerCase())
    .filter((g) => ["gs", "sr", "zzz"].includes(g))

  // Backward compat: allow single subscription via SUB_URL; preferred is config `proxy.subscription.urls`.
  const subUrl = String(process.env.SUB_URL || "").trim()
  if (subUrl) {
    if (!process.env.PROXY_SUB_URLS) process.env.PROXY_SUB_URLS = subUrl
    if (!process.env.PROXY_ENABLED) process.env.PROXY_ENABLED = "1"
    if (!process.env.PROXY_REQUIRED) process.env.PROXY_REQUIRED = "1"
  }

  const cfgSubUrls = Array.isArray(cfg?.proxy?.subscription?.urls) ? cfg.proxy.subscription.urls.map(String).filter(Boolean) : []
  const envSubUrls = String(process.env.PROXY_SUB_URLS || "").trim()
  if (!envSubUrls && cfgSubUrls.length === 0) {
    throw new Error("Missing subscription url: set `proxy.subscription.urls` in config/config.yaml, or set env `SUB_URL` / `PROXY_SUB_URLS`")
  }

  const proxyPoolSize = Math.max(1, Math.min(50, toInt(process.env.PROXY_POOL_SIZE, Number(qa?.proxy?.poolSize ?? cfg?.proxy?.subscription?.maxNodes ?? 20))))
  const proxyProbeCount = Math.max(proxyPoolSize, Math.min(500, toInt(process.env.PROXY_PROBE_COUNT, Number(qa?.proxy?.probeCount ?? cfg?.proxy?.subscription?.probeCount ?? 200))))

  const uid = String(process.env.PRESET_UID || qa?.uid || cfg?.preset?.uid || "100000000")
  const uidZzz = String(process.env.PRESET_UID_ZZZ || qa?.uidZzz || "10000000")
  const delayMs = Math.max(0, toInt(process.env.DELAY_MS, Number(qaScan?.delayMs ?? cfg?.samples?.enka?.delayMs ?? 1200)))
  const batchSize = Math.max(50, Math.min(20_000, toInt(process.env.BATCH_SIZE, Number(qaScan?.batchSize ?? 2000))))
  const enkaTimeoutMs = Math.max(1000, Math.min(60_000, toInt(process.env.ENKA_TIMEOUT_MS, Number(qaScan?.enkaTimeoutMs ?? cfg?.samples?.enka?.timeoutMs ?? 8000))))
  if (!process.env.ENKA_TIMEOUT_MS) process.env.ENKA_TIMEOUT_MS = String(enkaTimeoutMs)

  const maxUidsGs = Math.max(0, toInt(process.env.MAX_UIDS_GS, Number(qaScanGs?.maxUids ?? cfg?.samples?.enka?.maxCount ?? 2000)))
  const maxUidsSr = Math.max(0, toInt(process.env.MAX_UIDS_SR, Number(qaScanSr?.maxUids ?? cfg?.samples?.enka?.maxCount ?? 2000)))
  const maxUidsZzz = Math.max(0, toInt(process.env.MAX_UIDS_ZZZ, Number(qaScanZzz?.maxUids ?? 500)))
  const cfgEnka = cfg?.samples?.enka || {}
  const cfgEnkaGs = cfgEnka?.gs || {}
  const cfgEnkaSr = cfgEnka?.sr || {}
  const cfgEnkaZzz = cfgEnka?.zzz || {}

  const uidStartGs = toInt(process.env.UID_START_GS, Number(qaScanGs?.uidStart ?? cfgEnkaGs?.uidStart ?? cfgEnka?.uidStart ?? 100000001))
  const uidStartSr = toInt(process.env.UID_START_SR, Number(qaScanSr?.uidStart ?? cfgEnkaSr?.uidStart ?? cfgEnka?.uidStart ?? 100000001))
  const uidStartZzz = toInt(process.env.UID_START_ZZZ, Number(qaScanZzz?.uidStart ?? cfgEnkaZzz?.uidStart ?? 10000000))

  const targetCharsGs = Math.max(0, toInt(process.env.TARGET_CHARS_GS, Number(qaScanGs?.targetChars ?? 80)))
  const targetCharsSr = Math.max(0, toInt(process.env.TARGET_CHARS_SR, Number(qaScanSr?.targetChars ?? 60)))
  const targetCharsZzz = Math.max(0, toInt(process.env.TARGET_CHARS_ZZZ, Number(qaScanZzz?.targetChars ?? 20)))

  const toleranceGs = Math.max(0, toNum(process.env.TOLERANCE_GS, toNum(qaVerifyGs?.tolerance ?? process.env.TOLERANCE, 5)))
  const toleranceSr = Math.max(0, toNum(process.env.TOLERANCE_SR, toNum(qaVerifySr?.tolerance ?? process.env.TOLERANCE, 500)))
  const minCommonGs = Math.max(0, toInt(process.env.MIN_COMMON_GS, toInt(qaVerifyGs?.minCommon ?? process.env.MIN_COMMON, 10)))
  const minCommonSr = Math.max(0, toInt(process.env.MIN_COMMON_SR, toInt(qaVerifySr?.minCommon ?? process.env.MIN_COMMON, 10)))
  const passRateRequiredGs = Math.max(0, Math.min(1, toNum(process.env.PASS_RATE_GS, toNum(qaVerifyGs?.passRate ?? process.env.PASS_RATE, 0.8))))
  const passRateRequiredSr = Math.max(0, Math.min(1, toNum(process.env.PASS_RATE_SR, toNum(qaVerifySr?.passRate ?? process.env.PASS_RATE, 0.5))))
  const verifyMode = String(process.env.QA_VERIFY_MODE || qaVerify?.mode || "miao").toLowerCase()
  const thresholdGs = Math.max(0, toNum(process.env.THRESHOLD_GS, toNum(qaVerifyGs?.threshold ?? 300, 300)))
  const thresholdSr = Math.max(0, toNum(process.env.THRESHOLD_SR, toNum(qaVerifySr?.threshold ?? 300, 300)))

  const zzzMinMark = Math.max(0, toNum(process.env.ZZZ_MIN_MARK, toNum(qaVerifyZzz?.minMark, 590)))
  const zzzRequireSignature = toBool(process.env.ZZZ_REQUIRE_SIGNATURE, toBool(qaVerifyZzz?.requireSignature, true))
  const zzzRequirePattern = toBool(process.env.ZZZ_REQUIRE_PATTERN, toBool(qaVerifyZzz?.requirePattern, true))
  const zzzMinAvatars = Math.max(0, toInt(process.env.MIN_AVATARS_ZZZ, Number(qaVerifyZzz?.minAvatars ?? 5)))
  const passRateRequiredZzz = Math.max(0, Math.min(1, toNum(process.env.PASS_RATE_ZZZ, toNum(qaVerifyZzz?.passRate, 1))))

  const scanDbBase = path.resolve(
    process.env.SCAN_DB_PATH ||
      process.env.QA_SCAN_DB_PATH ||
      String(qaScan?.dbPath || "").trim() ||
      path.join(projectRoot, "data", "scan.qa.sqlite")
  )
  const resetDb = toBool(process.env.QA_SCAN_DB_RESET, toBool(qaScan?.dbReset, true))
  if (resetDb) await resetSqliteFile(scanDbBase)
  process.env.SCAN_DB_PATH = scanDbBase

  // Proxy pool (strict health check: require JSON and no HTML/WAF page).
  if (!process.env.PROXY_POOL_SIZE) process.env.PROXY_POOL_SIZE = String(proxyPoolSize)
  if (!process.env.PROXY_PROBE_COUNT) process.env.PROXY_PROBE_COUNT = String(proxyProbeCount)
  process.env.PROXY_TEST_URL = process.env.PROXY_TEST_URL || cfg?.proxy?.subscription?.testUrl || "https://enka.network/api/uid/100000001"

  // If user has enabled proxy in config, ensure env flags exist (so downstream can read consistently).
  if (cfg?.proxy?.enabled && !process.env.PROXY_ENABLED) process.env.PROXY_ENABLED = "1"
  if (cfg?.proxy?.required && !process.env.PROXY_REQUIRED) process.env.PROXY_REQUIRED = "1"

  console.log(`\n===== qa flow =====`)
  console.log(`games=${games.join(",")} uid=${uid}`)
  if (games.includes("zzz")) console.log(`uidZzz=${uidZzz}`)
  console.log(`proxyPoolSize=${proxyPoolSize} probeCount=${proxyProbeCount}`)
  const stepSize = Math.max(10, Math.min(batchSize, toInt(process.env.STEP_SIZE, Number(qaScan?.stepSize ?? 200))))
  console.log(`delayMs=${delayMs} (concurrency=adaptive) batchSize=${batchSize} stepSize=${stepSize} enkaTimeoutMs=${enkaTimeoutMs}`)
  console.log(`scanDb=${scanDbBase} resetDb=${resetDb}`)
  console.log(`maxUidsGs=${maxUidsGs} maxUidsSr=${maxUidsSr}`)
  if (games.includes("zzz")) console.log(`maxUidsZzz=${maxUidsZzz} uidStartZzz=${uidStartZzz} targetCharsZzz=${targetCharsZzz}`)
  console.log(`targetCharsGs=${targetCharsGs} targetCharsSr=${targetCharsSr}`)
  console.log(`verifyMode=${verifyMode}`)
  console.log(`toleranceGs=${toleranceGs} toleranceSr=${toleranceSr}`)
  console.log(`thresholdGs=${thresholdGs} thresholdSr=${thresholdSr}`)
  console.log(`minCommonGs=${minCommonGs} passRateGs=${passRateRequiredGs}`)
  console.log(`minCommonSr=${minCommonSr} passRateSr=${passRateRequiredSr}`)
  if (games.includes("zzz")) console.log(`zzzMinMark=${zzzMinMark} requireSignature=${zzzRequireSignature} requirePattern=${zzzRequirePattern} minAvatars=${zzzMinAvatars} passRateZzz=${passRateRequiredZzz}`)

  const pool = await ensureProxyPool(cfg)
  const proxyUrls = pool?.proxyUrls || []
  process.env.PROXY_URLS = proxyUrls.join(",")
  console.log(`[qa] proxy pool ready: ${proxyUrls.length}`)

  const results: any = { startedAt: nowMs(), proxy: { count: proxyUrls.length }, games: {} }

  try {
    // Meta is only needed for gs/sr scoring.
    if (games.some((g) => g === "gs" || g === "sr")) {
      await cmdMetaSync(["--game", "all"])
    }

    if (games.includes("gs")) {
      const scan = await runGameScan({
        game: "gs",
        uidStart: uidStartGs,
        maxUids: maxUidsGs,
        batchSize,
        stepSize,
        delayMs,
        targetCharFiles: targetCharsGs,
        scanDbPath: scanDbBase
      })
      await cmdPresetGenerate(["--game", "gs", "--uid", uid, "--quiet"])
      const verify: any = verifyMode === "miao"
        ? await compareWithLiangshiMiaoThreshold({ game: "gs", uid, threshold: thresholdGs })
        : await compareWithLiangshi({ game: "gs", uid, tolerance: toleranceGs })
      results.games.gs = {
        scan,
        verify,
        pass: verifyMode === "miao"
          ? verify.eligible >= minCommonGs && verify.qualifyRate >= passRateRequiredGs
          : verify.common >= minCommonGs && verify.passRate >= passRateRequiredGs
      }
    }

    if (games.includes("sr")) {
      const scan = await runGameScan({
        game: "sr",
        uidStart: uidStartSr,
        maxUids: maxUidsSr,
        batchSize,
        stepSize,
        delayMs,
        targetCharFiles: targetCharsSr,
        scanDbPath: scanDbBase
      })
      await cmdPresetGenerate(["--game", "sr", "--uid", uid, "--quiet"])
      const verify: any = verifyMode === "miao"
        ? await compareWithLiangshiMiaoThreshold({ game: "sr", uid, threshold: thresholdSr })
        : await compareWithLiangshi({ game: "sr", uid, tolerance: toleranceSr })
      results.games.sr = {
        scan,
        verify,
        pass: verifyMode === "miao"
          ? verify.eligible >= minCommonSr && verify.qualifyRate >= passRateRequiredSr
          : verify.common >= minCommonSr && verify.passRate >= passRateRequiredSr
      }
    }

    if (games.includes("zzz")) {
      const scan = await runGameScan({
        game: "zzz",
        uidStart: uidStartZzz,
        maxUids: maxUidsZzz,
        batchSize,
        stepSize,
        delayMs,
        targetCharFiles: targetCharsZzz,
        scanDbPath: scanDbBase
      })
      await cmdPresetGenerate(["--game", "zzz", "--uid", uidZzz, "--quiet"])
      const verify: any = await verifyZzzPreset({
        uid: uidZzz,
        minMark: zzzMinMark,
        requireSignature: zzzRequireSignature,
        requirePattern: zzzRequirePattern
      })
      results.games.zzz = {
        scan,
        verify,
        pass: verify.total >= zzzMinAvatars && verify.passRate >= passRateRequiredZzz
      }
    }
  } finally {
    await pool.close?.().catch?.(() => {})
    results.finishedAt = nowMs()
    results.durationSec = Math.round((results.finishedAt - results.startedAt) / 1000)
  }

  results.pass = Object.values(results.games as any).every((g: any) => g?.pass === true)

  const outPath = path.join(projectRoot, "out", `qa-flow.${Date.now()}.json`)
  await ensureDir(path.dirname(outPath))
  await fsp.writeFile(outPath, JSON.stringify(results, null, 2), "utf8")

  console.log(`\nwritten: ${outPath}`)
  console.log(`pass=${results.pass} durationSec=${results.durationSec}`)
  for (const game of Object.keys(results.games || {})) {
    const g = results.games[game]
    const v = g?.verify

    if (game === "zzz") {
      console.log(`[${game}] pass=${g?.pass} scanned=${g?.scan?.scanned} sampleChars=${g?.scan?.sampleChars} total=${v?.total} passRate=${v?.passRate} minMark=${v?.minMark}`)
      if (Array.isArray(v?.worst) && v.worst.length) {
        const tops = v.worst.slice(0, 5).map((r) => `${r.name}(${r.id}): mark=${r.mark} weapon=${r.weaponName || ""}(${r.weaponId || ""})`).join("; ")
        console.log(`[${game}] worst: ${tops}`)
      }
      continue
    }

    if (verifyMode === "miao") {
      console.log(`[${game}] pass=${g?.pass} scanned=${g?.scan?.scanned} sampleChars=${g?.scan?.sampleChars} common=${v?.common} eligible=${v?.eligible} qualifyRate=${v?.qualifyRate} threshold=${v?.threshold}`)
      if (Array.isArray(v?.worst) && v.worst.length) {
        const tops = v.worst.slice(0, 5).map((r) => `${r.name}(${r.id}): ours=${r.ours} base=${r.liangshi}`).join("; ")
        console.log(`[${game}] worst: ${tops}`)
      }
    } else {
      console.log(`[${game}] pass=${g?.pass} scanned=${g?.scan?.scanned} sampleChars=${g?.scan?.sampleChars} common=${v?.common} passRate=${v?.passRate} meanAbs=${v?.diffStats?.meanAbs} p90Abs=${v?.diffStats?.p90Abs} maxAbs=${v?.diffStats?.maxAbs}`)
    }
  }

  // Ensure this script terminates even if some imported modules keep handles open.
  process.exit(results.pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exit(1)
})
