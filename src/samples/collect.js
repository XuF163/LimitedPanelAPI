import path from "node:path"
import { paths } from "../config.js"
import { fetchEnkaGs } from "../enka/gs.js"
import { appendJsonl, sleep, writeJson } from "../utils/fs.js"
import { loadGsMeta } from "../meta/gs.js"

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
    saveRaw: true
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--game") args.game = argv[++i]
    else if (a === "--uids") args.uids = (argv[++i] || "").split(/[,\\s]+/).filter(Boolean)
    else if (a === "--uidStart") args.uidStart = Number(argv[++i])
    else if (a === "--count") args.count = Number(argv[++i])
    else if (a === "--maxCount") args.maxCount = Number(argv[++i])
    else if (a === "--delayMs") args.delayMs = Number(argv[++i])
    else if (a === "--jitterMs") args.jitterMs = Number(argv[++i])
    else if (a === "--no-raw") args.saveRaw = false
  }
  return args
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

export async function cmdSampleCollect(argv) {
  const args = parseArgs(argv)
  if (args.game !== "gs") throw new Error("Only --game gs is supported for now")

  let uidList = []
  if (args.uids.length > 0) {
    uidList = args.uids.map((v) => Number(v)).filter((v) => Number.isFinite(v))
  } else if (args.uidStart && args.count) {
    uidList = Array.from({ length: args.count }, (_, i) => args.uidStart + i)
  } else {
    throw new Error("Provide --uids or --uidStart + --count")
  }
  if (uidList.length > args.maxCount) {
    uidList = uidList.slice(0, args.maxCount)
    console.log(`UID list truncated to maxCount=${args.maxCount}`)
  }

  const meta = await loadGsMeta()

  for (let i = 0; i < uidList.length; i++) {
    const uid = uidList[i]
    console.log(`[${i + 1}/${uidList.length}] fetch uid=${uid}`)
    let data
    try {
      data = await fetchEnkaGs(uid)
    } catch (err) {
      console.warn(`  fetch failed: ${err?.message || err}`)
      continue
    }

    if (args.saveRaw) {
      const rawPath = path.join(paths.rawDir("gs"), `${uid}.json`)
      await writeJson(rawPath, data, 0)
    }

    const avatarList = data?.avatarInfoList || []
    for (const ds of avatarList) {
      const charId = ds.avatarId
      const charMeta = meta.character.byId[charId] || {}
      const weapon = pickWeapon(ds.equipList || [], meta.weapon.byId)
      const artis = pickArtifacts(ds.equipList || [], meta.artifact.artifactPieceById)
      const hasFive = [1,2,3,4,5].every((k) => artis[k]?.name && artis[k]?.mainId && (artis[k]?.attrIds?.length || 0) > 0)
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
      await appendJsonl(outPath, rec)
    }

    const delay = args.delayMs + Math.floor(Math.random() * (args.jitterMs || 0))
    if (i !== uidList.length - 1) {
      console.log(`  sleep ${delay}ms`)
      await sleep(delay)
    }
  }

  console.log("done.")
}

