import { useEffect } from "react"
import { Globe, LockSimple } from "@phosphor-icons/react"
import { TunnelArt } from "./poster/TunnelArt"
import { Barcode, Crosshair, Ruler } from "./Micro"
import { RingTunnel } from "./components/RingTunnel"
import { ringPresets } from "./components/ringSettings"
import { tunnelRoutes } from "./scenes/tunnelScore"
import "./OpenGraphCard.css"

declare global {
  interface Window { __ogReady?: Promise<void> }
}

// The share card as a printed sheet: one ink (the red) on black. A frame with registration marks and a tick
// ruler; the print, big, with the caption and a barcode under it; the wordmark; a schematic of the tunnel;
// a row of marks (rings, a dither ramp, a crosshair); the small print. Rendered at `/og`;
// `scripts/build-og.ts` screenshots it under reduced motion.

const WORDMARK = "OPENTUNNEL", WIDTH = 1000, ASPECT = 4.6, CAP = .867

export function OpenGraphCard() {
  const height = WIDTH / ASPECT, fontSize = height / CAP
  useEffect(() => {
    window.__ogReady = Promise.all([document.fonts.load(`400 ${fontSize}px Anton`), document.fonts.load("400 16px 'IBM Plex Mono'"), document.fonts.ready])
      .then(() => new Promise(resolve => setTimeout(resolve, 600)))
  }, [fontSize])
  return <div className="og-card" data-og-card>
    <div className="og-frame" aria-hidden="true">
      <Crosshair className="og-reg og-reg-tl" /><Crosshair className="og-reg og-reg-tr" /><Crosshair className="og-reg og-reg-bl" /><Crosshair className="og-reg og-reg-br" />
      <Ruler className="og-ruler" />
      <span className="og-edge">opentunnel.xyz — public urls for anything — encrypted end to end — № 0001</span>
    </div>
    <div className="og-gutter" aria-hidden="true" />
    <div className="og-left">
      <div className="og-print"><TunnelArt className="og-canvas" /></div>
      <p className="og-caption">
        <b><span>public</span><i className="fill" /><span>urls</span><Globe size={12} className="tail" /></b>
        <b><span>for</span><i className="fill" /><span>anything</span><LockSimple size={12} className="tail" /></b>
      </p>
    </div>
    <div className="og-right">
      <div className="og-mark">
        <svg className="og-wordmark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fill="currentColor">{WORDMARK}</text>
        </svg>
      </div>
      <Schematic />
    </div>
    <div className="og-rule" aria-hidden="true" />
    <div className="og-code"><Barcode text="OPENTUNNEL.XYZ" height={20} className="og-barcode" /><span>0047365</span></div>
    <div className="og-marks">
      <RingTunnel size={52} settings={{ ...ringPresets.Stack!, stroke: 1.4, fade: .3 }} color="#ff2a2a" paused />
      <Ramp />
      <div className="og-spec">
        <span>fig. 1</span><span>a request, through the relay, to your machine</span>
        <span>tls</span><span>terminated on your machine · ecdsa p-256</span>
        <span>relay</span><span>routes by hostname · cannot decrypt</span>
        <span>install</span><span>$ npm i -g opentunnel</span>
      </div>
    </div>
  </div>
}

