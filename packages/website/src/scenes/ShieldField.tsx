import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import type { Crossing } from "./tunnelFlight"
import type { RelayFront } from "./RelayField"
import { shieldFragmentSource, shieldVertexSource } from "./shieldFieldShader"
import { shieldParams, shieldTuning } from "./shieldTuning"

const INK = [232 / 255, 228 / 255, 220 / 255]

/** The shield's envelope at a scene time, from the measured crossings: a sharp strike as a dot reaches the relay
 * (with a short anticipation as it closes in), a hold while it is inside, and a cooling after it leaves. Pure in
 * scene time, so seeks and the loop restart need no state. */
export function shieldEnvelope(crossings: readonly Crossing[], now: number) {
  let flare = 0, sustain = 0, sinceEnter = 99, sinceLeave = 99
  for (const { enter, leave } of crossings) {
    const since = now - enter
    if (since < -.18) continue
    flare = Math.max(flare, since < 0 ? .35 * (1 + since / .18) ** 2 : Math.exp(-since * 2.6))
    if (since >= 0) {
      sinceEnter = Math.min(sinceEnter, since)
      sustain = Math.max(sustain, now <= leave ? 1 : Math.exp(-(now - leave) * 3))
      if (now >= leave) sinceLeave = Math.min(sinceLeave, now - leave)
    }
  }
  return { flare, sustain, sinceEnter, sinceLeave }
}

/** The relay's shield: always standing, struck by debris, flaring as the sealed bytes pass. Sits around the card. */
export function ShieldField({ crossings, fronts, now, className }: { crossings: readonly Crossing[]; fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef(crossings)
  latest.current = crossings
  useEffect(() => {
    const element = canvas.current
    const card = element?.parentElement?.querySelector<HTMLElement>(".node-card")
    if (!element || !card) return
    const gl = element.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "low-power" })
    if (!gl) return
    const shader = (type: number, source: string) => {
      const object = gl.createShader(type)!
      gl.shaderSource(object, source); gl.compileShader(object)
      return object
    }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, shieldVertexSource))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, shieldFragmentSource))
    gl.linkProgram(program)
    // An ornament: if this GPU can't build it, the diagram simply goes without.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(program)); gl.deleteProgram(program); return }
    gl.useProgram(program)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const u = (name: string) => gl.getUniformLocation(program, name)
    const uniforms = {
      resolution: u("resolution"), box: u("box"), time: u("time"), ambient: u("ambient"), flare: u("flare"), sustain: u("sustain"),
      head: u("head"), pixel: u("pixel"), sinceEnter: u("sinceEnter"), sinceLeave: u("sinceLeave"),
    }
    const tuned = shieldParams.map(param => ({ key: param.key, location: u(param.key), integer: "options" in param }))
    gl.uniform3fv(u("ink"), INK)
    gl.clearColor(0, 0, 0, 0)

    const scale = Math.min(window.devicePixelRatio || 1, 2)
    gl.uniform1f(uniforms.pixel, scale)
    let sized = ""
    const resize = () => {
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale)
      const frame = element.getBoundingClientRect(), rect = card.getBoundingClientRect()
      const size = `${width}x${height}:${rect.left - frame.left}:${rect.width}`
      if (sized === size) return
      sized = size
      element.width = width; element.height = height
      gl.viewport(0, 0, width, height)
      gl.uniform2f(uniforms.resolution, width, height)
      gl.uniform4f(uniforms.box, (rect.left - frame.left) * scale, (frame.bottom - rect.bottom) * scale, rect.width * scale, rect.height * scale)
    }
    // Always drawn while the scene plays: the shield stands, and debris keeps coming.
    const start = performance.now()
    let raf = 0
    const draw = () => {
      raf = 0
      resize()
      const t = now.get()
      const { flare, sustain, sinceEnter, sinceLeave } = shieldEnvelope(latest.current, t)
      const inside = fronts.get().filter(front => front.x >= 0 && front.x <= 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(uniforms.time, t)
      gl.uniform1f(uniforms.ambient, (performance.now() - start) / 1000)
      const values = shieldTuning.get()
      for (const { key, location, integer } of tuned) integer ? gl.uniform1i(location, values[key]) : gl.uniform1f(location, values[key])
      gl.uniform1f(uniforms.flare, flare); gl.uniform1f(uniforms.sustain, sustain)
      gl.uniform1f(uniforms.sinceEnter, sinceEnter); gl.uniform1f(uniforms.sinceLeave, sinceLeave)
      gl.uniform1f(uniforms.head, inside.length ? Math.max(...inside.map(front => front.x)) : -1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const unsubscribe = [fronts.on("change", request), now.on("change", request), shieldTuning.subscribe(request)]
    const observer = new ResizeObserver(() => { sized = ""; request() })
    observer.observe(element)
    request()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      for (const stop of unsubscribe) stop()
      observer.disconnect()
      gl.deleteProgram(program); gl.deleteBuffer(quad)
    }
  }, [fronts, now])
  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
