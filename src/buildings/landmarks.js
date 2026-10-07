import * as THREE from 'three';
import {
  Accum,
  chamferBox,
  plainBox,
  quad,
  cylinderY,
  moulding,
  polyPrism,
  fillMasks,
  weather,
  trs,
  fbm3,
} from './geom.js';
import { Kit } from './kit.js';

/**
 * BUILDINGS — the six landmarks (DESIGN.md).
 *
 * Hand-authored, always resident, never generated. These are the city's
 * silhouette: the Steel Tower and the Steel Bowl are what you read from across
 * the rivers, the Blast Furnace is what tells you Steel Row is Steel Row, and
 * the Incline is the reason Mt. Washington exists as a place you go.
 *
 * WHERE A LANDMARK IS IS NOT THIS FILE'S DECISION.
 *
 * `world` is the authority on where everything is, and it publishes the table
 * as `world.landmarks`. This file used to keep its own copy — DESIGN.md's
 * legacy coordinates times four — and the copy DISAGREED: it put The Point
 * Fountain at `(-712, 32)`, where `heightAt` is -8.68 m and `isWater` is true.
 * The fountain was on the bed of the Ohio, 112 m downstream of the confluence,
 * because a x4 scale of a 700 m map does not survive rivers that were widened
 * to match. `world/plan.js`, `src/game/data.js` and `src/ui/data.js` all say
 * `(-452, 46)` — the tip of the triangle, dry at +3.56 m — and they are right.
 *
 * So `BuildingSystem.init` calls `adoptLandmarkSites(world.landmarks)` before
 * anything reads this table, and the numbers below are only what the
 * standalone `preview.html` sees when there is no `world` to ask. They are
 * kept in world metres, identical to `plan.js`, so a diff between the two is
 * visible rather than hidden behind an arithmetic conversion.
 */

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export const LANDMARKS = [
  { id: 'lm_tower', name: 'Steel Tower', x: -208, z: -16, kind: 'tower', seed: 0x51ee1 },
  { id: 'lm_stadium', name: 'Steel Bowl', x: -416, z: -512, kind: 'stadium', seed: 0xb0417 },
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248, kind: 'mill', seed: 0xf0e2 },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296, kind: 'incline', seed: 0x1c11 },
  { id: 'lm_point', name: 'The Point Fountain', x: -452, z: 46, kind: 'fountain', seed: 0x9011 },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224, kind: 'market', seed: 0x3a12 },
  // OAKLAND / SOUTH SIDE wave. Same contract as the six above: these are the
  // preview.html fallbacks and `adoptLandmarkSites` overwrites x/z from
  // `world.landmarks` before anything reads them. Kept identical to `plan.js`.
  { id: 'lm_cathedral', name: 'The Cathedral of Steel', x: 508, z: 24, kind: 'cathedral', seed: 0xca7ed },
  { id: 'lm_ironwood', name: 'Ironwood Park', x: 676, z: 164, kind: 'greenpark', seed: 0x17ee5 },
  { id: 'lm_colorpark', name: 'Color Park', x: 306, z: 654, kind: 'colorpark', seed: 0xc01021 },
  // GOLDEN TRIANGLE wave. See `glassCourt()` and the note on `lm_glass` in
  // `world/plan.js`: one tower and four wings on one downtown block.
  { id: 'lm_glass', name: 'Glasshouse Court', x: -216, z: 104, kind: 'glasscourt', seed: 0x91a55 },
];

/**
 * Take the coordinates from `world.landmarks`, in place, so nothing that has
 * already captured a reference to `LANDMARKS` (or to one of its entries) can
 * end up reading the stale pair. `seed` stays ours — it is what makes each
 * landmark's weathering deterministic — and so does the build code; only
 * WHERE is adopted. Returns how many entries moved, so a divergence is
 * reported rather than silently absorbed.
 */
export function adoptLandmarkSites(published) {
  if (!Array.isArray(published)) return 0;
  let moved = 0;
  for (const lm of LANDMARKS) {
    const src = published.find((p) => p.id === lm.id);
    if (!src) continue;
    if (lm.x !== src.x || lm.z !== src.z) {
      console.warn(
        `[buildings] ${lm.id} moved to world's coordinate ` +
          `(${lm.x}, ${lm.z}) -> (${src.x}, ${src.z})`
      );
      moved++;
    }
    lm.x = src.x;
    lm.z = src.z;
    // The reserved footprint `world` keeps roads out of, when it publishes
    // one, and the uphill bearing it solved for a hill-oriented landmark.
    if (src.site) lm.site = src.site;
    if (src.uphill) lm.uphill = src.uphill;
    /**
     * The funicular TRACK DESCRIPTOR (`src/world/incline.js`), when `world`
     * has solved one. Adopted BY REFERENCE, deliberately: `incline()` emits
     * its trestle and rails from these exact arrays, and the `funicular`
     * subsystem poses its moving cars by sampling the same object off
     * `world.landmarks` — one authority, so the cars cannot drift off the
     * rails. `src/vehicles/funicularprobe.mjs` gates that.
     */
    if (src.funicular) lm.funicular = src.funicular;
  }
  return moved;
}

export function landmarksInBounds(x0, z0, x1, z1) {
  return LANDMARKS.filter((l) => l.x >= x0 && l.x < x1 && l.z >= z0 && l.z < z1);
}

/**
 * How much ground each landmark claims. Generated lots inside this are skipped
 * — a lot subdivision that does not know the Steel Bowl is there will happily
 * put a rowhouse through the middle of it, and the landmark is the one thing
 * in the city that must never be interpenetrated.
 */
const CLAIM = {
  lm_tower: 46,
  lm_stadium: 150,
  lm_mill: 92,
  lm_incline: 60,
  lm_point: 62,
  lm_market: 78,
  /**
   * The Oakland / South Side wave. Each is the site's own reach plus a couple
   * of metres, so a generated lot cannot be subdivided into the quad, the park
   * or the painted slabs: the Cathedral's quad is 54 x 42 about its centre
   * (corner 68.4), Ironwood is a disc of 84, and Color Park is 76 long on the
   * bank. `landmarkClaims` is a radial test, so each takes the corner.
   */
  lm_cathedral: 74,
  lm_ironwood: 92,
  lm_colorpark: 80,
  /**
   * GLASSHOUSE COURT is the one claim that must NOT be generous, and that is a
   * deliberate reversal of the rule the eight above follow.
   *
   * Every other landmark stands in open ground and a radial claim that
   * over-reaches costs nothing. This one stands on a downtown block in the
   * district the owner's report says is too empty, so every metre of claim past
   * the court's own wings deletes a generated building from the densest street
   * grid in the city. The site is 30 x 40 about the centre (`plan.js`), the
   * wings stand on its edges, and the corner of that box is 50 m out — so 54 is
   * the wings plus 4 m, and `landmarkClaims`' radial test is asked for the
   * corner rather than for a comfortable disc.
   */
  lm_glass: 54,
};

export function landmarkClaims(x, z) {
  for (const l of LANDMARKS) {
    const r = CLAIM[l.id] ?? 40;
    /**
     * The incline is a long diagonal, so its claim is a corridor up the hill —
     * and this function has no terrain, while `incline()` now DISCOVERS which
     * way the hill is at build time. So the claim is symmetric about the
     * station: it used to reserve the −z corridor only, which is the direction
     * the trestle was wrongly built in, and once the trestle was turned round
     * to face the actual bluff the generated lots would have been subdivided
     * straight through it.
     */
    if (l.id === 'lm_incline') {
      if (x > l.x - 26 && x < l.x + 26 && z > l.z - 200 && z < l.z + 200) return true;
      continue;
    }
    if ((x - l.x) * (x - l.x) + (z - l.z) * (z - l.z) < r * r) return true;
  }
  return false;
}

// ------------------------------------------------------------------ utils --
function box(T, key, x, y, z, sx, sy, sz, ry = 0, masks = null, geo = null) {
  const g = geo ?? _sharedBox();
  trs(_m, x, y, z, ry, sx, sy, sz);
  T.add(key, g, _m, masks ? { masks } : null);
}

let _bx = null;
function _sharedBox() {
  if (!_bx) _bx = plainBox();
  return _bx;
}
let _cbx = null;
function _sharedChamfer() {
  if (!_cbx) _cbx = chamferBox(1, 1, 1, 0.02);
  return _cbx;
}

function cyl(T, key, x, y, z, r, h, seg = 16, masks = null, rTop = null) {
  const g = cylinderY(r, h, seg, rTop !== null ? { rTop } : {});
  trs(_m, x, y + h / 2, z, 0, 1, 1, 1);
  T.addOnce(key, g, _m, masks ? { masks } : null);
}

export function buildLandmark(T, lib, lm, rng, groundY = 0, groundAt = null) {
  const ga = groundAt ?? (() => groundY);
  switch (lm.kind) {
    case 'tower':
      return steelTower(T, lib, lm, rng, groundY);
    case 'stadium':
      return steelBowl(T, lib, lm, rng, groundY);
    case 'mill':
      return blastFurnace(T, lib, lm, rng, groundY);
    case 'incline':
      return incline(T, lib, lm, rng, groundY, ga);
    case 'fountain':
      return pointFountain(T, lib, lm, rng, groundY);
    case 'market':
      return stripMarket(T, lib, lm, rng, groundY);
    case 'cathedral':
      return cathedralOfSteel(T, lib, lm, rng, groundY, ga);
    case 'greenpark':
      return ironwoodPark(T, lib, lm, rng, groundY, ga);
    case 'colorpark':
      return colorPark(T, lib, lm, rng, groundY, ga);
    case 'glasscourt':
      return glassCourt(T, lib, lm, rng, groundY);
    default:
      return null;
  }
}

// ------------------------------------------------------------ Steel Tower --
/**
 * The tallest building in Steel City: 64 storeys of dark steel and bronze
 * glass, chamfered corners, three setbacks and a lit mast. It is the one
 * silhouette every long view of downtown has to contain.
 */
