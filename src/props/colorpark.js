import * as THREE from 'three';
import { Accum, hash3i, smoothNoise, clamp01, TAU } from './geom.js';

/**
 * PROPS — COLOR PARK, the painted ground and the murals on the wall.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE REPORT
 * ═════════════════════════════════════════════════════════════════════════
 * "color park is glitchy (panels laying everywhere, player falls through the
 * ground) and does not look like spraypaint".
 *
 * The diagnosis and the split of ownership are written out at the head of
 * `colorPark()` in `buildings/landmarks.js`; the short version is that the
 * park was a stack of FLAT BOXES SEATED ON ONE GROUND SAMPLE on a bank that
 * falls 3.5 m across the site, so the apron stood up to 2.6 m in the air with
 * no collider under it. This file is the other half of the fix.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE RULE THIS FILE IS BUILT ON: A VERTEX PER SAMPLE, NEVER A BOX PER PIECE
 * ═════════════════════════════════════════════════════════════════════════
 * Every piece of ground paint here is a MESH THAT FOLLOWS THE TERRAIN — its
 * vertices are laid on `world.heightAt` at a fixed lift, at a spacing fine
 * enough that the chord between two of them cannot leave the surface. So:
 *
 *   - there is no floor. The tarmac is a 5 cm-proud SKIN on the ground that
 *     was already there, and every colour on it is proud of the skin. Nothing
 *     in this file emits a collider — `B.box` is never called — so the ground
 *     a player walks on at Color Park is the terrain and only the terrain,
 *     which is the report's second complaint answered by construction rather
 *     than by tuning a number.
 *   - it cannot glitch on the slope. A box has one height; a mesh has one per
 *     vertex.
 *
 * `src/props/colorparkprobe.mjs` is the gate on both halves of that: it walks
 * the emitted vertices against the terrain and asserts the whole park lies
 * inside a few centimetres of it, with a negative control that rebuilds the
 * paint the old way (one height per piece) and must go red.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY IT READS AS AEROSOL AND NOT AS A MUNICIPAL PLAY SURFACE
 * ═════════════════════════════════════════════════════════════════════════
 * Four things, and all four are shape rather than texture, because a tinted
 * bake cannot rescue a rectangle:
 *
 *   OUTLINE   nothing is a rectangle. Every piece is a blob whose rim radius
 *             is a noise field, so no two edges are parallel and none is
 *             straight. A can does not have a straight edge.
 *   EDGES     the wear mask ramps up toward the rim of every piece, so the
 *             colour is solid in the middle and eaten at the edge — overspray
 *             rather than a printed sticker.
 *   LAYERS    pieces are laid in three passes at increasing lift, deliberately
 *             overlapping, and the lift is stepped per piece so the later one
 *             is unambiguously ON TOP. That is what a wall painted over twenty
 *             years looks like and it is the single strongest cue.
 *   DRIPS     every piece on a vertical face runs. Each mural drops two to
 *             four thin runs of its own colour off its bottom edge, and the
 *             wall's foot bleeds onto the tarmac in front of it.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE SHARED FRAME (repeated verbatim in `buildings/landmarks.js`)
 * ═════════════════════════════════════════════════════════════════════════
 * `props` may not import `buildings` (ARCHITECTURE.md rule 2), so both sides
 * derive the park's geometry from the SAME published `world.landmarks` entry
 * through the same three expressions:
 *
 *   WALL_FACE_V = HV - 3.0                 the retaining wall's park face
 *   APRON_V     = [-HV * 0.38, HV - 3.2]   the painted asphalt band
 *   TRAIL_V     = -HV * 0.86               the riverside trail
 *
 * ...and the wall's top line is the same five-sample smoothing of the ground,
 * for the same reason: a poured wall is built to a level.
 *
 * Determinism: no `rng` anywhere. Every number is `hash3i` of the site id and
 * an index, so Color Park is the same park in every capture (hard rule 4).
 */

/** The eight cans, as `props/palette.js` surface keys. */
const CANS = ['cp_pink', 'cp_teal', 'cp_yellow', 'cp_blue', 'cp_orange', 'cp_green'];
const OUTLINE = ['cp_black', 'cp_white'];

