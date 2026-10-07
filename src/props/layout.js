import * as THREE from 'three';
import { Accum, trs, newTrs, clamp01, lerp, TAU, hash3i, smoothNoise } from './geom.js';
import { DISTRICT_STYLE, DEFAULT_STYLE, DISTRICT_NEON, SURFACE_TAG } from './palette.js';
import { polesOnEdge, armHeight, buildSpan, buildDrop, buildGuy, buildTrolley } from './wires.js';
import {
  signTextProto, fitScale, shopWords, pickInk, inkSurface,
  streetPlateText, neonWordProto, SIGN_WORDS, BANNER_WORDS,
} from './kit_sign.js';
import { KIT_SPECIES } from './kit_green.js';
import { paintColorPark } from './colorpark.js';

/**
 * PROPS — the placement solver.
 *
 * Two hard requirements shape everything in this file.
 *
 * 1. TILE-INDEPENDENCE. A prop must not appear twice because two tiles both
 *    thought they owned it, and must not vanish because neither did. So every
 *    street-side prop is generated from a PURE FUNCTION OF THE ROAD EDGE — the
 *    whole edge, every time — and the tile then keeps only what falls inside
 *    its own bounds. Recomputing a 200 m edge three times costs microseconds
 *    and removes a whole class of streaming seam.
 *
 * 2. NOTHING REPEATS. A critic called out "every instance of every asset is at
 *    the same yaw", which read the street as "a kit laid on a grid rather than
 *    a place". Every emit() below carries yaw jitter, non-uniform scale, a lean,
 *    and a per-instance weathering mask triple. Spacings are drawn from the
 *    edge seed, not from a constant, so two streets never share a rhythm.
 *
 * The pavement cross-section is measured from `world` at runtime rather than
 * assumed: `_measureWalk` steps outward from the kerb face asking
 * `world.surfaceAt` until the answer stops being 'sidewalk'. That keeps props
 * on the pavement even if `world` retunes its road kinds.
 */

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
/** Scratch for the wall-backing probe — build time only, never per frame. */
const _wv = new THREE.Vector3();

/** How far a prop may stand from the kerb face before it is in the way. */
const KERB_LANE = 0.62;

/**
 * `?owNoOak=1` (or `OW_NO_OAK=1` headless) plants the four species this file
 * planted before the oak was adopted, and changes nothing else — same hashes,
 * same pits, same spacing, because every planting site below indexes
 * `STREET_SPECIES` by `% STREET_SPECIES.length` rather than by a hardcoded 4.
 * It is the negative control for the triangle and batch deltas quoted in the
 * table below, and it is never reachable in play. Same shape as the
 * `?owNoSigns=1` hatch further down this file.
 */
let _noOak = null;
function noOak() {
  if (_noOak !== null) return _noOak;
  _noOak = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('owNoOak') === '1') {
      _noOak = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_OAK === '1') _noOak = true;
  } catch { /* no process */ }
  if (_noOak) console.warn('[props] LEGACY planting — four street species, no oak');
  return _noOak;
}

/**
 * THE STREET SPECIES, IN ONE PLACE.
 *
 * `kit_green.js` registers `tree_<id>_<v>_wood` and `tree_<id>_<v>_leaf<n>`
 * for every id in its own `SPECIES`, and this file decides which of them get
 * planted. The list was written out by hand at three separate call sites —
 * street verge, park scatter and waste ground — each with its own `* 4 ... % 4`
 * beside it, so adding a species meant finding four numbers in three places and
 * the city silently kept planting the old four if you missed one.
 *
 * ADDING A SPECIES IS TWO EDITS, AND THEY ARE IN TWO FILES ON PURPOSE.
 * `ProtoLibrary.proto` builds eagerly, so a `SPECIES` entry in `kit_green.js`
 * costs its trunk and canopy geometry the moment it exists whether anything
 * plants it or not — and naming a species here that the kit never registered
 * puts an id into `B.put` that resolves to nothing. The two lists have to move
 * together; this one is the half that is allowed to be short.
 *
 * `young` is not here. It is the replacement sapling every planting scheme has
 * a few of, chosen by its own hash below, not a species anybody plants a street
 * with.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FIFTH SPECIES, AND WHAT IT COST.
 * ───────────────────────────────────────────────────────────────────────────
 * `kit_green.js` built the red oak and said so plainly at the bottom of its own
 * table: "NOT PLANTED YET ... until that list takes `oak` this costs four
 * canopies and a far tier of build time at boot and ZERO draw calls, because
 * nothing instances it." It is the widest crown in the kit — 3.0 x 2.35 x 2.9
 * against a plane's 1.46x smaller volume — and the one that most changes what a
 * run of street trees does to a skyline, which is what a fifth species is
 * bought for. Planting it turns that dead build cost into pixels.
 *
 * MEASURED ON TREE-DENSE TILES, which is what the kit's note asked whoever
 * landed this to do, through the `?owNoOak=1` hatch above so that both arms
 * are the SHIPPED planting code and not two edits of it. Three tiles off the
 * `street` shot, counted off the emitted meshes — per-instance triangles and
 * `InstancedMesh` batches, collision proxies excluded:
 *
 *   tile        trees   triangles  ->  triangles     batches -> batches
 *   props_5_-3    140      67 552       69 970  +3.6%     17      19  (+2)
 *   props_5_-2    136      79 516       81 140  +2.0%     22      24  (+2)
 *   props_3_-4    132      66 842       68 438  +2.4%     17      19  (+2)
 *
 * THE TREE COUNT IS THE SAME ON BOTH SIDES OF EVERY ROW, and that is what
 * makes it a measurement of the oak rather than of a different planting: no
 * decision in `_treeRun` reads the species, so the pits, the spacings and the
 * canopy variants are untouched and the only thing that moved is which crown
 * stands in each pit. Tiles whose count differed between the two runs — the
 * far ring, where a tile can be built at LOD1 in one run and LOD0 in the next
 * — are excluded for that reason rather than averaged in.
 *
 * The +2 batches is exactly the price `kit_green.js` predicted and named: one
 * more wood proto and one more leaf material on any tile that grows an oak.
 * The 2-4% of triangles is the crown — an oak canopy is 2 240 triangles
 * against a plane's 1 408 — and it lands only on tiles that already have
 * trees, which is the right shape for a cost that buys silhouette variety.
 *
 * FILTERED AGAINST THE KIT, not asserted equal to it. `young` is in
 * `KIT_SPECIES` and is deliberately not a street species, so the two lists are
 * not the same list; what the filter stops is the failure this pair of lists
 * actually has — naming a species here that `kit_green.js` never registered,
 * which puts an id into `B.put` that silently resolves to no tree at all.
 */
export const STREET_SPECIES = ['plane', 'maple', 'locust', 'pear', 'oak'].filter(
  (s) => KIT_SPECIES.includes(s) && !(s === 'oak' && noOak())
);


/**
 * The leaf materials `kit_green.js` registers per species, in its own order:
 * three greens and then the autumn variants. `layout` needs the split because
 * it chooses green or turned per tree — see `_leafIndex`.
 *
 * GREENS is the count of leading green entries in that list; everything from
 * there on is a turning tree. Both numbers are stated here rather than derived
 * because the kit's array is not exported, and a wrong count plants a
 * mid-October canopy in July rather than crashing, which is the kind of bug
 * that ships.
 */
const LEAF_GREENS = 3;
/**
 * `leaf_autumn_b` / `leaf_autumn_c` AND THE `?oneautumn=1` HATCH BOTH LIVED
 * HERE, and both went with the guest pass — see `_registerAutumn`.
 *
 * The surfaces are declared by `kit_green.js`, which owns the canopy they are
 * painted on, and the hatch is read there too. Nothing in this file needs
 * either name any more: `_registerAutumn` counts what the kit actually built,
 * so the control arm reaches this file as a smaller count rather than as a
 * second copy of a query parameter. A duplicated hatch is a hatch that can be
 * half-off.
 */

/**
 * WHAT A REGULATORY PLATE SAYS, AND WHERE ON THE POST IT SAYS IT.
 *
 * Keyed by the FACE PROTO the kerb walk planted, because the legend and the
 * plate are one decision: `sign_reg_face2` is a 0.46 x 0.62 plate at y 2.15
 * with a 0.44 x 0.30 rider under it at y 1.66, so it gets a restriction AND
 * the hours it applies, and `sign_oneway_face` is a 0.92 x 0.28 blade that can
 * only ever carry one short line. The fields below are the plate's own
 * dimensions less a margin, at unit scale; the placement multiplies by its own
 * `sc`. The numbers come from `kit_street.js`'s `registerSigns` — if a plate is
 * ever resized, these move with it.
 *
 * EVERY LEGEND HERE WAS SIZED BEFORE IT WAS WRITTEN, not after. `signprobe`
 * requires a 0.055 m cap height on every word in the city and the kerb walk
 * scales its furniture by 0.88..1.14, so a legend has to clear the floor at
 * the SMALL end of that range. `fitScale` on these fields, times 0.88:
 *
 *   SPEED/LIMIT/25      0.090      MON-FRI            0.062
 *   NO/PARKING          0.065      7-9 AM / 4-6 PM    0.074
 *   2 HOUR/PARKING      0.065      2 HOURS            0.061
 *   LOADING/ZONE        0.065      ONE WAY            0.118
 *
 * Four legends that read perfectly well and did not survive it are worth
 * recording so nobody adds them back: NO/STOPPING 0.057, NO/STANDING 0.056,
 * TOW AWAY/ZONE 0.050, EXCEPT SUNDAY 0.031. A plate is 46 cm wide; the longer
 * the phrase, the smaller the type, and an unreadable plate is the defect this
 * whole method exists to remove rather than a smaller version of the fix.
 *
 * The vocabulary lives here rather than in `kit_sign.js`'s `SIGN_WORDS`
 * because it is paired to that geometry line by line — which plate carries how
 * many lines in how many centimetres — and a list of shop names is not.
 * `signprobe.mjs` imports it FROM HERE for its classifier, so there is exactly
 * one copy of it; moving it into `SIGN_WORDS` is a `kit_sign.js` followup and
 * would want the field table to travel with it.
 */
export const REG_PLATES = {
  reg: [{
    y: 2.15, w: 0.42, h: 0.54,
    words: [['NO', 'PARKING'], ['SPEED', 'LIMIT', '25'], ['2 HOUR', 'PARKING'],
      ['LOADING', 'ZONE']],
  }],
  reg2: [{
    y: 2.15, w: 0.42, h: 0.54,
    words: [['NO', 'PARKING'], ['2 HOUR', 'PARKING'], ['LOADING', 'ZONE']],
  }, {
    y: 1.66, w: 0.40, h: 0.25,
    words: [['MON-FRI'], ['7-9 AM'], ['4-6 PM'], ['2 HOURS']],
  }],
  oneway: [{
    y: 2.35, w: 0.82, h: 0.22,
    words: [['ONE WAY'], ['DO NOT ENTER'], ['NO TRUCKS'], ['BUS ONLY']],
  }],
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `?owNoSigns=1` — the signage layer's kill switch, and why it exists.
 * ─────────────────────────────────────────────────────────────────────────────
 * It is not a feature flag and nothing in play reaches it. It exists so that
 * `tools/perfcheck.mjs --ab='.|owNoSigns=1,.'` can measure the cost of the
 * type layer as ONE BUILD with the change off and on, which is the only honest
 * A/B on a tree several agents are editing at once: two separate builds
 * minutes apart are not the same picture and the frame time difference between
 * them is mostly somebody else's commit.
 *
 * It suppresses only the emission of TYPE (`Layout._type` and `_neonWord`).
 * The boards, blades, hoardings and plaques it goes on stay, so the arms
 * differ by the letters and nothing else.
 */
let _noSigns = null;
function noSigns() {
  if (_noSigns !== null) return _noSigns;
  _noSigns = false;
  try {
    if (typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('owNoSigns') === '1') _noSigns = true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_SIGNS === '1') _noSigns = true;
  } catch { /* no process */ }
  if (_noSigns) console.warn('[props] SIGNAGE OFF — no lettering anywhere (A/B control)');
  return _noSigns;
}

/**
 * Footprint radius assumed when asking "is this piece of furniture in the road?"
 *
 * Deliberately one modest number rather than a per-prototype measurement: the
 * guard exists to catch a bin standing in a running lane, not to shave
 * centimetres off a bollard, and because `_clearOff` PUSHES before it drops,
 * erring generous costs at most a 0.25 m nudge back across a footway that is
 * 3.2 m wide. A straight street leaves 1.1 m of slack, so on the overwhelming
 * majority of the network this never fires at all.
 */
const KERB_CLEAR = 0.45;

/**
 * Junction furniture — signal masts, stop signs, street blades, hydrants.
 * Smaller than `KERB_CLEAR` because these are posts, and because a corner is
 * where the pavement is tightest and an over-generous rule deletes the sign
 * instead of moving it.
 */
const SIGN_CLEAR = 0.3;

/** Tree pit: the grate is ~1 m across, so half of it plus the kerb nib. */
const TREE_CLEAR = 0.55;

/**
 * Anything scattered inside a lot polygon. Generous on purpose — a skip in a
 * running lane is the worst thing this file can emit, there is no sensible
 * direction to nudge a lot-interior prop in, and a real yard keeps its road
 * frontage clear anyway.
 */
const LOT_CLEAR = 0.9;

/** Signboard colourways, rotated per shop unit. */
const PANELS = ['panel_cream', 'panel_navy', 'panel_maroon', 'panel_forest'];

/**
 * Pavement widths by corridor kind, used only when the runtime probe of
 * `world.surfaceAt` comes back empty. These mirror what `world` publishes
 * through `edge.kind`; the probe is still the authority when it answers.
 */
const FALLBACK_WALK = { arterial: 4.0, street: 3.2, highway: 0, alley: 0 };

/**
 * KERB PARKING GEOMETRY. These mirror `traffic/lanes.js` and `traffic/parking.js`
 * — the same 1.30 m inset from the kerb face to the centre of a parked car, so
 * a car this system stands at a bay and a car `traffic` stands at one line up
 * with each other instead of arguing over the same three metres of road.
 */
const PARK_INSET = 1.30;
/** Manoeuvring gap between two parked cars. Under this they interpenetrate. */
const BAY_GAP = 1.25;
/** Kerb kept clear at each end of the block — no parking in a junction throat. */
const BAY_END_CLEAR = 9;

/**
 * What stands at a kerb, with the LENGTH each one needs. The slot pitch is
 * derived from this rather than from a constant: a 6.2 m pitch cannot hold a
 * 7.2 m box truck, and `traffic` measured exactly that as 1.7 m of parked cars
 * intersecting each other.
 */
const KERB_TYPES = [
  { t: 'sedan', L: 4.8, w: 3.4 },
  { t: 'muscle', L: 5.1, w: 1.5 },
  { t: 'sports', L: 4.6, w: 1.1 },
  { t: 'van', L: 5.6, w: 1.4 },
  { t: 'truck', L: 7.2, w: 0.6 },
];
const KERB_TOTAL = KERB_TYPES.reduce((a, b) => a + b.w, 0);

function pickKerbType(u) {
  let r = u * KERB_TOTAL;
  for (const k of KERB_TYPES) {
    r -= k.w;
    if (r <= 0) return k;
  }
  return KERB_TYPES[0];
}

export class Layout {
  constructor({ world, lib, peek, q }) {
    this.world = world;
    this.lib = lib;
    /** Runtime access to other subsystems — never an import (rule 2). */
    this.peek = peek ?? (() => null);
    /**
     * `q.grassDensity` was declared in `src/core/config.js` for all four tiers
     * and read by nobody, so the ground cover cost the same on `low` as on
     * `ultra`. It scales the verge and park scatter, which is where every blade
     * of grass in the game comes from.
     */
    this.grassDensity = q?.grassDensity ?? 0.6;
    this._laneNet = null;
    this._walkCache = new Map(); // edge.id -> { hw, sw, padA, padB }
    this._poles = [];
    this._edges = [];
    this.trolleyDistricts = new Set(['downtown', 'strip', 'point']);
    /** How many extra turning-leaf materials took. See `_registerAutumn`. */
    this._autumnExtra = this._registerAutumn();
  }

  /**
   * ───────────────────────────────────────────────────────────────────────
   * THE GUEST PASS IS GONE. THIS COUNTS; IT NO LONGER REGISTERS.
   * ───────────────────────────────────────────────────────────────────────
   * This used to walk the library for every `..._leaf0` the kit had built and
   * declare two more turning surfaces over each one — a PLACEMENT solver
   * writing entries into the canopy's own material list, which is a file it
   * does not own a vertex of. `kit_green.js` took that registration back when
   * it adopted the leaf table, and said so: "when `layout.js` drops its
   * discovery pass its copy goes with it." This is that drop.
   *
   * What is left is the one thing this file legitimately needs to know:
   * HOW MANY turning variants exist beyond the kit's own `leaf_autumn`, which
   * is what `_leafIndex` spans when it picks a canopy. It is still MEASURED
   * off the library rather than restated as a constant, for the reason the old
   * note gave and which has not changed — the two files would otherwise both
   * hold the number and could disagree — and because the measurement is what
   * makes the `?oneautumn=1` control work through this path for free: in that
   * arm the kit declares only `leaf3`, the highest index found is
   * `LEAF_GREENS`, and this correctly returns 0 without knowing the hatch
   * exists. That is why there is no `oneAutumn()` call left in here.
   *
   * Renaming it to something that says "count" is owed and is NOT this wave's
   * to make: `src/props/foliageprobe.mjs` calls it by this name.
   */
  _registerAutumn() {
    const protos = this.lib?.protos;
    if (!protos) return 0;
    let top = LEAF_GREENS;
    for (const id of protos.keys()) {
      const m = /^tree_.+_\d+_leaf(\d+)$/.exec(id);
      if (m) top = Math.max(top, +m[1]);
    }
    return Math.max(0, top - LEAF_GREENS);
  }

  /**
   * Which leaf material a tree wears, from one hash and its chance of having
   * turned. Greens are `0 .. LEAF_GREENS-1`; turning trees run from
   * `LEAF_GREENS` through however many `_registerAutumn` got.
   *
   * ONE HASH, TWO DECISIONS. `h` picks the season and then its own position
   * INSIDE whichever band it landed in picks the variant — both sub-ranges are
   * uniform, and drawing a second hash would only make the caller pass another
   * salt. The alternative, cycling the variants by instance index, is the
   * defect the street planting note below already names.
   */
  _leafIndex(h, aut) {
    const turned = 1 + this._autumnExtra;
    if (h < aut) {
      return LEAF_GREENS + Math.min(turned - 1, Math.floor((h / Math.max(1e-6, aut)) * turned));
    }
    const g = (h - aut) / Math.max(1e-6, 1 - aut);
    return Math.min(LEAF_GREENS - 1, Math.floor(g * LEAF_GREENS));
  }

  /* ================================================================== */
  /* world queries                                                      */
  /* ================================================================== */

  styleOf(x, z) {
    const d = this.world.districtAt?.(x, z);
    return (d && DISTRICT_STYLE[d.id]) || DEFAULT_STYLE;
  }

  districtIdAt(x, z) {
    return this.world.districtAt?.(x, z)?.id ?? 'lawren';
  }

  /**
   * Measure this edge's cross-section once. `edge.width` is published by the
   * world contract; the pavement width is not, so it is probed.
   */
  _walk(edge) {
    let rec = this._walkCache.get(edge.id);
    if (rec) return rec;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const hw = edge.width * 0.5;
    const mx = (na.x + nb.x) * 0.5;
    const mz = (na.z + nb.z) * 0.5;
    const rx = -edge.dz;
    const rz = edge.dx;
    let sw = 0;
    if (this.world.surfaceAt) {
      for (let d = hw + 0.45; d < hw + 6.2; d += 0.35) {
        if (this.world.surfaceAt(mx + rx * d, mz + rz * d) !== 'sidewalk') break;
        sw = d - hw - 0.33;
      }
    }
    // The probe can miss — a midpoint that happens to fall inside a junction
    // pad answers 'asphalt' and the whole street would come out bare. Fall
    // back to the corridor's own kind rather than dressing nothing.
    if (sw < 1.1 && FALLBACK_WALK[edge.kind]) sw = FALLBACK_WALK[edge.kind];

    /**
     * Junction clearance. `world` stops the carriageway short of a node by
     * roughly the widest connecting road; furniture has to clear the same
     * circle plus a little for the corner fillet — but no more than that. An
     * over-generous pad is why a first pass left every short block completely
     * bare: at 14 m per end, a 40 m block has 12 m of usable kerb.
     */
    const pad = (nodeId) => {
      const n = g.nodes[nodeId];
      let r = 3;
      for (const eid of n.links) r = Math.max(r, g.edges[eid].width * 0.5);
      return r * (n.links.length > 2 ? 1.18 : 1.02) + 1.2;
    };
    rec = { hw, sw, padA: pad(edge.a), padB: pad(edge.b) };
    this._walkCache.set(edge.id, rec);
    return rec;
  }

  /** World position on the pavement: `off` metres out from the kerb face. */
  _pos(edge, s, side, off, out = _v) {
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const t = s / edge.len;
    const w = this._walk(edge);
    const lat = (w.hw + 0.33 + off) * side;
    out.x = na.x + (nb.x - na.x) * t - edge.dz * lat;
    out.z = na.z + (nb.z - na.z) * t + edge.dx * lat;
    // road level at the kerb + kerb height + the pavement's cross-fall
    out.y = na.y + (nb.y - na.y) * t + 0.150 + off * 0.02;
    return out;
  }

  /** Yaw that faces the carriageway from `side`. */
  _facing(edge, side) {
    return Math.atan2(-edge.dz * side, edge.dx * side);
  }

  /** Yaw along the street. */
  _along(edge) {
    return Math.atan2(edge.dx, edge.dz);
  }

  /* ================================================================== */
  /* the tile entry point                                               */
  /* ================================================================== */

