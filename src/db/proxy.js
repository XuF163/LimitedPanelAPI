import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { DatabaseSync } from "node:sqlite"
import { paths } from "../config.js"

function nowMs() {
  return Date.now()
}

function gzipBuffer(text) {
  return zlib.gzipSync(Buffer.from(String(text || ""), "utf8"))
}

function gunzipToText(buf) {
  try {
    if (!buf) return null
    const out = zlib.gunzipSync(buf)
    return out ? out.toString("utf8") : null
  } catch {
    return null
  }
}

export function openProxyDb({ dbPath } = {}) {
  const envDbPath = String(process.env.PROXY_DB_PATH || "").trim()
  const resolved = dbPath || (envDbPath ? path.resolve(envDbPath) : path.join(paths.dataDir, "proxy.sqlite"))
  fs.mkdirSync(path.dirname(resolved), { recursive: true })

  const db = new DatabaseSync(resolved)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")

  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_node (
      node_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      node_type TEXT,
      node_tag TEXT,
      node_host TEXT,
      node_port INTEGER,
      node_gz BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_node_type ON proxy_node(node_type);
    CREATE INDEX IF NOT EXISTS idx_proxy_node_host_port ON proxy_node(node_host, node_port);

    CREATE TABLE IF NOT EXISTS proxy_v2ray_attempt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      local_port INTEGER,
      node_type TEXT,
      node_tag TEXT,
      node_host TEXT,
      node_port INTEGER,
      node_gz BLOB,
      config_gz BLOB,
      test_url TEXT,
      test_status INTEGER,
      test_ms INTEGER,
      ok INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_v2ray_attempt_created_at ON proxy_v2ray_attempt(created_at);
    CREATE INDEX IF NOT EXISTS idx_proxy_v2ray_attempt_ok ON proxy_v2ray_attempt(ok);
  `)

  const stmtInsertNode = db.prepare(`
    INSERT OR IGNORE INTO proxy_node (
      node_key, created_at, updated_at, node_type, node_tag, node_host, node_port, node_gz
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const stmtCountNodes = db.prepare(`SELECT COUNT(1) AS cnt FROM proxy_node`)
  const stmtListNodes = db.prepare(`
    SELECT node_key, node_gz
    FROM proxy_node
    ORDER BY updated_at DESC
    LIMIT ?
  `)

  const insertNode = ({ key, node } = {}) => {
    const k = String(key || "").trim()
    if (!k) return { ok: false, inserted: false, reason: "missing_key" }
    const createdAt = nowMs()
    const nodeType = node?.type != null ? String(node.type) : null
    const nodeTag = node?.tag != null ? String(node.tag) : null
    const nodeHost = node?.host != null ? String(node.host) : null
    const nodePort = node?.port != null ? Number(node.port) : null
    const nodeGz = gzipBuffer(JSON.stringify(node || null))

    const info = stmtInsertNode.run(
      k,
      createdAt,
      createdAt,
      nodeType,
      nodeTag,
      nodeHost,
      Number.isFinite(nodePort) ? nodePort : null,
      nodeGz
    )
    const inserted = Number(info?.changes || 0) > 0
    return { ok: true, inserted }
  }

  const countNodes = () => {
    try {
      const row = stmtCountNodes.get()
      return Number(row?.cnt || 0) || 0
    } catch {
      return 0
    }
  }

  const listNodes = ({ limit = 5000 } = {}) => {
    const n = Math.max(1, Math.min(50_000, Number(limit) || 5000))
    const out = []
    try {
      const rows = stmtListNodes.all(n) || []
      for (const r of rows) {
        const txt = gunzipToText(r?.node_gz)
        if (!txt) continue
        let node
        try {
          node = JSON.parse(txt)
        } catch {
          continue
        }
        if (!node || typeof node !== "object") continue
        out.push(node)
      }
      return out
    } catch {
      return out
    }
  }

  const stmtInsert = db.prepare(`
    INSERT INTO proxy_v2ray_attempt (
      created_at, local_port, node_type, node_tag, node_host, node_port,
      node_gz, config_gz, test_url, test_status, test_ms, ok, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertAttempt = ({ localPort, node, config, testUrl }) => {
    const createdAt = nowMs()
    const nodeType = node?.type != null ? String(node.type) : null
    const nodeTag = node?.tag != null ? String(node.tag) : null
    const nodeHost = node?.host != null ? String(node.host) : null
    const nodePort = node?.port != null ? Number(node.port) : null

    const nodeGz = gzipBuffer(JSON.stringify(node || null))
    const cfgGz = gzipBuffer(JSON.stringify(config || null))

    const info = stmtInsert.run(
      createdAt,
      localPort != null ? Number(localPort) : null,
      nodeType,
      nodeTag,
      nodeHost,
      Number.isFinite(nodePort) ? nodePort : null,
      nodeGz,
      cfgGz,
      testUrl != null ? String(testUrl) : null,
      null,
      null,
      null,
      null
    )

    // node:sqlite returns lastInsertRowid on the statement/changes object.
    return Number(info?.lastInsertRowid || 0) || null
  }

  const stmtUpdate = db.prepare(`
    UPDATE proxy_v2ray_attempt
    SET test_status = ?, test_ms = ?, ok = ?, error = ?
    WHERE id = ?
  `)

  const finishAttempt = (id, { ok, status, ms, error } = {}) => {
    if (!id) return
    stmtUpdate.run(
      status != null ? Number(status) : null,
      ms != null ? Number(ms) : null,
      ok == null ? null : (ok ? 1 : 0),
      error != null ? String(error) : null,
      Number(id)
    )
  }

  return {
    dbPath: resolved,
    insertNode,
    countNodes,
    listNodes,
    insertAttempt,
    finishAttempt,
    close: () => db.close()
  }
}