/**
 * The lift of the tarmac skin over the terrain, metres.
 *
 * MEASURED ON THE FRAME, and 0.05 was not enough: the drawn ground came
 * through the skin in tan triangles across the upper half of the apron. The
 * skin's vertices lie exactly on `world.heightAt`, but `terrainmesh` draws the
 * near ground at 2 m AND adds a band-limited detail displacement that
 * `heightAt` does not carry, so the surface a player sees is not the surface
 * this layer samples. 0.12 clears the measured residue with margin and is
 * still a step nobody can trip over — and, because nothing here collides, not
 * a step at all: the player walks on the terrain either way.
 */
const TARMAC_LIFT = 0.12;
/**
 * Sample spacing for anything that lies on the ground, metres.
 *
 * `world/terrainmesh.js` draws the near ground at 2 m, so a 1.5 m lattice
 * laid on `heightAt` cannot bridge a feature the ground mesh resolves. The
 * measured worst gap between this skin and the terrain under the whole site is
 * reported by `colorparkprobe.mjs`; the lift above is cut from it.
 */
const GROUND_STEP = 1.5;

/**
 * The site's local frame. `u` runs along the bank, `v` across it, exactly as
 * `plan.siteDist` and `buildings`' `siteAxes` define them.
 */
function frameOf(lm) {
  const yaw = lm.site?.yaw ?? 0.489;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    yaw, c, s,
    x: (u, v) => lm.x + u * c - v * s,
    z: (u, v) => lm.z + u * s + v * c,
  };
}

/**
 * A BLOB — one sprayed piece, as a fan of concentric rings.
 *
 * `map(a, b)` takes the piece's own 2D coordinates and returns the world
 * point; `nrm` is the face normal, constant per surface (up for the ground,
 * out of the wall for a mural). Rings rather than a single fan so no triangle
 * spans more than `step` — which is what keeps a 14 m piece lying on a bank
 * instead of tenting over it.
 *
 * The rim radius is a smooth noise field of the rim angle, so the outline
 * wobbles the way a can does and no two pieces share a silhouette.
 */
function blob(A, map, nrm, ra, rb, seed, opts = {}) {
  /**
   * Rim resolution. 2.6 points per metre of radius was measured on the frame
   * and rejected: an 8 m piece came out as a twenty-sided polygon with visibly
   * straight edges, which reads as a cut vinyl sticker rather than as a can.
   * Four per metre, floored at 18, is where the outline stops being a polygon
   * at the distance a player stands from it.
   */
  const N = opts.rim ?? Math.max(22, Math.round(Math.max(ra, rb) * 4));
  const rings = Math.max(1, Math.ceil(Math.max(ra, rb) / (opts.step ?? GROUND_STEP)));
  const wob = opts.wobble ?? 0.30;
  const soft = opts.soft ?? 0.55;
  const grime = opts.grime ?? 0.30;
  // radius multiplier at rim angle i, as a closed noise loop
  const rr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const n = smoothNoise(Math.cos(a) * 1.7 + seed * 0.37, Math.sin(a) * 1.7 - seed * 0.29);
    const n2 = smoothNoise(Math.cos(a) * 4.1 - seed * 0.11, Math.sin(a) * 4.1 + seed * 0.83);
    rr[i] = 1 + (n - 0.5) * 2 * wob + (n2 - 0.5) * wob * 0.7;
  }
  const p = new THREE.Vector3();
  const centre = map(0, 0, p);
  const c0 = A.vert(centre.x, centre.y, centre.z, nrm.x, nrm.y, nrm.z, 0.5, 0.5,
    0.06, grime * 0.7, 0.05);
  let prev = null;
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const idx = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const q = map(Math.cos(a) * ra * rr[i] * t, Math.sin(a) * rb * rr[i] * t, p);
      // Wear ramps to the rim: solid in the middle, eaten at the edge.
      idx[i] = A.vert(q.x, q.y, q.z, nrm.x, nrm.y, nrm.z, 0.5 + Math.cos(a) * t * 0.5,
        0.5 + Math.sin(a) * t * 0.5,
        clamp01(0.05 + soft * t * t * t), grime * (0.6 + 0.6 * t), 0.04 + 0.1 * t);
    }
    /**
     * WOUND CLOCKWISE IN THE PIECE'S OWN PLANE, and it has to be said out
     * loud because it is invisible until it is wrong — which it was, and the
     * symptom was a park with outlines and tags on it and not one field of
     * colour. Every piece here is single-sided.
     *
     * `geom.ground()` is the derivation: a `PlaneGeometry` is CCW in XY, and
     * `rotateX(-PI/2)` maps (x, y) -> (x, -y), which is a REFLECTION. So a
     * +Y-facing front face is CLOCKWISE in the XZ plane, not counter-clockwise.
     * The murals are the same: their frame is (along-u, up) with the normal
     * out of the wall, and `û × ŷ` is the INWARD normal, so the front face is
     * clockwise in that plane too. One rule, both mappings.
     */
    if (!prev) {
      for (let i = 0; i < N; i++) A.tri(c0, idx[(i + 1) % N], idx[i]);
    } else {
      for (let i = 0; i < N; i++) A.quad(prev[(i + 1) % N], idx[(i + 1) % N], idx[i], prev[i]);
    }
    prev = idx;
  }
}

