import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import { relayFragmentSource, relayVertexSource } from "./relayFieldShader"

/** The ivory of the traveling light. */
const INK = [232 / 255, 228 / 255, 220 / 255]

/** One dot inside the relay: which leg it belongs to, and its position across the card (0 entry wall, 1 exit wall). */
export type RelayFront = { leg: number; x: number }

/** How long a column keeps burning after a front has passed it, in seconds. */
const COOLING = 6

/** The relay's interior as a light field while sealed bytes pass through. `fronts` are the dots currently in flight
 * inside the card; `now` is scene time. Passes stack: each column burns from the last time a front crossed it. */
export function RelayField({ fronts, now, className }: { fronts: MotionValue<readonly RelayFront[]>; now: MotionValue<number>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const gl = element.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "low-power" })
    if (!gl) return
    const shader = (type: number, source: string) => {
      const object = gl.createShader(type)!
      gl.shaderSource(object, source); gl.compileShader(object)
      if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(object) ?? "shader")
      return object
    }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, relayVertexSource))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, relayFragmentSource))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program")
    gl.useProgram(program)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const u = (name: string) => gl.getUniformLocation(program, name)
    const uniforms = { resolution: u("resolution"), now: u("now"), time: u("time"), frontCount: u("frontCount"), fronts: u("fronts") }
    gl.uniform3fv(u("ink"), INK)
    gl.clearColor(0, 0, 0, 0)

    // One texel per column across the card: the scene time at which a front last passed it.
    const COLUMNS = 256, NEVER = -1e6
    const stamps = new Float32Array(COLUMNS).fill(NEVER)
    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, COLUMNS, 1, 0, gl.RED, gl.FLOAT, stamps)
    gl.uniform1i(u("passed"), 0)
    // Each front stamps the columns it crossed since its last frame. Scene time running backwards (a seek or
    // the loop restarting) clears the burn.
    let lastNow = -Infinity, latest = NEVER
    const previous = new Map<number, number>()
    const stamp = (active: readonly RelayFront[], t: number) => {
      if (t < lastNow) { stamps.fill(NEVER); previous.clear(); latest = NEVER }
      lastNow = t
      for (const front of active) {
        const from = previous.get(front.leg) ?? -Infinity
        previous.set(front.leg, front.x)
        for (let i = 0; i < COLUMNS; i++) {
          const column = (i + .5) / COLUMNS
          if (column > from && column <= front.x) { stamps[i] = t; latest = t }
        }
      }
      for (const leg of previous.keys()) if (!active.some(front => front.leg === leg)) previous.delete(leg)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, COLUMNS, 1, gl.RED, gl.FLOAT, stamps)
    }

    const scale = Math.min(window.devicePixelRatio || 1, 2)
    let sized = ""
    const resize = () => {
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale)
      const size = `${width}x${height}`
      if (sized === size) return
      sized = size
      element.width = width; element.height = height
      gl.viewport(0, 0, width, height)
      gl.uniform2f(uniforms.resolution, width, height)
    }
    // Draw only while the field is alive: while a dot is inside, and until the last burn has cooled.
    const start = performance.now()
    const positions = new Float32Array(4)
    let raf = 0
    const draw = () => {
      raf = 0
      resize()
      const active = fronts.get().filter(front => front.x >= 0), t = now.get()
      stamp(active, t)
      const alive = active.length > 0 || t - latest < COOLING
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (alive) {
        const count = Math.min(active.length, 4)
        for (let i = 0; i < count; i++) positions[i] = active[i]!.x
        gl.uniform1i(uniforms.frontCount, count); gl.uniform1fv(uniforms.fronts, positions)
        gl.uniform1f(uniforms.now, t); gl.uniform1f(uniforms.time, (performance.now() - start) / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const unsubscribe = [fronts.on("change", request), now.on("change", request)]
    const observer = new ResizeObserver(request)
    observer.observe(element)
    request()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      for (const stop of unsubscribe) stop()
      observer.disconnect()
      gl.deleteProgram(program); gl.deleteBuffer(quad); gl.deleteTexture(texture)
    }
  }, [fronts, now])
  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
