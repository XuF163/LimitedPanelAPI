function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseSrAttrId(attrId) {
  // "affixId,cnt,step"
  const parts = String(attrId || "").split(",")
  if (parts.length < 2) return null
  const affixId = toNum(parts[0], NaN)
  const cnt = toNum(parts[1], NaN)
  const step = parts.length >= 3 ? toNum(parts[2], 0) : 0
  if (!Number.isFinite(affixId) || !Number.isFinite(cnt)) return null
  return { affixId, cnt, step }
}

export function getSrWeights(meta, { charId, charName } = {}) {
  const name = charName || meta?.character?.byId?.[Number(charId)]?.name || ""
  const weights = meta?.artifact?.usefulAttr?.[name]
  return weights && typeof weights === "object" ? weights : {}
}

export function calcSrBuildMark(meta, build) {
  const weights = getSrWeights(meta, build)
  const artis = build?.artis || {}
  let sum = 0

  for (const piece of Object.values(artis)) {
    if (!piece?.attrIds) continue
    for (const raw of piece.attrIds || []) {
      const parsed = parseSrAttrId(raw)
      if (!parsed) continue
      const key = meta?.artifact?.subKeyById?.[parsed.affixId]
      if (!key) continue
      const w = toNum(weights?.[key], 0) / 100
      sum += w * toNum(parsed.cnt, 0)
    }
  }

  // Keep a stable number for sorting/logging.
  const mark = Math.round(sum * 1000) / 10
  return { mark, weights }
}

