#!/usr/bin/env node
import { bootstrap } from "./bootstrap.js"

await bootstrap()
await import("./start-main.js")

