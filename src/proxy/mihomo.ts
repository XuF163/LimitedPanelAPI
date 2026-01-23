import crypto from "node:crypto"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import yaml from "js-yaml"
import { ensureDir } from "../utils/fs.js"

function randId() {
  return crypto.randomBytes(6).toString("hex")
}

function compactObj(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue
    if (typeof v === "string" && !v.trim()) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

function toClashProxy(node) {
  if (node?.clash && typeof node.clash === "object") {
    // Use original Clash proxy object when available (best protocol coverage).
    return node.clash
  }

  const type = String(node?.type || "").toLowerCase()
  const name = String(node?.tag || "").trim() || `${type}:${node?.host || ""}:${node?.port || ""}`
  const server = String(node?.host || "").trim()
  const port = Number(node?.port || 0)
  const network = String(node?.net || "tcp").trim() || "tcp"
  const tls = String(node?.tls || "").toLowerCase() === "tls"
  const sni = String(node?.sni || "").trim()
  const wsHost = String(node?.wsHost || "").trim()
  const wsPath = String(node?.wsPath || "").trim()
  const grpcServiceName = String(node?.grpcServiceName || "").trim()

  if (!type || !server || !Number.isFinite(port) || port <= 0) return null

  if (type === "vmess") {
    return compactObj({
      name,
      type: "vmess",
      server,
      port,
      uuid: String(node?.id || "").trim(),
      alterId: Number(node?.alterId || 0) || 0,
      cipher: String(node?.security || "auto").trim() || "auto",
      tls,
      servername: sni || undefined,
      network,
      ...(network === "ws"
        ? {
            "ws-opts": compactObj({
              path: wsPath || "/",
              headers: wsHost ? { Host: wsHost } : undefined
            })
          }
        : {}),
      ...(network === "grpc"
        ? { "grpc-opts": compactObj({ "grpc-service-name": grpcServiceName || undefined }) }
        : {})
    })
  }

  if (type === "vless") {
    return compactObj({
      name,
      type: "vless",
      server,
      port,
      uuid: String(node?.id || "").trim(),
      encryption: String(node?.encryption || "none").trim() || "none",
      flow: String(node?.flow || "").trim() || undefined,
      tls,
      servername: sni || undefined,
      network,
      ...(network === "ws"
        ? {
            "ws-opts": compactObj({
              path: wsPath || "/",
              headers: wsHost ? { Host: wsHost } : undefined
            })
          }
        : {}),
      ...(network === "grpc"
        ? { "grpc-opts": compactObj({ "grpc-service-name": grpcServiceName || undefined }) }
        : {})
    })
  }

  if (type === "trojan") {
    return compactObj({
      name,
      type: "trojan",
      server,
      port,
      password: String(node?.password || "").trim(),
      sni: sni || undefined,
      network,
      ...(network === "ws"
        ? {
            "ws-opts": compactObj({
              path: wsPath || "/",
              headers: wsHost ? { Host: wsHost } : undefined
            })
          }
        : {}),
      ...(network === "grpc"
        ? { "grpc-opts": compactObj({ "grpc-service-name": grpcServiceName || undefined }) }
        : {})
    })
  }

  if (type === "ss") {
    return compactObj({
      name,
      type: "ss",
      server,
      port,
      cipher: String(node?.method || "").trim(),
      password: String(node?.password || "").trim()
    })
  }

  // For advanced types (hysteria2/tuic/reality...) prefer passing through Clash object.
  return null
}

export async function startMihomoHttpProxy({
  exePath = "",
  node = null,
  port = 0,
  logLevel = "warning",
  keepConfigFiles = false,
  runDir = process.cwd()
} = {}) {
  if (!exePath) throw new Error("mihomo exePath is required")
  const clashProxy = toClashProxy(node)
  if (!clashProxy) throw new Error(`node not supported by mihomo config builder: type=${node?.type || ""}`)

  const name = String(clashProxy?.name || "").trim() || `proxy-${randId()}`

  const cfgObj = {
    port: Number(port),
    "bind-address": "127.0.0.1",
    "allow-lan": false,
    mode: "rule",
    "log-level": String(logLevel || "warning"),
    proxies: [clashProxy],
    "proxy-groups": [
      { name: "Proxy", type: "select", proxies: [name] }
    ],
    rules: ["MATCH,Proxy"]
  }

  const cfgDir = keepConfigFiles
    ? path.join(runDir, "data", "proxy", "mihomo")
    : path.join(os.tmpdir(), "ExtremePanelAPI", "mihomo")
  await ensureDir(cfgDir)

  const cfgPath = keepConfigFiles
    ? path.join(cfgDir, `mihomo.${port}.yaml`)
    : path.join(cfgDir, `mihomo.${process.pid}.${port}.${Date.now()}.yaml`)
  const homeDir = keepConfigFiles
    ? path.join(cfgDir, `home.${port}`)
    : path.join(cfgDir, `home.${process.pid}.${port}.${Date.now()}`)
  await ensureDir(homeDir)

  const yml = yaml.dump(cfgObj, { lineWidth: 200 })
  await fsp.writeFile(cfgPath, yml, "utf8")

  const proxyUrl = `http://127.0.0.1:${port}`
  const child = spawn(exePath, ["-f", cfgPath, "-d", homeDir], {
    cwd: path.dirname(exePath),
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  })
  child.unref()

  const cleanup = async () => {
    try { child.kill() } catch {}
    if (!keepConfigFiles) {
      try { await fsp.rm(homeDir, { recursive: true, force: true }) } catch {}
      try { await fsp.unlink(cfgPath) } catch {}
    }
  }

  return { child, proxyUrl, cfgPath, homeDir, cleanup, config: cfgObj }
}
