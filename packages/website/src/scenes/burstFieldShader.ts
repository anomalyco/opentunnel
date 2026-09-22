// A card's interior when light leaves it or lands on it: the relay field's texture, as a burst
// from one socket. `origin` is the socket in card space (0..1 across, 0..1 up); `age` is seconds
// since the event, `duration` how long the burst lives. Mode 0 is the ember (light leaving: a
// warm pool at the socket that seeps outward and cools); mode 1 is the strike (light landing: a
// small bright burst at the socket that fades). Premultiplied alpha over the card.

export const burstVertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`

export const burstFragmentSource = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform vec2 resolution;
uniform vec2 origin;
uniform float age, duration, time, mode;
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
  vec2 o = vec2(origin.x * aspect, origin.y);
  float t = clamp(age / duration, 0.0, 1.0);

  // The same bent medium as the relay's.
  float warp = (fbm(vec2(p.y * 5.0 + time * 0.8, p.x * 2.0 - time * 0.4)) - 0.5) * 0.09;
  vec2 q = p + vec2(warp, 0.0);
  float d = distance(q, o);
  float turbulence = fbm(vec2(p.x * 6.0 - time * 1.2, p.y * 6.0 + age * 3.0));

  float field;
  if (mode < 0.5) {
    // Ember: warm at the socket at once, seeping a little outward as it cools quickly.
    float radius = 0.35 + 0.9 * sqrt(t);
    float core = smoothstep(0.0, 0.04, t) * pow(1.0 - t, 1.8);
    field = core * pow(max(0.0, 1.0 - d / radius), 2.2) * 0.55;
  } else {
    // Strike: a small burst at the socket, brightest at once, growing a little as it fades.
    float radius = 0.5 + 0.7 * sqrt(t);
    float fade = pow(1.0 - t, 1.6);
    field = fade * pow(max(0.0, 1.0 - d / radius), 2.0) * 0.8;
  }

  // The contents show only as hatching in the light: shape, never text.
  float hatch = step(0.55, fract((p.x + p.y + warp * 4.0) * 22.0)) * field * 0.35;
  float alpha = clamp(field * (0.35 + 0.65 * turbulence) * 0.5 + hatch, 0.0, 1.0);
  color = vec4(ink * alpha, alpha);
}
`
