#!/usr/bin/env node
import { run } from "./main.js"

run(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack || err)
  process.exitCode = 1
})

