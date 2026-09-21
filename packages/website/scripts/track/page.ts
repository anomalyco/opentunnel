// Browser side of scripts/render-track.ts: renders one loop of the tunnel's track through the real engine into
// an OfflineAudioContext (the cues at their times, the flight voice retuned every ~21 ms as on the page), then
// measures it (BS.1770 K-weighted momentary loudness, true peak) and draws the envelope with the cues marked.
import { createTravelSound, renderSound, type TravelSoundSettings } from "../../src/sfx"
import { soundPalette } from "../../src/sound/sounds"
import { tunnelSoundCues, tunnelVoiceAt } from "../../src/scenes/tunnelSounds"
import { legCrossing, type LegFractions } from "../../src/scenes/tunnelFlight"
import { tunnelLegs, tunnelScore } from "../../src/scenes/tunnelScore"

const SAMPLE_RATE = 48000
const PRE_ROLL = 1
const QUANTUM = 128
const STEP = 1024

export type TrackReport = {
  duration: number
  truePeakDb: number
  integratedLufs: number
  cues: { at: number; event: string; momentaryMaxLufs: number }[]
  spans: { name: string; from: number; to: number; momentaryMaxLufs: number; meanLufs: number }[]
  loudness: { at: number[]; lufs: number[] }
  wav: string
}

declare global { interface Window { track: { render: (fractions: LegFractions[], seed?: number) => Promise<TrackReport> } } }

function seedRandom(seed: number) {
  let state = seed >>> 0
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const nativeSetTimeout = window.setTimeout.bind(window)
let deferred: (() => void)[] | null = null
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  if (deferred && typeof handler === "function") { deferred.push(() => handler(...args)); return 0 }
  return nativeSetTimeout(handler, timeout, ...args)
}) as typeof window.setTimeout

async function render(fractions: LegFractions[], seed = 1979): Promise<TrackReport> {
  seedRandom(seed)
  const crossings = fractions.map((f, index) => legCrossing(index, f, false))
  const duration = tunnelScore.duration
  const cues = tunnelSoundCues(crossings)
  const context = new OfflineAudioContext(2, Math.round((PRE_ROLL + duration + .8) * SAMPLE_RATE), SAMPLE_RATE)
  deferred = []
  // The engine's limited output chain settles during the pre-roll; the voice's own bus goes straight to the destination, as on the page.
  renderSound(context, { masterGain: 0, layers: [{ kind: "tone", waveform: "sine", frequency: 440, attack: .001, decay: .001, peak: 1e-6 }] })
  const bus = context.createGain(); bus.gain.value = 1; bus.connect(context.destination)
  const voice = createTravelSound(context, bus)
  let last: TravelSoundSettings | undefined
  const actions = new Map<number, (() => void)[]>()
  const schedule = (seconds: number, action: () => void) => {
    const aligned = Math.round(seconds * SAMPLE_RATE / QUANTUM) * QUANTUM
    const list = actions.get(aligned) ?? []
    list.push(action); actions.set(aligned, list)
  }
  for (const cue of cues) schedule(PRE_ROLL + cue.at, () => {
    for (const layer of soundPalette[cue.event]) renderSound(context, layer.sound, { volume: layer.volume })
  })
  for (let sample = 0; sample < duration * SAMPLE_RATE; sample += STEP) {
    const time = sample / SAMPLE_RATE
    schedule(PRE_ROLL + time, () => {
      const next = tunnelVoiceAt(time, crossings)
      if (next) voice.set(true, next)
      else if (last) voice.set(false, last)
      last = next
    })
  }
  for (const [aligned, list] of [...actions.entries()].sort((a, b) => a[0] - b[0])) {
    void context.suspend(aligned / SAMPLE_RATE).then(() => { for (const action of list) action(); void context.resume() })
  }
  const buffer = await context.startRendering()
  const pending = deferred; deferred = null
  for (const fn of pending) { try { fn() } catch { /* cleanup only */ } }
  const start = Math.round(PRE_ROLL * SAMPLE_RATE)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(start))

  const weighted = channels.map(kWeight)
  const { at, power } = windowPowers(weighted, Math.round(.4 * SAMPLE_RATE), Math.round(.01 * SAMPLE_RATE))
  const lufs = power.map(p => LOUDNESS_OFFSET + toDb(p))
  // Windows are stamped by their start; a cue's loudness is the loudest window that begins from .3 s before it (so it contains the onset) to .4 s after.
  const maxIn = (from: number, to: number) => Math.max(-120, ...lufs.filter((_, i) => at[i]! >= from - .3 && at[i]! <= to))
  const inside = (from: number, to: number) => power.filter((_, i) => at[i]! >= from && at[i]! + .4 <= to)
  const meanIn = (from: number, to: number) => { const p = inside(from, to); return p.length ? LOUDNESS_OFFSET + toDb(p.reduce((a, b) => a + b, 0) / p.length) : -120 }
  const maxInside = (from: number, to: number) => { const p = inside(from, to); return p.length ? LOUDNESS_OFFSET + toDb(Math.max(...p)) : -120 }
  const spans = crossings.flatMap((crossing, index) => {
    const leg = tunnelLegs[index]!
    return [
      { name: `wire ${index}`, from: leg.send + .2, to: crossing.enter - .05 },
      { name: `relay ${index}`, from: crossing.enter + .3, to: crossing.leave - .25 },
      { name: `rush ${index}`, from: crossing.leave - .15, to: leg.contact - .05 },
    ].map(span => ({ ...span, momentaryMaxLufs: maxInside(span.from, span.to), meanLufs: meanIn(span.from, span.to) }))
  })
  draw(channels, at, lufs, cues, crossings, duration)
  return {
    duration,
    truePeakDb: 20 * Math.log10(Math.max(...channels.map(truePeak))),
    integratedLufs: integrated(power) ?? -120,
    cues: cues.map(cue => ({ ...cue, momentaryMaxLufs: maxIn(cue.at, cue.at + .4) })),
    spans,
    loudness: { at, lufs },
    wav: wav(channels),
  }
}

