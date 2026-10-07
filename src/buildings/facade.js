import * as THREE from 'three';
import {
  wallPanel,
  solidSlabs,
  moulding,
  runoffStreak,
  quad,
  plainBox,
  chamferBox,
  fillMasks,
  weather,
  trs,
  fbm3,
} from './geom.js';
import { Kit, sizeClass } from './kit.js';
import { surfaceTagOf } from './palette.js';

/**
 * BUILDINGS — the facade grammar.
 *
 * An elevation is not a texture. It is: a wall of real thickness with real
 * openings; a reveal you can see down; a frame set back in that reveal; glass
 * in the frame; a room behind the glass; a sill that throws a shadow and sheds
 * a stain; a lintel; a string course between floors; a cornice at the top; and
 * a ground floor that does not look like the floors above it.
 *
 * Everything here writes into a TileBuilder. Nothing touches the scene.
 */

/**
 * THE NEGATIVE-CONTROL SWITCHES, and the only thing that reads them is a probe.
 *
 * Same shape and same reasoning as `collisionOpts` in `archetypes.js`: a gate
 * that only ever runs one arm is measuring the harness, not the change. Each
 * flag turns exactly one of this wave's additions off and nothing else, so
 * `src/buildings/kitprobe.mjs` can show its assertions going red when the
 * feature is absent — which is the only evidence that they were testing the
 * feature and not the weather.
 *
 *   crown    the cornice profile family and its dentil/modillion course
 *   terrace  the stepped foundation apron below the plinth
 *   mounts   publishing sign mount points at all
 *   roof     the rooftop additions: chimney stacks, hatches, the water-tower
 *            rate. `false` restores the rates the wave inherited.
 *
 * `?owNoFacadeKit=1` turns all four off in a LIVE build, which is what makes
 * the frame-cost claim measurable: `perfcheck --ab='.|owNoFacadeKit=1,.'` runs
 * both arms out of one build in one minute on one machine, and a delta measured
 * that way is a property of the code rather than of whatever else the machine
 * was doing. Same convention as `?owNoTileAo=1` and `?owNoKerbGuard=1`.
 */
const NO_KIT = (() => {
  if (typeof location === 'undefined') return '';
  const m = /[?&]owNoFacadeKit=([^&]*)/.exec(location.search);
  return m ? decodeURIComponent(m[1]) : '';
})();
/**
 * `owNoFacadeKit=1` turns the lot off; a comma list turns off exactly the named
 * parts (`owNoFacadeKit=terrace`, `owNoFacadeKit=crown,roof`). The granularity
 * is not decoration: when `solidprobe`'s ghost count moved with this wave, the
 * only way to say WHICH addition moved it was to build the city with one of
 * them missing and nothing else changed — including the RNG stream, which a
 * revert would have shifted and which decides where every building in Steel
 * City stands.
 */
const kitOff = (part) => NO_KIT === '1' || NO_KIT.split(',').includes(part);
export const facadeOpts = {
  crown: !kitOff('crown'),
  terrace: !kitOff('terrace'),
  mounts: !kitOff('mounts'),
  roof: !kitOff('roof'),
};

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Wall basis: +X along the elevation, +Y up, +Z out of the building. The outer
 * face of the wall lands exactly on the edge line, so the massing polygon the
 * lot subdivision produced is the building's true outline.
 *
 * +X IS DERIVED FROM +Y AND +Z, NEVER FROM THE VERTEX ORDER. This is the whole
 * point of the function and it is not a stylistic choice.
 *
 * It used to take +X from the edge direction (b - a) while taking +Z from
 * `outwardNormal`, which resolves against the polygon's CENTROID. Those are two
 * independent sources of truth about the same handedness, and they disagreed:
 * `normaliseFootprint` forces every footprint to positive shoelace area, and on
 * that winding the centroid test never flips, so the basis came out with
 * determinant -1 — a MIRROR — on every elevation of every building in the city.
 *
 * A mirror is silent in the merge. `Accum` carries vertex normals through the
 * normal matrix, which is correct, and copies the triangle indices unchanged,
 * which re-winds every face. Normal and winding then disagreed by 180 degrees
 * on 85% of all building geometry (measured: 739 106 of 864 940 triangles in
 * the `street` frame; 92% of the facade triangles the camera was standing
 * outside of were wound away from it).
 *
 * The forward pass hid it, because `src/materials/shader.js` flips the shading
 * normal by `gl_FrontFacing`. The g-buffer could not: `render`'s prepass
 * measured facades writing a view-space normal of about (-0.72, 0.04, -0.69) —
 * away from the camera that could see them — and GTAO closed its visibility arc
 * about it and returned AO 0.000 on every facade in the frame while the road
 * and pavement beside them were correct. SSR, TAA's normal reconstruction and
 * the contact-shadow term read the same buffer.
 *
 * `cross(+Y, +Z)` cannot be mirrored, whatever order the caller's polygon is
 * in. `src/buildings/windprobe.mjs` asserts the result against the EMITTED
 * geometry rather than against this arithmetic.
 */
export function wallBasis(out, ax, az, bx, bz, nx, nz, y0, t) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const nl = Math.hypot(nx, nz) || 1;
  const ox = nx / nl;
  const oz = nz / nl;
  _z.set(ox, 0, oz);
  // +X = +Y x +Z. For a polygon edge this is exactly the edge line (the outward
  // normal is perpendicular to it by construction), so the panel still spans
  // the same wall; only the direction of increasing panel-x is pinned, and it
  // is now pinned to something that cannot produce a left-handed frame.
  _x.set(oz, 0, -ox);
  out.makeBasis(_x, _y, _z);
  out.setPosition((ax + bx) / 2 - ox * t, y0, (az + bz) / 2 - oz * t);
  return len;
}

/**
 * Publish one sign mount, given a point in the elevation's own frame.
 *
 * THE CONTRACT IS DOCUMENTED IN `tile.js` — read that comment, not this one.
 * This is only the transform: the caller works in panel space (x along the
 * wall, y up from the wall base, z out of the outer face, which is exactly
 * where it already placed the fascia or the parapet) and gets a world-space
 * record with the yaw a consumer needs to face a board at the street.
 *
 * `ry = atan2(nx, nz)` is the inverse of `wallBasis`: that function builds
 * +Z = (ox, oz), and a rotation of `a` about +Y sends +Z to (sin a, 0, cos a),
 * so `a` is the yaw whose +Z is this elevation's outward normal and whose +X
 * runs along the wall. A consumer calling `trs(m, x, y, z, ry, w, h, 1)` lands
 * on the mount face, right way up, facing out — with no knowledge of this file.
 */
function mountAt(T, basis, w, kind, lx, ly, lz, mw, mh) {
  if (!facadeOpts.mounts) return;
  _p.set(lx, ly, lz).applyMatrix4(basis);
  const nl = Math.hypot(w.nx, w.nz) || 1;
  T.mount({
    kind,
    x: _p.x,
    y: _p.y,
    z: _p.z,
    ry: Math.atan2(w.nx / nl, w.nz / nl),
    nx: w.nx / nl,
    nz: w.nz / nl,
    w: mw,
    h: mh,
    arch: w.prog.arch,
    era: w.prog.era ?? 'plain',
    front: !!w.front,
  });
}

/** Outward normal of edge a->b for a polygon whose interior contains `c`. */
export function outwardNormal(ax, az, bx, bz, cx, cz, out = [0, 0]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  let nx = dz / len;
  let nz = -dx / len;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  if (nx * (cx - mx) + nz * (cz - mz) > 0) {
    nx = -nx;
    nz = -nz;
  }
  out[0] = nx;
  out[1] = nz;
  return out;
}

// ------------------------------------------------------------ programmes --
/**
 * Which `DISTRICTS[*].accents` keys are PAINT ON JOINERY rather than a wall
 * material. Everything not in here is a render, a siding, a steel, a rust or a
 * brick — a surface you clad an elevation in — and becomes an accent BAND
 * instead of a window frame. See the accent block in `makeProgramme`.
 *
 * Enumerated rather than pattern-matched on the `trim_` prefix: `alu_bright`
 * and `alu_dark` are joinery too (a shop's aluminium shopfront section), and
 * `brick_painted` starts with neither prefix and is emphatically not one.
 */
const ACCENT_JOINERY = new Set([
  'trim_white', 'trim_dark', 'trim_green', 'trim_red',
  'timber_dark', 'alu_dark', 'alu_bright',
]);

/**
 * The facade programme: every decision that must stay consistent from the
 * pavement to the parapet, decided once per building so a single elevation
 * cannot contradict its neighbour.
 */
