import path from "node:path"
import { ProxyAgent } from "undici"

import { enka, paths } from "../config.js"
import { extractEnkaZzzAvatarList, enkaZzzToMysAvatars } from "../enka/zzz.js"
import { resolveEnkaUserAgent } from "../enka/headers.js"
import { appendJsonl, sleep, writeJson } from "../utils/fs.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { openScanDb } from "../db/sqlite.js"
import { loadAppConfig } from "../user-config.js"
import { createLogger } from "../utils/log.js"

const artisIdxMap = {
  EQUIP_BRACER: 1,
  EQUIP_NECKLACE: 2,
  EQUIP_SHOES: 3,
  EQUIP_RING: 4,
  EQUIP_DRESS: 5,
  生之花: 1,
  死之羽: 2,
  时之沙: 3,
  空之杯: 4,
  理之冠: 5
}

function makeAbortError() {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError()
}

function sleepAbortable(ms, signal) {
  const waitMs = Math.max(0, Number(ms) || 0)
  if (waitMs <= 0) return Promise.resolve()
  if (!signal) return sleep(waitMs)
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(makeAbortError())
    const onAbort = () => {
      clearTimeout(tid)
      reject(makeAbortError())
    }
    const tid = setTimeout(() => {
      try { signal.removeEventListener("abort", onAbort) } catch {}
      resolve()
    }, waitMs)
    try { signal.addEventListener("abort", onAbort, { once: true }) } catch {}
  })
}

function parseArgs(argv) {
  const args = {
    game: "gs",
    uids: [],
    uidStart: null,
    count: 10,
    maxCount: 20,
    delayMs: 20_000,
    jitterMs: 2_000,
    saveRaw: true,
    quiet: false,
    legacyConcurrency: null
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i]
    else if (a === "--uids") args.uids = (argv[++i] || "").split(/[,\s]+/).filter(Boolean)
    else if (a === "--uidStart") args.uidStart = Number(argv[++i])
    else if (a === "--count") args.count = Number(argv[++i])
    else if (a === "--maxCount") args.maxCount = Number(argv[++i])
    else if (a === "--delayMs") args.delayMs = Number(argv[++i])
    else if (a === "--jitterMs") args.jitterMs = Number(argv[++i])
    else if (a === "--concurrency") args.legacyConcurrency = Number(argv[++i])
    else if (a === "--no-raw") args.saveRaw = false
    else if (a === "--quiet") args.quiet = true
  }
  return args
}

function parseProxyUrls() {
  const raw = String(process.env.PROXY_URLS || "").trim()
  if (!raw) return []
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function envBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === "") return fallback
  if ([ "1", "true", "yes", "y", "on" ].includes(String(raw).toLowerCase())) return true
  if ([ "0", "false", "no", "n", "off" ].includes(String(raw).toLowerCase())) return false
  return fallback
}