function steelTower(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const floorH = 3.9;
  const stages = [
    { w: 52, d: 44, floors: 4, mat: 'stone_grey' },
    { w: 44, d: 38, floors: 26 },
    { w: 36, d: 31, floors: 18 },
    { w: 27, d: 24, floors: 12 },
  ];
  let y = gy;
  const glass = 'glass_bronze';
  const skin = 'steel_dark';

  for (let s = 0; s < stages.length; s++) {
    const st = stages[s];
    const h = st.floors * floorH;
    if (s === 0) {
      // podium: solid stone with a deep colonnade, so the tower has a base
      box(T, st.mat, x, y + h / 2, z, st.w, h, st.d, 0, [0.25, 0.35, 0.2], _sharedChamfer());
      const n = 9;
      for (let i = 0; i < n; i++) {
        const px = x - st.w / 2 + ((i + 0.5) / n) * st.w;
        box(T, 'stone_warm', px, y + h / 2, z + st.d / 2 + 0.9, 1.5, h, 1.5, 0, [0.35, 0.45, 0.25], _sharedChamfer());
      }
      box(T, 'stone_warm', x, y + h - 0.7, z, st.w + 3.4, 1.4, st.d + 3.4, 0, [0.4, 0.4, 0.2], _sharedChamfer());
      // glazed lobby behind the colonnade
      for (const sz of [-1, 1]) {
        box(T, glass, x, y + h * 0.45, z + sz * (st.d / 2 - 0.2), st.w - 4, h * 0.7, 0.2, 0, [0, 0.15, 0]);
        box(T, 'room_lit_cool', x, y + h * 0.45, z + sz * (st.d / 2 - 0.9), st.w - 4, h * 0.7, 0.2, 0, [0, 0.1, 0.4]);
      }
      y += h;
      continue;
    }

    // banded curtain wall on all four faces
    for (let f = 0; f < st.floors; f++) {
      const fy = y + f * floorH;
      // spandrel
      box(T, skin, x, fy + 0.55, z, st.w + 0.12, 1.1, st.d + 0.12, 0, [0.28, 0.3, 0.15]);
      // glazing
      box(T, glass, x, fy + 1.1 + (floorH - 1.1) / 2, z, st.w, floorH - 1.1, st.d, 0, [0, 0.15, 0]);
      box(T, 'room_office', x, fy + 1.1 + (floorH - 1.1) / 2, z, st.w - 1.6, floorH - 1.3, st.d - 1.6, 0, [0, 0.1, 0.45]);
    }
    // vertical fins on a 2.4 m module
    const finsW = Math.round(st.w / 2.4);
    const finsD = Math.round(st.d / 2.4);
    for (let i = 0; i <= finsW; i++) {
      const px = x - st.w / 2 + (i / finsW) * st.w;
      for (const sz of [-1, 1]) {
        box(T, 'alu_dark', px, y + h / 2, z + sz * (st.d / 2 + 0.14), 0.17, h, 0.42, 0, [0.35, 0.2, 0.1]);
      }
    }
    for (let i = 0; i <= finsD; i++) {
      const pz = z - st.d / 2 + (i / finsD) * st.d;
      for (const sx of [-1, 1]) {
        box(T, 'alu_dark', x + sx * (st.w / 2 + 0.14), y + h / 2, pz, 0.42, h, 0.17, 0, [0.35, 0.2, 0.1]);
      }
    }
    // chamfered corner piers — the tower's signature in profile
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(T, skin, x + sx * (st.w / 2 - 0.6), y + h / 2, z + sz * (st.d / 2 - 0.6), 2.6, h, 2.6, Math.PI / 4, [0.3, 0.3, 0.15], _sharedChamfer());
      }
    }
    // setback ledge
    box(T, 'concrete_dark', x, y + h + 0.35, z, st.w + 2.2, 0.7, st.d + 2.2, 0, [0.4, 0.45, 0.25], _sharedChamfer());
    y += h + 0.7;
  }

  /**
   * THE CROWN IS FLAT, AND IT IS A RING OF COLUMN HEADS. This used to be three
   * concentric setbacks — a wedding cake — and a wedding cake is what every
   * OTHER tall building in this city already is: `archetypes.js` gives a deco
   * tower two to four `step` crowns and a postmodern one a pyramid, so the one
   * hand-authored tower on the skyline was wearing the generator's hat.
   *
   * The building this is a portrait of is famous for the opposite. It is a
   * dark, blunt, dead-flat slab whose EXPOSED PERIMETER COLUMNS run past the
   * roofline and stop, so the top reads as a ring of square heads against the
   * sky with the plant deck sunk between them. Nothing else downtown does that,
   * which is the whole point of a landmark: at 1.2 km from Hazelwood the
   * silhouette is the only thing left, and "flat with teeth" survives that
   * distance where "slightly smaller box, then slightly smaller box" does not.
   *
   * The last stage's width `st.w` = 27 x 24, so the ring is laid on the SAME
   * 2.4 m module as the fins below it and the heads land on the columns they
   * are the tops of, rather than on a fresh rhythm of their own.
   */
  const cw = 27;
  const cd = 24;
  // The parapet the ring stands on: one flat band, no cornice, no step.
  box(T, 'steel_dark', x, y + 0.85, z, cw + 0.9, 1.7, cd + 0.9, 0, [0.32, 0.38, 0.2], _sharedChamfer());
  // The plant deck, SUNK inside the ring so the sky comes through the teeth.
  box(T, 'concrete_dark', x, y + 2.6, z, cw - 6.4, 3.4, cd - 6.4, 0, [0.4, 0.5, 0.3], _sharedChamfer());
  box(T, 'alu_dark', x, y + 4.5, z, cw - 5.6, 0.5, cd - 5.6, 0, [0.5, 0.35, 0.2]);
  // The column heads. One per fin module on all four faces, plus the four
  // corner piers carried up at twice the height — the corners are the two-
  // storey ones on the real thing and they are what makes the ring read.
  const headH = 5.6;
  const nW = Math.round(cw / 2.7);
  const nD = Math.round(cd / 2.7);
  for (let i = 0; i <= nW; i++) {
    const px = x - cw / 2 + (i / nW) * cw;
    for (const sz of [-1, 1]) {
      box(T, 'steel_dark', px, y + 1.7 + headH / 2, z + sz * (cd / 2), 1.5, headH, 1.5, 0, [0.34, 0.36, 0.18], _sharedChamfer());
    }
  }
  for (let j = 1; j < nD; j++) {
    const pz = z - cd / 2 + (j / nD) * cd;
    for (const sx of [-1, 1]) {
      box(T, 'steel_dark', x + sx * (cw / 2), y + 1.7 + headH / 2, pz, 1.5, headH, 1.5, 0, [0.34, 0.36, 0.18], _sharedChamfer());
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(T, 'steel_dark', x + sx * (cw / 2 - 0.6), y + 1.7 + headH * 0.9, z + sz * (cd / 2 - 0.6), 2.9, headH * 1.8, 2.9, Math.PI / 4, [0.3, 0.34, 0.16], _sharedChamfer());
    }
  }
  y += 1.7 + headH;
  // The mast, off the plant deck rather than off the parapet, and three
  // beacons rather than four: the ring already owns the top 6 m of profile.
  cyl(T, 'alu_bright', x, y - 2.2, z, 1.2, 4.4, 12, [0.4, 0.2, 0.1]);
  cyl(T, 'steel_dark', x, y + 2.2, z, 0.5, 22, 8, [0.4, 0.2, 0.1], 0.14);
  for (let i = 0; i < 3; i++) {
    box(T, 'neon_red', x, y + 5.4 + i * 6.4, z, 0.9, 0.5, 0.9, 0, [0, 0, 0]);
  }
  // roof plant on the podium
  T.put(Kit.acRoof(lib, 'alu_dark'), x + 16, gy + 4 * floorH, z + 14, 0.4, 2.2);
  T.put(Kit.vent(lib, 'steel_dark', 'stack'), x - 15, gy + 4 * floorH, z - 12, 0, 2.0);

  T.box('concrete', x, gy + 60, z, 46, 120, 40);
}

// -------------------------------------------------------- Glasshouse Court --
/**
 * A LANDMARK'S OWN FRAME.
 *
 * Every landmark before this one is axis-aligned, because every one of them
 * stands in open ground where nothing is square to anything. Glasshouse Court
 * stands ON A DOWNTOWN BLOCK, and a block has a bearing: `world` publishes it
 * as `site.yaw` (the Golden Triangle's grid angle) and the court's wings are
 * the street wall of that block, so a wing that is 30 degrees off the kerb it
 * fronts is not a street wall, it is a mistake with a plaza in it.
 *
 * `u` runs along the site's `hx`, `v` along its `hz`. The mapping is the one
 * `trs` composes — world = (u·c - v·s, u·s + v·c) with `ry = -yaw` — which is
 * the same L2W `netgen.gridDistrict` cuts the blocks with, so a wing edge at
 * `v = ±hz` is parallel to the street that bounds the block.
 */
function siteFrame(lm) {
  const s = lm.site;
  const yaw = s?.yaw ?? 0;
  return {
    x: lm.x + (s?.ox ?? 0),
    z: lm.z + (s?.oz ?? 0),
    hx: s?.hx ?? 30,
    hz: s?.hz ?? 40,
    c: Math.cos(yaw),
    s: Math.sin(yaw),
    yaw,
  };
}

/** World position of a point given in the frame's local (u, v). */
function fpos(F, u, v, out = [0, 0]) {
  out[0] = F.x + u * F.c - v * F.s;
  out[1] = F.z + u * F.s + v * F.c;
  return out;
}

const _fp = [0, 0];

/** A box given in frame-local (u, v), turned to face the frame's bearing. */
function fbox(F, T, key, u, y, v, su, sy, sv, masks = null, geo = null) {
  fpos(F, u, v, _fp);
  box(T, key, _fp[0], y, _fp[1], su, sy, sv, -F.yaw, masks, geo);
}

/**
 * A four-sided pyramid (a spire) in frame-local (u, v). `rTop` blunts the tip.
 *
 * FLAT-SHADED, and that is a correctness fix as well as a look. `cylinderY`
 * hands back a `CylinderGeometry`, whose vertex normals are RADIAL — correct
 * for a 24-sided drum and wrong for a 4-sided one, where each face's two
 * corners carry normals splayed 45 degrees either side of the face it belongs
 * to. Seen near its own silhouette that interpolated normal points away from
 * the eye on a triangle whose winding faces it, and `src/buildings/windprobe.mjs`
 * reported exactly that: one 0.51 m2 facade triangle on the plaza obelisk at
 * (-207.8, 14.5, 118.9), winding (-0.87, 0.08, 0.50) against normal
 * (-0.97, 0.15, 0.19). Splitting the vertices and recomputing gives every face
 * its own normal, which is what a masonry spire has anyway: hard arrises that
 * catch the sun on one side and not the other.
 */
function fspire(F, T, key, u, y, v, r, h, masks = null, rTop = 0.12) {
  fpos(F, u, v, _fp);
  const src = cylinderY(r, h, 4, { rTop });
  const g = src.toNonIndexed();
  g.computeVertexNormals();
  src.dispose();
  trs(_m, _fp[0], y + h / 2, _fp[1], -F.yaw + Math.PI * 0.25, 1, 1, 1);
  T.addOnce(key, g, _m, masks ? { masks } : null);
}

/**
 * GLASSHOUSE COURT — the glass castle on the Golden Triangle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HAND-AUTHORED AND NOT A CROWN RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * The other four Pittsburgh silhouettes the owner asked for are MASSING RULES,
 * and this wave gives all four of them to the generator in `archetypes.js`: a
 * red-lit deco beacon, a pyramid cap, a copper chateau roof, a flat-topped
 * steel slab. Each is one crown on an ordinary downtown lot and each therefore
 * lands wherever the lot planner put a tall lot, which is exactly right — a
 * city has several of each.
 *
 * A glass castle is not that. Its read is a SQUARE tower with a spire on every
 * corner and a taller one over the middle, standing behind a ring of low wings
 * with spires of their own, and every one of those relationships is between
 * parts of one composition. There is no per-lot rule that produces it, and a
 * generator that produced it by accident would produce nine of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A BLOCK, NOT A TOWER, AND THAT IS THE HALF THAT ANSWERS THE REPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * The report was two findings, not one: the skyline has no Pittsburgh in it,
 * AND "buildings are lining the blocks" is not true downtown. A landmark that
 * reserved 60 m of ground for one shaft would have fixed the first by making
 * the second worse — one more plaza in the district that already measures 27.6%
 * of its block area as park and surface parking.
 *
 * So the court is FIVE buildings: the tower set back on the south-west half of
 * the block, and four wings standing on the block's own edges at 5-6 storeys,
 * with the plaza between them. The wings are the street wall on all four
 * frontages — which is the thing the report asked for, built the only way a
 * landmark can build it.
 */
