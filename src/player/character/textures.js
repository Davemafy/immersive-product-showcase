/**
 * Procedural texture forge for the player character.
 *
 * Nothing is loaded from disk. Every map is rasterised into a canvas at load
 * time from deterministic value noise (`hash2`) — no Math.random, so a capture
 * is reproducible.
 *
 * Each surface produces a triple: albedo (sRGB), a tangent-space normal derived
 * from a height field by Sobel, and a linear roughness map. That is the minimum
 * the quality bar asks for: "albedo variation, a normal map, roughness
 * variation, and a detail layer visible at 0.5 m".
 *
 * Sizes are small on purpose — a 256 px weave tiled four times across a sleeve
 * has a higher texel density than a 1k map stretched over the whole body.
 *
 * ONE EXCEPTION, and it is the important one: the FACE. A face is not a
 * repeating pattern, so its map cannot tile; `makeFaceAtlas` paints a single
 * 512 px atlas in the skull's own (phi, theta) with the lips, sockets, brows,
 * beard and creases at the coordinates the geometry put them. See the texel
 * budget in `buildTextures` for what that costs and what pays for it.
 */

import * as THREE from 'three';

/* ---------------------------------------------------------------- noise */

function hash2(x, y, seed) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/** Tiling value noise: wraps every `period` so the texture repeats seamlessly. */
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => ((a % b) + b) % b;
  const x0 = w(xi, period), x1 = w(xi + 1, period);
  const y0 = w(yi, period), y1 = w(yi + 1, period);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x, y, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, period * f, seed + o * 977) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/* -------------------------------------------------------------- helpers */

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function texFromCanvas(c, srgb, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a height field into a tangent-space normal map.
 * `strength` scales the gradient; 1 is a gentle relief, 6 is coarse fabric.
 */
function normalFromHeight(height, size, strength, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const gy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, aniso);
}

function grayTexture(values, size, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, values[i] * 255)) | 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, aniso);
}

function rgbTexture(rgb, size, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = Math.max(0, Math.min(255, rgb[i * 3] * 255)) | 0;
    d[i * 4 + 1] = Math.max(0, Math.min(255, rgb[i * 3 + 1] * 255)) | 0;
    d[i * 4 + 2] = Math.max(0, Math.min(255, rgb[i * 3 + 2] * 255)) | 0;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, true, aniso);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Unpack a hex colour into linear-light RGB so blends are physical. */
function unpack(hex, out) {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

const _c0 = [0, 0, 0];
const _c1 = [0, 0, 0];

/* ------------------------------------------------------------- surfaces */

/**
 * Skin. Mottled dermal colour with a red low-frequency layer (blood under the
 * surface), fine pores in the normal, and a roughness that goes shinier on the
 * high points — that specular break-up is what stops CG skin reading as vinyl.
 */
function makeSkin(base, shadow, seed, size, aniso, stubble) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  unpack(shadow, _c1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * 8, v = (y / size) * 8;
      // three scales of mottling
      const blotch = fbm(u * 0.9, v * 0.9, 8, seed, 3);
      const capillary = fbm(u * 3.5, v * 3.5, 28, seed + 31, 3);
      const pore = vnoise(u * 26, v * 26, 208, seed + 77);
      const fine = hash2(x * 3, y * 7, seed + 5);

      // Blend toward the shadow tone in the blotchy lows; push red in the highs.
      const t = 0.14 + blotch * 0.2 + capillary * 0.12;
      const red = (capillary - 0.5) * 0.055;
      let r = _c0[0] * (1 - t) + _c1[0] * t + red;
      let g = _c0[1] * (1 - t) + _c1[1] * t - red * 0.35;
      let b = _c0[2] * (1 - t) + _c1[2] * t - red * 0.3;
      // pore speckle darkens fractionally
      const sp = (pore - 0.5) * 0.014 + (fine - 0.5) * 0.006;
      r += sp; g += sp * 0.95; b += sp * 0.9;

      // stubble: dark high-frequency dots, only where the caller asks for it
      if (stubble > 0) {
        const st = hash2(x * 11 + 3, y * 13 + 7, seed + 191);
        if (st > 1 - stubble * 0.30) {
          const k = 1 - stubble * 0.22;
          r *= k; g *= k * 1.01; b *= k * 1.04;
        }
      }

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));

      height[i] = pore * 0.28 + fine * 0.06 + capillary * 0.66;
      // Shinier where the skin bulges, drier in the creases.
      rough[i] = 0.62 - (pore - 0.5) * 0.16 - (blotch - 0.5) * 0.1;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 0.5, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/* --------------------------------------------------------- face atlas --- */

