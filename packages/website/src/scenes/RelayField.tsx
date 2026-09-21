import { useEffect, useRef } from "react"
import type { MotionValue } from "motion/react"
import { relayFragmentSource, relayVertexSource } from "./relayFieldShader"

const hex = (value: string): [number, number, number] => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number]

/** The relay's interior as a light field while the sealed bytes pass through. `front` is the dot's position across the
 * card (0 entry wall, 1 exit wall; outside that range nothing is drawn); `age` is seconds since impact, negative before. */
export function RelayField({ front, age, ink = "#e8e4dc", className }: { front: MotionValue<number>; age: MotionValue<number>; ink?: string; className?: string }) {
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
    const uniforms = { resolution: u("resolution"), front: u("front"), age: u("age"), time: u("time") }
    gl.uniform3fv(u("ink"), hex(ink))
    gl.clearColor(0, 0, 0, 0)

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
    // Draw only while the field is alive: from impact until the light has drained after the exit.
    const start = performance.now()
    let raf = 0, dirty = true
    const draw = () => {
      raf = 0
      resize()
      const f = front.get(), a = age.get()
      const alive = a >= 0 && f < 1.4
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (alive) {
        gl.uniform1f(uniforms.front, f); gl.uniform1f(uniforms.age, a); gl.uniform1f(uniforms.time, (performance.now() - start) / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      dirty = false
    }
    const request = () => { dirty = true; if (!raf) raf = requestAnimationFrame(draw) }
    const unsubscribe = [front.on("change", request), age.on("change", request)]
    const observer = new ResizeObserver(request)
    observer.observe(element)
    request()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      for (const stop of unsubscribe) stop()
      observer.disconnect()
      gl.deleteProgram(program); gl.deleteBuffer(quad)
      void dirty
    }
  }, [front, age, ink])
  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
