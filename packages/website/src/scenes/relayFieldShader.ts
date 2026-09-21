// The relay's interior while the sealed bytes pass through it. `front` is the dot's position across
// the card (0 at the entry wall, 1 at the exit wall); `age` is seconds since impact. A bright,
// distorted front, and behind it an afterburn: each column remembers when the front passed
// (`passed`, a 1D texture) and cools from that moment. The contents show only as hatching in the
// burn: the relay sees shape, never text. Premultiplied alpha over the card.

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
uniform sampler2D passed;   // per column: age at which the front passed, or -1

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
  // The field lives from impact until the burn has cooled; nothing switches it off.
  float envelope = smoothstep(0.0, 0.04, age);

  // The medium bends the light: the front and everything behind it is displaced by slow turbulence.
  float warp = (fbm(vec2(p.y * 5.0 + time * 0.8, p.x * 2.0 - time * 0.4)) - 0.5) * 0.09;
  float x = uv.x * aspect + warp, fx = front * aspect;
  float dx = x - fx;
  float line = exp(-dx * dx * 700.0);
  float glow = exp(-abs(dx) * 6.0) * 0.3;

  // Afterburn: how long ago the front passed this column, from the stamped texture.
  float stamp = texture(passed, vec2(clamp(uv.x + warp / aspect, 0.0, 1.0), 0.5)).r;
  float since = stamp >= 0.0 ? max(0.0, age - stamp) : 1e3;
  float burn = exp(-since * 0.9);
  float turbulence = fbm(vec2(p.x * 6.0 - time * 1.2, p.y * 6.0 + since * 3.0));
  float wake = burn * (0.35 + 0.65 * turbulence) * 0.32;
  // Hot core just behind the front, cooling into the wake.
  float ember = exp(-since * 4.0) * 0.25;

  // The contents, seen only in the burn: a hatch, nothing legible, shimmering as it cools.
  float hatch = step(0.55, fract((p.x + p.y + warp * 4.0) * 22.0)) * burn * 0.22;

  // Light pools along the middle where the bytes travel.
  float lane = 1.0 - 0.5 * pow(abs(uv.y - 0.5) * 2.0, 2.0);

  float alpha = clamp((line + glow + wake + ember + hatch) * lane, 0.0, 1.0) * envelope;
  color = vec4(ink * alpha, alpha);
}
`