export function makeProgramme(rng, style, arch, opts = {}) {
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * STREAM PARITY, and why a content wave has to care about it.
   * ─────────────────────────────────────────────────────────────────────────
   * Every decision below draws from ONE per-lot stream, and the draws after
   * this function — `floors`, `height`, `era`, `shapePlan`, the setback
   * fractions — draw from the same one. So a new decision taken from `rng`
   * does not just add a feature: it SHIFTS EVERY LATER DRAW, and the city
   * comes back with different buildings, of different heights, on different
   * hills. That is not a cosmetic difference. MEASURED on this wave's first
   * cut, with `solidprobe`: the worst archetype's sealed fraction moved from
   * green to 94.9% against a 95% ratchet, IN BOTH ARMS of the wave's own
   * negative control — i.e. the regression was the re-rolled city, not the new
   * geometry, and no switch could tell them apart because the switch cannot
   * un-draw a number.
   *
   * So new decisions draw from `aux`, a side stream seeded from the lot, and
   * anywhere a draw was REPLACED by a constant the draw is still taken and
   * discarded. The rule for anyone adding to this file: if your change alters
   * how many times `rng` is called, you have changed the whole city.
   */
  const aux = opts.aux ?? rng;
  const age = Math.min(1, Math.max(0, style.age + rng.range(-0.22, 0.22)));
  const masonry = rng.pick(style.masonry);
  /**
   * The lot's own accent draw. It is KEPT — see the stream-parity note above:
   * deleting it re-rolls every later draw and comes back with a different city
   * — but the block's accent wins where there is one, so a tile pays one extra
   * merged surface for the district accent instead of three. It is the
   * fallback for the callers that have no block (`preview.js`, `kitprobe`).
   */
  const lotAccent = rng.pick(style.accents);
  /**
   * `block` is the dressing palette shared by every building on this block —
   * joinery, stone, signage, awning canvas, roof covering. Two reasons, and
   * they point the same way: a terrace really was built by one developer out
   * of one set of parts, AND every distinct surface in a tile is one more
   * merged draw call, so letting each building pick its own trim colour costs
   * twenty batches a tile for variety nobody reads. The MASONRY stays per
   * building — that is the variety you actually see down a street.
   */
  const b = opts.block ?? {};
  const glass = b.glass ?? rng.pick(style.glass);
  /**
   * Joinery colour, weighted to WHITE.
   *
   * Five choices, four of them dark, produced a street where every window frame
   * disappeared into its own reveal: the opening read as a flat black rectangle
   * with a stone bar over it, which is exactly the "windows are painted on"
   * finding. A frame only describes depth if it is a different value from the
   * hole it sits in, and painted-white sash is what a Pittsburgh rowhouse
   * actually has. Dark joinery stays available — it is what makes the occasional
   * building read as recently done up — but it is no longer the default.
   */
  const trimSet = [
    'trim_white',
    'trim_white',
    'trim_white',
    'trim_green',
    'trim_dark',
    'timber_dark',
  ];
  const trim =
    arch === 'curtain' || arch === 'tower'
      ? (b.techTrim ?? rng.pick(['alu_dark', 'trim_dark', 'alu_bright']))
      : (b.trim ?? rng.pick(trimSet));

  const p = {
    arch,
    age,
    masonry,
    accent: b.accent ?? lotAccent,
    glass,
    trim,
    room: rng.float() < 0.5 ? 'room_dark' : 'room_mid',
    roof: b.roof ?? rng.pick(style.roof),
    winStyle: 'sash',
    bayW: 3.2,
    winW: 1.15,
    winH: 1.75,
    sillH: 0.95,
    floorH: 3.1,
    groundH: 3.9,
    wallT: 0.34,
    sill: true,
    lintel: false,
    stringCourse: false,
    cornice: 'brick',
    parapet: 0.9,
    balcony: 0,
    fireEscape: 0,
    acRate: 0,
    boarded: 0,
    blinds: 0.45,
    ground: 'stoop',
    litRate: 0.22,
    quoins: false,
    /** Storeys that get the full instanced window kit; see buildElevation. */
    detailFloors: 5,
  };

  switch (arch) {
    case 'curtain':
      p.winStyle = 'curtain';
      p.bayW = 1.55;
      p.floorH = 3.85;
      p.groundH = 6.2;
      p.wallT = 0.28;
      p.sill = false;
      p.cornice = 'flat';
      p.parapet = 1.3;
      p.ground = 'lobby';
      p.room = 'room_mid';
      p.blinds = 0.35;
      p.litRate = 0.3;
      /**
       * The SPANDREL of a curtain wall is the light half of the pair. Three of
       * the four old choices were dark, which put a dark band next to a dark
       * pane and flattened the whole elevation to one value — the other half of
       * why downtown read as "flat curtain-wall boxes". Precast, limestone and
       * painted aluminium are what a 1970s Pittsburgh tower is actually clad in,
       * and they sit a clear stop above the glazing at every hour.
       */
      p.masonry = rng.pick(['precast', 'stone_grey', 'concrete_wall', 'alu_bright', 'concrete_dark']);
      break;
    case 'tower':
      p.winStyle = 'plain';
      p.bayW = 2.5;
      p.winW = 1.5;
      p.winH = 2.15;
      p.floorH = 3.5;
      p.groundH = 5.4;
      p.sillH = 0.8;
      p.wallT = 0.4;
      p.lintel = false;
      p.stringCourse = true;
      p.cornice = 'stone';
      p.parapet = 1.2;
      p.ground = 'lobby';
      p.room = 'room_mid';
      p.litRate = 0.28;
      p.detailFloors = 4;
      break;
    case 'deco':
      p.winStyle = 'plain';
      p.bayW = 2.2;
      p.winW = 1.35;
      p.winH = 2.3;
      p.floorH = 3.4;
      p.groundH = 5.2;
      p.wallT = 0.46;
      p.lintel = true;
      p.stringCourse = true;
      p.cornice = 'stepped';
      p.parapet = 1.5;
      p.quoins = true;
      p.ground = 'lobby';
      p.room = 'room_mid';
      p.detailFloors = 4;
      break;
    case 'block':
      p.winStyle = rng.float() < 0.5 ? 'plain' : 'sash';
      p.bayW = rng.range(2.9, 3.7);
      p.winW = rng.range(1.2, 1.6);
      p.winH = rng.range(1.7, 2.1);
      p.floorH = rng.range(3.0, 3.5);
      p.groundH = rng.range(3.9, 4.6);
      p.lintel = rng.float() < 0.5;
      p.stringCourse = rng.float() < 0.55;
      p.cornice = rng.pick(['brick', 'stone', 'dentil', 'dentil', 'stepped']);
      p.ground = b.commercial === false && rng.float() < 0.5 ? 'stoop' : 'shop';
      p.acRate = 0.22 * age;
      p.balcony = rng.float() < 0.25 ? 0.35 : 0;
      p.fireEscape = rng.float() < 0.7 ? 1 : 0;
      break;
    case 'rowhouse':
      p.winStyle = 'sash';
      p.bayW = rng.range(2.5, 3.2);
      p.winW = rng.range(0.95, 1.25);
      p.winH = rng.range(1.55, 1.95);
      p.floorH = rng.range(2.95, 3.3);
      p.groundH = rng.range(3.4, 3.9);
      p.wallT = 0.36;
      p.lintel = rng.float() < 0.65;
      p.cornice = aux.float() < 0.45 ? 'dentil' : 'brick';
      p.parapet = rng.float() < 0.5 ? 0.75 : 0.25;
      p.ground = (b.commercial ?? rng.float() < 0.45) ? 'shop' : 'stoop';
      p.acRate = 0.3 * age;
      p.boarded = age > 0.6 ? 0.14 : 0.03;
      // Lawrenceville and the Strip: the escape is on the flank, and it is on
      // most of the terrace rather than a quarter of it.
      p.fireEscape = rng.float() < 0.6 ? 1 : 0;
      p.blinds = 0.6;
      p.litRate = 0.3;
      break;
    case 'house':
      p.winStyle = 'sash';
      p.bayW = rng.range(2.4, 3.1);
      p.winW = rng.range(0.9, 1.2);
      p.winH = rng.range(1.4, 1.8);
      p.floorH = rng.range(2.75, 3.05);
      p.groundH = rng.range(2.95, 3.3);
      p.wallT = 0.26;
      p.sillH = 0.95;
      p.cornice = 'eave';
      p.parapet = 0;
      p.ground = 'porch';
      p.blinds = 0.62;
      p.litRate = 0.34;
      p.acRate = 0.24 * age;
      break;
    case 'warehouse':
      p.winStyle = 'grid';
      p.bayW = rng.range(4.0, 5.6);
      p.winW = rng.range(2.1, 2.9);
      p.winH = rng.range(2.0, 2.6);
      p.floorH = rng.range(4.0, 5.0);
      p.groundH = rng.range(4.4, 5.4);
      p.sillH = 1.25;
      p.wallT = 0.42;
      p.lintel = true;
      p.cornice = aux.float() < 0.4 ? 'stepped' : 'brick';
      p.parapet = 1.05;
      p.ground = 'dock';
      p.boarded = 0.16 * age;
      p.room = 'room_dark';
      p.litRate = 0.12;
      /**
       * A LOFT ALWAYS HAS ONE. The Strip's warehouses and Lawrenceville's mill
       * lofts are the buildings a Pittsburgh fire escape actually hangs off,
       * and they now carry one on their flank whatever the roll said — the old
       * 45% coin flip meant most of the district had none.
       *
       * The roll is still TAKEN and thrown away. See the stream-parity note at
       * the top of this function: deleting a draw re-rolls every building in
       * the city, which is a much larger change than the one intended here.
       */
      rng.float();
      p.fireEscape = 1;
      break;
    case 'mill':
      p.winStyle = 'grid';
      p.bayW = rng.range(5.0, 7.5);
      p.winW = rng.range(2.6, 3.6);
      p.winH = rng.range(2.8, 4.0);
      p.floorH = rng.range(5.5, 8.0);
      p.groundH = rng.range(6.0, 8.5);
      p.sillH = 1.8;
      p.wallT = 0.5;
      p.cornice = aux.float() < 0.45 ? 'stepped' : 'flat';
      p.parapet = 0.7;
      p.ground = 'dock';
      p.boarded = 0.3 * age;
      p.room = 'room_dark';
      p.litRate = 0.08;
      p.fireEscape = 1;
      break;
    case 'market':
      p.winStyle = 'shop';
      p.bayW = 4.2;
      p.floorH = 4.2;
      p.groundH = 4.6;
      p.cornice = 'flat';
      p.parapet = 0.6;
      p.ground = 'shop';
      break;
    case 'pavilion':
      p.winStyle = 'shop';
      p.bayW = 3.4;
      p.floorH = 3.6;
      p.groundH = 3.8;
      p.cornice = 'flat';
      p.parapet = 0.5;
      p.ground = 'lobby';
      break;
    default:
      break;
  }
  if (opts.floorH) p.floorH = opts.floorH;
  // Dressings (sills, lintels, copings, string courses) are one stone across a
  // whole building — mixing them is what makes a facade look assembled from a
  // parts bin rather than built.
  p.sillMat = b.sillMat ?? rng.pick(['stone_grey', 'stone_warm', 'precast', 'concrete_wall']);
  /**
   * THE FOUNDATION COURSE, on the surface that was authored for it.
   *
   * `palette.js` shipped `stone_base` — rock-faced, coarser, with 1.1 m of
   * wheel-thrown road splash up it, "the band that grounds a building to its
   * pavement" — and nothing in this file ever named it, so every plinth in the
   * city drew the same ashlar as the sills three storeys up or a smooth
   * concrete pour. The draw is unchanged (see the stream-parity note): the
   * same coin flip, a different pair of faces on it.
   *
   * `stone_base` is one more merged surface in a tile, which is a real cost
   * and is why the OTHER face of the flip stays `concrete_dark` — a key the
   * tile was already paying for — rather than becoming a second new stone.
   */
  p.baseMat = rng.float() < 0.6 ? 'stone_base' : 'concrete_dark';
  /**
   * The glazed-brick dado under a shopfront, and the terracotta dressing on a
   * pre-war downtown elevation. Both are block-scoped (see `blockPalette`) so
   * a tile pays at most one extra batch for the first and none at all for the
   * second; both are null on a block that has no business with them.
   */
  p.dado = b.dado ?? null;
  p.dressMat = b.dress ?? null;
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE DISTRICT ACCENT, WHICH TWELVE AUTHORED LISTS HAD NOWHERE TO LAND.
   * ─────────────────────────────────────────────────────────────────────────
   * `DISTRICTS[*].accents` is documented in `palette.js` as "paint/render used
   * for a minority of buildings and for TRIM", and it is three hand-chosen
   * keys per district: `render_ochre`/`trim_red`/`steel_green` in the Strip,
   * `rust_deep`/`steel_dark`/`corrugated` in Steel Row, `render_cream`/
   * `trim_green` in Lawrenceville. Until now the pick was assigned to
   * `p.accent` and read by nothing — twelve district identities that cost a
   * draw and produced no pixels. `p.accentIsTrim`, which `buildElevation` has
   * always branched on to decide whether a SILL follows the joinery instead of
   * the stone, was dead for the same reason: nothing ever set it.
   *
   * The lists hold two classes of key and they land in two different places,
   * because a window frame painted `corrugated` is not a district identity, it
   * is a bug:
   *
   *   JOINERY class   `trim_*`, `timber_*`, `alu_*` — this is paint on wood or
   *                   on aluminium, so it becomes the building's own joinery,
   *                   and the sills follow it through `p.accentIsTrim`.
   *   BAND class      renders, sidings, steels, rusts, bricks — a wall
   *                   material, so it becomes the horizontal ACCENT BAND: the
   *                   string course where the archetype has one, and the base
   *                   moulding where it does not, which is the only band a
   *                   two-storey rowhouse carries.
   *
   * A MINORITY, per the authored intent, and drawn from `aux` — the side
   * stream — so wiring twelve dead lists in does not re-roll the city. The
   * accent is block-scoped, so "a third of a block" is what this reads as on
   * the street: two or three painted houses in a terrace, not a chequerboard.
   */
  const wearsAccent = aux.float() < 0.34 && p.arch !== 'curtain' && p.arch !== 'tower';
  p.accentIsTrim = wearsAccent && ACCENT_JOINERY.has(p.accent);
  if (p.accentIsTrim) p.trim = p.accent;
  p.accentBand = wearsAccent && !p.accentIsTrim ? p.accent : null;
  p.paints = b.paints ?? ['paint_red', 'paint_green', 'paint_cream'];
  p.awning = b.awning ?? rng.pick(['awning_canvas', 'awning_green', 'awning_navy']);
  p.signMat = b.signMat ?? rng.pick(['sign_board', 'trim_dark', 'trim_red', 'trim_green']);
  p.neon = b.neon ?? rng.pick(['neon_amber', 'neon_teal', 'neon_red']);
  p.doorMat = b.door ?? 'door_wood';
  return p;
}

// -------------------------------------------------------------- elevation --
/**
 * Build one elevation.
 *
 * `w` = {
 *   ax,az,bx,bz    the outer face line, world space
 *   nx,nz          outward normal
 *   y0             base of the wall
 *   floors         [{ y, h, kind }]  y relative to y0
 *   prog, rng, style
 *   front          this elevation faces the street
 *   blank          party wall: no openings at all
 *   collide        author collision proxies for this wall
 * }
 */