function glassCourt(T, lib, lm, rng, gy) {
  const F = siteFrame(lm);
  const glass = 'glass_sky';
  const mull = 'alu_dark';
  const stone = 'stone_grey';
  const cham = _sharedChamfer();

  // ---- the block plinth: one raised terrace the whole composition sits on --
  fbox(F, T, 'stone_base', 0, gy + 0.35, 0, F.hx * 2 + 1.6, 0.7, F.hz * 2 + 1.6, [0.5, 0.55, 0.35], cham);

  /**
   * ---- the wings ---------------------------------------------------------
   * Four ranges on the four edges, leaving a gap at each corner so the plaza
   * is entered from the corners rather than through a hole in an elevation.
   * `t` is how deep a wing is; 13 m is a single office bay plus a corridor,
   * which is what keeps the plaza a court rather than a light well.
   */
  const t = 13;
  const wingH = 21.5;
  const side = F.hz * 2 - 2 * t;
  const gate = 13; // the one gap in the ring: the court's entrance off the street
  const half = (F.hx * 2 - gate) / 2;
  const wings = [
    // the back range, unbroken, and the two flanks that butt into it
    { u: 0, v: -F.hz + t / 2, su: F.hx * 2, sv: t },
    { u: -F.hx + t / 2, v: 0, su: t, sv: side },
    { u: F.hx - t / 2, v: 0, su: t, sv: side },
    // the street range, split either side of the gate
    { u: -(gate + half) / 2, v: F.hz - t / 2, su: half, sv: t },
    { u: (gate + half) / 2, v: F.hz - t / 2, su: half, sv: t },
  ];
  for (const w of wings) {
    // shaft
    fbox(F, T, glass, w.u, gy + 0.7 + wingH / 2, w.v, w.su, wingH, w.sv, [0, 0.12, 0]);
    fbox(F, T, 'room_mid', w.u, gy + 0.7 + wingH / 2, w.v, w.su - 2.4, wingH - 2.6, w.sv - 2.4, [0, 0.1, 0.5]);
    fbox(F, T, 'room_lit_warm', w.u, gy + 0.7 + wingH * 0.62, w.v, w.su - 2.6, 2.4, w.sv - 2.6, [0, 0.1, 0.12]);
    // the ground storey is stone, not glass: a castle has a base course
    fbox(F, T, stone, w.u, gy + 2.9, w.v, w.su + 0.5, 4.4, w.sv + 0.5, [0.3, 0.45, 0.28], cham);
    // vertical mullions on a 2.7 m module, both long faces
    const along = w.su > w.sv;
    const len = along ? w.su : w.sv;
    const n = Math.max(2, Math.round(len / 2.7));
    for (let i = 0; i <= n; i++) {
      const o = -len / 2 + (i / n) * len;
      for (const sg of [-1, 1]) {
        const uu = along ? w.u + o : w.u + sg * (w.su / 2 + 0.1);
        const vv = along ? w.v + sg * (w.sv / 2 + 0.1) : w.v + o;
        fbox(F, T, mull, uu, gy + 0.7 + wingH / 2, vv, along ? 0.32 : 0.42, wingH, along ? 0.42 : 0.32, [0.35, 0.25, 0.12]);
      }
    }
    // the crenellated head: a band, then a row of small spires along the top
    fbox(F, T, stone, w.u, gy + wingH + 1.1, w.v, w.su + 1.1, 0.9, w.sv + 1.1, [0.45, 0.4, 0.22], cham);
    const nS = Math.max(2, Math.round(len / 8.5));
    for (let i = 0; i <= nS; i++) {
      const o = -len / 2 + (i / nS) * len;
      const uu = along ? w.u + o : w.u;
      const vv = along ? w.v : w.v + o;
      fbox(F, T, glass, uu, gy + wingH + 3.0, vv, 3.0, 3.0, 3.0, [0, 0.15, 0], cham);
      fspire(F, T, glass, uu, gy + wingH + 4.5, vv, 2.3, 5.6, [0, 0.18, 0]);
    }
    fpos(F, w.u, w.v, _fp);
    T.box('concrete', _fp[0], gy + wingH / 2, _fp[1], w.su, wingH + 1, w.sv, -F.yaw);
  }

  /**
   * ---- the tower ---------------------------------------------------------
   * Square in plan, because the four corner spires only read as a set if the
   * corners are the same corner. Set back onto the -v half of the block so the
   * plaza in front of it is a real forecourt rather than a slot.
   */
  const TU = 0;
  const TV = -10;
  const TW = 32;
  const floors = 42;
  const fh = 3.95;
  const shaftH = floors * fh;
  /**
   * THE SKIN IS A MIRROR, NOT A WINDOW, AND THE DIFFERENCE IS THE INTERIOR
   * BOX BEHIND IT. The first build of this tower used the Steel Tower's
   * recipe — a 1.24 m spandrel band per floor and `room_office` set 2 m back —
   * and photographed as a warm TAN shaft with a dark grid on it, because
   * `glass_sky` is transparent enough at 500 m to hand the whole elevation over
   * to the lit room behind. The building this is a portrait of is the opposite:
   * a reflective envelope with almost nothing legible behind it. So the
   * spandrel comes down to 0.62 m (a shadow line, not a band), and the room is
   * `room_mid` — dark — except on one floor in five, which is what makes the
   * night skyline read as occupied rather than as a lamp.
   */
  for (let f = 0; f < floors; f++) {
    const fy = gy + 0.7 + f * fh;
    fbox(F, T, mull, TU, fy + 0.31, TV, TW + 0.14, 0.62, TW + 0.14, [0.3, 0.3, 0.15]);
    fbox(F, T, glass, TU, fy + 0.62 + (fh - 0.62) / 2, TV, TW, fh - 0.62, TW, [0, 0.12, 0]);
    fbox(F, T, f % 5 === 2 ? 'room_lit_warm' : 'room_mid', TU, fy + 0.62 + (fh - 0.62) / 2, TV,
      TW - 2.4, fh - 1.2, TW - 2.4, [0, 0.1, f % 5 === 2 ? 0.12 : 0.5]);
  }
  // mullions, and the four corner piers that the corner spires stand on
  const nM = Math.round(TW / 2.7);
  for (let i = 0; i <= nM; i++) {
    const o = -TW / 2 + (i / nM) * TW;
    for (const sg of [-1, 1]) {
      fbox(F, T, mull, TU + o, gy + 0.7 + shaftH / 2, TV + sg * (TW / 2 + 0.12), 0.34, shaftH, 0.44, [0.35, 0.22, 0.1]);
      fbox(F, T, mull, TU + sg * (TW / 2 + 0.12), gy + 0.7 + shaftH / 2, TV + o, 0.44, shaftH, 0.34, [0.35, 0.22, 0.1]);
    }
  }
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      fbox(F, T, glass, TU + su * (TW / 2 - 1.5), gy + 0.7 + shaftH / 2, TV + sv * (TW / 2 - 1.5), 4.4, shaftH, 4.4, [0, 0.14, 0], cham);
    }
  }
  // the base: a stone arcade, so the tower meets the plaza with a colonnade
  fbox(F, T, stone, TU, gy + 3.4, TV, TW + 1.6, 5.4, TW + 1.6, [0.32, 0.44, 0.26], cham);
  for (let i = 0; i <= nM; i++) {
    const o = -TW / 2 + (i / nM) * TW;
    fbox(F, T, 'stone_warm', TU + o, gy + 3.4, TV + TW / 2 + 1.2, 1.15, 5.4, 1.15, [0.36, 0.46, 0.26], cham);
  }

  /**
   * ---- the crown: four corner spires and a taller one over the middle -----
   * This is the entire reason the building exists. The corner spires start on
   * the corner piers, so the vertical line runs unbroken from the plaza to the
   * tip; the central one is a third taller and sits on a short lantern, which
   * is what stops the five of them reading as one blunt cluster.
   */
  const top = gy + 0.7 + shaftH;
  fbox(F, T, stone, TU, top + 0.75, TV, TW + 1.5, 1.5, TW + 1.5, [0.45, 0.4, 0.22], cham);
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const cu = TU + su * (TW / 2 - 2.4);
      const cv = TV + sv * (TW / 2 - 2.4);
      fbox(F, T, glass, cu, top + 5.0, cv, 6.2, 8.5, 6.2, [0, 0.16, 0], cham);
      fbox(F, T, stone, cu, top + 9.5, cv, 7.0, 0.7, 7.0, [0.45, 0.4, 0.22], cham);
      fspire(F, T, glass, cu, top + 9.9, cv, 4.6, 19.0, [0, 0.2, 0]);
    }
  }
  fbox(F, T, glass, TU, top + 6.5, TV, 13.0, 11.5, 13.0, [0, 0.16, 0], cham);
  fbox(F, T, 'room_lit_warm', TU, top + 6.5, TV, 10.6, 9.0, 10.6, [0, 0.1, 0.5]);
  fbox(F, T, stone, TU, top + 12.6, TV, 14.4, 0.9, 14.4, [0.45, 0.4, 0.22], cham);
  fspire(F, T, glass, TU, top + 13.0, TV, 9.4, 27.0, [0, 0.2, 0]);
  fspire(F, T, 'alu_bright', TU, top + 39.0, TV, 0.5, 5.0, [0.4, 0.2, 0.1], 0.05);
  fbox(F, T, 'neon_red', TU, top + 42.4, TV, 0.8, 0.5, 0.8, [0, 0, 0]);

  /**
   * ---- the plaza ---------------------------------------------------------
   * Paved, with the obelisk the court is named for. Small: the wings are 13 m
   * deep and the tower takes the -v half, so what is left is about 30 x 22 m,
   * which is a courtyard rather than the "vast unfilled field" the critic
   * reported and the whole reason the wings exist.
   */
  const pv = TV + TW / 2 + 1.5;
  const pd = F.hz - t - pv;
  fbox(F, T, 'stone_grey', TU, gy + 0.78, pv + pd / 2, F.hx * 2 - 2 * t - 2, 0.24, Math.max(6, pd - 2), [0.5, 0.5, 0.3]);
  fspire(F, T, 'alu_bright', TU, gy + 0.9, pv + pd / 2, 1.1, 9.0, [0.4, 0.25, 0.1], 0.08);
  for (const su of [-1, 1]) {
    fbox(F, T, 'stone_warm', TU + su * 9, gy + 1.35, pv + pd / 2, 2.2, 0.9, 2.2, [0.45, 0.5, 0.3], cham);
  }

  // The tower's collision proxy. The wings emit their own above.
  fpos(F, TU, TV, _fp);
  T.box('concrete', _fp[0], gy + shaftH / 2, _fp[1], TW + 2, shaftH, TW + 2, -F.yaw);
}

// -------------------------------------------------------------- Steel Bowl --
/** A 60 000-seat bowl: raked deck, ring of piers, cantilever canopy, masts. */
function steelBowl(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const RA = 108;
  const RB = 86;
  const N = 56;
  const bowlH = 32;

  const pier = _sharedChamfer();
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const ca = Math.cos(am);
    const sa = Math.sin(am);
    const segW = ((Math.PI * 2) / N) * ((RA + RB) / 2) * 1.02;

    // outer wall: a pier and a recessed bay, all the way round
    box(T, 'precast', x + ca * RA, gy + bowlH / 2, z + sa * RB, 3.4, bowlH, 3.0, -am, [0.3, 0.45, 0.25], pier);
    box(T, 'concrete_dark', x + ca * (RA - 1.4), gy + bowlH / 2 - 1, z + sa * (RB - 1.4), segW * 0.72, bowlH - 3, 2.0, -am, [0.2, 0.55, 0.45]);
    // concourse glazing at ground level
    box(T, 'glass_plain', x + ca * (RA - 1.2), gy + 4.2, z + sa * (RB - 1.2), segW * 0.7, 6.4, 0.4, -am, [0, 0.2, 0]);
    box(T, 'room_lit_cool', x + ca * (RA - 2.4), gy + 4.2, z + sa * (RB - 2.4), segW * 0.7, 6.4, 0.4, -am, [0, 0.1, 0.4]);

    // the raked seating deck, as a wedge sloping in toward the pitch
    const inner = 0.46;
    const rise = bowlH - 9;
    const geo = new THREE.BufferGeometry();
    const p0 = [x + Math.cos(a0) * RA, z + Math.sin(a0) * RB];
    const p1 = [x + Math.cos(a1) * RA, z + Math.sin(a1) * RB];
    const q0 = [x + Math.cos(a0) * RA * inner, z + Math.sin(a0) * RB * inner];
    const q1 = [x + Math.cos(a1) * RA * inner, z + Math.sin(a1) * RB * inner];
    const pos = [p0[0], gy + rise, p0[1], p1[0], gy + rise, p1[1], q1[0], gy + 2.4, q1[1], q0[0], gy + 2.4, q0[1]];
    const col = [0.2, 0.35, 0.2, 0.2, 0.35, 0.2, 0.1, 0.5, 0.6, 0.1, 0.5, 0.6];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeVertexNormals();
    T.addOnce(i % 3 === 0 ? 'steel_green' : 'concrete_wall', geo, null);

    // canopy: a cantilever ring with a truss edge
    box(T, 'alu_dark', x + ca * (RA * 0.78), gy + bowlH + 5.5, z + sa * (RB * 0.78), segW * 0.98, 0.5, RA * 0.44, -am, [0.4, 0.3, 0.15]);
    box(T, 'steel_dark', x + ca * (RA + 1.2), gy + bowlH + 3.2, z + sa * (RB + 1.2), 0.55, 5.4, 0.55, -am, [0.4, 0.25, 0.12]);
    box(T, 'steel_dark', x + ca * (RA * 0.9), gy + bowlH + 4.4, z + sa * (RB * 0.9), 0.4, 0.4, RA * 0.34, -am, [0.4, 0.25, 0.12]);
  }

  // the pitch
  const pitch = new THREE.CircleGeometry(1, 40);
  pitch.rotateX(-Math.PI / 2);
  const pa = pitch.getAttribute('position');
  pitch.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  trs(_m, x, gy + 0.35, z, 0, RA * 0.44, 1, RB * 0.44);
  T.addOnce('render_green', pitch, _m, { masks: [0, 0.2, 0.1] });

  // floodlight masts
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const mx = x + Math.cos(a) * (RA + 6);
    const mz = z + Math.sin(a) * (RB + 6);
    cyl(T, 'steel_dark', mx, gy, mz, 0.75, 52, 10, [0.4, 0.3, 0.15], 0.4);
    box(T, 'alu_dark', mx, gy + 54, mz, 9, 5, 1.4, -a, [0.4, 0.2, 0.1], pier);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        box(T, 'neon_amber', mx + (c - 2.5) * 1.4 * Math.sin(-a), gy + 52.6 + r * 1.5, mz + (c - 2.5) * 1.4 * Math.cos(-a), 1.1, 1.1, 0.3, -a, [0, 0, 0]);
      }
    }
  }
  /**
   * COLLISION IS THE RING, NOT THE SITE.
   *
   * This used to be one 224 x 180 x 32 m box over the whole bowl, and it is
   * what `roadsweep.mjs` blamed for more impassable directions than anything
   * else in the city. Three consequences, all bad: the pitch and the concourse
   * were solid, so nothing could ever be inside the stadium; a single hull that
   * size cannot be dropped or trimmed by the kerb keep-out without deleting the
   * stadium's collision entirely; and it swallowed every road that crosses the
   * site — which, because `world` lays its district grids without reserving the
   * landmark sites, is three highway segments and an alley.
   *
   * A ring of per-segment hulls matching the piers is the same barrier where
   * there IS a wall, lets the keep-out remove only the segments a carriageway
   * runs through, and leaves the bowl enterable.
   */
  for (let i = 0; i < N; i++) {
    const am = ((i + 0.5) / N) * Math.PI * 2;
    const ca = Math.cos(am);
    const sa = Math.sin(am);
    const segW = ((Math.PI * 2) / N) * ((RA + RB) / 2) * 1.02;
    T.box('concrete', x + ca * (RA - 0.7), gy + bowlH / 2, z + sa * (RB - 0.7),
      segW * 1.02, bowlH, 3.4, -am);
  }
}

// -------------------------------------------------------- Old Blast Furnace --

/**
 * THE MILL'S FIVE STACKS, AS OFFSETS FROM THE LANDMARK CENTRE.
 *
 * The geometry below is emitted FROM this table — the brick stacks and the
 * furnace crown are both built by reading it — so it cannot describe a stack
 * that is not there, and a stack cannot move without it moving.
 *
 * IT IS EXPORTED BECAUSE SOMETHING HAS TO KNOW WHERE THE SMOKE COMES OUT, AND
 * IT IS NOT THIS SUBSYSTEM.
 *
 * `fx` owns plumes; `buildings` owns stacks. `fx` cannot import this (rule 2)
 * and there is no Object3D to hang `userData.fxSmoke` on either, because every
 * landmark is merged into a per-tile static batch and comes out of
 * `TileBuilder.build()` as a handful of meshes at the world origin — which is
 * why the smoke contract in `src/fx/ambience.js` has had a documented tag
 * route and ZERO producers since it was written. So `fx` carries the same five
 * anchors, and `src/fx/plumeprobe.mjs` imports BOTH and fails the moment they
 * disagree by more than a few centimetres. A probe may reach across
 * subsystems; a subsystem may not. The real fix — an emitter node the tile
 * builder can carry, so the tag route works — is `src/buildings/tile.js`'s to
 * make, and this table is what it would be built from.
 *
 *   dx, dz   metres from the landmark centre
 *   top      metres above the landmark's ground, i.e. where the flue opens
 *   r        flue radius there, which is the plume's birth radius
 *   kind     'smoke' — dirty industrial | 'steam' — a hot-blast stove venting
 */
