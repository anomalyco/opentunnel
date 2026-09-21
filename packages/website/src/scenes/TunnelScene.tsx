import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react"
import { motion, useTransform, type MotionValue } from "motion/react"
import { DiagramFrame, DiagramHeader, NodeCard } from "../graphics/Diagram"
import { GraphPort, GraphSignals, GraphWire } from "../graphics/GraphSignals"
import { CardGlow, Pulse, pulseEase, pulseGatherMs, type PulseEase } from "../graphics/Pulse"
import { pluginActivity, usePluginActivity } from "../graphics/pluginActivity"
import { roundedWire } from "../graphics/roundedWire"
import { useScenePlayback } from "../graphics/useScenePlayback"
import { tunnelLegs, tunnelRoutes, tunnelScore, tunnelTravel, viscousFlight } from "./tunnelScore"
import "./tunnel-scene.css"

// browser ──▶ relay ──▶ opencode
//                  ╲──▶ api          (your machine)
//                   ╲─▶ webhooks
//
// HTML frames carry the anatomy; one SVG overlay measures them and draws wires,
// sockets, pulses and light, as the blog's shipped diagrams do. Each leg is one
// pulse that passes through the relay: the dot goes behind the card while a scan
// beam sweeps its interior and finds only hatching, then leaves by the far socket.

type Box = { x: number; y: number; width: number; height: number }
type Bounds = { width: number; height: number; browser: Box; relay: Box; machine: Box; routes: Box[] }
/** Scene seconds at which each leg's pulse enters the relay, leaves it, and is read (its midpoint). */
export type Crossing = { enter: number; leave: number; read: number }
const outlineOf = (box: Box) => `M${box.x + .5} ${box.y + .5}h${box.width - 1}v${box.height - 1}h${1 - box.width}Z`

function Browser({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches: tunnelLegs.map(leg => leg.start), reduced })
  return <NodeCard name="browser" icon="globe" data-node="browser" aria-label="A visitor's browser" {...inks} />
}

function Relay({ clock, reduced, crossings }: { clock: MotionValue<number>; reduced: boolean; crossings: readonly Crossing[] }) {
  // Working while the bytes are inside: the icon holds bright for the scan.
  const inks = usePluginActivity(clock, { dispatches: [], running: crossings.map(c => [c.enter, c.leave] as const), reduced })
  return <NodeCard name="relay" icon="relay" armored data-node="relay" aria-label="The relay, which cannot decrypt" {...inks} />
}

