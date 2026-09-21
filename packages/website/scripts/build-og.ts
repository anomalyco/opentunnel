// Screenshots the share card at /og into dist/og.png. Runs after `vite build` so the image ships with the site.
// A private dev server on a free port renders the card; Chromium draws the WebGL print through SwiftShader.
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dirname, ".."), outDir = join(root, "dist"), file = join(outDir, "og.png")

const server = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === "string") throw new Error("The dev server did not report a port")
const origin = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: "reduce" })
  page.on("pageerror", error => { throw error })
  await page.goto(`${origin}/og`, { waitUntil: "load" })
  await page.waitForFunction(() => window.__ogReady !== undefined)
  await page.evaluate(() => window.__ogReady)
  const card = page.locator("[data-og-card]")
  const box = await card.boundingBox()
  if (!box || Math.round(box.width) !== 1200 || Math.round(box.height) !== 630) throw new Error(`The card measures ${box?.width}×${box?.height}, not 1200×630`)
  if (await page.locator("[data-og-card] canvas[data-fallback]").count()) throw new Error("WebGL2 was unavailable; the print did not draw")
  await mkdir(outDir, { recursive: true })
  await card.screenshot({ path: file, type: "png", animations: "disabled" })
  console.log(`Share card → ${file}`)
} finally {
  await browser.close()
  await server.close()
}