export function buildElevation(T, lib, w) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const len = wallBasis(_m, w.ax, w.az, w.bx, w.bz, w.nx, w.nz, w.y0, t);
  const basis = _m.clone();
  if (len < 0.6) return;

  const total = w.floors.reduce((s, f) => s + f.h, 0);

  // A curtain wall is not a wall with holes in it — it is a frame hung in front
  // of a floor plate, and punching 400 openings through an extruded shape to
  // fake one is both wrong and ruinously slow. Separate path.
  if (p.arch === 'curtain' && !w.blank) {
    curtainElevation(T, lib, w, basis, len, total);
    return;
  }

  if (w.blank) {
    // A party wall: one slab, no openings, and the ghost of the building that
    // used to be attached to it.
    const g = wallPanel(len, total, t, [], { seed: rng.float() * 20 });
    T.addOnce(w.blankSurface ?? p.masonry, g, basis);
    if (w.collide !== false) T.slabBox(surfaceTagOf(p.masonry), basis, 0, total / 2, len, total, t);
    if (len > 7 && total > 6 && rng.float() < 0.42) ghostSign(T, basis, len, total, t, p, rng);
    /**
     * GHOST-SIGN TERRITORY. A blank flank is the only surface in this city with
     * room for a painted wall sign, so it is published as one — inset a metre
     * from each arris and stopped below the cornice, because a hand-painted
     * sign that runs off the corner of the building reads as a decal.
     * `ghostSign` above may already have put the FADED one there; a mount is an
     * offer of the space, not a claim on it, and the two are allowed to coexist
     * the way a repainted flank does.
     */
    if (len > 8 && total > 7) {
      const fw = Math.min(len - 2.0, 16);
      const fh = Math.min(total - 2.4, 9);
      mountAt(T, basis, w, 'wall', 0, total * 0.55, t + 0.03, fw, fh);
    }
    return;
  }

  // --- bay layout -------------------------------------------------------
  const nBays = Math.max(1, Math.round(len / p.bayW));
  const bay = len / nBays;
  const cx = [];
  for (let i = 0; i < nBays; i++) cx.push(-len / 2 + (i + 0.5) * bay);

  /**
   * Which bays are blank on the upper floors. Real streets have chimney
   * breasts, party-wall stacks and plant risers; a facade where every bay has
   * a window at every level is the single clearest "generated" tell.
   */
  const blankBay = cx.map((_, i) => (nBays > 2 && rng.float() < 0.1 ? true : false));

  const winW = Math.min(p.winW, bay * 0.72);
  const glassMat = p.glass;
  const frameCls = sizeClass(winW, p.winH);

  // Prototypes this elevation will use.
  const frameId = Kit.frame(lib, p.trim, p.winStyle, frameCls);
  const glassId = Kit.glass(lib, glassMat);
  const roomId = Kit.room(lib, p.room, p.arch === 'curtain' ? 'shallow' : 'md');
  const litId = Kit.room(lib, rng.float() < 0.5 ? 'room_lit_warm' : 'room_lit_cool', 'shallow');
  const sillId = p.sill ? Kit.sill(lib, p.accentIsTrim ? p.trim : p.sillMat ?? 'stone_grey') : null;
  const lintelId = p.lintel ? Kit.lintel(lib, p.sillMat ?? 'stone_grey') : null;
  const boardId = p.boarded > 0 ? Kit.board(lib, 'timber') : null;
  const acId = p.acRate > 0 ? Kit.ac(lib, 'alu_dark') : null;
  const blindId = [0, 1, 2].map((s) => Kit.blind(lib, 'blind', s));

  /**
   * How many storeys get the full kit.
   *
   * Above about 18 m nobody on the pavement can resolve a sill nose, a blind
   * or a runoff stain, and paying an extruded panel plus five instanced parts
   * per opening for forty storeys is how a tower ends up costing more than the
   * rest of the block put together. Everything above `detail` is built from
   * piers and spandrels instead: the same punched-window geometry with the
   * same real depth, assembled from boxes at a ninth of the cost.
   */
  const detail = Math.min(w.floors.length, p.detailFloors ?? 5);

  // --- per-floor panels --------------------------------------------------
  // Floors repeat, so the expensive part (triangulating an extruded shape with
  // holes) is done once per distinct floor signature and the result is merged
  // as many times as the building is tall.
  const cache = new Map();
  const bandBox = plainBox();
  const bandQuad = quad(1, 1);
  let yAcc = 0;
  for (let fi = 0; fi < w.floors.length; fi++) {
    const f = w.floors[fi];
    const isGround = f.kind === 'ground';
    const y = yAcc;
    yAcc += f.h;

    if (isGround && p.ground !== 'plain') {
      buildGroundFloor(T, lib, w, basis, len, y, f.h, nBays, bay, cx);
      continue;
    }

    if (fi >= detail) {
      bandFloor(T, lib, w, basis, len, y, f.h, nBays, bay, cx, blankBay, winW, bandBox, bandQuad);
      continue;
    }

    // Window geometry for this floor.
    const holes = [];
    const wh = Math.min(p.winH, f.h - 0.8);
    const sy = Math.min(p.sillH, f.h - wh - 0.35);
    for (let i = 0; i < nBays; i++) {
      if (blankBay[i]) continue;
      holes.push({ x: cx[i], y: sy + wh / 2, w: winW, h: wh });
    }

    const sig = `${f.h.toFixed(2)}|${holes.length}|${wh.toFixed(2)}|${sy.toFixed(2)}`;
    let geo = cache.get(sig);
    if (!geo) {
      geo = wallPanel(len, f.h, t, holes, { seed: w.ax * 0.13 + fi });
      cache.set(sig, geo);
    }
    trs(_m2, 0, y, 0, 0);
    _m2.premultiply(basis);
    // Grime accumulates downward and in the crevices; the top floors of a
    // masonry building are always cleaner than the two above the pavement.
    const wash = Math.min(1, p.age * (1.15 - (y / Math.max(1, total)) * 0.5));
    T.add(f.kind === 'ground' ? p.masonry : p.masonry, geo, _m2, {
      masks: [0, wash * 0.28, 0],
    });

    // --- window furniture, per opening ---
    for (const h of holes) {
      placeWindow(T, lib, basis, {
        x: h.x,
        y: y + h.y,
        w: h.w,
        h: h.h,
        t,
        p,
        rng,
        frameId,
        glassId,
        roomId,
        litId,
        sillId,
        lintelId,
        boardId,
        blindId,
        floor: fi,
        lit: rng.float() < p.litRate,
      });
    }

    // --- air conditioners and satellite dishes on the residential blocks ---
    if (acId && fi > 0) {
      for (const h of holes) {
        if (rng.float() > p.acRate) continue;
        const s = Math.min(1, h.w * 0.85) * rng.range(0.88, 1.08);
        T.putM(acId, basis, h.x + rng.range(-0.06, 0.06), y + h.y - h.h * 0.34, t, rng.range(-0.05, 0.05), s, rng.range(0.9, 1.1), 1, [
          rng.range(0.3, 1),
          rng.range(0.3, 1),
          0.3,
        ]);
        stain(T, lib, basis, p, h.x, y + h.y - h.h * 0.5, t, h.w * 0.5, rng.range(0.9, 2.2), rng);
      }
    }

    // --- string course between floors ---
    if (p.stringCourse && fi > 0 && fi < w.floors.length - 1) {
      const band = moulding(len, [
        [-0.02, 0],
        [0.075, 0.02],
        [0.075, 0.16],
        [-0.02, 0.19],
      ]);
      trs(_m2, 0, y - 0.09, t, 0);
      _m2.premultiply(basis);
      // The band a district accent lands on when it is a wall material, and
      // the terracotta dressing where a downtown block carries one. Neither is
      // a new batch in the tile it appears in — see `blockPalette`.
      T.addOnce(p.accentBand ?? p.dressMat ?? p.sillMat ?? 'stone_grey', band, _m2);
    }
  }

  for (const g of cache.values()) g.dispose();
  bandBox.dispose();
  bandQuad.dispose();

  /**
   * Collision. The ground floor is authored EXACTLY, from the same numbers
   * that cut the openings, so a doorway is a real gap you can walk through.
   * Above it the wall is one slab: the openings are glazed, nothing walks in
   * through a third-floor window, and forty exact slabs per elevation would
   * put a hundred thousand triangles per tile into the BVH for nothing.
   */
  if (w.collide !== false) {
    const g0 = w.floors[0]?.kind === 'ground' ? w.floors[0].h : 0;
    if (total - g0 > 0.3) {
      T.slabBox(surfaceTagOf(p.masonry), basis, 0, g0 + (total - g0) / 2, len, total - g0, t);
    }
  }

  // --- balconies ---------------------------------------------------------
  if (p.balcony > 0 && w.front) {
    const slabId = Kit.balconySlab(lib, 'concrete_wall');
    const railId = Kit.balconyRail(lib, p.trim, rng.float() < 0.4 ? 'panel' : 'bar');
    let yy = w.floors[0].h;
    for (let fi = 1; fi < w.floors.length; fi++) {
      const f = w.floors[fi];
      for (let i = 0; i < nBays; i++) {
        if (rng.float() > p.balcony) continue;
        const bw = Math.min(bay * 0.86, 3.2) * rng.range(0.92, 1.06);
        const mk = [rng.range(0.3, 1), p.age * rng.range(0.4, 1.1), rng.range(0.2, 0.5)];
        T.putM(slabId, basis, cx[i], yy + 0.42, t, 0, bw, 1, rng.range(0.9, 1.12), mk);
        T.putM(railId, basis, cx[i], yy + 0.47, t, 0, bw, rng.range(0.94, 1.06), 1, mk);
        stain(T, lib, basis, p, cx[i], yy + 0.36, t, bw * 0.6, rng.range(0.8, 2.4), rng, 0.6);
      }
      yy += f.h;
    }
  }

  // --- fire escape -------------------------------------------------------
  /**
   * Centred on a window bay (it has to be reachable from inside) and scaled so
   * its flight spans exactly one storey.
   *
   * WHICH ELEVATION. `w.escape` — decided by the caller, which is the only
   * place that can see all four elevations at once and therefore the only
   * place that can put ONE escape on the building instead of one per wall.
   * It used to key off `w.front`, which is wrong twice over: a fire escape
   * hangs off the flank or the rear yard of a Lawrenceville rowhouse and a
   * Strip loft, not across its shopfront, and keying off `front` meant a
   * corner building grew two of them at right angles to each other.
   */
  if (p.fireEscape && w.escape && len > 6 && w.floors.length > 1) {
    const feId = Kit.fireEscape(lib, rng.float() < 0.5 ? 'steel_dark' : 'rust');
    const bi = Math.max(0, Math.min(nBays - 1, Math.floor(nBays / 2) + rng.int(-1, 1)));
    const fx = cx[bi];
    let yy = w.floors[0].h;
    for (let fi = 1; fi < w.floors.length; fi++) {
      const s = w.floors[fi].h / 3.2;
      T.putM(feId, basis, fx, yy + 0.06, t + 0.02, 0, s, s, s, [
        rng.range(0.5, 1),
        rng.range(0.4, 1),
        0.3,
      ]);
      yy += w.floors[fi].h;
    }
    // the wall brackets the whole run hangs off
    const brk = plainBox();
    let by = w.floors[0].h;
    for (let fi = 1; fi < w.floors.length; fi++) {
      for (const s of [-1, 1]) {
        trs(_m2, fx + s * 1.0, by - 0.4, t + 0.35, 0, 0.07, 0.07, 0.7, 0, s * 0.6);
        _m2.premultiply(basis);
        // 7 cm angle. It goes where the landings it carries go — see the note
        // on `Kit.fireEscape`; a bracket that cast while the escape did not
        // would be a floating shadow with no stair in it.
        T.add('steel_dark', brk, _m2, { masks: [0.8, 0.6, 0.3], noShadow: true });
      }
      by += w.floors[fi].h;
    }
    brk.dispose();
  }

  // --- downpipes ---------------------------------------------------------
  {
    const dpId = Kit.downpipe(lib, 'steel_light');
    const n = Math.max(1, Math.round(len / 16));
    for (let i = 0; i < n; i++) {
      const px = -len / 2 + ((i + 0.5) / n) * len + rng.range(-0.6, 0.6);
      // never straight through a window: snap to the bay joint
      const snapped = Math.round((px + len / 2) / bay) * bay - len / 2;
      T.putM(dpId, basis, snapped, 0, t, 0, 1, total, 1);
      stain(T, lib, basis, p, snapped, total * 0.55, t, 0.5, 2.4, rng, 0.5);
    }
  }

  // --- base course + cornice + parapet ------------------------------------
  buildBase(T, lib, basis, len, t, p, rng, w);
  buildCrown(T, lib, basis, len, total, t, p, rng, w);
}