/**
 * THE HEAD'S UV IS UNIQUE, NOT TILED — see the note on `B.ellipsoid` in
 * `mesh.js`. The skull is swept as u = phi / 2pi, v = theta / pi, so:
 *
 *   u = 0.50   dead ahead      u = 0.25  the character's RIGHT ear
 *   u = 0.75   his LEFT ear    u = 0/1   the back of the head (the seam)
 *   v = 0      crown           v = 1     under the chin
 *
 * `FACE_LANDMARKS` converts the head-local metres `buildHead()` authors its
 * gaussians in into that space, using the SAME undeformed ellipsoid radii
 * (143 x 216 x 187 mm). Gate 6 of `headprobe.mjs` checks these against the uv
 * the emitted geometry actually carries at each anatomical point, with a
 * shifted-atlas negative control — because a face atlas that is 4% out is a
 * mouth painted on a chin, and nothing else in the pipeline would notice.
 */
const HEAD_R = [0.0715, 0.108, 0.0935];

export function faceUV(x, y) {
  const dy = Math.max(-1, Math.min(1, y / HEAD_R[1]));
  const theta = Math.acos(dy);
  const st = Math.max(1e-6, Math.sin(theta));
  const sp = Math.max(-1, Math.min(1, (x / HEAD_R[0]) / st));
  // The face is the phi in (pi/2, 3pi/2) branch: dz < 0.
  const phi = Math.PI - Math.asin(sp);
  return [phi / (Math.PI * 2), theta / Math.PI];
}

/** Anatomical points, head-local metres, straight out of `buildHead()`. */
export const FACE_POINTS = {
  eyeR: [0.0305, 0.008],
  eyeL: [-0.0305, 0.008],
  browR: [0.028, 0.031],
  browL: [-0.028, 0.031],
  noseTip: [0, -0.026],
  nostrilR: [0.0165, -0.0325],
  mouth: [0, -0.061],
  chin: [0, -0.084],
  cheekR: [0.040, -0.010],
};

export const FACE_LANDMARKS = Object.fromEntries(
  Object.entries(FACE_POINTS).map(([k, p]) => [k, faceUV(p[0], p[1])])
);

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

/** Elliptical falloff: 1 at the centre, 0 outside the (ru, rv) ellipse. */
function blob(du, dv, ru, rv) {
  const d = Math.hypot(du / ru, dv / rv);
  return d >= 1 ? 0 : Math.cos(d * Math.PI * 0.5) ** 2;
}

/**
 * The face. One non-tiling atlas per brother carrying everything the geometry
 * cannot say: where the beard stops, what colour the lips are, how dark the
 * sockets sit, and how many years are written on the forehead.
 *
 * `age` (0 young .. 1 weathered) and `beard` (0 clean .. 1 full) come from
 * `IDENTITY`; they are the difference between the eldest and the youngest at
 * the range the third-person camera actually sits at, where 3 mm of geometry
 * is one pixel but a beard line is thirty.
 *
 * Albedo is baked at `size`; the relief and roughness at half that. Creases
 * and pores are broad next to a lip line, and the normal is the cheaper of the
 * three to under-sample.
 */
