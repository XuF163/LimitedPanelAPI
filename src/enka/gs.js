import { enka } from "../config.js"

export async function fetchEnkaGs(uid, options = {}) {
  const baseUrl = options.baseUrl || enka.baseUrl
  const userAgent = options.userAgent || enka.userAgent
  const timeoutMs = options.timeoutMs ?? enka.timeoutMs

  const url = new URL(`api/uid/${uid}`, baseUrl).toString()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Enka HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    if (text.trim().startsWith("<")) {
      throw new Error(`Enka returned HTML for uid=${uid}`)
    }
    const data = JSON.parse(text)
    return data
  } finally {
    clearTimeout(timeoutId)
  }
}

