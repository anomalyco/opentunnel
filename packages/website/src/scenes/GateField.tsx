import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import { gateFragmentSource, gateVertexSource } from "./gateFieldShader"

const INK = [232 / 255, 228 / 255, 220 / 255]
const PAD = 44

/** How far the membrane bows inward around a packet, in CSS pixels, by the packet's offset from the border; the
 * packet is opened along the bowed line. Matches the shader's BOW. */
export const gatePush = (offset: number) => Math.exp(-((offset / 9) ** 2))
export const gateBow = 4.5

/** What a membrane feels at a scene time: how hard a packet presses into it, how near one is on the way, and how
 * long since one last passed through. */
export type GateTouch = { push: number; approach: number; sinceCross: number }

/** A card's border as a plasma membrane (see gateFieldShader): the browser's, where requests are sealed, and your
 * machine's, where they are opened. Positioned over the border in the diagram's coordinates. */
export function GateField({ clock, touch, border, entryY, top, bottom }: {
  clock: MotionValue<number>; touch: (t: number) => GateTouch
  border: number; entryY: number; top: number; bottom: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const left = border - PAD, height = bottom - top + 20, origin = top - 10
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const gl = element.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "low-power" })
    if (!gl) return
    const shader = (type: number, source: string) => { const object = gl.createShader(type)!; gl.shaderSource(object, source); gl.compileShader(object); return object }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, gateVertexSource))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, gateFragmentSource))
    gl.linkProgram(program)
    // An ornament: if this GPU can't build it, the plain border stands.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(program)); gl.deleteProgram(program); return }
    gl.useProgram(program)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const u = (name: string) => gl.getUniformLocation(program, name)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = PAD * 2
    element.width = Math.round(width * dpr); element.height = Math.round(height * dpr)
    gl.viewport(0, 0, element.width, element.height)
    gl.uniform2f(u("resolution"), element.width, element.height)
    gl.uniform1f(u("pixel"), dpr)
    gl.uniform3fv(u("ink"), INK)
    gl.uniform1f(u("borderX"), PAD); gl.uniform1f(u("entryY"), entryY - origin)
    gl.uniform1f(u("top"), top - origin); gl.uniform1f(u("bottom"), bottom - origin)
    gl.uniform1f(u("fade"), Math.min(14, (bottom - top) * .22))
    const live = { ambient: u("ambient"), push: u("push"), approach: u("approach"), sinceCross: u("sinceCross") }
    gl.clearColor(0, 0, 0, 0)
    const start = performance.now()
    let raf = 0
    const draw = () => {
      raf = 0
      const { push, approach, sinceCross } = touch(clock.get())
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(live.ambient, (performance.now() - start) / 1000)
      gl.uniform1f(live.push, push); gl.uniform1f(live.approach, approach); gl.uniform1f(live.sinceCross, sinceCross)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const stop = clock.on("change", request)
    request()
    return () => { stop(); if (raf) cancelAnimationFrame(raf); gl.deleteProgram(program); gl.deleteBuffer(quad) }
  }, [clock, touch, border, entryY, top, bottom, height, origin])
  return <canvas ref={canvas} className="tunnel-gate-field" style={{ left, top: origin, width: PAD * 2, height }} aria-hidden="true" />
}
