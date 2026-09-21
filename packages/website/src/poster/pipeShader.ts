// A pipe, raymarched: an open tube lying across the frame at three-quarter view, a thick lip on each
// mouth, resting on a plain ground that catches its shadow. Packets slide in the near mouth, vanish,
// and come out the far one. Nothing is allowed to look like a clean model: the tube bends and
// breathes, the packets deform, the picture is warped by noise and torn by glitch bands, and grain
// streams past. Shaded to luminance, then printed in the poster's two inks with the same ordered
// dither as the tunnel, so it still reads as a screen print.

export const pipeFragmentSource = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 resolution;
uniform float time;
uniform vec3 ink;
uniform vec3 paper;
uniform float cell;
uniform vec2 eye;            // where the pipe's centre sits (height units from centre)
uniform float depth;         // pipe length
uniform float ringSpeed;     // packet speed
uniform float ringFrequency; // packets in flight
uniform float warpAmount;    // yaw of the pipe
uniform float streakAmount;  // grain in the shading
uniform float wallInk;       // sky ink
uniform float bandInk;       // shadow depth
uniform float distanceInk;   // fog
uniform float eyeGlow;       // rim light
uniform vec2 sphereCenter;   // unused here
uniform float sphereRadius, sphereHalo;
uniform float seaLevel;      // camera height
uniform float seaInk;        // ground ink
uniform vec3 fade;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }
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

// The scene clock runs slow (a print, not a film); the wobble wants something nearer real seconds.
float T;

const float R = 0.62;      // tube radius
const float W = 0.07;      // wall thickness
const float LIP = 0.12;    // how much each lip stands proud
const float LIPLEN = 0.32; // how long each lip is
const float PACKET = 0.26;

float sdTube(vec3 q, float r, float w, float z0, float z1) {
  float radial = abs(length(q.xy) - r) - w;
  float axial = max(z0 - q.z, q.z - z1);
  return max(radial, axial);
}

// The pipe alone, in pipe space: the near mouth at z = 0, the body running to z = -length.
// It bends along its length and breathes, so no two frames show the same tube.
float pipeAt(vec3 q, float length_) {
  q.xy += vec2(sin(q.z * 1.1 + T * 0.9), cos(q.z * 0.7 - T * 0.6)) * 0.09;
  q.xy *= 1.0 + 0.06 * sin(q.z * 2.3 - T * 1.7);
  float body = sdTube(q, R, W, -length_ + LIPLEN, -LIPLEN);
  float near = sdTube(q, R + LIP * 0.5, W + LIP * 0.5, -LIPLEN, 0.0);
  float far = sdTube(q, R + LIP * 0.5, W + LIP * 0.5, -length_, -length_ + LIPLEN);
  return min(body, min(near, far));
}

// Packets travel the axis from beyond the near mouth to beyond the far one. Inside the pipe they are
// hidden by its wall; that is the point.
float packetsAt(vec3 q, float length_) {
  float d = 1e9;
  float count = max(1.0, floor(ringFrequency));
  float run = length_ + 5.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= count) break;
    float z = 2.5 - mod(time * ringSpeed * 0.4 + float(i) * run / count, run);
    // Each packet is a lump, not a ball: displaced and dented by noise as it goes.
    vec3 c = vec3(sin(z * 2.0 + T * 2.1 + float(i)) * 0.08, cos(z * 1.6 - T * 1.3) * 0.06, z);
    vec3 v = q - c;
    float dent = (fbm(v.xy * 6.0 + v.z * 3.0 + T * 0.8 + float(i) * 7.0) - 0.5) * 0.14;
    d = min(d, length(v) - PACKET * (1.0 + 0.12 * sin(T * 3.0 + float(i) * 2.0)) + dent);
  }
  return d;
}

// .y carries the material: 0 pipe, 1 packet, 2 ground.
vec2 map(vec3 p, mat3 toPipe, vec3 origin, float length_, float groundY) {
  vec3 q = toPipe * (p - origin);
  float pipe = pipeAt(q, length_);
  float packets = packetsAt(q, length_);
  float ground = p.y - groundY;
  vec2 best = vec2(pipe, 0.0);
  if (packets < best.x) best = vec2(packets, 1.0);
  if (ground < best.x) best = vec2(ground, 2.0);
  return best;
}

vec3 normalAt(vec3 p, mat3 toPipe, vec3 origin, float length_, float groundY) {
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(
    map(p + e.xyy, toPipe, origin, length_, groundY).x - map(p - e.xyy, toPipe, origin, length_, groundY).x,
    map(p + e.yxy, toPipe, origin, length_, groundY).x - map(p - e.yxy, toPipe, origin, length_, groundY).x,
    map(p + e.yyx, toPipe, origin, length_, groundY).x - map(p - e.yyx, toPipe, origin, length_, groundY).x));
}

// How much of the light reaches p: a short march toward it against the pipe and packets only.
float shadowAt(vec3 p, vec3 light, mat3 toPipe, vec3 origin, float length_) {
  float t = 0.04, shade = 1.0;
  for (int i = 0; i < 40; i++) {
    vec3 q = toPipe * (p + light * t - origin);
    float d = min(pipeAt(q, length_), packetsAt(q, length_));
    shade = min(shade, 10.0 * d / t);
    if (shade < 0.002 || t > 12.0) break;
    t += clamp(d, 0.02, 0.4);
  }
  return clamp(shade, 0.0, 1.0);
}

