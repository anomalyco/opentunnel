import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react"
import { motion, useMotionValue, useMotionValueEvent, useTransform, type MotionStyle, type MotionValue } from "motion/react"
import { DiagramFrame, NodeCard } from "../graphics/Diagram"
import { GraphSignals, GraphWire } from "../graphics/GraphSignals"
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
import { CipherCanvas, choosingAt, packetCentre, type CipherLeg } from "./Cipher"
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
// pulses and light, as the blog's shipped diagrams do. Each leg is one
// request that passes through the relay: the packet goes behind the card while the
// field inside burns where the bytes pass and finds only hatching, then re-forms
// crossing your machine's border and plugs into the matching shape slot on its app.

type Box = { x: number; y: number; width: number; height: number }
type Bounds = { width: number; height: number; browser: Box; relay: Box; machine: Box; routes: Box[] }

const sends = tunnelLegs.map(leg => leg.send)
const dispatches = tunnelLegs.map(leg => leg.start)

/** The frame's 1px border, traced along its centre. */
const outlineOf = (box: Box) => `M${box.x + .5} ${box.y + .5}h${box.width - 1}v${box.height - 1}h${1 - box.width}Z`

/** Each app is a plain shape, so the request the browser picks can be matched at a glance where it lands. */
function ShapeIcon({ shape }: { shape: number }) {
  return <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    {shape === 0 ? <circle cx={8} cy={8} r={5} /> : shape === 1 ? <path d="M8 2.4L13.6 12.4H2.4Z" /> : <rect x={3.6} y={3.6} width={8.8} height={8.8} />}
  </svg>
}

function Browser({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches, reduced })
  return <NodeCard name="browser" icon={<Globe clock={clock} reduced={reduced} period={tunnelScore.duration} />} data-node="browser" aria-label="A visitor's browser" {...inks}>
    {!reduced && <BurstField clock={clock} at={dispatches} origin={[1, .5]} mode="ember" className="tunnel-card-field" />}
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
  const route = tunnelRoutes[index]!, contacts = tunnelLegs.filter(leg => leg.route === index).map(leg => leg.contact)
  // The destination flashes as the bytes land and cools over the next second; its icon flashes and decays with the name.
  const activity = { dispatches: contacts, reduced }
  const inks = usePluginActivity(clock, activity)
  const { rest, active } = pluginActivity.icon
  inks.iconColor = useTransform(clock, time => { const n = Math.round(rest + pluginActivityAt(time, activity).flash * (active - rest)); return `rgb(${n} ${n} ${n})` })
  return <NodeCard name={route.name} icon={<ShapeIcon shape={route.shape} />} data-node={route.id} aria-label={`${route.name} on ${route.target}`} {...inks}>
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