function makeFaceAtlas(palette, seed, size, aniso, opts) {
  const age = opts.age ?? 0.4;
  const beard = opts.beard ?? 0.4;
  const mouthW = opts.mouthW ?? 1;
  /** The identity's own nasolabial depth. A young face has none. */
  const foldK = opts.fold ?? 0.5;
  unpack(palette.skin, _c0);
  unpack(palette.skinShadow, _c1);
  const hair = [0, 0, 0];
  unpack(palette.hair, hair);

  const L = FACE_LANDMARKS;
  const out = [0, 0, 0, 0, 0]; // r, g, b, height, roughness

  /**
   * `du` is SIGNED about the centre line and wraps at the back seam, so an
   * asymmetric feature can be authored once and a symmetric one folded.
   */
  const evalPx = (u, v) => {
    let du = u - 0.5;
    if (du > 0.5) du -= 1;
    if (du < -0.5) du += 1;
    const au = Math.abs(du);
    // How much of the face we are on at all: 1 across the mask, 0 round the
    // back where the atlas is plain scalp the ears also sample.
    const facing = smoothstep(0.31, 0.24, au);

    /* ---- base dermis ---- */
    const blotch = fbm(u * 7, v * 7, 7, seed, 3);
    const capillary = fbm(u * 20, v * 20, 20, seed + 31, 3);
    const pore = vnoise(u * 150, v * 150, 150, seed + 77);
    const fine = fbm(u * 300, v * 300, 300, seed + 5, 2);

    const t0 = 0.12 + blotch * 0.20 + capillary * 0.10;
    const red = (capillary - 0.5) * 0.05;
    let r = _c0[0] * (1 - t0) + _c1[0] * t0 + red;
    let g = _c0[1] * (1 - t0) + _c1[1] * t0 - red * 0.35;
    let b = _c0[2] * (1 - t0) + _c1[2] * t0 - red * 0.30;
    // RELIEF IS TINY HERE ON PURPOSE. The atlas covers a whole skull at 256
    // px of normal map, so one texel is a millimetre: pore and blotch noise at
    // the amplitude a TILED skin map uses comes out as a cauliflower. Measured
    // by looking at it — the first bake ran pore 0.30 / capillary 0.58 through
    // a 0.65 Sobel at normalScale 0.8 and all three brothers had craters. The
    // relief budget belongs to the creases, the lips and the beard, which are
    // added below at ten times these numbers.
    let h = pore * 0.05 + fine * 0.03 + capillary * 0.06;
    let rough = 0.60 - (pore - 0.5) * 0.16 - (blotch - 0.5) * 0.10;

    /* ---- form shadow ----
     * The face's own occlusion, baked: the sides of the skull, under the brow
     * and under the jaw all sit in their own shadow, and a lambert term over a
     * smooth ellipsoid does not put it there. Without this the head renders as
     * a pale balloon with features drawn on it, which is half of what "flat"
     * meant in the review. */
    {
      const sides = smoothstep(0.115, 0.235, au);
      const underBrow = smoothstep(0.418, 0.462, v) * smoothstep(0.520, 0.478, v);
      const underJaw = smoothstep(0.800, 0.900, v);
      const k = facing * (sides * 0.16 + underBrow * 0.10) + underJaw * 0.14;
      r *= 1 - k; g *= 1 - k * 1.04; b *= 1 - k * 1.06;
    }

    /* ---- weathering: sun sits on the nose, the cheekbones and the ears ---- */
    const sun = facing * (blob(du, v - 0.545, 0.075, 0.075) * 0.8
      + blob(Math.abs(du) - 0.056, v - 0.50, 0.045, 0.045) * 0.7);
    const burn = sun * (0.22 + age * 0.55);
    r += burn * 0.055; g -= burn * 0.012; b -= burn * 0.022;
    rough += burn * 0.06;

    /* ---- eye sockets ---- */
    for (const k of ['eyeR', 'eyeL']) {
      const e = L[k];
      let ed = u - e[0];
      if (ed > 0.5) ed -= 1;
      if (ed < -0.5) ed += 1;
      const socket = blob(ed, v - e[1], 0.062, 0.052);
      const sh = socket * (0.13 + age * 0.13);
      r *= 1 - sh; g *= 1 - sh * 1.05; b *= 1 - sh * 0.95;
      h -= socket * 0.16;
      // Lash line: a thin dark arc riding the top of the aperture.
      const lash = blob(ed, v - (e[1] - 0.011), 0.030, 0.0055);
      const lk = lash * 0.55;
      r *= 1 - lk; g *= 1 - lk; b *= 1 - lk * 0.9;
      // Lower lid, and the bag under it that only the eldest has.
      const bag = blob(ed, v - (e[1] + 0.019), 0.034, 0.0085) * age;
      r *= 1 - bag * 0.10; g *= 1 - bag * 0.11; b *= 1 - bag * 0.10;
      h += bag * 0.10;
      // Crow's feet: three creases fanning off the outer corner.
      const outer = ed * (e[0] < 0.5 ? 1 : -1); // toward the ear
      if (age > 0.15 && outer < -0.022) {
        const fan = Math.abs(outer) - 0.022;
        const line = Math.abs(Math.sin((v - e[1]) * 190 + fan * 40));
        const crow = Math.max(0, 1 - fan / 0.030) * (1 - line) * age * 0.45
          * smoothstep(0.055, 0.030, Math.abs(v - e[1]));
        r *= 1 - crow * 0.10; g *= 1 - crow * 0.10; b *= 1 - crow * 0.09;
        h -= crow * 0.22;
      }
    }

    /* ---- eyebrows, painted under the geometry brow so the ridge reads dark
     * even where the tube is only 5 mm across ---- */
    {
      // The arch, sampled off the three control points the geometry brow tube
      // is swept through: au 0.023 -> v 0.4226, au 0.070 -> 0.4042 (the peak),
      // au 0.118 -> 0.4286. Paint it anywhere else and the tube casts a shadow
      // onto bare forehead.
      // +0.009 of v: the brow-ridge gaussian pushes the surface UP, so the
      // vertex that ends up at the tube's own height carries a v that much
      // larger than `faceUV` of the anatomical point. MEASURED as gate 6's
      // brow residual (carson 0.0096, aidan 0.0088, dylan 0.0080) before this
      // term existed; it is the difference between paint under the tube and
      // paint on the eyelid above it.
      const RIDGE = 0.009;
      const arc = RIDGE + (au < 0.070
        ? 0.4226 - 0.0184 * smoothstep(0.023, 0.070, au)
        : 0.4042 + 0.0244 * smoothstep(0.070, 0.118, au));
      const band = Math.max(0, 1 - Math.abs(v - arc) / (0.0130 + 0.006 * age));
      const brow = band * smoothstep(0.014, 0.026, au)
        * smoothstep(0.132, 0.108, au) * (0.72 + 0.28 * fbm(u * 90, v * 90, 90, seed + 9, 2));
      r += (hair[0] * 0.55 - r) * brow;
      g += (hair[1] * 0.55 - g) * brow;
      b += (hair[2] * 0.55 - b) * brow;
      h += brow * 0.30;
      rough += brow * 0.12;
    }

    /* ---- lips ---- */
    {
      const m = L.mouth;
      const w = 0.062 * mouthW;
      const bow = 0.0030 * Math.cos(Math.min(1, Math.abs(du) / w) * Math.PI);
      const lip = blob(du, v - (m[1] + bow), w * 1.06, 0.0265);
      if (lip > 0) {
        // Vermilion: darker, redder and much smoother than the skin round it.
        r += (0.138 - r) * lip;
        g += (0.034 - g) * lip;
        b += (0.036 - b) * lip;
        rough -= lip * 0.26;
        // Vertical lip creases.
        h += lip * 0.42 + lip * 0.16 * Math.sin(du * 620);
      }
      // The seam between the lips is the darkest line on the face.
      const seam = blob(du, v - (m[1] + bow), w * 0.96, 0.0042);
      r *= 1 - seam * 0.70; g *= 1 - seam * 0.74; b *= 1 - seam * 0.74;
      h -= seam * 0.85;
      // Philtrum.
      const phil = blob(du, v - (m[1] - 0.030), 0.010, 0.014);
      h -= phil * 0.14;
    }

    /* ---- nasolabial folds ----
     * SHORT AND FAINT, and gated on the identity's own `fold`. The first
     * version ran the full 0.556 -> 0.706 of v at (0.25 + age * 0.55) on every
     * brother regardless of what his face said, and the two arcs it drew
     * between the nostrils and the mouth read from the front as a permanent
     * grin — on the YOUNGEST brother as much as on the eldest, because the
     * gate was `age` and nothing else. */
    {
      const y0 = 0.596, y1 = 0.700;
      const tt = smoothstep(y0, y1, v);
      const cu = 0.040 + tt * 0.018;
      const arc = Math.max(0, 1 - Math.abs(au - cu) / 0.008)
        * smoothstep(y0, y0 + 0.03, v) * smoothstep(y1 + 0.01, y1 - 0.04, v);
      const k = arc * (0.10 + age * 0.30) * foldK * facing;
      r *= 1 - k * 0.10; g *= 1 - k * 0.11; b *= 1 - k * 0.10;
      h -= k * 0.30;
    }

    /* ---- forehead: horizontal creases, and only on a face old enough ---- */
    if (age > 0.2) {
      let line = 0;
      for (let i = 0; i < 3; i++) {
        const yc = 0.352 + i * 0.024;
        const wob = 0.0022 * Math.sin(du * 46 + i * 2.1);
        line += Math.max(0, 1 - Math.abs(v - (yc + wob)) / 0.0055)
          * smoothstep(0.16, 0.10, au) * (i === 0 ? 1 : Math.max(0, age - 0.35) / 0.65);
      }
      const k = Math.min(1, line) * age * 0.8;
      r *= 1 - k * 0.09; g *= 1 - k * 0.10; b *= 1 - k * 0.09;
      h -= k * 0.50;
      // The vertical glabellar pair between the brows.
      const gl = Math.max(0, 1 - Math.abs(au - 0.009) / 0.004)
        * smoothstep(0.400, 0.414, v) * smoothstep(0.446, 0.430, v);
      h -= gl * age * 0.26;
    }

    /* ---- beard ---- */
    {
      // THE JAW LINE IS A DIAGONAL. The boundary starts just under the lower
      // lip at the centre (v 0.72; the lip's own lower edge is 0.714) and
      // climbs to the sideburn in front of the ear (v 0.48, about ear height).
      // A boundary that is flat in v instead — the first version held 0.612 at
      // the centre and 0.442 at the side — paints the entire lower two thirds
      // of the face, which bakes as a dark rectangle with two vertical edges
      // down the cheeks rather than as a beard.
      // The outer limit is 0.545 rather than 0.480 because 0.480 is ABOVE the
      // top of the ear (v 0.50) and a sideburn stops at it. Changing it moved
      // nothing visible on the model, which is worth recording: the speckled
      // patch on carson's temple in the 3/4 renders is NOT this mask — it is
      // the hair shell at its own thin edge, and it predates the atlas.
      const top = 0.720 - 0.175 * smoothstep(0.020, 0.170, au);
      // The lower boundary is UNDER THE JAW, not on the chin. At 0.845 the
      // centre column had a 0.02-wide band of beard between the lip line and
      // the cut, i.e. a bearded jaw with a bare chin in the middle of it.
      const bot = 0.930 + 0.030 * smoothstep(0.10, 0.20, au);
      // A 0.14 RAMP, not 0.05. The boundary runs diagonally from below the lip
      // up to the sideburn, so a hard edge on it draws a curve from the mouth
      // corner out to the cheekbone on both sides — and that is a smile. The
      // geometric version of the same defect (a full-width concave valley at
      // y = -0.046, fixed by the maxilla mass in mesh.js) was found first, and
      // the moment the beard was strengthened afterwards the smile came back
      // from the OTHER source. Stubble has no edge; it thins out.
      let mask = smoothstep(top, top + 0.140, v) * smoothstep(bot, bot - 0.090, v) * facing;
      // Moustache: a separate patch above the lip, or the beard would stop at
      // the nose and the philtrum would be bare.
      mask = Math.max(mask, blob(du, v - 0.652, 0.050, 0.020));
      // No hair on the vermilion.
      mask *= 1 - blob(du, v - L.mouth[1], 0.060 * mouthW, 0.021);
      const patchy = 0.62 + 0.38 * fbm(u * 34, v * 34, 34, seed + 41, 3);
      const dens = Math.max(0, Math.min(1, mask * beard * 1.15 * patchy));
      if (dens > 0.002) {
        // Stubble is a small value shift toward the hair colour plus a clumped
        // speckle. The noise period matters as much as the amplitude: at
        // u * 620 on a 512 px bake the cells are sub-texel, which is white
        // noise and bakes as grime. 220 gives a cell every two texels, which
        // mips down to a tone instead of to sparkle.
        const dot = vnoise(u * 220, v * 220, 220, seed + 191);
        const k = dens * (0.20 + 0.32 * Math.max(0, dot - 0.45));
        r += (hair[0] * 0.62 - r) * k;
        g += (hair[1] * 0.62 - g) * k;
        b += (hair[2] * 0.62 - b) * k;
        h += dens * (dot - 0.5) * 0.30;
        rough += dens * 0.16;
      }
    }

    /* ---- T-zone: the forehead and the nose are the shiny parts of a face --- */
    const tzone = facing * Math.max(
      blob(du, v - 0.36, 0.13, 0.075),
      blob(du, v - 0.535, 0.030, 0.085)
    );
    rough -= tzone * 0.16;

    out[0] = r; out[1] = g; out[2] = b;
    out[3] = h;
    out[4] = Math.max(0.06, Math.min(1, rough));
    return out;
  };

  const rgb = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = evalPx((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 3;
      rgb[i] = linearToSrgb(Math.max(0, o[0]));
      rgb[i + 1] = linearToSrgb(Math.max(0, o[1]));
      rgb[i + 2] = linearToSrgb(Math.max(0, o[2]));
    }
  }
  const half = size >> 1;
  const height = new Float32Array(half * half);
  const rough = new Float32Array(half * half);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const o = evalPx((x + 0.5) / half, (y + 0.5) / half);
      height[y * half + x] = o[3];
      rough[y * half + x] = o[4];
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    // The atlas is not tiled, so the Sobel must not wrap across v (crown to
    // chin) — but `normalFromHeight` wraps both axes. The seam it produces
    // runs across the very top of the skull, under hair, on every brother.
    normalMap: normalFromHeight(height, half, 1.1, aniso),
    roughnessMap: grayTexture(rough, half, aniso),
  };
}