const FURNACE_CROWN_H = 10;
/** base radius, top radius, height. The three brick stacks in the ore yard. */
const MILL_BRICK = [
  { dx: -34, dz: -20, rBase: 2.6, r: 2.00, top: 44 },
  { dx: -43, dz: -25, rBase: 2.3, r: 1.75, top: 38 },
  { dx: -52, dz: -30, rBase: 2.0, r: 1.50, top: 32 },
];
/** The four hot-blast stoves. Only the first vents into the frame. */
const MILL_STOVES = [
  { dx: 20, dz: -12 }, { dx: 35, dz: -12 },
  { dx: 20, dz: 4 }, { dx: 35, dz: 4 },
];
const MILL_STOVE_VENT = { top: 57, r: 1.1 };

export const MILL_STACKS = [
  { dx: 0, dz: 0, top: 66, r: 3.4, kind: 'smoke' },
  ...MILL_BRICK.map((b) => ({ dx: b.dx, dz: b.dz, top: b.top, r: b.r, kind: 'smoke' })),
  {
    dx: MILL_STOVES[0].dx, dz: MILL_STOVES[0].dz,
    top: MILL_STOVE_VENT.top, r: MILL_STOVE_VENT.r, kind: 'steam',
  },
];

/**
 * The mill. A blast furnace is a vertical machine: the stack, four hot-blast
 * stoves beside it, the dust catcher, the skip hoist running up the side and a
 * conveyor bridge out to the ore yard. Rust everywhere.
 */
function blastFurnace(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const crown = MILL_STACKS[0];

  // --- the furnace stack ---
  cyl(T, 'rust_deep', x, gy, z, 6.5, 12, 20, [0.7, 0.6, 0.3]);
  cyl(T, 'rust', x, gy + 12, z, 7.4, 16, 20, [0.75, 0.55, 0.3], 5.4);
  cyl(T, 'rust_deep', x, gy + 28, z, 5.4, 20, 20, [0.7, 0.6, 0.3], 4.4);
  cyl(T, 'rust', x, gy + 48, z, 4.4, 8, 20, [0.7, 0.5, 0.25], 3.2);
  // The crown is built DOWN from the published flue height, so the smoke and
  // the steel cannot end up at two different altitudes.
  cyl(T, 'corrugated_rust', x + crown.dx, gy + crown.top - FURNACE_CROWN_H, z + crown.dz,
    crown.r, FURNACE_CROWN_H, 16, [0.75, 0.6, 0.3]);
  // bustle pipe
  const ring = new THREE.TorusGeometry(7.6, 0.85, 8, 24);
  ring.rotateX(Math.PI / 2);
  ring.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(ring.getAttribute('position').count * 3).fill(0.4), 3)
  );
  trs(_m, x, gy + 20, z, 0, 1, 1, 1);
  T.addOnce('rust_deep', ring, _m);
  // tuyere downcomers
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    box(T, 'rust', x + Math.cos(a) * 7.0, gy + 16, z + Math.sin(a) * 7.0, 0.75, 8, 0.75, -a, [0.7, 0.6, 0.3], _sharedChamfer());
  }

  // --- four hot-blast stoves ---
  for (let i = 0; i < 4; i++) {
    const sx = x + MILL_STOVES[i].dx;
    const sz = z + MILL_STOVES[i].dz;
    cyl(T, 'rust_deep', sx, gy, sz, 4.6, 40, 18, [0.7, 0.55, 0.3]);
    cyl(T, 'rust', sx, gy + 40, sz, 4.6, 5.5, 18, [0.7, 0.5, 0.25], 2.2);
    cyl(T, 'rust_deep', sx, gy + 45, sz, MILL_STOVE_VENT.r,
      MILL_STOVE_VENT.top - 45, 10, [0.7, 0.5, 0.25]);
    for (let r = 0; r < 5; r++) {
      const rg = cylinderY(4.75, 0.5, 18, { open: true });
      trs(_m, sx, gy + 5 + r * 8, sz, 0, 1, 1, 1);
      T.addOnce('rust', rg, _m, { masks: [0.85, 0.55, 0.3] });
    }
    T.putS(Kit.ladder(lib, 'rust'), sx + 4.7, gy, sz, -Math.PI / 2, 1, 44, 1);
  }

  // --- dust catcher ---
  cyl(T, 'rust', x - 20, gy + 8, z + 6, 5.2, 14, 16, [0.75, 0.6, 0.3]);
  cyl(T, 'rust_deep', x - 20, gy + 2, z + 6, 5.2, 6, 16, [0.75, 0.6, 0.3], 1.4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.7;
    box(T, 'rust_deep', x - 20 + Math.cos(a) * 4, gy + 1, z + 6 + Math.sin(a) * 4, 0.7, 2, 0.7, 0, [0.8, 0.6, 0.3]);
  }
  // downcomer from the stack top to the dust catcher
  box(T, 'rust', x - 10.5, gy + 44, z + 3, 22, 2.4, 2.4, 0, [0.75, 0.55, 0.3], _sharedChamfer());
  box(T, 'rust', x - 20, gy + 32, z + 6, 2.4, 24, 2.4, 0, [0.75, 0.55, 0.3], _sharedChamfer());

  // --- cast house ---
  const chW = 34;
  const chD = 20;
  box(T, 'corrugated_rust', x - 4, gy + 7, z + 24, chW, 14, chD, 0, [0.6, 0.65, 0.3], _sharedChamfer());
  for (let i = 0; i < 5; i++) {
    box(T, 'rust_deep', x - 4 - chW / 2 + (i / 4) * chW, gy + 15.6, z + 24, 1.1, 3.2, chD + 1, 0, [0.8, 0.6, 0.3]);
  }
  box(T, 'roof_metal', x - 4, gy + 14.4, z + 24, chW + 1.5, 0.7, chD + 1.5, 0, [0.5, 0.6, 0.3]);

  // --- skip hoist: the inclined bridge up the side of the furnace ---
  const hl = 46;
  const ang = 0.72;
  for (const s of [-1, 1]) {
    box(T, 'rust_deep', x - 16, gy + 20, z - 18 + s * 1.6, 2.0, 1.0, hl, 0, [0.8, 0.6, 0.3], _sharedChamfer());
  }
  trs(_m, x - 15, gy + 22, z - 20, 0, 1, 1, 1);
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    T.put(Kit.truss(lib, 'rust_deep'), x - 15 + t * 12, gy + 6 + t * 34, z - 34 + t * 22, Math.PI / 2, 1);
  }

  // --- stacks and gantries ---
  for (const b of MILL_BRICK) {
    cyl(T, 'brick_dark', x + b.dx, gy, z + b.dz, b.rBase, b.top, 14, [0.6, 0.65, 0.35], b.r);
  }
  for (let i = 0; i < 8; i++) {
    T.put(Kit.truss(lib, 'rust'), x - 44 + i * 4, gy + 15, z + 40, 0, 1);
    box(T, 'rust_deep', x - 44 + i * 4, gy + 7.5, z + 40, 1.2, 15, 1.2, 0, [0.85, 0.6, 0.3]);
  }
  // silos in the ore yard
  for (let i = 0; i < 4; i++) {
    T.putS(Kit.silo(lib, 'corrugated_rust'), x + 46, gy, z + 20 + i * 9.5, 0, 4.2, 18, 4.2);
  }

  /**
   * COLLISION. The stack and the cast house were the only two things here with
   * a shell, so a man walked through four 40 m hot-blast stoves, the dust
   * catcher, three brick stacks and the ore-yard silos as if they were smoke —
   * measured by `solidprobe.mjs` at 10 of 14 bearings sealed. Every vessel
   * below is a solid steel pressure shell in the picture and gets one box; the
   * gantries, the skip hoist and the tuyere pipework deliberately do NOT,
   * because you can walk under all three and a proxy there would be an
   * invisible wall across the yard.
   */
  T.box('metal', x, gy + 30, z, 18, 60, 18);
  T.box('metal', x - 4, gy + 7, z + 24, chW, 14, chD);
  for (const s of MILL_STOVES) T.box('metal', x + s.dx, gy + 22.5, z + s.dz, 8.4, 45, 8.4);
  T.box('metal', x - 20, gy + 9, z + 6, 9.4, 20, 9.4);
  for (const b of MILL_BRICK) {
    T.box('concrete', x + b.dx, gy + b.top / 2, z + b.dz, b.rBase * 1.8, b.top, b.rBase * 1.8);
  }
  for (let i = 0; i < 4; i++) T.box('metal', x + 46, gy + 9, z + 20 + i * 9.5, 7.6, 18, 7.6);
}

// --------------------------------------------------------- Duquesne Incline --
/**
 * A working funicular. Two station houses, a timber trestle up the cliff and
 * two cars that pass each other in the middle — the car meshes are static
 * here; `world` or `game` can drive them along the track later.
 *
 * THIS RAN THE WRONG WAY UP THE WRONG HILL.
 *
 * The old code took ONE ground sample at the lower station and then
 * extrapolated a straight ramp of a hardcoded `rise = 122` over `run = 168` in
 * the −z direction, with bents standing on fixed 4–7 m legs. At this landmark's
 * authored position (−488, 296) the hill is at INCREASING z — the ground climbs
 * from y=8.1 at z=300 to y=104.4 at z=480 — so the trestle set off in exactly
 * the opposite direction, straight out over the Monongahela. Measured along its
 * own run: t=0.63 already over water, and by the top of the run the track sat
 * 141.6 m above the terrain and 130 m above open water.
 *
 * That single bug produced all three artifacts:
 *   - "a bridge rendered as disconnected floating truss frames with no deck" —
 *     the bents, every 9 m, on stub legs, over the river;
 *   - two cables hanging in mid-air — the rails;
 *   - "floating cubes in the sky" — the upper station and the two cars, 130 m
 *     up over the water.
 * Hiding `buildings.root` removed all of it and left a clean `world` bridge, so
 * the earlier conclusion that "the bridges are `world`'s" was right about the
 * bridge and wrong about what was floating over it.
 *
 * Now: the uphill bearing is FOUND by probing the terrain rather than assumed,
 * the rise is whatever the hill actually does, and every bent stands on the
 * real ground under it. A funicular on a bench-shaped bluff cannot be a single
 * straight chord — a chord across this one is a 40 m stilt in the middle and
 * buried 10 m further up — so the track is a graded polyline that follows the
 * hill, which is also what a timber trestle is.
 */
/**
 * FALLBACK track solve for the two callers that have no `world` to ask: the
 * standalone `preview.html` and `prewarmMaterials`' scratch build (which
 * passes a flat groundAt — its geometry only exists to touch materials).
 *
 * The SHIPPED path never runs this. `world` solves the descriptor once in
 * `src/world/incline.js` (`publishInclineTracks`, called from
 * `WorldSystem.init` after `orientLandmarkSites`) and publishes it as
 * `world.landmarks[].funicular.track`; `adoptLandmarkSites` copies the
 * reference and `incline()` emits from it, so the trestle, the rails and the
 * moving cars all read the same arrays. This copy of the math exists ONLY so
 * the preview keeps working without a world, and it reproduces the historical
 * behaviour verbatim — including the bearing scan `netgen.orientLandmarkSites`
 * superseded (see the long note there for why the scan must not be primary).
 */
function _fallbackInclineTrack(lm, gy, groundAt) {
  const x = lm.x;
  const z = lm.z;
  const RUN = lm.uphill?.run ?? 180;
  const MIN_CLEAR = 2.2;
  const MAX_LEG = 15;

  let dirX = lm.uphill?.dir?.[0] ?? 0;
  let dirZ = lm.uphill?.dir?.[1] ?? 0;
  if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || (dirX === 0 && dirZ === 0)) {
    let bestScore = -Infinity;
    dirX = 0;
    dirZ = 1;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      let score = 0;
      let prev = gy;
      for (let k = 1; k <= 8; k++) {
        const h = groundAt(x + sx * (k / 8) * RUN, z + sz * (k / 8) * RUN);
        // Reward climbing, punish any descent — an incline goes UP the whole way.
        score += (h - prev) - Math.max(0, prev - h) * 3;
        prev = h;
      }
      if (score > bestScore) {
        bestScore = score;
        dirX = sx;
        dirZ = sz;
      }
    }
  }

  // The track profile: one node per bent, riding MIN_CLEAR above the ground and
  // then smoothed, so the rails read as a graded ramp rather than a terrain
  // sample. Monotonic, because a funicular does not go back downhill.
  const bents = Math.max(6, Math.round(RUN / 9));
  const px = new Array(bents + 1);
  const pz = new Array(bents + 1);
  const gnd = new Array(bents + 1);
  const py = new Array(bents + 1);
  for (let i = 0; i <= bents; i++) {
    const t = i / bents;
    px[i] = x + dirX * t * RUN;
    pz[i] = z + dirZ * t * RUN;
    gnd[i] = groundAt(px[i], pz[i]);
    py[i] = gnd[i] + MIN_CLEAR;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < bents; i++) py[i] = (py[i - 1] + py[i] * 2 + py[i + 1]) * 0.25;
    for (let i = 0; i <= bents; i++) {
      if (py[i] < gnd[i] + MIN_CLEAR) py[i] = gnd[i] + MIN_CLEAR;
      if (i && py[i] < py[i - 1]) py[i] = py[i - 1];
      if (py[i] > gnd[i] + MAX_LEG) py[i] = gnd[i] + MAX_LEG;
    }
  }
  py[0] = gy + MIN_CLEAR;

  const rx = dirZ;
  const rz = -dirX;
  const yaw = Math.atan2(dirX, dirZ);
  const at = (r, a, out) => {
    out = out ?? { x: 0, z: 0 };
    out.x = x + rx * r + dirX * a;
    out.z = z + rz * r + dirZ * a;
    return out;
  };
  const trackY = (a) => {
    const f = Math.max(0, Math.min(bents, (a / RUN) * bents));
    const i = Math.min(bents - 1, Math.floor(f));
    return py[i] + (py[i + 1] - py[i]) * (f - i);
  };
  const pitchAt = (a, h = 4) => -Math.atan2(trackY(a + h) - trackY(a - h), 2 * h);
  return { x, z, dirX, dirZ, rx, rz, run: RUN, yaw, bents, px, pz, gnd, py, gauge: 3.2, carLift: 1.2, at, trackY, pitchAt };
}

