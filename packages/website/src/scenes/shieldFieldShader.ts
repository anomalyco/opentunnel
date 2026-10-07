// The relay's shield: an ellipsoid force field around the card, nearly invisible at rest save for faint drifting
// shifts of light and rare single-cell glints. When stray debris strikes the flanks, the lattice reveals locally
// cell-by-cell, flickers, sends a refractive ripple across the 3D shell, and dissolves back into darkness. When
// the sealed bytes arrive and leave at the poles, an aperture rings open around the wire and reseals behind them.
// `time` is scene time (in step with the dot); `ambient` is wall time. Premultiplied alpha.

export const shieldVertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`

export const shieldFragmentSource = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform vec2 resolution;
uniform vec4 box;          // the relay card in canvas pixels: x, y (from the bottom), width, height
uniform float time, ambient, flare, sustain, head, pixel, sinceEnter, sinceLeave;
uniform vec3 ink;
uniform int pattern;
uniform float padX, height, depth, cell, lineWidth, fresnelPower;
uniform float presence, drift, glints, rim, backFace, spin;
uniform float reveal, linger, dissolve, flicker, lens;
uniform float debrisRate, debrisSpeed, trail, impact, rippleSpeed, strike, plasma, dither;

const float PI = 3.14159265, TAU = 6.2831853, SQRT3 = 1.7320508;
const int DEBRIS = 6;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash1(float n) { return hash(vec2(n, n * 1.618 + 0.37)); }
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

vec2 R;      // the silhouette's radii, in card heights
float H;     // card height in canvas pixels

float shellDistance(vec2 q) {
  vec2 e = q / R;
  float r = length(e);
  return (r - 1.0) * r / max(length(e / R), 1e-4);
}

// ---- Stray debris on the flanks. Stratified phases keep impacts evenly paced with quiet breathing room between hits.
struct Strike {
  vec2 hit;
  vec2 rimPos;
  vec2 normal;
  vec2 incoming;
  vec2 outgoing;
  float since;
  float local;
  float seed;
  bool live;
};

Strike strikes[DEBRIS];

Strike makeDebris(int i) {
  float fi = float(i);
  float approach = 1.25 / max(debrisSpeed, 0.2);
  float period = (3.4 + hash1(fi * 7.1) * 2.8) / max(debrisRate, 0.02) + approach + 1.5;
  float phase = (fi + 0.20 + 0.60 * hash1(fi * 5.3 + 0.7)) / float(DEBRIS);
  float t = ambient + phase * period;
  float cycle = floor(t / period);
  float seed = fi * 19.0 + cycle * 4.3;
  float side = mod(fi + cycle, 2.0) < 1.0 ? 1.0 : -1.0;
  float angle = side * mix(0.20, 0.80, hash1(seed + 1.0)) * PI;
  vec2 rim2 = vec2(cos(angle), sin(angle));
  vec2 normal = normalize(rim2 / R);
  float skew = (hash1(seed + 2.0) - 0.5) * 1.05;
  vec2 incoming = -normalize(normal + vec2(-normal.y, normal.x) * skew);
  vec2 outgoing = normalize(reflect(incoming, normal) + normal * 0.20);
  float local = mod(t, period);
  bool live = debrisRate > 0.001 && hash1(seed + 5.0) < clamp(debrisRate, 0.0, 1.2) * 0.52 + 0.34;
  return Strike(rim2 * R, rim2, normal, incoming, outgoing, local - approach, local, seed, live);
}

// Smooth position along the debris trajectory before and after contact (t = 0 at impact).
vec2 debrisPos(Strike k, float t) {
  if (t < 0.0) {
    float cushion = 0.014 * exp(t * 15.0);
    return k.hit + k.incoming * (debrisSpeed * t) + k.normal * cushion;
  }
  float drag = 2.5;
  float s = (1.0 - exp(-t * drag)) / drag;
  float speed = debrisSpeed * 0.46;
  return k.hit + k.outgoing * (speed * s) - k.normal * (0.032 * s * s);
}

float segDist(vec2 p, vec2 a, vec2 b, out float h) {
  vec2 ba = b - a;
  float l2 = dot(ba, ba);
  h = l2 > 1e-7 ? clamp(dot(p - a, ba) / l2, 0.0, 1.0) : 0.0;
  return length(p - a - ba * h);
}

// ---- Slow counter-drifting waves on the 3D surface: sparse, localized shifts of light (~18% of shell at rest).
float driftField(vec3 p) {
  float t = ambient * drift;
  vec2 u1 = p.xy * vec2(1.70, 1.30) + vec2(p.z * 0.65 - t * 0.25, t * 0.17 + 1.3);
  vec2 u2 = p.xy * vec2(2.30, 1.90) + vec2(-p.z * 0.75 + t * 0.20, -t * 0.21 + 5.1);
  float n1 = fbm(u1);
  float n2 = fbm(u2);
  float pocket = smoothstep(0.53, 0.78, n1) * smoothstep(0.50, 0.76, n2);
  float caustic = exp(-pow((n1 - n2) * 7.0, 2.0)) * smoothstep(0.54, 0.75, 0.5 * (n1 + n2));
  return pocket * 0.78 + caustic * 0.72;
}

// Surface distance from a rim point target on the unit circle to p: avoids the infinite dz/dr cliff at r=1
// so impacts on the silhouette rim immediately reach the hex rows inside the flank and travel smoothly across.
float surfaceDist(vec3 p, vec2 target, out vec2 dir2) {
  vec2 scale = vec2(mix(1.0, R.x / R.y, 0.48), 1.0);
  vec2 diff = (p.xy - target) * scale;
  float d2 = length(diff);
  dir2 = (p.xy - target) / max(d2, 1e-3);
  float zLag = p.z < 0.0 ? 0.18 * (1.0 - p.z) : 0.05 * p.z * p.z;
  return sqrt(d2 * d2 + zLag * zLag);
}

// ---- Surface energy from debris strikes and from the encrypted bytes passing the entry/exit poles.
struct SurfaceEnergy {
  float direct;
  float ripple;
  float aperture;
  vec2 disp;
};

SurfaceEnergy evalSurface(vec3 p) {
  float direct = 0.0, ripple = 0.0, aperture = 1.0;
  vec2 disp = vec2(0.0);
  float maxAge = max(1.3, linger * 2.8);
  float rPatch = max(0.09, reveal * 0.68);
  float wRing = max(0.042, reveal * 0.21);

  for (int i = 0; i < DEBRIS; i++) {
    Strike k = strikes[i];
    if (!k.live || k.since < -0.05 || k.since > maxAge) continue;
    vec2 dir2;
    float d = surfaceDist(p, k.rimPos, dir2);
    // Brief pre-contact ionization just as the incoming particle reaches the outer boundary.
    if (k.since < 0.0) {
      float pre = exp(k.since * 48.0) * exp(-pow(d / (rPatch * 0.65), 1.8));
      direct += pre * 0.85 * impact;
      continue;
    }
    // Central patch flashes and hollows out quickly while the expanding ripple band carries the wave outward.
    float patchEnv = exp(-k.since / max(0.09, linger * 0.38));
    float patchVal = exp(-pow(d / rPatch, 1.8)) * patchEnv;

    float rWave = k.since * rippleSpeed * 0.64;
    float arg1 = (d - rWave) / wRing;
    float ringEnv = exp(-k.since / max(0.20, linger * 1.22)) * smoothstep(2.1, 0.15, rWave);
    float ring1 = exp(-arg1 * arg1) * ringEnv;
    float arg2 = (d - rWave * 0.58) / (wRing * 0.72);
    float ring2 = exp(-arg2 * arg2) * ringEnv * 0.40;

    direct += patchVal * 1.35 * impact;
    ripple += (ring1 + ring2) * 1.30 * impact;
    disp += dir2 * (-arg1 * ring1 * 0.055) * impact;
  }

  // Entry pole (-1, 0): an iris parts around the wire while its hex collar flares and sends a 3D ripple.
  if (flare > 0.002 || sinceEnter < maxAge) {
    vec2 dirE;
    float de = surfaceDist(p, vec2(-1.0, 0.0), dirE);
    float openE = clamp(flare * 1.25, 0.0, 1.0) * (sinceEnter < 0.0 ? 1.0 : exp(-sinceEnter * 5.2));
    float holeE = 0.15 * openE;
    aperture *= smoothstep(holeE * 0.35, holeE * 1.05 + 1e-4, de);
    float collarE = exp(-pow(max(0.0, de - holeE) / max(0.08, reveal * 0.54), 1.7)) * flare;
    direct += collarE * 1.35 * strike;

    if (sinceEnter >= 0.0 && sinceEnter < maxAge) {
      float rWaveE = sinceEnter * rippleSpeed * 0.68;
      float wE = max(0.048, reveal * 0.23);
      float argE = (de - rWaveE) / wE;
      float envE = exp(-sinceEnter / max(0.24, linger * 1.28));
      float ringE = exp(-argE * argE) * envE;
      float argE2 = (de - rWaveE * 0.62) / (wE * 0.75);
      float ringE2 = exp(-argE2 * argE2) * envE * 0.38;
      ripple += (ringE + ringE2) * 1.18 * strike;
      disp += dirE * (-argE * ringE * 0.058) * strike;
    }
  }

  // Exit pole (1, 0): anticipates the emerging dot, opens an exit iris, then reseals with an echo ripple.
  float preExit = head > 0.65 ? pow((head - 0.65) / 0.35, 2.0) * 0.70 : 0.0;
  float postExit = sinceLeave < maxAge ? exp(-sinceLeave * 3.6) : 0.0;
  float exitFlare = max(preExit, postExit);
  if (exitFlare > 0.002 || sinceLeave < maxAge) {
    vec2 dirX;
    float dx = surfaceDist(p, vec2(1.0, 0.0), dirX);
    float openX = max(preExit * 0.9, sinceLeave < maxAge ? exp(-sinceLeave * 6.0) : 0.0);
    float holeX = 0.14 * openX;
    aperture *= smoothstep(holeX * 0.35, holeX * 1.05 + 1e-4, dx);
    float collarX = exp(-pow(max(0.0, dx - holeX) / max(0.08, reveal * 0.50), 1.7)) * exitFlare;
    direct += collarX * 1.15 * strike;

    if (sinceLeave >= 0.0 && sinceLeave < maxAge) {
      float rWaveX = sinceLeave * rippleSpeed * 0.65;
      float wX = max(0.046, reveal * 0.21);
      float argX = (dx - rWaveX) / wX;
      float envX = exp(-sinceLeave / max(0.22, linger * 1.15));
      float ringX = exp(-argX * argX) * envX;
      ripple += ringX * 0.92 * strike;
      disp += dirX * (-argX * ringX * 0.045) * strike;
    }
  }

  return SurfaceEnergy(direct, ripple, aperture, disp);
}

// ---- 3D dome projection: strong radial foreshortening across the curved flanks with exact Newton inverse.
vec2 spinShift(float faceSign) {
  return vec2(faceSign, 0.24 * faceSign) * (ambient * spin * 2.0);
}

mat2 domeTilt(float faceSign) {
  float ang = faceSign * 0.14 + faceSign * ambient * spin * 0.18;
  float c = cos(ang), s = sin(ang);
  return mat2(c, -s, s, c);
}

float domeStretch(vec2 eDom, float kWrap, out float radialDeriv) {
  float r = clamp(length(eDom), 0.0, 0.998);
  vec2 dir = eDom / max(r, 1e-5);
  float z = sqrt(max(1e-3, 1.0 - r * r));
  float u = 1.0 - z;
  float kLocal = kWrap * mix(1.0, 0.65, dir.x * dir.x);
  float dome = 1.0 + kLocal * u * (0.62 + 0.52 * u);
  radialDeriv = dome + kLocal * (0.62 + 1.04 * u) * (r * r / z);
  return dome;
}

vec2 toSurface(vec2 eDom, float faceSign, float kWrap) {
  float deriv;
  float dome = domeStretch(eDom, kWrap, deriv);
  return domeTilt(faceSign) * (eDom * R * dome) + spinShift(faceSign);
}

vec3 fromSurface(vec2 surf, float faceSign, float kWrap) {
  vec2 q0 = (transpose(domeTilt(faceSign)) * (surf - spinShift(faceSign))) / R;
  float r0 = length(q0);
  vec2 dir = q0 / max(r0, 1e-5);
  float kLocal = kWrap * mix(1.0, 0.65, dir.x * dir.x);
  float rMax = 1.0 + kLocal * 1.14;
  if (r0 >= rMax) return vec3(dir, 0.0);
  float r = clamp(r0 / (1.0 + 0.42 * kLocal * r0 * r0), 0.0, 0.996);
  for (int iter = 0; iter < 2; iter++) {
    float z = sqrt(max(1e-3, 1.0 - r * r));
    float u = 1.0 - z;
    float dome = 1.0 + kLocal * u * (0.62 + 0.52 * u);
    float deriv = dome + kLocal * (0.62 + 1.04 * u) * (r * r / z);
    float f = r * dome - r0;
    r = clamp(r - f / max(deriv, 1e-3), 0.0, 0.998);
  }
  vec2 eCell = dir * r;
  return vec3(eCell, faceSign * sqrt(max(0.0, 1.0 - r * r)));
}

// ---- Lattice geometry in surface space: returns edge distance, cell centre, cell ID, and corner proximity.
struct Cell {
  float dist;
  vec2 center;
  vec2 id;
  float vertex;
};

Cell evalCell(vec2 g) {
  if (pattern == 1) {
    vec2 r = vec2(1.0, SQRT3), h = r * 0.5;
    vec2 a = mod(g, r) - h, b = mod(g - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    vec2 center = g - gv;
    vec2 id = floor(center * 2.0 + 0.5);
    float dist = 0.5 - max(dot(abs(gv), vec2(0.5, 0.5 * SQRT3)), abs(gv.x));
    float vertex = smoothstep(0.40, 0.56, length(gv));
    return Cell(dist, center, id, vertex);
  } else if (pattern == 2) {
    vec2 t = vec2(g.x - g.y / SQRT3, g.y * 2.0 / SQRT3);
    vec2 ti = floor(t), tf = fract(t);
    bool lower = tf.x + tf.y < 1.0;
    vec2 tCen = ti + (lower ? vec2(0.3333) : vec2(0.6667));
    vec2 center = vec2(tCen.x + tCen.y * 0.5, tCen.y * 0.5 * SQRT3);
    vec2 id = ti * 2.0 + (lower ? vec2(0.0) : vec2(1.0));
    float dEdge = min(min(tf.x, tf.y), abs(1.0 - tf.x - tf.y)) * 0.866;
    float vertex = smoothstep(0.28, 0.52, length(g - center));
    return Cell(dEdge, center, id, vertex);
  } else {
    vec2 id = floor(g);
    vec2 gv = fract(g) - 0.5;
    vec2 center = id + 0.5;
    float dist = 0.5 - max(abs(gv.x), abs(gv.y));
    float vertex = smoothstep(0.45, 0.68, length(gv));
    return Cell(dist, center, id, vertex);
  }
}

// ---- Analytic ghost of the card border and wires, used inside the shield to render refractive lensing ripples.
float lensedStructure(vec2 qLensed, float a) {
  vec2 dBox = abs(qLensed) - vec2(0.5 * a, 0.5);
  float boxEdge = abs(max(dBox.x, dBox.y)) * H;
  float cardFrame = 1.0 - smoothstep(0.2 * pixel, 1.3 * pixel, boxEdge);
  float wireLine = (1.0 - smoothstep(0.2 * pixel, 1.2 * pixel, abs(qLensed.y) * H)) * step(0.5 * a, abs(qLensed.x));
  return max(cardFrame, wireLine * 0.85);
}

void main() {
  vec2 px = uv * resolution;
  H = box.w;
  float a = box.z / H;
  vec2 q = (px - (box.xy + box.zw * 0.5)) / H;
  R = vec2(0.5 * a + padX * min(1.0, a / 3.5), height);
  float rz = height * depth;
  vec2 e = q / R;
  float r2 = dot(e, e);
  float d = shellDistance(q);
  float dPx = d * H;
  // Back face is occluded by the opaque card rectangle; front face feathers softly across the card border so the interior stays clean.
  float inCardBack = (1.0 - smoothstep(0.5 * a - 0.02, 0.5 * a + 0.01, abs(q.x)))
                   * (1.0 - smoothstep(0.48, 0.51, abs(q.y)));
  float inCardFront = (1.0 - smoothstep(0.5 * a - 0.14, 0.5 * a + 0.03, abs(q.x)))
                    * (1.0 - smoothstep(0.32, 0.54, abs(q.y)));

  for (int i = 0; i < DEBRIS; i++) strikes[i] = makeDebris(i);

  float solid = 0.0, soft = 0.0;
  float kWrap = clamp(0.52 + 0.44 * depth, 0.35, 1.30);

  // ---- The two hemispheres of the ellipsoid shell.
  if (r2 < 1.0) {
    float radialScale;
    float dome = domeStretch(e, kWrap, radialScale);
    // Analytic screen-space filter width in cell units: keeps foreshortened hexes sharp up to the last 2px before the limb.
    float wAA = 0.78 * (0.55 * radialScale + 0.45 * dome) / max(H * cell, 1.0);
    float aaFade = 1.0 - smoothstep(0.22, 0.44, wAA);

    vec2 frontDisp = vec2(0.0);
    vec2 frontNorm = vec2(0.0);

    for (int face = 0; face < 2; face++) {
      float faceSign = face == 0 ? 1.0 : -1.0;
      float weight = face == 0 ? mix(1.0, 0.10, inCardFront) : backFace * 0.48 * (1.0 - inCardBack);
      if (weight <= 0.001) continue;

      // The far hemisphere is seen through the near hemisphere and refracted by its curvature and ripples.
      vec2 eFace = face == 0 ? e : clamp(e - frontNorm * (0.038 * lens) + frontDisp * (1.8 * lens), vec2(-0.99), vec2(0.99));
      float r2Face = min(0.998, dot(eFace, eFace));
      float zFace = faceSign * sqrt(max(0.0, 1.0 - r2Face));
      vec3 p = vec3(eFace, zFace);
      vec3 n = normalize(vec3(eFace.x / R.x, eFace.y / R.y, zFace / rz));
      float fresnel = pow(clamp(1.0 - abs(n.z), 0.0, 1.0), fresnelPower);

      SurfaceEnergy se = evalSurface(p);
      if (face == 0) {
        frontDisp = se.disp;
        frontNorm = n.xy;
      }

      float driftVal = driftField(p);
      float restVeil = presence * driftVal * (0.14 + 0.86 * fresnel);
      float uCard = (q.x + 0.5 * a) / max(a, 1e-3);
      float passTrack = head < -0.5 ? 0.0 : exp(-pow((uCard - head) * 4.2, 2.0)) * sustain * fresnel * 0.10 * strike;

      // Refractive lensing of the underlying card frame & wires + internal caustic when waves deform the shell.
      float waveBend = length(se.disp);
      float refractGhost = 0.0;
      if (face == 0 && lens > 0.001) {
        vec2 turb = vec2(fbm(p.xy * 3.5 + ambient * 0.3) - 0.5, fbm(p.yx * 3.5 - ambient * 0.25 + 3.1) - 0.5);
        vec2 qShift = q + (se.disp * 2.2 + (n.xy * 0.022 + turb * 0.014) * (driftVal * presence + waveBend * 8.0)) * lens;
        float ghost = lensedStructure(qShift, a);
        refractGhost = ghost * clamp(waveBend * 14.0 + driftVal * presence * 0.5 + flare * 0.35, 0.0, 1.0) * lens * 0.52;
      }
      float causticSheen = waveBend * 7.5 * lens * (0.35 + 0.65 * fresnel);

      if (pattern == 0) {
        float cont = (restVeil * 0.65 + (se.direct * 0.65 + se.ripple * 0.8 + causticSheen + passTrack) * (0.35 + 0.65 * fresnel)) * se.aperture;
        solid += refractGhost * se.aperture;
        soft += cont * weight;
      } else {
        vec2 surf = toSurface(eFace, faceSign, kWrap) + se.disp * (1.55 * (0.35 + 0.65 * lens));
        Cell c = evalCell(surf / cell);
        vec3 pCell = fromSurface(c.center * cell, faceSign, kWrap);
        SurfaceEnergy seCell = evalSurface(pCell);
        float driftCell = driftField(pCell);

        float cellHash = hash(c.id + vec2(float(face) * 31.0 + float(pattern) * 7.0, 19.0));
        float cellHash2 = hash(c.id * 1.73 + vec2(53.0, float(face) * 17.0));

        // Per-cell threshold so the revealed patch and ripple wake break apart into discrete hexagons.
        float rawCellE = seCell.direct + seCell.ripple * 1.28;
        float thresh = pow(cellHash, 1.05) * dissolve * 0.68;
        float gateSpan = mix(0.26, 0.045, dissolve);
        float cellGate = smoothstep(thresh, thresh + gateSpan, rawCellE) * min(1.4, rawCellE * 1.5);
        float cellTier = mix(1.0, 0.36 + 0.84 * step(0.32, cellHash2), dissolve * 0.72);

        // Smooth band-limited electrical flicker on active cells, strongest as cells wake or fade near threshold.
        float fWave = 0.5 + 0.5 * sin(ambient * 18.0 + cellHash * TAU * 5.0) * cos(ambient * 11.2 + cellHash2 * TAU * 3.0);
        float edgeBand = exp(-pow((rawCellE - thresh) / 0.16, 2.0));
        float flickMod = mix(1.0, mix(0.14, 1.45, fWave), flicker * (0.35 + 0.65 * edgeBand));
        float activeCell = cellGate * cellTier * flickMod;

        // Rare, pop-free single-cell glints at rest: clustered near the grazing limb and drifting light waves.
        float glintClock = ambient * (0.36 + 0.25 * drift) + cellHash * 29.0;
        float glintCycle = floor(glintClock);
        float glintEnv = pow(0.5 - 0.5 * cos(fract(glintClock) * TAU), 6.0);
        float glintPick = step(0.955 - 0.050 * glints, hash(c.id + vec2(glintCycle * 3.7, float(face) * 11.0)));
        float glintZone = pow(fresnel, 0.55) * smoothstep(0.02, 0.28, driftCell);
        float cellGlint = glints * glintPick * glintEnv * glintZone * 1.65;

        // Cohesive resting drift patch: only cells inside the drifting wave softly surface together.
        float restGate = smoothstep(0.03 + cellHash * 0.14 * dissolve, 0.28, driftCell);
        float restCell = presence * restGate * (0.16 + 0.84 * fresnel) * 0.76;

        // Blend cell-quantized activation with pixel-level wavefront so the side of a cell facing a strike is hotter.
        float pixelWave = (se.direct * 0.68 + se.ripple * 0.85) * flickMod;
        float cellEnergy = mix(activeCell, pixelWave, 0.20) * (0.50 + 0.50 * fresnel) + restCell + cellGlint + passTrack;

        // Anti-aliased cell wireframe + hot corner vertices + concave inner-wall membrane bevel.
        float line = (1.0 - smoothstep(max(0.0, lineWidth - wAA * 0.45), lineWidth + wAA * 0.85, c.dist)) * aaFade;
        float cornerBoost = 1.0 + 0.60 * c.vertex * min(1.0, activeCell + cellGlint * 1.5);
        float bevel = exp(-max(0.0, c.dist - lineWidth) * 12.5) * smoothstep(0.0, lineWidth + wAA, c.dist) * aaFade;
        float membrane = smoothstep(0.0, 0.22, c.dist) * 0.12;
        float limbCarry = (1.0 - aaFade) * min(1.0, cellEnergy) * 0.26;

        float lineAlpha = min(1.0, cellEnergy * cornerBoost + causticSheen * 0.40);
        float facetAlpha = bevel * (0.58 * activeCell + 0.42 * cellGlint + 0.22 * restCell) + membrane * activeCell * 0.42;

        solid += (line * lineAlpha + bevel * (0.38 * activeCell + 0.28 * cellGlint + 0.12 * restCell) + limbCarry + refractGhost) * se.aperture * weight;
        soft += (facetAlpha * 0.48 + (se.direct * 0.04 + se.ripple * 0.06 + causticSheen * 0.24) * (0.3 + 0.7 * fresnel)) * se.aperture * weight;
      }
    }
  }

  // ---- The silhouette limb: invisible at rest except where a drifting wave, ripple, or strike brushes the edge.
  vec3 pRim = vec3(normalize(e + 1e-5), 0.0);
  SurfaceEnergy seRim = evalSurface(pRim);
  float driftRim = driftField(pRim);
  float rimShift = sin(atan(e.y, e.x) * 20.0 - time * 10.0) * (seRim.ripple + seRim.direct) * 0.75 * lens * pixel;
  float dRimPx = dPx + rimShift;
  float rimActivity = rim * (presence * driftRim * 0.82 + sustain * 0.04 * strike) + (seRim.direct * 0.85 + seRim.ripple * 0.72) * (0.42 + 0.58 * rim);
  float rimLine = (1.0 - smoothstep(0.35 * pixel, 1.35 * pixel, abs(dRimPx))) * min(1.0, rimActivity) * seRim.aperture;
  float rimHalo = exp(-max(dRimPx, 0.0) / (4.2 * pixel)) * step(-1.0 * pixel, dRimPx) * (presence * driftRim * rim * 0.07 + (seRim.direct + seRim.ripple) * 0.14) * seRim.aperture;
  solid += rimLine;
  soft += rimHalo;

  // ---- Stray debris: continuous curved trajectory across the bounce, anti-aliased tapered streak & micro-sparks.
  for (int i = 0; i < DEBRIS; i++) {
    Strike k = strikes[i];
    if (!k.live || k.since > 1.35) continue;
    float tHead = k.since;
    float tTail = k.since - trail;
    vec2 pHead = debrisPos(k, tHead);
    if (length(q - k.hit) > 1.2 && length(q - pHead) > 0.6) continue;

    float hSeg = 0.0, dSeg = 1e5;
    if (tHead <= 0.0 || tTail >= 0.0) {
      vec2 pTail = debrisPos(k, tTail);
      dSeg = segDist(q, pHead, pTail, hSeg);
    } else {
      vec2 pTail = debrisPos(k, tTail);
      float fracOut = tHead / max(trail, 1e-4);
      float h1 = 0.0, h2 = 0.0;
      float d1 = segDist(q, pHead, k.hit, h1);
      float d2 = segDist(q, k.hit, pTail, h2);
      if (d1 < d2) { dSeg = d1; hSeg = h1 * fracOut; }
      else { dSeg = d2; hSeg = fracOut + h2 * (1.0 - fracOut); }
    }

    float distPx = dSeg * H;
    float envIn = smoothstep(0.0, 0.45, k.local) * 0.56;
    float envHit = exp(-max(0.0, k.since) * 3.4) * (0.56 + 0.44 * exp(-abs(k.since) * 14.0));
    float bright = k.since < 0.0 ? envIn : envHit;
    float width = mix(0.88, 0.20, hSeg) * pixel;
    float core = 1.0 - smoothstep(max(0.0, width - 0.55 * pixel), width + 0.55 * pixel, distPx);
    float glow = exp(-distPx * distPx / (pixel * pixel * 8.0)) * 0.15;
    float taper = pow(1.0 - hSeg, 1.6);
    solid += (core * taper + glow * (1.0 - hSeg)) * bright;

    // Contact: a tight tangential lens flash on the rim and 3 deterministic anti-aliased micro-sparks.
    if (k.since >= -0.015 && k.since < 0.50) {
      float st = max(0.0, k.since);
      vec2 tang = vec2(-k.normal.y, k.normal.x);
      vec2 relHit = (q - k.hit) * H / pixel;
      float uTang = dot(relHit, tang);
      float uNorm = dot(relHit, k.normal);
      float flash = exp(-(uTang * uTang / 30.0 + uNorm * uNorm / 6.5)) * exp(-st * 11.0);
      solid += flash * 0.95 * impact;

      for (int s = 0; s < 3; s++) {
        float fs = float(s);
        float fan = (hash1(k.seed + 11.0 + fs * 3.1) - 0.5) * 1.75;
        vec2 sDir = normalize(k.normal + tang * fan);
        float sSpeed = (0.30 + 0.26 * hash1(k.seed + 17.0 + fs * 5.3)) * debrisSpeed;
        float sDrag = (1.0 - exp(-st * 5.2)) / 5.2;
        vec2 sPos = k.hit + sDir * (sSpeed * sDrag);
        vec2 sPrev = k.hit + sDir * (sSpeed * max(0.0, sDrag - 0.024));
        float sh = 0.0;
        float sd = segDist(q, sPos, sPrev, sh) * H;
        float sparkCore = (1.0 - smoothstep(0.2 * pixel, 1.15 * pixel, sd)) * exp(-st * 6.8);
        solid += sparkCore * 0.62 * impact;
      }
    }
  }

  // ---- Optional plasma bow shock at the strike: hot at the shoulders, streaming back in wisps.
  if (plasma > 0.001 && (flare > 0.002 || sustain > 0.002)) {
    float angle = atan(e.y, e.x);
    float s = 1.0 - abs(angle) / PI;
    float wobble = (fbm(vec2(s * 9.0 - time * 2.5, time * 0.7 + sign(e.y) * 5.0)) - 0.5) * (0.06 + 0.04 * flare);
    float dd = d + wobble;
    float gate = smoothstep(0.45, 0.75, abs(q.y)) * (1.0 - smoothstep(0.55, 0.85, s));
    float u = (q.x + 0.5 * a) / a;
    float shoulder = exp(-max(0.0, s - 0.08) * 6.0);
    float band = head < -0.5 ? 0.0 : (u < head ? exp(-(head - u) * 3.2) : exp(-(u - head) * 14.0));
    float heat = (flare * (0.35 + 0.85 * shoulder) + sustain * (0.12 * shoulder + 0.30 * band)) * plasma;
    float front = exp(-dd * dd * 1100.0 * (1.0 + s * 2.5));
    vec2 flow = vec2(s * 7.0 - time * (3.0 + 4.0 * flare), dd * 9.0 + sign(e.y) * 3.0);
    float filaments = pow(ridge(flow * vec2(1.0, 2.2)), 6.0);
    float layer = dd < 0.0 ? exp(dd * 8.0) : exp(-dd * 16.0);
    solid += front * heat * gate * 0.75;
    soft += layer * (0.04 + 1.15 * filaments) * heat * gate;
  }

  // Print: fine 1px Bayer halftone grain on diffuse atmospheric glow; wireframe lines and speculars stay crisp.
  float I = clamp(soft, 0.0, 1.0);
  float bVal = bayer(px / pixel);
  float grained = smoothstep(bVal * 0.78, bVal * 0.78 + 0.22, I) * min(1.0, 0.22 + I * 0.85);
  float printed = mix(I, grained, dither);
  float edges = smoothstep(0.0, 0.06, min(uv.x, 1.0 - uv.x)) * smoothstep(0.0, 0.06, min(uv.y, 1.0 - uv.y));
  float alpha = clamp(solid + printed * (1.0 - clamp(solid, 0.0, 1.0)), 0.0, 1.0) * edges;
  color = vec4(ink * alpha, alpha);
}
`
