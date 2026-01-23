const startedAt = Date.now()

const state = {
  startedAt,
  proxyPool: null,
  scanner: {
    running: false,
    games: {
      gs: { running: false, startedAt: null, lastError: null },
      sr: { running: false, startedAt: null, lastError: null },
      zzz: { running: false, startedAt: null, lastError: null }
    }
  },
  adaptive: {
    current: null,
    max: null,
    backoffLevel: 0,
    backoffUntil: 0,
    updatedAt: 0
  },
  recent: {
    windowMs: 60_000,
    events: [] // { t, kind }
  }
}

function now() {
  return Date.now()
}

function pruneRecent() {
  const cutoff = now() - state.recent.windowMs
  const ev = state.recent.events
  while (ev.length && ev[0].t < cutoff) ev.shift()
}

export function setProxyPool(pool) {
  state.proxyPool = pool || null
}

export function getProxyPool() {
  return state.proxyPool
}

export function recordRecent(kind) {
  state.recent.events.push({ t: now(), kind: String(kind || "unknown") })
  pruneRecent()
}

export function setAdaptiveStatus({ current = null, max = null, backoffLevel = 0, backoffUntil = 0 } = {}) {
  state.adaptive.current = current == null ? null : Number(current)
  state.adaptive.max = max == null ? null : Number(max)
  state.adaptive.backoffLevel = Number(backoffLevel) || 0
  state.adaptive.backoffUntil = Number(backoffUntil) || 0
  state.adaptive.updatedAt = now()
}

export function setScannerGameRunning(game, running, { error = null } = {}) {
  const g = String(game || "").toLowerCase()
  const slot = state.scanner.games[g]
  if (!slot) return
  slot.running = Boolean(running)
  slot.startedAt = running ? now() : null
  slot.lastError = error ? String(error) : null
  state.scanner.running = Object.values(state.scanner.games).some((x) => x.running)
}

export function getRuntimeStatus() {
  pruneRecent()
  const uptimeSec = Math.max(0, Math.floor((now() - state.startedAt) / 1000))

  const recent1m = {}
  for (const e of state.recent.events) {
    recent1m[e.kind] = (recent1m[e.kind] || 0) + 1
  }

  const proxyPool = (() => {
    const p = state.proxyPool
    if (!p) return null
    try {
      if (typeof p.status === "function") return p.status()
      return { enabled: Boolean(p.enabled), usable: Array.isArray(p.proxyUrls) ? p.proxyUrls.length : 0 }
    } catch (e) {
      return { enabled: true, error: e?.message || String(e) }
    }
  })()

  return {
    ok: true,
    version: "v2",
    uptimeSec,
    adaptiveConcurrency: {
      current: state.adaptive.current,
      max: state.adaptive.max,
      backoff: { level: state.adaptive.backoffLevel, until: state.adaptive.backoffUntil },
      updatedAt: state.adaptive.updatedAt || null
    },
    proxyPool,
    scanner: {
      running: state.scanner.running,
      games: state.scanner.games,
      recent1m
    }
  }
}

