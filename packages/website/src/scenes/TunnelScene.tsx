import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react"
import { motion, useMotionValue, useMotionValueEvent, useTransform, type MotionStyle, type MotionValue } from "motion/react"
import { DiagramFrame, NodeCard } from "../graphics/Diagram"
import { GraphPort, GraphSignals, GraphWire } from "../graphics/GraphSignals"
import { CardGlow, Pulse, pulseGatherMs } from "../graphics/Pulse"
import { pluginActivity, pluginActivityAt, usePluginActivity } from "../graphics/pluginActivity"
import { useScenePlayback } from "../graphics/useScenePlayback"
import { tunnelLegs, tunnelRoutes, tunnelScore, tunnelTravel } from "./tunnelScore"
import { RelayField, type RelayFront } from "./RelayField"
import { useTunnelSounds } from "./tunnelSounds"
import { toggleSounds, useSoundReady, useSounds } from "../sound/sounds"
import { BurstField } from "./BurstField"
import { Globe } from "./Globe"
import { borderCrawl, legCrossing, type Crossing } from "./tunnelFlight"
import { CipherCanvas, choosingAt, cipherStyles, packetCentre, type CipherLeg, type CipherStyle } from "./Cipher"
import { GateField, gatePush, type GateTouch } from "./GateField"
import { flightTuning } from "./flightTuning"
import { TuningPanel } from "../TuningPanel"
import { ArrowsLeftRight, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react"
import "./tunnel-scene.css"

// browser ──▶ relay ──▶│opencode
//                       │╲──▶ api          (your machine)
//                       │ ╲─▶ webhooks
//
// opentunnel is the left border of your machine: the one place the bytes come in, and where they are opened.
//
// HTML frames carry the anatomy; one SVG overlay measures them and draws wires,
// sockets, pulses and light, as the blog's shipped diagrams do. Each leg is one
// pulse that passes through the relay: the dot goes behind the card while the
// field inside burns where the bytes pass and finds only hatching, then leaves
// by the far socket.

type Box = { x: number; y: number; width: number; height: number }
type Bounds = { width: number; height: number; browser: Box; relay: Box; machine: Box; routes: Box[] }

/** The frame's 1px border, traced along its centre. */
const outlineOf = (box: Box) => `M${box.x + .5} ${box.y + .5}h${box.width - 1}v${box.height - 1}h${1 - box.width}Z`

/** Each app is a plain shape, so the request the browser picks can be matched at a glance where it lands. */
function ShapeIcon({ shape }: { shape: number }) {
  return <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    {shape === 0 ? <circle cx={8} cy={8} r={5} /> : shape === 1 ? <path d="M8 2.4L13.6 12.4H2.4Z" /> : <rect x={3.6} y={3.6} width={8.8} height={8.8} />}
  </svg>
}

function Browser({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches: tunnelLegs.map(leg => leg.start), reduced })
  return <NodeCard name="browser" icon={<Globe clock={clock} reduced={reduced} period={tunnelScore.duration} />} data-node="browser" aria-label="A visitor's browser" {...inks}>
    {!reduced && <BurstField clock={clock} at={tunnelLegs.map(leg => leg.start)} origin={[1, .5]} mode="ember" className="tunnel-card-field" />}
  </NodeCard>
}

function Relay({ clock, reduced, crossings, fronts, now }: { clock: MotionValue<number>; reduced: boolean; crossings: readonly Crossing[]; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number> }) {
  // Working while the bytes are inside: the icon holds bright while the field is lit.
  const inks = usePluginActivity(clock, { dispatches: [], running: crossings.map(c => [c.enter, c.leave] as const), reduced })
  return <>
    <NodeCard name="*.opentunnel.xyz" icon={<ArrowsLeftRight size={16} />} data-node="relay" aria-label="The relay, which cannot decrypt" {...inks}>
      {!reduced && <RelayField fronts={fronts} now={now} className="tunnel-relay-field" />}
    </NodeCard>
  </>
}