/**
 * Where the building meets the ground.
 *
 * A wall that runs straight into the pavement is the tell that a building was
 * extruded rather than built. Real ones have a plinth: a projecting course in
 * a harder, darker stone, 0.4-0.9 m tall, with a weathered top edge and the
 * road splash up its face — plus, on anything with a cellar, air bricks and a
 * light well at pavement level.
 */
function buildBase(T, lib, basis, len, t, p, rng, w) {
  if (p.arch === 'curtain') {
    /**
     * A glass tower has a plinth too — a granite kerb-to-cill course under the
     * lobby glazing, squared rather than moulded. Skipping it was one half of
     * the critics' "buildings do not meet the ground: no plinth, no kerb, no
     * gutter, no threshold, they are extrusions pushed through a terrain
     * plane"; the other half is that this elevation type never called this
     * function at all.
     */
    const gh = 0.52;
    const g = moulding(len, [
      [-0.02, 0],
      [0.13, 0],
      [0.13, gh - 0.04],
      [0.09, gh],
      [-0.02, gh],
    ]);
    trs(_m2, 0, 0, t, 0);
    _m2.premultiply(basis);
    T.addOnce(p.sillMat ?? 'stone_grey', g, _m2, { masks: [0.35, 0.7, 0.4] });
    return;
  }
  const h = p.baseH ?? rng.range(0.42, 0.85);
  const proj = rng.range(0.05, 0.11);
  const g = moulding(len, [
    [-0.02, 0],
    [proj, 0],
    [proj, h - 0.06],
    [proj - 0.05, h],
    [-0.02, h],
  ]);
  trs(_m2, 0, 0, t, 0);
  _m2.premultiply(basis);
  /**
   * A rowhouse and a house have no string course, so the base moulding is the
   * only horizontal band they carry and it is where their district accent has
   * to land — otherwise `render_cream` in Lawrenceville and `siding_grey` on
   * Troy Hill would be authored, drawn from, and still invisible. Where the
   * elevation DOES have a string course the accent went there and the plinth
   * keeps the foundation stone, which is the right way round: you do not paint
   * the course that takes the road splash.
   */
  const baseMat = p.stringCourse ? (p.baseMat ?? 'stone_grey') : (p.accentBand ?? p.baseMat ?? 'stone_grey');
  T.addOnce(baseMat, g, _m2, { masks: [0.5, 0.75, 0.35] });

  // air bricks / cellar lights along the plinth
  if (!w.front || len < 4) return;
  const box = plainBox();
  const n = Math.max(1, Math.round(len / 4.5));
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + ((i + 0.5) / n) * len + rng.range(-0.5, 0.5);
    if (rng.float() < 0.35) continue;
    trs(_m2, x, h * 0.55, t - 0.07, 0, 0.62, 0.34, 0.16);
    _m2.premultiply(basis);
    T.add('room_dark', box, _m2, { masks: [0, 0.4, 0.8] });
    // The grille over it: 3 cm bars, RECESSED 5 cm into the plinth. Nothing it
    // could cast onto is outside its own reveal.
    for (let b = 0; b < 4; b++) {
      trs(_m2, x, h * 0.55, t - 0.02, 0, 0.62, 0.03, 0.05);
      _m2.premultiply(basis);
      T.add('steel_dark', box, _m2, { masks: [0.7, 0.6, 0.4], noShadow: true });
      trs(_m2, x - 0.22 + b * 0.15, h * 0.55, t - 0.02, 0, 0.035, 0.34, 0.05);
      _m2.premultiply(basis);
      T.add('steel_dark', box, _m2, { masks: [0.7, 0.6, 0.4], noShadow: true });
    }
  }
  box.dispose();
}

/**
 * A curtain wall: spandrel band, glazing band, vertical mullion fins, a
 * transom at every floor line. The fins are what give a glass tower its
 * vertical grain and its dawn/dusk edge highlight — without them a tower is a
 * mirrored slab and reads as a placeholder from any distance.
 */
export function curtainElevation(T, lib, w, basis, len, total) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const band = plainBox();
  const spandrel = 1.05;
  const finEvery = p.bayW;
  const nFins = Math.max(2, Math.round(len / finEvery));
  const glassId = p.glass;
  const roomBand = quad(1, 1);

  let y = 0;
  for (let fi = 0; fi < w.floors.length; fi++) {
    const f = w.floors[fi];
    const isGround = f.kind === 'ground';
    if (isGround) {
      buildLobby(T, lib, w, basis, len, y, f.h, nFins, len / nFins, []);
      y += f.h;
      continue;
    }
    // spandrel (the opaque strip that hides the floor slab)
    trs(_m2, 0, y + spandrel / 2, t - 0.09, 0, len, spandrel, 0.18);
    _m2.premultiply(basis);
    T.add(p.masonry, band, _m2, { masks: [0.25, 0.32, 0.15] });

    // glazing
    const gh = f.h - spandrel;
    const gy = y + spandrel + gh / 2;
    trs(_m2, 0, gy, t - 0.16, 0, len, gh, 0.05);
    _m2.premultiply(basis);
    T.add(glassId, band, _m2, { masks: [0, 0.18, 0] });
    // the floor plate behind the glass, so the tower is not hollow glass
    trs(_m2, 0, gy, t - 0.55, 0, len, gh, 1);
    _m2.premultiply(basis);
    T.add(rng.float() < 0.35 ? 'room_lit_cool' : 'room_mid', roomBand, _m2, {
      masks: [0, 0.1, 0.45],
    });
    trs(_m2, 0, y + spandrel + 0.02, t - 0.36, 0, len, 0.06, 0.68);
    _m2.premultiply(basis);
    T.add('room_mid', band, _m2, { masks: [0, 0.2, 0.5] });

    // transom
    trs(_m2, 0, y + f.h - 0.05, t - 0.05, 0, len, 0.11, 0.26);
    _m2.premultiply(basis);
    T.add(p.trim, band, _m2, { masks: [0.3, 0.2, 0.1] });
    y += f.h;
  }
  roomBand.dispose();

  // vertical fins, full height
  for (let i = 0; i <= nFins; i++) {
    const x = -len / 2 + (i / nFins) * len;
    trs(_m2, x, w.floors[0].h + (total - w.floors[0].h) / 2, t + 0.04, 0, 0.13, total - w.floors[0].h, 0.3);
    _m2.premultiply(basis);
    T.add(p.trim, band, _m2, { masks: [0.35, 0.18, 0.1] });
  }
  // corner pilaster: stops two curtain walls meeting in a raw mitre
  for (const s of [-1, 1]) {
    trs(_m2, (s * len) / 2, total / 2, t - 0.02, 0, 0.42, total, 0.5);
    _m2.premultiply(basis);
    T.add(p.masonry, band, _m2, { masks: [0.3, 0.3, 0.15] });
  }
  band.dispose();

  if (w.collide !== false) {
    const g0 = w.floors[0]?.kind === 'ground' ? w.floors[0].h : 0;
    if (total - g0 > 0.3) {
      T.slabBox(surfaceTagOf(p.masonry), basis, 0, g0 + (total - g0) / 2, len, total - g0, t);
    }
  }
  buildBase(T, lib, basis, len, t, p, rng, w);
  buildCrown(T, lib, basis, len, total, t, p, rng, w);
}

/**
 * One upper floor, assembled from piers and spandrels.
 *
 * This is a punched-window wall, not a band: the piers stand PROUD of the
 * glass by the full reveal depth, the head and the sill spandrel do the same,
 * and the glazing plane sits back behind them with a room plane behind that.
 * From the street it is indistinguishable from the extruded panel below it,
 * which is the whole point — the LOD transition has to be a change of cost,
 * not a change of architecture.
 */
function bandFloor(T, lib, w, basis, len, y, h, nBays, bay, cx, blankBay, winW, box, pane) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const wh = Math.min(p.winH, h - 0.8);
  const sy = Math.min(p.sillH, h - wh - 0.35);
  /**
   * The reveal. Deepened from 0.19 to 0.62 of the wall thickness because this
   * band IS the elevation on anything above five storeys — a forty-storey tower
   * is four detail floors and thirty-six of these — and 19 cm of setback under
   * an overcast sky produces a shadow line one value deep, which reads as a
   * printed stripe rather than a hole. The jamb shadow is the cheapest depth cue
   * in architecture and it scales with the setback.
   */
  const back = Math.min(0.26, t * 0.62);

  // sill spandrel and head spandrel, full width, on the wall plane
  trs(_m2, 0, y + sy / 2, t / 2, 0, len, sy, t);
  _m2.premultiply(basis);
  T.add(p.masonry, box, _m2, { masks: [0.1, p.age * 0.35, 0.1] });
  const headH = h - sy - wh;
  trs(_m2, 0, y + sy + wh + headH / 2, t / 2, 0, len, headH, t);
  _m2.premultiply(basis);
  T.add(p.masonry, box, _m2, { masks: [0.1, p.age * 0.3, 0.15] });

  /**
   * Glazing, in OPAQUE segments rather than one transparent plane.
   *
   * Three things wrong with the plane it replaces. It was the building's real
   * transparent glass, so a tower drew thirty-six sorted transparent bands per
   * elevation, stayed out of the depth prepass, and let the sky through the
   * window field — a tower literally dissolving into the sky it is supposed to
   * be silhouetted against. It was one unbroken run per floor, so the whole
   * elevation lit or unlit together after dark. And it sat 4 cm in front of a
   * flat room quad, which is not depth, it is a sandwich.
   *
   * Segments are 3-5 m of curtain wall each and pick their own state, so a
   * night tower has a scatter of lit floors and part-floors instead of stripes,
   * and a day tower has panel-to-panel value variation across its face.
   */
  const gy = y + sy + wh / 2;
  const dark = /bronze|grimy/.test(p.glass) ? 'glass_solid_warm' : 'glass_solid';
  const nSeg = Math.max(1, Math.round(len / rng.range(3.4, 5.2)));
  for (let s = 0; s < nSeg; s++) {
    const sw = len / nSeg;
    const sx = -len / 2 + (s + 0.5) * sw;
    const lit = rng.float() < p.litRate;
    trs(_m2, sx, gy, t - back, 0, sw * 0.995, wh, 0.06);
    _m2.premultiply(basis);
    T.add(lit ? 'room_lit_warm' : dark, box, _m2, {
      masks: [0, p.age * rng.range(0.15, 0.5), lit ? 0.1 : rng.range(0.15, 0.4)],
    });
  }
  // One transom across the floor: a horizontal shadow line inside the reveal,
  // which is what stops a deep band reading as a slot.
  trs(_m2, 0, gy + wh * 0.16, t - back + 0.05, 0, len, 0.09, 0.1);
  _m2.premultiply(basis);
  T.add(p.trim, box, _m2, { masks: [0.3, p.age * 0.3, 0.2] });

  // piers between the bays: these are what give the wall its vertical rhythm
  // and its reveal shadow, so they must reach the full outer face.
  const pierW = Math.max(0.35, bay - winW);
  for (let i = 0; i <= nBays; i++) {
    const px = -len / 2 + (i / nBays) * len;
    const ww = i === 0 || i === nBays ? pierW * 1.4 : pierW;
    trs(_m2, px, y + sy + wh / 2, t / 2, 0, ww, wh, t);
    _m2.premultiply(basis);
    T.add(p.masonry, box, _m2, { masks: [0.15, p.age * 0.3, 0.12] });
  }
  // Blank bays get filled in solid, same as below. 6 mm proud of the piers:
  // the fill is a full bay wide and the piers sit ON the bay lines, so at the
  // wall plane the two would share a coplanar front face over half a pier's
  // width and z-fight.
  for (let i = 0; i < nBays; i++) {
    if (!blankBay[i]) continue;
    trs(_m2, cx[i], y + sy + wh / 2, t / 2 + 0.006, 0, bay, wh, t);
    _m2.premultiply(basis);
    T.add(p.masonry, box, _m2, { masks: [0.15, p.age * 0.35, 0.12] });
  }
  // a sill course under the glazing, one run for the whole floor
  if (p.sill) {
    trs(_m2, 0, y + sy - 0.02, t + 0.03, 0, len, 0.09, 0.16);
    _m2.premultiply(basis);
    T.add(p.sillMat ?? 'stone_grey', box, _m2, { masks: [0.45, 0.5, 0.3] });
  }
}

