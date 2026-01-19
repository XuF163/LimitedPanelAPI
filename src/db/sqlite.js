import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { DatabaseSync } from "node:sqlite"
import { paths } from "../config.js"

function nowMs() {
  return Date.now()
}

function gzipBuffer(text) {
  return zlib.gzipSync(Buffer.from(text, "utf8"))
}

export function openScanDb({ dbPath } = {}) {
  const envDbPath = String(process.env.SCAN_DB_PATH || "").trim()
  const resolved = dbPath || (envDbPath ? path.resolve(envDbPath) : path.join(paths.dataDir, "scan.sqlite"))
  fs.mkdirSync(path.dirname(resolved), { recursive: true })

  const db = new DatabaseSync(resolved)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  // Avoid "database is locked" errors when multiple processes share the same scan DB
  // (e.g. gs/sr/zzz running together without proxy).
  db.exec("PRAGMA busy_timeout = 8000;")

  const tableInfo = (name) => {
    try {
      return db.prepare(`PRAGMA table_info(${name})`).all() || []
    } catch {
      return []
    }
  }

  const hasColumn = (rows, colName) => (rows || []).some((r) => String(r?.name || "").toLowerCase() === colName.toLowerCase())

  const uidInfo = tableInfo("enka_uid")
  const rawInfo = tableInfo("enka_raw")

  // v0 schema used uid as primary key. Starting from multi-game support we key by (game, uid).
  if (uidInfo.length > 0 && !hasColumn(uidInfo, "game")) {
    db.exec("BEGIN;")
    db.exec("ALTER TABLE enka_uid RENAME TO enka_uid_old;")
    db.exec(`
      CREATE TABLE enka_uid (
        game TEXT NOT NULL,
        uid INTEGER NOT NULL,
        status INTEGER,
        permanent INTEGER DEFAULT 0,
        last_error TEXT,
        fail_count INTEGER DEFAULT 0,
        last_checked_at INTEGER,
        next_retry_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (game, uid)
      );
    `)
    db.exec(`
      INSERT INTO enka_uid (game, uid, status, permanent, last_error, fail_count, last_checked_at, next_retry_at, updated_at)
      SELECT 'gs', uid, status, permanent, last_error, fail_count, last_checked_at, next_retry_at, updated_at
      FROM enka_uid_old;
    `)
    db.exec("DROP TABLE enka_uid_old;")
    db.exec("COMMIT;")
  }

  if (rawInfo.length > 0 && !hasColumn(rawInfo, "game")) {
    db.exec("BEGIN;")
    db.exec("ALTER TABLE enka_raw RENAME TO enka_raw_old;")
    db.exec(`
      CREATE TABLE enka_raw (
        game TEXT NOT NULL,
        uid INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        status INTEGER NOT NULL,
        body_gz BLOB NOT NULL,
        PRIMARY KEY (game, uid, fetched_at)
      );
    `)
    db.exec(`
      INSERT INTO enka_raw (game, uid, fetched_at, status, body_gz)
      SELECT 'gs', uid, fetched_at, status, body_gz
      FROM enka_raw_old;
    `)
    db.exec("DROP TABLE enka_raw_old;")
    db.exec("COMMIT;")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enka_uid (
      game TEXT NOT NULL,
      uid INTEGER NOT NULL,
      status INTEGER,
      permanent INTEGER DEFAULT 0,
      last_error TEXT,
      fail_count INTEGER DEFAULT 0,
      last_checked_at INTEGER,
      next_retry_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (game, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_enka_uid_game_permanent ON enka_uid(game, permanent);
    CREATE INDEX IF NOT EXISTS idx_enka_uid_game_next_retry ON enka_uid(game, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_enka_uid_game_last_checked ON enka_uid(game, last_checked_at);

    CREATE TABLE IF NOT EXISTS enka_raw (
      game TEXT NOT NULL,
      uid INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      status INTEGER NOT NULL,
      body_gz BLOB NOT NULL,
      PRIMARY KEY (game, uid, fetched_at)
    );
    CREATE INDEX IF NOT EXISTS idx_enka_raw_game_uid ON enka_raw(game, uid);

    CREATE TABLE IF NOT EXISTS scan_cursor (
      name TEXT PRIMARY KEY,
      next_uid INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS rate_limit (
      name TEXT PRIMARY KEY,
      next_at INTEGER,
      updated_at INTEGER
    );
  `)

  const stmtGet = db.prepare(`SELECT * FROM enka_uid WHERE game = ? AND uid = ?`)
  const stmtUpsert = db.prepare(`
    INSERT INTO enka_uid (game, uid, status, permanent, last_error, fail_count, last_checked_at, next_retry_at, updated_at)
    VALUES (@game, @uid, @status, @permanent, @last_error, @fail_count, @last_checked_at, @next_retry_at, @updated_at)
    ON CONFLICT(game, uid) DO UPDATE SET
      status=excluded.status,
      permanent=excluded.permanent,
      last_error=excluded.last_error,
      fail_count=excluded.fail_count,
      last_checked_at=excluded.last_checked_at,
      next_retry_at=excluded.next_retry_at,
      updated_at=excluded.updated_at
  `)
  const stmtInsertRaw = db.prepare(`
    INSERT OR REPLACE INTO enka_raw (game, uid, fetched_at, status, body_gz)
    VALUES (?, ?, ?, ?, ?)
  `)

  const stmtGetCursor = db.prepare(`SELECT name, next_uid, updated_at FROM scan_cursor WHERE name = ?`)
  const stmtUpsertCursor = db.prepare(`
    INSERT INTO scan_cursor (name, next_uid, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      next_uid=excluded.next_uid,
      updated_at=excluded.updated_at
  `)

  const stmtGetRateLimit = db.prepare(`SELECT name, next_at, updated_at FROM rate_limit WHERE name = ?`)
  const stmtUpsertRateLimit = db.prepare(`
    INSERT INTO rate_limit (name, next_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      next_at=excluded.next_at,
      updated_at=excluded.updated_at
  `)
  const stmtListDueRetry = db.prepare(`
    SELECT uid FROM enka_uid
    WHERE game = ?
      AND permanent = 0
      AND next_retry_at IS NOT NULL
      AND next_retry_at <= ?
    ORDER BY next_retry_at ASC
    LIMIT ?
  `)

  const stmtListStale = db.prepare(`
    SELECT uid FROM enka_uid
    WHERE game = ?
      AND permanent = 0
      AND last_checked_at IS NOT NULL
      AND last_checked_at <= ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
      AND uid BETWEEN ? AND ?
    ORDER BY last_checked_at ASC
    LIMIT ?
  `)

  const normalizeGame = (game) => (game ? String(game).toLowerCase() : "gs")

  const getUidState = (uid, { game = "gs" } = {}) => stmtGet.get(normalizeGame(game), uid) || null

  const markPermanent = (uid, { game = "gs", status, error } = {}) => {
    const g = normalizeGame(game)
    const prev = getUidState(uid, { game: g })
    const row = {
      game: g,
      uid,
      status: status ?? prev?.status ?? null,
      permanent: 1,
      last_error: error ? String(error) : prev?.last_error ?? null,
      fail_count: (prev?.fail_count || 0) + 1,
      last_checked_at: nowMs(),
      next_retry_at: null,
      updated_at: nowMs()
    }
    stmtUpsert.run(row)
  }

  const recordSuccess = (uid, { game = "gs", status = 200, bodyText, storeRaw = true } = {}) => {
    const g = normalizeGame(game)
    const prev = getUidState(uid, { game: g })
    stmtUpsert.run({
      game: g,
      uid,
      status,
      permanent: 0,
      last_error: null,
      fail_count: 0,
      last_checked_at: nowMs(),
      next_retry_at: null,
      updated_at: nowMs()
    })

    if (storeRaw && typeof bodyText === "string") {
      stmtInsertRaw.run(g, uid, nowMs(), status, gzipBuffer(bodyText))
    }
  }

  const computeBackoffMs = (failCount, { baseMs = 30_000, maxMs = 30 * 60_000 } = {}) => {
    const fc = Math.max(1, Math.min(50, Number(failCount) || 1))
    // 30s, 60s, 120s... capped.
    const ms = Math.min(maxMs, baseMs * Math.pow(2, Math.min(10, fc - 1)))
    // Add a small deterministic jitter based on uid later if needed; keep simple for now.
    return ms
  }

  const recordFailure = (uid, { game = "gs", status, error, retryAfterMs } = {}) => {
    const g = normalizeGame(game)
    const prev = getUidState(uid, { game: g })
    const failCount = (prev?.fail_count || 0) + 1
    const backoff = Number.isFinite(retryAfterMs) ? retryAfterMs : computeBackoffMs(failCount)
    const row = {
      game: g,
      uid,
      status: status ?? prev?.status ?? null,
      permanent: prev?.permanent ? 1 : 0,
      last_error: error ? String(error) : prev?.last_error ?? null,
      fail_count: failCount,
      last_checked_at: nowMs(),
      next_retry_at: nowMs() + backoff,
      updated_at: nowMs()
    }
    stmtUpsert.run(row)
    return { failCount, nextRetryAt: row.next_retry_at }
  }

  const shouldSkipUid = (uid, { game = "gs", now = nowMs() } = {}) => {
    const st = getUidState(uid, { game })
    if (!st) return { skip: false, reason: "" }
    if (st.permanent) return { skip: true, reason: `permanent status=${st.status || ""}`.trim() }
    if (st.next_retry_at && Number(st.next_retry_at) > now) return { skip: true, reason: `retry_at=${st.next_retry_at}` }
    return { skip: false, reason: "" }
  }

  const getCursor = (name, fallbackNextUid = null) => {
    const row = stmtGetCursor.get(name)
    if (!row) return { name, next_uid: fallbackNextUid, updated_at: null }
    return row
  }

  const setCursor = (name, nextUid) => {
    stmtUpsertCursor.run(name, nextUid, nowMs())
  }

  const listDueRetryUids = (limit = 10, { game = "gs", now = nowMs() } = {}) => {
    const rows = stmtListDueRetry.all(normalizeGame(game), now, Math.max(0, Number(limit) || 0))
    return (rows || []).map((r) => Number(r.uid)).filter((v) => Number.isFinite(v))
  }

  const listStaleUids = (
    limit = 10,
    { game = "gs", now = nowMs(), minAgeMs = 0, uidMin = null, uidMax = null } = {}
  ) => {
    const lim = Math.max(0, Number(limit) || 0)
    const age = Math.max(0, Number(minAgeMs) || 0)
    if (!lim || !age) return []

    const cutoff = now - age
    const min = Number.isFinite(Number(uidMin)) ? Number(uidMin) : 0
    const max = Number.isFinite(Number(uidMax)) ? Number(uidMax) : 9_999_999_999
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)

    const rows = stmtListStale.all(normalizeGame(game), cutoff, now, lo, hi, lim)
    return (rows || []).map((r) => Number(r.uid)).filter((v) => Number.isFinite(v))
  }

  // Reserve a slot in a shared (cross-process) rate limiter.
  // Returns how long the caller should wait before performing the action.
  const reserveRateLimit = (name, intervalMs, { now = nowMs() } = {}) => {
    const ms = Math.max(0, Number(intervalMs) || 0)
    if (!ms) return { waitMs: 0, nextAt: null }
    const key = String(name || "").trim()
    if (!key) return { waitMs: 0, nextAt: null }

    let waitMs = 0
    let nextAt = null

    db.exec("BEGIN IMMEDIATE;")
    try {
      const row = stmtGetRateLimit.get(key) || null
      const curNextAt = Math.max(0, Number(row?.next_at || 0))
      waitMs = Math.max(0, curNextAt - now)
      nextAt = Math.max(curNextAt, now) + ms
      stmtUpsertRateLimit.run(key, nextAt, nowMs())
      db.exec("COMMIT;")
    } catch (e) {
      try { db.exec("ROLLBACK;") } catch {}
      throw e
    }

    return { waitMs, nextAt }
  }

  const close = () => db.close()

  return { dbPath: resolved, getUidState, shouldSkipUid, markPermanent, recordSuccess, recordFailure, getCursor, setCursor, listDueRetryUids, listStaleUids, reserveRateLimit, close }
}