function Route({ index, clock, reduced, slotted }: { index: number; clock: MotionValue<number>; reduced: boolean; slotted: boolean }) {
  const route = tunnelRoutes[index]!, contacts = tunnelLegs.filter(leg => leg.route === index).map(leg => leg.contact)
  // The destination flashes as the bytes land and cools over the next second; its icon flashes and decays with the name.
  const activity = { dispatches: contacts, reduced }
  const inks = usePluginActivity(clock, activity)
  const { rest, active } = pluginActivity.icon
  inks.iconColor = useTransform(clock, time => { const n = Math.round(rest + pluginActivityAt(time, activity).flash * (active - rest)); return `rgb(${n} ${n} ${n})` })
  return <NodeCard name={route.name} icon={<ShapeIcon shape={route.shape} />} data-slotted={slotted || undefined} data-node={route.id} aria-label={`${route.name} on ${route.target}`} {...inks}>
    {!reduced && <BurstField clock={clock} at={contacts} origin={[0, .5]} mode="strike" className="tunnel-card-field" />}
    <span className="node-card-detail">{route.target}</span>
  </NodeCard>
}

/** Where along a path (0..1) x first reaches `x`, by bisection on a detached copy. */
function fractionAtX(path: SVGPathElement, length: number, x: number) {
  let low = 0, high = 1
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2
    if (path.getPointAtLength(mid * length).x < x) low = mid; else high = mid
  }
  return (low + high) / 2
}

const smoothstep01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=#%&*$@"
const scramble = (slot: number, tick: number) => {
  const x = Math.sin(slot * 91.7 + tick * 47.3) * 43758.5453
  return GLYPHS[Math.floor((x - Math.floor(x)) * GLYPHS.length)]!
}
const MAX_GLYPHS = 12

/** The request as the relay sees it: a short train of ciphertext riding the wire behind the dot, each glyph changing
 * on its own beat. At your machine's border it parks; brackets lock on, a scan line sweeps out from the gate, and each
 * glyph resolves into the plaintext request as the beam crosses it. Then the words draw in on themselves and go
 * through as the light. Where there is no room for words (phones), the scan runs over the bare dot. */