/**
 * A ghost sign: the hand-painted advertisement left on a party wall by the
 * building that used to stand against it.
 *
 * These are not decoration in Pittsburgh, they are the vernacular — every
 * demolished rowhouse leaves a brick flank with SANDBLASTING, FEED & GRAIN or a
 * beer brand fading off it, and a rustbelt street without them looks scrubbed.
 *
 * Built with zero new materials, which is what makes it affordable on every
 * party wall in the city: the FIELD is one of the block's three shopfront
 * paints (already in the tile's batch list) worn back to 85%, and the LETTERS
 * are the wall's own masonry standing 1 cm proud of the field — which is
 * literally how a ghost sign reads, as brick showing through where the paint
 * has gone. No text rendering, no atlas, no alpha.
 */
function ghostSign(T, basis, len, total, t, p, rng) {
  const paint = p.paints?.[0] ?? 'paint_cream';
  const w = Math.min(len * rng.range(0.5, 0.82), 15);
  const h = Math.min(total * rng.range(0.24, 0.42), 7.5);
  const gx = rng.range(-(len - w) / 2, (len - w) / 2);
  const gy = total * rng.range(0.42, 0.72);
  const box = plainBox();

  // The painted field. Heavy wear so the brick reads through it everywhere, and
  // heavy grime at the bottom edge where eighty years of runoff have crossed it.
  trs(_m2, gx, gy, t + 0.012, rng.range(-0.008, 0.008), w, h, 0.02);
  _m2.premultiply(basis);
  T.add(paint, box, _m2, { masks: [rng.range(0.62, 0.9), rng.range(0.4, 0.8), 0.1] });

  // Two or three lines of "lettering", as blocks of wall showing through. Word
  // lengths vary down the sign the way a real one does — a big word, a long
  // strapline, a phone number.
  const lines = rng.int(2, 3);
  let ly = gy + h * 0.5;
  for (let l = 0; l < lines; l++) {
    const lh = (h / lines) * rng.range(0.4, 0.62);
    ly -= (h / lines) * 0.5 + (l === 0 ? 0 : (h / lines) * 0.5);
    const lw = w * (l === 0 ? rng.range(0.62, 0.86) : rng.range(0.34, 0.7));
    const nGl = Math.max(3, Math.round(lw / (lh * 0.78)));
    const gw = (lw / nGl) * 0.72;
    for (let i = 0; i < nGl; i++) {
      if (rng.float() < 0.14) continue; // a letter entirely gone
      const cxg = -lw / 2 + (i + 0.5) * (lw / nGl);
      trs(_m2, gx + cxg, ly, t + 0.026, 0, gw, lh, 0.016);
      _m2.premultiply(basis);
      T.add(p.masonry, box, _m2, { masks: [rng.range(0.2, 0.6), rng.range(0.5, 0.95), 0.15] });
    }
  }
  box.dispose();

  // The paint sheds water differently from the brick, so the wall below a ghost
  // sign always carries its outline in runoff.
  stain(T, null, basis, p, gx, gy - h * 0.5, t, w * 0.42, rng.range(1.2, 3.4), rng, 0.5);
}

/** A runoff stain merged into the wall's own batch. */
function stain(T, lib, basis, p, x, y, t, width, len, rng, amount = 0.85) {
  if (len < 0.2) return;
  const g = runoffStreak(rng, Math.max(0.28, width * 1.5), len, { amount });
  trs(_m2, x, y, t + 0.012, 0);
  _m2.premultiply(basis);
  T.addOnce(p.masonry, g, _m2);
}

/** Frame, glass, room, sill, lintel, blind — one opening's worth. */
function placeWindow(T, lib, basis, o) {
  const { x, y, w, h, t, p, rng } = o;
  // The reveal. Everything the critics measure about a facade lives in this
  // number: the frame sits 8-16 cm back inside 34 cm of masonry, so the jamb
  // throws a hard shadow down one side of every opening at every hour, and the
  // head throws one across the top. A frame flush with the wall plane is a
  // painted rectangle no matter what the texture does.
  const inset = Math.min(0.27, t * 0.68) * rng.range(0.9, 1.1);
  /**
   * Per-instance dirt, so no two openings in a run are the same — but the GRIME
   * on a frame is now half what it was.
   *
   * A painted sash is the one part of a masonry elevation that gets repainted,
   * so it is always cleaner than the brick around it, and it is the only light
   * value inside the opening. Griming it to the same value as the reveal was
   * half of why an opening read as a solid black rectangle with a stone bar
   * over it: there was nothing in the hole for the eye to find the depth
   * against. The wall keeps its full weathering; the joinery does not.
   */
  const dirt = [rng.range(0, 0.3), p.age * rng.range(0.12, 0.5), rng.range(0, 0.2)];
  const gDirt = [0, p.age * rng.range(0.15, 0.85), 0];
  // A sash that has been painted a dozen times never sits quite square.
  const tilt = rng.range(-0.004, 0.004);

  T.putM(o.frameId, basis, x, y, t - inset, tilt, w, h, 1, dirt);
  T.putM(o.glassId, basis, x, y, t - inset - 0.012, tilt, w * 0.985, h * 0.985, 1, gDirt);
  const room = o.lit ? o.litId : o.roomId;
  T.putM(room, basis, x, y, t - inset - 0.03, 0, w * 0.99, h * 0.99, 1);

  if (o.boardId && rng.float() < p.boarded) {
    T.putM(o.boardId, basis, x, y, t - inset + 0.03, rng.range(-0.02, 0.02), w, h, 1, [
      rng.range(0.4, 1),
      rng.range(0.3, 0.9),
      0.2,
    ]);
    return;
  }
  if (rng.float() < p.blinds) {
    const s = rng.int(0, 2);
    T.putM(o.blindId[s], basis, x, y, t - inset - 0.05, 0, w * 0.94, h * 0.96, 1);
  }
  if (o.sillId) {
    T.putM(o.sillId, basis, x, y - h / 2 - 0.045, t, 0, w + 0.26, 1, 1, [
      rng.range(0.3, 0.9),
      p.age * rng.range(0.4, 1),
      0.3,
    ]);
    if (rng.float() < 0.55) {
      stain(T, lib, basis, p, x, y - h / 2 - 0.06, t, w * 0.5, rng.range(0.6, 1.9), rng, 0.7);
    }
  }
  if (o.lintelId) {
    T.putM(o.lintelId, basis, x, y + h / 2 + 0.02, t, 0, w + 0.34, 1, 1, [
      rng.range(0.25, 0.8),
      p.age * rng.range(0.3, 0.9),
      0.2,
    ]);
  }
}

// ------------------------------------------------------------ ground floor --
/**
 * The first three metres.
 *
 * A GTA V street reads because the ground floor is a different building from
 * the one above it: recessed shopfronts, stall risers, fascias, awnings, blade
 * signs, shutters half down, a stoop, a basement areaway. Everything here is
 * placed relative to the SAME wall line as the floors above, so the change of
 * plane at the fascia is real geometry.
 */
function buildGroundFloor(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;

  if (p.ground === 'dock') return buildDock(T, lib, w, basis, len, y, h, nBays, bay, cx);
  if (p.ground === 'lobby') return buildLobby(T, lib, w, basis, len, y, h, nBays, bay, cx);
  if (p.ground === 'porch') return buildPorch(T, lib, w, basis, len, y, h, nBays, bay, cx);
  if (p.ground === 'stoop' || !w.front) return buildStoopFront(T, lib, w, basis, len, y, h, nBays, bay, cx);
  return buildShopfront(T, lib, w, basis, len, y, h, nBays, bay, cx);
}

