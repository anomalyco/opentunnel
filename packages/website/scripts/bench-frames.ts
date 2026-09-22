// Frame pacing of the landing page in WebKit (Safari's engine), headless, at a phone and a laptop width.
// Loads the page, scrolls the diagram into view, samples requestAnimationFrame intervals for a few seconds,
// and reports the median frame interval, the 95th percentile and the share of frames over 20 ms (a dropped
// 60 Hz frame). One warmup pass, then N measured passes; the median of medians is the headline.
//
//   bun run scripts/bench-frames.ts [--url http://127.0.0.1:4190/] [--runs 7] [--seconds 4] [--browser webkit|chromium] [--css "<override rules>"]
// `--css` injects a stylesheet after load: a way to test one hypothesis ("what if this filter were off?") without editing source.
import { chromium, webkit } from "playwright-core"

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback
const url = option("--url", "http://127.0.0.1:4190/")
const runs = Number(option("--runs", "7")), seconds = Number(option("--seconds", "4"))
const engine = option("--browser", "webkit") === "chromium" ? chromium : webkit
const css = option("--css", "")

type Sample = { median: number; p95: number; dropped: number; frames: number }
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!

async function sample(width: number, height: number): Promise<Sample> {
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: "load" })
  if (css) await page.addStyleTag({ content: css })
  await page.waitForTimeout(800)
  // The diagram centred: what a visitor sees while it plays.
  await page.evaluate(() => document.querySelector(".diagram-wrap")?.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(400)
  const intervals: number[] = await page.evaluate(seconds => new Promise<number[]>(resolve => {
    const out: number[] = []
    let last = performance.now()
    const start = last
    const tick = (now: number) => {
      out.push(now - last); last = now
      if (now - start < seconds * 1000) requestAnimationFrame(tick); else resolve(out)
    }
    requestAnimationFrame(tick)
  }), seconds)
  await browser.close()
  const sorted = [...intervals].sort((a, b) => a - b)
  return { median: quantile(sorted, .5), p95: quantile(sorted, .95), dropped: intervals.filter(i => i > 20).length / intervals.length, frames: intervals.length }
}

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
for (const [name, width, height] of [["laptop", 1280, 800], ["phone", 390, 844]] as const) {
  await sample(width, height)
  const results: Sample[] = []
  for (let i = 0; i < runs; i++) results.push(await sample(width, height))
  const med = median(results.map(r => r.median)), p95 = median(results.map(r => r.p95)), dropped = median(results.map(r => r.dropped))
  const spread = results.map(r => r.median.toFixed(1)).join(" ")
  console.log(`${name.padEnd(7)} median frame ${med.toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  dropped ${(dropped * 100).toFixed(0)}%   (medians: ${spread})`)
  console.log(`METRIC ${name}_frame_median_ms=${med.toFixed(2)}`)
  console.log(`METRIC ${name}_frame_p95_ms=${p95.toFixed(2)}`)
  console.log(`METRIC ${name}_dropped_share=${dropped.toFixed(3)}`)
}
