import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import type { Crossing } from "./tunnelFlight"
import { gateBow, gatePush } from "./GateField"
import { flightTuning } from "./flightTuning"
import { tunnelScore } from "./tunnelScore"

// The sealed request as a thing, not text: a small object riding the wire that is plainly unreadable, which only
// your machine's gate can open. Two treatments under study (and the glyph train, drawn elsewhere in SVG):
//   moiré  a block of broken line grating. In the gate, the gate's own grating (the key) slides over it and aligns;
//          the interference cancels everywhere except a disk hidden in the packet's phase, which appears and
//          condenses into the light.
//   tiles  the destination's icon cut into 4×4 tiles, shuffling and turning while sealed. In the gate the tiles slide
//          home in a diagonal wave, the icon assembles, then condenses into the light.
// Drawn on one 2D canvas over the diagram; each packet is computed per device pixel into a tiny sprite.

export type CipherStyle = "shapes" | "glyphs" | "moire" | "tiles"
export const cipherStyles: readonly CipherStyle[] = ["shapes", "moire", "tiles", "glyphs"]

/** Before each send, in seconds: the reel spins and settles on the destination, rests, then the chosen shape slides
 * out of the browser through its border (where it garbles) to the socket. */
export const choosing = {
  get spin() { return flightTuning.get().spin }, get rest() { return flightTuning.get().rest }, get slide() { return flightTuning.get().slide },
}
export const chooseSeconds = () => choosing.spin + choosing.rest + choosing.slide

/** The reel's travel, in slots, at a fraction of its spin: spun up and eased to a stop on the destination with a
 * hair of overshoot. */
export const reelSlots = () => flightTuning.get().slots
export const reelOffset = (x: number) => { const c = flightTuning.get().overshoot, k = Math.max(0, Math.min(1, x)) - 1; return reelSlots() * (1 + (c + 1) * k * k * k + c * k * k) }

/** Scene times at which a shape passes the reel's centre (a ratchet tick each), for the request sent at `send`. */
export function reelTicks(send: number) {
  const start = send - chooseSeconds(), steps = 600, ticks: number[] = []
  let previous = reelOffset(0)
  for (let i = 1; i <= steps; i++) {
    const offset = reelOffset(i / steps)
    if (Math.floor(offset) !== Math.floor(previous) && i < steps) ticks.push(start + i / steps * choosing.spin)
    previous = offset
  }
  return ticks
}

/** Seconds from a request's send to a scene time, across the loop's wrap: the first request chooses its destination at
 * the end of the previous loop. */
export function sinceSend(t: number, send: number) {
  const loop = tunnelScore.duration
  const d = t - send
  return d > loop / 2 ? d - loop : d < -loop / 2 ? d + loop : d
}

/** Where the reel sits in the browser card: on its right; on a phone, where the card is just its icon, in the icon's place. */
export const reelCentre = (origin: Box) => ({ x: origin.width < 90 ? origin.x + origin.width / 2 : origin.x + origin.width - 22, y: origin.y + origin.height / 2 })

/** The chosen shape's centre at a scene time, from the moment it starts sliding out of the browser until it plugs into
 * its app; undefined otherwise. */
export function packetCentre(leg: CipherLeg, t: number, origin: Box, travel: number) {
  const before = sinceSend(t, leg.send), u = before / travel
  if (before < -choosing.slide || u >= 1) return undefined
  if (u <= 0) {
    const reel = reelCentre(origin), exit = origin.x + origin.width
    // Eased out of rest but still moving as it reaches the socket, so it carries straight on down the wire.
    const p = clamp01((before + choosing.slide) / choosing.slide)
    const carry = flightTuning.get().slideCarry
    return { x: reel.x + (exit - reel.x) * ((1 - carry) * smooth(p) + carry * p * p), y: reel.y }
  }
  return leg.path.getPointAtLength(leg.ease.at(u) * leg.length)
}