function buildShopfront(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const fasciaH = 0.62;
  const openH = h - fasciaH - 0.32;
  const stall = 0.42; // stall riser under the glass

  // Units along the frontage: one or two shops per elevation.
  const nUnits = Math.max(1, Math.round(len / rng.range(6.5, 11)));
  const unit = len / nUnits;

  /**
   * A frontage this narrow has no room for a shop, and pretending otherwise
   * emits geometry that is inside out.
   *
   * `ow` is `unit - 0.9` and the glazing beside the door is `ow - 1.14`, so a
   * returned flank or a lot the kerb clip has cut down to a metre or two takes
   * BOTH negative. A negative width is not a small shopfront: `trs` composes it
   * as a negative scale, the placement matrix's determinant goes negative, and
   * every fitting hung on it — frame, glass, room box, stall riser — is
   * mirrored, which re-winds its faces while `Accum` carries the normals
   * through unchanged. That is the same normal-versus-winding disagreement
   * `wallBasis` used to produce wholesale, and the g-buffer cannot recover from
   * it. It also punches an inverted rectangle into the wall's extruded shape.
   *
   * Measured before this guard: 720 triangles across the `street` frame,
   * concentrated in `room_mid` and the painted stall risers.
   */
  if (unit < 2.6) return buildStoopFront(T, lib, w, basis, len, y, h, nBays, bay, cx);

  const holes = [];
  for (let u = 0; u < nUnits; u++) {
    const ux = -len / 2 + (u + 0.5) * unit;
    holes.push({ x: ux, y: 0.32 + openH / 2, w: unit - 0.9, h: openH });
  }
  const g = wallPanel(len, h, t, holes, { seed: w.ax * 0.31 + 7 });
  trs(_m2, 0, y, 0, 0);
  _m2.premultiply(basis);
  T.addOnce(p.masonry, g, _m2, { masks: [0, p.age * 0.4, 0] });
  if (w.collide !== false) {
    for (const s of solidSlabs(len, h, holes)) {
      T.slabBox(surfaceTagOf(p.masonry), basis, s.x, y + s.y, s.w, s.h, t);
    }
  }

  const glazing = 'glass_plain';
  const glassId = Kit.glass(lib, p.age > 0.6 ? 'glass_grimy' : glazing);
  const roomId = Kit.room(lib, 'room_mid', 'deep');
  const litRoomId = Kit.room(lib, 'room_lit_warm', 'deep');
  /** What is behind a transom light: the top of the shop, and it is dark. */
  const transomRoomId = Kit.room(lib, 'room_dark', 'shallow');
  
  
  const signId = Kit.signBoard(lib, p.signMat);
  const faceId = Kit.signFace(lib, p.neon);
  const bladeId = Kit.bladeSign(lib, p.signMat);
  const awnId = Kit.awning(lib, p.awning);
  const awnFrameId = Kit.awningFrame(lib, 'steel_dark');
  const shutterIds = [0, 1, 2].map((s) => Kit.shutter(lib, 'shutter', s));
  /**
   * THE STALL RISER IS THE DADO. `palette.js` shipped `brick_glazed` and
   * `brick_glazed_green` with the note that half the commercial ground floors
   * on Butler St carry a band of cream or bottle-green glazed brick at eye
   * level, and that "it is the detail that says shop from across the street
   * because it is the only wet-looking masonry on the elevation" — and then
   * every stall riser in the city drew flat `stone_grey`. This is the course
   * that band goes on: the panel under the shop glass, at eye level, facing
   * the pavement. Block-scoped, so a tile pays one extra batch for it and a
   * whole parade is glazed by the same builder, which is what a parade is.
   */
  const stallId = Kit.sill(lib, p.dado ?? 'stone_grey', 'deep');

  for (let u = 0; u < nUnits; u++) {
    const ux = -len / 2 + (u + 0.5) * unit;
    const ow = unit - 0.9;
    const recess = rng.float() < 0.75 ? rng.range(0.45, 1.15) : 0.1;
    const zf = t - recess; // plane of the shop glazing
    // Every unit is its own business, so every unit picks its own paint.
    const paint = p.paints[rng.int(0, p.paints.length - 1)];

    const shut = rng.float();
    if (shut < 0.18) {
      // closed up: shutter all the way down, nothing else to see
      T.putM(shutterIds[2], basis, ux, y + 0.32 + openH / 2, t - 0.06, 0, ow, openH, 1);
    } else {
      // reveal jambs + soffit so the recess has real sides
      if (recess > 0.15) {
        const jamb = plainBox();
        for (const s of [-1, 1]) {
          trs(_m2, ux + s * (ow / 2 + 0.03), y + 0.32 + openH / 2, zf + recess / 2, 0, 0.08, openH, recess);
          _m2.premultiply(basis);
          T.add(p.masonry, jamb, _m2, { masks: [0.3, 0.5, 0.5] });
        }
        trs(_m2, ux, y + 0.32 + openH - 0.04, zf + recess / 2, 0, ow + 0.1, 0.09, recess);
        _m2.premultiply(basis);
        T.add(p.masonry, jamb, _m2, { masks: [0.2, 0.55, 0.7] });
        trs(_m2, ux, y + 0.03, zf + recess / 2, 0, ow + 0.1, 0.07, recess);
        _m2.premultiply(basis);
        T.add('stone_grey', jamb, _m2, { masks: [0.5, 0.7, 0.5] });
        jamb.dispose();
      }

      // door to one side, glazing across the rest
      const doorW = 1.0;
      const side = rng.float() < 0.5 ? -1 : 1;
      const dx = ux + side * (ow / 2 - doorW / 2 - 0.06);
      const glassW = ow - doorW - 0.14;
      const gx = ux - side * (doorW / 2 + 0.07);

      T.putM(Kit.door(lib, paint, 'glazed'), basis, dx, y + 0.32 + (openH - 0.35) / 2, zf, 0, doorW, openH - 0.35, 1);
      /**
       * THE TRANSOM over the entrance. The strip of glass above a shop door,
       * with its own bar under it, and the single cheapest way to stop a
       * recessed entrance reading as a rectangular hole: the bar is a hard
       * horizontal at head height, lit from a different angle than the glass
       * above and below it, so the opening acquires a top before the eye gets
       * to the fascia. Every pre-war Pittsburgh storefront has one.
       */
      {
        const th = 0.34;
        const ty = y + 0.32 + openH - th / 2 - 0.06;
        T.putM(transomRoomId, basis, dx, ty, zf - 0.04, 0, doorW * 0.96, th, 1);
        T.putM(glassId, basis, dx, ty, zf + 0.01, 0, doorW * 0.96, th, 1, [0, p.age * 0.4, 0]);
        const bar = plainBox();
        trs(_m2, dx, ty - th / 2 - 0.04, zf + 0.04, 0, doorW + 0.1, 0.09, 0.1);
        _m2.premultiply(basis);
        // 9 cm deep, standing inside a recessed entrance that is already in
        // shadow. It is a shading line, never a cascade's business — see
        // `TileBuilder.add`'s `noShadow`.
        T.add(paint, bar, _m2, { masks: [0.5, 0.5, 0.3], noShadow: true });
        bar.dispose();
      }
      T.putM(Kit.frame(lib, paint, 'shop', 'lg'), basis, gx, y + stall + (openH - stall) / 2 + 0.16, zf, 0, glassW, openH - stall - 0.1, 1);
      T.putM(glassId, basis, gx, y + stall + (openH - stall) / 2 + 0.16, zf - 0.02, 0, glassW * 0.98, (openH - stall - 0.1) * 0.98, 1);
      const lit = rng.float() < 0.75;
      const rh = openH - stall - 0.1;
      const ry2 = y + stall + (openH - stall) / 2 + 0.16;
      T.putM(lit ? litRoomId : roomId, basis, gx, ry2, zf - 0.05, 0, glassW, rh, 1);
      // fit it out — a counter, shelving, cartons
      T.putM(Kit.shopFit(lib, lit ? 'room_lit_warm' : 'room_mid'), basis, gx, ry2, zf - 0.12, 0, glassW * 0.9, rh, rh * 1.1);
      // stall riser
      T.putM(stallId, basis, gx, y + stall, zf + 0.02, 0, glassW + 0.16, 1, 1);
      const riser = plainBox();
      trs(_m2, gx, y + stall / 2, zf - 0.04, 0, glassW + 0.1, stall, 0.1);
      _m2.premultiply(basis);
      T.add(paint, riser, _m2, { masks: [0.6, 0.7, 0.3] });
      // painted pilasters framing the unit — the vertical that separates one
      // shop from the next and stops a terrace reading as one long window
      for (const s of [-1, 1]) {
        trs(_m2, ux + s * (ow / 2 + 0.24), y + h / 2 - 0.2, t + 0.05, 0, 0.4, h - 0.4, 0.14);
        _m2.premultiply(basis);
        T.add(paint, riser, _m2, { masks: [0.45, 0.55, 0.3] });
      }
      riser.dispose();

      if (shut < 0.34) {
        T.putM(shutterIds[rng.int(0, 1)], basis, ux, y + 0.32 + openH / 2, t - 0.05, 0, ow, openH, 1);
      }
    }

    // the painted ground-floor surround: everything between the pilasters and
    // under the fascia takes the unit's colour, which is what actually makes a
    // high street read as a row of separate businesses
    {
      const sur = plainBox();
      trs(_m2, ux, y + h - fasciaH - 0.28, t + 0.03, 0, unit - 0.2, 0.42, 0.1);
      _m2.premultiply(basis);
      T.add(paint, sur, _m2, { masks: [0.4, 0.5, 0.25] });
      sur.dispose();
    }

    // fascia + signage: a painted board with a lit sign on it, and a cornice
    // over the top so the shopfront is capped rather than just stopping
    const fascia = chamferBox(1, 1, 1, 0.015);
    trs(_m2, ux, y + h - fasciaH / 2 - 0.06, t + 0.07, 0, unit - 0.2, fasciaH, 0.16);
    _m2.premultiply(basis);
    T.add(paint, fascia, _m2, { masks: [0.5, 0.4, 0.2] });
    trs(_m2, ux, y + h + 0.06, t + 0.12, 0, unit - 0.1, 0.14, 0.28);
    _m2.premultiply(basis);
    T.add(p.sillMat ?? 'stone_grey', fascia, _m2, { masks: [0.55, 0.5, 0.3] });
    fascia.dispose();
    /**
     * THE MOUNTS. Published from the SAME numbers that just built the fascia,
     * which is the only reason they can be trusted: a mount derived from the
     * programme rather than from the placement would drift the moment a unit
     * was narrowed, recessed or dropped, and the signage layer has no way to
     * see that it had.
     *
     * The fascia field is the board itself, less a 20 cm margin so a name is
     * never jammed against the pilaster beside it. The blade anchor hangs off
     * the top corner of the unit furthest from the party wall.
     */
    mountAt(
      T,
      basis,
      w,
      'fascia',
      ux,
      y + h - fasciaH / 2 - 0.06,
      t + 0.16,
      Math.max(0.8, unit - 0.4),
      fasciaH * 0.82
    );
    if (unit > 4.2) {
      mountAt(T, basis, w, 'blade', ux + unit * 0.34, y + h - 0.45, t + 0.05, 1.15, 0.95);
    }
    T.putM(
      faceId,
      basis,
      ux,
      y + h - fasciaH / 2 - 0.06,
      t + 0.16,
      0,
      (unit - 0.5) * rng.range(0.5, 0.8),
      fasciaH * rng.range(0.4, 0.6),
      1
    );

    if (rng.float() < 0.5) {
      const aw = unit - 0.5;
      T.putM(awnId, basis, ux, y + h - fasciaH - 0.16, t + 0.02, 0, aw, 1, 1);
      T.putM(awnFrameId, basis, ux, y + h - fasciaH - 0.16, t + 0.02, 0, aw, 1, 1);
    }
    if (rng.float() < 0.42) {
      T.putM(bladeId, basis, ux + rng.range(-unit * 0.3, unit * 0.3), y + h - 0.35, t, 0, 1, 1, 1);
    }
  }

  // pavement furniture that belongs to the building, not the street
  if (rng.float() < 0.35) {
    const awId = Kit.areaway(lib, 'concrete_wall');
    T.putM(awId, basis, rng.range(-len / 2 + 1.5, len / 2 - 1.5), y, t + 0.9, 0, 1, 1, 1);
  }
}

function buildStoopFront(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const raise = w.front ? rng.range(0.5, 1.1) : 0;
  const doorW = 1.05;
  const doorH = 2.15;
  const wh = Math.min(p.winH * 1.12, h - raise - 1.2);
  const sy = raise + 0.85;

  const holes = [];
  const doorBay = w.front ? rng.int(0, nBays - 1) : -1;
  for (let i = 0; i < nBays; i++) {
    if (i === doorBay) {
      holes.push({ x: cx[i], y: raise + doorH / 2, w: doorW, h: doorH });
    } else {
      holes.push({ x: cx[i], y: sy + wh / 2, w: Math.min(p.winW * 1.05, bay * 0.7), h: wh });
    }
  }
  const g = wallPanel(len, h, t, holes, { seed: w.ax * 0.19 + 3 });
  trs(_m2, 0, y, 0, 0);
  _m2.premultiply(basis);
  T.addOnce(p.masonry, g, _m2, { masks: [0, p.age * 0.42, 0] });
  if (w.collide !== false) {
    for (const s of solidSlabs(len, h, holes)) {
      T.slabBox(surfaceTagOf(p.masonry), basis, s.x, y + s.y, s.w, s.h, t);
    }
  }

  const frameId = Kit.frame(lib, p.trim, p.winStyle, 'md');
  const glassId = Kit.glass(lib, p.glass);
  const roomId = Kit.room(lib, 'room_mid', 'md');
  const litId = Kit.room(lib, 'room_lit_warm', 'md');
  const sillId = Kit.sill(lib, 'stone_grey', 'deep');
  const doorId = Kit.door(lib, p.doorMat, 'panel');
  const stoopId = Kit.stoop(lib, 'stone_grey', Math.max(1, Math.round(raise / 0.17)));
  const blindId = [0, 1, 2].map((s) => Kit.blind(lib, 'blind', s));

  for (let i = 0; i < nBays; i++) {
    const hh = holes[i];
    if (i === doorBay) {
      T.putM(doorId, basis, hh.x, y + hh.y, t - 0.1, 0, doorW * 0.94, doorH * 0.97, 1, [
        rng.range(0.3, 1),
        rng.range(0.3, 0.9),
        0.3,
      ]);
      // dark vestibule so the doorway is not a hole into a hollow shell
      T.putM(Kit.room(lib, 'room_dark', 'md'), basis, hh.x, y + hh.y, t - 0.16, 0, doorW, doorH, 1);
      if (raise > 0.28) T.putM(stoopId, basis, hh.x, y, t, 0, 1, 1, 1);

      // a hood over the door on brackets, the entrance surround, and the
      // handrail up the stoop — the three metres around a front door is where
      // a residential street gets all of its character
      const b2 = plainBox();
      const hood = rng.float();
      if (hood < 0.55) {
        trs(_m2, hh.x, y + hh.y + doorH / 2 + 0.34, t + 0.42, 0, doorW + 1.0, 0.14, 0.95);
        _m2.premultiply(basis);
        T.add(rng.float() < 0.5 ? 'trim_white' : p.sillMat ?? 'stone_grey', b2, _m2, {
          masks: [0.5, 0.5, 0.3],
        });
        for (const s of [-1, 1]) {
          trs(_m2, hh.x + s * (doorW / 2 + 0.32), y + hh.y + doorH / 2 + 0.05, t + 0.22, 0, 0.1, 0.55, 0.45, 0, s * 0.5);
          _m2.premultiply(basis);
          T.add('trim_white', b2, _m2, { masks: [0.55, 0.5, 0.3] });
        }
      }
      // pilasters either side of the opening
      for (const s of [-1, 1]) {
        trs(_m2, hh.x + s * (doorW / 2 + 0.16), y + hh.y, t + 0.05, 0, 0.3, doorH + 0.2, 0.11);
        _m2.premultiply(basis);
        T.add(p.sillMat ?? 'stone_grey', b2, _m2, { masks: [0.5, 0.6, 0.3] });
      }
      if (raise > 0.35) {
        for (const s of [-1, 1]) {
          trs(_m2, hh.x + s * 0.78, y + raise * 0.5 + 0.5, t + raise * 1.1, 0, 0.06, 0.06, raise * 2.4, 0, 0);
          _m2.premultiply(basis);
          T.add('steel_dark', b2, _m2, { masks: [0.8, 0.6, 0.3] });
          trs(_m2, hh.x + s * 0.78, y + raise + 0.5, t + raise * 1.05, 0, 0.05, 1.0, 0.05);
          _m2.premultiply(basis);
          T.add('steel_dark', b2, _m2, { masks: [0.8, 0.6, 0.3] });
        }
      }
      b2.dispose();
      // transom light over the door
      T.putM(Kit.lintel(lib, p.sillMat ?? 'stone_grey'), basis, hh.x, y + hh.y + doorH / 2 + 0.02, t, 0, doorW + 0.9, 1, 1);
      // and the areaway down to the cellar next door to it
      if (rng.float() < 0.4 && len > 7) {
        T.putM(Kit.areaway(lib, 'concrete_wall'), basis, hh.x + (rng.float() < 0.5 ? -1 : 1) * 2.2, y, t + 1.0, 0, 1, 1, 1);
      }
      continue;
    }
    placeWindow(T, lib, basis, {
      x: hh.x,
      y: y + hh.y,
      w: hh.w,
      h: hh.h,
      t,
      p,
      rng,
      frameId,
      glassId,
      roomId,
      litId,
      sillId,
      lintelId: p.lintel ? Kit.lintel(lib, 'stone_grey') : null,
      boardId: p.boarded > 0 ? Kit.board(lib, 'timber') : null,
      blindId,
      floor: 0,
      lit: rng.float() < p.litRate,
    });
  }
}