function envNum(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function normalizeHttpProxyUrl(raw) {
  const s = String(raw || "").trim()
  if (!s) return ""
  if (s.includes("://")) return s
  return `http://${s}`
}

function createHttpProxyAgent(httpProxy) {
  const normalized = normalizeHttpProxyUrl(httpProxy)
  if (!normalized) return null
  try {
    return new ProxyAgent(normalized)
  } catch {
    return null
  }
}

function randJitter(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (!n) return 0
  return Math.floor(Math.random() * n)
}

function looksLikeHtml(text, contentType = "") {
  const t = String(text || "").trimStart()
  if (!t) return false
  if (/text\/html/i.test(String(contentType || ""))) return true
  return t.startsWith("<") || /<html/i.test(t.slice(0, 200))
}

function looksLikeJson(text) {
  const t = String(text || "").trimStart()
  return t.startsWith("{") || t.startsWith("[")
}

function pickWeapon(equipList = [], weaponById = {}) {
  for (const item of equipList) {
    if (item?.flat?.itemType !== "ITEM_WEAPON") continue
    const weapon = item.weapon || {}
    const affixRaw = Number((Object.values(weapon.affixMap || {}) as any)[0] || 0) || 0
    const meta = weaponById[item.itemId]
    return {
      id: item.itemId,
      name: meta?.name || "",
      level: weapon.level || 1,
      promote: weapon.promoteLevel || 0,
      affix: affixRaw + 1
    }
  }
  return null
}

function pickArtifacts(equipList = [], artifactPieceById) {
  const ret = {}
  for (const item of equipList) {
    if (item?.flat?.itemType !== "ITEM_RELIQUARY") continue
    const idx = artisIdxMap[item?.flat?.equipType]
    if (!idx) continue
    const meta = artifactPieceById.get(item.itemId)
    const re = item.reliquary || {}
    const level = Math.min(20, (re.level || 0) - 1)
    ret[idx] = {
      level,
      star: item?.flat?.rankLevel || 5,
      name: meta?.name || "",
      setName: meta?.setName || "",
      mainId: re.mainPropId,
      attrIds: re.appendPropIdList || []
    }
  }
  return ret
}

function pickWeaponSr(equipment: any = {}) {
  if (!equipment?.tid) return null
  return {
    id: equipment.tid,
    level: equipment.level || 1,
    promote: equipment.promotion || 0,
    affix: equipment.rank || 1
  }
}

function pickArtifactsSr(relicList = []) {
  const ret = {}
  for (const item of relicList) {
    const idx = Number(item?.type)
    if (!idx) continue
    const sub = Array.isArray(item?.subAffixList) ? item.subAffixList : []
    const attrIds = sub
      .map((s) => {
        const affixId = Number(s?.affixId)
        const cnt = Number(s?.cnt)
        const step = Number.isFinite(Number(s?.step)) ? Number(s.step) : 0
        if (!Number.isFinite(affixId) || !Number.isFinite(cnt)) return null
        return `${affixId},${cnt},${step}`
      })
      .filter(Boolean)

    ret[idx] = {
      level: Math.min(15, Number(item?.level) || 0),
      star: 5,
      id: Number(item?.tid) || 0,
      mainId: Number(item?.mainAffixId) || 0,
      attrIds
    }
  }
  return ret
}

class FetchError extends Error {
  status: number | null
  kind: string
  retryAfterMs: number | null

  constructor(message, { status = null, kind = "http", retryAfterMs = null }: any = {}) {
    super(message)
    this.name = "FetchError"
    this.status = status
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

class AdaptiveConcurrencyController {
  min: number
  getMax: () => number
  current: number
  backoffLevel: number
  backoffUntil: number
  lastAdjustAt: number
  quiet: boolean
  log: any
  onUpdate: ((snap: any) => void) | null

  constructor({ min = 1, getMax, quiet = false, log, onUpdate }: any = {}) {
    this.min = Math.max(1, Number(min) || 1)
    this.getMax = typeof getMax === "function" ? getMax : (() => 1)
    this.current = this.min
    this.backoffLevel = 0
    this.backoffUntil = 0
    this.lastAdjustAt = 0
    this.quiet = Boolean(quiet)
    this.log = log
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : null
  }

  snapshot() {
    const max = Math.max(this.min, Number(this.getMax()) || 1)
    return {
      current: this.current,
      max,
      backoffLevel: this.backoffLevel,
      backoffUntil: this.backoffUntil
    }
  }

  clamp() {
    const max = Math.max(this.min, Number(this.getMax()) || 1)
    this.current = Math.max(this.min, Math.min(this.current, max))
    this.onUpdate?.(this.snapshot())
    return { min: this.min, max, current: this.current }
  }

  async waitIfBackoff({ signal }: any = {}) {
    const now = Date.now()
    const waitMs = Math.max(0, Number(this.backoffUntil || 0) - now)
    if (waitMs > 0) await sleepAbortable(waitMs, signal)
  }

  onSuccess() {
    const { max } = this.clamp()
    const now = Date.now()
    if (this.backoffLevel > 0 && now >= this.backoffUntil) this.backoffLevel = Math.max(0, this.backoffLevel - 1)
    if (now - this.lastAdjustAt >= 1500 && this.current < max) {
      this.current++
      this.lastAdjustAt = now
      if (!this.quiet) this.log?.debug?.(`自适应并发：increase -> ${this.current}/${max}`)
    }
    this.onUpdate?.(this.snapshot())
  }

  onTransientError() {
    const { min, max } = this.clamp()
    const now = Date.now()
    if (now - this.lastAdjustAt >= 1500 && this.current > min) {
      this.current--
      this.lastAdjustAt = now
      if (!this.quiet) this.log?.debug?.(`自适应并发：decrease -> ${this.current}/${max}`)
    }
    this.onUpdate?.(this.snapshot())
  }

  on429({ baseMs = 30_000, maxMs = 10 * 60_000 } = {}) {
    const { min, max } = this.clamp()
    const now = Date.now()
    this.backoffLevel = Math.min(10, this.backoffLevel + 1)
    const ms = Math.min(maxMs, Math.max(1000, Number(baseMs) || 30_000) * Math.pow(2, this.backoffLevel - 1))
    this.backoffUntil = now + ms + randJitter(1000)
    this.current = min
    this.lastAdjustAt = now
    if (!this.quiet) this.log?.warn?.(`触发退避：429 backoffLevel=${this.backoffLevel} waitMs≈${ms} 并发=${this.current}/${max}`)
    this.onUpdate?.(this.snapshot())
  }
}

async function fetchEnkaJson({ url, dispatcher, timeoutMs, ua }) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 15_000))
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        "user-agent": ua,
        accept: "application/json,*/*"
      }
    })
    const text = await res.text().catch(() => "")
    const ct = String(res.headers.get("content-type") || "")
    const html = looksLikeHtml(text, ct)

    if (!res.ok) {
      const ra = res.headers.get("retry-after")
      const retryAfterMs = ra && Number.isFinite(Number(ra)) ? Math.max(0, Number(ra) * 1000) : null
      throw new FetchError(`HTTP ${res.status}: ${String(text || "").slice(0, 200)}`, { status: res.status, kind: html ? "html" : "http", retryAfterMs })
    }
    if (html || !looksLikeJson(text)) {
      throw new FetchError("HTML/WAF response", { status: res.status, kind: "html" })
    }

    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw new FetchError(`invalid json: ${e?.message || String(e)}`, { status: res.status, kind: "invalid_json" })
    }
    return { data, text }
  } catch (e) {
    if (e?.name === "AbortError") throw new FetchError("timeout", { status: null, kind: "timeout" })
    if (e instanceof FetchError) throw e
    throw new FetchError(e?.message || String(e), { status: null, kind: "transport" })
  } finally {
    clearTimeout(tid)
  }
}

