// The relay's interior while sealed bytes pass through it. `fronts` are the positions of every dot
// currently inside (0 at the entry wall, 1 at the exit wall), `now` is scene time. A bright,
// distorted front for each, and behind them an afterburn: each column remembers the scene time at
// which a front last passed (`passed`, a 1D texture) and cools from that moment, so passes stack.
// The contents show only as hatching in the burn: the relay sees shape, never text. Premultiplied
// alpha over the card.

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
uniform float now, time, cell;
uniform int frontCount;
uniform float fronts[4];
uniform vec3 ink;
uniform sampler2D passed;   // per column: scene time at which a front last passed, or far in the past

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
  // The medium bends the light: the fronts and everything behind them are displaced by slow turbulence.
  float warp = (fbm(vec2(p.y * 5.0 + time * 0.8, p.x * 2.0 - time * 0.4)) - 0.5) * 0.09;
  float x = uv.x * aspect + warp;
  float line = 0.0, glow = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= frontCount) break;
    float dx = x - fronts[i] * aspect;
    line += exp(-dx * dx * 700.0);
    glow += exp(-abs(dx) * 6.0) * 0.3;
  }

  // Afterburn: how long ago a front last passed this column, from the stamped texture.
  float stamp = texture(passed, vec2(clamp(uv.x + warp / aspect, 0.0, 1.0), 0.5)).r;
  float since = max(0.0, now - stamp);
  float burn = exp(-since * 0.9);
  float turbulence = fbm(vec2(p.x * 6.0 - time * 1.2, p.y * 6.0 + since * 3.0));
  float wake = burn * (0.35 + 0.65 * turbulence) * 0.32;
  // Hot core just behind the front, cooling into the wake.
  float ember = exp(-since * 4.0) * 0.25;

  // The contents, seen only in the burn: a hatch, nothing legible, shimmering as it cools.
  float hatch = step(0.55, fract((p.x + p.y + warp * 4.0) * 22.0)) * burn * 0.22;

  // Light pools along the middle where the bytes travel.
  float lane = 1.0 - 0.5 * pow(abs(uv.y - 0.5) * 2.0, 2.0);

  float alpha = clamp((line + glow + wake + ember + hatch) * lane, 0.0, 1.0);
  // Printed, not shaded: the field is screened into dots of one ink, the way the banner is.
  vec2 cellPx = floor(gl_FragCoord.xy / cell);
  float threshold = fract(52.9829189 * fract(0.06711056 * cellPx.x + 0.00583715 * cellPx.y));
  float printed = step(threshold, alpha * 1.15);
  color = vec4(ink * printed, printed);
}
`