function incline(T, lib, lm, rng, gy, groundAt) {
  const x = lm.x;
  const z = lm.z;

  /**
   * THE TRACK IS NOT THIS FUNCTION'S DECISION ANY MORE. `world` publishes the
   * solved descriptor (`src/world/incline.js`) and everything here EMITS from
   * its arrays — the same arrays the `funicular` subsystem samples every frame
   * to move the two cars. The fallback solve only runs where no world exists
   * (preview, prewarm); see `_fallbackInclineTrack`.
   */
  const trk = lm.funicular?.track ?? _fallbackInclineTrack(lm, gy, groundAt);
  const { px, pz, gnd, py, bents } = trk;
  const RUN = trk.run;
  /** Yaw that puts a box's local +Z along the climb. */
  const yawUp = trk.yaw;
  /** World point `r` metres right of the track and `a` metres up the run. */
  const at = (r, a) => trk.at(r, a);
  /** Track height at along-distance `a`, interpolated between bents. */
  const trackY = trk.trackY;

  /**
   * IDENTITY PASS — the station is 1877 carpentry, not a shed.
   *
   * Both stations were a masonry-or-timber box with a shingle lid and nothing
   * else, and at 40 m that is what they read as. What makes a funicular station
   * recognisable is the SECTION at its edges: a stone plinth the hillside is
   * cut back to, a wainscot band with a moulding on top of it, corner boards
   * standing proud of the cladding, and an eave fascia deep enough to throw a
   * shadow line across the whole elevation.
   *
   * Every piece below is a box on a surface key the tile is ALREADY drawing
   * (`tile.js` merges by key, so a station's twelve extra boxes cost zero extra
   * draw calls — see ARCHITECTURE.md rule 7), and the keys are the palette's,
   * so the woodwork weathers with the district.
   */
  // lower station: stone plinth, sooted brick body, deep eave
  box(T, 'stone_base', x, gy + 0.9, z, 16.8, 1.8, 12.8, yawUp, [0.5, 0.6, 0.4], _sharedChamfer());
  box(T, 'brick_dark', x, gy + 5.6, z, 16, 9.4, 12, yawUp, [0.4, 0.5, 0.3], _sharedChamfer());
  // Bottle-green glazed dado to shoulder height. Every transit building of the
  // period had one for the same reason the market has one: glaze hoses clean.
  box(T, 'brick_glazed_green', x, gy + 3.0, z, 16.2, 2.4, 12.2, yawUp, [0.3, 0.5, 0.3], _sharedChamfer());
  // string course at first-floor level — the horizontal that gives it a storey
  box(T, 'stone_grey', x, gy + 5.4, z, 16.5, 0.34, 12.5, yawUp, [0.45, 0.55, 0.3], _sharedChamfer());
  box(T, 'trim_white', x, gy + 10.15, z, 17.2, 0.55, 13.2, yawUp, [0.5, 0.45, 0.25], _sharedChamfer());
  box(T, 'roof_shingle', x, gy + 10.6, z, 18, 1.2, 14, yawUp, [0.4, 0.5, 0.25], _sharedChamfer());
  box(T, 'trim_red', x, gy + 11.6, z, 6, 1.4, 6, yawUp, [0.5, 0.4, 0.2], _sharedChamfer());
  for (const s of [-1, 1]) {
    const q = at(s * 4, -6.1);
    box(T, 'glass_plain', q.x, gy + 5.5, q.z, 4.5, 5, 0.2, yawUp, [0, 0.25, 0]);
    const q2 = at(s * 4, -5.4);
    box(T, 'room_lit_warm', q2.x, gy + 5.5, q2.z, 4.5, 5, 0.2, yawUp, [0, 0.1, 0.4]);
    // stone jambs down each side of the opening
    for (const j of [-1, 1]) {
      const qj = at(s * 4 + j * 2.55, -6.1);
      box(T, 'stone_grey', qj.x, gy + 5.5, qj.z, 0.5, 5.4, 0.34, yawUp, [0.4, 0.5, 0.3]);
    }
  }

  // upper station, standing on the ground the track actually reaches
  const up = at(0, RUN);
  const ux = up.x;
  const uz = up.z;
  const uy = gnd[bents];
  box(T, 'stone_base', ux, uy + 0.8, uz, 18.6, 1.6, 14.6, yawUp, [0.5, 0.6, 0.4], _sharedChamfer());
  box(T, 'timber_dark', ux, uy + 6.4, uz, 18, 11.2, 14, yawUp, [0.5, 0.5, 0.3], _sharedChamfer());
  // painted wainscot to sill height, with its cap moulding — the one band that
  // makes board cladding read as carpentry rather than as a dark box
  box(T, 'timber', ux, uy + 3.0, uz, 18.25, 3.4, 14.25, yawUp, [0.55, 0.6, 0.35], _sharedChamfer());
  box(T, 'trim_white', ux, uy + 4.78, uz, 18.5, 0.28, 14.5, yawUp, [0.5, 0.45, 0.25], _sharedChamfer());
  // corner boards, proud of the cladding on all four arrises
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const c = at(sx * 9.05, RUN + sz * 7.05);
      box(T, 'trim_white', c.x, uy + 6.4, c.z, 0.5, 11.2, 0.5, yawUp, [0.6, 0.5, 0.3]);
    }
  }
  // lit waiting room behind glass on the valley elevation
  for (const s of [-1, 1]) {
    const q = at(s * 4.4, RUN - 7.05);
    box(T, 'glass_plain', q.x, uy + 7.2, q.z, 5.0, 4.2, 0.2, yawUp, [0, 0.25, 0]);
    const q2 = at(s * 4.4, RUN - 6.4);
    box(T, 'room_lit_warm', q2.x, uy + 7.2, q2.z, 5.0, 4.2, 0.2, yawUp, [0, 0.1, 0.4]);
  }
  box(T, 'trim_red', ux, uy + 12.15, uz, 19.2, 0.6, 15.2, yawUp, [0.5, 0.45, 0.25], _sharedChamfer());
  box(T, 'roof_shingle', ux, uy + 12.6, uz, 20, 1.4, 16, yawUp, [0.4, 0.5, 0.25], _sharedChamfer());
  box(T, 'trim_white', ux, uy + 13.8, uz, 4.5, 3.2, 4.5, yawUp, [0.5, 0.4, 0.2], _sharedChamfer());

  // trestle: a bent every 9 m, each one standing on the ground beneath IT
  for (let i = 0; i <= bents; i++) {
    const a = (i / bents) * RUN;
    const top = py[i];
    const gh = Math.max(1.2, top - gnd[i]);
    for (const s of [-1, 1]) {
      const q = at(s * 3.2, a);
      box(T, 'timber_dark', q.x, top - gh / 2, q.z, 0.55, gh, 0.55, yawUp, [0.7, 0.6, 0.35]);
    }
    const c = at(0, a);
    box(T, 'timber_dark', c.x, top - gh + 0.3, c.z, 7.4, 0.5, 0.5, yawUp, [0.7, 0.6, 0.35]);
  }
  /**
   * Rails and stringers as ONE BOX PER BAY rather than one long scaled box.
   * The track is a polyline now, and a single box across a bench-shaped bluff
   * is exactly the "two cables hanging in mid-air" the critics photographed.
   */
  const bay = RUN / bents;
  for (let i = 0; i < bents; i++) {
    const a0 = i * bay;
    const a1 = a0 + bay;
    const y0 = py[i];
    const y1 = py[i + 1];
    const seg = Math.hypot(bay, y1 - y0);
    const pitch = -Math.atan2(y1 - y0, bay);
    const mid = at(0, (a0 + a1) * 0.5);
    for (const s of [-1, 1]) {
      const q = at(s * 3.2, (a0 + a1) * 0.5);
      const rm = new THREE.Matrix4()
        .makeTranslation(q.x, (y0 + y1) * 0.5 + 0.2, q.z)
        .multiply(new THREE.Matrix4().makeRotationY(yawUp))
        .multiply(new THREE.Matrix4().makeRotationX(pitch))
        .multiply(new THREE.Matrix4().makeScale(0.34, 0.34, seg));
      T.add('steel_light', _sharedBox(), rm, { masks: [0.9, 0.3, 0.1] });
    }
    // longitudinal stringer under the deck
    const sm = new THREE.Matrix4()
      .makeTranslation(mid.x, (y0 + y1) * 0.5 - 0.6, mid.z)
      .multiply(new THREE.Matrix4().makeRotationY(yawUp))
      .multiply(new THREE.Matrix4().makeRotationX(pitch))
      .multiply(new THREE.Matrix4().makeScale(0.4, 0.4, seg));
    T.add('timber', _sharedChamfer(), sm, { masks: [0.7, 0.6, 0.35] });
  }
  // sleepers
  for (let i = 0; i < bents * 3; i++) {
    const a = (i / (bents * 3)) * RUN;
    const q = at(0, a);
    box(T, 'timber_dark', q.x, trackY(a), q.z, 8, 0.22, 0.5, yawUp, [0.8, 0.7, 0.4]);
  }

  /**
   * NO STATIC CARS. Two counterweighted cars used to be baked in here,
   * frozen mid-pass at t = 0.34 and 0.66. They are now LIVE: the `funicular`
   * subsystem (`src/vehicles/funicular.js`) builds the red-and-yellow cars
   * and runs them up and down this exact track every frame, sampling the same
   * published descriptor these rails were just emitted from. Baking a third
   * pair here would put ghost cars inside the moving ones.
   */

  T.box('wood', x, gy + 5, z, 16, 10, 12);
  T.box('wood', ux, uy + 6, uz, 18, 12, 14);
}

// ------------------------------------------------------- The Point Fountain --
/** A 60 m basin, a raised plinth and a nozzle ring, with a granite apron. */
function pointFountain(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const R = 30;

  /**
   * IDENTITY PASS — the basin is granite masonry, and it is WET.
   *
   * The apron, the wall and the coping were one smooth concrete family, so the
   * whole thing read as a poured kerb. Three changes, all material and all
   * free: the apron becomes laid paving (`precast` carries real cast joints),
   * the wall becomes warm ashlar, and — the one that actually sells it — a
   * darkened ring sits at the waterline, because the single most recognisable
   * thing about any working fountain basin is the tide mark of algae and lime
   * where the water has stood against the stone for forty years.
   */
  const apron = new THREE.RingGeometry(R, R + 14, 64, 1);
  apron.rotateX(-Math.PI / 2);
  apron.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(apron.getAttribute('position').count * 3).fill(0.25), 3)
  );
  trs(_m, x, gy + 0.06, z, 0, 1, 1, 1);
  T.addOnce('precast', apron, _m);

  // basin wall
  const wall = cylinderY(R, 1.1, 64, { open: true });
  trs(_m, x, gy + 0.55, z, 0, 1, 1, 1);
  T.addOnce('stone_warm', wall, _m, { masks: [0.55, 0.6, 0.3] });
  // the waterline stain, 6 cm proud so it catches its own shadow
  const tide = cylinderY(R + 0.06, 0.34, 64, { open: true });
  trs(_m, x, gy + 0.74, z, 0, 1, 1, 1);
  T.addOnce('stone_soot', tide, _m, { masks: [0.7, 0.95, 0.55] });
  const cap = new THREE.TorusGeometry(R, 0.34, 8, 64);
  cap.rotateX(Math.PI / 2);
  cap.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(cap.getAttribute('position').count * 3).fill(0.45), 3)
  );
  trs(_m, x, gy + 1.12, z, 0, 1, 1, 1);
  T.addOnce('stone_grey', cap, _m);

  // water plane
  const water = new THREE.CircleGeometry(R - 0.4, 64);
  water.rotateX(-Math.PI / 2);
  water.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(water.getAttribute('position').count * 3), 3)
  );
  trs(_m, x, gy + 0.75, z, 0, 1, 1, 1);
  T.addOnce('glass_sky', water, _m, { masks: [0, 0.1, 0] });

  // centre plinth and nozzle
  cyl(T, 'stone_grey', x, gy + 0.4, z, 6.5, 1.6, 32, [0.5, 0.55, 0.3]);
  cyl(T, 'stone_warm', x, gy + 2.0, z, 4.2, 1.2, 32, [0.5, 0.55, 0.3], 3.4);
  cyl(T, 'alu_bright', x, gy + 3.2, z, 0.55, 2.6, 12, [0.5, 0.25, 0.1], 0.3);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    cyl(T, 'alu_bright', x + Math.cos(a) * 5.4, gy + 1.9, z + Math.sin(a) * 5.4, 0.11, 0.55, 6, [0.6, 0.3, 0.1]);
  }
  // bollard ring and benches
  const bol = Kit.bollard(lib, 'steel_dark');
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    T.put(bol, x + Math.cos(a) * (R + 12), gy, z + Math.sin(a) * (R + 12), 0, 1);
  }
  T.box('concrete', x, gy + 0.55, z, R * 2, 1.1, R * 2);
}

