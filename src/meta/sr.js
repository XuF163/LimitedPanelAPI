import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { paths } from "../config.js"

export async function loadSrMeta(metaRoot = paths.metaSr) {
  const artifactMeta = await import(pathToFileURL(path.join(metaRoot, "artifact", "meta.js")).href)
  const artifactMark = await import(pathToFileURL(path.join(metaRoot, "artifact", "artis-mark.js")).href)

  const artifactMetaJsonPath = path.join(metaRoot, "artifact", "meta.json")
  const characterDataPath = path.join(metaRoot, "character", "data.json")
  const weaponDataPath = path.join(metaRoot, "weapon", "data.json")

  if (!fs.existsSync(artifactMetaJsonPath) || !fs.existsSync(characterDataPath)) {
    throw new Error(`Missing meta files under: ${metaRoot} (run meta:sync first)`)
  }

  const artifactMetaJson = JSON.parse(await fsp.readFile(artifactMetaJsonPath, "utf8"))
  const characterData = JSON.parse(await fsp.readFile(characterDataPath, "utf8"))
  const weaponById = fs.existsSync(weaponDataPath) ? JSON.parse(await fsp.readFile(weaponDataPath, "utf8")) : {}

  const star5 = artifactMetaJson?.starData?.["5"] || artifactMetaJson?.starData?.[5] || null
  const subIdByKey = {}
  const subKeyById = {}
  for (const [ id, ds ] of Object.entries(star5?.sub || {})) {
    const key = ds?.key
    if (!key) continue
    subIdByKey[key] = Number(id)
    subKeyById[Number(id)] = key
  }

  return {
    game: "sr",
    metaRoot,
    artifact: {
      mainIdx: artifactMetaJson?.mainIdx || {},
      subAttr: artifactMeta.subAttr || [],
      usefulAttr: artifactMark.usefulAttr || {},
      subIdByKey,
      subKeyById
    },
    character: {
      byId: characterData
    },
    weapon: {
      byId: weaponById
    }
  }
}