/** How much the browser is busy choosing at a scene time, 0..1, across the requests' sends. */
export const choosingAt = (sends: readonly number[], t: number) =>
  Math.max(0, ...sends.map(send => { const d = sinceSend(t, send); return Math.min(smooth((d + chooseSeconds()) / .3), 1 - smooth((d + choosing.slide * .4) / .4)) }))

/** The three destinations as plain shapes, in CSS pixels about the origin: signed distance, negative inside. */
export const shapeNames = ["circle", "triangle", "square"] as const
function shapeDistance(shape: number, x: number, y: number) {
  if (shape === 0) return Math.hypot(x, y) - 5
  if (shape === 2) {
    const dx = Math.abs(x) - 4.4, dy = Math.abs(y) - 4.4
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0)
  }
  // Triangle, point up, the same box as the card icon's.
  const a = [0, -5.6], b = [5.6, 4.4], c = [-5.6, 4.4]
  const edge = (p: number[], q: number[]) => {
    const ex = q[0]! - p[0]!, ey = q[1]! - p[1]!, length = Math.hypot(ex, ey)
    return ((x - p[0]!) * ey - (y - p[1]!) * ex) / length
  }
  return Math.max(edge(a, b), edge(b, c), edge(c, a))
}

type Box = { x: number; y: number; width: number; height: number }
export type CipherLeg = {
  path: SVGPathElement; length: number; ease: Crossing["ease"]; send: number
  /** Path fractions over which the gate opens the packet. */
  zone: { from: number; to: number }
  /** The destination route's id, for its icon, and its shape. */
  route: string
  shape: number
  /** Path fraction at your machine's border. */
  border: number
}

const INK = [232, 228, 220] as const
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }
const hash = (a: number, b: number) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x) }

/** A seeded permutation of n. */
function shuffle(n: number, seed: number) {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(hash(seed, i) * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!] }
  return order
}

/** The route's icon, rasterised once from the card's own SVG, in ivory. */
const icons = new Map<string, HTMLCanvasElement | "loading">()
function iconFor(route: string, size: number): HTMLCanvasElement | undefined {
  const key = `${route}:${size}`
  const cached = icons.get(key)
  if (cached) return cached === "loading" ? undefined : cached
  const svg = document.querySelector(`[data-node="${route}"] .node-card-icon svg`)
  if (!svg) return undefined
  icons.set(key, "loading")
  const clone = svg.cloneNode(true) as SVGElement
  clone.setAttribute("width", String(size)); clone.setAttribute("height", String(size))
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  const markup = new XMLSerializer().serializeToString(clone).replaceAll("currentColor", "#e8e4dc")
  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = size
    canvas.getContext("2d")!.drawImage(image, 0, 0, size, size)
    icons.set(key, canvas)
  }
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  return undefined
}