// ------------------------------------------------------------ Strip Market --
/**
 * A market shed: a long steel-trussed hall open on both sides, a brick head
 * building at one end, and a row of awninged stalls down each side.
 */
/** Market hall: length, width, eaves. Shared with `MARKET_GRIDDLES` below. */
const MKT_L = 96;
const MKT_W = 30;
const MKT_H = 11;
const MKT_BAYS = Math.round(MKT_L / 6);
/** Half-width of a stall counter's centreline off the hall's axis. */
const MKT_STALL_X = MKT_W / 2 - 2.4;
/** Centre of stall bay `i`, in metres from the landmark centre along z. */
const mktBayZ = (i) => -MKT_L / 2 + ((i + 0.5) / MKT_BAYS) * MKT_L;

/**
 * TWO GRIDDLES IN THE MARKET, AS OFFSETS FROM THE LANDMARK CENTRE.
 *
 * Same contract and same reason as `MILL_STACKS` — `fx` carries the matching
 * anchors and `src/fx/plumeprobe.mjs` fails if they drift. `top` is the height
 * of a hot plate over the counter, which is `gy + 1.86` (the counter top the
 * stall loop below builds) plus half a metre of stove.
 *
 * These are the cheap half of "the city produces something": a food stall is
 * two emitters and it puts moving, lit, wind-sheared white steam at head
 * height in the one landmark the player walks THROUGH rather than past.
 */
export const MARKET_GRIDDLES = [
  { dx: -MKT_STALL_X, dz: mktBayZ(6), top: 2.36 },
  { dx: MKT_STALL_X, dz: mktBayZ(11), top: 2.36 },
];

function stripMarket(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const L = MKT_L;
  const W = MKT_W;
  const H = MKT_H;

  /**
   * Head building. IDENTITY PASS — a produce terminal's street elevation is
   * three materials stacked in the order the trade needed them: a rock-faced
   * stone base that survives a handcart, a GLAZED BRICK course at eye level
   * because glaze washes down and the wholesalers had to hose the frontage,
   * and common red brick above. The glazed band is the detail that says
   * "market" from the far pavement, and it is the one surface on the elevation
   * that comes back wet-looking under a low sun.
   */
  box(T, 'stone_base', x, gy + 1.1, z - L / 2 - 8, W + 6.4, 2.2, 16.4, 0, [0.5, 0.6, 0.4], _sharedChamfer());
  box(T, 'brick_glazed', x, gy + 3.5, z - L / 2 - 8, W + 6.2, 2.6, 16.2, 0, [0.3, 0.45, 0.25], _sharedChamfer());
  box(T, 'brick_red', x, gy + 9.4, z - L / 2 - 8, W + 6, 9.2, 16, 0, [0.35, 0.5, 0.3], _sharedChamfer());
  box(T, 'stone_grey', x, gy + 14.4, z - L / 2 - 8, W + 8, 1.1, 18, 0, [0.5, 0.5, 0.3], _sharedChamfer());
  for (let i = 0; i < 5; i++) {
    const px = x - 12 + i * 6;
    box(T, 'glass_grimy', px, gy + 8.5, z - L / 2 - 0.2, 3.4, 4.2, 0.3, 0, [0, 0.3, 0]);
    box(T, 'room_dark', px, gy + 8.5, z - L / 2 - 0.9, 3.4, 4.2, 0.3, 0, [0, 0.1, 0.5]);
    // stone head over each opening — the lintel that makes it a punched window
    box(T, 'stone_grey', px, gy + 10.85, z - L / 2 - 0.15, 4.2, 0.5, 0.42, 0, [0.45, 0.5, 0.3]);
  }
  box(T, 'sign_board', x, gy + 12.4, z - L / 2 - 0.1, 20, 2.4, 0.5, 0, [0.5, 0.5, 0.3], _sharedChamfer());
  T.putS(Kit.signFace(lib, 'neon_amber'), x, gy + 12.4, z - L / 2 + 0.25, 0, 16, 1.4, 1);

  // the hall: portal frames every 6 m
  const bays = MKT_BAYS;
  for (let i = 0; i <= bays; i++) {
    const pz = z - L / 2 + (i / bays) * L;
    for (const s of [-1, 1]) {
      box(T, 'steel_green', x + s * (W / 2), gy + H / 2, pz, 0.7, H, 0.7, 0, [0.6, 0.5, 0.25], _sharedChamfer());
      box(T, 'steel_green', x + s * (W / 4), gy + H + 1.3, pz, W / 2, 0.4, 0.4, 0, [0.6, 0.4, 0.2]);
    }
    T.putS(Kit.truss(lib, 'steel_green'), x, gy + H, pz, 0, W / 8.1, 1, 1);
  }
  // roof: two pitches with a raised monitor
  for (const s of [-1, 1]) {
    const rm = new THREE.Matrix4()
      .makeTranslation(x + s * (W / 4), gy + H + 2.5, z)
      .multiply(new THREE.Matrix4().makeRotationZ(s * 0.16))
      .multiply(new THREE.Matrix4().makeScale(W / 2 + 1.5, 0.3, L + 2));
    T.add('roof_metal', _sharedBox(), rm, { masks: [0.45, 0.5, 0.25] });
  }
  box(T, 'roof_metal', x, gy + H + 4.6, z, 6, 0.3, L, 0, [0.45, 0.5, 0.25]);
  for (const s of [-1, 1]) {
    box(T, 'glass_grimy', x + s * 3, gy + H + 3.6, z, 0.3, 2, L, 0, [0, 0.35, 0]);
  }

  // stalls down both sides
  const awn = Kit.awning(lib, rng.pick(['awning_canvas', 'awning_green', 'awning_navy']));
  const awnF = Kit.awningFrame(lib, 'steel_dark');
  for (let i = 0; i < bays; i++) {
    const pz = z + mktBayZ(i);
    for (const s of [-1, 1]) {
      const sx = x + s * MKT_STALL_X;
      box(T, 'timber', sx, gy + 0.9, pz, 3.2, 1.8, 4.6, 0, [0.7, 0.6, 0.3], _sharedChamfer());
      box(T, 'timber_dark', sx, gy + 1.86, pz, 3.6, 0.14, 5.0, 0, [0.75, 0.6, 0.3]);
      const rot = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      T.putS(awn, sx - s * 1.8, gy + 3.4, pz, rot, 4.6, 1, 1);
      T.putS(awnF, sx - s * 1.8, gy + 3.4, pz, rot, 4.6, 1, 1);
      if ((i + (s > 0 ? 0 : 1)) % 3 === 0) {
        T.putS(Kit.signFace(lib, rng.pick(['neon_amber', 'neon_teal', 'neon_red'])), sx - s * 1.6, gy + 4.2, pz, rot, 2.6, 0.6, 1);
      }
    }
  }
  T.box('concrete', x, gy + 7, z - L / 2 - 8, W + 6, 14, 16);
  for (let i = 0; i <= bays; i++) {
    const pz = z - L / 2 + (i / bays) * L;
    for (const s of [-1, 1]) T.box('metal', x + s * (W / 2), gy + H / 2, pz, 0.7, H, 0.7);
  }
}

/* ==========================================================================
 * OAKLAND AND THE SOUTH SIDE — appended 2026-08, lines 1017+.
 *
 * Three sites, none of which overlaps anything above: `lm_cathedral` at
 * (508, 24) and `lm_ironwood` at (676, 164) are in OAKLAND, `lm_colorpark` at
 * (306, 654) is on the Monongahela's south bank in the SOUTH SIDE. Every
 * coordinate is read off the entry rather than written here, so
 * `adoptLandmarkSites` moves them all.
 *
 * WHY THESE ARE LANDMARKS AND NOT LOTS. A generated lot is subdivided out of a
 * block, and a block is what is left between four streets — which is exactly
 * the wrong shape for a quad, a park or a strip of river bank. Being in
 * `plan.LANDMARKS` buys three things that cannot be had any other way: the road
 * network is kept `LANDMARK_RESERVE` metres off the site (`netgen`), a ring
 * road is laid on the isoline instead (`landmarkRings`), and `landmarkClaims`
 * refuses to subdivide a lot into it. `src/world/lmsweep.mjs` gates all three.
 * ======================================================================== */

/**
 * Local -> world for a site with a `yaw`: `u` along the site, `v` across it.
 *
 * NOT `siteFrame` above, deliberately. That one returns the site's numbers
 * (`hx`, `hz`, `c`, `s`) for `fpos` to transform a point with; this one closes
 * over them and hands back two functions, which is what a builder emitting a
 * few hundred points in a loop wants. Two names because they are two shapes,
 * not because either is a copy of the other.
 */
function siteAxes(lm, fallbackYaw = 0) {
  /**
   * `yaw` IS THE FRAME'S, AND EVERY `trs` ROTATION OFF IT IS NEGATED.
   *
   * `plan.siteDist` measures the site's long axis along `(cos yaw, sin yaw)`,
   * and `netgen.gridDistrict` cuts its blocks with the same `L2W(u, v) = (u c -
   * v s, u s + v c)`. Three's Y Euler is the OTHER handedness: `R_y(t)` sends
   * local +x to `(cos t, -sin t)`. So a box placed at `F.x(u, v)` and rotated
   * by `+yaw` comes out mirrored — 2 x 0.52 rad off true on Oakland's quad,
   * which is a tower standing at 60 degrees to its own lawn. Every rotation
   * argument below is `-F.yaw`; the direction arithmetic that uses
   * `Math.cos(F.yaw)` / `Math.sin(F.yaw)` to step ALONG the frame is not, and
   * the two must not be conflated. `siteFrame`/`fpos` above has the same rule
   * written the same way, and for the same reason.
   */
  const yaw = lm.site?.yaw ?? fallbackYaw;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    yaw,
    c,
    s,
    x: (u, v) => lm.x + u * c - v * s,
    z: (u, v) => lm.z + u * s + v * c,
  };
}

/**
 * A flat paved strip between two points in the site's own frame — a walk, a
 * path or a painted bay. One box, so a hundred metres of path is a hundred
 * metres of two triangles per segment rather than a mesh per paving slab.
 */
function walkStrip(T, key, F, ga, u0, v0, u1, v1, width, lift, masks) {
  const du = u1 - u0;
  const dv = v1 - v0;
  const len = Math.hypot(du, dv);
  if (len < 0.5) return;
  const segs = Math.max(1, Math.round(len / 12));
  // `ry` is NEGATED — see `siteAxes`. The strip's long axis is local +x, and
  // three's Y rotation sends local +x to (cos ry, -sin ry), so the yaw that
  // points it along (du, dv) in the frame is -(frame yaw + the strip's own).
  const yaw = -(F.yaw + Math.atan2(dv, du));
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const mu = u0 + du * (t0 + t1) * 0.5;
    const mv = v0 + dv * (t0 + t1) * 0.5;
    const wx = F.x(mu, mv);
    const wz = F.z(mu, mv);
    box(T, key, wx, ga(wx, wz) + lift, wz, len / segs + 0.25, 0.12, width, yaw, masks);
  }
}

// ------------------------------------------------------ Cathedral of Steel --
/**
 * THE CATHEDRAL OF STEEL — Oakland's gothic limestone tower, on its quad.
 *
 * DESIGN.md's skyline is glass (the Steel Tower), brick (Lawrenceville) and
 * rust (Steel Row). This is the fourth reading and the one the city did not
 * have: forty storeys of LOAD-BEARING STONE, unbroken vertical piers from the
 * plinth to the crown, and no setback wide enough to break the line. The whole
 * silhouette is one idea — a building trying to be a cathedral — and it works
 * from two kilometres because the piers make it read as fluted rather than as
 * a box, which is the only thing that distinguishes a gothic tower from an
 * office slab at that distance.
 *
 * IT IS DELIBERATELY SHORTER THAN THE STEEL TOWER. `steelTower` stands 60
 * storeys of 3.9 m plus a 22 m mast — about 258 m. This one tops out at 135 m
 * to the tip of the lantern. DESIGN.md says the Steel Tower is "the tallest
 * building in Steel City" and "the one silhouette every long view of downtown
 * has to contain"; a second tower that beat it would cost the map its centre.
 * Oakland reads because it is the only tall thing for 700 m, not because it is
 * the tallest thing on the map.
 *
 * The quad is authored with it, because a Cathedral of Learning without its
 * lawn is an office block: two collegiate ranges in buff brick and stone
 * dressing down the long sides, a cross of walks, a low ashlar wall along the
 * ring road, and the tower alone in the middle of the grass.
 */
