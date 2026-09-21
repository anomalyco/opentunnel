import { useEffect, useRef } from "react"
import { fragmentSource, vertexSource } from "./tunnelShader"

const hex = (value: string): [number, number, number] => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number]

/** The poster's printed image: a WebGL tunnel dithered to two inks. Pauses offscreen and in hidden tabs; reduced motion prints one still frame. */
export function TunnelArt({ ink = "#000000", paper = "#ff2a2a", className }: { ink?: string; paper?: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const gl = element.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" })
    if (!gl) { element.dataset.fallback = ""; return }

    const shader = (type: number, source: string) => {
      const object = gl.createShader(type)!
      gl.shaderSource(object, source); gl.compileShader(object)
      if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(object) ?? "shader")
      return object
    }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program")
    gl.useProgram(program)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniforms = {
      resolution: gl.getUniformLocation(program, "resolution"),
      time: gl.getUniformLocation(program, "time"),
      ink: gl.getUniformLocation(program, "ink"),
      paper: gl.getUniformLocation(program, "paper"),
      cell: gl.getUniformLocation(program, "cell"),
    }
    gl.uniform3fv(uniforms.ink, hex(ink))
    gl.uniform3fv(uniforms.paper, hex(paper))

    // Dither cells are device pixels: render at the display's density, capped for battery.
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    // One dither cell per CSS pixel: the same grain on every display.
    gl.uniform1f(uniforms.cell, scale)
    // Sized per program, not per canvas: a remount reuses the canvas but not the uniforms.
    let sized = ""
    const resize = () => {
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale)
      const size = `${width}x${height}`
      if (sized === size) return
      sized = size
      if (element.width !== width || element.height !== height) { element.width = width; element.height = height }
      gl.viewport(0, 0, width, height)
      gl.uniform2f(uniforms.resolution, width, height)
    }
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    let visible = false, hidden = document.hidden, raf = 0, start = performance.now()
    const draw = (now: number) => {
      resize()
      gl.uniform1f(uniforms.time, (now - start) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const tick = (now: number) => { draw(now); raf = requestAnimationFrame(tick) }
    const run = () => {
      cancelAnimationFrame(raf)
      if (media.matches) { draw(start + 7000); return }
      if (visible && !hidden) raf = requestAnimationFrame(tick)
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry!.isIntersecting; run() })
    observer.observe(element)
    const visibility = () => { hidden = document.hidden; run() }
    document.addEventListener("visibilitychange", visibility)
    media.addEventListener("change", run)
    const sizing = new ResizeObserver(() => { if (media.matches) draw(start + 7000) })
    sizing.observe(element)
    draw(start)
    return () => {
      cancelAnimationFrame(raf); observer.disconnect(); sizing.disconnect()
      document.removeEventListener("visibilitychange", visibility); media.removeEventListener("change", run)
      gl.deleteProgram(program); gl.deleteBuffer(quad)
    }
  }, [ink, paper])

  return <canvas ref={canvas} className={className} aria-hidden="true" />
}
