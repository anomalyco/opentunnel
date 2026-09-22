// Render one loop of the tunnel's track through the real engine in headless Chromium and report it: true peak,
// integrated loudness, each cue's momentary loudness, and the voice's level on the open wire, inside the relay
// and in the rush out. Writes an envelope plot and a WAV of the loop next to each other.
//
//   bun run scripts/render-track.ts [--out <dir>] [--fractions <enter,leave>] [--seed <n>]
//
// The relay's share of each leg's path is measured from the running dev page (window.__tunnel.crossings) when
// one is up at 127.0.0.1:4190; otherwise the 760px column's fractions are assumed.
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import type { TrackReport } from "./track/page"

const args = process.argv.slice(2)
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const out = option("--out") ?? join(tmpdir(), "opentunnel-track")
const seed = Number(option("--seed") ?? 1979)
const fallback = { enter: .19, leave: .73 }

const bundle = await Bun.build({ entrypoints: ["scripts/track/page.ts"], target: "browser", format: "esm", minify: false, define: { "import.meta.env.DEV": "false" } })
if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"))
const pageScript = await bundle.outputs[0]!.text()

const executablePath = process.env.BROWSER_EXECUTABLE ?? [chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
try {
  let fractions = [fallback, fallback, fallback]
  const given = option("--fractions")
  if (given) { const [enter, leave] = given.split(",").map(Number); fractions = fractions.map(() => ({ enter: enter!, leave: leave! })) }
  else {
    try {
      const probe = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      await probe.goto("http://127.0.0.1:4190/", { waitUntil: "networkidle", timeout: 8000 })
      await probe.waitForFunction(() => (window as unknown as { __tunnel?: { crossings: unknown[] } }).__tunnel?.crossings.length === 3, undefined, { timeout: 5000 })
      const measured = await probe.evaluate(() => (window as unknown as { __tunnel: { crossings: { fractions: { enter: number; leave: number } }[] } }).__tunnel.crossings.map(c => c.fractions))
      fractions = measured
      await probe.close()
      console.log("fractions from the dev page:", measured.map(f => `${f.enter.toFixed(3)}–${f.leave.toFixed(3)}`).join("  "))
    } catch { console.log("no dev page; assuming fractions", fallback) }
  }
  const page = await browser.newPage({ viewport: { width: 1600, height: 520 } })
  page.on("pageerror", error => { throw error })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#111"><canvas id="plot"></canvas><script type="module">${pageScript}</script></body></html>`)
  await page.waitForFunction(() => Boolean(window.track))
  const report = await page.evaluate(([fractions, seed]) => window.track.render(fractions, seed), [fractions, seed] as const) as TrackReport
  await mkdir(out, { recursive: true })
  await page.locator("#plot").screenshot({ path: join(out, "track.png") })
  await writeFile(join(out, "track.wav"), Buffer.from(report.wav, "base64"))
  await writeFile(join(out, "track.json"), JSON.stringify({ ...report, wav: undefined, loudness: undefined }, null, 2))
  const db = (value: number) => value <= -119 ? "—" : value.toFixed(1)
  console.log(`loop ${report.duration.toFixed(2)} s   true peak ${db(report.truePeakDb)} dBTP   integrated ${db(report.integratedLufs)} LUFS`)
  console.log("cues (momentary max LUFS):")
  for (const cue of report.cues) console.log(`  ${cue.at.toFixed(2).padStart(5)}  ${cue.event.padEnd(9)} ${db(cue.momentaryMaxLufs).padStart(6)}`)
  console.log("voice (mean / max LUFS):")
  for (const span of report.spans) console.log(`  ${span.name.padEnd(8)} ${span.from.toFixed(2)}–${span.to.toFixed(2)}  ${db(span.meanLufs).padStart(6)} / ${db(span.momentaryMaxLufs)}`)
  console.log(`→ ${join(out, "track.png")}  ${join(out, "track.wav")}`)
} finally { await browser.close() }
