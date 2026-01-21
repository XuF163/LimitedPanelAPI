const LEVEL = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
}

function normalizeLevel(v, fallback = LEVEL.info) {
  const s = String(v ?? "").trim().toLowerCase()
  if (!s) return fallback
  if (s === "error" || s === "err") return LEVEL.error
  if (s === "warn" || s === "warning") return LEVEL.warn
  if (s === "info") return LEVEL.info
  if (s === "debug" || s === "dbg") return LEVEL.debug
  const n = Number(s)
  if (Number.isFinite(n)) {
    const i = Math.trunc(n)
    if (i <= 0) return LEVEL.error
    if (i === 1) return LEVEL.warn
    if (i === 2) return LEVEL.info
    return LEVEL.debug
  }
  return fallback
}

function envLogLevel() {
  const raw = process.env.LOG_LEVEL || process.env.LOGLEVEL || ""
  if (raw) return normalizeLevel(raw, LEVEL.info)
  const debug = String(process.env.DEBUG || "").trim()
  if (debug && debug !== "0" && debug.toLowerCase() !== "false") return LEVEL.debug
  return LEVEL.info
}

function getSink() {
  const g = globalThis?.logger
  const consoleDebug = console.debug ? console.debug.bind(console) : console.log.bind(console)
  return {
    debug: (g?.debug ? g.debug.bind(g) : consoleDebug),
    info: (g?.info ? g.info.bind(g) : console.log.bind(console)),
    warn: (g?.warn ? g.warn.bind(g) : console.warn.bind(console)),
    error: (g?.error ? g.error.bind(g) : console.error.bind(console))
  }
}

export function setupUtf8() {
  try { process.stdout?.setDefaultEncoding?.("utf8") } catch {}
  try { process.stderr?.setDefaultEncoding?.("utf8") } catch {}
}

// Reduce noisy runtime warnings (keeps real errors/warnings).
export function suppressNoisyWarnings() {
  if (globalThis.__limitedpanel_noisy_warnings_suppressed) return
  globalThis.__limitedpanel_noisy_warnings_suppressed = true

  const orig = process.emitWarning
  if (typeof orig !== "function") return

  process.emitWarning = function emitWarningPatched(warning, ...args) {
    try {
      const msg = typeof warning === "string" ? warning : String(warning?.message || "")

      let type = ""
      if (typeof args[0] === "string") type = args[0]
      else if (args[0] && typeof args[0] === "object") type = String(args[0]?.type || args[0]?.name || "")

      const name = typeof warning === "string" ? "" : String(warning?.name || "")
      const kind = type || name

      // Node.js >= 22: `node:sqlite` is experimental and spams stderr on every run.
      if (kind === "ExperimentalWarning" && (msg.includes("SQLite") || msg.includes("node:sqlite"))) return
    } catch {}
    return orig.call(process, warning, ...args)
  }
}

export function fmtKv(obj) {
  if (!obj || typeof obj !== "object") return ""
  const parts = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue
    parts.push(`${k}=${v}`)
  }
  return parts.join(" ")
}

export function createLogger(tag = "", { level } = {}) {
  const sink = getSink()
  const cur = normalizeLevel(level, envLogLevel())
  const prefix = tag ? `[${String(tag)}] ` : ""
  const should = (lvl) => lvl <= cur

  return {
    debug(msg, ...args) {
      if (!should(LEVEL.debug)) return
      sink.debug(prefix + String(msg), ...args)
    },
    info(msg, ...args) {
      if (!should(LEVEL.info)) return
      sink.info(prefix + String(msg), ...args)
    },
    warn(msg, ...args) {
      if (!should(LEVEL.warn)) return
      sink.warn(prefix + String(msg), ...args)
    },
    error(msg, ...args) {
      if (!should(LEVEL.error)) return
      sink.error(prefix + String(msg), ...args)
    }
  }
}