function Route({ index, clock, reduced, crossing }: { index: number; clock: MotionValue<number>; reduced: boolean; crossing?: Crossing }) {
  const route = tunnelRoutes[index]!, leg = tunnelLegs[index]!
  // The relay's read shows on the destination: its name flashes as the hostname is read, and it works once the bytes land.
  const inks = usePluginActivity(clock, { dispatches: crossing ? [crossing.read] : [], running: [[leg.contact, leg.contact + 1.1]], reduced })
  return <NodeCard name={route.name} icon={route.icon} data-node={route.id} aria-label={`${route.name} on ${route.target}`} {...inks}>
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

/** The x-ray: a beam sweeps the relay's interior with the hidden dot, lighting hatching where it passes. Nothing legible. */
function RelayScan({ clock, relay, path, length, leg, ease, id }: { clock: MotionValue<number>; relay: Box; path: SVGPathElement; length: number; leg: typeof tunnelLegs[number]; ease: PulseEase; id: string }) {
  const inner = { x: relay.x + 4, y: relay.y + 4, width: relay.width - 8, height: relay.height - 8 }
  const beamX = useTransform(clock, seconds => {
    const t = seconds - leg.send
    if (t < 0 || t > tunnelTravel / 1000) return -1e4
    return path.getPointAtLength(ease.at(t / (tunnelTravel / 1000)) * length).x
  })
  const inside = useTransform(beamX, x => x > inner.x - 12 && x < inner.x + inner.width + 60 ? 1 : 0)
  return <g clipPath={`url(#${id}-relay-clip)`} pointerEvents="none">
    <motion.g style={{ opacity: inside }}>
      {/* Only where the beam has just been: the sealed bytes as a fine hatch, nothing legible. */}
      <motion.g style={{ x: beamX }}>
        <rect x={-52} y={inner.y} width={52} height={inner.height} fill={`url(#${id}-scan-wake)`} />
        <rect x={-52} y={inner.y} width={52} height={inner.height} fill={`url(#${id}-hatch)`} mask={`url(#${id}-scan-mask)`} />
        <rect x={-.75} y={inner.y} width={1.5} height={inner.height} fill="#e8e4dc" opacity={.9} />
        <rect x={-6} y={inner.y} width={12} height={inner.height} fill={`url(#${id}-scan-beam)`} />
      </motion.g>
    </motion.g>
  </g>
}

/** Wires, sockets, pulses and light over the measured frames. */
function TunnelSignals({ clock, reduced, panels, onCrossings }: { clock: MotionValue<number>; reduced: boolean; panels: RefObject<HTMLDivElement | null>; onCrossings: (crossings: Crossing[]) => void }) {
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
    const stacked = relay.y >= browser.y + browser.height
    const middle = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    const browserOut = stacked ? { x: middle(browser).x, y: browser.y + browser.height } : { x: browser.x + browser.width, y: middle(browser).y }
    const relayIn = stacked ? { x: middle(relay).x, y: relay.y } : { x: relay.x, y: middle(relay).y }
    const relayOut = stacked ? { x: middle(relay).x, y: relay.y + relay.height } : { x: relay.x + relay.width, y: middle(relay).y }
    const routeIn = (box: Box) => stacked ? { x: middle(box).x, y: box.y } : { x: box.x, y: middle(box).y }
    const spine = (relayOut.x + machine.x) / 2
    const inside = machine.x + 16
    // The whole leg is one path: into the relay, straight through it, out the far socket, then an S-curve to the route.
    const through = `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}L${relayOut.x} ${relayOut.y}`
    const hop = (box: Box) => {
      const input = routeIn(box)
      if (stacked) return roundedWire([relayOut, { x: relayOut.x, y: machine.y - 12 }, { x: inside, y: machine.y - 12 }, { x: inside, y: middle(box).y }, { x: box.x, y: middle(box).y }], 12).replace(/^M[^L]*/, "")
      if (Math.abs(input.y - relayOut.y) < 1) return `H${input.x}`
      return `C${spine} ${relayOut.y} ${spine} ${input.y} ${input.x} ${input.y}`
    }
    const legs = routes.map(box => {
      const d = through + hop(box)
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", d)
      const length = path.getTotalLength()
      const enter = stacked ? 0 : fractionAtX(path, length, relay.x), leave = stacked ? 0 : fractionAtX(path, length, relay.x + relay.width)
      // Through the relay the bytes move as through something thick: that stretch takes four times its share.
      const ease = stacked ? pulseEase : viscousFlight(enter, leave, 4)
      return { d, path, length, enter, leave, ease }
    })
    return { stacked, browserOut, relayIn, relayOut, routeIn, legs, wires: { request: `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`, hops: routes.map(box => `M${relayOut.x} ${relayOut.y}${hop(box)}`) } }
  }, [bounds])

  useEffect(() => {
    if (!geometry) return
    const flight = tunnelTravel / 1000
    onCrossings(geometry.legs.map((leg, index) => {
      const { send } = tunnelLegs[index]!
      const enter = send + leg.ease.inverse(leg.enter) * flight, leave = send + leg.ease.inverse(leg.leave) * flight
      return { enter, leave, read: (enter + leave) / 2 }
    }))
  }, [geometry, onCrossings])
  if (!bounds || !geometry) return null

  const { browser, relay, machine, routes } = bounds
  const { stacked, browserOut, relayIn, relayOut, routeIn, legs, wires } = geometry
  const routeLanding = (box: Box) => stacked ? { x: box.x, y: box.y + box.height / 2 } : routeIn(box)
  const reflection = { borders: [browser, relay, machine, ...routes].map(outlineOf).join("") }
  const relayInner = { x: relay.x + 4, y: relay.y + 4, width: relay.width - 8, height: relay.height - 8 }

  return <svg className="tunnel-signals" viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
    <defs>
      {/* The dot travels behind the relay: everything inside its border is cut from the pulse layer. */}
      <mask id={`${id}-relay-cutout`} maskUnits="userSpaceOnUse" x={0} y={0} width={bounds.width} height={bounds.height}>
        <rect width={bounds.width} height={bounds.height} fill="white" />
        <rect x={relay.x + 1} y={relay.y + 1} width={relay.width - 2} height={relay.height - 2} fill="black" />
      </mask>
      <clipPath id={`${id}-relay-clip`}><rect {...relayInner} /></clipPath>
      <linearGradient id={`${id}-scan-beam`} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#e8e4dc" stopOpacity="0" /><stop offset=".5" stopColor="#e8e4dc" stopOpacity=".35" /><stop offset="1" stopColor="#e8e4dc" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${id}-scan-wake`} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#e8e4dc" stopOpacity="0" /><stop offset="1" stopColor="#e8e4dc" stopOpacity=".08" />
      </linearGradient>
      <linearGradient id={`${id}-scan-fade`} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="white" stopOpacity="0" /><stop offset="1" stopColor="white" stopOpacity="1" />
      </linearGradient>
      <mask id={`${id}-scan-mask`} maskUnits="userSpaceOnUse" x={-52} y={relayInner.y} width={52} height={relayInner.height}>
        <rect x={-52} y={relayInner.y} width={52} height={relayInner.height} fill={`url(#${id}-scan-fade)`} />
      </mask>
      <pattern id={`${id}-hatch`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={1} height={5} fill="#e8e4dc" opacity=".55" />
      </pattern>
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
        {!stacked && routes.map((box, index) => <rect key={index} x={machine.x - 2} y={routeIn(box).y - 18} width={5} height={36} fill={`url(#${id}-opening-dim)`} />)}
      </mask>
    </defs>

    {/* The frame's border opens softly where each wire enters; the wire runs over the gap. */}
    {!stacked && routes.map((box, index) => <rect key={index} x={machine.x - 1} y={routeIn(box).y - 18} width={3} height={36} fill={`url(#${id}-opening)`} />)}
    <GraphWire d={wires.request} />
    {wires.hops.map((d, index) => <GraphWire key={index} d={d} />)}

    {!reduced && legs.map((leg, index) => <RelayScan key={index} clock={clock} relay={relay} path={leg.path} length={leg.length} leg={tunnelLegs[index]!} ease={leg.ease} id={id} />)}

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
        {legs.map((leg, index) => <Pulse key={index} d={leg.d} clock={milliseconds} delay={tunnelLegs[index]!.send * 1000 - pulseGatherMs} duration={tunnelTravel} ease={leg.ease} trail={{ cooling: 240 }} reflection={reflection} underlayMask={`url(#${id}-openings)`} />)}
      </g>}
    </GraphSignals>
  </svg>
}