export async function cmdSampleCollect(argv, options: any = {}) {
  const args = parseArgs(argv)
  const log = createLogger("采样")
  if (![ "gs", "sr", "zzz" ].includes(args.game)) throw new Error(`仅支持 --game gs|sr|zzz（收到：${args.game}）`)

  const signal = options?.signal
  const onRecent = typeof options?.onRecent === "function" ? options.onRecent : null
  const onAdaptive = typeof options?.onAdaptive === "function" ? options.onAdaptive : null

  const scanDb = openScanDb()
  const { data: cfg } = loadAppConfig({ ensureUser: false })

  const storeRawDb = cfg?.samples?.enka?.storeRawDb ?? true
  const noProxyDelayMsCfg = cfg?.samples?.enka?.noProxyDelayMs ?? 20_000
  const noProxyDelayMs = Math.max(0, envNum("ENKA_NO_PROXY_DELAY_MS", Number(noProxyDelayMsCfg) || 0))
  const breakerMaxConsecutiveFails = Number(cfg?.samples?.enka?.circuitBreaker?.maxConsecutiveFails ?? 5)
  const breakerOn429 = Boolean(cfg?.samples?.enka?.circuitBreaker?.breakOn429 ?? true)
  const quiet = Boolean(args.quiet || envBool("QUIET", false))
  const enkaTimeoutMs = Math.max(0, envNum("ENKA_TIMEOUT_MS", Number(cfg?.samples?.enka?.timeoutMs || 0)))

  const proxyRequired = envBool("PROXY_REQUIRED", Boolean(cfg?.proxy?.required ?? false))
  const maxProxyConsecutiveFailsCfg = Number(cfg?.proxy?.subscription?.maxConsecutiveFails ?? cfg?.proxy?.subscription?.maxConsecFails ?? 10)
  const maxProxyConsecutiveFails = Math.max(1, Math.min(200, envNum("PROXY_MAX_CONSEC_FAILS", maxProxyConsecutiveFailsCfg)))

  if (!quiet && args.legacyConcurrency != null) {
    log.warn(`参数已废弃：--concurrency=${args.legacyConcurrency}（已改为自适应并发 + 指数退避，忽略该参数）`)
  }

  const writeLocks = new Map()
  const appendJsonlSafe = async (filePath, obj) => {
    const prev = writeLocks.get(filePath) || Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => appendJsonl(filePath, obj))
    writeLocks.set(filePath, next)
    await next
  }

  try {
    let uidList = []
    if (args.uids.length > 0) {
      uidList = args.uids.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    } else if (args.uidStart && args.count) {
      const effectiveCount = Number.isFinite(args.maxCount) && args.maxCount > 0
        ? Math.min(args.count, args.maxCount)
        : args.count
      uidList = Array.from({ length: effectiveCount }, (_, i) => args.uidStart + i)
    } else {
      throw new Error("参数错误：请提供 --uids 或 --uidStart + --count")
    }
    if (uidList.length > args.maxCount) {
      uidList = uidList.slice(0, args.maxCount)
      log.warn(`UID 列表已截断：maxCount=${args.maxCount}`)
    }

    const meta = args.game === "sr" ? await loadSrMeta() : (args.game === "gs" ? await loadGsMeta() : null)

    let stop = false
    let consecutiveFails = 0
    let idx = 0

    const summary = {
      game: args.game,
      total: uidList.length,
      ok: 0,
      skipped: 0,
      permanent: 0,
      byStatus: {},
      transport: 0,
      html: 0
    }

    const processFetched = async (uid, data, text) => {
      if (args.saveRaw) {
        const rawPath = path.join(paths.rawDir(args.game), `${uid}.json`)
        await writeJson(rawPath, data, 0)
      }
      scanDb.recordSuccess(uid, { game: args.game, status: 200, bodyText: text, storeRaw: storeRawDb })

      if (args.game === "gs") {
        const avatarList = data?.avatarInfoList || []
        for (const ds of avatarList) {
          const charId = ds.avatarId
          const charMeta = meta.character.byId[charId] || {}
          const weapon = pickWeapon(ds.equipList || [], meta.weapon.byId)
          const artis = pickArtifacts(ds.equipList || [], meta.artifact.artifactPieceById)
          const hasFive = [ 1, 2, 3, 4, 5 ].every((k) => artis[k]?.mainId && (artis[k]?.attrIds?.length || 0) > 0)
          if (!hasFive) continue

          const rec = {
            uid,
            fetchedAt: Date.now(),
            charId,
            charName: charMeta.name || "",
            elem: charMeta.elem || "",
            weapon,
            artis
          }
          const outPath = path.join(paths.samplesDir("gs"), `${charId}.jsonl`)
          await appendJsonlSafe(outPath, rec)
        }
        return
      }

      if (args.game === "sr") {
        const avatarList = data?.detailInfo?.avatarDetailList || []
        for (const ds of avatarList) {
          const charId = Number(ds?.avatarId)
          if (!Number.isFinite(charId)) continue
          const charMeta = meta.character.byId[charId] || {}
          const weapon = pickWeaponSr(ds?.equipment || {})
          const artis = pickArtifactsSr(ds?.relicList || [])
          const hasSix = [ 1, 2, 3, 4, 5, 6 ].every((k) => artis[k]?.id && artis[k]?.mainId && (artis[k]?.attrIds?.length || 0) > 0)
          if (!hasSix) continue

          const rec = {
            uid,
            fetchedAt: Date.now(),
            charId,
            charName: charMeta.name || "",
            elem: charMeta.elem || "",
            weapon,
            artis
          }
          const outPath = path.join(paths.samplesDir("sr"), `${charId}.jsonl`)
          await appendJsonlSafe(outPath, rec)
        }
        return
      }

      const enkaAvatarList = extractEnkaZzzAvatarList(data)
      const mysAvatars = await enkaZzzToMysAvatars(enkaAvatarList)
      for (const a of mysAvatars) {
        const charId = Number(a?.id)
        if (!Number.isFinite(charId)) continue
        const equip = Array.isArray(a?.equip) ? a.equip : []
        if (equip.length < 6) continue
        const rec = {
          uid,
          fetchedAt: Date.now(),
          charId,
          charName: String(a?.name_mi18n || a?.full_name_mi18n || ""),
          // Keep full mys avatar fields (properties/skills/ranks...), so ZZZ-Plugin can score/render normally.
          avatar: a
        }
        const outPath = path.join(paths.samplesDir("zzz"), `${charId}.jsonl`)
        await appendJsonlSafe(outPath, rec)
      }
    }

    const proxyRateLimitMode = String(process.env.ENKA_PROXY_RATE_LIMIT || "").trim().toLowerCase() === "sqlite" ? "sqlite" : "mem"
    const baseDelayMs = Math.max(0, Number(args.delayMs) || 0)
    const jitterMs = Math.max(0, Number(args.jitterMs) || 0)
    const ua = (await resolveEnkaUserAgent(args.game)) || enka.userAgent
    const timeoutMs = Math.max(1, (enkaTimeoutMs > 0 ? enkaTimeoutMs : enka.timeoutMs))

    const proxyStates: any[] = []
    const proxyStateByUrl = new Map<string, any>()
    let proxyUrlsSnapshot: string[] = []

    const refreshProxyStates = () => {
      const urls = parseProxyUrls().map(normalizeHttpProxyUrl).filter(Boolean)
      const same = urls.length === proxyUrlsSnapshot.length && urls.every((u, i) => u === proxyUrlsSnapshot[i])
      if (same) return
      proxyUrlsSnapshot = urls
      proxyStates.length = 0
      for (const url of urls) {
        const prev = proxyStateByUrl.get(url) || {}
        const dispatcher = createHttpProxyAgent(url)
        const st = {
          url,
          dispatcher,
          nextAt: Number(prev.nextAt || 0) || 0,
          disabledUntil: Number(prev.disabledUntil || 0) || 0,
          consecutiveTransportFails: Number(prev.consecutiveTransportFails || 0) || 0
        }
        proxyStates.push(st)
        proxyStateByUrl.set(url, st)
      }
    }
    refreshProxyStates()
    if (proxyRequired && proxyStates.length === 0) {
      throw new Error("需要代理(PROXY_REQUIRED=1 / proxy.required=true)，但 PROXY_URLS 为空")
    }

    const adaptive = new AdaptiveConcurrencyController({
      min: 1,
      quiet,
      log,
      onUpdate: onAdaptive,
      getMax: () => {
        const now = Date.now()
        const usable = proxyStates.filter((p) => p.dispatcher && (!p.disabledUntil || p.disabledUntil <= now)).length
        return Math.max(1, usable || (proxyStates.length ? 1 : 1))
      }
    })

    const pickProxyIndex = (startIdx = 0) => {
      const n = proxyStates.length
      if (!n) return null
      const now = Date.now()
      for (let i = 0; i < n; i++) {
        const idx = (startIdx + i) % n
        const st = proxyStates[idx]
        if (!st?.dispatcher) continue
        if (st.disabledUntil && st.disabledUntil > now) continue
        return idx
      }
      return null
    }

    let globalNoProxyNextAt = 0
    const waitTurn = async (bucket) => {
      throwIfAborted(signal)
      const now = Date.now()
      if (!proxyStates.length) {
        const waitMs = Math.max(0, globalNoProxyNextAt - now)
        globalNoProxyNextAt = Math.max(globalNoProxyNextAt, now) + baseDelayMs + randJitter(jitterMs)
        if (waitMs > 0) await sleepAbortable(waitMs, signal)
        return
      }

      const st = proxyStates[bucket]
      if (!st) return
      const waitMs = Math.max(0, Number(st.nextAt || 0) - now)
      st.nextAt = Math.max(st.nextAt || 0, now) + baseDelayMs + randJitter(jitterMs)
      if (waitMs > 0) await sleepAbortable(waitMs, signal)
    }

    const fetchEnka = async (uid, { dispatcher }: any = {}) => {
      const base = String(enka.baseUrl || "https://enka.network/").replace(/\/+$/, "") + "/"
      const url =
        args.game === "sr"
          ? `${base}api/hsr/uid/${uid}`
          : (args.game === "zzz" ? `${base}api/zzz/uid/${uid}` : `${base}api/uid/${uid}`)

      try {
        return await fetchEnkaJson({ url, dispatcher, timeoutMs, ua })
      } catch (e) {
        // ZZZ fallback domain (best-effort).
        if (args.game === "zzz" && (e?.kind === "transport" || e?.kind === "timeout")) {
          const fallbackBase = "https://profile.microgg.cn/"
          const url2 = `${fallbackBase}api/zzz/uid/${uid}`
          return await fetchEnkaJson({ url: url2, dispatcher, timeoutMs, ua })
        }
        throw e
      }
    }

    const runOne = async (pos, uid, workerState) => {
      throwIfAborted(signal)
      refreshProxyStates()
      adaptive.clamp()

      const skip = scanDb.shouldSkipUid(uid, { game: args.game })
      if (skip.skip) {
        summary.skipped++
        if (!quiet) log.info(`[${pos}/${uidList.length}] 跳过 uid=${uid} (${skip.reason})`)
        return
      }

      let bucket = 0
      let dispatcher = undefined
      if (proxyStates.length) {
        const picked = pickProxyIndex(workerState?.proxyIdx ?? 0)
        if (picked == null) {
          if (proxyRequired) {
            stop = true
            log.warn("需要代理(PROXY_REQUIRED=1)，但当前无可用代理；提前结束。")
            return
          }
          dispatcher = undefined
          bucket = 0
        } else {
          workerState.proxyIdx = picked
          bucket = picked
          dispatcher = proxyStates[picked]?.dispatcher
        }
      }

      await adaptive.waitIfBackoff({ signal })

      if (dispatcher && proxyRateLimitMode === "sqlite" && typeof scanDb.reserveRateLimit === "function") {
        const intervalMs = baseDelayMs + randJitter(jitterMs)
        const key = `enka:proxy:${proxyStates[bucket]?.url || bucket}`
        const { waitMs } = scanDb.reserveRateLimit(key, intervalMs)
        if (waitMs > 0) await sleepAbortable(waitMs, signal)
      } else if (!dispatcher && noProxyDelayMs > 0 && typeof scanDb.reserveRateLimit === "function") {
        const intervalMs = Math.max(0, baseDelayMs, noProxyDelayMs)
        const { waitMs } = scanDb.reserveRateLimit("enka:no-proxy:global", intervalMs)
        if (waitMs > 0) await sleepAbortable(waitMs, signal)
      } else {
        await waitTurn(bucket)
      }

      if (!quiet) {
        log.info(`[${pos}/${uidList.length}] fetch uid=${uid}${dispatcher ? ` proxy=${bucket + 1}/${proxyStates.length}` : ""} cc=${adaptive.current}`)
      }

      try {
        const { data, text } = await fetchEnka(uid, { dispatcher })
        consecutiveFails = 0
        summary.ok++
        onRecent?.("ok")
        if (dispatcher && bucket >= 0 && bucket < proxyStates.length) {
          proxyStates[bucket].consecutiveTransportFails = 0
        }
        await processFetched(uid, data, text)
        adaptive.onSuccess()
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) throw makeAbortError()
        const e = err instanceof FetchError ? err : new FetchError(err?.message || String(err), { status: null, kind: "transport" })
        const msg = e?.message || String(e)

        const breakerEnabled = !dispatcher

        const markProxyTransportFail = () => {
          if (!dispatcher) return
          if (bucket < 0 || bucket >= proxyStates.length) return
          const st = proxyStates[bucket]
          st.consecutiveTransportFails++
          if (st.consecutiveTransportFails >= maxProxyConsecutiveFails) {
            st.disabledUntil = Date.now() + Math.max(60_000, baseDelayMs * 5)
            log.warn(`代理禁用：${bucket + 1}/${proxyStates.length} url=${st.url} consecutiveFails=${st.consecutiveTransportFails}`)
            workerState.proxyIdx = (bucket + 1) % proxyStates.length
          }
        }

        if (e.status != null) {
          const status = Number(e.status)
          summary.byStatus[String(status)] = (summary.byStatus[String(status)] || 0) + 1

          if (status === 400 || status === 404) {
            scanDb.markPermanent(uid, { game: args.game, status })
            summary.permanent++
            onRecent?.("permanent")
            if (!quiet) log.warn(`永久跳过：uid=${uid} status=${status}`)
            adaptive.onTransientError()
            return
          }

          if (status === 429) {
            onRecent?.("http429")
            const retryAfterMs = Math.max(5 * 60_000, baseDelayMs * 10, Number(e.retryAfterMs || 0))
            scanDb.recordFailure(uid, { game: args.game, status, error: msg, retryAfterMs })
            if (dispatcher && bucket >= 0 && bucket < proxyStates.length) {
              proxyStates[bucket].disabledUntil = Date.now() + Math.max(60_000, retryAfterMs)
              log.warn(`429：代理禁用 ${bucket + 1}/${proxyStates.length} url=${proxyStates[bucket].url} retryAfterMs=${retryAfterMs}`)
              workerState.proxyIdx = (bucket + 1) % proxyStates.length
            }
            if (breakerEnabled && breakerOn429) stop = true
            adaptive.on429({ baseMs: Math.max(30_000, baseDelayMs * 2) })
            return
          }

          if (e.kind === "html") {
            summary.html++
            onRecent?.("htmlWaf")
          } else if (e.kind === "invalid_json") {
            onRecent?.("invalidJson")
          } else {
            onRecent?.("httpError")
          }
          scanDb.recordFailure(uid, { game: args.game, status, error: msg })
          if (!quiet) log.warn(`失败：uid=${uid} status=${status} ${msg}`)
          if (breakerEnabled) consecutiveFails++
          if (breakerEnabled && breakerMaxConsecutiveFails > 0 && consecutiveFails >= breakerMaxConsecutiveFails) {
            if (!quiet) log.warn(`熔断：maxConsecutiveFails=${breakerMaxConsecutiveFails}`)
            stop = true
          }
          adaptive.onTransientError()
          return
        }

        markProxyTransportFail()
        scanDb.recordFailure(uid, { game: args.game, status: null, error: msg })
        summary.transport++
        onRecent?.(e.kind === "timeout" ? "timeout" : "transport")
        if (!quiet) log.warn(`失败：uid=${uid} ${e.kind} ${msg}`)
        if (breakerEnabled) consecutiveFails++
        if (breakerEnabled && breakerMaxConsecutiveFails > 0 && consecutiveFails >= breakerMaxConsecutiveFails) {
          if (!quiet) log.warn(`熔断：maxConsecutiveFails=${breakerMaxConsecutiveFails}`)
          stop = true
        }
        adaptive.onTransientError()
      }
    }

    const maxWorkers = 50
    const workers = Array.from({ length: maxWorkers }, (_, workerIdx) => (async () => {
      const workerState = { proxyIdx: proxyStates.length ? (workerIdx % Math.max(1, proxyStates.length)) : 0 }
      while (!stop) {
        throwIfAborted(signal)
        // If all UIDs have been assigned to workers, exit even when this worker is above the current concurrency limit.
        // Otherwise Promise.all(workers) would hang forever.
        if (idx >= uidList.length) return
        refreshProxyStates()
        adaptive.clamp()
        if (workerIdx >= adaptive.current) {
          await sleepAbortable(200, signal)
          continue
        }
        const cur = idx++
        if (cur >= uidList.length) return
        const uid = uidList[cur]
        await runOne(cur + 1, uid, workerState)
      }
    })())

    await Promise.all(workers)
    await Promise.allSettled([ ...writeLocks.values() ])

    if (quiet) {
      log.info(`[done] game=${summary.game} total=${summary.total} ok=${summary.ok} skipped=${summary.skipped} permanent=${summary.permanent} transport=${summary.transport} html=${summary.html}`)
      log.info(`[done] byStatus=${JSON.stringify(summary.byStatus)}`)
    } else {
      log.info("done.")
    }
  } finally {
    scanDb.close()
  }
}