function draw(channels: Float32Array[], at: number[], lufs: number[], cues: readonly { at: number; event: string }[], crossings: { enter: number; leave: number }[], duration: number) {
  const canvas = document.getElementById("plot") as HTMLCanvasElement
  const W = 1600, H = 520, pad = 40, top = 30
  canvas.width = W; canvas.height = H
  const g = canvas.getContext("2d")!
  g.fillStyle = "#111"; g.fillRect(0, 0, W, H)
  const x = (t: number) => pad + (W - 2 * pad) * t / duration
  // Relay stretches and legs.
  for (const [index, crossing] of crossings.entries()) {
    g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(x(crossing.enter), top, x(crossing.leave) - x(crossing.enter), H - top - 60)
    const leg = tunnelLegs[index]!
    g.strokeStyle = "rgba(255,255,255,.25)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x(leg.send), top); g.lineTo(x(leg.send), H - 60); g.moveTo(x(leg.contact), top); g.lineTo(x(leg.contact), H - 60); g.stroke(); g.setLineDash([])
  }
  // Waveform envelope (peak per pixel column).
  const mid = top + (H - top - 60) * .32, amp = (H - top - 60) * .28
  g.fillStyle = "#9ab"
  const perPixel = channels[0]!.length / (W - 2 * pad)
  for (let px = 0; px < W - 2 * pad; px++) {
    let peak = 0
    const from = Math.floor(px * perPixel), to = Math.floor((px + 1) * perPixel)
    for (const channel of channels) for (let i = from; i < to; i++) { const m = Math.abs(channel[i]!); if (m > peak) peak = m }
    g.fillRect(pad + px, mid - peak * amp / .25, 1, Math.max(1, 2 * peak * amp / .25))
  }
  // Momentary loudness, -60..-20 LUFS.
  const ly = (v: number) => H - 60 - (H - top - 60) * .36 * Math.max(0, Math.min(1, (v + 60) / 40))
  for (const tier of [-33, -39, -42]) { g.strokeStyle = "rgba(255,255,255,.18)"; g.beginPath(); g.moveTo(pad, ly(tier)); g.lineTo(W - pad, ly(tier)); g.stroke(); g.fillStyle = "#888"; g.font = "11px monospace"; g.fillText(`${tier}`, 4, ly(tier) + 4) }
  g.strokeStyle = "#ffb347"; g.lineWidth = 1.5; g.beginPath()
  for (const [i, t] of at.entries()) { const px = x(t + .2), py = ly(lufs[i]!); if (i === 0) g.moveTo(px, py); else g.lineTo(px, py) }
  g.stroke(); g.lineWidth = 1
  // Cues.
  g.font = "11px monospace"
  for (const [i, cue] of cues.entries()) {
    g.strokeStyle = "#f55"; g.beginPath(); g.moveTo(x(cue.at), H - 58); g.lineTo(x(cue.at), H - 40); g.stroke()
    g.fillStyle = "#f88"; g.fillText(cue.event, x(cue.at) - 10, H - 26 + (i % 2) * 12)
  }
  g.fillStyle = "#888"
  for (let t = 0; t <= duration; t += .5) g.fillText(t.toFixed(1), x(t) - 8, H - 4)
}