export function TunnelScene() {
  const player = useScenePlayback(tunnelScore.duration, { repeat: true, autoplay: true, after: 0 })
  const panels = useRef<HTMLDivElement>(null)
  const [crossings, setCrossings] = useState<Crossing[]>([])
  // Development: headless checks pose the scene through `window.__tunnel.seek(seconds)`.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __tunnel?: unknown }).__tunnel = { seek: player.seek, crossings, legs: tunnelLegs, duration: tunnelScore.duration }
  }, [player.seek, crossings])
  return <figure ref={player.host} className="tunnel-scene" aria-label="A visitor's browser sends encrypted traffic through the relay, which scans it without being able to read it, to one of three apps on your machine. Only your machine decrypts it.">
    <div ref={panels} className="tunnel-panels">
      <div className="tunnel-column tunnel-visitor"><Browser clock={player.clock} reduced={player.reduced} /></div>
      <div className="tunnel-column tunnel-relay"><Relay clock={player.clock} reduced={player.reduced} crossings={crossings} /></div>
      <DiagramFrame as="section" className="tunnel-machine" data-machine="" aria-label="Your machine">
        <DiagramHeader>Your machine</DiagramHeader>
        <div className="tunnel-routes">
          {tunnelRoutes.map((route, index) => <Route key={route.id} index={index} clock={player.clock} reduced={player.reduced} crossing={crossings[index]} />)}
        </div>
      </DiagramFrame>
      <TunnelSignals clock={player.clock} reduced={player.reduced} panels={panels} onCrossings={setCrossings} />
    </div>
  </figure>
}
