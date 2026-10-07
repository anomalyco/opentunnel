import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react"
import { useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react"
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
import { legCrossing, type Crossing } from "./tunnelFlight"
import { ArrowsLeftRight, SpeakerHigh, SpeakerSlash, Stack, Terminal, WebhooksLogo } from "@phosphor-icons/react"
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

const routeIcons = { terminal: <Terminal size={16} />, layers: <Stack size={16} />, webhook: <WebhooksLogo size={16} /> } as const

function Browser({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches: tunnelLegs.map(leg => leg.start), reduced })
  return <NodeCard name="browser" icon={<Globe clock={clock} reduced={reduced} period={tunnelScore.duration} />} data-node="browser" aria-label="A visitor's browser" {...inks}>
    {!reduced && <BurstField clock={clock} at={tunnelLegs.map(leg => leg.start)} origin={[1, .5]} mode="ember" className="tunnel-card-field" />}
  </NodeCard>
}

function Relay({ clock, reduced, crossings, fronts, now }: { clock: MotionValue<number>; reduced: boolean; crossings: readonly Crossing[]; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number> }) {
  // Working while the bytes are inside: the icon holds bright while the field is lit.
  const inks = usePluginActivity(clock, { dispatches: [], running: crossings.map(c => [c.enter, c.leave] as const), reduced })
  return <NodeCard name="*.opentunnel.xyz" icon={<ArrowsLeftRight size={16} />} data-node="relay" aria-label="The relay, which cannot decrypt" {...inks}>
    {!reduced && <RelayField fronts={fronts} now={now} className="tunnel-relay-field" />}
  </NodeCard>
}