/** Wires, pulses, membranes and light over the measured frames. */
function TunnelSignals({ clock, reduced, panels, onCrossings, fronts, now }: { clock: MotionValue<number>; reduced: boolean; panels: RefObject<HTMLDivElement | null>; onCrossings: (crossings: Crossing[]) => void; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number> }) {
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
    // One wire into your machine, level with the relay; inside, a straight stretch through the gate before it fans out to the apps.
    const entry = { x: machine.x, y: relayOut.y }
    const fan = entry.x + Math.max(14, Math.min(36, (routes[0]!.x - machine.x) * .5))
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
      const border = fractionAtX(path, length, machine.x)
      // Through the relay the bytes move as through something thick, and they crawl across both borders.
      const crossing = legCrossing(index, {
        enter, leave,
        gate: border, gateWidth: borderCrawl.gate.reach / length,
        exit: 4 / length, exitWidth: borderCrawl.exit.reach / length,
      })
      return { d, path, length, ease: crossing.ease, crossing, send: request.send, shape: tunnelRoutes[request.route]!.shape, border }
    })
    // What each membrane feels: the browser's as the chosen shape leaves (it crosses at the send), your machine's as it
    // arrives (it crosses at the border's path fraction).
    const travel = tunnelTravel / 1000
    const feel = (border: number, crossedAt: (leg: CipherLeg) => number) => (t: number): GateTouch => {
      let push = 0, approach = 0, sinceCross = 99
      for (const leg of legs) {
        const crossed = crossedAt(leg)
        if (t >= crossed) sinceCross = Math.min(sinceCross, t - crossed)
        const centre = packetCentre(leg, t, browser, travel)
        if (!centre) continue
        const dx = centre.x - border
        push = Math.max(push, gatePush(dx))
        if (dx < 0) approach = Math.max(approach, Math.exp(dx / 60))
      }
      return { push, approach, sinceCross }
    }
    const touches = {
      browser: feel(browserOut.x, leg => leg.send),
      machine: feel(machine.x, leg => leg.send + leg.ease.inverse(leg.border) * travel),
    }
    return {
      browserOut, routeIn, entry, legs, touches,
      wires: {
        request: `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`,
        toMachine: `M${relayOut.x} ${relayOut.y}L${entry.x} ${entry.y}`,
        hops: routes.map(box => `M${entry.x} ${entry.y}${hop(box)}`),
      },
    }
  }, [bounds, tuned])

  // The relay's field follows every dot in flight: each one's position across the card's interior, and scene time.
  useMotionValueEvent(clock, "change", seconds => {
    now.set(seconds)
    if (!geometry || !bounds) { fronts.set([]); return }
    const flight = tunnelTravel / 1000
    const inner = { x: bounds.relay.x + 1, width: bounds.relay.width - 2 }
    const active: RelayFront[] = []
    for (const [index, leg] of geometry.legs.entries()) {
      const t = seconds - leg.send
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
  const { browserOut, routeIn, entry, legs, touches, wires } = geometry
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

    <GraphSignals glows={!reduced && <>
      {/* Dispatch: an ember warms the socket the light leaves from. */}
      <CardGlow id={`${id}-browser-leave`} {...browser} rx={0} cx={browserOut.x} cy={browserOut.y} clock={milliseconds} at={dispatches.map(t => t * 1000)} role="leaving" {...pluginActivity.ember} />
      {/* Contact: the destination is struck and floods from its socket. Only the local app ever opens the bytes. */}
      {routes.map((box, index) => {
        const at = tunnelLegs.filter(leg => leg.route === index).map(leg => leg.contact * 1000), landing = routeIn(box)
        return <g key={index}>
          <CardGlow id={`${id}-route-strike-${index}`} {...box} rx={0} cx={landing.x} cy={landing.y} clock={milliseconds} at={at} style="crack" strength={1} size={300} />
          <CardGlow id={`${id}-route-${index}`} {...box} rx={0} cx={landing.x} cy={landing.y} clock={milliseconds} at={at} style="flood" strength={1.2} />
        </g>
      })}
    </>}>
      {!reduced && <g mask={`url(#${id}-relay-cutout)`}>
        {legs.map((leg, index) => <Pulse key={index} d={leg.d} clock={milliseconds} delay={leg.send * 1000 - pulseGatherMs} duration={tunnelTravel} ease={leg.ease} reflection={reflection} underlayMask={`url(#${id}-openings)`} />)}
      </g>}
    </GraphSignals>
  </svg>
  <GateField clock={clock} touch={touches.browser} border={browserOut.x} entryY={browserOut.y} top={browser.y} bottom={browser.y + browser.height} />
  <GateField clock={clock} touch={touches.machine} border={machine.x} entryY={entry.y} top={machine.y} bottom={machine.y + machine.height} />
  {!reduced && <CipherCanvas clock={clock} legs={legs} width={bounds.width} height={bounds.height} origin={browser} relay={relay} gateX={machine.x} travel={tunnelTravel / 1000} />}
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
    ;(window as unknown as { __tunnel?: unknown }).__tunnel = { seek: player.seek, crossings, sends, travel: tunnelTravel / 1000 }
  }, [player.seek, crossings])
  // Sound: a click on the diagram turns it on (visitors start muted); the track follows the same clock as the picture.
  const sounds = useSounds(), ready = useSoundReady()
  useTunnelSounds(player.elapsed, player.host, player.active && !player.reduced, crossings)
  const sounding = sounds && ready
  // While the browser chooses, a phone's icon-only browser card gives its globe's place to the reel.
  const choosingInk = useTransform(player.clock, time => choosingAt(sends, time))
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
          {tunnelRoutes.map((route, index) => <Route key={route.id} index={index} clock={player.clock} reduced={player.reduced} />)}
        </div>
      </DiagramFrame>
      <TunnelSignals clock={player.clock} reduced={player.reduced} panels={panels} onCrossings={setCrossings} fronts={fronts} now={now} />
    </div>
    {import.meta.env.DEV && <TuningPanel title="timing" tuning={flightTuning} />}
  </figure>
}
