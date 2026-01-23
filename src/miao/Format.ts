const GS_ELEMS = new Set([ "anemo", "geo", "electro", "dendro", "pyro", "hydro", "cryo" ])
const SR_ELEMS = new Set([ "fire", "ice", "wind", "elec", "phy", "quantum", "imaginary" ])

const isElem = (elem = "", game = "gs") => {
  elem = (elem || "").toString().toLowerCase()
  return (game === "gs" ? GS_ELEMS : SR_ELEMS).has(elem)
}

const sameElem = (key1 = "", key2 = "", game = "gs") => {
  key1 = (key1 || "").toString().toLowerCase()
  key2 = (key2 || "").toString().toLowerCase()
  return key1 && key1 === key2 && isElem(key1, game)
}

const Format = {
  int(d) {
    return parseInt(d, 10)
  },
  comma(num, fix = 0) {
    num = Number.parseFloat((num * 1).toFixed(fix))
    const [ integer, decimal ] = String(num).split(".")
    const withComma = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    return `${withComma}${fix > 0 ? "." + (decimal || "0".repeat(fix)) : ""}`
  },
  pct(num, fix = 1) {
    return (num * 1).toFixed(fix) + "%"
  },
  percent(num, fix = 1) {
    return Format.pct(num * 100, fix)
  },
  isElem,
  sameElem
}

export default Format