function Route({ index, clock, reduced }: { index: number; clock: MotionValue<number>; reduced: boolean }) {
  const route = tunnelRoutes[index]!, leg = tunnelLegs[index]!
  // The destination flashes as the bytes land and cools over the next second; its icon flashes and decays with the name.
  const activity = { dispatches: [leg.contact], reduced }
  const inks = usePluginActivity(clock, activity)
  const { rest, active } = pluginActivity.icon
  inks.iconColor = useTransform(clock, time => { const n = Math.round(rest + pluginActivityAt(time, activity).flash * (active - rest)); return `rgb(${n} ${n} ${n})` })
  return <NodeCard name={route.name} icon={routeIcons[route.icon]} data-node={route.id} aria-label={`${route.name} on ${route.target}`} {...inks}>
    {!reduced && <BurstField clock={clock} at={[leg.contact]} origin={[0, .5]} mode="strike" className="tunnel-card-field" />}
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

/** opentunnel, written up your machine's left border below where the bytes come in. The text knocks the border out. */
function GateLabel({ machine, entry }: { machine: Box; entry: { x: number; y: number } }) {
  const below = entry.y + 22, bottom = machine.y + machine.height - 12
  const centre = (below + bottom) / 2, x = machine.x
  return <g className="tunnel-gate-label">
    <rect x={x - 8} y={centre - 46} width={16} height={92} fill="#000" />
    <text x={x} y={centre} transform={`rotate(-90 ${x} ${centre})`} textAnchor="middle" dominantBaseline="central">OPENTUNNEL</text>
  </g>
}

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=#%&*$@"
const scramble = (slot: number, tick: number) => {
  const x = Math.sin(slot * 91.7 + tick * 47.3) * 43758.5453
  return GLYPHS[Math.floor((x - Math.floor(x)) * GLYPHS.length)]!
}

/** The request as the relay sees it: a few characters of ciphertext riding the dot's path, never the same twice,
 * until they cross your machine's border and condense into the light. */
function Cipher({ clock, path, length, ease, send, opened }: { clock: MotionValue<number>; path: SVGPathElement; length: number; ease: Crossing["ease"]; send: number; opened: number }) {
  const text = useRef<SVGTextElement>(null)
  const SLOTS = 4, collapse = 14 / length
  const paint = (seconds: number) => {
    const element = text.current
    if (!element) return
    const u = (seconds - send) / (tunnelTravel / 1000)
    const progress = u <= 0 ? 0 : ease.at(Math.min(1, u))
    const gathering = pulseGatherMs / 1000 / (tunnelTravel / 1000)
    if (u < -gathering || progress >= opened) { element.setAttribute("opacity", "0"); return }
    const point = path.getPointAtLength(progress * length)
    // Fades up as the request gathers at the browser; draws in on itself as it reaches the border.
    const arriving = Math.min(1, (u + gathering) / gathering)
    const closing = Math.max(0, Math.min(1, (opened - progress) / collapse))
    // Each character changes on its own beat, a little out of step with the others.
    const characters = Array.from({ length: SLOTS }, (_, slot) => scramble(slot, Math.floor(seconds * 18 + slot * .37))).join("")
    element.textContent = characters
    element.setAttribute("x", String(point.x)); element.setAttribute("y", String(point.y))
    element.setAttribute("letter-spacing", String(1.5 * closing - 1.5 * (1 - closing)))
    element.setAttribute("opacity", String(arriving * (.25 + .75 * closing)))
  }
  useMotionValueEvent(clock, "change", paint)
  useEffect(() => paint(clock.get()))
  return <text ref={text} className="tunnel-cipher" textAnchor="middle" dominantBaseline="central" opacity={0} />
}

/** Wires, sockets, pulses and light over the measured frames. */
function TunnelSignals({ clock, reduced, panels, onCrossings, fronts, now }: { clock: MotionValue<number>; reduced: boolean; panels: RefObject<HTMLDivElement | null>; onCrossings: (crossings: Crossing[]) => void; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number> }) {
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
    const through = `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}L${relayOut.x} ${relayOut.y}L${entry.x} ${entry.y}`
    const hop = (box: Box) => {
      const input = routeIn(box)
      if (Math.abs(input.y - entry.y) < 1) return `H${input.x}`
      const spine = (entry.x + input.x) / 2
      return `C${spine} ${entry.y} ${spine} ${input.y} ${input.x} ${input.y}`
    }
    const legs = routes.map((box, index) => {
      const d = through + hop(box)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", d)
      const length = path.getTotalLength()
      const enter = fractionAtX(path, length, relay.x), leave = fractionAtX(path, length, relay.x + relay.width)
      // Through the relay the bytes move as through something thick: the crossing knows when, and how fast.
      const crossing = legCrossing(index, { enter, leave })
      // Until the bytes cross into your machine they are ciphertext.
      return { d, path, length, ease: crossing.ease, crossing, opened: fractionAtX(path, length, machine.x) }
    })
    return { browserOut, relayIn, relayOut, routeIn, entry, legs, wires: { request: `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`, toMachine: `M${relayOut.x} ${relayOut.y}L${entry.x} ${entry.y}`, hops: routes.map(box => `M${entry.x} ${entry.y}${hop(box)}`) } }
  }, [bounds])

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
  if (!bounds || !geometry) return null

  const { browser, relay, machine, routes } = bounds
  const { browserOut, relayIn, relayOut, routeIn, entry, legs, wires } = geometry
  const routeLanding = routeIn
  // Where the wire crosses the machine's left border: a short gap centred on it, `thickness` deep.
  const opening = (thickness: number) => ({ x: machine.x - Math.floor(thickness / 2), y: entry.y - 18, width: thickness, height: 36 })
  const reflection = { borders: [browser, relay, machine, ...routes].map(outlineOf).join(""), strength: .9, radius: 110 }

  return <svg className="tunnel-signals" viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
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
    <GateLabel machine={machine} entry={entry} />
    <GraphWire d={wires.request} />
    <GraphWire d={wires.toMachine} />
    {wires.hops.map((d, index) => <GraphWire key={index} d={d} />)}

    <GraphSignals ports={<>
      <GraphPort {...browserOut} />
      <GraphPort {...relayIn} />
      <GraphPort {...relayOut} />
      {routes.map((box, index) => <GraphPort key={index} {...routeLanding(box)} />)}
    </>} glows={!reduced && <>
      {/* Dispatch: an ember warms the socket the light leaves from. */}
      <CardGlow id={`${id}-browser-leave`} {...browser} rx={0} cx={browserOut.x} cy={browserOut.y} clock={milliseconds} at={tunnelLegs.map(leg => leg.start * 1000)} role="leaving" {...pluginActivity.ember} />
      {/* Contact: the destination is struck and floods from its socket. Only the local app ever opens the bytes. */}
      {routes.map((box, index) => <g key={index}>
        <CardGlow id={`${id}-route-strike-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs[index]!.contact * 1000} style="crack" strength={1} size={300} />
        <CardGlow id={`${id}-route-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs[index]!.contact * 1000} style="flood" strength={1.2} />
      </g>)}
    </>}>
      {!reduced && <g mask={`url(#${id}-relay-cutout)`}>
        {legs.map((leg, index) => <Pulse key={index} d={leg.d} clock={milliseconds} delay={tunnelLegs[index]!.send * 1000 - pulseGatherMs} duration={tunnelTravel} ease={leg.ease} hiddenUntil={leg.opened} reflection={reflection} underlayMask={`url(#${id}-openings)`} />)}
        {legs.map((leg, index) => <Cipher key={index} clock={clock} path={leg.path} length={leg.length} ease={leg.ease} send={tunnelLegs[index]!.send} opened={leg.opened} />)}
      </g>}

    </GraphSignals>
  </svg>
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
    ;(window as unknown as { __tunnel?: unknown }).__tunnel = { seek: player.seek, crossings }
  }, [player.seek, crossings])
  // Sound: a click on the diagram turns it on (visitors start muted); the track follows the same clock as the picture.
  const sounds = useSounds(), ready = useSoundReady()
  useTunnelSounds(player.elapsed, player.host, player.active && !player.reduced, crossings)
  const sounding = sounds && ready
  return <figure ref={player.host} className="tunnel-scene" aria-label="A visitor's browser sends encrypted traffic through the relay, which scans it without being able to read it, to one of three apps on your machine. Only your machine decrypts it.">
    <button type="button" className="tunnel-sound" onClick={toggleSounds} aria-pressed={sounding} aria-label={sounding ? "Turn the diagram's sound off" : "Turn the diagram's sound on"}>
      {sounding ? <SpeakerHigh size={13} /> : <SpeakerSlash size={13} />}<span>{sounding ? "sound on" : "sound off"}</span>
    </button>
    <div ref={panels} className="tunnel-panels" onClick={event => { if (!(event.target as HTMLElement).closest("a, button")) toggleSounds() }}>
      <div className="tunnel-column tunnel-visitor"><Browser clock={player.clock} reduced={player.reduced} /></div>
      <div className="tunnel-column tunnel-relay"><Relay clock={player.clock} reduced={player.reduced} crossings={crossings} fronts={fronts} now={now} /></div>
      <DiagramFrame className="tunnel-machine" data-machine="" aria-label="Your machine">
        <span className="tunnel-machine-label" aria-hidden="true"><span>your machine</span></span>
        <div className="tunnel-routes">
          {tunnelRoutes.map((route, index) => <Route key={route.id} index={index} clock={player.clock} reduced={player.reduced} />)}
        </div>
      </DiagramFrame>
      <TunnelSignals clock={player.clock} reduced={player.reduced} panels={panels} onCrossings={setCrossings} fronts={fronts} now={now} />
    </div>
  </figure>
}