/**
 * Woven cloth. A real weave: two interleaved thread families whose crossings
 * alternate, plus slubs (thick threads), plus a grime gradient so it never
 * reads as a flat colour field.
 *
 * THREE CLOTHS, because three men in the same weave at three hues is what made
 * the brothers read as recolours. The `kind` changes the thread count, the
 * structure and the dirt, which is what the eye actually separates:
 *
 *   canvas    carson — coarse cotton duck, 22 threads, heavy slubs, salt
 *             bloom off the river and a lot of ground-in grime.
 *   chambray  aidan  — a fine shirting at 40 threads with a pale weft against
 *             a dyed warp, plus oil smudges off a body shop.
 *   ripstop   dylan  — 62 threads with the reinforcing GRID every eighth
 *             thread standing proud, barely soiled, and a sheen: the only one
 *             of the three whose roughness ever drops below 0.7.
 */
function makeCloth(base, dark, seed, size, aniso, kind = 'chambray') {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  unpack(dark, _c1);

  const K = {
    canvas: { threads: 22, slub: 0.42, grime: 0.34, sheen: 0.0, weft: 0.0, rip: 0, relief: 3.4, rough: 0.90 },
    chambray: { threads: 40, slub: 0.25, grime: 0.24, sheen: 0.04, weft: 0.13, rip: 0, relief: 2.6, rough: 0.86 },
    ripstop: { threads: 62, slub: 0.12, grime: 0.10, sheen: 0.22, weft: 0.0, rip: 8, relief: 2.2, rough: 0.66 },
  }[kind] ?? { threads: 40, slub: 0.25, grime: 0.24, sheen: 0.04, weft: 0.13, rip: 0, relief: 2.6, rough: 0.86 };
  const THREADS = K.threads;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tx = (x / size) * THREADS;
      const ty = (y / size) * THREADS;
      const cellX = Math.floor(tx), cellY = Math.floor(ty);
      const fx = tx - cellX, fy = ty - cellY;
      // plain weave: warp on top when (cellX+cellY) is even
      const warpTop = ((cellX + cellY) & 1) === 0;
      const warp = Math.sin(fx * Math.PI);
      const weft = Math.sin(fy * Math.PI);
      let h = warpTop ? warp * 0.85 + weft * 0.3 : weft * 0.85 + warp * 0.3;

      // Ripstop: every Nth thread in each direction is doubled, so the fabric
      // carries a visible square grid that no other cloth here has.
      let ripLine = 0;
      if (K.rip) {
        const gx = cellX % K.rip === 0 ? Math.sin(fx * Math.PI) : 0;
        const gy = cellY % K.rip === 0 ? Math.sin(fy * Math.PI) : 0;
        ripLine = Math.max(gx, gy);
        h = h * (1 - 0.35 * ripLine) + ripLine * 1.25;
      }

      const slub = vnoise((x / size) * 9, (y / size) * 60, 60, seed + 13);
      const grime = fbm((x / size) * 3, (y / size) * 3, 6, seed + 61, 4);
      const dust = fbm((x / size) * 14, (y / size) * 14, 28, seed + 101, 3);

      // Fabric absorbs less light in the crossings than in the valleys. Kept
      // SHALLOW on purpose: a high-contrast weave in the albedo turns into a
      // moire screen door once it is minified, and the relief belongs in the
      // normal map where mipping resolves it correctly.
      const shade = 0.90 + h * 0.10;
      const t = 0.06 + grime * K.grime + (1 - shade) * 0.8;
      let r = (_c0[0] * (1 - t) + _c1[0] * t) * shade;
      let g = (_c0[1] * (1 - t) + _c1[1] * t) * shade;
      let b = (_c0[2] * (1 - t) + _c1[2] * t) * shade;
      // Chambray: the weft is undyed, so every second crossing is paler. It is
      // the whole reason chambray does not read as a flat dyed field.
      if (K.weft && !warpTop) {
        r += (0.58 - r) * K.weft; g += (0.58 - g) * K.weft; b += (0.60 - b) * K.weft;
      }
      // dusty bloom lifts and desaturates
      const dl = (dust - 0.45) * 0.06 * (K.grime / 0.24);
      const lum = (r + g + b) / 3;
      r += (lum - r) * 0.25 * dust + dl;
      g += (lum - g) * 0.25 * dust + dl;
      b += (lum - b) * 0.25 * dust + dl;
      if (ripLine > 0) { const k = 1 + ripLine * 0.05; r *= k; g *= k; b *= k; }

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));

      height[i] = h * (1 - K.slub) + slub * K.slub;
      rough[i] = K.rough - h * 0.09 + (dust - 0.5) * 0.08 - K.sheen * Math.max(0, h);
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, K.relief, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/**
 * Denim: 2/1 twill, so the diagonal rib is the read, plus abrasion whitening.
 * `wear` scales the abrasion — a river hand's trousers are not a courier's.
 */
