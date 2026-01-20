import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { projectRoot } from "../config.js"

function exeName(base) {
  return process.platform === "win32" ? `${base}.exe` : base
}

function fileExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function findVsDevCmdBat() {
  if (process.platform !== "win32") return ""
  const roots = [
    path.join(String(process.env.ProgramFiles || "C:\\Program Files"), "Microsoft Visual Studio"),
    path.join(String(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"), "Microsoft Visual Studio")
  ]
  const skus = [ "BuildTools", "Community", "Professional", "Enterprise" ]
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue
      const versions = fs.readdirSync(root).filter(Boolean).sort().reverse()
      for (const v of versions) {
        for (const sku of skus) {
          const p = path.join(root, v, sku, "Common7", "Tools", "VsDevCmd.bat")
          if (fileExists(p)) return p
        }
      }
    } catch {
      // ignore
    }
  }
  return ""
}

function findOnPath(cmd) {
  const r = spawnSync(cmd, [ "--version" ], { stdio: "ignore", windowsHide: true })
  return r.status === 0
}

const crateRoot = path.join(projectRoot, "rust", "limitedpanel-rs")

function targetBinPath({ release = true } = {}) {
  const profile = release ? "release" : "debug"
  return path.join(crateRoot, "target", profile, exeName("limitedpanel-rs"))
}

let _ensurePromise = null

export async function ensureLimitedPanelRsBinary({ release = true, autoBuild = true } = {}) {
  if (_ensurePromise) return await _ensurePromise
  _ensurePromise = (async () => {
    const envBin = String(process.env.LIMITEDPANEL_RS_BIN || "").trim()
    if (envBin) return path.resolve(envBin)

    const binPath = targetBinPath({ release })
    if (fileExists(binPath)) return binPath

    const wantBuild = autoBuild && !envBool("RUST_NO_BUILD", false)
    if (!wantBuild) throw new Error(`missing rust binary: ${binPath}`)

    if (!findOnPath("cargo")) throw new Error("cargo not found on PATH (install Rust toolchain or set LIMITEDPANEL_RS_BIN)")

    const args = [ "build", ...(release ? [ "--release" ] : []) ]
    const r = (() => {
      // Windows: use VsDevCmd.bat to provide MSVC toolchain (link.exe, include/lib) even in a plain shell.
      // This makes auto-build work without requiring users to start a "Developer PowerShell" manually.
      if (process.platform === "win32") {
        const vsDevCmd = findVsDevCmdBat()
        if (vsDevCmd) {
          // `cmd /c` has tricky quoting rules when the command starts with a quoted path.
          // Use the canonical pattern: cmd /c ""C:\Path With Spaces\VsDevCmd.bat" ... && cargo ..."
          const cmd = `""${vsDevCmd}" -arch=x64 -host_arch=x64 >nul && cargo ${args.join(" ")}"`
          return spawnSync("cmd.exe", [ "/d", "/s", "/c", cmd ], {
            cwd: crateRoot,
            stdio: "inherit",
            windowsHide: true,
            windowsVerbatimArguments: true
          })
        }
      }
      return spawnSync("cargo", args, {
        cwd: crateRoot,
        stdio: "inherit",
        windowsHide: true
      })
    })()
    if (r.status !== 0) {
      const hint = process.platform === "win32"
        ? " (Windows: install Visual Studio Build Tools/MSVC or run in a VS Developer shell; you can also set LIMITEDPANEL_RS_BIN to a prebuilt binary)"
        : " (set LIMITEDPANEL_RS_BIN to a prebuilt binary if you don't want auto-build)"
      throw new Error(`cargo build failed (code=${r.status})${hint}`)
    }

    if (!fileExists(binPath)) throw new Error(`rust build finished but binary missing: ${binPath}`)
    return binPath
  })()
  return await _ensurePromise
}

function envBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw == null || raw === "") return fallback
  if ([ "1", "true", "yes", "y", "on" ].includes(String(raw).toLowerCase())) return true
  if ([ "0", "false", "no", "n", "off" ].includes(String(raw).toLowerCase())) return false
  return fallback
}
