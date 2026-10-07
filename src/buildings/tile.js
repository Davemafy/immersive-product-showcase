import * as THREE from 'three';
import { Accum, trs } from './geom.js';
import { SURFACES, TRANSPARENT, surfaceTagOf } from './palette.js';

/**
 * BUILDINGS — the per-tile assembler.
 *
 * Every generator writes into one of these rather than touching the scene,
 * which is how a tile holding thirty buildings and ~40 000 pieces of facade
 * furniture comes out as ~20 draw calls:
 *
 *   add(key, geo, matrix, opts)   merge into this tile's static batch for `key`
 *   proto(id, geo, key, opts)     declare a globally shared instance prototype
 *   put(id, x,y,z, ry, s, masks)  add one instance of it to this tile
 *   box(surface, ...)             an axis-aligned collision proxy
 *   mount(rec)                    publish a sign mount point (contract below)
 *
 * Collision is authored separately from the visual mesh: proxies are boxes
 * generated from the same numbers that built the geometry, so a doorway is a
 * real hole in the hull and the BVH stays in the thousands of triangles instead
 * of chewing through every window chamfer.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SIGN MOUNT CONTRACT — this comment IS the contract.
 * ─────────────────────────────────────────────────────────────────────────────
 * A sign is not facade geometry and it is not authored here. What the facade
 * kit owes the signage layer is the one thing only the facade knows: WHERE a
 * sign can legally go and how big it may be. So every built facade publishes
 * its mount points, and `src/props/kit_sign.js` (which runs after this) reads
 * them and decides what the sign SAYS.
 *
 * WHERE THEY LIVE. `TileBuilder.build()` writes the array onto the returned
 * group:
 *
 *     rec.group.userData.owSignMounts   // Array<Mount>, possibly empty
 *
 * `rec` here is what `build()` returns (`{ group, handles, ... }`), and the
 * group is the node the buildings system parents under the tile. A consumer
 * that does not know which node it has can `traverse` and take every
 * `userData.owSignMounts` it finds; the array is plain data, owns nothing, and
 * is dropped with the tile.
 *
 * WHICH TILES CARRY THEM. **LOD0 (near) tiles only.** `buildLotLod` is the
 * massing mesh — it has no shopfront, no fascia and no party wall to hang a
 * sign on, so it publishes nothing and a far tile's array is empty. A consumer
 * must therefore key its signs off the NEAR tile's lifetime and drop them when
 * the near mesh is released (`releaseTile`), exactly as the near mesh itself is.
 *
 * THE RECORD. Every field is world space, metres, and already has the kerb
 * guard applied — a mount standing in a live carriageway is never published.
 *
 *   {
 *     kind : 'fascia' | 'blade' | 'billboard' | 'wall'
 *     x,y,z: the CENTRE of the mount face, on the face itself. A sign is drawn
 *            in front of it, i.e. displaced along +n by its own thickness.
 *     ry   : yaw, radians. `trs(m, x, y, z, ry, w, h, 1)` (see geom.js) builds
 *            a basis whose +X runs along the mount's width, +Y is up and +Z is
 *            the outward normal — the same convention `wallBasis` publishes, so
 *            a sign placed with it faces the street without further thought.
 *     nx,nz: the same outward normal as a unit vector, for consumers that would
 *            rather do their own trigonometry. ny is always 0: every mount face
 *            in this city is vertical.
 *     w,h  : the USABLE field, metres. A sign wider or taller than this overlaps
 *            a window, a pier or the next business, so it is the consumer's
 *            budget, not a suggestion.
 *     arch : the archetype that published it ('rowhouse', 'mill', 'tower', ...)
 *     era  : the massing era for tall buildings ('deco' | 'midcentury' |
 *            'modern' | 'postmodern'), else 'plain'.
 *     front: true if this elevation faces the street.
 *     seed : a stable 32-bit integer derived from the mount's own position, so
 *            a consumer can pick its content deterministically without carrying
 *            an RNG stream across a subsystem boundary (rule 4).
 *   }
 *
 * THE FOUR KINDS, and what each is FOR:
 *
 *   'fascia'    the signboard band over one shopfront unit. `w` is the unit's
 *               frontage between its pilasters, `h` the band depth. This is the
 *               named-business mount: DeCarlo Body Shop, Rustbelt Respray.
 *   'blade'     a projecting sign at right angles to the street, anchored at
 *               the fascia's top corner. `w` is the maximum PROJECTION off the
 *               wall and `h` the maximum drop. The sign's own plane is
 *               perpendicular to `n` — this normal is the wall's, not the
 *               board's, because what the mount pins is the bracket.
 *   'billboard' a rooftop hoarding anchor on a tall flat-roofed archetype.
 *               x,y,z sit on the roof deck at the parapet line; a board stands
 *               UP from there, so `h` is headroom above the deck, not a centred
 *               half-height. Only published where the deck is deep enough to
 *               carry the back legs.
 *   'wall'      a blank-flank field: ghost-sign territory. Published only on
 *               windowless party walls, inset from the arrises, so a painted
 *               sign never runs off the corner of the building.
 *
 * WHAT IS NOT PROMISED. Mounts are not deduplicated against each other across
 * buildings, they are not sorted, and two mounts on the same elevation may
 * overlap in Y if a blade and a fascia share a corner — that pair is meant to
 * be resolved by whoever draws them. Nothing here reserves the space.
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
/**
 * Instance groups smaller than this are merged into the tile's static batch
 * instead of becoming their own InstancedMesh. See build().
 */
const MERGE_BELOW = 48;
/**
 * Triangles a tile's NON-CASTING half of a surface must reach before it is
 * worth emitting as its own batch instead of being folded back in and left to
 * cast. See the fold in `build()`.
 */