function makeDenim(base, seed, size, aniso, wear = 1) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  const THREADS = 46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tx = (x / size) * THREADS;
      const ty = (y / size) * THREADS;
      const cx = Math.floor(tx), cy = Math.floor(ty);
      // 2/1 twill: warp floats over two, under one, shifting one per row
      const phase = (cx - cy * 1 + 300) % 3;
      const warpTop = phase < 2;
      const fx = tx - cx, fy = ty - cy;
      const h = warpTop ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI) * 0.8;

      const rub = fbm((x / size) * 2.5, (y / size) * 2.5, 5, seed + 7, 4);
      const fuzz = vnoise((x / size) * 90, (y / size) * 90, 90, seed + 44);

      // Indigo is dyed only on the warp; the weft stays pale. That contrast is
      // the whole look of denim.
      const paleness = warpTop ? 0.0 : 0.07;
      const abrasion = Math.max(0, rub - 0.66) * 1.1 * wear;
      const t = paleness + abrasion * 0.55;
      const shade = 0.94 + h * 0.06;
      let r = (_c0[0] + (0.55 - _c0[0]) * t) * shade;
      let g = (_c0[1] + (0.56 - _c0[1]) * t) * shade;
      let b = (_c0[2] + (0.6 - _c0[2]) * t) * shade;
      const f = (fuzz - 0.5) * 0.03;
      r += f; g += f; b += f;

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      height[i] = h * 0.8 + fuzz * 0.2;
      rough[i] = 0.9 - abrasion * 0.12 + (fuzz - 0.5) * 0.06;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 3.0, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/** Scuffed work-boot leather: Voronoi-ish crease cells + polished high points. */
