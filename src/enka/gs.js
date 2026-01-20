import { enka } from "../config.js"
import { resolveEnkaUserAgent } from "./headers.js"

export class EnkaHttpError extends Error {
  constructor(uid, status, body) {
    super(`Enka HTTP ${status} uid=${uid}`)
    this.name = "EnkaHttpError"
    this.uid = uid
    this.status = status
    this.body = body
  }
}

export async function fetchEnkaGs(uid, options = {}) {
  const baseUrl = options.baseUrl || enka.baseUrl
  const userAgent = options.userAgent || (await resolveEnkaUserAgent("gs")) || enka.userAgent
  const timeoutMs = options.timeoutMs ?? enka.timeoutMs
  const dispatcher = options.dispatcher

  const url = new URL(`api/uid/${uid}`, baseUrl).toString()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const fetchOptions = {
      headers: {
        "user-agent": userAgent,
        accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    }

    const res = await fetch(url, fetchOptions)
    const text = await res.text()
    if (!res.ok) {
      throw new EnkaHttpError(uid, res.status, text)
    }
    if (text.trim().startsWith("<")) {
      throw new Error(`Enka returned HTML for uid=${uid}`)
    }
    const data = JSON.parse(text)
    return { data, text }
  } finally {
    clearTimeout(timeoutId)
  }
}

