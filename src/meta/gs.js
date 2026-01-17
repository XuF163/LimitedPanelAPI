import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { paths } from "../config.js"

const defaultWeaponTypes = [ "sword", "claymore", "polearm", "catalyst", "bow" ]

export async function loadGsMeta(metaRoot = paths.metaGs) {
  const artifactExtra = await import(pathToFileURL(path.join(metaRoot, "artifact", "extra.js")).href)
  const artifactMark = await import(pathToFileURL(path.join(metaRoot, "artifact", "artis-mark.js")).href)
  const artifactAlias = await import(pathToFileURL(path.join(metaRoot, "artifact", "alias.js")).href)

  const artifactDataPath = path.join(metaRoot, "artifact", "data.json")
  const characterDataPath = path.join(metaRoot, "character", "data.json")

  if (!fs.existsSync(artifactDataPath) || !fs.existsSync(characterDataPath)) {
    throw new Error(`Missing meta files under: ${metaRoot} (run meta:sync first)`)
  }

  const artifactData = JSON.parse(await fsp.readFile(artifactDataPath, "utf8"))
  const characterData = JSON.parse(await fsp.readFile(characterDataPath, "utf8"))

  const artifactPieceById = new Map()
  const artifactPieceByName = new Map()
  for (const setId of Object.keys(artifactData)) {
    const set = artifactData[setId]
    const setName = set?.name
    const idxs = set?.idxs || {}
    if (!setName) continue
    for (const idx of Object.keys(idxs)) {
      const piece = idxs[idx]
      if (!piece?.id || !piece?.name) continue
      const itemId = Number(piece.id)
      const entry = { itemId, name: piece.name, setName, idx: Number(idx) }
      artifactPieceById.set(itemId, entry)
      artifactPieceByName.set(piece.name, entry)
    }
  }

  const weaponById = {}
  for (const type of defaultWeaponTypes) {
    const p = path.join(metaRoot, "weapon", type, "data.json")
    if (!fs.existsSync(p)) continue
    const data = JSON.parse(await fsp.readFile(p, "utf8"))
    for (const [ id, ds ] of Object.entries(data || {})) {
      weaponById[Number(id)] = { ...ds, type }
    }
  }

  const maxAppendIdByKey = {}
  for (const [ id, ds ] of Object.entries(artifactExtra.attrIdMap || {})) {
    if (!id.startsWith("501")) continue
    const key = ds?.key
    if (!key) continue
    const prev = maxAppendIdByKey[key]
    if (!prev || ds.value > prev.value) {
      maxAppendIdByKey[key] = { id: Number(id), value: ds.value }
    }
  }

  const charDetailCache = new Map()
  const getCharDetailByName = async (name) => {
    if (charDetailCache.has(name)) return charDetailCache.get(name)
    const p = path.join(metaRoot, "character", name, "data.json")
    const data = fs.existsSync(p) ? JSON.parse(await fsp.readFile(p, "utf8")) : null
    charDetailCache.set(name, data)
    return data
  }

  const getCharArtisRule = async (name) => {
    const p = path.join(metaRoot, "character", name, "artis.js")
    if (!fs.existsSync(p)) return null
    const mod = await import(pathToFileURL(p).href)
    return mod?.default || null
  }

  return {
    game: "gs",
    metaRoot,
    artifact: {
      ...artifactExtra,
      usefulAttr: artifactMark.usefulAttr,
      setAbbr: artifactAlias.setAbbr || {},
      setAlias: artifactAlias.setAlias || {},
      artifactPieceById,
      artifactPieceByName,
      maxAppendIdByKey: Object.fromEntries(Object.entries(maxAppendIdByKey).map(([k, v]) => [ k, v.id ]))
    },
    character: {
      byId: characterData,
      getDetailByName: getCharDetailByName,
      getArtisRule: getCharArtisRule
    },
    weapon: {
      byId: weaponById
    }
  }
}