const NOCAST_MIN_TRIS = 3000;
/**
 * Ground-junction AO bake. See `TileBuilder._bakeGroundAo`.
 *
 * `AO_HEIGHT` is a SKIRTING HEIGHT, not a guess: a metre and a bit is the
 * scale of the ambient shadow a wall throws onto the ground it stands on under
 * an overcast sky, and it is the height at which a shopfront's own plinth
 * stops being read as part of the ground. Past ~2 m the term stops looking
 * like a junction and starts looking like soot on the lower storey, which is
 * the same failure mode `render`'s `aoRadius` hits at 4 m.
 */
const AO_CELL = 2.0;
const AO_GRID_MAX = 128;
const AO_HEIGHT = 1.25;
const AO_STRENGTH = 0.7;
/** How much of the term an UP-facing face keeps. A plinth top is not a corner. */
const AO_UPFACE_CUT = 0.8;
/**
 * Instances get less than merged geometry, and deliberately: the mask is
 * constant over the whole prototype, so a 3 m lamp column would carry its
 * base's occlusion all the way to the lantern. The value is what a small
 * object (a bin, a bollard, a hydrant) can take without going flat.
 */
const AO_INSTANCE_SCALE = 0.55;
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SURFACES THAT ARE NEVER SHADOW CASTERS, whatever they are merged with.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every one of these is an INTERIOR seen through glazing — the cardboard room
 * behind a window (`Kit.room`), the floor plate behind a curtain wall, the dark
 * box behind a transom, the lit deck of a setback. Not one of them is ever
 * outside the building's own hull, so the shadow it casts is cast onto the
 * inside of a wall that is already fully occluded by the wall itself.
 *
 * IT IS A CORRECTNESS FIX BEFORE IT IS A SAVING, and the defect it closes is
 * in `build()` below. `Kit.room`, `Kit.blind`, `Kit.shopFit` and `Kit.signFace`
 * are all declared `castShadow: false` at the prototype, and that flag was
 * honoured only while the piece stayed an `InstancedMesh`. Below `MERGE_BELOW`
 * instances the group is folded into the tile's static batch — which is most
 * groups on most tiles — and the fold read `p.key` and `p.geo` and nothing
 * else, so the flag was dropped on the floor and the room boxes started casting
 * again. MEASURED on the settled night frame: 43 `room_lit_warm` batches, all
 * 43 submitted to every cascade.
 *
 * Named surfaces rather than a per-piece flag because a whole KEY costs nothing
 * to exclude: the batch already exists, it is simply not a caster, so this is
 * the only shadow saving in the file that does not buy itself a second draw
 * call. See `_noCast` for the pieces that do need one.
 */
const NEVER_CASTS = new Set([
  'room_dark', 'room_mid', 'room_lit_warm', 'room_lit_cool',
  /**
   * The OPAQUE glazing keys, which are a window plane and never a silhouette.
   * Checked at every site that emits them before they went in here:
   *
   *   `bandFloor`          set back `min(0.26, t*0.62)` behind piers and
   *                        spandrels that reach the full outer face. The piers
   *                        cast the reveal shadow; the pane behind them cannot
   *                        cast anything they have not already cast.
   *   `buildLotLod`        2 cm proud of the massing face, and it only ever
   *                        draws past 130 m. That file's own comment is the
   *                        argument: "the cascades cannot resolve 19 cm at
   *                        400 m" — so 2 cm resolves as acne, not as a window.
   *   deco crown band      `polyInset(poly, 0.22)`, i.e. recessed into the
   *                        crown it is cut out of.
   *   far-LOD roof plant   a box on a penthouse roof past the near ring,
   *                        borrowing this key for batch economy.
   *
   * MEASURED on the settled night frame before this: 34 batches and 88 000
   * triangles, submitted to every cascade, for a shadow that another surface
   * was already casting in every one of those four cases.
   */
  'glass_solid', 'glass_solid_warm',
]);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Prototype geometry is shared by every tile in the city — a window unit built
 * once is the same forty thousand times. Instance MATRICES are per tile, so a
 * tile can be freed without touching the library.
 */
export class ProtoLibrary {
  constructor(materials) {
    this.materials = materials;
    this.protos = new Map(); // id -> { geo, key, castShadow, noPrepass }
    this._mats = new Map(); // surface key -> THREE.Material
    this._geoCache = new Map();
  }

  mat(key) {
    let m = this._mats.get(key);
    if (m) return m;
    const def = SURFACES[key];
    if (!def) {
      console.warn(`[buildings] unknown surface "${key}"`);
      return this.mat('concrete_wall');
    }
    m = this.materials.get(def.name, def.opts);
    if (TRANSPARENT.has(key)) {
      m.userData.owBuildingGlass = true;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
    }
    this._mats.set(key, m);
    return m;
  }

  /** Cache one-off geometry that several generators want (a step, a bracket). */
  cache(id, factory) {
    let g = this._geoCache.get(id);
    if (!g) {
      g = factory();
      this._geoCache.set(id, g);
    }
    return g;
  }

  /** Declare (once) an instanced prototype. Returns the id. */
  proto(id, factory, key, opts = {}) {
    if (this.protos.has(id)) return id;
    const geo = factory();
    geo.computeBoundingSphere();
    this.protos.set(id, {
      id,
      geo,
      key,
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
      noPrepass: !!opts.noPrepass || TRANSPARENT.has(key),
      noShadow: !!opts.noShadow || TRANSPARENT.has(key),
      tris: (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3,
    });
    return id;
  }

  has(id) {
    return this.protos.has(id);
  }

  dispose() {
    for (const p of this.protos.values()) p.geo.dispose();
    for (const g of this._geoCache.values()) g.dispose();
    this.protos.clear();
    this._geoCache.clear();
    this._mats.clear();
  }
}

export class TileBuilder {
  /**
   * `?owNoTileAo=1` — the negative control for the ground-junction bake. Read
   * once at module scope so the per-tile path costs one property read; benches
   * and the node-only probes boot with no `location` at all.
   */
  static noGroundAo =
    typeof location !== 'undefined' && /[?&]owNoTileAo=1/.test(location.search);