function buildPorch(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  buildStoopFront(T, lib, w, basis, len, y, h, nBays, bay, cx);
  if (!w.front || len < 4) return;

  // A covered porch across most of the frontage: posts, deck, roof, rail.
  const pw = Math.min(len - 0.6, rng.range(4.5, 9));
  const pd = rng.range(1.8, 2.6);
  const px = rng.range(-(len - pw) / 2, (len - pw) / 2);
  const deckY = 0.42;
  const box = chamferBox(1, 1, 1, 0.012);
  const pb = plainBox();

  trs(_m2, px, y + deckY - 0.09, t + pd / 2, 0, pw, 0.18, pd);
  _m2.premultiply(basis);
  T.add('timber', box, _m2, { masks: [0.7, 0.5, 0.2] });

  // posts
  const nPosts = Math.max(2, Math.round(pw / 2.4));
  for (let i = 0; i <= nPosts; i++) {
    const x = px - pw / 2 + (i / nPosts) * pw;
    trs(_m2, x, y + deckY + 1.28, t + pd - 0.18, 0, 0.15, 2.55, 0.15);
    _m2.premultiply(basis);
    T.add('trim_white', box, _m2, { masks: [0.6, 0.4, 0.2] });
    // rail
    if (i < nPosts) {
      const seg = pw / nPosts;
      trs(_m2, x + seg / 2, y + deckY + 0.92, t + pd - 0.18, 0, seg, 0.07, 0.09);
      _m2.premultiply(basis);
      T.add('trim_white', pb, _m2, { masks: [0.7, 0.4, 0.2] });
      const nb = Math.max(3, Math.round(seg / 0.16));
      for (let j = 0; j < nb; j++) {
        trs(_m2, x + ((j + 0.5) / nb) * seg, y + deckY + 0.5, t + pd - 0.18, 0, 0.04, 0.85, 0.04);
        _m2.premultiply(basis);
        T.add('trim_white', pb, _m2, { masks: [0.7, 0.4, 0.2] });
      }
    }
  }
  // porch roof
  trs(_m2, px, y + deckY + 2.66, t + pd / 2, 0, pw + 0.3, 0.16, pd + 0.35);
  _m2.premultiply(basis);
  T.add('roof_shingle', box, _m2, { masks: [0.4, 0.4, 0.2] });
  trs(_m2, px, y + deckY + 2.78, t + pd + 0.12, 0, pw + 0.3, 0.22, 0.12);
  _m2.premultiply(basis);
  T.add('trim_white', pb, _m2, { masks: [0.6, 0.5, 0.3] });

  // steps down to the street
  const steps = Math.max(2, Math.round((deckY + 0.1) / 0.17));
  T.putM(Kit.stoop(lib, 'concrete_wall', steps), basis, px, y, t + pd, 0, 1, 1, 1);
  box.dispose();
  pb.dispose();
}

/**
 * The podium of a tower.
 *
 * WHAT THIS FIXES. The critic panel measured "downtown towers are windowless
 * stucco slabs", and the capture that produced it shows a 50 m run of ground
 * floor with nothing on it at all. The old version cut ONE opening `len - 2.4`
 * wide — a single 48 m sheet of glass with a 1.2 m return each end. At street
 * level that is one flat plane: no structure crosses it, nothing casts a
 * shadow onto it, and the dark interior behind it reads as solid. A real
 * podium is a colonnade — a stone pier every six to nine metres, glazing
 * between them, a deep head beam over the lot, a granite base under it — and
 * the piers are what make it read as a building rather than a painted band.
 */
function buildLobby(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const openH = h - 1.35;
  const sill = 0.5;

  // Structural bays. A pier lands on every bay line including both ends, so a
  // corner of the podium is always solid.
  const units = Math.max(1, Math.round(len / rng.range(5.5, 8.0)));
  const pierW = Math.min(1.8, Math.max(0.85, len * 0.045));
  const step = len / units;
  const holes = [];
  const glazed = [];
  for (let i = 0; i < units; i++) {
    const gw = step - pierW;
    if (gw < 1.2) continue;
    // Not every bay is glass: a plant room, a service door, a blank return.
    // On a flank elevation most of them are.
    const solid = rng.float() < (w.front ? 0.1 : 0.28);
    if (solid) continue;
    const x = -len / 2 + (i + 0.5) * step;
    holes.push({ x, y: sill + openH / 2, w: gw, h: openH });
    glazed.push({ x, w: gw });
  }

  const g = wallPanel(len, h, t, holes, { seed: w.ax * 0.11 + 5 });
  trs(_m2, 0, y, 0, 0);
  _m2.premultiply(basis);
  // A podium is clad in the heavy stone, not in the tower's own skin — that
  // change of material at the third metre is most of what makes a tower read
  // as sitting on the ground rather than starting there.
  const clad = p.arch === 'curtain' ? (p.sillMat ?? 'stone_grey') : p.masonry;
  T.addOnce(clad, g, _m2, { masks: [0.18, p.age * 0.5, 0.14] });
  if (w.collide !== false) {
    for (const s of solidSlabs(len, h, holes)) {
      T.slabBox(surfaceTagOf(p.masonry), basis, s.x, y + s.y, s.w, s.h, t);
    }
  }

  const glassId = Kit.glass(lib, p.glass);
  const roomId = Kit.room(lib, 'room_lit_cool', 'deep');
  const mull = plainBox();
  for (const b of glazed) {
    T.putM(glassId, basis, b.x, y + sill + openH / 2, t - 0.14, 0, b.w * 0.99, openH, 1, [0, p.age * 0.4, 0]);
    T.putM(roomId, basis, b.x, y + sill + openH / 2, t - 0.22, 0, b.w * 0.99, openH, 1);
    // mullions and one transom per bay
    const n = Math.max(1, Math.round(b.w / 2.4));
    for (let i = 0; i <= n; i++) {
      trs(_m2, b.x - b.w / 2 + (i / n) * b.w, y + sill + openH / 2, t - 0.12, 0, 0.09, openH, 0.22);
      _m2.premultiply(basis);
      T.add('alu_dark', mull, _m2, { masks: [0.4, 0.2, 0.1] });
    }
    trs(_m2, b.x, y + sill + Math.min(openH - 0.4, 2.35), t - 0.12, 0, b.w, 0.11, 0.22);
    _m2.premultiply(basis);
    T.add('alu_dark', mull, _m2, { masks: [0.4, 0.2, 0.1] });
  }

  // The reveal on the piers: a shadow gap each side of every opening, so the
  // stone reads as standing proud of the glass instead of butting it.
  for (const b of glazed) {
    for (const s of [-1, 1]) {
      trs(_m2, b.x + (s * b.w) / 2, y + sill + openH / 2, t - 0.07, 0, 0.06, openH, 0.16);
      _m2.premultiply(basis);
      T.add('alu_dark', mull, _m2, { masks: [0.5, 0.3, 0.2] });
    }
  }

  // Head beam over the whole colonnade and a shadow reveal under it: the deep
  // horizontal that separates podium from shaft.
  trs(_m2, 0, y + h - 0.42, t + 0.09, 0, len, 0.84, 0.2);
  _m2.premultiply(basis);
  T.add(p.sillMat ?? 'stone_grey', mull, _m2, { masks: [0.4, 0.45, 0.25] });
  // The head beam IS the building's name band — every office tower in the
  // Triangle carries its tenant across it in cut letters.
  if (w.front && len > 8) {
    mountAt(T, basis, w, 'fascia', 0, y + h - 0.42, t + 0.2, Math.min(len - 2.4, 14), 0.62);
  }
  trs(_m2, 0, y + h - 0.86, t + 0.11, 0, len, 0.06, 0.24);
  _m2.premultiply(basis);
  T.add('steel_dark', mull, _m2, { masks: [0.5, 0.6, 0.5] });

  // revolving-door drum, then the canopy over the pavement. Centred on the
  // glazed bay nearest the middle of the frontage, never on a pier.
  if (w.front && glazed.length) {
    let ent = glazed[0];
    for (const b of glazed) if (Math.abs(b.x) < Math.abs(ent.x)) ent = b;
    const drum = new THREE.CylinderGeometry(1.25, 1.25, 2.5, 16, 1, true);
    drum.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(new Float32Array(drum.getAttribute('position').count * 3), 3)
    );
    trs(_m2, ent.x, y + 1.25, t - 0.5, 0, 1, 1, 1);
    _m2.premultiply(basis);
    T.add('alu_dark', drum, _m2, { masks: [0.4, 0.3, 0.2] });
    drum.dispose();
    // the threshold step the doors stand on
    trs(_m2, ent.x, y + 0.06, t + 0.55, 0, Math.min(ent.w + 1.6, 7), 0.12, 1.5);
    _m2.premultiply(basis);
    T.add(p.sillMat ?? 'stone_grey', mull, _m2, { masks: [0.5, 0.8, 0.4] });

    const can = chamferBox(1, 1, 1, 0.02);
    trs(_m2, ent.x, y + h - 1.5, t + 1.4, 0, Math.min(ent.w + 2.4, 9), 0.28, 2.8);
    _m2.premultiply(basis);
    T.add('alu_dark', can, _m2, { masks: [0.3, 0.45, 0.3] });
    // one tension rod each side, not a thicket
    for (const s of [-1, 1]) {
      trs(_m2, ent.x + s * Math.min(ent.w / 2, 3.2), y + h - 0.7, t + 0.9, 0, 0.06, 1.9, 0.06, 0, s * 0.85);
      _m2.premultiply(basis);
      T.add('alu_dark', mull, _m2, { masks: [0.3, 0.25, 0.1] });
    }
    can.dispose();
  }
  mull.dispose();
}