function makeLeather(base, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * 14, v = (y / size) * 14;
      // cheap cellular: distance to the nearest jittered lattice point
      let best = 9, second = 9;
      const cx = Math.floor(u), cy = Math.floor(v);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const jx = gx + hash2(((gx % 14) + 14) % 14, ((gy % 14) + 14) % 14, seed);
          const jy = gy + hash2(((gx % 14) + 14) % 14, ((gy % 14) + 14) % 14, seed + 9);
          const d = Math.hypot(u - jx, v - jy);
          if (d < best) { second = best; best = d; }
          else if (d < second) second = d;
        }
      }
      const crease = Math.min(1, (second - best) * 2.2);
      const grain = fbm(u * 4, v * 4, 56, seed + 21, 3);
      const scuff = fbm(u * 0.8, v * 0.8, 12, seed + 55, 4);

      const shade = 0.62 + crease * 0.38;
      const dust = Math.max(0, scuff - 0.6) * 0.9;
      let r = _c0[0] * shade + dust * 0.06;
      let g = _c0[1] * shade + dust * 0.055;
      let b = _c0[2] * shade + dust * 0.048;
      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      height[i] = crease * 0.7 + grain * 0.3;
      rough[i] = 0.46 + (1 - crease) * 0.34 + dust * 0.25;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 2.2, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/** Hair: strand streaks along V, dark, with a low-roughness sheen band. */
