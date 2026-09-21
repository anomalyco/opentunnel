// The relay's interior while the sealed bytes pass through it. `front` is the dot's position across
// the card (0 at the entry wall, 1 at the exit wall); `age` is seconds since impact. A bright front
// with a turbulent wake, ripples spreading from the entry point, and the contents showing only as
// a fine hatch behind the front: the relay sees shape, never text. Premultiplied alpha over the card.

export const relayVertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`

export const relayFragmentSource = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform vec2 resolution;
uniform float front, age, time;
uniform vec3 ink;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = rot * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  float aspect = resolution.x / resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);            // card space, 1 unit = card height
  float entered = smoothstep(0.0, 0.04, age);
  float gone = 1.0 - smoothstep(1.0, 1.35, front); // the field drains once the dot has left
  float envelope = entered * gone;

  // The front: a thin bright line with a soft glow, its shape rippled by the medium.
  float x = uv.x * aspect, fx = front * aspect;
  float wobble = (fbm(vec2(p.y * 6.0, time * 2.0)) - 0.5) * 0.06;
  float dx = x - fx + wobble;
  float line = exp(-dx * dx * 900.0);
  float glow = exp(-abs(dx) * 7.0) * 0.45;

  // The wake: turbulent light trailing the front, brightest just behind it.
  float behind = max(0.0, fx - x);
  float turbulence = fbm(vec2(p.x * 5.0 - time * 1.5, p.y * 5.0 + time * 0.7));
  float wake = exp(-behind * 2.2) * step(0.0, fx - x) * (0.25 + 0.75 * turbulence) * 0.5;

  // Ripples from the entry point: rings spreading and fading, as from a round entering water.
  vec2 entry = vec2(0.0, 0.5);
  float d = length(p - entry);
  float rings = pow(0.5 + 0.5 * cos(d * 26.0 - age * 16.0), 5.0);
  float ripple = rings * exp(-d * 1.8) * exp(-age * 1.5) * 0.6;

  // The contents, seen only in the wake: a hatch, nothing legible.
  float hatch = step(0.55, fract((p.x + p.y) * 22.0)) * exp(-behind * 3.0) * step(0.0, fx - x) * 0.28;

  // Light pools along the middle where the bytes travel.
  float lane = 1.0 - 0.55 * pow(abs(uv.y - 0.5) * 2.0, 2.0);

  float alpha = clamp((line + glow + wake + hatch) * lane + ripple, 0.0, 1.0) * envelope;
  color = vec4(ink * alpha, alpha);
}
`