function Packet({ clock, path, length, ease, send, opened, crossing, plaintext, room }: {
  clock: MotionValue<number>; path: SVGPathElement; length: number; ease: Crossing["ease"]; send: number; opened: number
  crossing: Crossing; plaintext: string; room: number
}) {
  const group = useRef<SVGGElement>(null)
  const glyphs = useRef<(SVGTextElement | null)[]>([])
  const brackets = useRef<SVGPathElement>(null)
  const beam = useRef<SVGGElement>(null)
  const wash = useRef<SVGRectElement>(null)
  const ADVANCE = 6.1
  // As many glyphs as the stretch of wire before the gate can hold, up to the request's own length.
  const count = Math.min(MAX_GLYPHS, plaintext.length, Math.max(0, Math.floor((room - 14) / ADVANCE)))
  const text = plaintext.slice(-count)
  const paint = (seconds: number) => {
    const root = group.current
    if (!root) return
    const flight = tunnelTravel / 1000
    const u = (seconds - send) / flight
    const progress = u <= 0 ? 0 : ease.at(Math.min(1, u))
    const gathering = pulseGatherMs / 1000 / flight
    const collapse = 16 / length
    if (u < -gathering || progress >= opened + collapse) { root.setAttribute("opacity", "0"); return }
    root.setAttribute("opacity", "1")
    const head = path.getPointAtLength(Math.min(progress, opened) * length)
    const arriving = Math.min(1, (u + gathering) / gathering)
    // Scan progress through the pause: 0 arriving, brackets by .15, beam sweeps .15–.75, plaintext holds after.
    const gate = crossing.gate
    const scan = gate ? Math.max(0, Math.min(1, (seconds - gate.start) / (gate.end - gate.start))) : (progress >= opened ? 1 : 0)
    const lock = smoothstep01(scan / .15)
    const sweep = smoothstep01((scan - .15) / .6)
    // Through the gate: the words draw in on themselves into the point where the light comes out.
    const through = Math.max(0, Math.min(1, (progress - opened) / collapse))
    const right = head.x - 5, left = right - count * ADVANCE
    const beamX = right - (right - left) * sweep
    for (let i = 0; i < MAX_GLYPHS; i++) {
      const glyph = glyphs.current[i]
      if (!glyph) continue
      if (i >= count) { glyph.setAttribute("opacity", "0"); continue }
      const home = left + (i + .5) * ADVANCE
      const x = home + (head.x - home) * smoothstep01(through)
      const revealed = scan > .15 && beamX <= home + ADVANCE * .5
      // Each glyph keeps its own beat; just before the beam reaches it, it churns faster.
      const rate = 13 + (i * 7) % 9 + (scan > .1 && !revealed ? 10 : 0)
      glyph.textContent = revealed ? text[i]! : scramble(i, Math.floor(seconds * rate + i * .37))
      glyph.setAttribute("x", String(x)); glyph.setAttribute("y", String(head.y))
      const trail = .45 + .55 * Math.pow((i + 1) / count, 1.5)
      glyph.setAttribute("opacity", String(arriving * (1 - through) * (revealed ? 1 : .62 * trail)))
      glyph.setAttribute("class", revealed ? "tunnel-packet-glyph is-plain" : "tunnel-packet-glyph")
    }
    const scanning = gate ? Math.min(lock, 1 - smoothstep01((seconds - gate.end) / .2)) * (1 - through) : 0
    // Brackets: four corner ticks that close in on the packet (or on the bare dot) as the gate locks on.
    const pad = 4 + 6 * (1 - lock), x0 = (count ? left : head.x - 8) - pad, x1 = head.x + 1 + pad * .4, y0 = head.y - 9 - pad * .5, y1 = head.y + 9 + pad * .5, t = 4
    brackets.current?.setAttribute("d", `M${x0} ${y0 + t}V${y0}H${x0 + t}M${x1 - t} ${y0}H${x1}V${y0 + t}M${x1} ${y1 - t}V${y1}H${x1 - t}M${x0 + t} ${y1}H${x0}V${y1 - t}`)
    brackets.current?.setAttribute("opacity", String(scanning * .8))
    // The beam: a hairline sweeping out from the gate, with the scanned stretch washed faintly behind it.
    const shownBeam = scanning * (scan > .12 && scan < .82 ? 1 : 0)
    const bx = count ? beamX : head.x - 8 * sweep
    beam.current?.setAttribute("transform", `translate(${bx} ${head.y})`)
    beam.current?.setAttribute("opacity", String(shownBeam))
    if (wash.current) {
      wash.current.setAttribute("x", String(bx)); wash.current.setAttribute("y", String(head.y - 9))
      wash.current.setAttribute("width", String(Math.max(0, head.x - bx))); wash.current.setAttribute("opacity", String(scanning * .07))
    }
  }
  useMotionValueEvent(clock, "change", paint)
  useEffect(() => paint(clock.get()))
  return <g ref={group} className="tunnel-packet" opacity={0}>
    <rect ref={wash} height={18} fill="#e8e4dc" opacity={0} />
    {Array.from({ length: MAX_GLYPHS }, (_, i) => <text key={i} ref={element => { glyphs.current[i] = element }} className="tunnel-packet-glyph" textAnchor="middle" dominantBaseline="central" opacity={0} />)}
    <path ref={brackets} fill="none" stroke="#e8e4dc" strokeWidth={1} opacity={0} />
    <g ref={beam} opacity={0}>
      <line x1={0} x2={0} y1={-12} y2={12} stroke="#e8e4dc" strokeWidth={3} opacity={.18} />
      <line x1={0} x2={0} y1={-11} y2={11} stroke="#fffaf0" strokeWidth={1} />
    </g>
  </g>
}