  /**
   * `?owKitCasters=1` — the NEGATIVE CONTROL for the shadow-caster routing:
   * every merged batch casts again, exactly as it did before `NEVER_CASTS` and
   * `_noCast` existed, and the authored `castShadow: false` on a folded
   * prototype is dropped again. Nothing else changes — same geometry, same
   * batches, same RNG — so `perfcheck --ab='.|owKitCasters=1,.'` measures the
   * routing and not the machine. Same convention as `?owNoTileAo=1`.
   */
  static keepKitCasters =
    typeof location !== 'undefined' && /[?&]owKitCasters=1/.test(location.search);

  /**
   * Instance groups smaller than this are merged into the tile's static batch
   * instead of becoming their own `InstancedMesh`. A STATIC rather than the
   * module constant it was, for one reason: `kitprobe`'s streamed-tile tier
   * needs to run its own arm with merging off, and a threshold a probe cannot
   * reach is an invariant with no negative control. See `MERGE_BELOW`.
   */
  static mergeBelow = MERGE_BELOW;

  constructor(lib, name = 'tile') {
    this.lib = lib;
    this.name = name;
    this._static = new Map(); // surface key -> Accum
    this._detail = new Map(); // surface key -> Accum, hosted under a THREE.LOD
    this._noCast = new Map(); // surface key -> Accum, emitted with castShadow off
    this._inst = new Map(); // proto id -> { m: Matrix4[], c: masks[] }
    this._collide = new Map(); // surface tag -> Accum
    this.lights = [];
    /** Published sign mount points. See THE SIGN MOUNT CONTRACT at the top. */
    this.mounts = [];
    /**
     * Vertex ranges that are NOT ground reference. See `_bakeGroundAo`.
     * Map<Accum, number[]> of [v0, v1) pairs; null until something asks.
     */
    this._noRef = null;
    this.stats = {
      tris: 0,
      instTris: 0,
      instances: 0,
      draws: 0,
      keptOut: 0,
      groundAo: 0,
      mounts: 0,
    };
    /** See `setKeepOut` and `BuildingSystem._keepOutFor`. */
    this._keepOut = null;
  }

  /**
   * Refuse any piece that would stand on a drivable carriageway.
   *
   * Without this, roads end up undrivable. `_clipToStreets` trims
   * the LOT, but everything hung off the building afterwards — plinth courses,
   * silos, pipe-rack legs, stoops, and every part of every hand-authored
   * landmark — was placed with nothing checking it. This is the one chokepoint
   * all of that passes through, so it is where the check belongs: the caller
   * sets a predicate for the duration of one building and every `add`, `place`
   * and collision `box` is measured against it.
   *
   * `fn(bbox, matrix, geo) -> true to drop`. Null disables. Cleared per lot by
   * the caller, never sticky.
   */
  setKeepOut(fn) {
    this._keepOut = fn ?? null;
    this._gone = null;
    return this;
  }

  /**
   * NOTHING THE GUARD REMOVES MAY LEAVE SOMETHING HANGING IN THE AIR.
   *
   * The first cut dropped pieces individually and it produced a defect worse
   * than the one it fixed. A blast furnace's stove is one 40 m cylinder with a
   * separate cap cylinder on top of it; a mill stack is the same. Drop the
   * body — because its base is standing in a street — and the cap stays exactly
   * where it was, forty metres up, with nothing under it. The `mill` capture
   * came back with four rust-coloured funnels floating in the sky.
   *
   * So every removal is remembered as an XZ footprint and a top height, and any
   * later piece that sits ON one of those and nowhere else goes with it. The
   * result is a missing stove rather than a levitating one, which is the right
   * way round: a gap reads as "there is a street through here", and a floating
   * cone reads as a broken engine.
   *
   * The list is per building (cleared by `setKeepOut`) and never more than a few
   * dozen entries, so this is a handful of comparisons per piece.
   */
  _orphaned(x0, z0, x1, z1, y0) {
    const g = this._gone;
    if (!g) return false;
    for (let i = 0; i < g.length; i += 5) {
      // Wholly over the removed piece's plan, and starting at or above its top.
      if (x0 >= g[i] - 0.4 && x1 <= g[i + 2] + 0.4 &&
          z0 >= g[i + 1] - 0.4 && z1 <= g[i + 3] + 0.4 &&
          y0 >= g[i + 4] - 1.0) return true;
    }
    return false;
  }

  _drop(geo, matrix) {
    const f = this._keepOut;
    if (!f || !geo) return false;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    // World-space extent of this piece, needed by both the guard and the
    // orphan test.
    const lo = bb.min;
    const hi = bb.max;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
      if (matrix) _v.applyMatrix4(matrix);
      if (_v.x < x0) x0 = _v.x;
      if (_v.x > x1) x1 = _v.x;
      if (_v.y < y0) y0 = _v.y;
      if (_v.y > y1) y1 = _v.y;
      if (_v.z < z0) z0 = _v.z;
      if (_v.z > z1) z1 = _v.z;
    }
    if (!this._orphaned(x0, z0, x1, z1, y0) && !f(bb, matrix, geo)) return false;
    (this._gone ??= []).push(x0, z0, x1, z1, y1);
    this.stats.keptOut++;
    return true;
  }