function cathedralOfSteel(T, lib, lm, rng, gy, groundAt) {
  const F = siteAxes(lm, 0.52);
  const ga = groundAt ?? (() => gy);
  const x = lm.x;
  const z = lm.z;

  /* ---- the quad: walls, walks and the plinth the tower stands on ------- */
  const QU = lm.site?.hx ?? 54;
  const QV = lm.site?.hz ?? 42;
  // Perimeter walk just inside the reserve, and the cross through the middle.
  for (const v of [-QV + 5, QV - 5]) walkStrip(T, 'precast', F, ga, -QU + 5, v, QU - 5, v, 3.4, 0.07, [0.5, 0.6, 0.3]);
  for (const u of [-QU + 5, QU - 5]) walkStrip(T, 'precast', F, ga, u, -QV + 5, u, QV - 5, 3.4, 0.07, [0.5, 0.6, 0.3]);
  walkStrip(T, 'precast', F, ga, -QU + 5, 0, QU - 5, 0, 5.0, 0.08, [0.45, 0.55, 0.3]);
  walkStrip(T, 'precast', F, ga, 0, -QV + 5, 0, QV - 5, 5.0, 0.08, [0.45, 0.55, 0.3]);
  // Low ashlar boundary wall with piers, which is what tells you the lawn is
  // somebody's rather than a gap between buildings.
  for (const sv of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const u = -QU + 2 + (i / 10) * (QU * 2 - 4);
      const wx = F.x(u, sv * (QV - 1.5));
      const wz = F.z(u, sv * (QV - 1.5));
      const g = ga(wx, wz);
      box(T, 'stone_grey', wx, g + 0.45, wz, (QU * 2 - 4) / 10 + 0.2, 0.9, 0.5, -F.yaw, [0.6, 0.65, 0.3], _sharedChamfer());
      box(T, 'stone_warm', wx, g + 1.02, wz, 0.9, 0.34, 0.9, -F.yaw, [0.55, 0.6, 0.3], _sharedChamfer());
    }
  }
  // The plinth: three steps of ashlar, so the tower has a base and the grass
  // does not run straight into the stonework.
  for (let i = 0; i < 3; i++) {
    box(T, 'stone_grey', x, gy + 0.22 + i * 0.42, z, 34 - i * 4.4, 0.5, 30 - i * 4.4, -F.yaw, [0.5, 0.6, 0.3], _sharedChamfer());
  }

  /* ---- the tower ------------------------------------------------------- */
  /**
   * Stages are half-extents in the site frame. The taper is deliberately slow
   * — 21 -> 16 -> 12.5 -> 9 over 109 m — because a gothic tower is a shaft
   * with setbacks, not a ziggurat: every step is small enough that the piers
   * on the stage above land on the ledge of the one below rather than
   * cantilevering off nothing.
   */
  const stages = [
    { hu: 21.0, hv: 17.0, h: 17, pier: 3.4, mat: 'stone_warm' },
    { hu: 16.0, hv: 13.0, h: 44, pier: 3.2, mat: 'stone_grey' },
    { hu: 12.5, hv: 10.5, h: 28, pier: 3.0, mat: 'stone_grey' },
    { hu: 9.0, hv: 7.5, h: 20, pier: 2.8, mat: 'stone_warm' },
  ];
  let y = gy + 1.4;
  for (let s = 0; s < stages.length; s++) {
    const st = stages[s];
    // core: the wall plane, recessed behind the piers
    box(T, st.mat, x, y + st.h / 2, z, st.hu * 2 - 1.1, st.h, st.hv * 2 - 1.1, -F.yaw, [0.35, 0.45, 0.25], _sharedChamfer());
    /**
     * THE LANCETS. Tall, narrow, and set in the recess between two piers —
     * one per bay, running nearly the full height of the stage. A gothic
     * window is a slot, so the glass is 1.5 m wide against a 3 m bay, and the
     * lit-room card behind it is what makes the tower read at night.
     */
    const bu = Math.max(2, Math.round((st.hu * 2) / st.pier));
    const bv = Math.max(2, Math.round((st.hv * 2) / st.pier));
    for (const [n, hAlong, hAcross, along] of [[bu, st.hu, st.hv, true], [bv, st.hv, st.hu, false]]) {
      for (let i = 0; i < n; i++) {
        const o = -hAlong + ((i + 0.5) / n) * hAlong * 2;
        for (const sd of [-1, 1]) {
          const u = along ? o : sd * (hAcross - 0.5);
          const v = along ? sd * (hAcross - 0.5) : o;
          const wx = F.x(u, v);
          const wz = F.z(u, v);
          const gh = st.h - 4.4;
          box(T, 'glass_solid_warm', wx, y + st.h / 2, wz, along ? 1.5 : 0.28, gh, along ? 0.28 : 1.5, -F.yaw, [0, 0.15, 0]);
          box(T, 'room_lit_warm', wx, y + st.h / 2, wz, along ? 1.3 : 0.16, gh - 0.6, along ? 0.16 : 1.3, -F.yaw, [0, 0.1, 0.5]);
        }
      }
    }
    // the piers themselves: unbroken stone mullions, 0.55 m proud
    for (const [n, hAlong, hAcross, along] of [[bu, st.hu, st.hv, true], [bv, st.hv, st.hu, false]]) {
      for (let i = 0; i <= n; i++) {
        const o = -hAlong + (i / n) * hAlong * 2;
        for (const sd of [-1, 1]) {
          const u = along ? o : sd * (hAcross + 0.18);
          const v = along ? sd * (hAcross + 0.18) : o;
          const wx = F.x(u, v);
          const wz = F.z(u, v);
          box(T, st.mat, wx, y + st.h / 2, wz, along ? 0.85 : 0.9, st.h, along ? 0.9 : 0.85, -F.yaw, [0.45, 0.5, 0.28], _sharedChamfer());
        }
      }
    }
    // corner buttress piers, heavier than the mullions — the tower's profile
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const wx = F.x(su * st.hu, sv * st.hv);
        const wz = F.z(su * st.hu, sv * st.hv);
        box(T, st.mat, wx, y + st.h / 2, wz, 2.6, st.h, 2.6, -F.yaw, [0.5, 0.55, 0.3], _sharedChamfer());
        // a pinnacle on every setback
        box(T, 'stone_warm', wx, y + st.h + 1.5, wz, 1.9, 3.0, 1.9, -F.yaw + 0.78, [0.6, 0.6, 0.3], _sharedChamfer());
      }
    }
    // string course / cornice at the setback
    box(T, 'stone_warm', x, y + st.h + 0.42, z, st.hu * 2 + 2.4, 0.84, st.hv * 2 + 2.4, -F.yaw, [0.6, 0.6, 0.3], _sharedChamfer());
    y += st.h + 0.84;
  }

  /* ---- the lantern and the spire --------------------------------------- */
  const LU = 6.4;
  box(T, 'stone_warm', x, y + 7, z, LU * 2, 14, LU * 1.7 * 2 * 0.5, -F.yaw, [0.4, 0.5, 0.25], _sharedChamfer());
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + F.yaw;
    box(T, 'glass_solid_warm', x + Math.cos(a) * (LU - 0.6), y + 7, z + Math.sin(a) * (LU - 0.6), 1.5, 10, 0.3, -a - Math.PI / 2, [0, 0.15, 0]);
  }
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const wx = F.x(su * LU, sv * LU * 0.85);
      const wz = F.z(su * LU, sv * LU * 0.85);
      box(T, 'stone_grey', wx, y + 15.5, wz, 1.5, 9, 1.5, -F.yaw + 0.78, [0.6, 0.6, 0.3], _sharedChamfer());
    }
  }
  cyl(T, 'stone_warm', x, y + 14, z, 5.0, 3, 8, [0.55, 0.55, 0.3], 3.4);
  cyl(T, 'stone_grey', x, y + 17, z, 3.4, 12, 8, [0.55, 0.55, 0.3], 0.25);
  // the two aircraft lamps every 130 m tower in a river valley carries
  for (const dy of [4.0, 9.0]) box(T, 'neon_red', x, y + 17 + dy, z, 0.7, 0.4, 0.7, 0, [0, 0, 0]);

  /* ---- the two collegiate ranges down the long sides -------------------- */
  /**
   * Buff brick with stone dressing, three storeys and a steep gable — the
   * cheap half of collegiate gothic, which is what a university actually
   * builds around the one expensive thing. They are set on the QUAD's long
   * edges, inside the wall, so the lawn is enclosed on three sides.
   */
  for (const sv of [-1, 1]) {
    const hallV = sv * (QV - 12);
    const HU = 34;
    const HH = 12.5;
    for (let i = 0; i < 7; i++) {
      const u = -HU + ((i + 0.5) / 7) * HU * 2;
      const wx = F.x(u, hallV);
      const wz = F.z(u, hallV);
      const g = ga(wx, wz);
      const bay = (HU * 2) / 7;
      box(T, 'brick_buff', wx, g + HH / 2, wz, bay, HH, 15, -F.yaw, [0.4, 0.5, 0.3], _sharedChamfer());
      // stone plinth, band course and parapet
      box(T, 'stone_grey', wx, g + 1.1, wz, bay + 0.3, 2.2, 15.4, -F.yaw, [0.55, 0.65, 0.35], _sharedChamfer());
      box(T, 'stone_warm', wx, g + HH - 0.5, wz, bay + 0.5, 1.0, 15.6, -F.yaw, [0.6, 0.6, 0.3], _sharedChamfer());
      // steep slate gable behind the parapet
      box(T, 'roof_shingle', wx, g + HH + 2.4, wz, bay, 4.6, 11, -F.yaw, [0.5, 0.55, 0.3], _sharedChamfer());
      // two ranks of pointed windows facing the lawn
      for (let f = 0; f < 3; f++) {
        for (const o of [-bay * 0.26, bay * 0.26]) {
          const qx = F.x(u + o, hallV - sv * 7.6);
          const qz = F.z(u + o, hallV - sv * 7.6);
          box(T, 'glass_solid_warm', qx, g + 3.4 + f * 3.2, qz, 1.5, 2.3, 0.3, -F.yaw, [0, 0.15, 0]);
          box(T, 'stone_warm', qx, g + 4.75 + f * 3.2, qz, 1.9, 0.5, 0.42, -F.yaw, [0.6, 0.6, 0.3], _sharedChamfer());
        }
      }
      // an arched entry in the middle bay
      if (i === 3) {
        const ex = F.x(u, hallV - sv * 7.9);
        const ez = F.z(u, hallV - sv * 7.9);
        box(T, 'stone_warm', ex, g + 2.6, ez, 4.6, 5.2, 1.1, -F.yaw, [0.6, 0.6, 0.3], _sharedChamfer());
        box(T, 'door_wood', ex, g + 1.9, ez, 3.0, 3.8, 0.5, -F.yaw, [0.5, 0.5, 0.3]);
        T.put(Kit.stoop(lib, 'stone_grey', 3), ex, g, ez, -F.yaw + (sv > 0 ? Math.PI : 0), 1.6);
      }
      T.box('concrete', wx, g + HH / 2, wz, bay, HH + 5, 15, -F.yaw);
    }
  }

  /* ---- lamps down the cross walk, and the collision box for the tower --- */
  const bol = Kit.bollard(lib, 'steel_dark');
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const u = Math.cos(a) * (QU - 8);
    const v = Math.sin(a) * (QV - 8);
    const wx = F.x(u, v);
    const wz = F.z(u, v);
    T.put(bol, wx, ga(wx, wz), wz, 0, 1);
  }
  T.box('concrete', x, gy + 55, z, 40, 110, 35, -F.yaw);
}

// ------------------------------------------------------------ Ironwood Park --
/**
 * IRONWOOD PARK — Oakland's park: a ring drive's worth of lawn with a path
 * loop, a bandstand, a lily pond and a stone entrance.
 *
 * `netgen.landmarkRings` lays the road AROUND this, so what is authored here
 * is only what is inside the ring: the hard landscape. THE TREES ARE NOT HERE.
 * Vegetation belongs to `src/props/` — it owns the five species, their four
 * canopy variants, the far tier and the leaf materials — and duplicating a
 * tree in `buildings` would be the Point Fountain defect with a trunk on it.
 * `props/layout.js` scatters the planting over this same site off the
 * published `world.landmarks` entry.
 */
function ironwoodPark(T, lib, lm, rng, gy, groundAt) {
  const F = siteAxes(lm, 0);
  const ga = groundAt ?? (() => gy);
  const x = lm.x;
  const z = lm.z;
  const R = lm.site?.r ?? 84;

  /* ---- the path loop: an annulus of hoggin, and four radial walks ------- */
  const loop = new THREE.RingGeometry(R - 26, R - 22.6, 48, 1);
  loop.rotateX(-Math.PI / 2);
  fillMasks(loop, 0.55, 0.5, 0.3);
  trs(_m, x, ga(x, z) + 0.06, z, 0, 1, 1, 1);
  T.addOnce('roof_gravel', loop, _m);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    walkStrip(T, 'roof_gravel', F, ga, Math.cos(a) * 11, Math.sin(a) * 11,
      Math.cos(a) * (R - 3), Math.sin(a) * (R - 3), 3.0, 0.06, [0.55, 0.5, 0.3]);
  }

  /* ---- the bandstand at the centre -------------------------------------- */
  const bx = x;
  const bz = z;
  const bg = ga(bx, bz);
  for (let i = 0; i < 3; i++) {
    cyl(T, 'stone_grey', bx, bg + i * 0.34, bz, 9.6 - i * 1.0, 0.36, 24, [0.5, 0.6, 0.3]);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    cyl(T, 'trim_white', bx + Math.cos(a) * 6.6, bg + 1.05, bz + Math.sin(a) * 6.6, 0.24, 4.2, 8, [0.5, 0.4, 0.2]);
  }
  cyl(T, 'roof_shingle', bx, bg + 5.25, bz, 8.2, 0.5, 20, [0.5, 0.55, 0.3]);
  cyl(T, 'roof_shingle', bx, bg + 5.7, bz, 7.6, 3.2, 20, [0.5, 0.55, 0.3], 0.5);
  cyl(T, 'alu_bright', bx, bg + 8.9, bz, 0.22, 2.4, 8, [0.4, 0.3, 0.1], 0.05);
  T.box('concrete', bx, bg + 3, bz, 17, 6, 17);

  /* ---- the pond, and the wall that holds the bank up --------------------- */
  const px = F.x(-R * 0.42, R * 0.34);
  const pz = F.z(-R * 0.42, R * 0.34);
  const pg = ga(px, pz);
  const water = new THREE.CircleGeometry(15.5, 40);
  water.rotateX(-Math.PI / 2);
  fillMasks(water, 0, 0.1, 0);
  trs(_m, px, pg - 0.55, pz, 0, 1, 1, 1);
  T.addOnce('glass_sky', water, _m);
  const coping = new THREE.RingGeometry(15.4, 17.2, 40, 1);
  coping.rotateX(-Math.PI / 2);
  fillMasks(coping, 0.6, 0.7, 0.35);
  trs(_m, px, pg + 0.05, pz, 0, 1, 1, 1);
  T.addOnce('stone_soot', coping, _m);

  /* ---- the entrance: two ashlar piers and a name plinth ------------------ */
  for (const sv of [-1, 1]) {
    const ex = F.x(R - 8, sv * 9);
    const ez = F.z(R - 8, sv * 9);
    const eg = ga(ex, ez);
    box(T, 'stone_grey', ex, eg + 1.9, ez, 2.2, 3.8, 2.2, -F.yaw, [0.55, 0.6, 0.3], _sharedChamfer());
    box(T, 'stone_warm', ex, eg + 4.0, ez, 2.8, 0.5, 2.8, -F.yaw, [0.6, 0.6, 0.3], _sharedChamfer());
    box(T, 'alu_dark', ex, eg + 4.7, ez, 0.9, 1.1, 0.9, -F.yaw + 0.78, [0.5, 0.3, 0.15]);
  }

  /* ---- benches and bollards round the loop ------------------------------ */
  const bol = Kit.bollard(lib, 'steel_dark');
  /**
   * Bollards on the loop, and NOTHING ELSE. The first cut hand-built a park
   * bench here out of three boxes; `props/kit_street.js` already registers
   * `bench_slat` and `bench_ends`, `props/layout.js` already places them round
   * this exact site, and a second bench grown in `buildings` is two subsystems
   * deciding one fact for the sake of six triangles.
   */
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.13;
    const rr = R - 20;
    const wx = x + Math.cos(a) * rr;
    const wz = z + Math.sin(a) * rr;
    T.put(bol, wx, ga(wx, wz), wz, 0, 0.85);
  }
}