function buildDock(T, lib, w, basis, len, y, h, nBays, bay, cx) {
  const p = w.prog;
  const rng = w.rng;
  const t = p.wallT;
  const doorH = Math.min(h - 0.8, 4.2);
  /**
   * `len / nDoors - 1.6` goes NEGATIVE on any elevation under 1.6 m — a return
   * wall, or a lot the kerb clip has taken a corner off. A negative width is
   * placed by `trs` as a negative scale, which mirrors the shutter, the room
   * box and the dock lip: their faces are re-wound while their normals are
   * not, and the g-buffer has no way back from that. A wall too narrow for a
   * loading door simply does not get one.
   */
  const doorW = Math.min(4.2, len / Math.max(1, Math.round(len / 9)) - 1.6);
  const nDoors = doorW >= 1.6 ? Math.max(1, Math.round(len / 9)) : 0;
  const holes = [];
  for (let i = 0; i < nDoors; i++) {
    const x = -len / 2 + ((i + 0.5) / nDoors) * len;
    holes.push({ x, y: doorH / 2 + 0.1, w: doorW, h: doorH });
  }
  // a strip of high grid windows above the doors
  const hi = h - doorH - 1.4;
  if (hi > 1.1) {
    for (let i = 0; i < nBays; i++) {
      holes.push({ x: cx[i], y: h - hi / 2 - 0.5, w: Math.min(bay * 0.7, 2.6), h: hi * 0.8 });
    }
  }
  const g = wallPanel(len, h, t, holes, { seed: w.ax * 0.23 + 11 });
  trs(_m2, 0, y, 0, 0);
  _m2.premultiply(basis);
  T.addOnce(p.masonry, g, _m2, { masks: [0, p.age * 0.5, 0] });
  if (w.collide !== false) {
    for (const s of solidSlabs(len, h, holes)) {
      T.slabBox(surfaceTagOf(p.masonry), basis, s.x, y + s.y, s.w, s.h, t);
    }
  }

  const shutterIds = [0, 1, 2].map((s) => Kit.shutter(lib, 'shutter', s));
  const frameId = Kit.frame(lib, p.trim, 'grid', 'lg');
  const glassId = Kit.glass(lib, 'glass_grimy');
  const roomId = Kit.room(lib, 'room_dark', 'md');
  const boardId = Kit.board(lib, 'timber');

  for (let i = 0; i < nDoors; i++) {
    const hh = holes[i];
    T.putM(shutterIds[rng.float() < 0.5 ? 2 : rng.int(0, 1)], basis, hh.x, y + hh.y, t - 0.12, 0, hh.w, hh.h, 1);
    T.putM(Kit.room(lib, 'room_dark', 'deep'), basis, hh.x, y + hh.y, t - 0.2, 0, hh.w, hh.h, 1);
    // loading dock lip + bumpers
    const b = chamferBox(1, 1, 1, 0.015);
    trs(_m2, hh.x, y + 0.06, t + 0.4, 0, hh.w + 0.6, 0.12, 0.9);
    _m2.premultiply(basis);
    T.add('concrete_wall', b, _m2, { masks: [0.7, 0.7, 0.5] });
    for (const s of [-1, 1]) {
      trs(_m2, hh.x + (s * hh.w) / 2 + s * 0.1, y + 0.75, t + 0.06, 0, 0.28, 0.55, 0.16);
      _m2.premultiply(basis);
      T.add('rubber', b, _m2, { masks: [0.8, 0.6, 0.4] });
    }
    b.dispose();
  }
  for (let i = nDoors; i < holes.length; i++) {
    const hh = holes[i];
    if (rng.float() < p.boarded) {
      T.putM(boardId, basis, hh.x, y + hh.y, t - 0.1, 0, hh.w, hh.h, 1);
      continue;
    }
    T.putM(frameId, basis, hh.x, y + hh.y, t - 0.13, 0, hh.w, hh.h, 1);
    T.putM(glassId, basis, hh.x, y + hh.y, t - 0.145, 0, hh.w * 0.98, hh.h * 0.98, 1);
    T.putM(roomId, basis, hh.x, y + hh.y, t - 0.17, 0, hh.w, hh.h, 1);
  }
}

// ------------------------------------------------------------------ crown --
/**
 * THE CORNICE PROFILE FAMILY.
 *
 * Each entry is a `moulding` section in the wall's own frame: [z, y] pairs,
 * z out of the wall face, y up from the profile's base. The family exists
 * because the critics measured "no cornices anywhere" TWICE, and because one
 * profile on every building is the same finding in a different costume — an
 * elevation is dated by its crown before anything else on it, and a city with
 * one crown is a city with one date.
 *
 * The numbers are projections, and projection is the entire point: a cornice
 * that stands 6 cm off the wall throws a 6 cm shadow, which at street distance
 * under Pittsburgh's overcast is nothing at all. Every profile here reaches at
 * least 24 cm and the heavy ones 40, because the SHADOW is the cornice — the
 * moulding is just what casts it.
 *
 *   plain     a squared-off capping band. Post-war, and the mill's own.
 *   stone     the 1900s commercial moulding: cyma, corona, heavy corona drip.
 *   stepped   deco/industrial: three hard rectangular steps, no curves. This
 *             is the Golden Triangle's 1920s-30s vocabulary.
 *   dentil    stone's section carried on a course of instanced dentil blocks
 *             (see `denticulate`), which is the classical commercial block.
 *   eave      a house's projecting timber eave, carried on modillions.
 *   brick     NOT in this table: corbelled brick is courses of brick, not a
 *             cut section, so it is three boxes in the building's own masonry.
 */
const CORNICE_PROFILE = {
  plain: [
    [-0.02, 0],
    [0.24, 0.05],
    [0.24, 0.3],
    [0.14, 0.38],
    [-0.02, 0.38],
  ],
  stone: [
    [-0.02, 0],
    [0.16, 0.14],
    [0.34, 0.24],
    [0.34, 0.44],
    [0.22, 0.58],
    [-0.02, 0.58],
  ],
  stepped: [
    [-0.02, 0],
    [0.16, 0],
    [0.16, 0.16],
    [0.3, 0.16],
    [0.3, 0.34],
    [0.44, 0.34],
    [0.44, 0.54],
    [0.22, 0.62],
    [-0.02, 0.62],
  ],
  dentil: [
    [-0.02, 0],
    [0.2, 0.02],
    [0.38, 0.12],
    [0.38, 0.34],
    [0.24, 0.46],
    [-0.02, 0.46],
  ],
  /**
   * The eave keeps the 42 cm it always had rather than the 52 this wave first
   * gave it — but no less, and that was MEASURED rather than guessed. When
   * `solidprobe`'s ghost tier moved with this wave, the obvious suspect was
   * cornice projection on the smallest archetype in the city, so all three of
   * these profiles were trimmed to their pre-wave depths (eave 0.42 -> 0.30,
   * stone 0.34 -> 0.30, stepped 0.44 -> 0.38) and the gate was re-run: FOUR
   * ghosts before the trim and FOUR after. Depth is not the lever there —
   * removing the cornice entirely is, and every one of these archetypes had a
   * cornice before this wave existed. So the depths stay where the shadow
   * wants them.
   */
  eave: [
    [-0.02, 0],
    [0.42, 0.0],
    [0.42, 0.16],
    [0.1, 0.32],
    [-0.02, 0.32],
  ],
};

/**
 * The tooth course under a dentil or eave cornice.
 *
 * Instanced, not merged, and authored at REAL SIZE — a dentil is 13 cm on a
 * rowhouse and 13 cm on a 20-storey block, and the run is what changes, not
 * the tooth. One prototype serves the whole city, so a street of these is one
 * draw call however many teeth are in it.
 *
 * Two guards, both about cost rather than looks, and both MEASURED: at a pitch
 * of 0.31 with a cap of 96 the course was most of this wave's triangle budget
 * (`kitprobe` put the whole kit at +15.5%, over its own limit). The pitch is
 * now the widest a tooth course still reads at, and the cap is the point past
 * which a cornice is a straight line at any distance you can see all of it
 * from. The caller adds the third guard — front elevations and long flanks
 * only; nobody stands in the light well.
 */
function denticulate(T, lib, basis, len, y, t, mat, kind, rng) {
  if (len < 2.2) return 0;
  const pitch = kind === 'modillion' ? 1.15 : 0.37;
  const cap = kind === 'modillion' ? 22 : 54;
  const n = Math.min(cap, Math.floor((len - 0.4) / pitch));
  if (n < 3) return 0;
  const id = kind === 'modillion' ? Kit.modillion(lib, mat) : Kit.dentil(lib, mat);
  const span = n * pitch;
  for (let i = 0; i < n; i++) {
    const x = -span / 2 + (i + 0.5) * pitch;
    // A course of identical blocks in identical dirt is a comb, not a cornice.
    T.putM(id, basis, x, y, t, 0, 1, 1, 1, [
      rng.range(0.3, 0.9),
      rng.range(0.35, 1),
      rng.range(0.2, 0.5),
    ]);
  }
  return n;
}

/**
 * Where a building meets the sky. A flat top on a box is the fastest way to
 * make a city look like a bar chart, so every elevation gets a cornice with a
 * real projection and a parapet with a coping, and the projection throws a
 * shadow onto the top two metres of the wall.
 *
 * All of this is SILHOUETTE and goes in the static bucket: the cornice must
 * survive to the mid LOD (`buildLotLod` draws its own band at LOD_RELIEF+0.14
 * for the same reason). Only the dentil/modillion COURSE is allowed to be a
 * near-field luxury, and it is instanced rather than merged so that dropping
 * it is a matter of distance culling one InstancedMesh.
 */
function buildCrown(T, lib, basis, len, total, t, p, rng, w) {
  // The cornice is the other half of a terracotta dressing: a Golden Triangle
  // elevation is stone or brick with a glazed terracotta cap and string
  // course, and doing only the course leaves the top of the building in the
  // wrong material. `dressMat` is null everywhere terracotta is not already a
  // masonry key in the district, so this costs those tiles no batch.
  const capMat = p.dressMat ?? p.sillMat ?? 'stone_grey';
  const kind = facadeOpts.crown ? (p.cornice ?? 'plain') : 'none';
  if (kind === 'none') {
    /**
     * The control arm: the flat capping band this wave replaced. Not "nothing"
     * — a probe that compares a cornice against an unbuilt roofline is
     * measuring whether a roof exists, which is not the question.
     */
    const b = plainBox();
    trs(_m2, 0, total - 0.28, t + 0.06, 0, len, 0.3, 0.16);
    _m2.premultiply(basis);
    T.add(capMat, b, _m2, { masks: [0.5, 0.5, 0.3] });
    b.dispose();
  } else if (kind === 'brick') {
    // corbelled brick: three courses, each stepping out
    const b = plainBox();
    for (let i = 0; i < 3; i++) {
      trs(_m2, 0, total - 0.62 + i * 0.16, t + 0.03 + i * 0.055, 0, len, 0.15, 0.12 + i * 0.11);
      _m2.premultiply(basis);
      T.add(p.masonry, b, _m2, { masks: [0.45, 0.55, 0.35] });
    }
    b.dispose();
  } else {
    const prof = CORNICE_PROFILE[kind] ?? CORNICE_PROFILE.plain;
    const over = kind === 'eave' ? 0.7 : 0;
    const drop = kind === 'eave' ? 0.32 : prof[prof.length - 1][1] + 0.16;
    const c = moulding(len + over, prof);
    trs(_m2, 0, total - drop, t, 0);
    _m2.premultiply(basis);
    T.addOnce(kind === 'eave' ? 'trim_white' : capMat, c, _m2, {
      masks: [0.35, p.age * 0.5, 0.2],
    });
    // Under the corona, never inside it: the tooth course projects 21 cm and
    // the section it hangs off reaches 38, so the overhang shades the teeth.
    // Street elevations and long flanks only — see `denticulate`.
    const cut = w.front || len > 13;
    if (kind === 'dentil' && cut) {
      denticulate(T, lib, basis, len, total - drop - 0.11, t + 0.02, capMat, 'dentil', rng);
    } else if (kind === 'eave' && cut) {
      denticulate(T, lib, basis, len, total - drop - 0.12, t + 0.02, 'trim_white', 'modillion', rng);
    }
  }

  // the dark band the cornice casts, painted straight into the wall's masks
  if (kind !== 'eave') {
    const shade = quad(len, 1.6);
    fillMasks(shade, 0, 0.55, 0.55);
    trs(_m2, 0, total - 1.5, t + 0.008, 0);
    _m2.premultiply(basis);
    T.addOnce(p.masonry, shade, _m2);
  }

  if (p.parapet > 0.05) {
    const b = plainBox();
    trs(_m2, 0, total + p.parapet / 2, t - 0.08, 0, len, p.parapet, 0.24);
    _m2.premultiply(basis);
    T.add(p.masonry, b, _m2, { masks: [0.35, 0.4, 0.2] });
    /**
     * A stepped parapet CAP on the profiles that ask for one. A flat coping
     * run reads as a lid; a deco or industrial parapet is capped by a course
     * that oversails it on both sides, and the shadow under the oversail is
     * what keeps the top edge of the building from dissolving into the sky.
     */
    if (kind === 'stepped' || kind === 'dentil') {
      trs(_m2, 0, total + p.parapet + 0.06, t - 0.02, 0, len, 0.12, 0.4);
      _m2.premultiply(basis);
      T.add(capMat, b, _m2, { masks: [0.5, 0.5, 0.3] });
    }
    b.dispose();
    T.putM(Kit.coping(lib, capMat), basis, 0, total + p.parapet, t - 0.08, 0, len, 1, 1);
  }
}

export { buildShopfront, buildLobby, buildDock };