  /**
   * @param {TileBatch} B
   * @param {{x0,z0,x1,z1}} bx tile bounds in XZ
   * @param {number} lod 0 = full detail, 1 = the far skeleton
   */
  buildTile(B, bx, lots, lod, rng, parked) {
    const roads = this.world.roads;
    if (!roads) return;
    const edges = this._edges;
    edges.length = 0;
    roads.edgesInRect(bx.x0 - 40, bx.z0 - 40, bx.x1 + 40, bx.z1 + 40, edges);

    for (const e of edges) {
      if (e.rail) continue;
      this._edgeFurniture(B, e, bx, lod, parked);
      this._edgeWires(B, e, bx, lod);
      if (lod === 0) this._edgeDecals(B, e, bx);
    }
    for (const lot of lots ?? []) this._lot(B, lot, bx, lod, rng, parked);
    if (lod === 0) this._wasteGround(B, bx, lots, rng);
    this._placeGreens(B, bx, lod);
    if (lod === 0) this._placeSigns(B, bx);
  }

  /* ================================================================== */
  /* THE PLANTED LANDMARKS — Oakland's quad and park, Color Park's bank */
  /* ================================================================== */

  /**
   * `buildings` authors the hard landscape of a park — the walks, the
   * bandstand, the pond coping, the painted slabs — and stops there, because
   * VEGETATION IS THIS SUBSYSTEM'S. `kit_green.js` owns the five species,
   * their four canopy variants, the far tier and the seven leaf materials, and
   * a second tree grown in `buildings` would be the Point Fountain defect with
   * a trunk on it: two subsystems deciding one fact (ARCHITECTURE.md rule 12).
   * So the trees for `lm_ironwood`, `lm_cathedral` and `lm_colorpark` are
   * planted here, off the published `world.landmarks` entry.
   *
   * TILE-INDEPENDENCE, in the form the file header calls the second one. The
   * candidate list is a pure function of the landmark's own id and geometry —
   * the same 230 points every boot, in the same order, whatever tile is being
   * built — and each candidate is emitted ONLY by the tile whose bounds
   * contain it. So a park that straddles four tiles plants each of its trees
   * exactly once, no tree falls down a seam, and nothing doubles up when a
   * tile is rebuilt at a different LOD. The `_in` test is applied BEFORE the
   * terrain and lane queries, so a tile nowhere near a park pays two hashes
   * per candidate and no more.
   */
  _placeGreens(B, bx, lod) {
    for (const lm of this.world.landmarks ?? []) {
      if (lm.kind !== 'greenpark' && lm.kind !== 'cathedral' && lm.kind !== 'colorpark') continue;
      const s = lm.site;
      const reach = (s ? Math.hypot(s.hx ?? 0, s.hz ?? 0) + (s.r ?? 0) : 40) + 8;
      if (lm.x + reach < bx.x0 || lm.x - reach > bx.x1) continue;
      if (lm.z + reach < bx.z0 || lm.z - reach > bx.z1) continue;
      const seed = this._siteSeed(lm.id);
      if (lm.kind === 'greenpark') this._parkPlanting(B, bx, lod, lm, seed);
      else if (lm.kind === 'cathedral') this._quadPlanting(B, bx, lod, lm, seed);
      else this._bankPlanting(B, bx, lod, lm, seed);
    }
  }

  /** A stable 32-bit seed from a landmark id. Same city every boot. */
  _siteSeed(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  /**
   * Plant ONE candidate. `mix` is the cumulative roll: below `mix[0]` a canopy
   * tree, below `mix[1]` a pine, below `mix[2]` a shrub, otherwise a drift of
   * grass. Returns nothing — a candidate that fails any guard simply does not
   * get planted, which is what a park with a path through it looks like.
   */
  _plantOne(B, bx, lod, seed, i, x, z, mix, clear = 2.2) {
    if (!this._in(bx, x, z)) return;
    if (this.world.isWater?.(x, z)) return;
    const y = this.world.heightAt(x, z);
    if (!Number.isFinite(y)) return;
    if (!this._clearsLanes(x, y, z, clear)) return;
    const h0 = hash3i(seed, i, 1);
    const h1 = hash3i(seed, i, 2);
    const roll = hash3i(seed, i, 3);
    const yaw = hash3i(seed, i, 4) * TAU;
    const sc = 0.85 + hash3i(seed, i, 5) * 0.7;
    const mask = [0.45 + h0 * 0.8, 0.35 + h1 * 0.7, 0.7];
    if (roll < mix[0] && this._headroom(x, y, z, 9.5 * sc)) {
      const sp = STREET_SPECIES[Math.floor(hash3i(seed, i, 6) * STREET_SPECIES.length) % STREET_SPECIES.length];
      const v = lod !== 0 ? 'far' : Math.floor(hash3i(seed, i, 7) * 4) % 4;
      const li = lod !== 0 ? 0 : this._leafIndex(hash3i(seed, i, 8), 0.22);
      const M = trs(new THREE.Matrix4(), x, y - 0.02, z, yaw, sc, sc * (0.92 + h1 * 0.34), sc,
        (h0 - 0.5) * 0.08, (h1 - 0.5) * 0.08);
      B.put(`tree_${sp}_${v}_wood`, M, mask);
      B.put(`tree_${sp}_${v}_leaf${li}`, M, mask);
      if (lod === 0) B.box('wood', x, y, z, 0.36, 2.6, 0.36);
      return;
    }
    if (roll < mix[1] && this._headroom(x, y, z, 9 * sc)) {
      const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc);
      B.put('tree_pine_wood', M, mask);
      B.put('tree_pine_leaf', M, mask);
      return;
    }
    if (lod !== 0) return;
    if (roll < mix[2]) {
      B.put(['shrub_a', 'shrub_b', 'shrub_c'][i % 3],
        trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      return;
    }
    // A lawn is a drift of grass, not one tuft every ten metres — same
    // reasoning, and the same `q.grassDensity` scaling, as `_park`.
    const gn = Math.max(1, Math.round(5 * this.grassDensity));
    for (let k = 0; k < gn; k++) {
      const g0 = hash3i(seed, i * 11 + k, 41);
      const g1 = hash3i(seed, i * 11 + k, 42);
      const gx = x + (g0 - 0.5) * 2.4;
      const gz = z + (g1 - 0.5) * 2.4;
      if (!this._in(bx, gx, gz)) continue;
      const gy = this.world.heightAt(gx, gz);
      if (!this._clearsLanes(gx, gy, gz, 0.5)) continue;
      const gs = sc * (0.7 + 0.8 * g0);
      B.put('grass_clump', trs(new THREE.Matrix4(), gx, gy, gz, g1 * TAU, gs * 1.5, gs, gs * 1.5), mask);
    }
  }

  /** A bench, and a bin thrown clear of it on the bench's own yaw. */
  _parkSeat(B, bx, seed, i, x, z, yaw) {
    if (!this._in(bx, x, z)) return;
    const y = this.world.heightAt(x, z);
    if (!Number.isFinite(y) || !this._clearsLanes(x, y, z, 1.6)) return;
    const M = trs(new THREE.Matrix4(), x, y, z, yaw, 1, 1, 1, 0, (hash3i(seed, i, 14) - 0.5) * 0.03);
    B.put('bench_slat', M, [0.8, 0.7, 0.5]);
    B.put('bench_ends', M, [0.8, 0.9, 0.5]);
    if (hash3i(seed, i, 15) < 0.55) {
      const px = x + Math.cos(yaw) * 2.4;
      const pz = z + Math.sin(yaw) * 2.4;
      if (this._in(bx, px, pz) && this._clearsLanes(px, y, pz, 0.4)) {
        B.put('bin_mesh', trs(new THREE.Matrix4(), px, y, pz, hash3i(seed, i, 16) * TAU), [0.9, 0.9, 0.6]);
      }
    }
  }

  /**
   * IRONWOOD PARK. Trees over the whole disc except the three places
   * `buildings` already occupies — the bandstand at the centre, the pond on
   * the north-west quarter, and the 3.4 m ring of hoggin at r = R - 24, which
   * is a path and gets benches instead of maples.
   */
  _parkPlanting(B, bx, lod, lm, seed) {
    const R = lm.site?.r ?? 84;
    const n = Math.max(24, Math.round((Math.PI * R * R) / 96));
    const pondX = lm.x - R * 0.42;
    const pondZ = lm.z + R * 0.34;
    for (let i = 0; i < n; i++) {
      // Sunflower-ish placement: a golden-angle spiral jittered by two hashes,
      // which fills a disc evenly without the clumping a uniform square draw
      // gives you after rejection.
      const t = (i + 0.5) / n;
      const rr = Math.sqrt(t) * (R - 5) * (0.94 + hash3i(seed, i, 51) * 0.12);
      const a = i * 2.39996 + hash3i(seed, i, 52) * 0.5;
      const x = lm.x + Math.cos(a) * rr;
      const z = lm.z + Math.sin(a) * rr;
      if (rr < 13) continue;                                   // the bandstand
      if (Math.abs(rr - (R - 24.3)) < 3.2) continue;           // the path loop
      if (Math.hypot(x - pondX, z - pondZ) < 19) continue;     // the pond
      this._plantOne(B, bx, lod, seed, i, x, z, [0.40, 0.50, 0.62]);
    }
    if (lod !== 0) return;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + 0.31;
      const rr = R - 20.4;
      this._parkSeat(B, bx, seed, i, lm.x + Math.cos(a) * rr, lm.z + Math.sin(a) * rr, a + Math.PI);
    }
  }

  /**
   * THE CATHEDRAL'S QUAD. A campus lawn is mown, not wooded: the planting is a
   * FRAME rather than a fill — a rank of trees down each long edge inside the
   * boundary wall, nothing at all across the middle, because the whole point
   * of the site is the tower standing alone on grass and a canopy in front of
   * it is the one thing that would cost the silhouette.
   */
  _quadPlanting(B, bx, lod, lm, seed) {
    const HU = lm.site?.hx ?? 54;
    const HV = lm.site?.hz ?? 42;
    const yaw = lm.site?.yaw ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const W = (u, v) => [lm.x + u * c - v * s, lm.z + u * s + v * c];
    let i = 0;
    for (const sv of [-1, 1]) {
      for (let k = 0; k < 13; k++, i++) {
        const u = -HU + 6 + (k / 12) * (HU * 2 - 12);
        // The ranges stand at |v| = HV - 12 with a 15 m depth, so the trees go
        // between the wall and the range: |v| = HV - 3.
        const [x, z] = W(u + (hash3i(seed, i, 61) - 0.5) * 3.0, sv * (HV - 3.0));
        if (hash3i(seed, i, 62) > 0.82) continue;   // a pit nobody replanted
        this._plantOne(B, bx, lod, seed, i, x, z, [0.86, 0.86, 0.94], 2.0);
      }
    }
    if (lod !== 0) return;
    /**
     * THE LAWN. "Alone on its lawn" is the whole composition, and a landmark
     * cannot paint one: `buildings` has no ground surface in its palette and
     * the terrain layer under a dense district resolves to worn earth
     * (`terrainmesh` picks `terrain_dirt` off `urbanAt`, which is 0.72 here).
     * So the grass is instanced — `grass_clump` is 56 triangles, no shadow,
     * culled at 145 m — over the two halves of the quad the walks and the
     * plinth leave free.
     */
    for (let k = 0; k < 150; k++, i++) {
      const u = -HU + 4 + hash3i(seed, i, 65) * (HU * 2 - 8);
      const v = -HV + 4 + hash3i(seed, i, 66) * (HV * 2 - 8);
      if (Math.abs(u) < 20 && Math.abs(v) < 18) continue;   // the plinth
      if (Math.abs(v) > HV - 20 && Math.abs(v) < HV - 4) continue;   // the ranges
      if (Math.abs(u) < 3.4 || Math.abs(v) < 3.4) continue; // the cross walk
      const [x, z] = W(u, v);
      if (!this._in(bx, x, z)) continue;
      const y = this.world.heightAt(x, z);
      if (!Number.isFinite(y) || !this._clearsLanes(x, y, z, 0.6)) continue;
      const gs = 0.8 + hash3i(seed, i, 67) * 0.7;
      B.put('grass_clump', trs(new THREE.Matrix4(), x, y, z,
        hash3i(seed, i, 68) * TAU, gs * 1.6, gs, gs * 1.6), [0.4, 0.35, 0.7]);
    }
    // Benches face the cross walk, four a side, looking at the tower.
    for (const sv of [-1, 1]) {
      for (let k = 0; k < 4; k++, i++) {
        const u = -HU * 0.62 + (k / 3) * HU * 1.24;
        const [x, z] = W(u, sv * 9.5);
        this._parkSeat(B, bx, seed, i, x, z, yaw + (sv > 0 ? Math.PI : 0));
      }
    }
  }

  /**
   * COLOR PARK. Nothing is planted on the painted apron — the apron is the
   * point — so this is a screen of trees along the inland edge behind the
   * retaining wall, plus benches and bins on the trail between the paint and
   * the river, and then the PAINT ITSELF (`props/colorpark.js`: the tarmac
   * skin, the pieces on it, the murals on the wall). The wall face is at
   * v = HV - 3.0 and the trail at v = -0.86 HV; both numbers come off the same
   * `site` the geometry is built from, on both sides of the subsystem line.
   */
  _bankPlanting(B, bx, lod, lm, seed) {
    const HU = lm.site?.hx ?? 76;
    const HV = lm.site?.hz ?? 16;
    const yaw = lm.site?.yaw ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const W = (u, v) => [lm.x + u * c - v * s, lm.z + u * s + v * c];
    let i = 0;
    for (let k = 0; k < 16; k++, i++) {
      const u = -HU + 4 + (k / 15) * (HU * 2 - 8);
      const [x, z] = W(u + (hash3i(seed, i, 71) - 0.5) * 3.5, HV + 1.6 + hash3i(seed, i, 72) * 2.0);
      if (hash3i(seed, i, 73) > 0.80) continue;
      this._plantOne(B, bx, lod, seed, i, x, z, [0.72, 0.80, 0.94], 2.0);
    }
    if (lod !== 0) return;
    for (let k = 0; k < 7; k++, i++) {
      const u = -HU + 12 + (k / 6) * (HU * 2 - 24);
      const [x, z] = W(u, -HV * 0.86 + 2.6);
      this._parkSeat(B, bx, seed, i, x, z, yaw + Math.PI);
    }
    /**
     * THE PAINT. LOD 0 only — the whole point of it is 3 cm of relief read at
     * walking distance, and the impostor tier has no business carrying 6 000
     * triangles of aerosol.
     */
    paintColorPark(B, bx, lm, this.world, seed);
  }

  /* ================================================================== */
  /* NAMED PLACES — bridges, the mill gate, the incline station         */
  /* ================================================================== */

  /**
   * A clear spot for a free-standing sign, searched rather than assumed.
   *
   * Every one of these signs stands next to something big that `world` and
   * `buildings` placed — a bridge abutment, a blast furnace, a funicular
   * trestle — and the sign is the only thing in the frame that will be read
   * from two metres away, so it cannot be shoved at a nominal offset and
   * hoped for. This walks a ring of bearings, keeps only the candidates that
   * are dry, off the carriageway by `clear` and have headroom, and returns the
   * one CLOSEST TO A ROAD, because a gate nobody drives past is not a gate.
   *
   * Returns null when nothing on the ring qualifies, and the caller then draws
   * no sign at all.
   */
  /**
   * The same search over several rings, nearest first.
   *
   * ONE RING IS A COIN TOSS. A landmark's own radius is where its apron ends,
   * and whether that ring happens to contain a spot that is dry, has 6 m of
   * lane clearance and 7 m of headroom depends entirely on what `buildings`
   * put on the site — which is why the first pass at the mill gate placed
   * nothing at all in `--shot=mill`. Widening the search is the fix; giving up
   * silently is not, because a landmark with no sign is the finding.
   */
  _signSpotRings(cx, cz, radii, clear, headroom) {
    for (let i = 0; i < radii.length; i++) {
      const s = this._signSpot(cx, cz, radii[i], clear, headroom);
      if (s) return s;
    }
    return null;
  }

