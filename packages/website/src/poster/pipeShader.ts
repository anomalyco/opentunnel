// A pipe, raymarched: an open tube with a thick lip at its mouth, lit from one side, with packets
// sliding through it and out. Shaded to luminance, then printed in the poster's two inks with the
// same ordered dither as the tunnel, so it still reads as a screen print.

export const pipeFragmentSource = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 resolution;
uniform float time;
uniform vec3 ink;
uniform vec3 paper;
uniform float cell;
uniform vec2 eye;            // where the mouth sits (height units from centre)
uniform float depth;         // pipe length
uniform float ringSpeed;     // packet speed
uniform float ringFrequency; // packets in flight
uniform float warpAmount;    // yaw of the pipe, in radians × 0.3
uniform float streakAmount;  // grain in the shading
uniform float wallInk;       // background ink
uniform float bandInk;       // shadow depth
uniform float distanceInk;   // fog
uniform float eyeGlow;       // rim light
uniform vec2 sphereCenter;   // unused here
uniform float sphereRadius, sphereHalo, seaLevel, seaInk;
uniform vec3 fade;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }

const float R = 0.9;      // tube radius
const float W = 0.09;     // wall thickness
const float LIP = 0.16;   // how much the lip stands proud
const float LIPLEN = 0.42;

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }

float sdTube(vec3 q, float r, float w, float z0, float z1) {
  float radial = abs(length(q.xy) - r) - w;
  float axial = max(z0 - q.z, q.z - z1);
  return max(radial, axial);
}

// Scene SDF in pipe space: the mouth is at z = 0 and the body runs to z = -depth.
// .y carries the material: 0 pipe, 1 packet.
vec2 map(vec3 q, float length_) {
  float body = sdTube(q, R, W, -length_, -LIPLEN);
  float lip = sdTube(q, R + LIP * 0.5, W + LIP * 0.5, -LIPLEN, 0.0);
  float pipe = min(body, lip);
  float packets = 1e9;
  float count = max(1.0, floor(ringFrequency));
  float span = length_ + 3.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= count) break;
    float z = mod(time * ringSpeed * 0.35 + float(i) * span / count, span) - length_;
    packets = min(packets, length(q - vec3(0.0, 0.0, z)) - 0.34);
  }
  return pipe < packets ? vec2(pipe, 0.0) : vec2(packets, 1.0);
}

vec3 normalAt(vec3 q, float length_) {
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(
    map(q + e.xyy, length_).x - map(q - e.xyy, length_).x,
    map(q + e.yxy, length_).x - map(q - e.yxy, length_).x,
    map(q + e.yyx, length_).x - map(q - e.yyx, length_).x));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = (px - 0.5 * resolution) / resolution.y;
  float length_ = 2.0 + depth * 8.0;

  // Camera looks down -z; the pipe's mouth sits at eye, its body yawed away and slightly up.
  vec3 ro = vec3(0.0, 0.0, 4.2);
  vec3 rd = normalize(vec3(uv, -1.7));
  mat3 frame = rotX(0.18) * rotY(-0.55 - warpAmount * 0.3);
  vec3 mouth = vec3(eye.x * 2.2, eye.y * 2.2, 0.0);

  float t = 0.0, material = -1.0;
  vec3 pos = ro;
  for (int i = 0; i < 96; i++) {
    pos = ro + rd * t;
    vec2 hit = map(frame * (pos - mouth), length_);
    if (hit.x < 0.0015) { material = hit.y; break; }
    t += hit.x * 0.9;
    if (t > 40.0) break;
  }

  // Ink coverage: dark where unlit. Background is mostly ink with a breath of grain.
  float field = wallInk + 0.5 + (hash(floor(px / cell) * 0.37) - 0.5) * streakAmount * 0.15;
  if (material >= 0.0) {
    vec3 q = frame * (pos - mouth);
    vec3 n = transpose(frame) * normalAt(q, length_);
    vec3 light = normalize(vec3(-0.55, 0.75, 0.6));
    float diffuse = max(dot(n, light), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * eyeGlow * 3.0;
    float spec = pow(max(dot(reflect(-light, n), -rd), 0.0), 24.0) * 0.35;
    // Inside the tube it is darker the deeper you look.
    float inside = length(q.xy) < R && material < 0.5 ? smoothstep(0.0, -length_ * 0.6, q.z) : 0.0;
    float lum = 0.12 + 0.88 * diffuse + spec + rim;
    lum *= 1.0 - inside * 0.85;
    lum *= exp(-t * distanceInk * 0.12);
    if (material > 0.5) lum = 0.35 + 0.65 * diffuse + spec * 2.0; // packets: brighter, glossier
    lum += (hash(floor(px / cell) * 0.11 + 3.0) - 0.5) * streakAmount * 0.25;
    field = 1.0 - clamp(lum, 0.0, 1.0);
    field = mix(field, 1.0, bandInk * 0.3 * (1.0 - diffuse));
  }

  float along = fade.z > 0.5 ? 1.0 - px.y / resolution.y : px.x / resolution.x;
  if (fade.y > fade.x) field *= smoothstep(fade.x, fade.y, along);

  float threshold = ign(floor(px / cell));
  float printed = step(threshold, field);
  color = vec4(mix(paper, ink, printed), 1.0);
}
`
