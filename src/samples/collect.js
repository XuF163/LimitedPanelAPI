import path from "node:path"
import { paths } from "../config.js"
import { EnkaHttpError as EnkaHttpErrorGs, fetchEnkaGs } from "../enka/gs.js"
import { EnkaHttpError as EnkaHttpErrorSr, fetchEnkaSr } from "../enka/sr.js"
import { EnkaHttpError as EnkaHttpErrorZzz, fetchEnkaZzz, extractEnkaZzzAvatarList, enkaZzzToMysAvatars } from "../enka/zzz.js"
import { appendJsonl, sleep, writeJson } from "../utils/fs.js"
import { loadGsMeta } from "../meta/gs.js"
import { loadSrMeta } from "../meta/sr.js"
import { openScanDb } from "../db/sqlite.js"
import { loadAppConfig } from "../user-config.js"
import { ProxyAgent } from "undici"

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

function parseArgs(argv) {
  const args = {
    game: "gs",
    uids: [],
    uidStart: null,
    count: 10,
    maxCount: 20,
    delayMs: 30_000,
    jitterMs: 2_000,
    saveRaw: true,
    concurrency: 1,
    quiet: false
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
    else if (a === "--concurrency") args.concurrency = Number(argv[++i])
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

function pickWeapon(equipList = [], weaponById = {}) {
  for (const item of equipList) {
    if (item?.flat?.itemType !== "ITEM_WEAPON") continue
    const weapon = item.weapon || {}
    const affixRaw = Object.values(weapon.affixMap || {})[0] || 0
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

function pickWeaponSr(equipment = {}) {
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

export async function cmdSampleCollect(argv) {
  const args = parseArgs(argv)
  if (!["gs", "sr", "zzz"].includes(args.game)) throw new Error(`Only --game gs|sr|zzz is supported for now (got: ${args.game})`)

  const scanDb = openScanDb()
  const { data: cfg } = loadAppConfig({ ensureUser: false })
  const storeRawDb = cfg?.samples?.enka?.storeRawDb ?? true
  const breakerMaxConsecutiveFails = Number(cfg?.samples?.enka?.circuitBreaker?.maxConsecutiveFails ?? 5)
  const breakerOn429 = Boolean(cfg?.samples?.enka?.circuitBreaker?.breakOn429 ?? true)
  const quiet = Boolean(args.quiet || envBool("QUIET", false))
  const enkaTimeoutMs = Math.max(0, envNum("ENKA_TIMEOUT_MS", Number(cfg?.samples?.enka?.timeoutMs || 0)))

  const concurrency = Math.max(1, Math.min(50, Number(args.concurrency) || 1))

  const proxyUrls = parseProxyUrls()
  const proxyDispatchers = proxyUrls.map((u) => new ProxyAgent(u))
  const proxyStates = proxyDispatchers.map((dispatcher, i) => ({
    i,
    url: proxyUrls[i],
    dispatcher,
    disabled: false,
    consecutiveTransportFails: 0
  }))
  const proxyRequired = envBool("PROXY_REQUIRED", Boolean(cfg?.proxy?.required ?? false))
  const maxProxyConsecutiveFailsCfg = Number(cfg?.proxy?.subscription?.maxConsecutiveFails ?? cfg?.proxy?.subscription?.maxConsecFails ?? 10)
  const maxProxyConsecutiveFails = Math.max(1, Math.min(200, envNum("PROXY_MAX_CONSEC_FAILS", maxProxyConsecutiveFailsCfg)))
  const buckets = Math.max(1, proxyDispatchers.length || 1)

  const pickProxyIndex = (startIdx = 0) => {
    if (!proxyStates.length) return null
    const start = Math.max(0, Math.min(proxyStates.length - 1, Number(startIdx) || 0))
    for (let step = 0; step < proxyStates.length; step++) {
      const idx = (start + step) % proxyStates.length
      const st = proxyStates[idx]
      if (!st.disabled) return idx
    }
    return null
  }

  const waitTurn = (() => {
    const baseDelayMs = Number(args.delayMs) || 0
    const jitterMs = Math.max(0, Number(args.jitterMs) || 0)
    const nextAt = Array.from({ length: buckets }, () => 0)
    return async (bucket = 0) => {
      if (baseDelayMs <= 0 && jitterMs <= 0) return
      const now = Date.now()
      const b = Math.max(0, Math.min(buckets - 1, Number(bucket) || 0))
      const wait = Math.max(0, nextAt[b] - now)
      nextAt[b] = Math.max(nextAt[b], now) + baseDelayMs + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0)
      if (wait > 0) await sleep(wait)
    }
  })()

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
      throw new Error("Provide --uids or --uidStart + --count")
    }
    if (uidList.length > args.maxCount) {
      uidList = uidList.slice(0, args.maxCount)
      console.log(`UID list truncated to maxCount=${args.maxCount}`)
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

    const runOne = async (pos, uid, workerState) => {
      const skip = scanDb.shouldSkipUid(uid, { game: args.game })
      if (skip.skip) {
        summary.skipped++
        if (!quiet) console.log(`[${pos}/${uidList.length}] skip uid=${uid} (${skip.reason})`)
        return
      }

      let bucket = 0
      let dispatcher
      if (proxyStates.length) {
        const picked = pickProxyIndex(workerState.proxyIdx ?? 0)
        if (picked == null) {
          if (proxyRequired) {
            stop = true
            console.warn("All proxies disabled/unavailable (PROXY_REQUIRED=1); stop scanning early.")
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
      await waitTurn(bucket)

      if (!quiet) {
        console.log(`[${pos}/${uidList.length}] fetch uid=${uid}${proxyStates.length ? ` proxy=${bucket + 1}/${proxyStates.length}` : ""}`)
      }
      let data
      let text
      try {
        const fetchOpts = {
          ...(dispatcher ? { dispatcher } : {}),
          ...(enkaTimeoutMs > 0 ? { timeoutMs: enkaTimeoutMs } : {})
        }
        const ret = args.game === "sr"
          ? await fetchEnkaSr(uid, fetchOpts)
          : (args.game === "zzz" ? await fetchEnkaZzz(uid, fetchOpts) : await fetchEnkaGs(uid, fetchOpts))
        data = ret.data
        text = ret.text
        consecutiveFails = 0
        summary.ok++
        if (proxyStates.length && bucket < proxyStates.length) {
          proxyStates[bucket].consecutiveTransportFails = 0
        }
      } catch (err) {
        const markProxyTransportFail = () => {
          if (!proxyStates.length) return
          if (bucket < 0 || bucket >= proxyStates.length) return
          const st = proxyStates[bucket]
          st.consecutiveTransportFails++
          if (st.consecutiveTransportFails >= maxProxyConsecutiveFails) {
            st.disabled = true
            console.warn(`  proxy disabled: ${bucket + 1}/${proxyStates.length} url=${st.url} consecutiveFails=${st.consecutiveTransportFails}`)
            // Switch to next proxy for this worker on next request.
            if (workerState) workerState.proxyIdx = (bucket + 1) % proxyStates.length
          }
        }

        // Treat UID format / non-exist as permanent invalid.
         if (err instanceof EnkaHttpErrorGs || err instanceof EnkaHttpErrorSr || err instanceof EnkaHttpErrorZzz) {
           const bodyShort = String(err.body || "").slice(0, 300)
           const msg = bodyShort ? `${err.message}: ${bodyShort}` : err.message
           const bodyTrim = String(err.body || "").trim()
           const bodyIsHtml = bodyTrim.startsWith("<")
          // If upstream returns HTML (WAF/ban page) via proxy, treat as proxy transport failure.
          // IMPORTANT: do NOT mark UID as permanent in this case (it is likely a proxy/WAF issue, not an invalid UID).
          if (bodyIsHtml) {
            markProxyTransportFail()
            scanDb.recordFailure(uid, { game: args.game, status: err.status, error: msg })
            summary.html++
            summary.byStatus[String(err.status)] = (summary.byStatus[String(err.status)] || 0) + 1
            if (!quiet) console.warn(`  fetch failed: ${msg} (html)`)
            consecutiveFails++
            if (breakerMaxConsecutiveFails > 0 && consecutiveFails >= breakerMaxConsecutiveFails) {
              if (!quiet) console.warn(`  circuit breaker: maxConsecutiveFails=${breakerMaxConsecutiveFails}`)
              stop = true
            }
            return
          }
          if (err.status === 400 || err.status === 404) {
            scanDb.markPermanent(uid, { game: args.game, status: err.status, error: msg })
            summary.permanent++
            summary.byStatus[String(err.status)] = (summary.byStatus[String(err.status)] || 0) + 1
            if (!quiet) console.warn(`  fetch failed: ${msg} (permanent)`)
            return
          }
          // 403 is usually permanent (private / forbidden) and retrying won't help.
          if (err.status === 403) {
            scanDb.markPermanent(uid, { game: args.game, status: err.status, error: msg })
            summary.permanent++
            summary.byStatus[String(err.status)] = (summary.byStatus[String(err.status)] || 0) + 1
            if (!quiet) console.warn(`  fetch failed: ${msg} (permanent)`)
            return
          }
          // 429: backoff more aggressively.
          if (err.status === 429) {
            scanDb.recordFailure(uid, { game: args.game, status: err.status, error: msg, retryAfterMs: Math.max(5 * 60_000, args.delayMs * 10) })
            summary.byStatus[String(err.status)] = (summary.byStatus[String(err.status)] || 0) + 1
            if (!quiet) console.warn(`  fetch failed: ${msg} (rate limited)`)
            consecutiveFails++
            if (breakerOn429) {
              if (!quiet) console.warn(`  circuit breaker: break on 429`)
              stop = true
            }
            return
          }
          // 424/500/503 etc: transient, record and continue.
          scanDb.recordFailure(uid, { game: args.game, status: err.status, error: msg })
          summary.byStatus[String(err.status)] = (summary.byStatus[String(err.status)] || 0) + 1
          if (!quiet) console.warn(`  fetch failed: ${msg}`)
          consecutiveFails++
          if (breakerMaxConsecutiveFails > 0 && consecutiveFails >= breakerMaxConsecutiveFails) {
            if (!quiet) console.warn(`  circuit breaker: maxConsecutiveFails=${breakerMaxConsecutiveFails}`)
            stop = true
          }
          return
        }

        const msg = err?.stack || err?.message || String(err)
        // Transport errors are very likely proxy issues.
        markProxyTransportFail()
        scanDb.recordFailure(uid, { game: args.game, status: null, error: msg })
        summary.transport++
        if (!quiet) console.warn(`  fetch failed: ${msg}`)
        consecutiveFails++
        if (breakerMaxConsecutiveFails > 0 && consecutiveFails >= breakerMaxConsecutiveFails) {
          if (!quiet) console.warn(`  circuit breaker: maxConsecutiveFails=${breakerMaxConsecutiveFails}`)
          stop = true
        }
        return
      }

      if (args.saveRaw) {
        const rawPath = path.join(paths.rawDir(args.game), `${uid}.json`)
        await writeJson(rawPath, data, 0)
      }
      // Store raw to sqlite when enabled (gzip). This is the preferred storage for large-scale scans.
      scanDb.recordSuccess(uid, { game: args.game, status: 200, bodyText: text, storeRaw: storeRawDb })

      if (args.game === "gs") {
        const avatarList = data?.avatarInfoList || []
        for (const ds of avatarList) {
          const charId = ds.avatarId
          const charMeta = meta.character.byId[charId] || {}
          const weapon = pickWeapon(ds.equipList || [], meta.weapon.byId)
          const artis = pickArtifacts(ds.equipList || [], meta.artifact.artifactPieceById)
          const hasFive = [ 1, 2, 3, 4, 5 ].every((k) => artis[k]?.name && artis[k]?.mainId && (artis[k]?.attrIds?.length || 0) > 0)
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
      } else if (args.game === "sr") {
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
      } else {
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
            avatar: {
              id: a?.id,
              name_mi18n: a?.name_mi18n,
              full_name_mi18n: a?.full_name_mi18n,
              level: a?.level,
              element_type: a?.element_type,
              avatar_profession: a?.avatar_profession,
              rarity: a?.rarity,
              rank: a?.rank,
              weapon: a?.weapon || null,
              equip
            }
          }
          const outPath = path.join(paths.samplesDir("zzz"), `${charId}.jsonl`)
          await appendJsonlSafe(outPath, rec)
        }
      }
    }

    const workers = Array.from({ length: concurrency }, (_, workerIdx) => (async () => {
      const workerState = { proxyIdx: proxyStates.length ? (workerIdx % proxyStates.length) : 0 }
      while (!stop) {
        const cur = idx++
        if (cur >= uidList.length) return
        const uid = uidList[cur]
        await runOne(cur + 1, uid, workerState)
      }
    })())

    await Promise.all(workers)

    // Wait all queued writes.
    await Promise.allSettled([ ...writeLocks.values() ])

    if (quiet) {
      console.log(`[done] game=${summary.game} total=${summary.total} ok=${summary.ok} skipped=${summary.skipped} permanent=${summary.permanent} transport=${summary.transport}`)
      console.log(`[done] byStatus=${JSON.stringify(summary.byStatus)}`)
    } else {
      console.log("done.")
    }
  } finally {
    scanDb.close()
    for (const d of proxyDispatchers) {
      try { d.close?.() } catch {}
    }
  }
}