  _signSpot(cx, cz, r, clear, headroom) {
    const roads = this.world.roads;
    const near = roads ? roads.edgesInRect(cx - 90, cz - 90, cx + 90, cz + 90, []) : [];
    let best = null;
    let bestD = Infinity;
    /**
     * THE ROAD IS A PREFERENCE, NOT A PRECONDITION. Scoring by distance to the
     * nearest road puts the gate where the traffic is — but a landmark whose
     * apron has no corridor inside the 180 m query box then scored EVERY
     * candidate at Infinity and `d >= bestD` rejected all of them, so the
     * Duquesne Incline came out with no station board at all. Keep the first
     * qualifying bearing as a fallback so "no road nearby" degrades to "signed
     * somewhere sensible" rather than to "not signed".
     */
    let any = null;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (this.world.isWater?.(x, z)) continue;
      const y = this.world.heightAt(x, z);
      if (!Number.isFinite(y)) continue;
      if (!this._clearsLanes(x, y, z, clear)) continue;
      if (!this._headroom(x, y, z, headroom)) continue;
      if (!any) any = { x, y, z, a };
      let d = Infinity;
      for (let k = 0; k < near.length; k++) {
        const e = near[k];
        if (e.rail) continue;
        const na = roads.nodes[e.a];
        const nb = roads.nodes[e.b];
        if (!na || !nb) continue;
        d = Math.min(d, Math.hypot((na.x + nb.x) / 2 - x, (na.z + nb.z) / 2 - z));
      }
      if (d >= bestD) continue;
      bestD = d;
      best = { x, y, z, a };
    }
    return best ?? any;
  }

  /**
   * A named plate on two posts. `lines` sets the plate's WIDTH — a two-word
   * bridge name gets a wider plate than 'GATE 3', which is what a fabricated
   * steel sign actually does; the plate is not a fixed rectangle the words are
   * squeezed into.
   */
  _plaque(B, lines, x, y, z, yaw, mask) {
    const rows = Array.isArray(lines) ? lines : [lines];
    let w = 0;
    for (const r of rows) w = Math.max(w, r.length);
    const pw = Math.min(4.4, Math.max(1.6, w * 0.145 + 0.5));
    const M = trs(new THREE.Matrix4(), x, y, z, yaw, pw, 1, 1);
    B.put('plaque_posts', M, mask);
    B.put('plaque_plate', M, mask);
    this._type(B, rows, 'sign_pale',
      x + Math.sin(yaw) * 0.10, y + 1.72, z + Math.cos(yaw) * 0.10, yaw,
      pw * 0.86, 0.42, mask);
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE PLACES THAT HAVE NAMES IN THE PLAN TABLES.
   * ─────────────────────────────────────────────────────────────────────────
   * `world.bridges` and `world.landmarks` carry the names — Sixth Street
   * Bridge, Hot Metal Bridge, the Old Blast Furnace, the Duquesne Incline —
   * and until this pass none of them appeared anywhere a player could read.
   * Every sign here is derived from the SHIPPED table (`world.*` at runtime,
   * never `plan.js`, which is another subsystem's module), so a bridge that
   * moves takes its plaque with it.
   *
   * TILE-INDEPENDENCE. These are world singletons, not edge-derived props, so
   * the rule at the top of this file applies in its second form: each one is
   * emitted by exactly the tile whose bounds contain its own anchor, which is
   * a pure function of the anchor and therefore cannot double up or fall down
   * a seam.
   */
  _placeSigns(B, bx) {
    const mask = [0.85, 0.8, 0.4];

    // ---- bridge name plaques, at both ends of every crossing -------------
    for (const b of this.world.bridges ?? []) {
      if (!b?.name || !b.a || !b.b) continue;
      const dx = b.b[0] - b.a[0];
      const dz = b.b[1] - b.a[1];
      const l = Math.hypot(dx, dz) || 1;
      for (const end of [0, 1]) {
        const ax = end === 0 ? b.a[0] : b.b[0];
        const az = end === 0 ? b.a[1] : b.b[1];
        if (!this._in(bx, ax, az)) continue;
        // Perpendicular to the deck, walked outward until it is off the road.
        const px = -dz / l;
        const pz = dx / l;
        let spot = null;
        for (const s of [1, -1]) {
          for (let d = 7; d <= 16 && !spot; d += 2.5) {
            const x = ax + px * s * d;
            const z = az + pz * s * d;
            if (this.world.isWater?.(x, z)) continue;
            const y = this.world.heightAt(x, z);
            if (!Number.isFinite(y)) continue;
            if (!this._clearsLanes(x, y, z, 2.6)) continue;
            spot = { x, y, z };
          }
          if (spot) break;
        }
        if (!spot) continue;
        // Facing back along the deck, so it is read on the way onto the bridge.
        const yaw = Math.atan2(end === 0 ? dx / l : -dx / l, end === 0 ? dz / l : -dz / l);
        const name = String(b.name).toUpperCase();
        const cut = name.lastIndexOf(' ');
        this._plaque(B, cut > 0 ? [name.slice(0, cut), name.slice(cut + 1)] : [name],
          spot.x, spot.y, spot.z, yaw, mask);
      }
    }

    // ---- the landmarks that a working city labels ------------------------
    for (const lm of this.world.landmarks ?? []) {
      if (!this._in(bx, lm.x, lm.z)) continue;
      /**
       * THE RING TO SEARCH FOR A SIGN SPOT ON, AND WHY IT IS NOT `site.r`.
       *
       * `site` is a rounded box: `r` is the CORNER RADIUS, not the size. For
       * the six original landmarks that was harmless — five of them are discs
       * or near-discs, where `r` is the whole shape — but the Cathedral's quad
       * is `hx 54 x hz 42, r 12`, so `r + 6` would start the search 18 m from
       * the centre, which is inside the tower's own plinth. The box-shaped
       * sites take the half diagonal instead.
       *
       * SCOPED TO THE NEW KINDS ON PURPOSE. The six original landmarks keep
       * the ring they were tuned against — the Strip Market's plaque has been
       * placed off `r + 6` = 9 m since it was authored, and moving it to 70 m
       * would be a silent regression in somebody else's content for the sake
       * of a tidier expression here.
       */
      const boxy = lm.kind === 'cathedral' || lm.kind === 'greenpark' || lm.kind === 'colorpark';
      const r = boxy
        ? Math.hypot(lm.site?.hx ?? 0, lm.site?.hz ?? 0) + (lm.site?.r ?? 30) + 6
        : (lm.site?.r ?? 30) + 6;
      if (lm.kind === 'mill') {
        /**
         * THE WORKS GATE. A riveted arch over the entrance is how every plant
         * in this valley announced itself, and DESIGN.md's Old Blast Furnace
         * is the district's whole identity. The arch is 7.1 m across, so the
         * spot has to clear the carriageway by more than a plaque does.
         */
        const spot = this._signSpotRings(lm.x, lm.z, [r, r + 16, r + 32, r - 14], 6.0, 7);
        if (spot) {
          const yaw = Math.atan2(Math.cos(spot.a), Math.sin(spot.a));
          B.put('gate_arch',
            trs(new THREE.Matrix4(), spot.x, spot.y, spot.z, yaw), [0.9, 0.85, 0.5]);
          this._type(B, String(lm.name).toUpperCase(), 'sign_pale',
            spot.x + Math.sin(yaw) * 0.14, spot.y + 5.62, spot.z + Math.cos(yaw) * 0.14,
            yaw, 6.2, 0.62, [0.9, 0.85, 0.35]);
          this._type(B, 'STEEL ROW WORKS · GATE 3', 'sign_ink',
            spot.x + Math.sin(yaw) * 0.14, spot.y + 4.66, spot.z + Math.cos(yaw) * 0.14,
            yaw, 5.4, 0.30, [0.9, 0.85, 0.35]);
          B.box('metal', spot.x, spot.y, spot.z, 7.4, 5.4, 0.6, yaw);
          continue;
        }
        // A 7.4 m arch did not fit anywhere on the site. A plate on two posts
        // needs a third of the clearance and a fifth of the headroom, and the
        // works being NAMED matters more than the arch that names it.
        const alt = this._signSpotRings(lm.x, lm.z, [r, r + 16, r + 32, r - 14], 3.0, 4);
        if (!alt) continue;
        this._plaque(B, [String(lm.name).toUpperCase(), 'STEEL ROW WORKS'],
          alt.x, alt.y, alt.z, Math.atan2(Math.cos(alt.a), Math.sin(alt.a)), mask);
      } else if (lm.kind === 'incline') {
        // The funicular's lower station board. `uphill.run` is the length of
        // the track, so the base of it is the landmark itself.
        const spot = this._signSpotRings(lm.x, lm.z,
          [Math.max(14, r), Math.max(14, r) + 14, Math.max(14, r) + 28], 3.0, 4);
        if (!spot) continue;
        const yaw = Math.atan2(Math.cos(spot.a), Math.sin(spot.a));
        this._plaque(B, [String(lm.name).toUpperCase(), 'LOWER STATION'],
          spot.x, spot.y, spot.z, yaw, mask);
      } else if (lm.kind === 'market' || lm.kind === 'stadium'
        || lm.kind === 'cathedral' || lm.kind === 'greenpark' || lm.kind === 'colorpark') {
        /**
         * The Oakland / South Side wave: a board on two posts, on the ring
         * road the reserve laid round each site. Same search and same fallback
         * as the market and the stadium — these are places with names on the
         * map, and a place named on the map and nowhere on the ground is a
         * wayfinding defect, not a missing decoration.
         */
        const spot = this._signSpotRings(lm.x, lm.z,
          [Math.max(12, r), Math.max(12, r) + 14, Math.max(12, r) + 28], 3.0, 4);
        if (!spot) continue;
        const yaw = Math.atan2(Math.cos(spot.a), Math.sin(spot.a));
        this._plaque(B, String(lm.name).toUpperCase(), spot.x, spot.y, spot.z, yaw, mask);
      }
    }
  }

  _in(bx, x, z) {
    return x >= bx.x0 && x < bx.x1 && z >= bx.z0 && z < bx.z1;
  }

  /* ================================================================== */
  /* street furniture along an edge                                     */
  /* ================================================================== */

  _edgeFurniture(B, edge, bx, lod, parked) {
    const w = this._walk(edge);
    if (w.sw < 1.1 && edge.kind !== 'alley') return;
    const L = edge.len;
    const s0 = w.padA;
    const s1 = L - w.padB;
    if (s1 - s0 < 6) return;
    const eSeed = (edge.id * 2654435761) >>> 0;

    for (const side of [-1, 1]) {
      const mid = this._pos(edge, L * 0.5, side, 1.0, new THREE.Vector3());
      const style = this.styleOf(mid.x, mid.z);
      const district = this.districtIdAt(mid.x, mid.z);
      const sSeed = (eSeed ^ (side > 0 ? 0x5bf03635 : 0x27d4eb2d)) >>> 0;

      this._lampRun(B, edge, side, s0, s1, sSeed, style, bx, lod);
      this._treeRun(B, edge, side, s0, s1, sSeed, style, bx, lod, w);
      this._cornerKit(B, edge, side, s0, s1, sSeed, style, bx, lod);
      if (lod === 0) {
        this._kerbClutter(B, edge, side, s0, s1, sSeed, style, bx, w, district);
        this._wallClutter(B, edge, side, s0, s1, sSeed, style, bx, w, district);
      }
      if (parked) this._parking(edge, side, s0, s1, sSeed, style, bx, parked);
    }
  }

  /* -------------------------------------------------------- lamp posts -- */

  _lampRun(B, edge, side, s0, s1, seed, style, bx, lod) {
    // Lamps stagger: one side gets them at 0, the other at half a pitch, which
    // is what a real street does and what stops a corridor of paired columns.
    const kind = style.lampKind;
    const pitch = (kind === 'acorn' || kind === 'park' ? 21 : 29) * (0.86 + hash3i(seed, 1, 1) * 0.3);
    const phase = side > 0 ? 0.5 : 0;
    // Alleys get a wall bracket, not a column.
    if (edge.kind === 'alley') return;
    const both = edge.kind === 'arterial' || edge.kind === 'highway' || style.lampKind === 'twin';
    if (!both && side < 0) return;

    const wk = this._walk(edge);
    const maxOff = Math.max(KERB_LANE + 0.2, wk.sw - 0.45);
    let i = 0;
    for (let s = s0 + pitch * phase; s < s1; s += pitch, i++) {
      const h = hash3i(seed, i, 11);
      if (h > 0.94) continue; // one column in sixteen was never replaced
      const p = this._clearOff(edge, s + (h - 0.5) * 2.4, side, KERB_LANE + h * 0.18,
        SIGN_CLEAR, maxOff, new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const face = this._facing(edge, side);
      const yaw = face + (hash3i(seed, i, 12) - 0.5) * 0.14;
      const lean = (hash3i(seed, i, 13) - 0.5) * 0.035;
      const sc = 0.94 + hash3i(seed, i, 14) * 0.14;
      const mask = [
        0.55 + hash3i(seed, i, 15) * 0.75,
        0.5 + hash3i(seed, i, 16) * 0.85,
        0.6 + hash3i(seed, i, 17) * 0.5,
      ];
      const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc, lean, lean * 0.6);

      if (kind === 'acorn' || kind === 'park') {
        const tag = kind;
        B.put(`lamp_${tag}`, M, mask);
        B.put(`lamp_${tag}_globe`, M, mask);
        if (lod === 0) B.put(`lamp_${tag}_glow`, M, null);
      } else if (kind === 'twin') {
        B.put('lamp_twin', M, mask);
        B.put('lamp_twin_head', M, mask);
        B.put('lamp_twin_lens', M, mask);
        if (lod === 0) B.put('lamp_twin_glow', M, null);
      } else {
        // Not `i % 3`: a cycle of three down a 29 m pitch is a repeat every 87 m,
        // and a critic logged "the same lamp" down one block.
        const v = Math.floor(hash3i(seed, i, 111) * 3) % 3;
        B.put(`lamp_cobra_${v}`, M, mask);
        B.put(`lamp_cobra_head_${v}`, M, mask);
        B.put(`lamp_cobra_lens_${v}`, M, mask);
        if (lod === 0) B.put(`lamp_cobra_glow_${v}`, M, null);
      }
      if (lod === 0) {
        B.box('metal', p.x, p.y, p.z, 0.26, 3.0, 0.26);
        /**
         * Record where the light actually IS. Street lighting is emissive plus
         * bloom (ARCHITECTURE.md is explicit that a punctual light per lamp is
         * not affordable), but `render.submitLight` scores a handful of nearby
         * requests into a FIXED pool, so the two or three lamps closest to the
         * camera can be real — which is what puts a moving sodium pool on wet
         * asphalt instead of a painted one.
         */
        const armR = kind === 'acorn' || kind === 'park' ? 0 : 2.1 * sc;
        B.lamps.push({
          x: p.x - Math.sin(yaw) * 0 + Math.cos(yaw) * 0 + (kind === 'twin' ? 0 : Math.cos(yaw) * 0),
          y: p.y + (kind === 'acorn' ? 4.3 : kind === 'park' ? 3.2 : 8.9) * sc,
          z: p.z,
          r: armR,
          yaw,
        });
        // the things that end up bolted to a lamp column
        const r = hash3i(seed, i, 18);
        if (r < 0.22) {
          // Bolted to the column but 0.11 m off it, on the road-facing side —
          // enough to cross a lane edge the column itself just cleared.
          const px = p.x - Math.sin(yaw) * 0.11;
          const pz = p.z - Math.cos(yaw) * 0.11;
          if (this._clearsLanes(px, p.y, pz, SIGN_CLEAR)) {
            B.put('sign_plate_small', trs(new THREE.Matrix4(), px, p.y + 2.1, pz, yaw), mask);
          }
        }
        if (r > 0.80 && style.signage > 0.5) {
          const byaw = yaw + Math.PI / 2;
          B.put('banner_pair', trs(new THREE.Matrix4(),
            p.x, p.y + 4.6, p.z, byaw, 1, 1, 1), mask);
          /**
           * A CIVIC BANNER WITH NOTHING ON IT IS A GREY SHEET, and two of them
           * were the largest objects in the foreground of `--shot=hero`. A pole
           * banner exists to name the district it hangs in, so it says so: the
           * name comes off `world.districtAt` through `districtIdAt`, which is
           * the same table `DISTRICT_STYLE` is keyed by, so a banner cannot
           * name a district it is not in.
           *
           * Both banners of the pair, both faces of each — a banner is a
           * printed sheet, not a decal, and reads from either side of the pole.
           */
          const bn = BANNER_WORDS[this.districtIdAt(p.x, p.z)] ?? BANNER_WORDS.lawren;
          for (const s of [-1, 1]) {
            for (const f of [-1, 1]) {
              this._type(B, bn, 'sign_pale',
                p.x + Math.cos(byaw) * (s * 0.32) + Math.sin(byaw) * (f * 0.03),
                p.y + 4.6 - 0.72,
                p.z - Math.sin(byaw) * (s * 0.32) + Math.cos(byaw) * (f * 0.03),
                byaw + (f < 0 ? Math.PI : 0), 0.42, 1.10, mask,
                { weight: 0.10, margin: 0.95 });
            }
          }
        }
        if (hash3i(seed, i, 19) < 0.30) {
          B.put('sticker_cluster', trs(new THREE.Matrix4(),
            p.x - Math.sin(yaw) * 0.105, p.y, p.z - Math.cos(yaw) * 0.105, yaw), null);
        }
      }
    }
  }

  /* ------------------------------------------------------------ trees -- */

  _treeRun(B, edge, side, s0, s1, seed, style, bx, lod, w) {
    if (style.trees <= 0.02) return;
    if (w.sw < 2.0) return;
    const pitch = (9.5 / Math.max(0.25, style.trees)) * (0.85 + hash3i(seed, 2, 1) * 0.35);
    /**
     * Four street species, not three. A boulevard of forty trees showed each
     * crown seven times; the callery pear is columnar and half the width of a
     * plane, so it also breaks the SKYLINE of a run of trees, which is what the
     * eye actually counts. The list is `STREET_SPECIES` — one place, three
     * call sites.
     */
    const SP = STREET_SPECIES;
    let i = 0;
    for (let s = s0 + pitch * (0.3 + hash3i(seed, 3, 1) * 0.5); s < s1; s += pitch, i++) {
      const h = hash3i(seed, i, 21);
      if (h > 0.86) continue; // a dead pit, or one nobody replanted
      const off = Math.min(w.sw - 0.95, 0.95 + hash3i(seed, i, 22) * 0.45);
      if (off < 0.7) continue;
      // A tree pit is 1 m of grate and a trunk; it cannot straddle a kerb line.
      const p = this._clearOff(edge, s + (h - 0.5) * 3.2, side, off,
        TREE_CLEAR, Math.max(off, w.sw - 0.85), new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const young = hash3i(seed, i, 23) < 0.20;
      /**
       * NO CYCLES. `SP[(i + seed) % 3]` walked plane-maple-locust-plane down
       * every block, and with three canopy variants that is a visible period of
       * three — a critic counted "the same autumn tree six times" on one street.
       * Species, canopy and leaf are now three independent hashes.
       */
      const sp = young ? 'young' : SP[Math.floor(hash3i(seed, i, 24) * SP.length) % SP.length];
      /**
       * Past the near horizon the tree switches to the FAR crown: a third of
       * the cards at nearly twice the size. A skeleton tile used to instance
       * the full 190-card canopy for a tree that resolves to twenty pixels,
       * which is most of what vegetation costs in a driving frame.
       */
      const v = lod !== 0 ? 'far' : Math.floor(hash3i(seed, i, 224) * 4) % 4;
      /**
       * Autumn is ONE species turning, not a quarter of the street. It rides on
       * the species so a block reads as a planting scheme rather than a random
       * draw, and it is rare enough that the eye does not pair two of them up.
       */
      const aut = sp === 'maple' ? 0.34 : sp === 'locust' ? 0.10 : 0.03;
      const lh = hash3i(seed, i, 25);
      // The far tier is one shared canopy in one green; a season it resolves to
      // twenty pixels of is not worth a second material.
      const li = lod !== 0 ? 0 : this._leafIndex(lh, aut);
      const yaw = hash3i(seed, i, 26) * TAU;
      const sc = 0.74 + hash3i(seed, i, 27) * 0.58;
      const scz = sc * (0.9 + hash3i(seed, i, 28) * 0.2);
      const lean = (hash3i(seed, i, 29) - 0.5) * 0.10;
      const mask = [0.5 + hash3i(seed, i, 30), 0.4 + hash3i(seed, i, 31) * 0.9, 0.7];
      // nobody plants a plane tree under a viaduct deck — see `_headroom`
      if (!this._headroom(p.x, p.y, p.z, 8.5 * sc)) continue;
      const M = trs(new THREE.Matrix4(), p.x, p.y - 0.02, p.z, yaw, sc, sc * (0.9 + hash3i(seed, i, 32) * 0.25), scz, lean, lean * 0.7);
      B.put(`tree_${sp}_${v}_wood`, M, mask);
      B.put(`tree_${sp}_${v}_leaf${li}`, M, [mask[0], mask[1] * 0.8, 0.8]);
      if (lod === 0) {
        B.put('tree_grate', trs(new THREE.Matrix4(), p.x, p.y + 0.01, p.z, yaw * 0.7, 0.86 + sc * 0.2), null);
        B.box('wood', p.x, p.y, p.z, 0.34, 2.4, 0.34);
        // The companion weed takes the tree's random yaw, so half the time it
        // is thrown 0.55 m toward the carriageway from a pit already at the kerb.
        if (hash3i(seed, i, 33) < 0.35) {
          const wx = p.x + Math.cos(yaw) * 0.55;
          const wz = p.z + Math.sin(yaw) * 0.55;
          if (this._clearsLanes(wx, p.y, wz, 0.3)) {
            B.put('weed_tuft', trs(new THREE.Matrix4(),
              wx, p.y, wz, yaw * 1.7, 0.8 + hash3i(seed, i, 34) * 0.6), null);
          }
        }
        // a tree guard on the young ones
        if (young && hash3i(seed, i, 35) < 0.5) {
          B.put('rail_guard', trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, 0.42, 0.7, 0.42), mask);
        }
      }
    }
  }

  /* ----------------------------------------------------- junction kit -- */

  /**
   * A CORNER PROP HAS TO CLEAR EVERY ARM OF ITS JUNCTION, NOT JUST ITS OWN.
   *
   * This is the bug that put a stop sign in the middle of the road, and the
   * measurement is unambiguous. Edge 716 (Sycamore,
   * 27.6 m) ends at node 719, a five-way; edge 717 leaves that same node and
   * folds back at 43 degrees over an 11 m stub. The stop sign for 716 was placed
   * at `s0 - 0.5` — half a metre INTO the junction throat — and 4.55 m out from
   * 716's own centreline, which put it 0.06 m from the centreline of 717. Dead
   * in the road, and legal by every test the old code ran,
   * because every test it ran was about edge 716.
   *
   * Two changes. The kit now starts at `s0` rather than inside the throat, and
   * when a spot still fouls a lane it RETREATS ALONG THE APPROACH before giving
   * up: at an acute fork no amount of pushing sideways helps, because sideways
   * is further into the other road. Backing off down your own kerb does.
   */
  _clearCorner(edge, end, s0, s1, side, off, clearance, out = new THREE.Vector3()) {
    const wk = this._walk(edge);
    const maxOff = Math.max(off, wk.sw - 0.4);
    for (let back = 0; back <= 8.001; back += 1.0) {
      const s = end === 0 ? s0 + back : s1 - back;
      if (s < 0 || s > edge.len) continue;
      if (this._clearOff(edge, s, side, off, clearance, maxOff, out)) return out;
    }
    return null;
  }

  _cornerKit(B, edge, side, s0, s1, seed, style, bx, lod) {
    const g = this.world.roads;
    for (const end of [0, 1]) {
      const node = g.nodes[end === 0 ? edge.a : edge.b];
      const busy = node.links.length;
      if (busy < 3) continue;
      const nSeed = (Math.imul(node.id + 1, 0x9e3779b1) ^ (side > 0 ? 7 : 13) ^ Math.imul(edge.id + 1, 31)) >>> 0;
      const p = this._clearCorner(edge, end, s0, s1, side, KERB_LANE + 0.15, SIGN_CLEAR);
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const face = this._facing(edge, side);
      const toward = end === 0 ? this._along(edge) : this._along(edge) + Math.PI;
      const mask = [0.6 + hash3i(nSeed, 1, 1) * 0.7, 0.55 + hash3i(nSeed, 2, 1) * 0.8, 0.6];

      // Real cities signalise a minority of junctions; the rest get a stop
      // sign or nothing at all. At 62% of every 3-way this kit was putting
      // twenty-two signal masts in a 128 m tile.
      const signalise = edge.kind === 'arterial' ? busy >= 3 : busy >= 4;
      if (signalise && hash3i(nSeed, 3, 1) < 0.30) {
        const yaw = toward + Math.PI + (hash3i(nSeed, 4, 1) - 0.5) * 0.1;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, 1, 0.96 + hash3i(nSeed, 5, 1) * 0.1, 1,
          (hash3i(nSeed, 6, 1) - 0.5) * 0.03);
        B.put('signal_post', M, mask);
        B.put('signal_head_main', M, mask);
        B.put('signal_head_side', M, mask);
        // Which aspect burns is a function of the junction, so opposing
        // approaches are not both green.
        const phase = Math.floor(hash3i(nSeed, 7, 1) * 3);
        const tag = ['red', 'amber', 'green'][((phase + (end === 0 ? 0 : 1)) % 3)];
        if (lod === 0) {
          B.put(`signal_lit_${tag}_main`, M, null);
          B.put(`signal_lit_${tag}_side`, M, null);
        }
        if (lod === 0) B.box('metal', p.x, p.y, p.z, 0.24, 3.2, 0.24);
      } else if (lod === 0 && hash3i(nSeed, 8, 1) < 0.55) {
        const yaw = toward + Math.PI + (hash3i(nSeed, 9, 1) - 0.5) * 0.28;
        const sc = 0.94 + hash3i(nSeed, 10, 1) * 0.14;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc,
          (hash3i(nSeed, 11, 1) - 0.5) * 0.09, (hash3i(nSeed, 12, 1) - 0.5) * 0.07);
        B.put('sign_stop', M, mask);
        B.put('sign_stop_face', M, mask);
        if (lod === 0 && hash3i(nSeed, 13, 1) < 0.3) B.put('sticker_cluster', M, null);
      }

      /**
       * ─────────────────────────────────────────────────────────────────────
       * ONE POST PER JUNCTION, AND THE NODE — NOT THE EDGE — DECIDES.
       * ─────────────────────────────────────────────────────────────────────
       * `_cornerKit` runs once per (edge, side, end), so a three-way node is
       * visited up to six times and `nSeed` differs on every visit. At p = 0.42
       * that put two and sometimes three posts on the same corner, a few
       * centimetres and a few percent of scale apart.
       *
       * That was invisible while the blades were BLANK — two coincident green
       * plates z-fight into one green plate. It stopped being invisible the
       * moment they carried words: MEASURED in `--shot=street`, the blade at
       * the Bushnell/Butler corner read as its own name printed twice, offset
       * by about a tenth of a cap height, which is what a doubled sign looks
       * like from 40 m and reads as a rendering fault rather than as a sign.
       *
       * So the node elects a single owner — its lowest-numbered link, and one
       * fixed side of it — and the 0.42 roll is taken on the NODE's own seed
       * so the density is unchanged. Nothing else in the corner kit is
       * deduplicated this way, deliberately: a junction really does get a stop
       * sign per approach.
       */
      let ownsBlade = false;
      if (lod === 0) {
        let lowest = Infinity;
        for (let li = 0; li < node.links.length; li++) {
          if (node.links[li] < lowest) lowest = node.links[li];
        }
        ownsBlade = edge.id === lowest && side === ((node.id & 1) ? 1 : -1);
      }
      const bladeSeed = Math.imul(node.id + 1, 0x9e3779b1) >>> 0;
      if (ownsBlade && hash3i(bladeSeed, 14, 1) < 0.42) {
        // Was `s0 - 1.6` — 1.6 m further into the junction than the stop sign.
        const p2 = this._clearCorner(edge, end, s0 + 1.6, s1 - 1.6, side, KERB_LANE + 0.5, SIGN_CLEAR);
        if (p2 && this._in(bx, p2.x, p2.z)) {
          const yaw = this._along(edge) + (hash3i(nSeed, 15, 1) - 0.5) * 0.2;
          const sc = 0.95 + hash3i(nSeed, 16, 1) * 0.12;
          const M = trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, yaw, sc, sc, sc, (hash3i(nSeed, 17, 1) - 0.5) * 0.05);
          B.put('sign_street_post', M, mask);
          B.put('sign_street_blades', M, mask);
          this._streetPlates(B, node, p2, yaw, sc, mask);
        }
      }

      if (lod !== 0) continue;

      // Pedestrian signal, hydrant and a bin cluster at the corner.
      if (signalise && hash3i(nSeed, 18, 1) < 0.7) {
        const p3 = this._clearCorner(edge, end, s0 + 1.4, s1 - 1.4, side, KERB_LANE + 0.05, SIGN_CLEAR);
        if (p3 && this._in(bx, p3.x, p3.z)) {
          const M = trs(new THREE.Matrix4(), p3.x, p3.y, p3.z, face + Math.PI + (hash3i(nSeed, 19, 1) - 0.5) * 0.2);
          B.put('ped_signal', M, mask);
          B.put('ped_signal_lens', M, null);
        }
      }
      if (hash3i(nSeed, 20, 1) < style.hydrant * 0.45) {
        const p4 = this._clearCorner(edge, end, s0 + 3.4, s1 - 3.4, side, KERB_LANE + 0.1, SIGN_CLEAR);
        if (p4 && this._in(bx, p4.x, p4.z)) {
          const sc = 0.92 + hash3i(nSeed, 21, 1) * 0.18;
          B.put(hash3i(nSeed, 22, 1) < 0.75 ? 'hydrant_a' : 'hydrant_b',
            trs(new THREE.Matrix4(), p4.x, p4.y, p4.z, hash3i(nSeed, 23, 1) * TAU, sc, sc, sc,
              (hash3i(nSeed, 24, 1) - 0.5) * 0.08), mask);
        }
      }
    }
  }

  /* ---------------------------------------------------- kerb clutter --- */

  _kerbClutter(B, edge, side, s0, s1, seed, style, bx, w, district) {
    const usable = s1 - s0;
    if (usable < 8) return;
    const face = this._facing(edge, side);
    const along = this._along(edge);
    /** How far back across the footway a fouled prop may be pushed. */
    const maxOff = Math.max(KERB_LANE + 0.3, w.sw - 0.5);

    // Parking meters: a metronome by design, so they get the jitter instead.
    if (style.meters > 0.08 && edge.kind !== 'alley' && hash3i(seed, 41, 1) < style.meters) {
      const pitch = 5.8 + hash3i(seed, 42, 1) * 1.4;
      let i = 0;
      for (let s = s0 + 3; s < s1 - 3; s += pitch, i++) {
        const h = hash3i(seed, i, 43);
        if (h > 0.88) continue;
        const p = this._clearOff(edge, s + (h - 0.5) * 0.8, side, KERB_LANE - 0.1,
          KERB_CLEAR, maxOff, new THREE.Vector3());
        if (!p || !this._in(bx, p.x, p.z)) continue;
        const id = hash3i(seed, i, 44) < 0.55 ? 'meter_single' : 'meter_twin';
        const sc = 0.94 + hash3i(seed, i, 45) * 0.12;
        B.put(id, trs(new THREE.Matrix4(), p.x, p.y, p.z,
          face + (hash3i(seed, i, 46) - 0.5) * 0.4, sc, sc, sc,
          (hash3i(seed, i, 47) - 0.5) * 0.12, (hash3i(seed, i, 48) - 0.5) * 0.10),
          [0.6 + h, 0.5 + hash3i(seed, i, 49) * 0.9, 0.6]);
      }
    }

    // Everything else: a Poisson-ish walk down the kerb, family drawn by weight.
    const FAMS = [
      { id: ['bin_mesh'], w: 0.9, len: 0.7, tag: 'metal' },
      { id: ['bin_drum'], w: 0.5, len: 0.8, tag: 'metal' },
      { id: ['bin_concrete'], w: 0.4, len: 0.9, tag: 'concrete' },
      { id: ['bollard_steel'], w: 0.8, len: 0.4, tag: 'metal' },
      { id: ['bollard_iron'], w: 0.6, len: 0.4, tag: 'metal' },
      { id: ['bollard_concrete'], w: 0.4, len: 0.5, tag: 'concrete' },
      { id: ['bollard_flex'], w: 0.3, len: 0.3, tag: 'plastic' },
      { id: ['bench_slat', 'bench_ends'], w: 0.55, len: 2.0, tag: 'wood', bench: true },
      { id: ['bench_concrete'], w: 0.3, len: 2.0, tag: 'concrete', bench: true },
      { id: ['postbox_us'], w: 0.22, len: 0.8, tag: 'metal' },
      { id: ['postbox_relay'], w: 0.18, len: 0.7, tag: 'metal' },
      { id: ['newsbox_a', 'newsbox_b'], w: 0.3, len: 1.1, tag: 'metal', row: true },
      { id: ['newsbox_c', 'newsbox_d'], w: 0.25, len: 1.1, tag: 'metal', row: true },
      { id: ['phone_hood'], w: 0.2, len: 0.9, tag: 'metal' },
      { id: ['phone_booth_frame', 'phone_booth_glass'], w: 0.14, len: 1.1, tag: 'metal' },
      { id: ['cabinet_util'], w: 0.28, len: 1.2, tag: 'metal' },
      { id: ['meter_kiosk'], w: 0.14, len: 0.6, tag: 'metal' },
      { id: ['planter_concrete', 'planter_soil', 'shrub_a'], w: 0.45, len: 1.4, tag: 'concrete', planter: true },
      { id: ['planter_timber', 'planter_soil', 'shrub_c'], w: 0.3, len: 1.6, tag: 'wood', planter: true },
      { id: ['bike_chained'], w: 0.4, len: 1.3, tag: 'metal', bike: true },
      { id: ['cone'], w: 0.35, len: 0.4, tag: 'plastic', cone: true },
      { id: ['sign_reg', 'sign_reg_face'], w: 0.4, len: 0.4, tag: 'metal', sign: true, plates: 'reg' },
      { id: ['sign_reg', 'sign_reg_face2'], w: 0.28, len: 0.4, tag: 'metal', sign: true, plates: 'reg2' },
      { id: ['sign_warn', 'sign_warn_face'], w: 0.22, len: 0.4, tag: 'metal', sign: true },
      { id: ['sign_reg', 'sign_oneway_face'], w: 0.2, len: 0.4, tag: 'metal', sign: true, plates: 'oneway' },
      { id: ['standpipe'], w: 0.12, len: 0.5, tag: 'metal' },
      { id: ['rail_guard'], w: 0.35, len: 2.0, tag: 'metal', rail: true },
    ];
    let total = 0;
    for (const f of FAMS) total += f.w;

    const density = 0.85 + style.litter * 0.45 + (style.kind === 'core' ? 0.30 : 0);
    let s = s0 + 1.5 + hash3i(seed, 50, 1) * 4;
    let i = 0;
    while (s < s1 - 2 && i < 140) {
      i++;
      const h = hash3i(seed, i, 51);
      const gap = 1.6 + h * 6.4 / Math.max(0.2, density);
      s += gap;
      if (s > s1 - 2) break;
      /**
       * Family FIRST, then the spot. A bench is 2 m long and a bollard is
       * 0.15 m, and asking the same clearance for both either leaves half a
       * bench in the lane or pushes every bollard to the back of the footway.
       * `len` is already the family's along-street footprint, so it is also the
       * radius to keep clear when the kerb it stands on runs at an angle to the
       * lane it must not foul.
       */
      let r = hash3i(seed, i, 53) * total;
      let fam = FAMS[0];
      for (const f of FAMS) {
        r -= f.w;
        if (r <= 0) {
          fam = f;
          break;
        }
      }
      /**
       * A planter is measured by its SHRUB, not by its tub. `planter_concrete`
       * is 1.4 m across but `shrub_c` on top of it spreads past 1.3 m, and it is
       * the foliage that ends up over the running lane — 810 of them, which is
       * enough to read as a planted central reservation rather than a kerb.
       */
      const clear = fam.planter ? 1.35 : Math.max(KERB_CLEAR, fam.len * 0.5);
      const p = this._clearOff(edge, s, side, KERB_LANE + hash3i(seed, i, 52) * 0.22,
        clear, maxOff, new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      /**
       * NINETY DEGREES OUT. `along` was chosen for the families that "run along
       * the kerb" — but every one of those prototypes is authored X-LONG
       * (`bench_slat` is 1.82 m on X, `rail_guard` 2.0 m on X, its posts at
       * x=±1.0), and a yaw of `_along` maps local +Z to the street, so their
       * length was being laid ACROSS the footway. Half of each one stood in the
       * carriageway: 3551 guardrails and 246 benches, up to 1.44 m into a live
       * lane. `_facing` maps local +X along the street and local +Z at the
       * carriageway, which is what these were modelled for. A bench then gets a
       * further half-turn so the seat looks at the street and the backrest is
       * against the building, instead of the reverse.
       */
      const yawBase = fam.bench ? face + Math.PI : face;
      const yaw = yawBase + (hash3i(seed, i, 54) - 0.5) * (fam.sign ? 0.5 : 0.35);
      const sc = 0.88 + hash3i(seed, i, 55) * 0.26;
      const tiltA = (hash3i(seed, i, 56) - 0.5) * (fam.cone ? 0.3 : 0.09);
      const tiltB = (hash3i(seed, i, 57) - 0.5) * (fam.cone ? 0.3 : 0.08);
      const mask = [
        0.4 + hash3i(seed, i, 58) * 1.0,
        0.35 + hash3i(seed, i, 59) * 1.0,
        0.5 + hash3i(seed, i, 60) * 0.6,
      ];
      const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc,
        sc * (0.94 + hash3i(seed, i, 61) * 0.13), sc, tiltA, tiltB);
      for (const id of fam.id) B.put(id, M, mask);
      if (fam.plates) this._regLegend(B, fam.plates, M, yaw, sc, seed, i);
      if (fam.cone) {
        B.put('cone_band', M, null);
        // cones come in threes
        for (let k = 1; k < 3; k++) {
          const p2 = this._clearOff(edge, s + k * (0.9 + hash3i(seed, i, 62 + k) * 0.7), side,
            KERB_LANE - 0.25 + hash3i(seed, i, 65 + k) * 0.5, KERB_CLEAR, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          const M2 = trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, hash3i(seed, i, 68 + k) * TAU, sc,
            sc, sc, (hash3i(seed, i, 71 + k) - 0.5) * 0.4, (hash3i(seed, i, 74 + k) - 0.5) * 0.4);
          B.put('cone', M2, mask);
          B.put('cone_band', M2, null);
        }
      }
      if (fam.row) {
        for (let k = 1; k < 2 + Math.floor(hash3i(seed, i, 77) * 3); k++) {
          const p2 = this._clearOff(edge, s + k * 0.52, side, KERB_LANE + hash3i(seed, i, 78 + k) * 0.2,
            KERB_CLEAR, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          B.put(fam.id[k % fam.id.length], trs(new THREE.Matrix4(), p2.x, p2.y, p2.z,
            yaw + (hash3i(seed, i, 81 + k) - 0.5) * 0.2, sc), mask);
        }
      }
      if (fam.rail) {
        // Continues the run started above, so it takes the same corrected yaw.
        for (let k = 1; k < 3; k++) {
          const p2 = this._clearOff(edge, s + k * 2.0, side, KERB_LANE + 0.05,
            clear, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          B.put('rail_guard', trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, face, 1, 1, 1), mask);
        }
      }
      if (fam.tag) B.box(fam.tag, p.x, p.y, p.z, 0.6 * sc, 0.9, 0.6 * sc, yaw);
      s += fam.len * sc;
    }

    // Bus shelters: rare, and only on a road wide enough to stop on.
    if (w.sw > 2.6 && edge.kind !== 'alley' && hash3i(seed, 90, 1) < 0.26 && usable > 22) {
      const s2 = s0 + 6 + hash3i(seed, 91, 1) * (usable - 14);
      /**
       * A shelter is 3.9 m wide on X and 1.5 m deep on Z, with its back panel
       * at -Z and its opening at +Z — so `_facing` is the yaw it was modelled
       * for, and the old `_along + (side>0 ? 0 : PI)` was both ninety degrees
       * out and a hand-rolled version of the side term `_facing` already
       * carries. It stood across the footway with its open front looking down
       * the street and 2 m of it in the bus lane.
       */
      const p = this._clearOff(edge, s2, side, Math.min(w.sw - 0.85, 1.5),
        0.85, Math.max(1.5, w.sw - 0.85), new THREE.Vector3());
      if (p && this._in(bx, p.x, p.z)) {
        const yaw = face + (hash3i(seed, 92, 1) - 0.5) * 0.06;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw);
        const mask = [0.7, 0.8, 0.6];
        B.put('shelter_frame', M, mask);
        B.put('shelter_glass', M, null);
        B.put('shelter_ad', M, null);
        B.put('shelter_flag', M, mask);
        B.box('metal', p.x, p.y, p.z, 4.0, 2.4, 1.6, yaw);
      }
    }
  }

  /* ---------------------------------------------------- wall clutter --- */

  _wallClutter(B, edge, side, s0, s1, seed, style, bx, w, district) {
    if (w.sw < 1.8) return;
    const off = w.sw - 0.55;
    const face = this._facing(edge, side);
    const along = this._along(edge);
    const FAMS = [
      { id: ['binbag_0'], w: 1.0, stack: 3 },
      { id: ['binbag_1'], w: 0.9, stack: 3 },
      { id: ['binbag_2'], w: 0.8, stack: 2 },
      { id: ['bin_wheelie'], w: 0.7 },
      { id: ['pallet'], w: 0.5 },
      { id: ['crate_wood'], w: 0.4 },
      { id: ['crate_milk'], w: 0.45, stack: 2 },
      { id: ['box_card'], w: 0.5, stack: 2 },
      { id: ['a_board'], w: 0.5 },
      { id: ['aircon_ground'], w: 0.35 },
      { id: ['hatch_twin'], w: 0.35, flat: true },
      { id: ['hatch_round'], w: 0.3, flat: true },
      { id: ['gully_walk'], w: 0.4, flat: true },
      { id: ['utility_lid'], w: 0.45, flat: true },
      { id: ['vent_grate'], w: 0.25, flat: true },
      { id: ['drum_oil'], w: 0.2 },
      { id: ['tyre_stack'], w: 0.14 },
      { id: ['weed_tuft'], w: 0.6, weed: true },
    ];
    let total = 0;
    for (const f of FAMS) total += f.w;
    const density = 0.75 + style.litter * 0.85;
    let s = s0 + 1 + hash3i(seed, 100, 1) * 5;
    let i = 0;
    while (s < s1 - 1 && i < 130) {
      i++;
      s += 1.4 + hash3i(seed, i, 101) * 6.5 / Math.max(0.2, density);
      if (s > s1 - 1) break;
      /**
       * Wall clutter sits at the BACK of the footway, so it is never in the
       * road because of its own offset — but at an acute fork, or where two
       * corridors overlap, the back of one footway is the middle of the next
       * street. Same guard, pushing further from the kerb rather than nearer.
       */
      const p = this._clearOff(edge, s, side, off - hash3i(seed, i, 102) * 0.35,
        KERB_CLEAR, Math.max(off, w.sw - 0.2), new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      let r = hash3i(seed, i, 103) * total;
      let fam = FAMS[0];
      for (const f of FAMS) {
        r -= f.w;
        if (r <= 0) {
          fam = f;
          break;
        }
      }
      const yaw = (fam.flat ? along : face + Math.PI) + (hash3i(seed, i, 104) - 0.5) * (fam.flat ? 0.2 : 1.1);
      const sc = 0.85 + hash3i(seed, i, 105) * 0.34;
      const mask = [0.4 + hash3i(seed, i, 106), 0.5 + hash3i(seed, i, 107), 0.6];
      const y = fam.flat ? p.y + 0.012 : p.y;
      B.put(fam.id[0], trs(new THREE.Matrix4(), p.x, y, p.z, yaw, sc,
        sc * (0.9 + hash3i(seed, i, 108) * 0.2), sc,
        fam.flat ? 0 : (hash3i(seed, i, 109) - 0.5) * 0.12,
        fam.flat ? 0 : (hash3i(seed, i, 110) - 0.5) * 0.12), mask);
      const n = fam.stack ? 1 + Math.floor(hash3i(seed, i, 111) * fam.stack) : 0;
      for (let k = 0; k < n; k++) {
        const dx = (hash3i(seed, i, 112 + k) - 0.5) * 0.9;
        const dz = (hash3i(seed, i, 115 + k) - 0.5) * 0.5;
        const p2x = p.x + Math.cos(along) * dx - Math.sin(along) * dz;
        const p2z = p.z + Math.sin(along) * dx + Math.cos(along) * dz;
        if (!this._in(bx, p2x, p2z)) continue;
        const sc2 = sc * (0.8 + hash3i(seed, i, 118 + k) * 0.4);
        // The stack jitters up to 0.45 m off its parent in an unconstrained
        // direction, which is enough to walk a bin bag off a narrow footway.
        // Checked at the height it is actually placed at, because the height
        // gate in `laneIntrusion` is what decides whether a road below counts.
        const p2y = p.y + (hash3i(seed, i, 121 + k) < 0.35 ? 0.34 * sc2 : 0);
        if (!this._clearsLanes(p2x, p2y, p2z, 0.3)) continue;
        B.put(fam.id[0], trs(new THREE.Matrix4(), p2x, p2y, p2z,
          hash3i(seed, i, 124 + k) * TAU, sc2, sc2 * 0.92, sc2,
          (hash3i(seed, i, 127 + k) - 0.5) * 0.4, (hash3i(seed, i, 130 + k) - 0.5) * 0.4), mask);
      }
    }
  }

  /* ================================================================== */
  /* overhead                                                            */
  /* ================================================================== */

  _edgeWires(B, edge, bx, lod) {
    const poles = polesOnEdge(this.world.roads, edge, this.world, (x, z) => this.styleOf(x, z), this._poles);
    if (poles.length === 0) return;
    const wireAcc = this._wireAcc(B);

    for (let i = 0; i < poles.length; i++) {
      const p = poles[i];
      if (this._in(bx, p.x, p.z)) {
        const yaw = this._along(edge) + (hash3i(p.seed, 40, 1) - 0.5) * 0.10 + Math.PI / 2;
        const sc = 0.96 + hash3i(p.seed, 41, 1) * 0.1;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc);
        const mask = [0.5 + hash3i(p.seed, 42, 1) * 0.8, 0.5 + hash3i(p.seed, 43, 1) * 0.8, 0.6];
        B.put(`pole_${p.variant}_${p.arms}`, M, mask);
        if (lod === 0) {
          B.put(`pole_${p.variant}_ins${p.arms}`, M, null);
          if (p.xfmr) B.put(`pole_${p.variant}_xfmr`, M, mask);
        }
        if (lod === 0) B.box('wood', p.x, p.y, p.z, 0.30, 4.0, 0.30);
        // guy wires where the line turns or ends
        if (lod === 0 && (i === 0 || i === poles.length - 1) && hash3i(p.seed, 44, 1) < 0.6) {
          const d = i === 0 ? -1 : 1;
          buildGuy(wireAcc, p, edge.dx * d, edge.dz * d, p.seed);
        }
      }
      // --- SPANS. Only ever between consecutive authored poles.
      if (i + 1 < poles.length) {
        const q = poles[i + 1];
        const mx = (p.x + q.x) * 0.5;
        const mz = (p.z + q.z) * 0.5;
        if (this._in(bx, mx, mz)) {
          buildSpan(wireAcc, p, q, (p.seed ^ Math.imul(q.seed, 31)) >>> 0);
        }
      }
    }

    if (lod !== 0) return;

    // Service drops: pole to an AUTHORED wall bracket. No bracket, no drop.
    for (const p of poles) {
      if (!this._in(bx, p.x, p.z)) continue;
      if (hash3i(p.seed, 50, 1) > 0.55) continue;
      const w = this._walk(edge);
      const lat = (w.hw + 0.33 + w.sw + 1.2) * p.side;
      const t = p.s / edge.len;
      const g = this.world.roads;
      const na = g.nodes[edge.a];
      const nb = g.nodes[edge.b];
      const wx = na.x + (nb.x - na.x) * t - edge.dz * lat + (hash3i(p.seed, 51, 1) - 0.5) * 5;
      const wz = na.z + (nb.z - na.z) * t + edge.dx * lat + (hash3i(p.seed, 52, 1) - 0.5) * 5;
      if (this.world.isWater?.(wx, wz)) continue;
      // A service drop needs a WALL. Across the footway of an airfield's
      // perimeter road there is only the fence and the open field.
      if (this._onAirfield(wx, wz)) continue;
      const wy = p.y + 4.4 + hash3i(p.seed, 53, 1) * 2.6;
      const yaw = this._facing(edge, p.side) + Math.PI;
      B.put('wire_bracket', trs(new THREE.Matrix4(), wx, wy, wz, yaw), [0.7, 0.8, 0.5]);
      B.put('wire_junction', trs(new THREE.Matrix4(), wx, wy - 1.5, wz, yaw), [0.7, 0.8, 0.5]);
      buildDrop(this._wireAcc(B), p, wx, wy + 0.28, wz, p.seed);
    }
  }

  _wireAcc(B) {
    let a = B._static.get('wire');
    if (!a) B._static.set('wire', (a = new Accum('wire')));
    return a;
  }

  /* ================================================================== */
  /* road decals — only what `world` does not already paint              */
  /* ================================================================== */

  setDecalGlyphs(set) {
    this.decalGlyphs = set;
  }

  _edgeDecals(B, edge, bx) {
    if (edge.kind === 'alley' || edge.rail) return;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const w = this._walk(edge);
    const L = edge.len;
    const seed = (edge.id * 0x9e3779b1) >>> 0;
    const allow = this.decalGlyphs ?? {};

    const put = (surf, cx, cz, y, yaw, halfW, halfL, vSpan) => {
      let a = B._static.get(surf);
      if (!a) B._static.set(surf, (a = new Accum(surf)));
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const q = [];
      for (const [u, v, tu, tv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, vSpan], [-1, 1, 0, vSpan]]) {
        const dx = u * halfW;
        const dz = v * halfL;
        q.push(a.vert(cx + dx * c - dz * s, y, cz + dx * s + dz * c, 0, 1, 0, tu, tv, 0.15, 0.5, 0.05));
      }
      a.quad(q[0], q[1], q[2], q[3]);
    };

    const at = (t, lat) => {
      const x = na.x + (nb.x - na.x) * t - edge.dz * lat;
      const z = na.z + (nb.z - na.z) * t + edge.dx * lat;
      const y = na.y + (nb.y - na.y) * t + 0.016;
      return { x, y, z };
    };
    const along = this._along(edge);

    // ---- lane arrows on the approach to a busy junction ------------------
    if (allow.arrow) {
      for (const end of [0, 1]) {
        const node = g.nodes[end === 0 ? edge.a : edge.b];
        if (node.links.length < 3) continue;
        if (hash3i(seed, end, 61) > 0.55) continue;
        const fw = edge.forward;
        for (let k = 0; k < fw; k++) {
          const lat = (k + 0.5) * edge.laneWidth * (end === 0 ? -1 : 1);
          const t = end === 0 ? (w.padA + 7) / L : 1 - (w.padB + 7) / L;
          if (t < 0.05 || t > 0.95) continue;
          const p = at(t, lat);
          if (!this._in(bx, p.x, p.z)) continue;
          const turn = k === 0 && hash3i(seed, k, 62) < 0.5;
          put(turn && allow.arrowTurn ? 'decal_arrow_turn' : 'decal_arrow',
            p.x, p.z, p.y, along + (end === 0 ? Math.PI : 0), 1.5, 2.4, 1);
        }
      }
    }

    // ---- kerbside parking-bay ticks and a double yellow -------------------
    for (const side of [-1, 1]) {
      const mid = at(0.5, 0);
      const style = this.styleOf(mid.x, mid.z);
      if (hash3i(seed, side > 0 ? 3 : 4, 63) < 0.34 && allow.yellow) {
        // a continuous no-parking line hugging the channel
        const segs = Math.max(1, Math.round((L - w.padA - w.padB) / 8));
        for (let i = 0; i < segs; i++) {
          const t0 = (w.padA + i * 8) / L;
          const p = at(t0 + 4 / L, (w.hw - 0.28) * side);
          if (!this._in(bx, p.x, p.z)) continue;
          put('decal_yellow', p.x, p.z, p.y, along, 0.28, 4.0, 8 / 9);
        }
      } else if (style.meters > 0.2) {
        const pitch = 6.4 + hash3i(seed, 5, 64) * 1.8;
        for (let s = w.padA + 4; s < L - w.padB - 4; s += pitch) {
          const p = at(s / L, (w.hw - 1.15) * side);
          if (!this._in(bx, p.x, p.z)) continue;
          put('decal_paint', p.x, p.z, p.y, along + Math.PI / 2, 0.25, 1.15, 0.26);
        }
      }
    }

    // ---- hatched keep-clear box outside a junction -----------------------
    if (allow.hatch && hash3i(seed, 6, 65) < 0.14) {
      const t = 0.5 + (hash3i(seed, 7, 66) - 0.5) * 0.4;
      const p = at(t, 0);
      if (this._in(bx, p.x, p.z)) put('decal_hatch', p.x, p.z, p.y, along, w.hw * 0.9, 3.4, 1);
    }

    // ---- oil, skid scuff, tar seams, standing water ----------------------
    const n = Math.max(1, Math.round(L / 26));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.2 + hash3i(seed, i, 67) * 0.6) / n;
      const lat = (hash3i(seed, i, 68) - 0.5) * 1.7 * w.hw;
      const p = at(t, lat);
      if (!this._in(bx, p.x, p.z)) continue;
      const r = hash3i(seed, i, 69);
      if (r < 0.34) {
        const sx = 0.5 + hash3i(seed, i, 70) * 1.3;
        const sz = 0.4 + hash3i(seed, i, 71) * 2.4;
        put('oil', p.x, p.z, p.y, along + (hash3i(seed, i, 72) - 0.5) * 0.6, sx, sz, 1);
      } else if (r < 0.58) {
        put('tarpatch', p.x, p.z, p.y - 0.004, along + (hash3i(seed, i, 73) - 0.5) * 1.4,
          0.16 + hash3i(seed, i, 74) * 0.18, w.hw * (0.5 + hash3i(seed, i, 75) * 0.55), 1);
      } else if (r < 0.72) {
        // standing water gathers in the channel, not in the crown
        const p2 = at(t, (w.hw - 0.55) * (hash3i(seed, i, 76) < 0.5 ? -1 : 1));
        if (!this._in(bx, p2.x, p2.z)) continue;
        const sc = 0.7 + hash3i(seed, i, 77) * 1.3;
        B.put(`puddle_${i % 3}`, trs(new THREE.Matrix4(), p2.x, p2.y - 0.006, p2.z,
          along + (hash3i(seed, i, 78) - 0.5) * 0.5, sc, 1, sc * 0.7), null);
      } else if (r < 0.86) {
        // utility spray marks — the coloured squiggles nobody ever cleans off
        const tag = ['tag_a', 'tag_b', 'tag_c'][i % 3];
        let a = B._static.get(tag);
        if (!a) B._static.set(tag, (a = new Accum(tag)));
        const id = `tag_${i % 4}_${tag}`;
        const proto = this.lib.protos.get(id);
        if (proto) {
          a.add(proto.geo, trs(new THREE.Matrix4(), p.x, p.y + 0.004, p.z,
            along + (hash3i(seed, i, 79) - 0.5) * 1.2, 0.55, 0.55, 0.55, -Math.PI / 2),
            [0.3, 0.6, 0.1]);
        }
      }
    }
  }

  /* ================================================================== */
  /* per-lot dressing                                                    */
  /* ================================================================== */

  /**
   * The ground the BUILDING sits on, not the ground under the lot centre.
   * `buildings` pads to the LOWEST footprint corner minus 12 cm precisely
   * because Steel City is built on hills, and a prop keyed off the centroid
   * floats a whole storey clear of the wall on the downhill side.
   */
  _lotGround(lot) {
    let gy = Infinity;
    for (const c of lot.footprint) gy = Math.min(gy, this.world.heightAt(c[0], c[1]));
    if (!Number.isFinite(gy)) gy = lot.y ?? this.world.heightAt(lot.cx, lot.cz);
    return gy - 0.12;
  }

  /**
   * WHERE IS THE WALL, ACTUALLY?
   *
   * Everything below is placed off the LOT FOOTPRINT, and the footprint is not
   * the building. `buildings` insets, steps and plinths its ground volume, so a
   * sign keyed off the polygon hangs in space wherever it inset and sinks into
   * brick wherever it did not — the "two floating illegible billboards in
   * mid-air" a critic found in `mill.png` were a poster cluster and a tag on a
   * lot whose building is nowhere near its footprint edge.
   *
   * So: fire a ray at the wall, at the prop's own height, and use what it finds.
   * Returns metres to push along the outward normal, or null for "there is no
   * wall here" — in which case the prop is not drawn at all. A wall prop with
   * nothing behind it is the defect; not drawing it is the fix.
   */
  _phys() {
    if (this._physSys === undefined) this._physSys = this.peek?.('physics') ?? null;
    return this._physSys;
  }

  _wallPush(x, y, z, nx, nz) {
    const phys = this._phys();
    if (!phys?.raycast) return 0; // no physics at all: nominal placement
    const OUT = 1.9;
    const h = phys.raycast(
      x + nx * OUT, y, z + nz * OUT, -nx, 0, -nz, OUT + 2.6,
      phys.MASK?.WORLD
    );
    /**
     * A MISS IS ONLY EVIDENCE IF THE BUILDING IS IN THE COLLISION WORLD.
     * `buildings` registers colliders for its LIVE ring only, and our near
     * radius is wider than theirs — so out at the edge a miss means "nobody
     * told physics about this building", not "there is no wall". Dropping the
     * prop then would quietly strip the shopfronts off the outer ring of every
     * tile. `_wallKnown` is set per lot by a single roof probe.
     */
    if (!h?.hit) return this._wallKnown ? null : 0;
    const push = OUT - h.distance;
    if (push < -2.6 || push > 1.9) return this._wallKnown ? null : 0;
    return push;
  }

  /**
   * Is this lot's building actually in the static BVH? One ray, straight down
   * the middle from above the roof. If it comes back with something well above
   * the ground then `buildings` has registered this lot and a wall query here
   * is trustworthy; if not, we are placing blind and must not throw props away.
   */
  _probeLotKnown(lot, baseY) {
    const phys = this._phys();
    if (!phys?.raycast) return false;
    const hgt = lot.height ?? 10;
    const h = phys.raycast(lot.cx, baseY + hgt + 8, lot.cz, 0, -1, 0, hgt + 16, phys.MASK?.WORLD);
    return !!h?.hit && h.point.y > baseY + 1.2;
  }

  /**
   * EVERY WALL-MOUNTED CARD MUST HAVE A WALL BEHIND ITS OWN CORNERS.
   *
   * `_wallPush` probes ONE point at the middle of a wall and, on a miss, falls
   * back to nominal placement so the outer ring of tiles does not lose its
   * shopfronts. That is right for a poster at eye level and catastrophic for a
   * ghost sign, which is up to 18 m wide, is hung from `lot.height` — the LOT
   * RECORD, not the building `buildings` actually built — and therefore ends up
   * hanging in clear sky when the two disagree. One was found 14.6 m from the
   * lens at y 19.6 with nothing under it.
   *
   * This gate is deliberately NOT another version of the placement arithmetic.
   * It reads the PROTOTYPE'S OWN BOUNDING BOX, pushes its four front-face
   * corners through the final instance matrix, and asks `physics` — a different
   * subsystem, holding geometry this file never produced — whether there is
   * something behind each of them. An invariant that re-derives its expectation
   * from the same inputs as the code it is checking cannot fail; this one fails
   * the moment a card's own emitted corners are over open air.
   *
   * @param {number} need how many of the four corners must be backed
   */
  _wallBacked(id, M, nx, nz, need = 4) {
    const phys = this._phys();
    if (!phys?.raycast) return true;
    const p = this.lib.get?.(id);
    if (!p?.geo) return true;
    let bb = p._bb;
    if (bb === undefined) {
      p.geo.computeBoundingBox();
      bb = p._bb = p.geo.boundingBox ?? null;
    }
    if (!bb) return true;
    // 8 % inset, so a card that legitimately runs to the arris of its wall is
    // not failed by a corner sitting exactly on the edge
    const ix = (bb.max.x - bb.min.x) * 0.08;
    const iy = (bb.max.y - bb.min.y) * 0.08;
    const zf = bb.max.z;
    const OUT = 1.9;
    let hits = 0;
    for (let k = 0; k < 4; k++) {
      _wv.set(
        (k & 1) ? bb.max.x - ix : bb.min.x + ix,
        (k & 2) ? bb.max.y - iy : bb.min.y + iy,
        zf
      ).applyMatrix4(M);
      const h = phys.raycast(
        _wv.x + nx * OUT, _wv.y, _wv.z + nz * OUT, -nx, 0, -nz, OUT + 2.6,
        phys.MASK?.WORLD
      );
      if (h?.hit && OUT - h.distance > -2.6) hits++;
    }
    return hits >= need;
  }

  /* ================================================================== */
  /* SIGNAGE — what the city actually SAYS                              */
  /* ================================================================== */

  /**
   * ───────────────────────────────────────────────────────────────────────
   * THE AUTHORED NAMES, AND WHY THEY BEAT THE VOCABULARY.
   * ───────────────────────────────────────────────────────────────────────
   * Most shopfronts get a name out of `SIGN_WORDS` chosen by their own mount
   * seed, and that is fine — they are set dressing. But six of them are not:
   * DeCarlo Body Shop is a SAFEHOUSE, Rustbelt Respray is the one hard heat
   * reset in the game, Foundry Supply and Row Hardware sell ammunition,
   * Primo's Sandwich and the Incline Diner sell health, and every gas station
   * is a fuel stop. A player told to "get to the respray" and standing in
   * front of a building signed LADLE & SPOON has been lied to by the art.
   *
   * So the frontage pass asks this first, and an authored hit OVERRIDES both
   * the name and the "does this unit trade at all" roll. The coordinates come
   * from `world` at runtime (`world.pois`, `world.safehouses`) — never from
   * `game/data.js`, which is another subsystem's module (rule 2) — and
   * `world.pois` is the RESOLVED table, i.e. where the forecourt actually
   * ended up after `resolvePoi` walked it off a river or a carriageway, not
   * where the plan wished it were.
   */
  _namedSites() {
    if (this._sites) return this._sites;
    const out = [];
    const add = (p, r, kind) => {
      if (!p || !p.name) return;
      const x = +p.x;
      const z = +p.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      out.push({ x, z, r, kind, name: String(p.name).toUpperCase() });
    };
    // A shop frontage is signed if the unit's own centre is within `r` of the
    // POI. 34 m is the forecourt radius (`POI_PAD.r` is 17) plus the depth of
    // the lot behind it — wide enough that the building fronting the pad is
    // caught, tight enough that its neighbour across the junction is not.
    for (const p of this.world.pois ?? []) add(p, 34, p.kind ?? 'service');
    for (const s of this.world.safehouses ?? []) add(s, 30, 'safehouse');
    this._sites = out;
    return out;
  }

  /** The authored name for a frontage at (x, z), or null. Nearest wins. */
  _authoredName(x, z) {
    const sites = this._namedSites();
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const d = Math.hypot(s.x - x, s.z - z);
      if (d > s.r || d >= bestD) continue;
      bestD = d;
      best = s;
    }
    return best;
  }

  /**
   * Draw one piece of type, fitted to a field, at UNIFORM scale.
   *
   * `fw`/`fh` is the board's usable field in metres and the word is scaled to
   * fill it — never stretched to it. Returns false when the word would land
   * under `fitScale`'s legibility floor, and the caller then draws nothing:
   * the "blank rectangles standing in for signage" finding is a sign that was
   * drawn too small to read, not a sign that was missing.
   */
  _type(B, lines, surface, x, y, z, yaw, fw, fh, mask = null, opts = null) {
    if (noSigns()) return false;
    const id = signTextProto(B.lib, lines, surface, opts ?? undefined);
    const s = fitScale(B.lib, id, fw, fh, opts?.margin ?? 0.86);
    if (!s) return false;
    B.put(id, trs(new THREE.Matrix4(), x, y, z, yaw, s, s, s), mask);
    return true;
  }

  /**
   * ───────────────────────────────────────────────────────────────────────
   * STREET NAME BLADES — the wayfinding layer nobody could read.
   * ───────────────────────────────────────────────────────────────────────
   * `sign_street_blades` is two crossed green plates on a cast bracket and it
   * has been in the city since the street kit landed, blank. The names exist:
   * `world.streetAt(x, z)` speaks the full Pittsburgh vocabulary — the grid
   * names out of `plan.DISTRICT_STREETS` and the connectors `netgen` names by
   * hand — and the minimap has been using them all along.
   *
   * WHICH TWO NAMES. A junction node carries its links; sampling `streetAt` at
   * the MIDPOINT of each linked edge asks the public API what that road is
   * called rather than reaching into `edge.name` / `corridorStreetName`, which
   * are `world`'s internals. Two DISTINCT names are then taken in link order,
   * which is what a corner plate says: the street you are on and the one you
   * are crossing. A node whose links all resolve to one name (a bend, or a
   * corridor that continues) gets one plate, not two of the same.
   *
   * Both faces of both plates, four instances of type, because a blade with a
   * name on one side only is a sign that is blank from half the junction.
   */
  _streetPlates(B, node, p, yaw, sc, mask) {
    const g = this.world.roads;
    if (!g || !this.world.streetAt) return;
    const names = [];
    for (let i = 0; i < node.links.length && names.length < 2; i++) {
      const e = g.edges[node.links[i]];
      if (!e || e.rail) continue;
      const na = g.nodes[e.a];
      const nb = g.nodes[e.b];
      if (!na || !nb) continue;
      const t = this.world.streetAt((na.x + nb.x) / 2, (na.z + nb.z) / 2);
      const plate = streetPlateText(t);
      if (plate && !names.includes(plate)) names.push(plate);
    }
    if (!names.length) return;
    // The two plates of `sign_street_blades`: 1.05 x 0.20 at y 2.92 facing +Z,
    // and the same rotated a quarter turn at y 2.68. Both are at unit scale in
    // the prototype, so everything here rides the placement's own `sc`.
    const decks = [{ y: 2.92, ry: 0 }, { y: 2.68, ry: Math.PI / 2 }];
    for (let k = 0; k < names.length && k < 2; k++) {
      const d = decks[k];
      for (const s of [-1, 1]) {
        const a = yaw + d.ry + (s < 0 ? Math.PI : 0);
        // 18 mm off the plate's own centre plane: the plate is a 12 mm box
        // bowed 4 mm, so this is ~8 mm of relief — a painted legend, not a
        // set of letters floating in front of the sign.
        this._type(B, names[k], 'sign_pale',
          p.x + Math.sin(a) * 0.018 * sc, p.y + d.y * sc, p.z + Math.cos(a) * 0.018 * sc,
          a, 0.92 * sc, 0.125 * sc, mask);
      }
    }
  }

  /**
   * ───────────────────────────────────────────────────────────────────────
   * THE REGULATORY PLATES, WHICH WERE BLANK.
   * ───────────────────────────────────────────────────────────────────────
   * `sign_reg_face`, `sign_reg_face2` and `sign_oneway_face` are white plates
   * on a 2.6 m post and this file plants a lot of them — they are four of the
   * twenty-eight families in the kerb walk. Every one of them shipped with
   * NOTHING ON IT, and a white rectangle on a pole a few metres from the lens
   * is the single most conspicuous version of the "blank rectangles standing
   * in for signage" defect there is: FOUND BY MEASUREMENT, not by reading the
   * kit — a raycast through the `detail` frame at (365, 180) and (365, 290)
   * lands on `p-2_0:sign_white` / `sign_reg` at 13.0 m, two grey panels
   * stacked on one post filling 160 px of a 1080p frame with no legend.
   *
   * They predate the signage system rather than being excluded from it: the
   * shopfront fascias, blades, ghost signs, street blades and hoardings were
   * all typed when `kit_sign.js` landed, and the street kit's own plates —
   * which are older — were never revisited.
   *
   * ONE LEGEND PER PLATE, PICKED BY THE POST'S OWN HASH, so a street does not
   * repeat and a re-run does not change. Below `fitScale`'s legibility floor
   * `_type` draws nothing at all and the plate stays blank, which is the right
   * failure: an unreadable smear of type is worse than a plain plate.
   */
  _regLegend(B, kind, M, yaw, sc, seed, i) {
    const spec = REG_PLATES[kind];
    if (!spec) return;
    for (let k = 0; k < spec.length; k++) {
      const d = spec[k];
      const list = d.words;
      const lines = list[Math.floor(hash3i(seed, i, 84 + k) * list.length) % list.length];
      /**
       * THE ANCHOR RIDES THE SIGN'S OWN MATRIX, and it has to.
       *
       * The obvious version of this — `p.x + Math.sin(yaw) * z`, the way
       * `_streetPlates` offsets a blade — was written first and MEASURED
       * WRONG: the legend landed 13 mm INSIDE the plate and rendered nothing
       * at all, because a post also carries a lean (`tiltA`/`tiltB`) and a
       * non-uniform height scale, and reconstructing its plane by hand from
       * the yaw alone drops both. Pushing the same offset out to 0.30 m for a
       * diagnostic capture put the words 26 cm to the SIDE of the sign, in
       * mid-air over the building behind it, which is what that error looks
       * like when it is big enough to see.
       *
       * So the plate's own placement matrix transforms the plate's own local
       * anchor: `(0, y, 0.045)` in the frame `registerSigns` authored the face
       * in. 45 mm is 11 mm proud of that face — `signFace` is a 12 mm box
       * bowed 6 mm whose centre sits 22 mm off the post — which is a painted
       * legend rather than letters floating in front of a sign, and it stays
       * 11 mm whatever the post's scale and lean happen to be.
       */
      _v.set(0, d.y, 0.045).applyMatrix4(M);
      this._type(B, lines, 'sign_ink', _v.x, _v.y, _v.z,
        yaw, d.w * sc, d.h * sc, [0.5, 0.55, 0.3]);
    }
  }

  /**
   * A neon word: emissive tube core, dead tubes in cold glass, additive halo.
   *
   * The three go on TOGETHER or not at all — a halo with no word in it is a
   * glowing smear, which is what an early pass at this looked like when the
   * word failed its own fit test and the halo did not.
   */
  _neonWord(B, text, key, x, y, z, yaw, nx, nz, fw, mask = null) {
    if (noSigns()) return false;
    const n = neonWordProto(B.lib, text, key);
    if (!n.id || !n.w) return false;
    // Tube geometry is authored at cap height 1, so the scale that fits the
    // field is the field over the word's own em width. Clamped: a two-letter
    // word on a five-metre fascia is not a 2.5 m tall letter.
    const s = Math.min(0.42, (fw * 0.8) / n.w);
    if (s < 0.09) return false;
    const M = trs(new THREE.Matrix4(), x, y, z, yaw, s, s, s);
    B.put(n.id, M, mask);
    if (n.dead) B.put(n.dead, M, [0.8, 0.9, 0.4]);
    // The halo sits 3 cm BEHIND the tubes, which is where the glass actually
    // is. Coplanar with them it brightens the core instead of surrounding it,
    // and coplanar with the WALL it z-fights — the caller has already stood
    // the word off the brick, so this only has to stay inside that gap.
    if (n.halo) {
      B.put(n.halo, trs(new THREE.Matrix4(), x - nx * 0.03, y, z - nz * 0.03,
        yaw, s * 1.15, s * 1.1, 1), null);
    }
    return true;
  }

  _lot(B, lot, bx, lod, rng, parked = null, wallOut = null) {
    const foot = lot.footprint;
    if (!foot || foot.length < 3) return;
    const seed = lot.seed >>> 0;
    const style = this.styleOf(lot.cx, lot.cz);
    const district = lot.district ?? this.districtIdAt(lot.cx, lot.cz);

    /**
     * A lot belongs to exactly one tile — `world.lotsInTile` assigns it by its
     * centroid — so lot-derived props are already unique and must NOT be gated
     * on the tile bounds. Doing that threw away the dressing of every lot whose
     * frontage crossed a tile edge, which is most of them, and is why the first
     * pass had no shopfronts at all.
     */
    if (lot.kind === 'park') {
      this._park(B, lot, bx, lod, seed, style);
      return;
    }
    if (lot.kind === 'lot') {
      this._surfaceLot(B, lot, bx, lod, seed, style);
      if (parked && lod === 0) this._lotParking(lot, seed, parked, bx);
      return;
    }
    // Shopfront dressing is a dozen materials per tile and none of it resolves
    // beyond the near radius. The skeleton tier plants and lights only.
    if (lod !== 0) return;

    /**
     * Everything from here down needs a wall query, and `physics` cannot answer
     * one for a building whose colliders are still in this frame's build queue.
     * So the caller takes the lot now and hands it back once the static BVH has
     * been rebuilt — see `PropSystem._drainWalls`.
     */
    if (wallOut) {
      wallOut.push(lot);
      return;
    }
    this._lotDressing(B, lot, bx, seed, style, district);
  }

  /** Deferred entry point: everything on a lot that needed the wall to exist. */
  lotWalls(B, lot, bx) {
    const foot = lot.footprint;
    if (!foot || foot.length < 3) return;
    this._wallKnown = this._probeLotKnown(lot, this._lotGround(lot));
    this._lotDressing(B, lot, bx, lot.seed >>> 0,
      this.styleOf(lot.cx, lot.cz),
      lot.district ?? this.districtIdAt(lot.cx, lot.cz));
  }

  /** The wall-mounted half of a lot. Runs only when a wall query is possible. */
  _lotDressing(B, lot, bx, seed, style, district) {
    const foot = lot.footprint;
    const lod = 0;

    // ---- the frontage: shopfront signage --------------------------------
    const fr = lot.frontage;
    if (fr && fr.length === 2) {
      this._frontage(B, lot, fr, bx, lod, seed, style, district);
    }

    if (lod !== 0) return;

    // ---- the roof: a hoarding on the tall flat-topped lots ---------------
    this._rooftopBoard(B, lot, seed, style);

    // ---- the other walls: ghost signs, ivy, tags, posters, scaffolding ---
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i];
      const b = foot[(i + 1) % foot.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 4) continue;
      const isFront = fr && Math.hypot((a[0] + b[0]) / 2 - (fr[0][0] + fr[1][0]) / 2,
        (a[1] + b[1]) / 2 - (fr[0][1] + fr[1][1]) / 2) < 2.5;
      const ux = dx / len;
      const uz = dz / len;
      let nx = uz;
      let nz = -ux;
      const emx = (a[0] + b[0]) * 0.5;
      const emz = (a[1] + b[1]) * 0.5;
      if (nx * (emx - lot.cx) + nz * (emz - lot.cz) < 0) {
        nx = -nx;
        nz = -nz;
      }
      const wSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
      const yaw = Math.atan2(nx, nz);
      const cx = (a[0] + b[0]) / 2 + nx * 0.06;
      const cz = (a[1] + b[1]) / 2 + nz * 0.06;
      const baseY = this._lotGround(lot);

      /**
       * Probe the wall at the height each family actually hangs at. A gable sign
       * three storeys up and a poster at eye level are on different planes the
       * moment `buildings` steps the volume, so one probe per lot is not enough.
       */
      const at = (t, off) => ({
        x: a[0] + dx * t + nx * off,
        z: a[1] + dz * t + nz * off,
      });

      /**
       * A gable big enough to have carried a painted advert.
       *
       * THIS IS THE ONE THAT FLOATED. The sign is hung off `lot.height`, which
       * is what `world` asked for and not necessarily what `buildings` built,
       * and it is the only card in the kit mounted three storeys up — so when
       * the two disagree it hangs in open sky, which is what a critic found at
       * y 19.6 in the searchlight frame. Two defences, both against the emitted
       * card rather than the arithmetic that produced it: the whole family is
       * skipped unless the roof probe proved this building is really in the
       * collision world, and the card is then only kept if all four of its own
       * corners have a wall behind them. It also walks DOWN the wall first, so
       * a sign whose top overhangs the roof is lowered rather than dropped.
       */
      /**
       * A GHOST SIGN IS A DISTRICT'S AGE, NOT ITS SIGNAGE BUDGET. It advertises
       * a company that closed fifty years ago, so it belongs on the brick of
       * the mill districts and the rowhouse streets and NOT on a glass tower or
       * in a park — the flat 0.30 put as many on the Golden Triangle as on
       * Steel Row. The weights below are the age of the fabric, which is why
       * they do not come from `style.signage`.
       */
      const ghostAge = { mill: 1.5, row: 1.25, market: 1.15, hill: 0.8, civic: 0.6,
        core: 0.35, park: 0.1 }[style.kind] ?? 1.0;
      if (!isFront && len > 9 && (lot.height ?? 0) > 9
          && hash3i(wSeed, 1, 1) < 0.30 * ghostAge
          && this._wallKnown) {
        const gw = Math.min(len - 2.4, 10 + hash3i(wSeed, 2, 1) * 8);
        const gh = Math.min((lot.height ?? 10) - 4.5, 5 + hash3i(wSeed, 3, 1) * 6);
        const gy0 = baseY + 3.4 + hash3i(wSeed, 4, 1) * ((lot.height ?? 10) - gh - 4.5);
        for (let step = 0; step < 6; step++) {
          const gy = gy0 - step * gh * 0.35;
          if (gy < baseY + 2.6) break;
          const push = this._wallPush(cx, gy + gh / 2, cz, nx, nz);
          if (push === null) continue;
          const M = trs(new THREE.Matrix4(), cx + nx * push, gy + gh / 2, cz + nz * push,
            yaw, gw, gh, 1);
          if (!this._wallBacked('ghost_field', M, nx, nz, 4)) continue;
          B.put('ghost_field', M, [0.6 + hash3i(wSeed, 5, 1) * 0.6, 0.6, 0.3]);
          /**
           * ─────────────────────────────────────────────────────────────────
           * THE GHOST SIGN — a fifty-year-old painted advert for a company
           * that closed, and the single most Pittsburgh texture there is.
           * ─────────────────────────────────────────────────────────────────
           * `ghost_letters` was a unit-square block of abstract bars stretched
           * with the field. It goes; the field keeps the non-uniform stretch
           * (it is a stain, and a stain does not mind) and the WORDS go on
           * separately at uniform scale out of `SIGN_WORDS.ghost`.
           *
           * WHAT MAKES IT A GHOST AND NOT A SIGN is the `wear` callback: the
           * mask is driven by a two-octave noise field in the sign's own
           * space, so the paint survives in patches and is scoured to nothing
           * across the middle of the wall. Vertical banding on top of it is
           * the mortar courses drinking the lead white out of the paint — the
           * reason a real ghost sign fades in STRIPES rather than evenly.
           * The layout does not choose where it fades; the wall does.
           */
          const gAds = SIGN_WORDS.ghost;
          const ad = gAds[Math.floor(hash3i(wSeed, 60, 1) * gAds.length) % gAds.length];
          const age = 0.45 + hash3i(wSeed, 61, 1) * 0.5;
          this._type(B, ad, 'ghost_ink',
            cx + nx * (push + 0.03), gy + gh / 2, cz + nz * (push + 0.03), yaw,
            gw * 0.82, gh * 0.66,
            [0.75 + hash3i(wSeed, 62, 1) * 0.25, 0.85, 0.25],
            {
              key: `ghost${Math.round(age * 6)}`,
              weight: 0.105,
              leading: 1.5,
              wear: (x, y, w, h) => {
                const patch = smoothNoise(x * 1.7 + 3.1, y * 1.9 - 5.4);
                const fine = smoothNoise(x * 6.1 - 1.7, y * 5.3 + 2.2);
                const course = 0.5 + 0.5 * Math.sin(y * 21.0);
                const scour = clamp01(0.35 + 0.9 * patch + 0.35 * (fine - 0.5)
                  - 0.25 * course) * age;
                return [clamp01(0.35 + scour), clamp01(0.55 + 0.45 * (1 - scour)), 0.15];
              },
            });
          break;
        }
      }
      // ivy up a side wall
      if (!isFront && hash3i(wSeed, 6, 1) < 0.22) {
        const n = 1 + Math.floor(hash3i(wSeed, 7, 1) * Math.min(3, len / 4));
        for (let k = 0; k < n; k++) {
          const p = at((k + 0.5) / n, 0.12);
          const sc = 0.8 + hash3i(wSeed, k, 8) * 0.7;
          const push = this._wallPush(p.x, baseY + 1.4, p.z, nx, nz);
          if (push === null) continue;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, baseY, p.z + nz * push,
            yaw, sc, 0.7 + hash3i(wSeed, k, 9) * 0.8, sc);
          // ivy climbs 3 m: the lower corners are enough, the top may be free
          if (!this._wallBacked('ivy_panel', M, nx, nz, 2)) continue;
          B.put('ivy_panel', M, null);
        }
      }
      // aerosol at street level, flyposting on the blank stretches
      if (hash3i(wSeed, 10, 1) < 0.34 * (0.5 + style.litter)) {
        const p = at(0.2 + hash3i(wSeed, 11, 1) * 0.6, 0.05);
        const ty = baseY + 1.1 + hash3i(wSeed, 15, 1) * 0.8;
        const push = this._wallPush(p.x, ty, p.z, nx, nz);
        if (push !== null) {
          const v = Math.floor(hash3i(wSeed, 12, 1) * 4);
          const key = ['tag_a', 'tag_b', 'tag_c', 'tag_d'][Math.floor(hash3i(wSeed, 13, 1) * 4)];
          const sc = 0.8 + hash3i(wSeed, 14, 1) * 0.9;
          const id = `tag_${v}_${key}`;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, ty, p.z + nz * push,
            yaw, sc, sc * (0.8 + hash3i(wSeed, 16, 1) * 0.5), sc);
          if (this._wallBacked(id, M, nx, nz, 3)) B.put(id, M, null);
        }
      }
      if (hash3i(wSeed, 17, 1) < 0.28 * (0.4 + style.litter)) {
        const p = at(0.15 + hash3i(wSeed, 18, 1) * 0.7, 0.05);
        const push = this._wallPush(p.x, baseY + 1.2, p.z, nx, nz);
        if (push !== null) {
          const key = ['poster_a', 'poster_b', 'poster_c', 'poster_d'][Math.floor(hash3i(wSeed, 19, 1) * 4)];
          const id = `poster_cluster_${key}`;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, baseY, p.z + nz * push,
            yaw, 0.8 + hash3i(wSeed, 20, 1) * 0.5);
          if (this._wallBacked(id, M, nx, nz, 3)) B.put(id, M, null);
        }
      }
      // scaffolding on the odd building
      if (isFront && hash3i(wSeed, 21, 1) < 0.10 * style.scaffold && (lot.height ?? 0) > 8) {
        const bays = Math.max(1, Math.floor(len / 2.1));
        const lifts = Math.min(5, Math.max(2, Math.floor((lot.height ?? 8) / 2)));
        const base = this._wallPush(cx, baseY + 2.0, cz, nx, nz);
        if (base !== null) {
          for (let k = 0; k < bays; k++) {
            const p = at((k + 0.5) / bays, 0.75 + base);
            for (let l = 0; l < lifts; l++) {
              B.put('scaffold_bay', trs(new THREE.Matrix4(), p.x, baseY + l * 2.0, p.z, yaw), [0.7, 0.8, 0.5]);
            }
          }
          const p = at(0.5, 0.9 + base);
          B.put('ladder', trs(new THREE.Matrix4(), p.x, baseY, p.z, yaw + 0.1, 1, 1, 1, -0.12), [0.7, 0.8, 0.5]);
        }
      }
    }
  }

  /* -------------------------------------------------------- frontage --- */

  _frontage(B, lot, fr, bx, lod, seed, style, district) {
    const a = fr[0];
    const b = fr[1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 3.5) return;
    const ux = dx / len;
    const uz = dz / len;
    /**
     * WHICH WAY IS OUT. `lots.js` emits the frontage as u0 -> u1 for BOTH rows
     * of a two-row block, so the edge winding alone puts the outward normal
     * into the building for half of every block in the city — which is why the
     * first pass had no shopfronts on one side of every street. Decide it from
     * the lot centroid instead; that cannot be wrong.
     */
    let nx = uz;
    let nz = -ux;
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    if (nx * (mx - lot.cx) + nz * (mz - lot.cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const yaw = Math.atan2(nx, nz);
    const baseY = this._lotGround(lot);
    const shopish = lot.kind === 'shop' || lot.kind === 'block' || lot.kind === 'industrial';
    const units = Math.max(1, Math.round(len / (7 + hash3i(seed, 1, 2) * 4)));
    const neon = DISTRICT_NEON[district] ?? DISTRICT_NEON.lawren;
    const pOff = seed % 4;

    for (let u = 0; u < units; u++) {
      const uSeed = (seed ^ Math.imul(u + 1, 0x27d4eb2d)) >>> 0;
      const t0 = u / units;
      const t1 = (u + 1) / units;
      const tc = (t0 + t1) * 0.5;
      const cw = len / units;
      /**
       * ONE PROBE PER SHOP UNIT, at first-floor height, and every prop in the
       * unit moves with it. The frontage polygon is where `world` said the lot
       * faces the street; the shopfront is where `buildings` actually put the
       * wall, and on a stepped or inset ground floor those differ by up to a
       * metre — which is a fascia floating clear of its own building.
       */
      const pcx = a[0] + dx * tc;
      const pcz = a[1] + dz * tc;
      const push = this._wallPush(pcx, baseY + 2.6, pcz, nx, nz);
      if (push === null) continue;
      const cx = pcx + nx * (0.10 + push);
      const cz = pcz + nz * (0.10 + push);
      /**
       * WHAT THIS SHOP IS CALLED, decided once for the unit so the fascia, the
       * blade and the window all agree. An authored site wins outright and
       * also forces the unit to trade — see `_namedSites`.
       */
      const site = this._authoredName(pcx, pcz);
      /**
       * HOW MANY UNITS ON THIS FRONTAGE ACTUALLY TRADE — and this coefficient
       * is the one that decides whether twelve districts read as twelve
       * places. It was `0.62 + signage * 0.25`, which maps `style.signage`'s
       * full 0.15 to 1.30 range onto 0.66 to 0.95: the market street and the
       * clifftop terrace differed by three shops in ten and the city read as
       * one commercial strip laid down everywhere.
       *
       * MEASURED with `signprobe.mjs`, identical lots in every district: the
       * old curve put the Strip + Lawrenceville at 1.34x Mt Washington + Troy
       * Hill. The rubric asks for the Strip and Butler Street DENSE and the
       * residential hills SPARSE, so the slope is now the dominant term.
       */
      const trades = !!site || (shopish && hash3i(uSeed, 2, 2) < 0.40 + style.signage * 0.46);
      const words = shopWords(style.kind);
      const name = site
        ? site.name
        : words[Math.floor(hash3i(uSeed, 44, 2) * words.length) % words.length];
      /**
       * Two lines once the name is longer than the board is wide. `fitScale`
       * would otherwise honour the request and shrink 'FORTIETH ST LAUNDRY' to
       * 55 mm caps on a 4 m fascia, which is a sign nobody can read — and an
       * illegible sign is the finding, not a missing one. The split is at the
       * space nearest the middle, which is where a sign writer puts it.
       */
      const nameLines = (() => {
        if (name.length <= 13 || !name.includes(' ')) return [name];
        let cut = -1;
        let bestD = Infinity;
        for (let k = 0; k < name.length; k++) {
          if (name[k] !== ' ') continue;
          const d = Math.abs(k - name.length / 2);
          if (d < bestD) {
            bestD = d;
            cut = k;
          }
        }
        return cut > 0 ? [name.slice(0, cut), name.slice(cut + 1)] : [name];
      })();
      const ink = pickInk(style.kind, hash3i(uSeed, 45, 2));

      // --- the fascia board ---------------------------------------------
      if (trades) {
        const fw = cw * (0.72 + hash3i(uSeed, 3, 2) * 0.2);
        const fy = baseY + 3.15 + hash3i(uSeed, 4, 2) * 0.55;
        const M = trs(new THREE.Matrix4(), cx, fy, cz, yaw + (hash3i(uSeed, 5, 2) - 0.5) * 0.02,
          fw, 0.85 + hash3i(uSeed, 6, 2) * 0.35, 1);
        const fmask = [0.6 + hash3i(uSeed, 7, 2) * 0.7, 0.6 + hash3i(uSeed, 8, 2) * 0.6, 0.5];
        const panel = PANELS[(u + pOff) % PANELS.length];
        B.put('fascia_board', M, fmask);
        B.put(`fascia_face_${panel}`, M,
          [0.5 + hash3i(uSeed, 40, 2) * 0.8, 0.5 + hash3i(uSeed, 41, 2) * 0.8, 0.4]);
        // The gooseneck lamps go on at UNIFORM scale, at the board's own ends.
        for (const sgn of [-1, 1]) {
          const lx = cx + ux * (sgn * fw * 0.30);
          const lz = cz + uz * (sgn * fw * 0.30);
          B.put('fascia_lamp', trs(new THREE.Matrix4(), lx, fy, lz, yaw), fmask);
        }
        /**
         * ───────────────────────────────────────────────────────────────────
         * THE SHOP'S NAME, IN WORDS. This is the finding the wave is answering:
         * "a signless, empty world — no billboards, storefronts, shop names".
         * ───────────────────────────────────────────────────────────────────
         * What was here was a row of abstract neon glyphs in the district's
         * colour: correct as a light source, and completely mute. It is now
         * real type, at UNIFORM scale (see `_type`), in one of three inks
         * chosen by district era and for contrast against the panel the board
         * was just painted (`inkSurface`).
         *
         * The board field is the face's own reveal, not the board's outline:
         * `fascia_face_*` runs 0.94 wide by 0.48 tall about a centre 0.07 up,
         * and the type has to stay inside the two reveal rails or it reads as
         * lettering that has slipped off its sign.
         */
        const bandY = fy + (0.85 + hash3i(uSeed, 6, 2) * 0.35) * 0.07;
        const bandH = (0.85 + hash3i(uSeed, 6, 2) * 0.35) * 0.40;
        /**
         * `shop_lit` IS THE BACKLIT BOX, and it needs no case behind it. An
         * `EMISSIVE` entry resolves to `color 0x0a0a0a + emissive`, so by day
         * these letters are near-black plastic pans and after dark
         * `props._driveLights` runs them up — which is exactly the life of an
         * internally-lit fascia and is most of what separates the three eras
         * at night. An early pass put a `neon_backer` behind them; the board
         * is 0.14 m deep and the backer landed INSIDE it.
         */
        const inkKey = inkSurface(ink, panel);
        this._type(B, nameLines, inkKey,
          cx + nx * 0.17, bandY, cz + nz * 0.17, yaw, fw * 0.94, bandH,
          inkKey === 'shop_lit' ? null
            : [0.55 + hash3i(uSeed, 46, 2) * 0.7, 0.5 + hash3i(uSeed, 47, 2) * 0.7, 0.3],
          { margin: 0.94 });
      }

      // --- a projecting blade sign --------------------------------------
      if (trades && hash3i(uSeed, 10, 2) < 0.42 * (0.5 + style.signage)) {
        const px = a[0] + dx * (t0 + 0.25 / units) + nx * (0.05 + push);
        const pz = a[1] + dz * (t0 + 0.25 / units) + nz * (0.05 + push);
        const py = baseY + 3.3 + hash3i(uSeed, 11, 2) * 1.4;
        const sc = 0.9 + hash3i(uSeed, 12, 2) * 0.4;
        const M = trs(new THREE.Matrix4(), px, py, pz, yaw, sc, sc, sc);
        B.put('blade_bracket', M, [0.7, 0.8, 0.5]);
        B.put('blade_panel', M, [0.7, 0.8, 0.5]);
        B.put(`blade_face_${neon[(u + 1) % neon.length]}`, M, null);
        /**
         * ONE WORD, ON BOTH FACES, READING THE RIGHT WAY ROUND FROM EACH SIDE.
         *
         * A blade projects at right angles to the wall, so its faces are the
         * two sides of the panel and their normals are the wall's TANGENT, not
         * its normal. `trs` only gives yaw, and yaw +/- PI/2 is exactly the pair
         * that puts +Z' on each face — and, checked rather than assumed, each
         * one's +X' then runs left-to-right for the viewer standing on THAT
         * side. Draw one instance per face and neither is mirrored.
         *
         * The panel is 0.86 deep and 0.78 tall at unit scale, centred 0.42 out
         * and 0.12 down; the neon border eats 0.36 of it, so the word gets what
         * is left inside.
         */
        const bw = SIGN_WORDS.blade;
        const word = bw[Math.floor(hash3i(uSeed, 48, 2) * bw.length) % bw.length];
        const bcx = px + nx * (0.42 * sc);
        const bcz = pz + nz * (0.42 * sc);
        const bcy = py - 0.12 * sc;
        const bmask = [0.7 + hash3i(uSeed, 49, 2) * 0.5, 0.7, 0.35];
        for (const s of [-1, 1]) {
          this._type(B, word, 'sign_pale',
            bcx + ux * (s * 0.034 * sc), bcy, bcz + uz * (s * 0.034 * sc),
            yaw + s * Math.PI / 2, 0.62 * sc, 0.52 * sc, bmask);
        }
      }

      // --- a big neon on the wall ---------------------------------------
      if (trades && hash3i(uSeed, 13, 2) < 0.30 * (0.4 + style.signage)) {
        const py = baseY + 4.6 + hash3i(uSeed, 14, 2) * 2.4;
        const sc = 0.8 + hash3i(uSeed, 15, 2) * 0.7;
        const M = trs(new THREE.Matrix4(), cx, py, cz, yaw, sc, sc, sc);
        B.put('neon_backer', M, [0.7, 0.85, 0.5]);
        /**
         * HALF THE WALL NEONS NOW SAY SOMETHING. The abstract family — the
         * squiggle, the ring, the martini glass, the OPEN box — is the right
         * answer for a bar's window and the WRONG one for the whole city: a
         * street of six shapes and no words is the "signless world" finding
         * with the lights on. So a coin decides between the shape kit and a
         * readable tube word out of `SIGN_WORDS.neon`, and the word carries a
         * halo and its own dead tubes (see `_neonWord`).
         */
        const key = neon[(u + 2) % neon.length];
        const nw = SIGN_WORDS.neon;
        if (hash3i(uSeed, 50, 2) < 0.55
          && this._neonWord(B, nw[Math.floor(hash3i(uSeed, 51, 2) * nw.length) % nw.length],
            key, cx + nx * 0.10, py - 0.46 * sc, cz + nz * 0.10, yaw, nx, nz, 1.35 * sc, null)) {
          // the word took the backer's field; nothing else goes on it
        } else {
          B.put(`neon_${Math.floor(hash3i(uSeed, 16, 2) * 6)}_${key}`, M, null);
        }
      }

      /**
       * A tall vertical hotel/theatre sign, rare and load-bearing.
       *
       * ONE sign, authored to fill the frame. The first pass stacked five copies
       * of a small prototype at a 0.65 m pitch when the prototype was 0.87 m
       * tall, so they overlapped into a single column of symmetrical blobs —
       * "five untextured purple crosses down a wall" in three separate reviews.
       * If a sign needs five of anything, the FIVE belong inside the prototype
       * where they can be composed, not in the placement loop.
       */
      if (trades && (lot.height ?? 0) > 14 && hash3i(uSeed, 17, 2) < 0.07 * (0.4 + style.signage)) {
        const py = baseY + 12 + hash3i(uSeed, 18, 2) * 5;
        const M = trs(new THREE.Matrix4(), cx, py, cz, yaw);
        B.put('blade_tall_frame', M, [0.8, 0.9, 0.5]);
        // the frame is a ladder 0.95 m deep, hung off the wall: the sign sits on
        // its centre plane, facing along the street rather than out of the wall.
        const vkey = neon[u % neon.length];
        /**
         * THE THEATRE BUG NOW SPELLS SOMETHING. A vertical sign is one letter
         * per line, which is what `buildTextGeo`'s multi-line layout already
         * is — so H O T E L is a five-row block with a one-glyph row, no new
         * machinery. It goes on BOTH faces at yaw +/- PI/2, for the same reason
         * the blade word does: this sign faces along the street, not out of the
         * wall, and each side needs its own instance to read the right way.
         *
         * `neon_vert_*` stays as the fallback for the words the frame cannot
         * hold at a legible cap height — it is abstract, but a 4 cm letter is
         * worse than an abstract one.
         */
        const vw = ['HOTEL', 'DINER', 'ROOMS', 'LOANS', 'CAFE', 'GRAND', 'PALACE'];
        const vword = vw[Math.floor(hash3i(uSeed, 52, 2) * vw.length) % vw.length];
        let drewVert = false;
        for (const s of [-1, 1]) {
          drewVert = this._type(B, vword.split(''), vkey,
            cx + nx * 0.575 + ux * (s * 0.06), py - 1.80, cz + nz * 0.575 + uz * (s * 0.06),
            yaw + s * Math.PI / 2, 0.80, 3.10, null, { weight: 0.10, leading: 1.30 })
            || drewVert;
        }
        if (!drewVert) {
          B.put(`neon_vert_${vkey}`,
            trs(new THREE.Matrix4(), cx + nx * 0.575, py - 1.80, cz + nz * 0.575,
              yaw + Math.PI / 2), null);
        }
      }

      if (lod !== 0) continue;

      // --- awning --------------------------------------------------------
      if (trades && hash3i(uSeed, 19, 2) < 0.40) {
        const aw = cw * (0.68 + hash3i(uSeed, 20, 2) * 0.22);
        const ay = baseY + 2.95 + hash3i(uSeed, 21, 2) * 0.3;
        const key = ['awning_red', 'awning_green', 'awning_cream'][Math.floor(hash3i(uSeed, 22, 2) * 3)];
        const M = trs(new THREE.Matrix4(), cx, ay, cz, yaw + (hash3i(uSeed, 23, 2) - 0.5) * 0.03,
          aw, 1, 0.9 + hash3i(uSeed, 24, 2) * 0.35);
        B.put('awning_frame', M, [0.7, 0.85, 0.5]);
        B.put(`awning_canvas_${key}`, M, null);
        for (const sgn of [-1, 1]) {
          const lx = cx + ux * (sgn * aw * 0.48);
          const lz = cz + uz * (sgn * aw * 0.48);
          B.put('awning_rib', trs(new THREE.Matrix4(), lx, ay, lz, yaw, 1, 1,
            0.9 + hash3i(uSeed, 24, 2) * 0.35), [0.7, 0.85, 0.5]);
        }
      }

      // --- the lit window and the shutter -------------------------------
      if (trades) {
        const closed = hash3i(uSeed, 25, 2) < 0.22;
        if (closed) {
          const n = Math.max(1, Math.round(cw / 1.4));
          for (let k = 0; k < n; k++) {
            const t = t0 + (k + 0.5) / n / units;
            const px = a[0] + dx * t + nx * (0.09 + push);
            const pz = a[1] + dz * t + nz * (0.09 + push);
            B.put('shutter_unit', trs(new THREE.Matrix4(), px, baseY + 0.05, pz, yaw,
              cw / n, 2.5 + hash3i(uSeed, k, 26) * 0.4, 1), [0.8, 0.9, 0.5]);
            if (hash3i(uSeed, k, 27) < 0.4) {
              B.put(`tag_${k % 4}_${['tag_a', 'tag_b', 'tag_c'][k % 3]}`,
                trs(new THREE.Matrix4(), px, baseY + 1.2, pz, yaw, 0.7, 0.7, 0.7), null);
            }
          }
        } else {
          B.put('shop_glow', trs(new THREE.Matrix4(), cx, baseY + 1.5, cz, yaw,
            cw * 0.72, 2.1, 1), null);
        }
        // menu case beside the door
        if (hash3i(uSeed, 28, 2) < 0.3) {
          const px = a[0] + dx * (t1 - 0.18 / units) + nx * (0.08 + push);
          const pz = a[1] + dz * (t1 - 0.18 / units) + nz * (0.08 + push);
          const M = trs(new THREE.Matrix4(), px, baseY + 1.25, pz, yaw);
          B.put('menu_case', M, [0.7, 0.8, 0.5]);
          B.put('menu_lit', M, null);
        }
      }

      // --- house frontage: a stoop, and the bins beside it ----------------
      if (!trades && (lot.kind === 'house' || lot.kind === 'block') && hash3i(uSeed, 29, 2) < 0.7) {
        const px = cx + nx * 0.35;
        const pz = cz + nz * 0.35;
        {
          const sc = 0.9 + hash3i(uSeed, 30, 2) * 0.25;
          const M = trs(new THREE.Matrix4(), px, baseY, pz, yaw + (hash3i(uSeed, 31, 2) - 0.5) * 0.05, sc, sc, sc);
          B.put('stoop_steps', M, [0.7 + hash3i(uSeed, 32, 2) * 0.6, 0.8, 0.6]);
          if (hash3i(uSeed, 33, 2) < 0.7) B.put('stoop_rail', M, [0.8, 0.85, 0.5]);
          B.box('concrete', px, baseY, pz, 1.6, 0.7, 1.3, yaw);
        }
      }
    }
  }

  /* ------------------------------------------------------------ parks --- */

  _park(B, lot, bx, lod, seed, style) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    const n = Math.max(4, Math.round((b.w * b.d) / 95));
    for (let i = 0; i < n; i++) {
      const h0 = hash3i(seed, i, 1);
      const h1 = hash3i(seed, i, 2);
      const x = b.x0 + h0 * b.w;
      const z = b.z0 + h1 * b.d;
      if (!pointInPoly(x, z, foot, 2.0)) continue;
      const y = this.world.heightAt(x, z);
      // `_lotParking` already learned this: a lot polygon can run up to — and
      // over — the kerb, so "inside the lot" is not "off the road".
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const h2 = hash3i(seed, i, 3);
      const yaw = hash3i(seed, i, 4) * TAU;
      const sc = 0.85 + hash3i(seed, i, 5) * 0.6;
      const mask = [0.5 + h0, 0.5 + h1 * 0.8, 0.7];
      if (h2 < 0.42 && this._headroom(x, y, z, 9 * sc)) {
        const sp = STREET_SPECIES[Math.floor(hash3i(seed, i, 16) * STREET_SPECIES.length) % STREET_SPECIES.length];
        const v = lod !== 0 ? 'far' : Math.floor(hash3i(seed, i, 17) * 4) % 4;
        // A park keeps the quarter-turned mix the uniform draw over four leaf
        // materials used to give it, now spread over whichever turning
        // variants exist instead of landing on one orange.
        const li = lod !== 0 ? 0 : this._leafIndex(hash3i(seed, i, 6), 0.25);
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc * (0.9 + h1 * 0.3), sc,
          (h0 - 0.5) * 0.09, (h1 - 0.5) * 0.09);
        B.put(`tree_${sp}_${v}_wood`, M, mask);
        B.put(`tree_${sp}_${v}_leaf${li}`, M, mask);
        if (lod === 0) B.box('wood', x, y, z, 0.36, 2.5, 0.36);
      } else if (h2 < 0.58 && this._headroom(x, y, z, 9 * sc)) {
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc);
        B.put('tree_pine_wood', M, mask);
        B.put('tree_pine_leaf', M, mask);
      } else if (lod === 0 && h2 < 0.80) {
        B.put(['shrub_a', 'shrub_b', 'shrub_c'][i % 3],
          trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      } else if (lod === 0) {
        /**
         * A lawn is not one tuft every ten metres. Grass is the cheapest thing
         * in the kit (56 triangles, no shadow, gone at 145 m) and the thing a
         * park most obviously lacks, so a grass hit seeds a small drift of them
         * rather than a single clump — scaled by `q.grassDensity`, which is
         * 0.18 on `low` and 1.0 on `ultra`.
         */
        const gn = Math.max(1, Math.round(5 * this.grassDensity));
        for (let k = 0; k < gn; k++) {
          const g0 = hash3i(seed, i * 11 + k, 41);
          const g1 = hash3i(seed, i * 11 + k, 42);
          const gx = x + (g0 - 0.5) * 2.2;
          const gz = z + (g1 - 0.5) * 2.2;
          const gy = this.world.heightAt(gx, gz);
          if (!this._clearsLanes(gx, gy, gz, LOT_CLEAR)) continue;
          const gs = sc * (0.7 + 0.8 * g0);
          B.put('grass_clump', trs(new THREE.Matrix4(),
            gx, gy, gz, g1 * TAU, gs * 1.5, gs, gs * 1.5), mask);
        }
      }
    }
    if (lod !== 0) return;
    // benches and bins on the paths
    for (let i = 0; i < Math.max(2, Math.round(b.w / 22)); i++) {
      const x = b.x0 + hash3i(seed, i, 11) * b.w;
      const z = b.z0 + hash3i(seed, i, 12) * b.d;
      if (!pointInPoly(x, z, foot, 3)) continue;
      const y = this.world.heightAt(x, z);
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const yaw = hash3i(seed, i, 13) * TAU;
      const M = trs(new THREE.Matrix4(), x, y, z, yaw, 1, 1, 1, 0, (hash3i(seed, i, 14) - 0.5) * 0.03);
      B.put('bench_slat', M, [0.8, 0.7, 0.5]);
      B.put('bench_ends', M, [0.8, 0.9, 0.5]);
      // The bin is thrown 2.2 m from the bench on the bench's random yaw, so it
      // can clear the lot boundary the bench itself was checked against.
      if (hash3i(seed, i, 15) < 0.5) {
        const bxp = x + Math.cos(yaw) * 2.2;
        const bzp = z + Math.sin(yaw) * 2.2;
        if (this._clearsLanes(bxp, y, bzp, 0.4)) {
          B.put('bin_mesh', trs(new THREE.Matrix4(), bxp, y, bzp,
            hash3i(seed, i, 16) * TAU), [0.9, 0.9, 0.6]);
        }
      }
    }
  }

  /* ----------------------------------------------- surface car parks ---- */

  _surfaceLot(B, lot, bx, lod, seed, style) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    const y0 = this._lotGround(lot);
    // the chain-link and the weeds that grow through it
    if (lod === 0) {
      const n = Math.max(3, Math.round((b.w * b.d) / 55));
      for (let i = 0; i < n; i++) {
        const x = b.x0 + hash3i(seed, i, 21) * b.w;
        const z = b.z0 + hash3i(seed, i, 22) * b.d;
        if (!pointInPoly(x, z, foot, 1.2)) continue;
        const y = this.world.heightAt(x, z);
        // A skip or a jersey barrier standing in the running lane is the single
        // worst thing this file can emit; a surface lot's boundary is exactly
        // where that happens.
        if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
        const r = hash3i(seed, i, 23);
        const yaw = hash3i(seed, i, 24) * TAU;
        const sc = 0.8 + hash3i(seed, i, 25) * 0.7;
        const mask = [0.5, 0.8, 0.6];
        if (r < 0.32) B.put('weed_tuft', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.5) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.60) B.put('pallet', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.68) B.put('tyre_stack', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.74) B.put('drum_oil', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.80) B.put('cone', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc,
          (hash3i(seed, i, 26) - 0.5) * 0.5), mask);
        else if (r < 0.86) B.put('barrier_jersey', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.93) B.put('skip', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else B.put('dumpster', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      }
    }
    // a billboard facing the street
    if (hash3i(seed, 30, 1) < 0.30 && lot.frontage) {
      const fr = lot.frontage;
      const cx = (fr[0][0] + fr[1][0]) / 2;
      const cz = (fr[0][1] + fr[1][1]) / 2;
      const ux = (fr[1][0] - fr[0][0]);
      const uz = (fr[1][1] - fr[0][1]);
      const l = Math.hypot(ux, uz) || 1;
      const yaw = Math.atan2(uz / l, -ux / l) + Math.PI / 2;
      /**
       * The billboard is deliberately shoved 3.5 m off the frontage line TOWARD
       * the street so it reads from the road — which on a lot whose frontage
       * already sits on the kerb puts a 6 m hoarding in the near-side lane.
       * Walk it back onto the plot until it clears.
       */
      let px = 0;
      let pz = 0;
      let ok = false;
      for (let d = 3.5; d >= -1.0; d -= 0.75) {
        px = cx + (uz / l) * d;
        pz = cz - (ux / l) * d;
        if (this._clearsLanes(px, this.world.heightAt(px, pz), pz, 3.0)) {
          ok = true;
          break;
        }
      }
      if (!ok) return;
      const M = trs(new THREE.Matrix4(), px, this.world.heightAt(px, pz), pz,
        yaw + (hash3i(seed, 31, 1) - 0.5) * 0.2);
      B.put('billboard_frame', M, [0.8, 0.9, 0.5]);
      B.put('billboard_face', M, [0.8, 0.8, 0.3]);
      B.put('billboard_art', M, [0.75, 0.85, 0.3]);
      B.put('billboard_lit', M, null);
      /**
       * THE COPY. `billboard_art` is the image block and the strapline RULES —
       * grey bars standing in for type, which read as an unfinished poster in
       * every capture. The words go on top of them out of `SIGN_WORDS.billboard`:
       * a headline and a strapline, both original Steel City products (the
       * radio stations and the marques from DESIGN.md, the motor oil, the
       * coffee). The art block occupies the left third of the panel, so the
       * type is set in the right two thirds and centred there.
       */
      const ads = SIGN_WORDS.billboard;
      const ad = ads[Math.floor(hash3i(seed, 32, 1) * ads.length) % ads.length];
      const yawB = yaw + (hash3i(seed, 31, 1) - 0.5) * 0.2;
      const bnx = Math.sin(yawB);
      const bnz = Math.cos(yawB);
      const bux = Math.cos(yawB);
      const buz = -Math.sin(yawB);
      const gy = this.world.heightAt(px, pz);
      this._type(B, [ad[0]], 'sign_ink',
        px + bux * 0.95 + bnx * 0.13, gy + 5.17, pz + buz * 0.95 + bnz * 0.13,
        yawB, 2.8, 0.38, [0.85, 0.7, 0.2]);
      this._type(B, [ad[1]], 'sign_ink',
        px + bux * 1.30 + bnx * 0.13, gy + 3.99, pz + buz * 1.30 + bnz * 0.13,
        yawB, 2.0, 0.20, [0.9, 0.75, 0.2]);
    }
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ROOFTOP HOARDINGS — the skyline's half of the signage layer.
   * ─────────────────────────────────────────────────────────────────────────
   * `tile.js`'s mount contract publishes a 'billboard' anchor on the roof deck
   * of tall flat-roofed archetypes, and that is the right shape for this. It is
   * NOT what this reads, and the reason is worth stating rather than hiding: a
   * mount array lives on the near BUILDING tile's group, `props` builds its own
   * tiles from `world.lotsInTile` and holds no reference to the buildings
   * subsystem, and reaching for one would be exactly the cross-subsystem import
   * rule 2 forbids.
   *
   * So this derives the anchor from the same inputs the mount does — the lot
   * polygon, its height, the street it faces — and then VERIFIES it against
   * the built world with a downward ray, which the mount pass cannot do because
   * it runs before its own colliders exist. A hoarding is only drawn where
   * physics agrees there is a deck under all four feet at roughly the height
   * the lot record claims. That is a stronger guarantee than the contract
   * offers, and it is what stops the "two floating illegible billboards in
   * mid-air" defect coming back at roof height.
   */
  _rooftopBoard(B, lot, seed, style) {
    const foot = lot.footprint;
    const h = lot.height ?? 0;
    if (!foot || foot.length < 3 || h < 16) return;
    if (hash3i(seed, 70, 1) > 0.16 + style.signage * 0.14) return;
    const phys = this._phys();
    if (!phys?.raycast) return;
    const baseY = this._lotGround(lot);

    // The street-facing edge: the longest one whose outward normal points away
    // from the lot centroid and which is long enough to carry the board.
    let best = null;
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i];
      const b = foot[(i + 1) % foot.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 9) continue;
      if (!best || len > best.len) {
        const ux = (b[0] - a[0]) / len;
        const uz = (b[1] - a[1]) / len;
        let nx = uz;
        let nz = -ux;
        const mx = (a[0] + b[0]) / 2;
        const mz = (a[1] + b[1]) / 2;
        if (nx * (mx - lot.cx) + nz * (mz - lot.cz) < 0) {
          nx = -nx;
          nz = -nz;
        }
        best = { len, ux, uz, nx, nz, mx, mz };
      }
    }
    if (!best) return;

    /**
     * IS THERE A ROOF THERE? Four rays down the board's own footprint from
     * well above it. `lot.height` is what `world` ASKED for; `buildings` sets
     * back, steps and pitches its massing, so on a stepped tower the deck at
     * the parapet line is metres below the lot record and on a pitched roof
     * there is no deck at all. Requiring all four feet inside 1.6 m of each
     * other rejects both without this file knowing anything about archetypes.
     */
    const bw = Math.min(best.len - 3.0, 13);
    const inset = 2.2;
    const ox = best.mx - best.nx * inset;
    const oz = best.mz - best.nz * inset;
    let deck = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 4; k++) {
      const t = (k - 1.5) / 1.5;
      const sx = ox + best.ux * (t * bw * 0.5) - best.nx * (k & 1 ? 0.8 : 0);
      const sz = oz + best.uz * (t * bw * 0.5) - best.nz * (k & 1 ? 0.8 : 0);
      const hit = phys.raycast(sx, baseY + h + 14, sz, 0, -1, 0, h + 22, phys.MASK?.WORLD);
      if (!hit?.hit) return;
      const y = hit.point.y;
      if (y < baseY + 10) return; // that is the ground, not a roof
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
      deck += y;
    }
    if (hi - lo > 1.6) return; // stepped or pitched: no deck to stand on
    deck /= 4;

    const bh = Math.min(5.6, Math.max(3.2, h * 0.20));
    const yaw = Math.atan2(best.nx, best.nz);
    const mask = [0.75 + hash3i(seed, 71, 1) * 0.5, 0.85, 0.4];
    /**
     * NON-UNIFORM SCALE IS SAFE HERE ONLY BECAUSE THE FRAME IS ALL BOXES. See
     * `roof_board_frame` — the raked back stay is a rotated box and not a
     * tube, for exactly this reason: a 48 mm round section stretched thirteen
     * times in x is a ribbon, which is the trap `fascia_board` documents.
     *
     * Z IS NEVER SCALED. The section of a post and the depth of the back stay
     * are properties of the steel, not of how tall the hoarding is; scaling z
     * with the height gave a 4 m board 0.64 m deep legs and swallowed its own
     * poster, which sits at z = 0.13.
     */
    B.put('roof_board_frame',
      trs(new THREE.Matrix4(), ox, deck, oz, yaw, bw, bh, 1), mask);
    B.put('roof_board_face',
      trs(new THREE.Matrix4(), ox, deck, oz, yaw, bw, bh, 1), [0.8, 0.8, 0.3]);

    const ads = SIGN_WORDS.billboard;
    const ad = ads[Math.floor(hash3i(seed, 72, 1) * ads.length) % ads.length];
    // The face runs 0.98 x 0.60 about (0, 0.68) at unit scale: headline in the
    // top two thirds, strapline under it, both inside the paper.
    this._type(B, [ad[0]], 'sign_ink',
      ox + best.nx * 0.17, deck + bh * 0.80, oz + best.nz * 0.17, yaw,
      bw * 0.86, bh * 0.26, [0.9, 0.7, 0.25]);
    this._type(B, [ad[1]], 'sign_ink',
      ox + best.nx * 0.17, deck + bh * 0.55, oz + best.nz * 0.17, yaw,
      bw * 0.72, bh * 0.15, [0.9, 0.75, 0.25]);
  }

  /* -------------------------------------------- verges and waste ground -- */

  /**
   * A drift of grass rather than one tuft. Scaled by `q.grassDensity` so `low`
   * places one and `ultra` places six, which is the whole point of that number
   * existing — it had never been read.
   */
  _grassDrift(B, x, y, z, seed, i, sc, mask) {
    const n = Math.max(1, Math.round(6 * this.grassDensity));
    for (let k = 0; k < n; k++) {
      const g0 = hash3i(seed, i * 13 + k, 51);
      const g1 = hash3i(seed, i * 13 + k, 52);
      const gx = x + (g0 - 0.5) * 2.6;
      const gz = z + (g1 - 0.5) * 2.6;
      const gy = this.world.heightAt(gx, gz);
      if (!this._clearsLanes(gx, gy, gz, LOT_CLEAR)) continue;
      const gs = sc * (0.65 + 0.85 * g0);
      B.put('grass_clump', trs(new THREE.Matrix4(),
        gx, gy, gz, g1 * TAU, gs * 1.6, gs, gs * 1.6), mask);
    }
  }

  /**
   * IS THERE ROOM FOR A TREE HERE, OR IS THERE A BRIDGE OVER IT?
   *
   * Without this, a canopy floats against a viaduct girder with no trunk under
   * it. Scatter vegetation is planted at `world.heightAt` — the TERRAIN — and
   * the terrain runs on underneath every viaduct and embankment in the city, so
   * a tree can be planted in the dark under a deck with its trunk swallowed by
   * the structure and only the top of its crown poking through. Nothing in the
   * placement arithmetic can see that; only the geometry can.
   *
   * A HIT is positive evidence and vetoes the tree. A MISS is not evidence of
   * anything — `physics` only holds triangles within 320 m of the camera and a
   * tile can be built outside that — so a miss plants as before. That asymmetry
   * is deliberate: it can only ever remove a tree that provably has a roof.
   */
  _headroom(x, y, z, need) {
    const phys = this._phys();
    if (!phys?.raycast) return true;
    const h = phys.raycast(x, y + 0.6, z, 0, 1, 0, need, phys.MASK?.WORLD);
    return !(h?.hit);
  }

  _wasteGround(B, bx, lots, rng) {
    // Scatter on whatever the world calls dirt or grass inside this tile: the
    // verge behind the kerb, the batter of an embankment, the gaps nobody owns.
    const N = 44;
    const seed = (Math.imul(bx.x0 | 0, 0x9e3779b1) ^ Math.imul(bx.z0 | 0, 0x85ebca6b)) >>> 0;
    for (let i = 0; i < N; i++) {
      const x = bx.x0 + hash3i(seed, i, 1) * (bx.x1 - bx.x0);
      const z = bx.z0 + hash3i(seed, i, 2) * (bx.z1 - bx.z0);
      const surf = this.world.surfaceAt?.(x, z);
      if (surf !== 'grass' && surf !== 'dirt') continue;
      const y = this.world.heightAt(x, z);
      // A verge inside a road corridor is still road.
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const yaw = hash3i(seed, i, 3) * TAU;
      const sc = 0.7 + hash3i(seed, i, 4) * 0.9;
      const r = hash3i(seed, i, 5);
      const mask = [0.4, 0.55, 0.5];
      /**
       * WATER'S EDGE. Three rivers and forty bridges, and the banks were bare
       * mown terrain right down to the waterline. Within ~7 m of water the
       * scatter switches to the willow-scrub form, which is taller, looser and
       * hangs over — the read that says "riverbank" from a boat or a bridge.
       */
      const bank = this.world.isWater
        ? (this.world.isWater(x + 7, z) || this.world.isWater(x - 7, z)
          || this.world.isWater(x, z + 7) || this.world.isWater(x, z - 7))
        : false;
      if (bank) {
        if (r < 0.52) B.put('scrub_bank', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc * (0.8 + r), sc), mask);
        else if (r < 0.86) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc * 1.2, sc, sc * 1.2), mask);
        else this._grassDrift(B, x, y, z, seed, i, sc, mask);
        continue;
      }
      if (r < 0.45) this._grassDrift(B, x, y, z, seed, i, sc, mask);
      else if (r < 0.72) B.put('weed_tuft', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      else if (r < 0.90) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      else if (this._headroom(x, y, z, 9 * sc)) {
        const sp = STREET_SPECIES[Math.floor(hash3i(seed, i, 7) * STREET_SPECIES.length) % STREET_SPECIES.length];
        const v = Math.floor(hash3i(seed, i, 8) * 4) % 4;
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc, (hash3i(seed, i, 6) - 0.5) * 0.12);
        B.put(`tree_${sp}_${v}_wood`, M, mask);
        // `(i + 2) % 4` walked the leaf materials in lockstep with the scatter
        // index — a period-four cycle down a strip of waste ground, which is
        // the same defect the street planting note above calls out. Self-sown
        // scrub trees are the most stressed in the city and turn earliest, so
        // this ground carries more autumn than a watered verge does.
        B.put(`tree_${sp}_${v}_leaf${this._leafIndex(hash3i(seed, i, 9), 0.30)}`, M, mask);
      } else {
        B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      }
    }
  }

  /* ================================================================== */
  /* parked cars — coordinated with `vehicles` at runtime                */
  /* ================================================================== */

  /**
   * The lane layer `traffic` publishes, or null until it exists. Read at build
   * time, never imported (ARCHITECTURE.md rule 2), and re-read while it is not
   * ready because the first tiles are dressed before `traffic` has attached.
   */
  _lanes() {
    if (this._laneNet?.ready) return this._laneNet;
    this._laneNet = this.peek?.('traffic')?.lanes ?? null;
    return this._laneNet?.ready ? this._laneNet : null;
  }

  /**
   * WHERE A KERB BAY IS LEGAL — a pure function of the edge, so `traffic` can
   * ask it the same question (`props.parkedOnEdge`) and get the same answer
   * without either of us keeping state.
   *
   * The rule is `traffic/lanes.js`'s, restated rather than guessed at: a bay
   * eats ~2.45 m of carriageway, so it may only exist where giving up the kerb
   * lane still leaves a running lane in each direction. On the 7.2 m two-lane
   * streets that is never true.
   */
  parksOn(edge, side) {
    if (!edge || edge.rail || edge.bridge) return false;
    if (edge.kind === 'highway' || edge.kind === 'alley') return false;
    if (edge.len < 40) return false;
    const L = this._lanes();
    if (L) {
      const flags = L.parkFlags(edge);
      return side > 0 ? !!(flags & 1) : !!(flags & 2);
    }
    // No traffic system: fall back to the same geometric test it uses.
    const fw = edge.forward;
    return fw >= 2 && edge.lanes - fw >= 2;
  }

  /**
   * AN AIRFIELD IS OPEN GROUND — the same rule `world/netgen` applies to
   * rowhouse blocks ("no block on the bench"), applied to everything this
   * file places. The two civilian strips and Ridgeline AFB publish their
   * field rects through `world.airfieldAt` / `world.airbaseAt`; anything
   * standing inside one is inside the fence, and anything inside the runway
   * roll lanes is what the SKYLARK's wing meets on its take-off run —
   * measured before this guard: 232 street-furniture colliders in
   * af_county's roll corridor, 166 in af_rivers'. Consulted by `_clearOff`
   * and `_clearsLanes`, which every placement family funnels through.
   *
   * `debugIgnoreAirfields` is the live-code negative-control hatch (the
   * `debugIgnorePause` pattern): `airsweep` flips it to prove the guard is
   * what keeps the strip clean, without editing production code.
   */
  _onAirfield(x, z) {
    if (this.debugIgnoreAirfields) return false;
    const w = this.world;
    return !!(w.airfieldAt?.(x, z) || w.airbaseAt?.(x, z));
  }

  /**
   * FINAL GUARD: does a thing standing here clear every lane a driver may use?
   *
   * `parksOn` reasons about ONE edge, and that is not enough in a real graph —
   * downtown has an at-grade highway running alongside an arterial, so a bay
   * that is perfectly legal on its own edge can still sit in the middle of the
   * six-lane road next to it. Ten of the first pass's fifty-one slots did. This
   * asks the question the fleet actually cares about: is there any drivable
   * lane, at this height, within a car's half-width of me?
   *
   * This was originally only ever asked about PARKED CARS, which is why a real
   * player found a stop sign standing in a live lane: `_cornerKit`,
   * `_kerbClutter`, `_lampRun` and `_treeRun` all place from an offset measured
   * off `edge.width`, and `edge.width` is not the same number as "where the
   * outermost drivable lane ends" at a junction, on a flared approach, or
   * anywhere a second corridor runs close by. Every family now goes through
   * `_clearOff` / `_clearsLanes`.
   */
  _clearsLanes(x, y, z, clearance) {
    if (this._onAirfield(x, z)) return false;
    return this.laneIntrusion(x, y, z, clearance) <= 0;
  }

  /**
   * HOW FAR INTO a drivable lane a disc of radius `clearance` at (x,y,z) reaches,
   * in metres. <= 0 is clear.
   *
   * `_clearsLanes` is this thresholded, and `src/props/lanesweep.mjs` calls it
   * directly, so the shipped guard and the assertion that polices it are the
   * same arithmetic and cannot drift apart.
   *
   * `edges` may be a pre-gathered candidate list (see `_nearEdgesFor`); without
   * one it does its own broad-phase. `out`, when given, receives the edge that
   * produced the worst reading — which is the difference between "this prop's
   * own offset is wrong" and "a second corridor is lying on top of this one",
   * and those two have completely different fixes.
   */
  laneIntrusion(x, y, z, clearance, edges = null, out = null) {
    const roads = this.world.roads;
    if (!roads?.edgesInRect) return -1;
    let list = edges;
    if (!list) {
      list = this._nearEdges ??= [];
      list.length = 0;
      roads.edgesInRect(x - 30, z - 30, x + 30, z + 30, list);
    }
    const L = this._lanes();
    let worst = -1e9;
    for (const ed of list) {
      if (ed.rail) continue;
      const na = roads.nodes[ed.a];
      const nb = roads.nodes[ed.b];
      const px = x - na.x;
      const pz = z - na.z;
      const tRaw = px * ed.dx + pz * ed.dz;
      /**
       * A CARRIAGEWAY IS A BAND, NOT A CAPSULE.
       *
       * This used to clamp `t` to the segment and measure the euclidean
       * distance to the clamped point — a capsule, whose round cap projects a
       * disc of radius `laneEdge` past the end node. On a 28.6 m highway that
       * is fourteen metres of phantom road hanging off the end of every
       * segment, and it made furniture standing on a perfectly ordinary
       * pavement near a highway junction measure as 9 m deep in a lane. It also
       * made the reading DISCONTINUOUS: 7 cm of movement crossed the old
       * `len + 6` cutoff and swung the answer by 10 m.
       *
       * Edges meet end to end, so the neighbour owns the ground past the node
       * and the cap was never needed for coverage — only a short slop, so a
       * prop just past a dead end still respects the road it is standing in.
       */
      const over = tRaw < 0 ? -tRaw : tRaw > ed.len ? tRaw - ed.len : 0;
      if (over > 2.0) continue;
      const t = tRaw < 0 ? 0 : tRaw > ed.len ? ed.len : tRaw;
      const ey = na.y + (nb.y - na.y) * (t / Math.max(1e-3, ed.len));
      // A viaduct overhead is not an obstruction; only same-level road is.
      if (Math.abs(ey - y) > 3.0) continue;
      const lat = -ed.dz * px + ed.dx * pz;
      const dir = lat >= 0 ? 1 : -1;
      let laneEdge;
      if (L) {
        if (!L.drivable(ed, dir)) continue;
        laneEdge = Math.abs(L.laneOffset(ed, L.laneHi(ed, dir))) + ed.laneWidth * 0.5;
      } else {
        const fw = ed.forward;
        const k = dir > 0 ? fw - 1 : ed.lanes - fw - 1;
        if (k < 0) continue;
        laneEdge = (k + 1) * ed.laneWidth;
      }
      // Perpendicular distance to the centreline — `lat` already is exactly
      // that, because an edge is straight.
      const dist = Math.abs(lat);
      const d = laneEdge + 0.15 - (dist - clearance);
      if (d > worst) {
        worst = d;
        if (out) {
          out.edge = ed;
          out.laneEdge = laneEdge;
          out.dist = dist;
        }
      }
    }
    return worst === -1e9 ? -1 : worst;
  }

  /**
   * Broad-phase for a whole edge, cached.
   *
   * The guard used to run its own `edgesInRect` per candidate. That is fine for
   * fifty parked cars and ruinous for the ~40 pieces of furniture on every side
   * of every edge in the city — it is the same query, from points a couple of
   * metres apart, tens of thousands of times. One query per edge, sized to the
   * edge's own bounds plus the 30 m the point query used, is identical in
   * result and roughly two orders of magnitude cheaper.
   */
  _nearEdgesFor(edge) {
    let rec = (this._nearCache ??= new Map()).get(edge.id);
    if (rec) return rec;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    rec = [];
    g.edgesInRect?.(
      Math.min(na.x, nb.x) - 30, Math.min(na.z, nb.z) - 30,
      Math.max(na.x, nb.x) + 30, Math.max(na.z, nb.z) + 30, rec
    );
    this._nearCache.set(edge.id, rec);
    return rec;
  }

  /**
   * PUSH, THEN DROP. Street furniture belongs at the kerb, so a piece that
   * fouls a lane is almost always a piece whose offset was measured off the
   * wrong number rather than a piece that should not exist.
   *
   * Rejecting outright is what left "every short block completely bare" the
   * last time a clearance rule went in here, so this walks the prop outward
   * across the pavement in 0.25 m steps first and only gives up when even the
   * back of the footway is inside a lane (which means the pavement itself is
   * under the road — a `world` problem, not something to dress).
   *
   * @returns {THREE.Vector3|null} a cleared position, or null to skip.
   */
  _clearOff(edge, s, side, off, clearance, maxOff, out = new THREE.Vector3()) {
    const near = this._nearEdgesFor(edge);
    for (let o = off; o <= maxOff + 1e-6; o += 0.25) {
      this._pos(edge, s, side, o, out);
      // Pushing outward cannot get a prop OFF an airfield — the field is on
      // the far side of the kerb — so this side of the street stays bare.
      if (this._onAirfield(out.x, out.z)) return null;
      if (this.laneIntrusion(out.x, out.y, out.z, clearance, near) <= 0) return out;
    }
    return null;
  }

  /** Signed lateral offset of the bay centre from the edge centreline. */
  _bayOffset(edge, side) {
    const L = this._lanes();
    if (L) return L.parkOffset(edge, side);
    return side > 0 ? edge.width * 0.5 - PARK_INSET : -(edge.width * 0.5 - PARK_INSET);
  }

  /**
   * PARKED CARS STAND ON THE CARRIAGEWAY, SO THE CARRIAGEWAY DECIDES.
   *
   * The first pass put a car at `width*0.5 - 1.05` on every street and arterial
   * in the city. On a 7.2 m two-lane street the running lane centre is 1.65 m
   * out from the crown and the parked car sat at 2.55 +/- 1.0 m — parked ON the
   * lane, all the way across it. `traffic` measured ~200 heavy impacts per
   * simulated minute and had to write a static-obstruction swerve to survive us.
   * The slots also collided with each other: a 6.2 m pitch cannot hold a 7.2 m
   * truck, which is the 1.7 m of interpenetration `traffic/parking.js` logged.
   *
   * Now: only where `traffic` says a bay exists (it has already taken that lane
   * out of the drivable set), at the offset it publishes, and the pitch is the
   * length of the vehicle THIS slot will actually receive plus a manoeuvring
   * gap — so two slots cannot overlap however the types fall out.
   */
  _parking(edge, side, s0, s1, seed, style, bx, out) {
    if (!this.parksOn(edge, side)) return;
    const lat = this._bayOffset(edge, side);
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    // Keep clear of the junction: a car standing in the throat of a turn is the
    // one place a parked car actually does block traffic that has nowhere else
    // to go.
    const a0 = Math.max(s0, 0) + BAY_END_CLEAR;
    const a1 = Math.min(s1, edge.len) - BAY_END_CLEAR;
    if (a1 - a0 < 8) return;
    const occupancy = 0.34 + style.meters * 0.34 + style.litter * 0.12;
    const along = Math.atan2(edge.dx, edge.dz);

    let s = a0 + hash3i(seed, 0, 200) * 3.5;
    let i = 0;
    while (i < 40) {
      i++;
      const kind = pickKerbType(hash3i(seed, i, 206));
      const step = kind.L + BAY_GAP;
      if (s + kind.L > a1) break;
      const cs = s + kind.L * 0.5;
      if (hash3i(seed, i, 201) <= occupancy) {
        const t = cs / edge.len;
        const x = na.x + (nb.x - na.x) * t - edge.dz * lat;
        const z = na.z + (nb.z - na.z) * t + edge.dx * lat;
        const y = na.y + (nb.y - na.y) * t;
        if (this._in(bx, x, z) && this._clearsLanes(x, y, z, 1.15)) {
          out.push({
            x, y, z,
            yaw: along + (side > 0 ? Math.PI : 0) + (hash3i(seed, i, 203) - 0.5) * 0.07,
            type: kind.t,
            half: kind.L * 0.5,
            src: 'kerb',
            seed: (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
          });
        }
      }
      s += step;
    }
  }

  /**
   * OFF-STREET PARKING. Two-lane streets cannot carry a parked car and an empty
   * kerb reads as a film set, so the density has to come from somewhere that is
   * not the running lane: the surface car parks `world` marks as `kind: 'lot'`.
   * Bays run in rows off the lot's long axis, which is what a real lot does and
   * what makes a row of cars read as parked rather than abandoned.
   */
  _lotParking(lot, seed, out, bx) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    if (b.w < 12 || b.d < 12) return;
    // Rows run along the lot's longer axis; bays are perpendicular to them.
    const alongX = b.w >= b.d;
    const rowPitch = 6.4;
    const bayPitch = 2.85;
    const rows = Math.floor((alongX ? b.d : b.w) / rowPitch);
    const bays = Math.floor((alongX ? b.w : b.d) / bayPitch);
    /**
     * A car in a bay stands ACROSS its row, never along it. Bays are 2.85 m
     * apart and a sedan is 4.8 m long: get this ninety degrees wrong and every
     * car in the lot is buried in the two beside it.
     */
    const yaw0 = alongX ? 0 : Math.PI / 2;
    const occupancy = 0.34 + hash3i(seed, 0, 301) * 0.28;
    for (let r = 0; r < rows; r++) {
      const u = (alongX ? b.z0 : b.x0) + (r + 0.5) * rowPitch;
      const flip = r % 2 === 0 ? 0 : Math.PI;
      for (let k = 0; k < bays; k++) {
        if (hash3i(seed, r * 41 + k, 302) > occupancy) continue;
        const v = (alongX ? b.x0 : b.z0) + (k + 0.5) * bayPitch;
        const x = alongX ? v : u;
        const z = alongX ? u : v;
        if (!pointInPoly(x, z, foot, 3.4)) continue;
        if (!this._in(bx, x, z)) continue;
        if (this.world.isWater?.(x, z)) continue;
        /**
         * A lot polygon can run right up to — and sometimes over — the kerb, so
         * "inside the lot" is not the same as "off the road". Ask the graph.
         * Eight bays in the first pass landed 2 m from an arterial crown.
         */
        const kind = pickKerbType(hash3i(seed, r * 41 + k, 303));
        if (kind.L > 6) continue; // a box truck does not fit a 5.5 m bay
        const y = this.world.heightAt(x, z);
        // A bay stands ACROSS its row, so it is its LENGTH that reaches toward
        // whatever road the lot happens to back onto.
        if (!this._clearsLanes(x, y, z, kind.L * 0.5 + 0.4)) continue;
        out.push({
          x, y, z,
          yaw: yaw0 + flip + (hash3i(seed, r * 41 + k, 304) - 0.5) * 0.09,
          type: kind.t,
          half: kind.L * 0.5,
          src: 'lot',
          seed: (seed ^ Math.imul(r * 41 + k + 1, 0x85ebca6b)) >>> 0,
        });
      }
    }
  }
}

/* ---------------------------------------------------------------- utils -- */

function polyBounds(poly) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

function pointInPoly(x, z, poly, margin = 0) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  if (!inside || margin <= 0) return inside;
  // crude erosion: stay `margin` away from every edge
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a[0] + dx * t - x;
    const qz = a[1] + dz * t - z;
    if (qx * qx + qz * qz < margin * margin) return false;
  }
  return true;
}

export { polyBounds, pointInPoly };