/**
 * A STROKE — one pass of a can, as a ribbon down a polyline.
 *
 * Used for tags, for the outline a writer cuts round a finished piece and for
 * drips. `w(t)` is the half-width along the stroke, so a scrawl can taper the
 * way a moving can does.
 */
function stroke(A, map, nrm, pts, w, seed, opts = {}) {
  const soft = opts.soft ?? 0.5;
  const grime = opts.grime ?? 0.25;
  const step = opts.step ?? GROUND_STEP;
  // Resample the polyline so no ribbon quad is longer than `step`.
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) {
      dense.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
    }
  }
  dense.push(pts[pts.length - 1]);
  if (dense.length < 2) return;
  const p = new THREE.Vector3();
  let prevL = -1;
  let prevR = -1;
  for (let i = 0; i < dense.length; i++) {
    const a = dense[Math.max(0, i - 1)];
    const b = dense[Math.min(dense.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const t = i / (dense.length - 1);
    /**
     * A can lifts at both ends of a stroke, so the width tapers to a third at
     * the tips — EXCEPT on a closed ring, where "both ends" is one point in
     * the middle of the line and the taper opens a gap in the outline. That
     * was measured on the frame as a piece whose outline broke into shards.
     */
    const jitter = 0.75 + 0.5 * smoothNoise(t * 6.1 + seed * 0.7, seed * 1.9);
    const hw = w * jitter * (opts.closed
      ? 1
      : 0.34 + 0.66 * Math.sin(Math.PI * clamp01(t)) ** 0.45);
    const q0 = map(dense[i][0] - dy * hw, dense[i][1] + dx * hw, p);
    const l0 = A.vert(q0.x, q0.y, q0.z, nrm.x, nrm.y, nrm.z, 0, t,
      clamp01(0.05 + soft), grime, 0.08);
    const q1 = map(dense[i][0] + dy * hw, dense[i][1] - dx * hw, p);
    const r0 = A.vert(q1.x, q1.y, q1.z, nrm.x, nrm.y, nrm.z, 1, t,
      clamp01(0.05 + soft), grime, 0.08);
    if (prevL >= 0) A.quad(prevL, l0, r0, prevR);
    prevL = l0;
    prevR = r0;
  }
}

/** A closed ring of stroke, for the outline round a finished piece. */
function ringStroke(A, map, nrm, ra, rb, seed, w, opts) {
  const N = opts?.rim ?? 44;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    const n = smoothNoise(Math.cos(a) * 1.7 + seed * 0.37, Math.sin(a) * 1.7 - seed * 0.29);
    const n2 = smoothNoise(Math.cos(a) * 4.1 - seed * 0.11, Math.sin(a) * 4.1 + seed * 0.83);
    const rmul = 1 + (n - 0.5) * 0.6 + (n2 - 0.5) * 0.21;
    pts.push([Math.cos(a) * ra * rmul, Math.sin(a) * rb * rmul]);
  }
  stroke(A, map, nrm, pts, w, seed + 11, { ...opts, closed: true });
}

/**
 * Emit one accumulated surface into the tile batch and free the scratch.
 * `TileBatch.add` copies every attribute, so the temporary is ours to dispose
 * (hard rule 6).
 */
function flush(B, key, A) {
  if (A.empty) return;
  const g = A.build();
  B.add(key, g);
  g.dispose();
}

