import { spawn } from "node:child_process"

export async function runCmd(command, args, options: any = {}) {
  const { cwd, env, stdio = "inherit" } = options
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio,
      windowsHide: true
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`))
    })
  })
}

