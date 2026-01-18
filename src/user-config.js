import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import _ from "lodash"
import { projectRoot } from "./config.js"

const require = createRequire(import.meta.url)
const yaml = require("js-yaml")

const CONFIG_DIR = path.join(projectRoot, "config")
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, "defSet.yaml")
const USER_CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml")

const LEGACY_DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, "defSet.json")
const LEGACY_USER_CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

function readYamlSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const txt = fs.readFileSync(filePath, "utf8")
    return yaml.load(txt)
  } catch {
    return null
  }
}

function ensureUserConfig(defaultConfig) {
  if (fs.existsSync(USER_CONFIG_PATH)) return
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(USER_CONFIG_PATH, yaml.dump(defaultConfig, { noRefs: true }), "utf8")
}

export function loadAppConfig({ ensureUser = true } = {}) {
  const base =
    readYamlSafe(DEFAULT_CONFIG_PATH) ||
    // 兼容旧 JSON 默认配置（曾经生成过）
    readYamlSafe(LEGACY_DEFAULT_CONFIG_PATH) ||
    {}

  if (ensureUser) ensureUserConfig(base)

  const override =
    readYamlSafe(USER_CONFIG_PATH) ||
    // 兼容旧 JSON 用户配置：若存在则合并进来（不自动删除）
    readYamlSafe(LEGACY_USER_CONFIG_PATH) ||
    {}

  const merged = _.merge({}, base, override)

  return {
    configDir: CONFIG_DIR,
    defaultPath: DEFAULT_CONFIG_PATH,
    userPath: USER_CONFIG_PATH,
    data: merged
  }
}
