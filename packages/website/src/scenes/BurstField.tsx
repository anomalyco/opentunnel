import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import { burstFragmentSource, burstVertexSource } from "./burstFieldShader"

/** The ivory of the traveling light. */
const INK = [232 / 255, 228 / 255, 220 / 255]

/** A card's interior lit from one socket: the ember when light leaves it (`mode: "ember"`), the flood when
 * light lands (`mode: "strike"`). `at` are the scene seconds of each event; `clock` is the scene clock. */
export function BurstField({ clock, at, origin, mode, className }: {
  clock: MotionValue<number>; at: readonly number[]; origin: readonly [number, number]; mode: "ember" | "strike"; className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const events = at.join(",")
  // How long a burst lives, in scene seconds: the ember lingers, the strike is quicker.
  const duration = mode === "ember" ? 1.6 : 1.4
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
    gl.attachShader(program, shader(gl.VERTEX_SHADER, burstVertexSource))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, burstFragmentSource))
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
    const uniforms = { resolution: u("resolution"), age: u("age"), time: u("time") }
    gl.uniform3fv(u("ink"), INK)
    gl.uniform2f(u("origin"), origin[0], origin[1])
    gl.uniform1f(u("duration"), duration)
    gl.uniform1f(u("mode"), mode === "ember" ? 0 : 1)
    gl.clearColor(0, 0, 0, 0)

    const times = events.split(",").map(Number)
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
    const start = performance.now()
    let raf = 0
    const draw = () => {
      raf = 0
      resize()
      const now = clock.get()
      // The most recent event that has happened: its age drives the burst.
      let age = Infinity
      for (const t of times) { const a = now - t; if (a >= 0 && a < age) age = a }
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (age < duration) {
        gl.uniform1f(uniforms.age, age); gl.uniform1f(uniforms.time, (performance.now() - start) / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const unsubscribe = clock.on("change", request)
    const observer = new ResizeObserver(request)
    observer.observe(element)
    request()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      unsubscribe()
      observer.disconnect()
      gl.deleteProgram(program); gl.deleteBuffer(quad)
    }
  }, [clock, events, origin[0], origin[1], mode])
  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