/**
 * THE PAINTED GROUND AND THE MURALS.
 *
 * @param {TileBatch} B
 * @param {object} bx    tile bounds — every piece is emitted by the tile that
 *                       contains its own centre, so a park across four tiles
 *                       paints each piece exactly once and none falls down a
 *                       seam (the second form of the tile-independence rule at
 *                       the head of `layout.js`).
 * @param {object} lm    the published `world.landmarks` entry
 * @param {object} world the world system, for `heightAt`
 * @param {number} seed  the site seed
 * @param {object} [opts] `flat: true` seats every piece on ONE ground sample,
 *                       which is what the shipped park did — the negative
 *                       control for `colorparkprobe.mjs`, and the only reason
 *                       this parameter exists.
 */
export function paintColorPark(B, bx, lm, world, seed, opts = {}) {
  const F = frameOf(lm);
  const HU = lm.site?.hx ?? 76;
  const HV = lm.site?.hz ?? 16;
  const inTile = (u, v) => {
    const x = F.x(u, v);
    const z = F.z(u, v);
    return x >= bx.x0 && x < bx.x1 && z >= bx.z0 && z < bx.z1;
  };
  const gAt = (x, z) => {
    const y = world.heightAt?.(x, z);
    return Number.isFinite(y) ? y : 0;
  };
  const H = (rnd) => hash3i(seed, rnd, 7);

  // ---- the shared frame; see the header ---------------------------------
  const WALL_V = HV - 3.0;
  const AV0 = -HV * 0.38;
  const AV1 = HV - 3.2;

  /**
   * Ground mapping. `opts.flat` freezes the height at the piece's centre,
   * which is the defect this file exists to remove — kept reachable so the
   * probe can prove the gate is measuring something.
   */
  const groundMap = (lift, cu, cv) => {
    const y0 = opts.flat ? gAt(F.x(cu, cv), F.z(cu, cv)) + lift : 0;
    return (a, b, out) => {
      const u = cu + a;
      const v = cv + b;
      const x = F.x(u, v);
      const z = F.z(u, v);
      return out.set(x, opts.flat ? y0 : gAt(x, z) + lift, z);
    };
  };
  const UP = { x: 0, y: 1, z: 0 };

  const acc = new Map();
  const A = (key) => {
    let a = acc.get(key);
    if (!a) acc.set(key, (a = new Accum(`colorpark:${key}`)));
    return a;
  };

  /* ---- 1. the tarmac skin ---------------------------------------------- */
  /**
   * ONE CONTINUOUS SKIN ON THE GROUND, at `TARMAC_LIFT`, sampled on a
   * `GROUND_STEP` lattice. This is what the report means by painted asphalt:
   * the paint needs asphalt under it, and asphalt on a river bank is a skin,
   * not a slab. No collider: the terrain under it is unchanged and is what the
   * player stands on.
   */
  {
    const u0 = -HU + 3;
    const u1 = HU - 3;
    const nu = Math.max(2, Math.ceil((u1 - u0) / GROUND_STEP));
    const nv = Math.max(2, Math.ceil((AV1 - AV0) / GROUND_STEP));
    const a = A('cp_tarmac');
    /**
     * EMITTED CELL BY CELL, each by the tile that contains its own centre.
     * A shared vertex grid would have to belong to one tile, and the skin is
     * 150 m long across three of them — so a quad is the unit, its four
     * corners are computed from the same expressions on both sides of a seam,
     * and the two tiles' meshes therefore meet exactly. The duplicated corner
     * vertices are the price of a park that cannot show a crack down it.
     */
    const P = (u, v) => {
      const x = F.x(u, v);
      const z = F.z(u, v);
      const n = smoothNoise(x * 0.09, z * 0.09);
      return a.vert(x, gAt(x, z) + TARMAC_LIFT, z, 0, 1, 0, u * 0.09, v * 0.09,
        0.25 + 0.5 * n, 0.3 + 0.5 * (1 - (v - AV0) / (AV1 - AV0)), 0.08);
    };
    for (let j = 0; j < nv; j++) {
      const va = AV0 + ((AV1 - AV0) * j) / nv;
      const vb = AV0 + ((AV1 - AV0) * (j + 1)) / nv;
      for (let i = 0; i < nu; i++) {
        const ua = u0 + ((u1 - u0) * i) / nu;
        const ub = u0 + ((u1 - u0) * (i + 1)) / nu;
        if (!inTile((ua + ub) * 0.5, (va + vb) * 0.5)) continue;
        // Clockwise in (u, v) — see the winding note in `blob`.
        a.quad(P(ua, va), P(ua, vb), P(ub, vb), P(ub, va));
      }
    }
  }

  /* ---- 2. the pieces on the ground ------------------------------------- */
  /**
   * A PIECE IS FOUR PASSES, NOT ONE FLAT SHAPE, and that is the difference
   * between paint and a coloured tarpaulin. MEASURED on the frame: a single
   * blob of solid colour with an outline round it reads as a cut vinyl decal,
   * however irregular its outline is, because a real piece has a fill, a
   * second colour thrown over it, a black cut round the whole thing and a
   * white highlight inside. So each of the fourteen BASE pieces is built the
   * same way the murals are, and the small FILLS are CLUSTERED on them rather
   * than scattered over the apron — writers paint next to each other's work,
   * and a scatter of unrelated shapes on open tarmac is exactly the "panels
   * laying everywhere" the report opened with.
   *
   * The lift is stepped per index so two overlapping pieces cannot z-fight and
   * so the later one is unambiguously the later one.
   */
  const BASE = 14;
  const baseAt = [];
  for (let i = 0; i < BASE; i++) {
    const u = -HU + 8 + H(i * 3 + 1) * (HU * 2 - 16);
    const v = AV0 + 1.5 + H(i * 3 + 2) * (AV1 - AV0 - 3);
    const ra = 3.2 + H(i * 3 + 3) * 4.0;
    const rb = 2.2 + H(i * 5 + 4) * 2.6;
    baseAt.push([u, v, ra, rb]);
    if (!inTile(u, v)) continue;
    const can = CANS[Math.floor(H(i * 7 + 5) * CANS.length) % CANS.length];
    const c2 = CANS[(Math.floor(H(i * 7 + 6) * CANS.length) + 2) % CANS.length];
    const lift = TARMAC_LIFT + 0.012 + i * 0.003;
    blob(A(can), groundMap(lift, u, v), UP, ra, rb, seed + i * 13,
      { wobble: 0.34, soft: 0.5, grime: 0.26 });
    // The second colour, thrown over the fill and off-centre.
    blob(A(c2), groundMap(lift + 0.004, u + (H(i * 9 + 7) - 0.5) * ra * 0.8,
      v + (H(i * 9 + 8) - 0.5) * rb * 0.7), UP, ra * 0.5, rb * 0.55,
      seed + 400 + i * 11, { wobble: 0.44, soft: 0.5, grime: 0.22 });
    /**
     * The black cut round the whole thing — and NO white highlight on the
     * ground, deliberately. On a vertical mural a white ring reads as the
     * highlight a writer cuts inside a letter; laid flat on dark tarmac and
     * seen at the grazing angle a standing player has, it reads as a scrap of
     * paper. Same shape, opposite meaning, so it stays on the wall.
     */
    ringStroke(A('cp_black'), groundMap(lift + 0.008, u, v), UP, ra * 1.02, rb * 1.02,
      seed + i * 13, 0.13, { soft: 0.3, grime: 0.3 });
  }
  const FILL = 40;
  for (let i = 0; i < FILL; i++) {
    const b = baseAt[i % BASE];
    const u = b[0] + (H(i * 11 + 21) - 0.5) * b[2] * 2.6;
    const v = b[1] + (H(i * 11 + 22) - 0.5) * b[3] * 2.2;
    if (v < AV0 + 0.5 || v > AV1 - 0.5) continue;
    if (!inTile(u, v)) continue;
    const ra = 1.2 + H(i * 11 + 23) * 2.4;
    const rb = 0.9 + H(i * 13 + 24) * 1.8;
    const can = CANS[Math.floor(H(i * 17 + 25) * CANS.length) % CANS.length];
    // 0.42 of wobble on a 2 m piece puts a spike on it, and a spike on tarmac
    // is a shard rather than a can. Small pieces get a rounder outline.
    blob(A(can), groundMap(TARMAC_LIFT + 0.05 + (i % 7) * 0.004, u, v), UP, ra, rb,
      seed + 700 + i * 7, { wobble: 0.24, soft: 0.55, grime: 0.2 });
  }

  /* ---- 3. tags on the ground ------------------------------------------- */
  /**
   * Hand tags, and they are DELIBERATELY THIN AND MOSTLY BLACK. A fat pale
   * scrawl on dark tarmac photographs as a sheet of paper lying on the ground
   * at any grazing angle, which is the one reading this whole rebuild exists
   * to avoid; 4-9 cm of mostly-black stroke reads as a marker every time.
   */
  const TAGS = 34;
  for (let i = 0; i < TAGS; i++) {
    const u = -HU + 6 + H(i * 19 + 41) * (HU * 2 - 12);
    const v = AV0 + 1.0 + H(i * 19 + 42) * (AV1 - AV0 - 2);
    if (!inTile(u, v)) continue;
    const key = H(i * 23 + 43) < 0.72
      ? 'cp_black'
      : CANS[Math.floor(H(i * 29 + 44) * CANS.length) % CANS.length];
    const len = 1.6 + H(i * 31 + 45) * 3.4;
    const ang = H(i * 37 + 46) * TAU;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    // A three-beat scrawl: over, back under, out — the shape of a hand tag.
    const pts = [];
    for (let k = 0; k < 5; k++) {
      const t = k / 4;
      const across = (t - 0.5) * len;
      const up = (H(i * 41 + 50 + k) - 0.5) * len * 0.5;
      pts.push([across * ca - up * sa, across * sa + up * ca]);
    }
    stroke(A(key), groundMap(TARMAC_LIFT + 0.09 + (i % 5) * 0.004, u, v), UP, pts,
      0.04 + H(i * 43 + 47) * 0.05, seed + 900 + i * 5, { soft: 0.4, grime: 0.25 });
  }

  /* ---- 4. the murals on the retaining wall ------------------------------ */
  /**
   * THE WALL FACE. The same five-sample smoothing of the ground that
   * `buildings` builds the wall's top line from, so a mural lands on concrete
   * whatever the bank does underneath. The face is at `WALL_V`; paint sits
   * `off` metres in front of it and every layer a few millimetres further, so
   * the drips are in front of the fields they run off.
   */
  const wallU0 = -HU + 3;
  const wallU1 = HU - 3;
  const smoothG = (u) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) {
      const uu = Math.max(wallU0, Math.min(wallU1, u + k * 3));
      s += gAt(F.x(uu, WALL_V + 0.45), F.z(uu, WALL_V + 0.45));
    }
    return s / 5;
  };
  // Out of the wall, toward the park: -v in the site frame.
  const outN = { x: F.s, y: 0, z: -F.c };
  const wallMap = (cu, off) => {
    const g = smoothG(cu);
    return (a, b, out) => {
      const u = cu + a;
      return out.set(F.x(u, WALL_V - off), g + b, F.z(u, WALL_V - off));
    };
  };

  const MURAL = 13;
  for (let i = 0; i < MURAL; i++) {
    const u = wallU0 + 6 + ((wallU1 - wallU0 - 12) * i) / (MURAL - 1)
      + (H(i * 53 + 61) - 0.5) * 5;
    if (!inTile(u, WALL_V)) continue;
    const can = CANS[Math.floor(H(i * 59 + 62) * CANS.length) % CANS.length];
    const ra = 4.4 + H(i * 61 + 63) * 3.2;
    const rb = 1.10 + H(i * 67 + 64) * 0.45;
    const cy = 1.55 + H(i * 71 + 65) * 0.35;
    /** Lift a wall mapping to the field's own centre height on the wall. */
    const at = (m) => (a, b, out) => m(a, b + cy, out);
    blob(A(can), at(wallMap(u, 0.05)), outN, ra, rb, seed + 1300 + i * 17,
      { wobble: 0.3, soft: 0.45, grime: 0.2, step: 1.2 });
    // A second colour laid over the first, smaller and off-centre: nobody
    // finishes a legal wall.
    const c2 = CANS[Math.floor(H(i * 73 + 66) * CANS.length + 3) % CANS.length];
    blob(A(c2), at(wallMap(u + (H(i * 79 + 67) - 0.5) * ra, 0.075)), outN,
      ra * 0.52, rb * 0.72, seed + 1700 + i * 19,
      { wobble: 0.42, soft: 0.5, grime: 0.18, step: 1.2 });
    // The outline, and a white highlight inside it.
    ringStroke(A('cp_black'), at(wallMap(u, 0.095)), outN, ra * 1.02, rb * 1.04,
      seed + 1300 + i * 17, 0.11, { soft: 0.3, grime: 0.25, step: 1.0 });
    ringStroke(A('cp_white'), at(wallMap(u - ra * 0.2, 0.11)), outN, ra * 0.3, rb * 0.42,
      seed + 2100 + i * 23, 0.07, { soft: 0.45, grime: 0.2, step: 1.0 });
    /**
     * THE DRIPS. Two to four runs off the bottom of every field, each one a
     * tapering stroke straight down. This is the single detail that separates
     * aerosol from vinyl, and it is the one the shipped park had none of.
     */
    const drips = 2 + Math.floor(H(i * 83 + 68) * 3);
    for (let k = 0; k < drips; k++) {
      const du = (H(i * 89 + 70 + k) - 0.5) * ra * 1.5;
      const dl = 0.35 + H(i * 97 + 80 + k) * 1.1;
      stroke(A(can), at(wallMap(u, 0.115)), outN,
        [[du, -rb * 0.9], [du + (H(i * 101 + 90 + k) - 0.5) * 0.12, -rb * 0.9 - dl]],
        0.035 + H(i * 103 + 95 + k) * 0.03, seed + 2500 + i * 29 + k,
        { soft: 0.5, grime: 0.3, step: 0.5 });
    }
  }

  /* ---- 5. tags along the foot of the wall, and the bleed onto the tarmac - */
  const FOOT = 16;
  for (let i = 0; i < FOOT; i++) {
    const u = wallU0 + 4 + H(i * 107 + 111) * (wallU1 - wallU0 - 8);
    if (!inTile(u, WALL_V)) continue;
    const key = H(i * 109 + 112) < 0.5
      ? OUTLINE[i % OUTLINE.length]
      : CANS[Math.floor(H(i * 113 + 113) * CANS.length) % CANS.length];
    const len = 0.9 + H(i * 127 + 114) * 1.8;
    const y = 0.45 + H(i * 131 + 115) * 0.6;
    const pts = [];
    for (let k = 0; k < 4; k++) {
      const t = k / 3;
      pts.push([(t - 0.5) * len, y + (H(i * 137 + 120 + k) - 0.5) * 0.42]);
    }
    stroke(A(key), wallMap(u, 0.13), outN, pts, 0.05 + H(i * 139 + 116) * 0.05,
      seed + 3100 + i * 11, { soft: 0.4, grime: 0.3, step: 0.5 });
    // ...and where the can ran off the bottom of the wall onto the ground.
    // Set down at `WALL_V - 1.6` rather than against the skirting, so the
    // whole blob is unambiguously GROUND paint: `colorparkprobe.mjs` sorts
    // ground from wall by the site-local v of each emitted vertex, and a
    // puddle straddling the wall face would be measured against the terrain
    // on one side and against the wall on the other.
    if (H(i * 149 + 117) < 0.45) {
      const v = WALL_V - 1.6;
      if (inTile(u, v)) {
        blob(A(key), groundMap(TARMAC_LIFT + 0.11, u, v), UP,
          0.5 + H(i * 151 + 118) * 0.9, 0.28 + H(i * 157 + 119) * 0.4,
          seed + 3300 + i * 3, { wobble: 0.45, soft: 0.6, grime: 0.26, step: 0.8 });
      }
    }
  }

  /**
   * THE SKATE LEDGES ARE PAINTED BY `buildings`, NOT HERE, and that is a
   * deliberate line rather than an oversight. Everything in this file lies on
   * the GROUND or on the WALL FACE, which is exactly the claim
   * `colorparkprobe.mjs` gates: every emitted vertex in front of the wall is
   * within a few centimetres of the terrain. A ledge deck stands 0.56 m proud
   * of the ground, so paint on one would have to be excluded from that sweep
   * by a rule keyed to the ledge's authored position — a fourth number shared
   * across the subsystem line, and a hole in the assertion. The ledge owns its
   * own top surface; this file owns the ground and the wall.
   */

  for (const [key, a] of acc) flush(B, key, a);
}
