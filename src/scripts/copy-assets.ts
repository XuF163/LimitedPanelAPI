import fs from "node:fs/promises"
import path from "node:path"

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function copyFile(src: string, dst: string) {
  await ensureDir(path.dirname(dst))
  await fs.copyFile(src, dst)
}

async function main() {
  const root = process.cwd()
  const pairs: Array<[string, string]> = [
    ["src/ui/index.html", "dist/ui/index.html"],
    ["src/ui/index.html", "dist/webui/index.html"]
  ]

  for (const [from, to] of pairs) {
    const src = path.join(root, from)
    const dst = path.join(root, to)
    await copyFile(src, dst)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

