// Your machine's border as a living membrane: the one place sealed requests come in and are opened. At rest it is a
// faint, warbling line of plasma, a little brighter where the wire meets it. As a packet presses through, the
// membrane bows inward around it and flares; once it is through, ripples run up and down the border and fade.
// Coordinates are CSS pixels, y down. Soft light is dithered like the print. Premultiplied alpha.

export const gateVertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`

export const gateFragmentSource = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform vec2 resolution;           // canvas, device pixels
uniform float pixel;               // device pixels per CSS pixel
uniform float borderX, entryY, top, bottom, fade;
uniform float ambient, push, approach, sinceCross;
uniform vec3 ink;
const float BOW = 4.5;   // how far the membrane bows inward around a packet (GateField's gateBow)

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
float ridge(vec2 p) { return 1.0 - abs(2.0 * fbm(p) - 1.0); }
float bayer(vec2 p) {
  vec2 c = mod(floor(p), 4.0);
  int i = int(c.x) + int(c.y) * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}

void main() {
  vec2 device = vec2(uv.x, 1.0 - uv.y) * resolution;
  vec2 p = device / pixel;
  float dy = p.y - entryY, ady = abs(dy);

  // The membrane's shape: a slow warble along its length; a bow inward around a packet pressing through; and,
  // after a crossing, a pulse running away up and down the border.
  float warble = (fbm(vec2(p.y * 0.05 + ambient * 0.35, ambient * 0.17)) - 0.5) * 2.2;
  float bow = push * BOW * exp(-dy * dy / 110.0);
  float front = sinceCross * 70.0;
  float pulse = sinceCross < 4.0 ? exp(-pow((ady - front) / 10.0, 2.0)) * exp(-sinceCross * 1.1) : 0.0;
  // The pulse is a travelling swell: the line leans out into your machine as it passes.
  float x = p.x - borderX - warble - bow - pulse * 2.4;

  // Energy along it: at rest only a faint, breathing thread, a touch warmer where the wire meets it; much more
  // around a packet and along a running pulse.
  float near = exp(-ady / 28.0);
  float breath = 0.75 + 0.25 * sin(ambient * 0.9 + p.y * 0.02);
  float energy = (0.06 + 0.08 * near) * breath + approach * 0.35 * near + push * 1.3 * exp(-ady / 18.0) + pulse * 0.8;
  float flow = ridge(vec2(p.y * 0.08 - ambient * (0.9 + 2.0 * push), x * 0.3 + ambient * 0.25));
  float filaments = pow(flow, 5.0);
  float width = 0.45 + 0.9 * push + 0.4 * pulse;
  float core = exp(-x * x / width) * min(1.0, energy * 1.6);
  float halo = exp(-abs(x) / (2.2 + 4.0 * push + 2.0 * pulse)) * energy * (0.2 + 0.8 * filaments) * 0.55;
  // Sparks shed into your machine while a packet is in the membrane.
  vec2 cell = vec2(floor((p.x - borderX) * 0.5 - ambient * 9.0), floor(p.y * 0.5));
  float spark = step(0.985, hash(cell + floor(ambient * 12.0))) * push * exp(-ady / 12.0) * step(0.0, p.x - borderX) * exp(-(p.x - borderX) / 10.0);

  // Ends fade before the frame's corners.
  float ends = smoothstep(top, top + fade, p.y) * smoothstep(bottom, bottom - fade, p.y);
  float soft = clamp((halo + spark) * ends, 0.0, 1.0);
  float hard = clamp(core * ends, 0.0, 1.0);
  float printed = soft > 0.8 ? soft : step(bayer(device), soft * 1.2) * min(1.0, 0.3 + soft);
  float alpha = max(hard, mix(soft, printed, 0.6));
  color = vec4(ink * alpha, alpha);
}
`