/** Wires, sockets, pulses and light over the measured frames. */
function TunnelSignals({ clock, reduced, panels, onCrossings, fronts, now, cipher }: { clock: MotionValue<number>; reduced: boolean; panels: RefObject<HTMLDivElement | null>; onCrossings: (crossings: Crossing[]) => void; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number>; cipher: CipherStyle }) {
  // Development: the flights are rebuilt whenever their timings are tuned.
  const tuned = useSyncExternalStore(flightTuning.subscribe, flightTuning.get)
  const id = useId().replace(/:/g, "")
  const milliseconds = useTransform(clock, seconds => seconds * 1000)
  const [bounds, setBounds] = useState<Bounds>()
  useEffect(() => {
    const root = panels.current
    if (!root) return
    const measure = () => {
      const origin = root.getBoundingClientRect()
      const box = (element: Element): Box => {
        const rect = element.getBoundingClientRect()
        return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height }
      }
      const node = (name: string) => root.querySelector(`[data-node="${name}"]`)!
      setBounds({
        width: root.clientWidth, height: root.clientHeight,
        browser: box(node("browser")), relay: box(node("relay")), machine: box(root.querySelector("[data-machine]")!),
        routes: tunnelRoutes.map(route => box(node(route.id))),
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const element of root.querySelectorAll("[data-node], [data-machine]")) observer.observe(element)
    return () => observer.disconnect()
  }, [panels])

  const geometry = useMemo(() => {
    if (!bounds) return null
    const { browser, relay, machine, routes } = bounds
    const middle = (box: Box) => box.y + box.height / 2
    const browserOut = { x: browser.x + browser.width, y: middle(browser) }
    const relayIn = { x: relay.x, y: middle(relay) }
    const relayOut = { x: relay.x + relay.width, y: middle(relay) }
    const routeIn = (box: Box) => ({ x: box.x, y: middle(box) })
    // One wire into your machine, level with the relay; inside, it fans out to the apps.
    const entry = { x: machine.x, y: relayOut.y }
    // The gate: a straight stretch of wire just inside your machine's border where a sealed packet is opened;
    // the fan to the apps starts after it.
    const gateDepth = Math.max(14, Math.min(36, (routes[0]!.x - machine.x) * .5))
    const fan = entry.x + gateDepth
    const hop = (box: Box) => {
      const input = routeIn(box)
      if (Math.abs(input.y - entry.y) < 1) return `H${input.x}`
      const spine = (fan + input.x) / 2
      return `H${fan}C${spine} ${entry.y} ${spine} ${input.y} ${input.x} ${input.y}`
    }
    const through = `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}L${relayOut.x} ${relayOut.y}L${entry.x} ${entry.y}`
    const legs = tunnelLegs.map((request, index) => {
      const box = routes[request.route]!
      const d = through + hop(box)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", d)
      const length = path.getTotalLength()
      const enter = fractionAtX(path, length, relay.x), leave = fractionAtX(path, length, relay.x + relay.width)
      // Until the bytes cross into your machine they are ciphertext. The glyph train parks just short of the border;
      // a sealed packet crawls through the gate, a stretch just inside it, while it is opened.
      const opened = fractionAtX(path, length, machine.x)
      const zone = { from: fractionAtX(path, length, machine.x - 4), to: fractionAtX(path, length, machine.x + gateDepth) }
      const gate = cipher === "glyphs" ? { gate: opened - 2 / length, gateWidth: 18 / length }
        // Shapes are opened by the border line itself: the packet crawls across it.
        : cipher === "shapes" ? { gate: opened, gateWidth: borderCrawl.gate.reach / length, exit: 4 / length, exitWidth: borderCrawl.exit.reach / length }
        : { gate: (zone.from + zone.to) / 2, gateWidth: zone.to - zone.from + 8 / length }
      // Through the relay the bytes move as through something thick, and they slow at the gate: the crossing knows when, and how fast.
      const crossing = legCrossing(index, { enter, leave, ...gate })
      return { d, path, length, ease: crossing.ease, crossing, opened, zone }
    })
    return { browserOut, relayIn, relayOut, routeIn, entry, gateDepth, legs, wires: { request: `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`, toMachine: `M${relayOut.x} ${relayOut.y}L${entry.x} ${entry.y}`, hops: routes.map(box => `M${entry.x} ${entry.y}${hop(box)}`) } }
  }, [bounds, cipher, tuned])

  // The relay's field follows every dot in flight: each one's position across the card's interior, and scene time.
  useMotionValueEvent(clock, "change", seconds => {
    now.set(seconds)
    if (!geometry || !bounds) { fronts.set([]); return }
    const flight = tunnelTravel / 1000
    const inner = { x: bounds.relay.x + 1, width: bounds.relay.width - 2 }
    const active: RelayFront[] = []
    for (const [index, leg] of geometry.legs.entries()) {
      const { send } = tunnelLegs[index]!
      const t = seconds - send
      if (t < 0 || t > flight) continue
      const x = leg.path.getPointAtLength(leg.ease.at(t / flight) * leg.length).x
      active.push({ leg: index, x: (x - inner.x) / inner.width })
    }
    fronts.set(active)
  })

  const crossings = useMemo(() => geometry ? geometry.legs.map(leg => leg.crossing) : [], [geometry])
  useEffect(() => { if (geometry) onCrossings(crossings) }, [geometry, crossings, onCrossings])
  const cipherLegs = useMemo<CipherLeg[]>(() => geometry ? geometry.legs.map((leg, index) => ({ path: leg.path, length: leg.length, ease: leg.ease, send: tunnelLegs[index]!.send, zone: leg.zone, route: tunnelRoutes[tunnelLegs[index]!.route].id, shape: tunnelRoutes[tunnelLegs[index]!.route].shape, border: leg.opened })) : [], [geometry])
  const hidden = useMemo(() => bounds ? [bounds.browser, bounds.relay] : [], [bounds])
  // What each membrane feels: the browser's as the chosen shape leaves (it crosses at the send), your machine's as it
  // arrives (it crosses at the border's path fraction).
  const touches = useMemo(() => {
    if (!bounds) return undefined
    const travel = tunnelTravel / 1000
    const feel = (border: number, crossedAt: (leg: CipherLeg) => number) => (t: number): GateTouch => {
      let push = 0, approach = 0, sinceCross = 99
      for (const leg of cipherLegs) {
        const crossed = crossedAt(leg)
        if (t >= crossed) sinceCross = Math.min(sinceCross, t - crossed)
        const centre = packetCentre(leg, t, bounds.browser, travel)
        if (!centre) continue
        const dx = centre.x - border
        push = Math.max(push, gatePush(dx))
        if (dx < 0) approach = Math.max(approach, Math.exp(dx / 60))
      }
      return { push, approach, sinceCross }
    }
    return {
      browser: feel(bounds.browser.x + bounds.browser.width, leg => leg.send),
      machine: feel(bounds.machine.x, leg => leg.send + leg.ease.inverse(leg.border) * travel),
    }
  }, [bounds, cipherLegs])
  const gateSpot = useMemo(() => geometry ? { x: geometry.entry.x, y: geometry.entry.y, depth: geometry.gateDepth } : { x: 0, y: 0, depth: 0 }, [geometry])
  if (!bounds || !geometry) return null

  const { browser, relay, machine, routes } = bounds
  const { browserOut, relayIn, relayOut, routeIn, entry, legs, wires } = geometry
  const routeLanding = routeIn
  // Where the wire crosses the machine's left border: a short gap centred on it, `thickness` deep.
  const opening = (thickness: number) => ({ x: machine.x - Math.floor(thickness / 2), y: entry.y - 18, width: thickness, height: 36 })
  const reflection = { borders: [browser, relay, machine, ...routes].map(outlineOf).join(""), strength: .9, radius: 110 }

  return <>
  <svg className="tunnel-signals" viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
    <defs>
      {/* The dot travels behind the relay: everything inside its border is cut from the pulse layer. */}
      <mask id={`${id}-relay-cutout`} maskUnits="userSpaceOnUse" x={0} y={0} width={bounds.width} height={bounds.height}>
        <rect width={bounds.width} height={bounds.height} fill="white" />
        <rect x={relay.x + 1} y={relay.y + 1} width={relay.width - 2} height={relay.height - 2} fill="black" />
      </mask>
      {/* The frame's border opens softly where a wire enters. */}
      <linearGradient id={`${id}-opening`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#000" stopOpacity="0" /><stop offset=".5" stopColor="#000" stopOpacity="1" /><stop offset="1" stopColor="#000" stopOpacity="0" />
      </linearGradient>
      {/* Reflected light respects the openings: the cut border only glimmers there. */}
      <linearGradient id={`${id}-opening-dim`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#fff" /><stop offset=".5" stopColor="#333" /><stop offset="1" stopColor="#fff" />
      </linearGradient>
      <mask id={`${id}-openings`} maskUnits="userSpaceOnUse" x={0} y={0} width={bounds.width} height={bounds.height}>
        <rect width={bounds.width} height={bounds.height} fill="white" />
        <rect {...opening(5)} fill={`url(#${id}-opening-dim)`} />
      </mask>
    </defs>

    {/* The frame's border opens softly where each wire enters; the wire runs over the gap. */}
    <rect {...opening(3)} fill={`url(#${id}-opening)`} />
    <GraphWire d={wires.request} />
    <GraphWire d={wires.toMachine} />
    {wires.hops.map((d, index) => <GraphWire key={index} d={d} />)}

    <GraphSignals ports={<>
      {cipher !== "shapes" && <>
        <GraphPort {...browserOut} />
        <GraphPort {...relayIn} />
        <GraphPort {...relayOut} />
      </>}
      {cipher !== "shapes" && routes.map((box, index) => <GraphPort key={index} {...routeLanding(box)} />)}
    </>} glows={!reduced && <>
      {/* Dispatch: an ember warms the socket the light leaves from. */}
      <CardGlow id={`${id}-browser-leave`} {...browser} rx={0} cx={browserOut.x} cy={browserOut.y} clock={milliseconds} at={tunnelLegs.map(leg => leg.start * 1000)} role="leaving" {...pluginActivity.ember} />
      {/* Contact: the destination is struck and floods from its socket. Only the local app ever opens the bytes. */}
      {routes.map((box, index) => <g key={index}>
        <CardGlow id={`${id}-route-strike-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs.filter(leg => leg.route === index).map(leg => leg.contact * 1000)} style="crack" strength={1} size={300} />
        <CardGlow id={`${id}-route-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs.filter(leg => leg.route === index).map(leg => leg.contact * 1000)} style="flood" strength={1.2} />
      </g>)}
    </>}>
      {!reduced && <g mask={`url(#${id}-relay-cutout)`}>
        {legs.map((leg, index) => <Pulse key={index} d={leg.d} clock={milliseconds} delay={tunnelLegs[index]!.send * 1000 - pulseGatherMs} duration={tunnelTravel} ease={leg.ease} hiddenUntil={cipher === "glyphs" ? leg.opened : cipher === "shapes" ? 1.01 : leg.zone.to} reflection={reflection} underlayMask={`url(#${id}-openings)`} />)}
        {cipher === "glyphs" && legs.map((leg, index) => <Packet key={index} clock={clock} path={leg.path} length={leg.length} ease={leg.ease} send={tunnelLegs[index]!.send} opened={leg.opened} crossing={leg.crossing} plaintext={tunnelRoutes[tunnelLegs[index]!.route].request} room={entry.x - relayOut.x} />)}
      </g>}

    </GraphSignals>
  </svg>
  {cipher === "shapes" && touches && <>
    <GateField clock={clock} touch={touches.browser} border={browser.x + browser.width} entryY={browserOut.y} top={browser.y} bottom={browser.y + browser.height} />
    <GateField clock={clock} touch={touches.machine} border={machine.x} entryY={entry.y} top={machine.y} bottom={machine.y + machine.height} />
  </>}
  {!reduced && cipher !== "glyphs" && <CipherCanvas style={cipher} clock={clock} legs={cipherLegs} width={bounds.width} height={bounds.height} hide={hidden} origin={bounds.browser} gate={gateSpot} travel={tunnelTravel / 1000} gather={pulseGatherMs / 1000} />}
  </>
}

export function TunnelScene() {
  const player = useScenePlayback(tunnelScore.duration, { repeat: true, autoplay: true, after: 0 })
  const panels = useRef<HTMLDivElement>(null)
  const [crossings, setCrossings] = useState<Crossing[]>([])
  const fronts = useMotionValue<readonly RelayFront[]>([]), now = useMotionValue(0)
  // Development: headless checks pose the scene through `window.__tunnel.seek(seconds)`; the offline track
  // render reads the measured crossings.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __tunnel?: unknown }).__tunnel = { seek: player.seek, crossings, sends: tunnelLegs.map(leg => leg.send), travel: tunnelTravel / 1000 }
  }, [player.seek, crossings])
  // Sound: a click on the diagram turns it on (visitors start muted); the track follows the same clock as the picture.
  const sounds = useSounds(), ready = useSoundReady()
  useTunnelSounds(player.elapsed, player.host, player.active && !player.reduced, crossings)
  const sounding = sounds && ready
  // Development: the sealed packet's treatment under study, `?cipher=moire|tiles|glyphs`.
  const [cipher, setCipher] = useState<CipherStyle>(() => {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("cipher")
    return cipherStyles.find(style => style === asked) ?? "shapes"
  })
  const chooseCipher = (style: CipherStyle) => {
    setCipher(style)
    const url = new URL(window.location.href)
    url.searchParams.set("cipher", style)
    window.history.replaceState(null, "", url)
  }
  // While the browser chooses, a phone's icon-only browser card gives its globe's place to the reel.
  const choosingInk = useTransform(player.clock, time => cipher === "shapes" ? choosingAt(tunnelLegs.map(leg => leg.send), time) : 0)
  return <figure ref={player.host} className="tunnel-scene" aria-label="A visitor's browser sends encrypted traffic through the relay, which scans it without being able to read it, to one of three apps on your machine. Only your machine decrypts it.">
    <button type="button" className="tunnel-sound" onClick={toggleSounds} aria-pressed={sounding} aria-label={sounding ? "Turn the diagram's sound off" : "Turn the diagram's sound on"}>
      {sounding ? <SpeakerHigh size={13} /> : <SpeakerSlash size={13} />}<span>{sounding ? "sound on" : "sound off"}</span>
    </button>
    <div ref={panels} className="tunnel-panels" onClick={event => { if (!(event.target as HTMLElement).closest("a, button")) toggleSounds() }}>
      <motion.div className="tunnel-column tunnel-visitor" style={{ "--choosing": choosingInk } as unknown as MotionStyle}><Browser clock={player.clock} reduced={player.reduced} /></motion.div>
      <div className="tunnel-column tunnel-relay"><Relay clock={player.clock} reduced={player.reduced} crossings={crossings} fronts={fronts} now={now} /></div>
      <DiagramFrame className="tunnel-machine" data-machine="" aria-label="Your machine">
        <span className="tunnel-machine-label" aria-hidden="true"><span>your machine</span></span>
        <div className="tunnel-routes">
          {tunnelRoutes.map((route, index) => <Route key={route.id} index={index} clock={player.clock} reduced={player.reduced} slotted={cipher === "shapes"} />)}
        </div>
      </DiagramFrame>
      <TunnelSignals clock={player.clock} reduced={player.reduced} panels={panels} onCrossings={setCrossings} fronts={fronts} now={now} cipher={cipher} />
    </div>
    {import.meta.env.DEV && cipher === "shapes" && <TuningPanel title="timing" tuning={flightTuning} />}
    {import.meta.env.DEV && <div className="tunnel-cipher-switch" onClick={event => event.stopPropagation()}>
      {cipherStyles.map(style => <button key={style} type="button" aria-pressed={cipher === style} onClick={() => chooseCipher(style)}>{style === "moire" ? "moiré" : style}</button>)}
    </div>}
  </figure>
}
