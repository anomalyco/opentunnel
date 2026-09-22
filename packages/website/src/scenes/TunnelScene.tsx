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

// browser ──▶ relay ──▶ opencode
//                  ╲──▶ api          (your machine)
//                   ╲─▶ webhooks
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
  return <NodeCard name="relay" icon={<ArrowsLeftRight size={16} />} data-node="relay" aria-label="The relay, which cannot decrypt" {...inks}>
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
    const spine = (relayOut.x + machine.x) / 2
    // The whole leg is one path: into the relay, straight through it, out the far socket, then an S-curve to the route.
    const through = `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}L${relayOut.x} ${relayOut.y}`
    const hop = (box: Box) => {
      const input = routeIn(box)
      if (Math.abs(input.y - relayOut.y) < 1) return `H${input.x}`
      return `C${spine} ${relayOut.y} ${spine} ${input.y} ${input.x} ${input.y}`
    }
    const legs = routes.map((box, index) => {
      const d = through + hop(box)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", d)
      const length = path.getTotalLength()
      const enter = fractionAtX(path, length, relay.x), leave = fractionAtX(path, length, relay.x + relay.width)
      // Through the relay the bytes move as through something thick: the crossing knows when, and how fast.
      const crossing = legCrossing(index, { enter, leave })
      return { d, path, length, ease: crossing.ease, crossing }
    })
    return { browserOut, relayIn, relayOut, routeIn, legs, wires: { request: `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`, hops: routes.map(box => `M${relayOut.x} ${relayOut.y}${hop(box)}`) } }
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
  const { browserOut, relayIn, relayOut, routeIn, legs, wires } = geometry
  const routeLanding = routeIn
  // Where each wire crosses the machine's left border: a short gap centred on the socket, `thickness` deep.
  const opening = (box: Box, thickness: number) => ({ x: machine.x - Math.floor(thickness / 2), y: routeIn(box).y - 18, width: thickness, height: 36 })
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
        {routes.map((box, index) => <rect key={index} {...opening(box, 5)} fill={`url(#${id}-opening-dim)`} />)}
      </mask>
    </defs>

    {/* The frame's border opens softly where each wire enters; the wire runs over the gap. */}
    {routes.map((box, index) => <rect key={index} {...opening(box, 3)} fill={`url(#${id}-opening)`} />)}
    <GraphWire d={wires.request} />
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
        {legs.map((leg, index) => <Pulse key={index} d={leg.d} clock={milliseconds} delay={tunnelLegs[index]!.send * 1000 - pulseGatherMs} duration={tunnelTravel} ease={leg.ease} reflection={reflection} underlayMask={`url(#${id}-openings)`} />)}
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