function makeHair(base, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const strand = vnoise((x / size) * 120, (y / size) * 5, 120, seed);
      const clump = fbm((x / size) * 16, (y / size) * 3, 32, seed + 17, 3);
      const shade = 0.55 + strand * 0.5 + clump * 0.25;
      rgb[i * 3] = linearToSrgb(Math.max(0, _c0[0] * shade));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, _c0[1] * shade));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, _c0[2] * shade));
      height[i] = strand * 0.7 + clump * 0.3;
      rough[i] = 0.34 + (1 - strand) * 0.28;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 3.4, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/**
 * The eye. One texture, laid out so that the iris lands on the front of the
 * eyeball when the sphere is UV-mapped: u wraps around, v is the polar axis.
 * The sclera carries capillaries — without them an eye is a ping-pong ball.
 */
function makeEye(iris, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  unpack(iris, _c0);
  // Iris centre in uv. The body builder's sphere puts u = 0.5 on -Z, which is
  // the direction the character faces, so that is where the iris has to land.
  const CU = 0.5, CV = 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      let du = u - CU;
      if (du > 0.5) du -= 1;
      if (du < -0.5) du += 1;
      const d = Math.hypot(du * 2.0, (v - CV) * 1.0);
      let r, g, b;
      if (d < 0.062) {
        r = g = b = 0.005; // pupil
      } else if (d < 0.215) {
        // iris: radial fibres, darker limbal ring at the edge
        const ang = Math.atan2(v - CV, du);
        const fib = vnoise(ang * 9, d * 40, 64, seed) * 0.55 + 0.55;
        const limbal = d > 0.185 ? 0.28 : 1;
        r = _c0[0] * fib * limbal;
        g = _c0[1] * fib * limbal;
        b = _c0[2] * fib * limbal;
      } else {
        // sclera with capillaries
        const cap = Math.max(0, fbm(u * 26, v * 26, 52, seed + 3, 3) - 0.56) * 2.4;
        r = 0.82 - cap * 0.02;
        g = 0.78 - cap * 0.28;
        b = 0.74 - cap * 0.3;
      }
      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      rough[i] = d < 0.22 ? 0.06 : 0.16;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/* ------------------------------------------------------------------ api */

/**
 * Build the whole texture set for one brother. Returns plain records; the
 * caller wires them onto materials and owns disposal.
 */
export function buildTextures(palette, opts = {}) {
  const aniso = opts.anisotropy ?? 8;
  const seed = opts.seed ?? 1337;
  const S = opts.size ?? 256;
  /**
   * TEXEL BUDGET, because the face atlas is the only map here that cannot
   * tile and therefore the only one whose cost is set by the size of the
   * thing rather than by the detail on it. Counted in texels, one set:
   *
   *   face atlas   512^2 albedo + 256^2 normal + 256^2 rough  = 393 216
   *   was          3 x 256^2 tiling skin                      = 196 608
   *   paid back    `belt` (built, never bound to a material)  =  49 152
   *                `eye` at 128 (it is 24 mm of sphere)       =  98 304
   *
   * Net +49 152 texels — +0.26 MiB with mips, on a set that is otherwise
   * unchanged. The character has never been the pressure on the 640 MiB soft
   * cap and this does not make it one.
   */
  return {
    skin: makeSkin(palette.skin, palette.skinShadow, seed, S, aniso, 0),
    face: makeFaceAtlas(palette, seed + 3, S * 2, aniso, {
      age: opts.age ?? 0.4,
      beard: opts.beard ?? (opts.stubble ?? 0.3),
      mouthW: opts.mouthW ?? 1,
    }),
    shirt: makeCloth(palette.shirt, palette.shirtDark, seed + 11, S, aniso, opts.cloth),
    pants: makeDenim(palette.pants, seed + 19, S, aniso, opts.wear ?? 1),
    leather: makeLeather(palette.shoe, seed + 23, S, aniso),
    hair: makeHair(palette.hair, seed + 31, S, aniso),
    eye: makeEye(palette.eye, seed + 37, S >> 1, aniso),
  };
}

export function disposeTextures(set) {
  for (const k of Object.keys(set ?? {})) {
    const m = set[k];
    if (!m) continue;
    m.map?.dispose();
    m.normalMap?.dispose();
    m.roughnessMap?.dispose();
  }
}