// ---------------------------------------------------------------- Color Park --
/**
 * COLOR PARK — the legal wall on the Monongahela's south bank, and the one
 * place in Steel City where the paint is the POINT rather than the decay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REPORT, AND WHAT WAS ACTUALLY WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * "color park is glitchy (panels laying everywhere, player falls through the
 * ground) and does not look like spraypaint".
 *
 * All three are the same mistake made twice: FLAT BOXES SAMPLED AT ONE POINT
 * STANDING ON A BANK THAT FALLS 3.5 m.
 *
 *   THE FALL-THROUGH. The apron was ten `roof_tar` boxes, each `HV * 1.35` =
 *   21.6 m deep across the slope and each seated on ONE ground sample taken at
 *   its own centre (v = 0). MEASURED on the shipped terrain, across the band
 *   those boxes covered: the ground runs 8.5 m at v = 0 and 4.9 m at
 *   v = -10.8, so the slab's far edge stood up to 2.6 m in the air. It carried
 *   no collider — deliberately, so as not to build a floor — so a player
 *   walked onto a surface that was visibly solid and dropped to the terrain
 *   underneath it. That is exactly "falls through the ground", and it was
 *   authored in.
 *
 *   THE PANELS. Ten free-standing 11.5 x 3.5 m concrete slabs on end, jogged a
 *   metre in and out. A "legal wall" made of separate panels standing in open
 *   ground reads as panels lying about in a field, because that is what it is.
 *
 *   THE PAINT. Flat rectangles of opaque colour, hard-edged, one per box. No
 *   aerosol has a straight edge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS NOW, AND WHO OWNS WHICH HALF
 * ─────────────────────────────────────────────────────────────────────────────
 * The park is PAINTED ASPHALT and A WALL WITH MURALS ON IT, and those are two
 * different subsystems:
 *
 *   HERE (`buildings`)   the hard landscape only — one continuous retaining
 *                        wall along the inland edge, the skate ledges, the
 *                        trail, the bank wall and rail over the water, and the
 *                        excursion landing. Everything stands ON the ground it
 *                        samples and everything that encloses mass collides.
 *                        NOTHING here is a floor and nothing here is paint.
 *   `src/props/colorpark.js`   the asphalt skin and every drop of paint on it,
 *                        as GROUND-CONFORMING meshes (a vertex per sample of
 *                        `world.heightAt`, not a box seated on one), plus the
 *                        murals on this wall's face. No collision at all: the
 *                        ground a player walks on at Color Park is the terrain
 *                        that was already there, and only the terrain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHARED FRAME, AND WHY IT IS COPIED RATHER THAN IMPORTED
 * ─────────────────────────────────────────────────────────────────────────────
 * `props` cannot import this module (ARCHITECTURE.md rule 2) and must not
 * guess where this wall is. Both sides therefore derive every number from the
 * SAME published `world.landmarks` entry — `site.hx`, `site.hz`, `site.yaw` —
 * through the same three expressions, which are stated here and repeated
 * verbatim in `props/colorpark.js`:
 *
 *   WALL_FACE_V = HV - 3.0     the retaining wall's park-facing face
 *   APRON_V     = [-HV * 0.38, HV - 3.2]   the painted asphalt band
 *   TRAIL_V     = -HV * 0.86   the riverside trail (unchanged)
 *
 * If the site moves or turns, both sides move with it. If someone edits one of
 * the three, `props/colorparkprobe.mjs` reports the murals as unbacked.
 */

/** The retaining wall's park-facing face, in site-local v. See the note above. */
const CP_WALL_FACE_V = (HV) => HV - 3.0;

/**
 * The cans the skate ledges are painted with. Existing `buildings/palette.js`
 * keys, so five painted decks cost no new material — the same accounting note
 * that governs the rest of this file.
 */
const LEDGE_PAINT = ['paint_red', 'paint_teal', 'hazard_yellow', 'paint_blue', 'paint_green'];

function colorPark(T, lib, lm, rng, gy, groundAt) {
  const F = siteAxes(lm, 0.489);
  const ga = groundAt ?? (() => gy);
  const HU = lm.site?.hx ?? 76;
  const HV = lm.site?.hz ?? 16;

  /* ---- the retaining wall: ONE wall, not ten panels --------------------- */
  /**
   * A legal wall is the side of something. This is the retaining wall that
   * holds Carson Street's embankment up off the bank, so it is continuous, it
   * is founded 1.8 m into the ground (nothing can show daylight under it
   * however the bank falls away) and every segment sits on its own sample.
   *
   * The top line is SMOOTHED over five samples spanning 12 m rather than
   * following each segment's own ground: a poured wall is built to a level and
   * the ground does what it likes underneath, and a top edge that copies the
   * terrain reads as a fence rather than as concrete.
   */
  const WALL_V = CP_WALL_FACE_V(HV);
  const WSEG = 3.0;
  const wallU0 = -HU + 3;
  const wallU1 = HU - 3;
  const wallN = Math.max(4, Math.round((wallU1 - wallU0) / WSEG));
  const wallSeg = (wallU1 - wallU0) / wallN;
  const smoothG = (u) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) {
      const uu = Math.max(wallU0, Math.min(wallU1, u + k * 3));
      s += ga(F.x(uu, WALL_V + 0.45), F.z(uu, WALL_V + 0.45));
    }
    return s / 5;
  };
  for (let i = 0; i < wallN; i++) {
    const u = wallU0 + (i + 0.5) * wallSeg;
    const wx = F.x(u, WALL_V + 0.45);
    const wz = F.z(u, WALL_V + 0.45);
    const g = smoothG(u);
    // Founded 1.8 m down, 3.3 m of it above the smoothed line: one prism, so
    // there is no seam for the ground to show through however it falls.
    box(T, 'concrete_wall', wx, g + 0.75, wz, wallSeg + 0.06, 5.1, 0.9, -F.yaw, [0.55, 0.7, 0.35]);
    // The coping: every poured wall in this valley has one, and it is what
    // stops the top edge reading as a cut-off box.
    box(T, 'concrete_dark', wx, g + 3.38, wz, wallSeg + 0.18, 0.16, 1.12, -F.yaw, [0.6, 0.8, 0.45],
      _sharedChamfer());
    T.box('concrete', wx, g + 0.75, wz, wallSeg + 0.06, 5.1, 0.9, -F.yaw);
    // A buttress every fourth bay, on the EMBANKMENT side, so it never eats
    // into the face the murals go on.
    if (i % 4 === 2) {
      const bx = F.x(u, WALL_V + 1.5);
      const bz = F.z(u, WALL_V + 1.5);
      box(T, 'concrete_dark', bx, g + 0.4, bz, 0.9, 3.0, 1.4, -F.yaw, [0.6, 0.75, 0.4], _sharedChamfer());
      T.box('concrete', bx, g + 0.4, bz, 0.9, 3.0, 1.4, -F.yaw);
    }
  }

  /* ---- the ledges and rails the apron grew ------------------------------ */
  /**
   * Skate furniture, on the flat of the shelf. Each stands on its own ground
   * sample and is 7.5 m long, so the worst cross-fall under one is centimetres
   * — the failure the apron had is not reachable at this size. Collided,
   * because a man can stand on a ledge.
   */
  for (let i = 0; i < 5; i++) {
    const u = -HU + 20 + i * 26;
    const wx = F.x(u, -HV * 0.12);
    const wz = F.z(u, -HV * 0.12);
    const g = ga(wx, wz);
    box(T, 'precast', wx, g + 0.28, wz, 7.5, 0.56, 1.2, -F.yaw, [0.7, 0.75, 0.4], _sharedChamfer());
    /**
     * A LEDGE'S OWN TOP SURFACE, painted here rather than in `props`. Every
     * other drop of paint in this park is on the ground or on the wall face,
     * which is what `props/colorparkprobe.mjs` can gate as a total claim; a
     * deck standing 0.56 m proud would have to be carved out of that sweep by
     * a rule keyed to this loop's own coordinates. So the ledge paints itself.
     */
    box(T, LEDGE_PAINT[i % LEDGE_PAINT.length], wx, g + 0.575, wz, 7.4, 0.03, 1.1,
      -F.yaw, [0.85, 0.5, 0.3]);
    // The steel coping every ledge in every skate park in the world wears.
    box(T, 'steel_light', wx, g + 0.58, wz, 7.6, 0.09, 0.16, -F.yaw, [0.75, 0.4, 0.2]);
    T.box('concrete', wx, g + 0.28, wz, 7.5, 0.6, 1.2, -F.yaw);
  }

  /* ---- the trail, and the bank wall between it and the river ------------- */
  walkStrip(T, 'roof_tar', F, ga, -HU + 2, -HV * 0.86, HU - 2, -HV * 0.86, 3.2, 0.07, [0.6, 0.6, 0.35]);
  // 24 bays rather than 16: the same 152 m of bank, sampled half again as
  // often, so a wall that follows a falling bank steps in 60 mm rather than
  // 100 mm and never lifts off it.
  const BANK_N = 24;
  for (let i = 0; i < BANK_N; i++) {
    const u = -HU + (i / (BANK_N - 1)) * HU * 2;
    const wx = F.x(u, -HV - 1.4);
    const wz = F.z(u, -HV - 1.4);
    const g = ga(wx, wz);
    box(T, 'stone_soot', wx, g + 0.42, wz, (HU * 2) / (BANK_N - 1) + 0.2, 0.9, 0.7, -F.yaw, [0.7, 0.8, 0.4], _sharedChamfer());
    // a rail on top of the bank wall, because the drop behind it is the river
    if (i < BANK_N - 1) {
      for (const h of [0.72, 1.1]) {
        box(T, 'steel_dark', wx, g + 0.42 + h, wz, (HU * 2) / (BANK_N - 1) + 0.2, 0.06, 0.06, -F.yaw, [0.6, 0.5, 0.3]);
      }
      box(T, 'steel_dark', wx, g + 1.0, wz, 0.09, 1.2, 0.09, -F.yaw, [0.6, 0.5, 0.3]);
    }
    T.box('concrete', wx, g + 0.9, wz, (HU * 2) / (BANK_N - 1) + 0.2, 1.8, 0.7, -F.yaw);
  }

  /* ---- the landing: a timber pier off the trail for the excursion boats -- */
  const dx = F.x(HU * 0.18, -HV - 3.2);
  const dz = F.z(HU * 0.18, -HV - 3.2);
  const dg = ga(dx, dz);
  for (let i = 0; i < 7; i++) {
    const u = HU * 0.18;
    const v = -HV - 3.2 - i * 4.2;
    const wx = F.x(u, v);
    const wz = F.z(u, v);
    box(T, 'timber', wx, dg - 0.4 - i * 0.6, wz, 5.0, 0.22, 4.2, -F.yaw, [0.7, 0.65, 0.35]);
    for (const su of [-1, 1]) {
      const cx = wx + Math.cos(F.yaw) * su * 2.2;
      const cz = wz + Math.sin(F.yaw) * su * 2.2;
      cyl(T, 'timber_dark', cx, dg - 3.4 - i * 0.6, cz, 0.26, 3.2, 8, [0.75, 0.7, 0.4]);
    }
    T.box('wood', wx, dg - 0.4 - i * 0.6, wz, 5.0, 0.3, 4.2, -F.yaw);
  }
  box(T, 'steel_light', dx, dg + 0.6, dz, 0.16, 2.2, 0.16, -F.yaw, [0.7, 0.5, 0.3]);
}