export function CipherCanvas({ style, clock, legs, width, height, hide, origin, gate, travel, gather }: {
  style: CipherStyle; clock: MotionValue<number>; legs: readonly CipherLeg[]; width: number; height: number
  /** Cards the packet passes behind (the browser, the relay). */
  hide: readonly Box[]
  /** The browser card, where the destination is chosen. */
  origin: Box
  /** Where the gate is: the border's x, the wire's y, and how far the opening stretch runs into your machine. */
  gate: { x: number; y: number; depth: number }
  travel: number; gather: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element || style === "glyphs") return
    const ctx = element.getContext("2d")!
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    element.width = Math.round(width * dpr); element.height = Math.round(height * dpr)
    const sprite = document.createElement("canvas")
    const spriteContext = sprite.getContext("2d")!
    const compact = gate.depth < 24

    const drawMoire = (t: number, k: number, fade: number, seed: number) => {
      const W = Math.round((compact ? 16 : 24) * dpr), H = Math.round((compact ? 10 : 12) * dpr)
      if (sprite.width !== W || sprite.height !== H) { sprite.width = W; sprite.height = H }
      const image = spriteContext.createImageData(W, H)
      const s = 2 * dpr, radius = (compact ? 2.8 : 3.8) * dpr
      // The key aligns over the first 60% of the gate; the disk then holds in clean lines before it fills in.
      const sealed = 1 - smooth(k / .6)
      const key = smooth(k / .3)
      const theta = sealed * .45 * Math.sin(t * 2.3 + seed), delta = sealed * .24
      const cos = Math.cos(theta), sin = Math.sin(theta), drift = sealed * s * Math.sin(t * 5 + seed)
      const tick = Math.floor(t * 14)
      const fill = smooth((k - .85) / .15)
      for (let y = 0; y < H; y++) {
        const cy = y - H / 2 + .5
        // Sealed: each row of the grating is torn sideways and the whole block ripples.
        const tear = (hash(Math.floor(cy / dpr) + seed * 13, tick) - .5) * s * 2.2 * sealed
        const warp = Math.sin(cy * .55 / dpr + t * 7) * s * .6 * sealed
        for (let x = 0; x < W; x++) {
          const cx = x - W / 2 + .5
          const inside = cx * cx + cy * cy < radius * radius
          const a = ((cx + tear + warp + (inside ? s / 2 : 0)) / s % 1 + 1) % 1 < .5
          const u = ((cx * cos + cy * sin) * (1 + delta) + drift) / s
          const band = (u % 1 + 1) % 1 < .5
          let v = a ? (band ? 1 - key : 1) : 0
          if (inside) v = Math.max(v, fill)
          else v *= 1 - fill * .9
          // The packet's edge: a hairline frame while sealed, gone once open.
          const edge = (x === 0 || y === 0 || x === W - 1 || y === H - 1) ? .5 * (1 - fill) : 0
          const alpha = Math.max(v * (.55 + .45 * k), edge) * fade
          const i = (y * W + x) * 4
          image.data[i] = INK[0]; image.data[i + 1] = INK[1]; image.data[i + 2] = INK[2]; image.data[i + 3] = alpha * 255
        }
      }
      spriteContext.putImageData(image, 0, 0)
      return sprite
    }

    const drawTiles = (t: number, k: number, fade: number, leg: CipherLeg, entered: number) => {
      const N = 4, T = (compact ? 3 : 4) * dpr, size = N * T
      const pad = Math.round(2 * dpr), W = Math.round(size + pad * 2)
      if (sprite.width !== W || sprite.height !== W) { sprite.width = W; sprite.height = W }
      spriteContext.clearRect(0, 0, W, W)
      const icon = iconFor(leg.route, Math.round(size))
      // Sealed: a new arrangement nine times a second, each tile sliding to its next place and turned.
      const rate = 9
      const at = k > 0 ? entered : t
      const tick = Math.floor(at * rate), phase = k > 0 ? 1 : smooth((at * rate - tick) / .45)
      const now = shuffle(N * N, tick + leg.send * 7), before = shuffle(N * N, tick - 1 + leg.send * 7)
      spriteContext.globalAlpha = fade
      for (let i = 0; i < N * N; i++) {
        const home = { x: i % N, y: Math.floor(i / N) }
        const slot = (order: number[]) => { const j = order.indexOf(i); return { x: j % N, y: Math.floor(j / N) } }
        const from = slot(before), to = slot(now)
        const scrambled = { x: from.x + (to.x - from.x) * phase, y: from.y + (to.y - from.y) * phase }
        // Opening: a diagonal wave from the gate's side carries each tile home and squares it up.
        const delay = ((N - 1 - home.x) + home.y) / (2 * (N - 1)) * .45
        const settle = smooth((k - delay) / .45)
        const x = scrambled.x + (home.x - scrambled.x) * settle, y = scrambled.y + (home.y - scrambled.y) * settle
        const turn = Math.floor(hash(i, tick) * 4) * Math.PI / 2 * (1 - settle)
        spriteContext.save()
        spriteContext.translate(pad + (x + .5) * T, pad + (y + .5) * T)
        spriteContext.rotate(turn)
        spriteContext.globalAlpha = fade * (.55 + .45 * settle)
        if (icon) spriteContext.drawImage(icon, home.x * T, home.y * T, T, T, -T / 2, -T / 2, T, T)
        else { spriteContext.fillStyle = "#e8e4dc"; spriteContext.fillRect(-T / 2 + .5, -T / 2 + .5, T - 1, T - 1) }
        spriteContext.restore()
      }
      // While sealed the block reads as a parcel: a hairline around it.
      spriteContext.globalAlpha = fade * .45 * (1 - smooth(k / .6))
      spriteContext.strokeStyle = "#e8e4dc"; spriteContext.lineWidth = 1
      spriteContext.strokeRect(.5, .5, W - 1, W - 1)
      spriteContext.globalAlpha = 1
      return sprite
    }

    // The shape story. The browser spins a reel of the three shapes and settles on the request's destination. The
    // chosen shape slides out, and every grain that passes the browser's border crumbles into churning static: it is
    // sealed by leaving. It travels sealed. At your machine's border it crawls through the membrane, and every grain
    // past that line condenses back into the shape: it is opened by arriving. Then it rides the wire to the slot of
    // the same shape on its app and plugs in.
    const shapePath = (shape: number, x: number, y: number, size: number) => {
      ctx.beginPath()
      if (shape === 0) ctx.arc(x, y, 5 * size, 0, Math.PI * 2)
      else if (shape === 1) { ctx.moveTo(x, y - 5.6 * size); ctx.lineTo(x + 5.6 * size, y + 4.4 * size); ctx.lineTo(x - 5.6 * size, y + 4.4 * size); ctx.closePath() }
      else ctx.rect(x - 4.4 * size, y - 4.4 * size, 8.8 * size, 8.8 * size)
    }
    const S = 20
    // Sealed, the packet is a corrupted signal rather than noise: a disk of fine scanlines, each carrying broken
    // dashes of data that drift along it; the lines slide against each other, and every so often a tear jolts a
    // band of them sideways and breaks the disk's edge. Both borders cut through it a scanline at a time.
    const noise1 = (x: number, seed: number) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u }
    const drawPacket = (t: number, shape: number, centre: number, seal: number, open: number, fade: number, seed: number) => {
      const W = Math.round(S * dpr)
      if (sprite.width !== W || sprite.height !== W) { sprite.width = W; sprite.height = W }
      const image = spriteContext.createImageData(W, W)
      const line = 1 / dpr * Math.max(1, Math.round(dpr * .75))     // scanline height, CSS px (one device row on 1×, ~one on 2×)
      const jolt = Math.floor(t * 7)                                  // tears are re-cut seven times a second
      const radius = 7
      for (let y = 0; y < W; y++) {
        const py = (y + .5) / dpr - S / 2
        const row = Math.floor((py + S / 2) / line)
        // Each scanline drifts on its own slow wave; a tear throws a band of them sideways for a moment.
        const drift = (noise1(row * .35 + t * 1.3, seed * 7 + 1) - .5) * 2.2
        const band = Math.floor(row / 3)
        const torn = hash(band + seed * 13, jolt) > .78 ? (hash(band * 3.1 + seed, jolt + 9) - .5) * 7 : 0
        const shift = drift + torn
        const rowLight = .45 + .55 * hash(row + seed * 5, Math.floor(t * 3 + row * .07))
        // Where each border's front reaches on this scanline: ragged per line, so it cuts the packet a line at a time.
        const ragged = (hash(row * 1.7 + seed, 4) - .5) * 3.2
        for (let x = 0; x < W; x++) {
          const px = (x + .5) / dpr - S / 2
          const solid = clamp01(.5 - shapeDistance(shape, px, py) * dpr)
          // The disk, its edge broken by the same tears that shift its lines.
          const r = Math.hypot(px - torn * .35, py)
          const disk = clamp01((radius + (noise1(py * .9 + t * 2, seed) - .5) * 1.4 - r) * dpr)
          // Data along the line: long dashes of varying length, flowing; every other scanline is a dark gap.
          const u = (px + shift) * .42 + row * 13.7 + t * (1.4 + (row % 3) * .5)
          const dash = smooth((noise1(u, seed + row * 3) - .4) / .14)
          const gap = row % 2 === 0 ? 1 : .14
          const sealed = disk * (.1 + .9 * dash * rowLight * gap)
          // Sealed once past the browser's border, opened once past your machine's.
          const out = smooth((centre + px - seal + ragged) / 1.6 + .5)
          const home = smooth((centre + px - open + ragged) / 1.6 + .5)
          const amount = out * (1 - home)
          const value = sealed * amount + solid * (1 - amount)
          const i = (y * W + x) * 4
          image.data[i] = INK[0]; image.data[i + 1] = INK[1]; image.data[i + 2] = INK[2]; image.data[i + 3] = value * fade * 255
        }
      }
      spriteContext.putImageData(image, 0, 0)
      return sprite
    }

    const drawShapes = (t: number) => {
      const packets: (() => void)[] = []
      // On a phone the reel takes the browser icon's place (the scene fades the globe while the browser chooses).
      const reel = { ...reelCentre(origin), half: origin.height / 2 - 4 }
      const exit = origin.x + origin.width
      // The slots on the apps' edges where the wires end, in their shapes: each fills when a shape plugs in and cools
      // back to an outline. One per app, however many requests go to it.
      const slots = new Map<string, { end: { x: number; y: number }; shape: number; lit: number; plugged: number }>()
      for (const leg of legs) {
        const before = sinceSend(t, leg.send), u = before / travel
        const since = before - travel
        const slot = slots.get(leg.route) ?? { end: leg.path.getPointAtLength(leg.length), shape: leg.shape, lit: 0, plugged: 0 }
        slot.plugged = Math.max(slot.plugged, since >= 0 ? Math.exp(-since * 1.1) : 0)
        slot.lit = Math.max(slot.lit, slot.plugged, u > 0 && u < 1 ? smooth((u - .85) / .15) * .4 : 0)
        slots.set(leg.route, slot)
      }
      for (const { end, shape, lit, plugged } of slots.values()) packets.push(() => {
        ctx.save()
        ctx.fillStyle = "#000"; shapePath(shape, end.x, end.y, 1.05); ctx.fill()
        ctx.lineWidth = 1; ctx.strokeStyle = `rgba(232,228,220,${.42 + .58 * lit})`
        shapePath(shape, end.x, end.y, 1); ctx.stroke()
        if (plugged > .002) { ctx.globalAlpha = plugged; ctx.fillStyle = "#e8e4dc"; shapePath(shape, end.x, end.y, 1); ctx.fill() }
        ctx.restore()
      })
      for (const leg of legs) {
        const before = sinceSend(t, leg.send)  // negative while the browser chooses
        const u = before / travel
        if (before < -chooseSeconds() || u >= 1) continue
        const spinStart = -chooseSeconds(), slideStart = -choosing.slide
        if (before < slideStart + .05) {
          // The reel: shapes a slot apart, spun up and eased to a stop on the destination with a hair of overshoot.
          // Linear fades at its top and bottom.
          const x = clamp01((before - spinStart) / choosing.spin), slots = reelSlots(), gap = 17
          const offset = reelOffset(x)
          const first = ((leg.shape - slots) % 3 + 3) % 3
          // The reel's speed, in pixels a second, for its motion blur: a shutter of a fortieth of a second.
          const h = .004, velocity = (reelOffset(Math.min(1, x + h)) - reelOffset(Math.max(0, x - h))) / (Math.min(1, x + h) - Math.max(0, x - h)) / choosing.spin * gap
          const blur = Math.min(gap * .9, Math.abs(velocity) / 40)
          // Always the same number of samples, each faint enough that stacked exactly they make the crisp shape, so the
          // blur grows and shrinks smoothly with speed (switching sample counts made it flicker).
          const samples = 7
          const others = 1 - smooth((before - (slideStart - choosing.rest)) / Math.max(.1, choosing.rest + .15))
          const appear = clamp01((before - spinStart) / .25)
          // Landing: the chosen shape pops on a little spring and flashes bright.
          const since = before - (spinStart + choosing.spin)
          const pop = since >= 0 ? 1 + .3 * Math.exp(-since * 7) * Math.cos(since * 17) : 1
          packets.push(() => {
            ctx.save()
            ctx.beginPath(); ctx.rect(origin.x + 1, origin.y + 1, origin.width - 2, origin.height - 2); ctx.clip()
            for (let j = Math.floor(offset) - 3; j <= Math.ceil(offset) + 3; j++) {
              const centre = (j - offset) * gap
              if (Math.abs(centre) > reel.half + gap) continue
              const chosen = j === slots
              if (chosen && before >= slideStart) continue
              const weight = appear * (chosen ? .55 + .45 * smooth((x - .7) / .3) : .55 * others)
              if (weight <= .002) continue
              ctx.fillStyle = chosen && since >= 0 ? `rgba(255,250,240,1)` : "#e8e4dc"
              // Motion blur: the shape smeared along the reel over the shutter, each sample faded by the reel's edge mask.
              for (let k = 0; k < samples; k++) {
                const dy = centre + (k / (samples - 1) - .5) * blur
                const mask = 1 - Math.abs(dy) / reel.half
                if (mask <= 0) continue
                ctx.globalAlpha = 1 - Math.pow(1 - Math.min(.999, weight * mask), 1 / samples)
                shapePath((first + j) % 3, reel.x, reel.y + dy, .85 * (chosen ? pop : 1))
                ctx.fill()
              }
            }
            ctx.restore()
          })
        }
        // The flash as the reel lands, following the shape out: a soft bloom and a thin ring, decaying together.
        {
          const since = before - (-chooseSeconds() + choosing.spin)
          if (since >= 0 && since < .9) {
            const at = before < -choosing.slide ? reel : packetCentre(leg, t, origin, travel) ?? reel
            const fade = Math.exp(-since * 4.5)
            packets.push(() => {
              ctx.save()
              ctx.beginPath(); ctx.rect(origin.x + 1, origin.y + 1, origin.width - 2, origin.height - 2); ctx.clip()
              const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 16 + 10 * since)
              glow.addColorStop(0, `rgba(255,250,240,${.32 * fade})`); glow.addColorStop(1, "rgba(255,250,240,0)")
              ctx.fillStyle = glow; ctx.fillRect(at.x - 30, at.y - 30, 60, 60)
              ctx.globalAlpha = .55 * fade * (1 - since / .9)
              ctx.strokeStyle = "#fffaf0"; ctx.lineWidth = 1
              ctx.beginPath(); ctx.arc(at.x, at.y, 7 + 26 * (1 - Math.exp(-since * 5)), 0, Math.PI * 2); ctx.stroke()
              ctx.restore()
            })
          }
        }
        if (before < slideStart) continue
        // Out of the browser: the chosen shape slides from the reel through the card's border to the socket, then
        // rides the wire.
        const position = packetCentre(leg, t, origin, travel)!
        const seed = leg.send
        packets.push(() => {
          // Sealed and opened along the membranes, which bow as the packet presses through them.
          const sealAt = exit + gateBow * gatePush(position.x - exit), open = gate.x + gateBow * gatePush(position.x - gate.x)
          const image = drawPacket(t, leg.shape, position.x, sealAt, open, 1, seed)
          ctx.drawImage(image, position.x - S / 2, position.y - S / 2, S, S)
        })
      }
      return packets
    }

    let raf = 0
    const draw = () => {
      raf = 0
      const t = clock.get()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, element.width, element.height)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (style === "shapes") {
        // Only the relay hides the packet: the reel and the slide live inside the browser card.
        const packets = drawShapes(t)
        ctx.save()
        ctx.beginPath(); ctx.rect(0, 0, width, height)
        for (const box of hide.slice(1)) ctx.rect(box.x, box.y, box.width, box.height)
        ctx.clip("evenodd")
        for (const paint of packets) paint()
        ctx.restore()
        return
      }
      let awake = 0
      const packets: (() => void)[] = []
      for (const leg of legs) {
        const u = (t - leg.send) / travel
        if (u < -gather / travel || u > 1) continue
        const progress = u <= 0 ? 0 : leg.ease.at(u)
        const condense = clamp01((progress - leg.zone.to) / (10 / leg.length))
        if (condense >= 1) continue
        const k = clamp01((progress - leg.zone.from) / (leg.zone.to - leg.zone.from))
        awake = Math.max(awake, Math.min(smooth((progress - leg.zone.from + 30 / leg.length) / (30 / leg.length)), 1 - condense))
        const head = leg.path.getPointAtLength(Math.min(1, progress) * leg.length)
        const arriving = clamp01((u * travel + gather) / gather)
        const fade = arriving * (1 - condense)
        const entered = leg.send + leg.ease.inverse(leg.zone.from) * travel
        // The gate captures the packet: it is drawn into the lock, opened there, and let go.
        const held = smooth(k / .18) * (1 - smooth((k - .82) / .18))
        const lockX = gate.x + gate.depth * .5
        const x = head.x + (lockX - head.x) * held
        packets.push(() => {
          const image = style === "moire" ? drawMoire(t, k, fade, leg.send) : drawTiles(t, k, fade, leg, entered)
          ctx.drawImage(image, x - image.width / dpr / 2, head.y - image.height / dpr / 2, image.width / dpr, image.height / dpr)
        })
      }
      // The gate's lock, faint until a packet is in it: the key grating, or the empty frame the tiles fall into.
      const lock = .1 + .35 * awake
      const mid = gate.x + gate.depth * .5
      ctx.fillStyle = `rgba(232,228,220,${lock})`
      if (style === "moire") {
        const h = compact ? 12 : 16, w = (compact ? 16 : 24) + 6
        for (let x = mid - w / 2; x < mid + w / 2; x += 2) ctx.fillRect(x, gate.y - h / 2, 1, h)
      } else {
        const T = compact ? 3 : 4, size = 4 * T, x0 = mid - size / 2, y0 = gate.y - size / 2
        ctx.strokeStyle = `rgba(232,228,220,${lock})`; ctx.lineWidth = .5
        for (let i = 0; i <= 4; i++) {
          ctx.beginPath(); ctx.moveTo(x0 + i * T, y0); ctx.lineTo(x0 + i * T, y0 + size); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(x0, y0 + i * T); ctx.lineTo(x0 + size, y0 + i * T); ctx.stroke()
        }
      }
      // Packets pass behind the browser and relay cards: the relay shows its own burn while they are inside.
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, width, height)
      for (const box of hide) ctx.rect(box.x, box.y, box.width, box.height)
      ctx.clip("evenodd")
      for (const paint of packets) paint()
      ctx.restore()
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const stop = clock.on("change", request)
    request()
    return () => { stop(); if (raf) cancelAnimationFrame(raf); ctx.clearRect(0, 0, element.width, element.height) }
  }, [style, clock, legs, width, height, hide, origin, gate, travel, gather])
  return <canvas ref={canvas} className="tunnel-cipher-canvas" style={{ width, height }} aria-hidden="true" />
}