function wav(channels: Float32Array[]): string {
  const frames = channels[0]!.length, blockAlign = channels.length * 2
  const buffer = new ArrayBuffer(44 + frames * blockAlign), view = new DataView(buffer)
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
  ascii(0, "RIFF"); view.setUint32(4, 36 + frames * blockAlign, true); ascii(8, "WAVE"); ascii(12, "fmt ")
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true); view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, frames * blockAlign, true)
  let offset = 44
  for (let i = 0; i < frames; i++) for (const channel of channels) { view.setInt16(offset, Math.max(-1, Math.min(1, channel[i]!)) * 32767, true); offset += 2 }
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// ITU-R BS.1770-4 K-weighting at 48 kHz: stage 1 high shelf, stage 2 high-pass.
const K_STAGE_1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 }
const K_STAGE_2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 }
function biquad(input: ArrayLike<number>, c: typeof K_STAGE_1): Float64Array {
  const out = new Float64Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    out[i] = y0
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
  }
  return out
}
const kWeight = (channel: Float32Array) => biquad(biquad(channel, K_STAGE_1), K_STAGE_2)
const toDb = (power: number) => power > 0 ? 10 * Math.log10(power) : -Infinity
const LOUDNESS_OFFSET = -0.691
function windowPowers(weighted: Float64Array[], windowSamples: number, hop: number) {
  const length = weighted[0]!.length
  const prefix = new Float64Array(length + 1)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const channel of weighted) sum += channel[i]! * channel[i]!
    prefix[i + 1] = prefix[i]! + sum
  }
  const at: number[] = [], power: number[] = []
  for (let start = 0; start + windowSamples <= length; start += hop) { at.push(start / SAMPLE_RATE); power.push((prefix[start + windowSamples]! - prefix[start]!) / windowSamples) }
  return { at, power }
}
function integrated(blocks: number[]): number | null {
  const absolute = blocks.filter(power => LOUDNESS_OFFSET + toDb(power) > -70)
  if (!absolute.length) return null
  const ungated = LOUDNESS_OFFSET + toDb(absolute.reduce((a, b) => a + b, 0) / absolute.length)
  const relative = absolute.filter(power => LOUDNESS_OFFSET + toDb(power) > ungated - 10)
  return relative.length ? LOUDNESS_OFFSET + toDb(relative.reduce((a, b) => a + b, 0) / relative.length) : null
}
const OVERSAMPLE = 4, TAPS_PER_PHASE = 12
const PHASES: Float64Array[] = (() => {
  const total = OVERSAMPLE * TAPS_PER_PHASE, center = (total - 1) / 2
  const h = new Float64Array(total)
  for (let n = 0; n < total; n++) {
    const x = (n - center) / OVERSAMPLE
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const w = .42 - .5 * Math.cos(2 * Math.PI * n / (total - 1)) + .08 * Math.cos(4 * Math.PI * n / (total - 1))
    h[n] = sinc * w
  }
  return Array.from({ length: OVERSAMPLE }, (_, phase) => {
    const taps = new Float64Array(TAPS_PER_PHASE)
    let sum = 0
    for (let k = 0; k < TAPS_PER_PHASE; k++) { taps[k] = h[k * OVERSAMPLE + phase]!; sum += taps[k]! }
    for (let k = 0; k < TAPS_PER_PHASE; k++) taps[k]! /= sum
    return taps
  })
})()
function truePeak(channel: Float32Array): number {
  let peak = 0
  for (let i = 0; i < channel.length; i++) for (const taps of PHASES) {
    let y = 0
    for (let k = 0; k < TAPS_PER_PHASE; k++) { const index = i - k; if (index >= 0) y += taps[k]! * channel[index]! }
    const magnitude = Math.abs(y)
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

window.track = { render }