  // ------------------------------------------------------------- static ---
  /**
   * `opts.detail` routes the geometry into the tile's DETAIL bucket, which is
   * hosted under a `THREE.LOD` whose far level is empty (see build()). Use it
   * for anything that stops resolving at range — facade banding, reveal piers,
   * sill courses. The silhouette must never go in here: the far level being
   * empty means "this disappears", and a silhouette that changes shape at a
   * distance threshold is worse than no LOD at all.
   *
   * `opts.buried === true` declares geometry that is authored BELOW GRADE on
   * purpose — today that is exactly one thing, the terraced foundation apron in
   * `archetypes.js`. It has two consequences and they are both correctness, not
   * economy:
   *
   *  1. IT IS NOT GROUND REFERENCE. The AO junction bake reads the minimum
   *     emitted vertex Y per cell to find the ground (`_bakeGroundAo`). An
   *     apron reaching nine metres down a hillside would become that minimum,
   *     and every wall in the cell would lose its junction darkening. Buried
   *     geometry still RECEIVES the term; it is only refused a vote on where
   *     the ground is.
   *  2. THE KERB GUARD DOES NOT APPLY. A foundation course carries no
   *     collision and is under the road surface, so it cannot obstruct a
   *     carriageway — but it is WIDER in plan than the building standing on it,
   *     so letting the guard delete one would file its footprint in `_gone`
   *     and orphan the entire building above it. That is not a hypothetical:
   *     `buildLotLod` lays the foundation before the crown.
   *
   * `opts.noShadow === true` declares geometry whose CAST shadow is not worth a
   * cascade — a dentil tooth, a modillion, a transom bar, an escape landing.
   * It is routed into a parallel accumulator for the same surface, emitted with
   * `castShadow = false`, and that is not free: a key that carries both kinds
   * costs one extra merged batch on the tiles that carry both. Use it only
   * where the piece cannot resolve in the shadow map at ANY cascade — the same
   * argument the DETAIL bucket's `noShadow` already makes, and the same
   * measurement behind it (a 13 cm block against a 0.1-0.5 m cascade texel
   * lands inside its own depth bias and self-shadows in a stipple). A silhouette
   * never goes in here; a parapet coping is silhouette and a dentil is not.
   */
  add(key, geo, matrix = null, opts = null) {
    const buried = opts?.buried === true;
    if (this._keepOut && !buried && this._drop(geo, matrix)) return this;
    const bucket =
      opts?.detail === true
        ? this._detail
        : opts?.noShadow === true && !TileBuilder.keepKitCasters
          ? this._noCast
          : this._static;
    let a = bucket.get(key);
    if (!a) bucket.set(key, (a = new Accum(`${this.name}:${key}`)));
    const v0 = buried ? a.verts : -1;
    a.add(geo, matrix, opts);
    if (v0 >= 0 && a.verts > v0) {
      const m = (this._noRef ??= new Map());
      let r = m.get(a);
      if (!r) m.set(a, (r = []));
      r.push(v0, a.verts);
    }
    return this;
  }

  /**
   * Publish one sign mount point. THE SIGN MOUNT CONTRACT is documented at the
   * top of this file and that comment is normative; this is the plumbing.
   *
   * The kerb guard applies, for the same reason it applies to geometry: a shop
   * fascia on a wall the guard has just deleted is a sign hanging over a live
   * carriageway with no building behind it. `_keepOut` is measured against a
   * box the size of the mount's own field rather than a point, so a mount whose
   * CENTRE clears the kerb but whose board would not is refused too.
   */
  mount(rec) {
    if (!rec) return this;
    if (this._keepOut) {
      const rx = Math.max(0.5, (rec.w ?? 1) * 0.5);
      const ry = Math.max(0.5, (rec.h ?? 1) * 0.5);
      _box.min.set(rec.x - rx, rec.y - ry, rec.z - rx);
      _box.max.set(rec.x + rx, rec.y + ry, rec.z + rx);
      if (this._keepOut(_box, null, null)) return this;
    }
    // A stable per-mount stream seed. Position only: the same wall rebuilt by
    // the same tile gets the same signs back, and no RNG crosses the boundary.
    const h =
      (Math.imul(Math.round(rec.x * 16) | 0, 0x27d4eb2d) ^
        Math.imul(Math.round(rec.y * 16) | 0, 0x165667b1) ^
        Math.imul(Math.round(rec.z * 16) | 0, 0x9e3779b1)) >>>
      0;
    rec.seed = h;
    rec.ny = 0;
    this.mounts.push(rec);
    return this;
  }

  /** Merge a transformed box-like geometry. */
  addAt(key, geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, opts = null) {
    return this.add(key, geo, trs(_m, x, y, z, ry, sx, sy, sz), opts);
  }

  /** Merge then free — for a geometry generated for exactly one placement. */
  addOnce(key, geo, matrix = null, opts = null) {
    this.add(key, geo, matrix, opts);
    geo.dispose();
    return this;
  }

  // ---------------------------------------------------------- instanced ---
  place(id, matrix, masks = null) {
    if (this._keepOut) {
      const p = this.lib.protos.get(id);
      if (p && this._drop(p.geo, matrix)) return this;
    }
    let e = this._inst.get(id);
    if (!e) this._inst.set(id, (e = { id, m: [], c: [] }));
    e.m.push(matrix.clone());
    e.c.push(masks ?? null);
    return this;
  }

