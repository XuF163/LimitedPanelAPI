import crypto from "node:crypto"

function randId() {
  return crypto.randomBytes(6).toString("hex")
}

function toNum(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function buildStreamSettings(node) {
  const net = String(node?.net || "tcp").toLowerCase()
  const tls = String(node?.tls || "").toLowerCase()
  const sni = String(node?.sni || "").trim()
  const allowInsecure = Boolean(node?.allowInsecure)

  const stream: any = {
    network: net,
    security: tls === "tls" ? "tls" : "none"
  }

  if (stream.security === "tls") {
    stream.tlsSettings = {}
    if (sni) stream.tlsSettings.serverName = sni
    if (allowInsecure) stream.tlsSettings.allowInsecure = true
  }

  if (net === "ws") {
    const path = String(node?.wsPath || "/").trim() || "/"
    const host = String(node?.wsHost || "").trim()
    stream.wsSettings = { path }
    if (host) stream.wsSettings.headers = { Host: host }
  }

  if (net === "grpc") {
    const serviceName = String(node?.grpcServiceName || "").trim()
    stream.grpcSettings = {}
    if (serviceName) stream.grpcSettings.serviceName = serviceName
  }

  return stream
}

function outboundFromNode(node, { tag = "proxy" } = {}) {
  const type = String(node?.type || "").toLowerCase()
  const host = String(node?.host || "").trim()
  const port = toNum(node?.port, 0)
  if (!type || !host || !Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid node: ${JSON.stringify({ type, host, port })}`)
  }

  if (type === "vmess") {
    const id = String(node?.id || "").trim()
    if (!id) throw new Error("vmess missing id")
    return {
      protocol: "vmess",
      tag,
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [
              {
                id,
                alterId: toNum(node?.alterId, 0),
                security: String(node?.security || "auto").trim() || "auto"
              }
            ]
          }
        ]
      },
      streamSettings: buildStreamSettings(node)
    }
  }

  if (type === "vless") {
    const id = String(node?.id || "").trim()
    if (!id) throw new Error("vless missing id")
    const encryption = String(node?.encryption || "none").trim() || "none"
    const flow = String(node?.flow || "").trim()
    return {
      protocol: "vless",
      tag,
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [
              {
                id,
                encryption,
                ...(flow ? { flow } : {})
              }
            ]
          }
        ]
      },
      streamSettings: buildStreamSettings(node)
    }
  }

  if (type === "trojan") {
    const password = String(node?.password || "").trim()
    if (!password) throw new Error("trojan missing password")
    return {
      protocol: "trojan",
      tag,
      settings: {
        servers: [
          { address: host, port, password }
        ]
      },
      streamSettings: buildStreamSettings({ ...node, tls: "tls", net: node?.net || "tcp" })
    }
  }

  if (type === "ss") {
    const method = String(node?.method || "").trim()
    const password = String(node?.password || "").trim()
    if (!method || !password) throw new Error("ss missing method/password")
    return {
      protocol: "shadowsocks",
      tag,
      settings: {
        servers: [
          { address: host, port, method, password }
        ]
      }
    }
  }

  throw new Error(`Unsupported node type for v2ray-core: ${type}`)
}

export function buildV2rayHttpProxyConfig(node, { listen = "127.0.0.1", port, logLevel = "warning" }: any = {}) {
  const inTag = `http-in-${randId()}`
  const outTag = `proxy-${randId()}`

  return {
    log: { loglevel: logLevel },
    inbounds: [
      {
        tag: inTag,
        listen,
        port,
        protocol: "http",
        settings: { timeout: 0 }
      }
    ],
    outbounds: [
      outboundFromNode(node, { tag: outTag }),
      { protocol: "freedom", tag: "direct", settings: {} }
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        { type: "field", inboundTag: [inTag], outboundTag: outTag }
      ]
    }
  }
}
