import { useEffect, useId, useRef, useState, type RefObject } from "react"
import { useTransform, type MotionValue } from "motion/react"
import { DiagramFrame, DiagramHeader, NodeCard } from "../graphics/Diagram"
import { GraphPort, GraphSignals, GraphWire } from "../graphics/GraphSignals"
import { CardGlow, Pulse } from "../graphics/Pulse"
import { pluginActivity, usePluginActivity } from "../graphics/pluginActivity"
import { roundedWire } from "../graphics/roundedWire"
import { useScenePlayback } from "../graphics/useScenePlayback"
import { tunnelLegs, tunnelRoutes, tunnelScore, tunnelTravel } from "./tunnelScore"
import "./tunnel-scene.css"

// browser ──▶ relay ──┬──▶ opencode
//                     ├──▶ api          (your machine)
//                     └──▶ webhooks
//
// HTML frames carry the anatomy; one SVG overlay measures them and draws wires,
// sockets, pulses and light, as the blog's shipped diagrams do.

type Box = { x: number; y: number; width: number; height: number }
type Bounds = { width: number; height: number; browser: Box; relay: Box; machine: Box; routes: Box[] }
const outlineOf = (box: Box) => `M${box.x + .5} ${box.y + .5}h${box.width - 1}v${box.height - 1}h${1 - box.width}Z`

function Browser({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches: tunnelLegs.map(leg => leg.request.start), reduced })
  return <NodeCard name="browser" icon="globe" data-node="browser" aria-label="A visitor's browser" {...inks} />
}

function Relay({ clock, reduced }: { clock: MotionValue<number>; reduced: boolean }) {
  const inks = usePluginActivity(clock, { dispatches: tunnelLegs.map(leg => leg.hop.start), running: tunnelLegs.map(leg => [leg.request.contact, leg.hop.send] as const), reduced })
  return <NodeCard name="relay" icon="relay" data-node="relay" aria-label="The relay, which cannot decrypt" {...inks} />
}

function Route({ index, clock, reduced }: { index: number; clock: MotionValue<number>; reduced: boolean }) {
  const route = tunnelRoutes[index]!, leg = tunnelLegs[index]!
  // The relay's read shows on the destination: its name flashes as the hostname is read, and it works once the bytes land.
  const inks = usePluginActivity(clock, { dispatches: [leg.request.contact], running: [[leg.hop.contact, leg.hop.contact + 1.1]], reduced })
  return <NodeCard name={route.name} icon={route.icon} data-node={route.id} aria-label={`${route.name} on ${route.target}`} {...inks}>
    <span className="node-card-detail">{route.target}</span>
  </NodeCard>
}