  put(id, x, y, z, ry = 0, s = 1, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, s, s, s, rx, rz);
    return this.place(id, _m, masks);
  }

  putS(id, x, y, z, ry, sx, sy, sz, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, sx, sy, sz, rx, rz);
    return this.place(id, _m, masks);
  }

  /**
   * Place using a caller-supplied basis matrix (facade space -> world).
   * `masks` is the per-instance [wear, grime, ao] scale — no two windows in a
   * street are equally dirty, and an instance cloud with one mask value is the
   * loudest "this is a kit on a grid" tell there is.
   */
  putM(id, basis, lx, ly, lz, ry = 0, sx = 1, sy = sx, sz = sx, masks = null) {
    trs(_m, lx, ly, lz, ry, sx, sy, sz);
    _m.premultiply(basis);
    return this.place(id, _m, masks);
  }

  // ---------------------------------------------------------- collision ---
  box(surface, cx, cy, cz, sx, sy, sz, ry = 0) {
    if (this._keepOut && this._drop(UNIT_BOX, trs(_m, cx, cy, cz, ry, sx, sy, sz))) return this;
    let a = this._collide.get(surface);
    if (!a) this._collide.set(surface, (a = new Accum(`col:${surface}`)));
    a.add(UNIT_BOX, trs(_m, cx, cy, cz, ry, sx, sy, sz));
    return this;
  }

  /** A wall slab given in panel space, placed through the panel's basis. */
  slabBox(surface, basis, x, y, w, h, t) {
    trs(_m, x, y, t * 0.5, 0, w, h, t);
    _m.premultiply(basis);
    if (this._keepOut && this._drop(UNIT_BOX, _m)) return this;
    let a = this._collide.get(surface);
    if (!a) this._collide.set(surface, (a = new Accum(`col:${surface}`)));
    a.add(UNIT_BOX, _m);
    return this;
  }

  // --------------------------------------------------------- ground AO ---
  /**
   * ──────────────────────────────────────────────────────────────────────────
   * THE WALL/GROUND JUNCTION, BAKED INTO THE VERTEX AO MASK
   * ──────────────────────────────────────────────────────────────────────────
   * Two blind critic panels reported the same defect off `detail.png`: "no
   * visible AO at wall/ground junctions", buildings meeting the pavement as
   * two butted planes with no corner between them.
   *
   * MEASURED on `detail.png` before this existed, a 12 px column stepped down
   * through the retaining wall onto the plaza it stands on (linear x255): the
   * wall face reads 13.1-14.4 all the way to the seam and the plaza reads
   * 44-47 from 20 px out to the bottom of the frame. There is a transition
   * because the two surfaces are different materials, and there is no corner:
   * neither side darkens toward the other.
   *
   * Why the screen-space passes cannot close it. GTAO's radius is 2.6 m, sized
   * for architecture, and it does resolve this seam — measured 0.55 visibility
   * at a wall/pavement junction. But its march ceiling is a FRACTION OF THE
   * RENDER HEIGHT, so the metres it reaches shrink with distance and the seam
   * fades out exactly as a street recedes; and `render/contact.js` multiplies
   * onto the SUN term only, which under the overcast both review shots are
   * lit by is worth nothing at all. A bake has neither property: it is in the
   * geometry, so it is resolution-independent, distance-independent, weather-
   * independent and free at runtime.
   *
   * WHERE THE GROUND COMES FROM, and why it is not `world.heightAt`. Rule 12:
   * the ground is read off the EMITTED GEOMETRY — a coarse grid of the minimum
   * vertex Y this tile actually produced in each cell, dilated 3x3 — never off
   * the terrain field the placement arithmetic used. A plinth course sunk into
   * a slope, a stoop, a loading dock and a landmark hand-placed 40 cm proud of
   * the terrain are all things the placement input does not know about and the
   * emitted vertices do. It also keeps `buildings` from re-deriving a fact
   * `world` owns (the spatial form of rule 12), because it is not asking
   * `world` anything.
   *
   * The orientation weight is what stops this reading as dirt: an UP-facing
   * face at ground level is a plinth top or a pavement slab, not a corner, and
   * darkening it produces a grey band across the ground rather than a junction.
   * Vertical and down-facing geometry gets the full term.
   *
   * `?owNoTileAo=1` is the negative control — see `src/render/aoprobe.mjs`.
   */
  _bakeGroundAo() {
    if (TileBuilder.noGroundAo) return;
    const buckets = [];
    for (const a of this._static.values()) if (!a.empty) buckets.push(a);
    for (const a of this._detail.values()) if (!a.empty) buckets.push(a);
    // Not casting a shadow has nothing to do with receiving one: a dentil
    // course still sits in the ground-junction bake's world like anything else,
    // and skipping it here would also cost it its vote on where the ground is.
    for (const a of this._noCast.values()) if (!a.empty) buckets.push(a);
    if (buckets.length === 0 && this._inst.size === 0) return;

    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const a of buckets) {
      const p = a.pos;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < x0) x0 = p[i];
        if (p[i] > x1) x1 = p[i];
        if (p[i + 2] < z0) z0 = p[i + 2];
        if (p[i + 2] > z1) z1 = p[i + 2];
      }
    }
    if (!Number.isFinite(x0)) return;

    // The grid is bounded as well as sized: a landmark whose pieces sprawl
    // across a whole district must not allocate a million cells.
    const nx = Math.min(AO_GRID_MAX, Math.max(1, Math.ceil((x1 - x0) / AO_CELL) + 1));
    const nz = Math.min(AO_GRID_MAX, Math.max(1, Math.ceil((z1 - z0) / AO_CELL) + 1));
    const sx = nx > 1 ? (x1 - x0) / (nx - 1) : AO_CELL;
    const sz = nz > 1 ? (z1 - z0) / (nz - 1) : AO_CELL;
    const raw = new Float32Array(nx * nz).fill(Infinity);
    const cellOf = (x, z) => {
      const i = Math.min(nx - 1, Math.max(0, Math.round((x - x0) / sx)));
      const k = Math.min(nz - 1, Math.max(0, Math.round((z - z0) / sz)));
      return k * nx + i;
    };

    /**
     * `buried: true` geometry is skipped HERE and only here — it may not lower
     * the ground, but it is still weathered by it. Built as a byte mask
     * per accumulator rather than tested against the range list per vertex: a
     * dense tile has a hundred thousand vertices and a hundred ranges, and the
     * product of those two numbers is not a per-vertex test anyone should pay.
     */
    const noRef = this._noRef;
    for (const a of buckets) {
      const p = a.pos;
      let mask = null;
      const ranges = noRef?.get(a);
      if (ranges) {
        mask = new Uint8Array(a.verts);
        for (let r = 0; r < ranges.length; r += 2) mask.fill(1, ranges[r], ranges[r + 1]);
      }
      for (let i = 0, v = 0; i < p.length; i += 3, v++) {
        if (mask && mask[v]) continue;
        const c = cellOf(p[i], p[i + 2]);
        if (p[i + 1] < raw[c]) raw[c] = p[i + 1];
      }
    }
    // 3x3 minimum. A wall standing at the top of a kerb has its own base a few
    // centimetres above the pavement in the next cell; without the dilation
    // that step is read as height and the junction loses its darkening on the
    // one side of the building that is uphill.
    const gnd = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        let m = Infinity;
        for (let dk = -1; dk <= 1; dk++) {
          const kk = k + dk;
          if (kk < 0 || kk >= nz) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            const v = raw[kk * nx + ii];
            if (v < m) m = v;
          }
        }
        gnd[k * nx + i] = m;
      }
    }

    let touched = 0;
    for (const a of buckets) {
      const p = a.pos;
      const n = a.nrm;
      const col = a.col;
      for (let i = 0, v = 0; i < p.length; i += 3, v += 3) {
        const g = gnd[cellOf(p[i], p[i + 2])];
        if (!Number.isFinite(g)) continue;
        const h = p[i + 1] - g;
        if (h < -0.05 || h > AO_HEIGHT) continue;
        let t = 1 - Math.max(0, h) / AO_HEIGHT;
        t *= t;
        const w = 1 - Math.max(0, n[v + 1]) * AO_UPFACE_CUT;
        const ao = AO_STRENGTH * t * w;
        if (ao > col[v + 2]) {
          col[v + 2] = ao > 1 ? 1 : ao;
          touched++;
        }
      }
    }

    /**
     * Instanced placements carry the same term as a PER-INSTANCE mask rather
     * than per vertex — the prototype geometry is shared by the whole city, so
     * a bin that stands on this pavement cannot be allowed to darken the same
     * bin on a roof three tiles away. `place()` already carries a masks slot
     * for exactly this reason (no two windows in a street are equally dirty).
     */
    for (const [id, e] of this._inst) {
      const proto = this.lib.protos.get(id);
      if (!proto || e.m.length === 0) continue;
      for (let i = 0; i < e.m.length; i++) {
        const el = e.m[i].elements;
        const g = gnd[cellOf(el[12], el[14])];
        if (!Number.isFinite(g)) continue;
        const h = el[13] - g;
        if (h < -0.05 || h > AO_HEIGHT) continue;
        let t = 1 - Math.max(0, h) / AO_HEIGHT;
        t *= t;
        const ao = AO_STRENGTH * AO_INSTANCE_SCALE * t;
        const mk = e.c[i] ?? [0, 0, 0];
        if (ao > mk[2]) {
          mk[2] = ao > 1 ? 1 : ao;
          e.c[i] = mk;
          touched++;
        }
      }
    }
    this.stats.groundAo = touched;
  }

  // ----------------------------------------------------------- finalize ---
  /**
   * Build the meshes into a Group. Nothing is added to the scene here — the
   * system decides when a tile becomes visible.
   */
  build(physics, opts = {}) {
    const group = new THREE.Group();
    group.name = `buildings_${this.name}`;
    group.matrixAutoUpdate = false;
    const bounds = new THREE.Box3();
    bounds.makeEmpty();

    /**
     * The detail LOD host. `render` honours `THREE.LOD` natively and rescales
     * the level distances by `q.lodBias`, FOV and resolution, so the distance
     * below is authored for a 1080p / 60-degree frame (ARCHITECTURE.md, render
     * integration). The far level is an empty Group: past the threshold the
     * facade banding simply stops being submitted, and because the banding is
     * proud of a wall that is still there, the silhouette does not move.
     *
     * The merged geometry is in world space, so the LOD node is positioned at
     * the tile centre (three measures LOD distance from the node's own world
     * position, and a node parked at the origin would measure the distance to
     * the middle of the map) and the level group is counter-translated.
     */
    let lodNode = null;
    let detailHost = group;
    const lodDist = opts.lodDistance ?? 0;
    if (this._detail.size && lodDist > 0) {
      lodNode = new THREE.LOD();
      lodNode.name = `bl_${this.name}`;
      lodNode.autoUpdate = false;
      const near = new THREE.Group();
      near.name = `bld_${this.name}`;
      near.matrixAutoUpdate = false;
      const c = opts.lodCenter ?? [0, 0, 0];
      lodNode.position.set(c[0], c[1], c[2]);
      near.position.set(-c[0], -c[1], -c[2]);
      near.updateMatrix();
      lodNode.addLevel(near, 0);
      lodNode.addLevel(new THREE.Group(), lodDist);
      lodNode.updateMatrix();
      group.add(lodNode);
      detailHost = near;
    } else if (this._detail.size) {
      // No LOD requested — fold the detail buckets back into the static ones so
      // nothing is silently dropped.
      for (const [key, acc] of this._detail) {
        const cur = this._static.get(key);
        if (!cur) this._static.set(key, acc);
        else mergeAccum(cur, acc, this._noRef);
      }
      this._detail.clear();
    }

    /**
     * The long tail of instance groups is the real draw-call cost of a tile:
     * one areaway, two water towers and three satellite dishes are three more
     * draw calls EACH, again through the prepass and again through every shadow
     * cascade. Below the threshold it is strictly cheaper to bake them into the
     * static batch for the same material, which already exists. This alone
     * takes a dense downtown tile from ~47 batches to ~18.
     */
    for (const [, e] of this._inst) {
      const p = this.lib.protos.get(e.id);
      if (!p || e.m.length === 0 || e.m.length >= TileBuilder.mergeBelow) continue;
      /**
       * THE FOLD CARRIES THE PROTOTYPE'S SHADOW FLAG. It used to read `p.key`
       * and `p.geo` and nothing else, so `castShadow: false` — authored on
       * every room box, blind, shopfit and sign face in the kit — survived only
       * on the groups big enough to stay instanced. Below the threshold the
       * piece silently became a caster again, which is both a cost and a wrong
       * picture. See `NEVER_CASTS`.
       */
      const noShadow = p.castShadow === false || p.noShadow === true;
      for (let i = 0; i < e.m.length; i++) {
        const o = e.c[i] ? { masks: e.c[i] } : {};
        if (noShadow) o.noShadow = true;
        this.add(p.key, p.geo, e.m[i], o);
      }
      e.m.length = 0;
    }

    this._bakeGroundAo();

    /**
     * `noShadow` is set for the DETAIL bucket, and it is not a saving — it is a
     * correctness fix.
     *
     * The detail bucket is the mid-LOD's facade relief: glazing bands 2 cm
     * proud, spandrel courses 17 cm proud, piers 24 cm proud. It only ever
     * draws between the full-detail ring (~130 m) and `farDetailDist` (~520 m).
     * A CSM cascade covering 500 m has a texel a metre or more across, so a
     * 2 cm slab casting into it lands entirely inside its own depth bias and
     * self-shadows in a stipple. That is what shredded every mid-distance
     * elevation in the `skyline` capture into torn, dithered horizontal bands —
     * measured as "no mullion depth, flat plane with horizontal banding",
     * because a torn band is exactly what a flat painted stripe looks like.
     *
     * The relief still reads: the massing prism underneath it casts the
     * building's own shadow, and the recess is baked into the vertex AO mask
     * (see buildLotLod), which is resolution-independent.
     */
    const emit = (bucket, host, noShadow = false) => {
      for (const [key, acc] of bucket) {
        if (acc.empty) continue;
        const geo = acc.build();
        const mesh = new THREE.Mesh(geo, this.lib.mat(key));
        mesh.name = `b_${key}`;
        const dark = noShadow || (NEVER_CASTS.has(key) && !TileBuilder.keepKitCasters);
        mesh.castShadow = !TRANSPARENT.has(key) && !dark;
        mesh.receiveShadow = true;
        if (dark) mesh.userData.owNoShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.surface = surfaceTagOf(key);
        mesh.userData.collision = false;
        // Nothing a building is made of ever moves: skip the per-frame velocity
        // bookkeeping (ARCHITECTURE.md, render integration).
        mesh.userData.owStatic = true;
        if (TRANSPARENT.has(key)) {
          mesh.userData.owNoPrepass = true;
          mesh.userData.owNoShadow = true;
          mesh.renderOrder = 2;
        }
        mesh.updateMatrix();
        host.add(mesh);
        if (geo.boundingBox === null) geo.computeBoundingBox();
        if (geo.boundingBox) bounds.union(geo.boundingBox);
        this.stats.tris += geo.index.count / 3;
        this.stats.draws++;
      }
    };
    /**
     * A SECOND BATCH HAS TO BUY ITSELF.
     *
     * Splitting a surface into a casting and a non-casting half is not free:
     * the extra `Mesh` is submitted in the main pass, again in the depth
     * prepass, and it is one more object for the culler on every frame — call
     * it five extra submissions — against the triangles it keeps out of the
     * three cascades that would otherwise have drawn it. So the split only
     * happens where there is enough geometry to pay for it. A tile's whole
     * dentil course is 126 teeth at 12 triangles, which is not; a tile's fire
     * escapes are 180 000 triangles of slat grating, which very much is.
     *
     * Under the threshold the non-casting accumulator is folded straight back
     * into the casting one (`mergeAccum`, which carries the buried-geometry
     * ground-reference ranges with it) and those pieces go on casting — which
     * is the right answer, because at that size their contribution to a cascade
     * is a rounding error either way.
     */
    for (const [key, acc] of this._noCast) {
      if (acc.empty || acc.tris >= NOCAST_MIN_TRIS) continue;
      const cur = this._static.get(key);
      /**
       * A key with NOTHING casting on it is not a split at all — the batch has
       * to exist either way, so keeping it out of the cascades is free and the
       * threshold above must not apply to it. That is the whole of a sign face
       * (`neon_*`), a window blind, a shopfit: surfaces the kit only ever emits
       * as things that must not cast. Folding those back would have handed the
       * cascades a batch for two triangles of lit signboard.
       */
      if (!cur) continue;
      mergeAccum(cur, acc, this._noRef);
      this._noCast.delete(key);
    }
    emit(this._static, group);
    emit(this._detail, detailHost, true);
    // Hosted on the GROUP, not on the detail LOD: these pieces are still drawn
    // at every range, they simply are not submitted to a cascade.
    emit(this._noCast, group, true);

    for (const [id, e] of this._inst) {
      const p = this.lib.protos.get(id);
      if (!p || e.m.length === 0) continue;
      const im = new THREE.InstancedMesh(p.geo, this.lib.mat(p.key), e.m.length);
      im.name = `bi_${id}`;
      /**
       * `castShadow` IS NOT THE SWITCH, and writing it here was doing nothing.
       *
       * ARCHITECTURE.md: "`owNoShadow` is the ONLY shadow-caster switch" — the
       * cascades build their caster list from `isMesh && !userData.owNoShadow`
       * and never read `object.castShadow` (`src/render/index.js`, the culler's
       * `casts` term). So `p.castShadow === false`, which the kit sets on every
       * room box, blind, shopfit and sign face, has been suppressing nothing at
       * all: those pieces were submitted to every cascade, instanced or folded.
       * The flag is still written because it is the three-native spelling and a
       * probe may read it, but the line below it is what the renderer obeys.
       */
      const dark =
        !TileBuilder.keepKitCasters &&
        (p.castShadow === false || p.noShadow === true || NEVER_CASTS.has(p.key));
      im.castShadow = !dark;
      im.receiveShadow = p.receiveShadow;
      im.matrixAutoUpdate = false;
      im.userData.surface = surfaceTagOf(p.key);
      im.userData.collision = false;
      im.userData.owStatic = true;
      if (p.noPrepass) im.userData.owNoPrepass = true;
      if (dark) im.userData.owNoShadow = true;
      // Sorted last because it is TRANSPARENT, which is a different question
      // from whether it casts — see the two independent classifications in the
      // render culler.
      if (p.noShadow) im.renderOrder = 2;
      let needColor = false;
      for (let i = 0; i < e.c.length; i++) if (e.c[i]) needColor = true;
      if (needColor) {
        const arr = new Float32Array(e.m.length * 3);
        for (let i = 0; i < e.m.length; i++) {
          const mk = e.c[i] ?? [0, 0, 0];
          arr[i * 3] = mk[0];
          arr[i * 3 + 1] = mk[1];
          arr[i * 3 + 2] = mk[2];
        }
        im.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
      }
      for (let i = 0; i < e.m.length; i++) im.setMatrixAt(i, e.m[i]);
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.computeBoundingBox();
      im.updateMatrix();
      group.add(im);
      if (im.boundingBox) bounds.union(im.boundingBox);
      this.stats.draws++;
      this.stats.instances += e.m.length;
      this.stats.instTris += p.tris * e.m.length;
    }

    // --- collision ---
    const handles = [];
    const colMeshes = [];
    if (this._collide.size) {
      for (const [surface, acc] of this._collide) {
        if (acc.empty) continue;
        const geo = acc.build();
        const mesh = new THREE.Mesh(geo, INVISIBLE);
        mesh.name = `bcol_${surface}`;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        colMeshes.push(mesh);
        if (physics) {
          const h = physics.addStatic(mesh, surface);
          if (h >= 0) handles.push(h);
        }
      }
    }

    // The sign mount contract: published on the group, not returned separately,
    // so a consumer that only ever sees the scene graph can still find them.
    group.userData.owSignMounts = this.mounts;
    this.stats.mounts = this.mounts.length;

    group.updateMatrix();
    this._static.clear();
    this._detail.clear();
    this._noCast.clear();
    this._inst.clear();
    this._collide.clear();
    this._noRef = null;

    // A world-space sphere for the hierarchical cull. Derived from the geometry
    // that was actually emitted, so a tile carrying a 60 m tower is not culled
    // by a sphere sized for a two-storey terrace.
    let sphere = null;
    if (!bounds.isEmpty()) {
      sphere = new THREE.Sphere();
      bounds.getBoundingSphere(sphere);
    }
    return { group, handles, colMeshes, lod: lodNode, sphere, stats: this.stats };
  }
}

