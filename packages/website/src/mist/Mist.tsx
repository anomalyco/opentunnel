import { useEffect, useRef, type CSSProperties } from "react"

// Mist leaking from the O's counter onto the page: a thin plume that falls away down and to the right on
// a slow wind, gusting a little, screened into the print's dither so it stays a texture. Ambient: it runs
// on its own frame loop while visible, like the banner's print.

const vertex = `#version 300 es
in vec2 position; out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`
const fragment = `#version 300 es
precision highp float;
in vec2 uv; out vec4 color;
uniform vec2 resolution, source; uniform float time, cell;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = rot * p * 2.03 + 11.7; a *= 0.5; } return v; }
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }
void main() {
  float aspect = resolution.x / resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 s = vec2(source.x * aspect, source.y);
  // The wind: down and to the right, veering slowly.
  float veer = (fbm(vec2(time * 0.03, 3.0)) - 0.5) * 0.6;
  vec2 wind = normalize(vec2(0.45 + veer, -0.9));
  vec2 side = vec2(-wind.y, wind.x);
  vec2 q = p - s;
  float along = dot(q, wind), across = dot(q, side);
  // Gusts push the plume sideways more the farther it has travelled.
  across += (fbm(vec2(along * 1.5 - time * 0.07, time * 0.04)) - 0.5) * 0.4 * along;
  float width = 0.03 + 0.26 * along;
  float plume = smoothstep(0.0, 0.06, along) * exp(-along * 0.9) * exp(-across * across / (2.0 * width * width));
  float fog = fbm(vec2(p.x * 3.4, p.y * 3.4) - wind * time * 0.05);
  float density = smoothstep(0.5, 0.8, fog) * plume;
  float alpha = density * 0.11;
  float printed = step(ign(floor(gl_FragCoord.xy / cell)), alpha);
  color = vec4(vec3(printed), printed);
}
`

export function Mist({ className, style, source }: { className?: string; style?: CSSProperties; source: readonly [number, number] }) {
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
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(program); gl.useProgram(program)
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "position")
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const resolution = gl.getUniformLocation(program, "resolution"), time = gl.getUniformLocation(program, "time")
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    gl.uniform1f(gl.getUniformLocation(program, "cell"), 1.5 * scale)
    gl.uniform2f(gl.getUniformLocation(program, "source"), source[0], source[1])
    gl.clearColor(0, 0, 0, 0)
    let sized = ""
    const resize = () => {
      const width = Math.round(element.clientWidth * scale), height = Math.round(element.clientHeight * scale)
      const size = `${width}x${height}`
      if (sized === size || !width || !height) return
      sized = size; element.width = width; element.height = height
      gl.viewport(0, 0, width, height); gl.uniform2f(resolution, width, height)
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const start = performance.now()
    let raf = 0, visible = true
    const frame = () => {
      raf = 0
      resize()
      gl.uniform1f(time, reduced ? 3 : (performance.now() - start) / 1000)
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (visible && !reduced && !document.hidden) raf = requestAnimationFrame(frame)
    }
    const request = () => { if (!raf) raf = requestAnimationFrame(frame) }
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; if (visible) request() })
    observer.observe(element)
    const resized = new ResizeObserver(request); resized.observe(element)
    document.addEventListener("visibilitychange", request)
    request()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect(); resized.disconnect(); document.removeEventListener("visibilitychange", request)
      gl.deleteProgram(program); gl.deleteBuffer(quad)
    }
  }, [source[0], source[1]])
  return <canvas ref={canvas} className={className} style={style} aria-hidden="true" />
}