/** The tunnel, as a line drawing on graph paper: browser, relay, and the three routes on your machine, filling its band. */
function Schematic() {
  const W = 676, H = 250
  const browser = { x: 0, y: 101, w: 150, h: 48 }, relay = { x: 214, y: 101, w: 182, h: 48 }
  const machine = { x: 456, y: 28, w: 220, h: 194 }
  const routes = tunnelRoutes.map((route, i) => ({ ...route, x: machine.x + 14, y: machine.y + 14 + i * 58, w: machine.w - 28, h: 44 }))
  const mid = (b: { y: number; h: number }) => b.y + b.h / 2
  const bend = (relay.x + relay.w + machine.x) / 2
  return <svg className="og-schematic" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
    <defs>
      <pattern id="og-graph" width={10} height={10} patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="currentColor" strokeOpacity={.11} strokeWidth={1} /></pattern>
      <pattern id="og-graph-major" width={50} height={50} patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="currentColor" strokeOpacity={.24} strokeWidth={1} /></pattern>
    </defs>
    <rect width={W} height={H} fill="url(#og-graph)" /><rect width={W} height={H} fill="url(#og-graph-major)" />
    {/* Boxes sit on paper, not on the grid. */}
    <g fill="#000">
      <rect x={browser.x} y={browser.y} width={browser.w} height={browser.h} /><rect x={relay.x} y={relay.y} width={relay.w} height={relay.h} /><rect x={machine.x} y={machine.y} width={machine.w} height={machine.h} />
    </g>
    <g fill="none" stroke="currentColor" strokeWidth={1}>
      <rect x={browser.x + .5} y={browser.y + .5} width={browser.w - 1} height={browser.h - 1} />
      <rect x={relay.x + .5} y={relay.y + .5} width={relay.w - 1} height={relay.h - 1} />
      <rect x={machine.x + .5} y={machine.y + .5} width={machine.w - 1} height={machine.h - 1} strokeDasharray="3 3" />
      {routes.map(route => <rect key={route.id} x={route.x + .5} y={route.y + .5} width={route.w - 1} height={route.h - 1} />)}
      <path d={`M${browser.x + browser.w} ${mid(browser)}H${relay.x}`} />
      {routes.map(route => <path key={route.id} d={`M${relay.x + relay.w} ${mid(relay)}C${bend} ${mid(relay)} ${bend} ${mid(route)} ${machine.x} ${mid(route)}`} />)}
      {/* The request in flight: a dotted trail along the first wire. */}
      <path d={`M${browser.x + browser.w + 10} ${mid(browser)}H${relay.x - 10}`} strokeDasharray="1.5 4.5" strokeWidth={3} strokeLinecap="round" opacity={.9} />
    </g>
    <g fill="currentColor">
      <circle cx={browser.x + browser.w} cy={mid(browser)} r={2.5} /><circle cx={relay.x} cy={mid(relay)} r={2.5} /><circle cx={relay.x + relay.w} cy={mid(relay)} r={2.5} />
      {routes.map(route => <circle key={route.id} cx={machine.x} cy={mid(route)} r={2.5} />)}
    </g>
    <g className="og-labels">
      <text x={browser.x + 14} y={mid(browser) + 4}>browser</text>
      <text x={browser.x + browser.w - 14} y={mid(browser) + 4} textAnchor="end" opacity={.6}>https</text>
      <text x={relay.x + 14} y={mid(relay) + 4}>relay</text>
      <text x={relay.x + relay.w - 14} y={mid(relay) + 4} textAnchor="end" opacity={.6}>sni only</text>
      <text x={machine.x} y={machine.y - 8} opacity={.85}>your machine</text>
      <text x={machine.x + machine.w} y={machine.y + machine.h + 16} textAnchor="end" opacity={.6}>tls ends here</text>
      {routes.map((route, i) => <g key={route.id}>
        <text x={route.x + 12} y={mid(route) + 4}>{route.name}</text>
        <text x={route.x + route.w - 12} y={mid(route) + 4} textAnchor="end" opacity={.6}>{route.target}</text>
        <text className="og-small" x={machine.x - 10} y={mid(route) + 3} textAnchor="end" opacity={.5}>0{i + 1}</text>
      </g>)}
      {/* Plate marks in the band's corners. */}
      <text className="og-small" x={0} y={10} opacity={.7}>fig. 1 — a request through the tunnel</text>
      <text className="og-small" x={0} y={H - 4} opacity={.7}>scale 1:∞ — one hop</text>
      <text className="og-small" x={W} y={10} textAnchor="end" opacity={.7}>plate 01 / 01</text>
    </g>
  </svg>
}

/** A dither ramp: squares that grow across the bar, the print's halftone as a scale. */
function Ramp() {
  const cols = 36, rows = 5, cell = 6
  const dots = Array.from({ length: cols * rows }, (_, i) => {
    const c = i % cols, r = Math.floor(i / cols)
    const size = Math.max(.6, (c + .5) / cols * cell * .95 * (1 - ((r + c) % 2) * .15))
    return <rect key={i} x={c * cell + (cell - size) / 2} y={r * cell + (cell - size) / 2} width={size} height={size} />
  })
  return <svg className="og-ramp" viewBox={`0 0 ${cols * cell} ${rows * cell}`} width={cols * cell} height={rows * cell} fill="currentColor" aria-hidden="true">{dots}</svg>
}
