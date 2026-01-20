import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const projectRoot = path.resolve(__dirname, "..")

export const metaRepo = {
  url: "https://cnb.cool/qsyhh_res/meta.git",
  branch: (game) => `meta-${game}`
}

export const paths = {
  resourcesDir: path.join(projectRoot, "resources"),
  metaGs: path.join(projectRoot, "resources", "meta-gs"),
  metaSr: path.join(projectRoot, "resources", "meta-sr"),
  dataDir: path.join(projectRoot, "data"),
  rawDir: (game) => path.join(projectRoot, "data", "raw", game),
  samplesDir: (game) => path.join(projectRoot, "data", "samples", game),
  outDir: (game) => path.join(projectRoot, "out", game)
}

export const enka = {
  baseUrl: "https://enka.network/",
  // Use a browser-like UA by default to reduce HTML/WAF responses.
  // NOTE: When running under Yunzai, enka/* fetchers will prefer miao-plugin / ZZZ-Plugin UA automatically.
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  timeoutMs: 20_000
}