void main() {
  T = time * 8.0;
  vec2 px = gl_FragCoord.xy;
  vec2 uv = (px - 0.5 * resolution) / resolution.y;
  float length_ = 2.0 + depth * 8.0;

  // The picture itself is unsteady: bent by slow noise, torn sideways in bands that come and go.
  vec2 warp = vec2(fbm(uv * 2.5 + vec2(T * 0.25, 0.0)), fbm(uv * 2.5 - vec2(0.0, T * 0.2) + 5.0)) - 0.5;
  uv += warp * 0.07 * (0.5 + streakAmount);
  float band = floor(uv.y * 28.0 + T * 0.7);
  float tearGate = step(0.93, hash(vec2(band, floor(T * 6.0))));
  uv.x += tearGate * (hash(vec2(band * 3.1, floor(T * 6.0) + 1.0)) - 0.5) * 0.5;
  float fine = floor(uv.y * 160.0);
  uv.x += step(0.985, hash(vec2(fine, floor(T * 12.0)))) * (hash(vec2(fine, 2.0)) - 0.5) * 0.06;

  // The pipe lies along the ground, yawed so its far end recedes to the right.
  float yaw = 0.5 + warpAmount;
  vec3 axis = normalize(vec3(cos(yaw), 0.0, -sin(yaw)));   // near mouth → far mouth, in world
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(up, axis));
  mat3 fromPipe = mat3(side, up, -axis);                    // pipe x, y, z as world vectors
  mat3 toPipe = transpose(fromPipe);
  float groundY = -(R + W + LIP * 0.5);
  vec3 centre = vec3(eye.x * 4.0, eye.y * 2.0, 0.0);
  vec3 origin = centre - axis * (length_ * 0.5);            // the near mouth

  // Camera a little above the pipe, looking gently down along the ground.
  vec3 ro = vec3(0.0, 0.9 + seaLevel * 2.0, 7.0);
  vec3 target = vec3(centre.x * 0.6, -0.1, 0.0);
  vec3 f = normalize(target - ro), r = normalize(cross(f, up)), u = cross(r, f);
  vec3 rd = normalize(f * 1.9 + r * uv.x + u * uv.y);

  float t = 0.0, material = -1.0;
  vec3 pos = ro;
  for (int i = 0; i < 110; i++) {
    pos = ro + rd * t;
    vec2 hit = map(pos, toPipe, origin, length_, groundY);
    if (hit.x < 0.0015) { material = hit.y; break; }
    t += hit.x * 0.9;
    if (t > 60.0) break;
  }

  vec3 light = normalize(vec3(-0.5, 0.8, 0.45));
  // Ink coverage: the sky is nearly solid ink with a breath of grain.
  float grain = (hash(floor(px / cell) * 0.37) - 0.5) * streakAmount;
  float field = clamp(wallInk + 0.5 + grain * 0.15, 0.0, 1.0);
  if (material >= 0.0) {
    vec3 n = normalAt(pos, toPipe, origin, length_, groundY);
    float diffuse = max(dot(n, light), 0.0);
    float shade = shadowAt(pos, light, toPipe, origin, length_);
    float lum;
    if (material > 1.5) {
      // Ground: flat, lit, dimmed by the pipe's shadow and by distance.
      lum = (1.0 - seaInk) * (0.35 + 0.65 * shade) ;
    } else {
      vec3 q = toPipe * (pos - origin);
      float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * eyeGlow * 3.0;
      float spec = pow(max(dot(reflect(-light, n), -rd), 0.0), 28.0) * 0.4;
      // Inside the tube it is darker the deeper you look.
      float inside = material < 0.5 && length(q.xy) < R ? 0.85 * smoothstep(0.0, -1.6, q.z) + 0.85 * smoothstep(-length_, -length_ + 1.6, q.z) : 0.0;
      lum = 0.1 + 0.9 * diffuse * (0.3 + 0.7 * shade) + spec + rim;
      lum *= 1.0 - inside;
      if (material > 0.5) lum = 0.3 + 0.7 * diffuse + spec * 2.0;  // packets: brighter, glossier
    }
    lum *= exp(-t * distanceInk * 0.06);
    // Shading noise: the tone wanders across the surface, so nothing shades like a render.
    lum *= 1.0 + (fbm(pos.xz * 1.5 + pos.y * 2.0 + T * 0.3) - 0.5) * streakAmount * 0.8;
    lum += grain * 0.25;
    field = 1.0 - clamp(lum, 0.0, 1.0);
    field = mix(field, 1.0, bandInk * 0.35 * (1.0 - shade));
  }

  // Grain streams past along the pipe's direction: two layers of sparse motes, some stretched to streaks.
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 14.0 : 26.0, speed = layer == 0 ? 1.4 : 2.6;
    vec2 g = uv * scale + vec2(-T * speed, 0.0);
    vec2 id = floor(g), f = fract(g) - 0.5;
    float seed = hash(id + float(layer) * 31.0);
    if (seed > 0.86) {
      vec2 o = (vec2(hash(id + 1.0), hash(id + 2.0)) - 0.5) * 0.6;
      float stretch = 1.0 + step(0.5, hash(id + 3.0)) * 5.0;
      float mote = length((f - o) * vec2(1.0 / stretch, 1.0)) - 0.06;
      float blink = 0.6 + 0.4 * sin(T * 4.0 + seed * 40.0);
      field = mix(field, 0.0, smoothstep(0.02, -0.02, mote) * blink * 0.9);
    }
  }

  float along = fade.z > 0.5 ? 1.0 - px.y / resolution.y : px.x / resolution.x;
  if (fade.y > fade.x) field *= smoothstep(fade.x, fade.y, along);

  float threshold = ign(floor(px / cell));
  float printed = step(threshold, field);
  color = vec4(mix(paper, ink, printed), 1.0);
}
`