/** Wires, sockets, pulses and light over the measured frames. */
function TunnelSignals({ clock, reduced, panels }: { clock: MotionValue<number>; reduced: boolean; panels: RefObject<HTMLDivElement | null> }) {
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
  if (!bounds) return null

  const { browser, relay, machine, routes } = bounds
  const stacked = relay.y >= browser.y + browser.height
  const middle = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const browserOut = stacked ? { x: middle(browser).x, y: browser.y + browser.height } : { x: browser.x + browser.width, y: middle(browser).y }
  const relayIn = stacked ? { x: middle(relay).x, y: relay.y } : { x: relay.x, y: middle(relay).y }
  const relayOut = stacked ? { x: middle(relay).x, y: relay.y + relay.height } : { x: relay.x + relay.width, y: middle(relay).y }
  const routeIn = (box: Box) => stacked ? { x: middle(box).x, y: box.y } : { x: box.x, y: middle(box).y }
  const requestWire = `M${browserOut.x} ${browserOut.y}L${relayIn.x} ${relayIn.y}`
  // Horizontal: a shared spine between relay and machine fans out to each route's socket.
  // Stacked: the hop runs down into the machine frame and along its inside edge to the route.
  const spine = (relayOut.x + machine.x) / 2
  const inside = machine.x + 16
  // Shared segments coincide exactly (trunk, spine), so three routes read as one bus; each branch rounds only into its socket.
  const hopWire = (box: Box) => {
    const input = routeIn(box)
    if (stacked) return roundedWire([relayOut, { x: relayOut.x, y: machine.y - 12 }, { x: inside, y: machine.y - 12 }, { x: inside, y: middle(box).y }, { x: box.x, y: middle(box).y }], 12)
    const dy = input.y - relayOut.y
    if (Math.abs(dy) < 1) return `M${relayOut.x} ${relayOut.y}H${input.x}`
    const r = Math.min(18, Math.abs(dy), (input.x - spine) / 2), dir = Math.sign(dy)
    return `M${relayOut.x} ${relayOut.y}H${spine}V${input.y - dir * r}Q${spine} ${input.y} ${spine + r} ${input.y}H${input.x}`
  }
  const routeLanding = (box: Box) => stacked ? { x: box.x, y: middle(box).y } : routeIn(box)
  const reflection = { borders: [browser, relay, machine, ...routes].map(outlineOf).join("") }

  return <svg className="tunnel-signals" viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
    <GraphWire d={requestWire} />
    {routes.map((box, index) => <GraphWire key={index} d={hopWire(box)} />)}
    <GraphSignals ports={<>
      <GraphPort {...browserOut} />
      <GraphPort {...relayIn} />
      <GraphPort {...relayOut} />
      {routes.map((box, index) => <GraphPort key={index} {...routeLanding(box)} />)}
    </>} glows={!reduced && <>
      {/* Dispatch: an ember warms the socket the light leaves from. */}
      <CardGlow id={`${id}-browser-leave`} {...browser} rx={0} cx={browserOut.x} cy={browserOut.y} clock={milliseconds} at={tunnelLegs.map(leg => leg.request.start * 1000)} role="leaving" {...pluginActivity.ember} />
      <CardGlow id={`${id}-relay-leave`} {...relay} rx={0} cx={relayOut.x} cy={relayOut.y} clock={milliseconds} at={tunnelLegs.map(leg => leg.hop.start * 1000)} role="leaving" {...pluginActivity.ember} />
      {/* The relay is struck but nothing gets in: a thin front crosses its surface. */}
      <CardGlow id={`${id}-relay-strike`} {...relay} rx={0} cx={relayIn.x} cy={relayIn.y} clock={milliseconds} at={tunnelLegs.map(leg => leg.request.contact * 1000)} style="crack" strength={1} size={300} />
      {/* Contact: the destination floods from its socket. Only the local app ever opens the bytes. */}
      {routes.map((box, index) => <g key={index}>
        <CardGlow id={`${id}-route-strike-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs[index]!.hop.contact * 1000} style="crack" strength={1} size={300} />
        <CardGlow id={`${id}-route-${index}`} {...box} rx={0} cx={routeLanding(box).x} cy={routeLanding(box).y} clock={milliseconds} at={tunnelLegs[index]!.hop.contact * 1000} style="flood" strength={1.2} />
      </g>)}
    </>}>
      {!reduced && tunnelLegs.map((leg, index) => <g key={index}>
        <Pulse d={requestWire} clock={milliseconds} delay={leg.request.start * 1000} duration={tunnelTravel.request} trail={{ cooling: 240 }} reflection={reflection} />
        <Pulse d={hopWire(routes[index]!)} clock={milliseconds} delay={leg.hop.start * 1000} duration={tunnelTravel.hop} trail={{ cooling: 240 }} reflection={reflection} />
      </g>)}
    </GraphSignals>
  </svg>
}

export function TunnelScene() {
  const player = useScenePlayback(tunnelScore.duration, { repeat: true, autoplay: true, after: 0 })
  const panels = useRef<HTMLDivElement>(null)
  return <figure ref={player.host} className="tunnel-scene" aria-label="A visitor's browser sends encrypted traffic to the relay, which forwards it, still encrypted, to one of three apps on your machine. Only your machine decrypts it.">
    <div ref={panels} className="tunnel-panels">
      <div className="tunnel-column tunnel-visitor"><Browser clock={player.clock} reduced={player.reduced} /></div>
      <div className="tunnel-column tunnel-relay"><Relay clock={player.clock} reduced={player.reduced} /></div>
      <DiagramFrame as="section" className="tunnel-machine" data-machine="" aria-label="Your machine">
        <DiagramHeader>Your machine</DiagramHeader>
        <div className="tunnel-routes">
          {tunnelRoutes.map((route, index) => <Route key={route.id} index={index} clock={player.clock} reduced={player.reduced} />)}
        </div>
      </DiagramFrame>
      <TunnelSignals clock={player.clock} reduced={player.reduced} panels={panels} />
    </div>
  </figure>
}
