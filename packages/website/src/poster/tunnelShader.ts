// A procedural tunnel, printed in two inks. Perspective rings recede toward a
// vanishing point above a black sphere; turbulence tears the rings into cloud;
// an ordered dither quantises the field to red or black so it reads like a
// risograph print rather than a smooth gradient.

export const vertexSource = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`

export const fragmentSource = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 resolution;
uniform float time;
uniform vec3 ink;
uniform vec3 paper;
uniform float cell;
uniform vec2 eye;
uniform float depth, ringFrequency, ringSpeed, warpAmount, streakAmount;
uniform float wallInk, bandInk, distanceInk, eyeGlow;
uniform vec2 sphereCenter;
uniform float sphereRadius, sphereHalo;
uniform float seaLevel, seaInk;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
// Interleaved gradient noise: an ordered dither with a stipple rather than a checker.
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }

// The field is ink coverage: 0 prints paper (red), 1 prints ink (black).
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = (px - 0.5 * resolution) / resolution.y;
  vec2 d = uv - eye;
  float r = length(d);
  // Seamless angular coordinate: noise sampled on a circle has no seam at ±π.
  vec2 ring = d / max(r, 1e-4);
  float t = time;

  // Perspective depth: rings compress toward the eye and roll inward.
  float z = depth / max(r, 0.015);
  float warp = fbm(ring * 2.4 + vec2(0.0, z * 0.45 - t * 1.5)) * warpAmount;
  float bands = 0.5 + 0.5 * sin(z * ringFrequency - t * ringSpeed + warp);
  bands = smoothstep(0.35, 0.7, bands);
  // Torn cloud along the walls; streaks tear red light through the black bands.
  float streak = fbm(ring * 3.5 + vec2(t * 0.3, z * 0.8 - t * 2.5));
  float wall = wallInk + bandInk * bands + streakAmount * (streak - 0.5);
  // The walls go heavier with distance from the eye and up into the corners.
  wall += distanceInk * smoothstep(0.25, 0.8, r);
  wall *= 0.75 + 0.45 * smoothstep(-0.5, 0.45, d.y);
  // The eye itself burns through: paper, not ink.
  wall *= smoothstep(0.015, 0.015 + eyeGlow, r);
  wall = clamp(wall, 0.0, 1.0);

  // A black sphere, lit from behind.
  float sr = sphereRadius;
  float sd = length(uv - sphereCenter);
  float body = sr > 0.0 ? smoothstep(sr, sr - 0.003, sd) : 0.0;
  // A thin hard rim of paper, then a soft halo that fades into the walls.
  float rim = sr > 0.0 ? smoothstep(sr + 0.014, sr + 0.006, sd) * (1.0 - body) : 0.0;
  float halo = sr > 0.0 ? smoothstep(sr + sphereHalo, sr + 0.01, sd) * (1.0 - body) : 0.0;
  halo *= 0.5 + 0.5 * smoothstep(-0.15, 0.3, uv.y - sphereCenter.y);
  float grain = fbm((uv - sphereCenter) * 18.0 + t * 0.7);
  float bodyInk = 0.985 - 0.3 * smoothstep(0.6, 0.85, grain) * smoothstep(sr, sr * 0.55, sd);
  float field = mix(wall * (1.0 - halo * 0.7) * (1.0 - rim), bodyInk, body);

  // Ground: a turbulent sea below the sphere, heavy ink near the bottom edge.
  float sea = fbm(vec2(uv.x * 5.0 + t * 0.6, (uv.y + 0.7) * 16.0 - t * 4.0));
  float shore = smoothstep(seaLevel, seaLevel - 0.43, uv.y);
  sea = seaInk * ((0.3 + 1.0 * smoothstep(0.35, 0.7, sea)) * shore + 0.4 * smoothstep(seaLevel - 0.48, seaLevel - 0.73, uv.y));
  field = mix(max(field, sea), field, body);

  // Two inks. Dither in CSS-pixel cells so the grain is the same on every display.
  float threshold = ign(floor(px / cell));
  float printed = step(threshold, field);
  color = vec4(mix(paper, ink, printed), 1.0);
}
`
