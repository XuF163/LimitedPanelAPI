#!/usr/bin/env node
import { bootstrap } from "./bootstrap.js"

await bootstrap()

const { run } = await import("./main.js")

try {
  await run(process.argv.slice(2))
} catch (err) {
  console.error(err?.stack || err)
  process.exitCode = 1
}