/**
 * Append one Accum onto another (used when a detail bucket has no LOD host).
 *
 * `noRef` is the ground-reference exclusion map; the source's ranges have to
 * move with its vertices or a foundation course would silently become ground
 * reference again on any tile built without an LOD host — which is every tile
 * a probe or the pre-warm builds.
 */
function mergeAccum(dst, src, noRef = null) {
  const base = dst.verts;
  const sr = noRef?.get(src);
  if (sr) {
    let dr = noRef.get(dst);
    if (!dr) noRef.set(dst, (dr = []));
    for (let i = 0; i < sr.length; i += 2) dr.push(base + sr[i], base + sr[i + 1]);
    noRef.delete(src);
  }
  for (let i = 0; i < src.pos.length; i++) dst.pos.push(src.pos[i]);
  for (let i = 0; i < src.nrm.length; i++) dst.nrm.push(src.nrm[i]);
  for (let i = 0; i < src.uv.length; i++) dst.uv.push(src.uv[i]);
  for (let i = 0; i < src.col.length; i++) dst.col.push(src.col[i]);
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(base + src.idx[i]);
  dst.verts += src.verts;
  dst.tris += src.tris;
}

/** Free a built tile: geometry, collision handles, scene attachment. */
export function releaseTile(rec, physics) {
  if (!rec) return;
  for (const h of rec.handles ?? []) physics?.removeStatic?.(h);
  for (const m of rec.colMeshes ?? []) m.geometry?.dispose();
  const g = rec.group;
  if (g) {
    // Sign mounts die with the tile that published them; see the contract note.
    if (g.userData) g.userData.owSignMounts = null;
    g.traverse((o) => {
      if (o.isInstancedMesh) {
        o.dispose?.();
        return; // prototype geometry is owned by the library
      }
      if (o.isMesh) o.geometry?.dispose();
    });
    g.parent?.remove(g);
  }
  rec.group = null;
  rec.handles = null;
  rec.colMeshes = null;
  rec.lod = null;
  rec.sphere = null;
}

export { _v as _scratchVec };
