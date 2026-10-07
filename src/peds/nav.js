/**
 * PEDS — sidewalk navigation on the city's road graph.
 *
 * `world.roads` is a planar graph of straight edges with a width and a kind.
 * Sidewalks are not in that graph, but they are completely determined by it: a
 * pavement runs down each side of every street at `width/2 + inset`, and the
 * places two pavements meet are exactly the graph's junctions. So instead of a
 * second authored network (which would have to be streamed, stored and kept in
 * sync), a pedestrian carries a LINK — `{ edge, side, dir }` — and a parameter
 * `t`, and the whole crowd navigates by walking that link to its node and
 * choosing the next one.
 *
 * Choosing the next link keeps the walker on the same physical corner: for each
 * candidate edge we evaluate both of its pavements at the shared node and take
 * the nearer one. Turning a corner therefore never teleports anybody across a
 * road. Crossing is an explicit, separate decision with its own state, its own
 * light check (`traffic.lightAt(nodeId)`) and its own exposure to vehicles —
 * which is what makes a crossing read as a crossing.
 *
 * Everything guards `world` and `traffic` being absent: they are built in
 * parallel with this system, and a missing road graph must degrade to a wander,
 * never to a crash.
 */

import * as THREE from 'three';

/** Pavement inset from the kerb, by road kind. Highways have no pavement. */
const INSET = {
  highway: null,
  arterial: 2.3,
  street: 1.9,
  alley: 1.15,
  service: 1.4,
};

/**
 * The pavement inset for a road kind, or null where that kind has no pavement.
 *
 * NOT `INSET[kind] ?? INSET.street`. `??` falls back on null as well as on
 * undefined, so that expression answered 1.9 for `highway` — whose entry is an
 * EXPLICIT null meaning "no pavement here" — and every filter written as
 * `(INSET[kind] ?? INSET.street) === null` was therefore dead code that could
 * not fire. A six-lane parkway is 28.6 m wide, so the pavement it was handing
 * out sat 16.2 m off the centreline, on the far shoulder of a 33 m/s road.
 * `in` distinguishes "the table says no pavement" from "the table has never
 * heard of this kind", which is the only case `INSET.street` is a default for.
 */
function insetOf(kind) {
  return kind in INSET ? INSET[kind] : INSET.street;
}

/**
 * MAY A WALKER ADOPT THIS EDGE? Three clauses, and all three sites that pick
 * an edge need all three or the crowd ends up somewhere a person cannot be:
 *
 *   - RAIL is in the graph so `roadmesh` can draw ballast, and it is not a
 *     road. `netgen.railLines` emits mill trackage as `kind: 'alley'`, which
 *     `INSET` admits at 1.15 m, so the KIND cannot rule it out — only the
 *     `rail` flag can. A "pavement" beside trackage is a pedestrian on the
 *     sleepers, and `net.next()` will happily walk him down the spur;
 *   - a HIGHWAY has no pavement at all (see `insetOf`);
 *   - an edge shorter than a stride is a weld artefact, not a street. Only
 *     `attach` tests that one — a pick that lands on a stub is still a legal
 *     place to stand, it is just not worth sampling a destination on.
 *
 * `attach` was the only site that filtered on `rail`, which was invisible for
 * as long as `nearestLink` had no callers. `Ped._rejoinPavement` gave it one.
 */
function walkable(e) {
  return !!e && !e.rail && insetOf(e.kind) !== null;
}

const _v = new THREE.Vector3();

export class SidewalkNet {
  constructor() {
    this.roads = null;
    this.ready = false;
    this._edgeCount = -1;
    this._walkable = [];
    this._out = new THREE.Vector3();
    this._out2 = new THREE.Vector3();
  }

  /**
   * Adopt (or re-adopt) a road graph. Cheap and idempotent — call it every so
   * often while `world` is still streaming its network in.
   */
  attach(roads) {
    if (!roads || !Array.isArray(roads.edges) || !Array.isArray(roads.nodes)) {
      this.ready = false;
      return false;
    }
    if (roads === this.roads && roads.edges.length === this._edgeCount) return this.ready;
    this.roads = roads;
    this._edgeCount = roads.edges.length;
    this._walkable.length = 0;
    for (const e of roads.edges) {
      if (!walkable(e)) continue;
      if (!(e.len > 6)) continue;
      this._walkable.push(e);
    }
    this.ready = this._walkable.length > 0;
    return this.ready;
  }

  /** Half the road width plus the pavement inset — the pavement centreline. */
  offsetOf(edge) {
    const inset = insetOf(edge.kind);
    return (edge.width ?? 7) * 0.5 + (inset ?? 1.9);
  }

  /** World point at parameter t (always measured a -> b) on one pavement. */
  pointOn(edge, side, t, out = this._out) {
    const roads = this.roads;
    const na = roads.nodes[edge.a];
    const nb = roads.nodes[edge.b];
    const o = this.offsetOf(edge) * side;
    out.x = na.x + (nb.x - na.x) * t - edge.dz * o;
    out.z = na.z + (nb.z - na.z) * t + edge.dx * o;
    out.y = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * t;
    return out;
  }

  /** Heading, radians, of walking this link. */
  headingOf(link) {
    const e = link.edge;
    const s = link.dir;
    return Math.atan2(e.dx * s, e.dz * s);
  }

  /** The node a link is walking toward. */
  endNode(link) {
    return link.dir > 0 ? link.edge.b : link.edge.a;
  }

  startNode(link) {
    return link.dir > 0 ? link.edge.a : link.edge.b;
  }

  /** A random legal pavement pose in an annulus around a point. */
  sampleLink(rng, near, minDist = 12, maxDist = 180, out = {}) {
    if (!this.ready) return null;
    const list = this._walkable;
    const n = list.length;
    if (!n) return null;
    const cx = near?.x ?? 0;
    const cz = near?.z ?? 0;
    const min2 = minDist * minDist;
    const max2 = maxDist * maxDist;
    // 24 tries against the annulus, then give up rather than scan the city
    for (let i = 0; i < 24; i++) {
      const e = list[rng.u32() % n];
      const na = this.roads.nodes[e.a];
      const nb = this.roads.nodes[e.b];
      const mx = (na.x + nb.x) * 0.5 - cx;
      const mz = (na.z + nb.z) * 0.5 - cz;
      const d2 = mx * mx + mz * mz;
      if (d2 < min2 || d2 > max2) continue;
      out.edge = e;
      out.side = rng.float() < 0.5 ? 1 : -1;
      out.dir = rng.float() < 0.5 ? 1 : -1;
      out.t = rng.range(0.08, 0.92);
      return out;
    }
    return null;
  }

  /**
   * The nearest pavement to a world point, or null.
   *
   * `heading` (radians, optional) picks the direction of travel that keeps a
   * walker facing the way he already is. Without it a walker adopting this
   * link would about-face on the spot half the time, which reads as a glitch
   * rather than as somebody stepping back onto the pavement.
   *
   * PASS `y` WHEN YOU HAVE ONE. Steel City has eleven bridges and every one of
   * them flies over a riverfront quay: in PLAN a man on the Allegheny Quay is
   * two metres from the Sixth Street deck and eighteen metres below it, so a
   * 2D query hands him the deck, `pointOn` interpolates the deck's node
   * heights, and he spends the rest of his life walking under the bridge
   * toward a point on top of it. `RoadGraph.nearestEdge` takes the height for
   * exactly this and scores a wrong deck out of contention; the caller still
   * has to check the height it gets back, because the penalty picks the BEST
   * candidate and cannot invent a right one. See `Ped._rejoinPavement`.
   *
   * `maxDist` sizes the ring search. The default is the whole-city reach a
   * caller with no opinion wants; a caller whose accept radius is metres
   * should pass that instead, because `nearestEdge` scans ceil(maxDist/CELL)
   * rings whether or not the answer can possibly be accepted.
   *
   * Returns null rather than a second-best when the nearest edge is not
   * `walkable`: the alternative is to keep scanning outward past trackage or
   * a parkway for something that would fail the caller's own reach test
   * anyway, and a walker who finds nothing simply goes on wandering.
   */
  nearestLink(x, z, out = {}, heading = null, y = NaN, maxDist = 160) {
    if (!this.ready || typeof this.roads.nearestEdge !== 'function') return null;
    const near = this.roads.nearestEdge(x, z, maxDist, y);
    if (!near || !walkable(near.edge)) return null;
    const e = near.edge;
    const na = this.roads.nodes[e.a];
    const px = x - (na.x + (this.roads.nodes[e.b].x - na.x) * near.t);
    const pz = z - (na.z + (this.roads.nodes[e.b].z - na.z) * near.t);
    const lat = -e.dz * px + e.dx * pz;
    out.edge = e;
    out.side = lat >= 0 ? 1 : -1;
    out.dir = heading === null || Math.sin(heading) * e.dx + Math.cos(heading) * e.dz >= 0 ? 1 : -1;
    out.t = near.t;
    return out;
  }

  /**
   * Pick the next link at the end of the current one, staying on the same
   * corner. Returns null at a dead end (the caller reverses).
   */
  next(link, rng, out = {}) {
    const roads = this.roads;
    const nodeId = this.endNode(link);
    const node = roads.nodes[nodeId];
    if (!node) return null;
    // where the walker physically is, at the end of this pavement
    const here = this._here ?? (this._here = new THREE.Vector3());
    here.copy(this.pointOn(link.edge, link.side, link.dir > 0 ? 1 : 0, this._out2));

    const best = this._best ?? (this._best = { edge: null, dir: 1 });
    let found = false;
    let bestScore = -Infinity;
    const heading = this.headingOf(link);
    for (let i = 0; i < node.links.length; i++) {
      const e = roads.edges[node.links[i]];
      if (e === link.edge) continue;
      // Same predicate as `attach` — a junction is exactly where a rail spur
      // welds onto the road grid (`railsweep` documents the weld), so this is
      // the site at which a walker would turn onto the sleepers.
      if (!walkable(e)) continue;
      const dir = e.a === nodeId ? 1 : -1;
      const h = Math.atan2(e.dx * dir, e.dz * dir);
      let dh = h - heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      // strong preference for carrying straight on, then for a turn, never a
      // U-turn; plus a deterministic jitter so a crowd fans out at a junction
      let score = 1.6 * Math.cos(dh) + rng.float() * 0.9;
      if (Math.abs(dh) > 2.7) score -= 2.0;
      if (score > bestScore) {
        bestScore = score;
        best.edge = e;
        best.dir = dir;
        found = true;
      }
    }
    if (!found) {
      // dead end: turn round on the other pavement
      out.edge = link.edge;
      out.side = -link.side;
      out.dir = -link.dir;
      out.t = link.dir > 0 ? 1 : 0;
      return out;
    }
    /**
     * TURN THE CORNER — DO NOT AIM AT THE MIDDLE OF THE JUNCTION.
     *
     * The new link used to start at t = 0 (or 1), i.e. exactly AT the node,
     * offset sideways onto the new edge's pavement. At a crossroads those two
     * facts fight: the sideways offset is along the OLD street, which at a
     * right-angle junction points straight down the NEW street's centreline —
     * so the aim point for the first stride round every corner is the middle
     * of the carriageway the walker has just decided not to cross. MEASURED in
     * the `crowd` shot: nine of the twenty-six link-mode pedestrians were
     * standing on `asphalt`, every one of them within a few metres of a node,
     * and their nearest edge was never the edge they were walking.
     *
     * Starting the link one pavement-offset INTO the new edge puts the aim
     * point past the far kerb of the street being left, which is where the
     * corner of a real pavement is. Capped at 0.45 so a very short edge cannot
     * have its parameter run past its own midpoint.
     */
    const corner = this.offsetOf(link.edge) / Math.max(8, best.edge.len ?? 8);
    const tIn = Math.min(0.45, corner);
    const tNear = best.dir > 0 ? tIn : 1 - tIn;
    const pA = this.pointOn(best.edge, 1, tNear, this._out);
    const dA = (pA.x - here.x) ** 2 + (pA.z - here.z) ** 2;
    const pB = this.pointOn(best.edge, -1, tNear, this._out);
    const dB = (pB.x - here.x) ** 2 + (pB.z - here.z) ** 2;
    out.edge = best.edge;
    out.side = dA <= dB ? 1 : -1;
    out.dir = best.dir;
    out.t = tNear;
    return out;
  }

  /**
   * Where a crossing of this link's road ends up: the same t on the opposite
   * pavement. Returns the target point and the node whose light governs it.
   */
  crossTarget(link, t, out = new THREE.Vector3()) {
    this.pointOn(link.edge, -link.side, t, out);
    return out;
  }

  /** Metres of open road a crossing has to traverse. */
  crossWidth(link) {
    return this.offsetOf(link.edge) * 2;
  }
}

/**
 * Fallback navigation for when `world.roads` does not exist yet, or the
 * pedestrian is somewhere with no road near it.
 *
 * A wander is not a fallback nobody sees: it is what a ped does in a park, on
 * a plaza and inside a lot, so it has to look deliberate. Each walker keeps a
 * destination inside a disc around its anchor, walks to it, pauses, picks
 * another. The pause distribution is what stops a wander reading as a random
 * walk.
 */

/** Resamples allowed inside one `Wander.pick` before the last one is kept. */
const WANDER_TRIES = 6;

export class Wander {
  constructor() {
    this.target = new THREE.Vector3();
    this.anchor = new THREE.Vector3();
    this.radius = 26;
    this.pause = 0;
    /**
     * Optional `(x, z) => boolean` KEEP-OUT, installed by whoever reset this
     * wander. `pick` resamples while it answers true.
     *
     * It is a callback rather than a rule in here because a wander has no idea
     * what ground it is over — the disqualifying fact (today: a flooded
     * fountain basin) needs a resolved height, and `PedSystem` is the only
     * object that can get one. Null by default, so a wander with no owner
     * opinion — the ped preview harness, a `Wander` built inside `ped.js`
     * before a system has touched it — behaves exactly as before.
     */
    this.avoid = null;
  }

  reset(rng, anchor, radius = 26) {
    this.anchor.copy(anchor);
    this.radius = radius;
    this.pick(rng);
    this.pause = rng.range(0, 2);
  }

  /**
   * A destination inside the disc, resampled up to `WANDER_TRIES` times while
   * `avoid` rejects it.
   *
   * The LAST sample is kept rather than the walker being frozen: a wanderer
   * whose whole disc is disqualified (standing in the middle of the thing being
   * excluded) still has to have somewhere to go, and the alternative — no
   * target — reads as a crowd of statues. He walks out on the next pick.
   */
  pick(rng) {
    for (let i = 0; i < WANDER_TRIES; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = Math.sqrt(rng.float()) * this.radius;
      this.target.set(this.anchor.x + Math.cos(a) * r, this.anchor.y, this.anchor.z + Math.sin(a) * r);
      if (!this.avoid || !this.avoid(this.target.x, this.target.z)) return;
    }
  }

  /** @returns true when the walker should keep moving toward `target`. */
  step(rng, position, dt) {
    if (this.pause > 0) {
      this.pause -= dt;
      return false;
    }
    const dx = this.target.x - position.x;
    const dz = this.target.z - position.z;
    if (dx * dx + dz * dz < 1.2) {
      this.pick(rng);
      this.pause = rng.float() < 0.42 ? rng.range(1.5, 7) : 0;
      return this.pause <= 0;
    }
    return true;
  }
}

/**
 * A tiny uniform grid over the live crowd, rebuilt every frame from the ped
 * positions. Local avoidance, "who is near the incident" and `nearest()` all
 * go through it, so the crowd is O(n) rather than O(n^2) — at 110 peds the
 * naive version is 12,100 distance tests per frame and this is about 900.
 */
export class CrowdGrid {
  constructor(cell = 4) {
    this.cell = cell;
    this.map = new Map();
    this._out = [];
  }

  _key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663;
  }

  rebuild(peds) {
    this.map.clear();
    const c = 1 / this.cell;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (!p.active) continue;
      const k = this._key(Math.floor(p.position.x * c), Math.floor(p.position.z * c));
      let list = this.map.get(k);
      if (!list) this.map.set(k, (list = []));
      list.push(p);
    }
  }

  /** Everyone within `radius` of (x,z). Returns a REUSED array. */
  query(x, z, radius) {
    const out = this._out;
    out.length = 0;
    const c = 1 / this.cell;
    const r = Math.ceil(radius * c);
    const cx = Math.floor(x * c);
    const cz = Math.floor(z * c);
    const r2 = radius * radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.map.get(this._key(cx + dx, cz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const ddx = p.position.x - x;
          const ddz = p.position.z - z;
          if (ddx * ddx + ddz * ddz <= r2) out.push(p);
        }
      }
    }
    return out;
  }
}

export { INSET as SIDEWALK_INSET };

/* ---------------------------------------------------------- airfield --- */

/**
 * AMBIENT-SPAWN KEEP-OUT for airfields and the airbase.
 *
 * An airfield (the two civilian ones and Ridgeline AFB) is open, RESTRICTED
 * ground: no wandering pedestrian belongs on the runway, apron or the graded
 * field inside the fence, and — the part that surprises — the perimeter RING
 * ROAD that `world` lays round each field must not carry city-sidewalk crowd
 * density either. `netgen` (commit ee63000) diverts the city streets that used
 * to cross each civilian field into a ring road hugging the fence; a ring road
 * carries pavement, and pavement carries ambient peds, so without this the
 * whole airport ends up encircled by a dense band of pedestrians — the "NPCs
 * all over the airfield / too many people running around" report.
 *
 * `world.airfieldAt(x,z)` / `world.airbaseAt(x,z)` are the published FIELD
 * predicates: truthy inside the fence, falsy under `?noairfield=1` /
 * `?noairbase=1` (and before the pads are built). We consult ONLY those, so
 * this stays in lock-step with `world`'s field geometry for free and touches
 * nothing `peds` does not own.
 *
 * RIDGELINE'S FENCED PERIMETER IS THE SAME REGION AS `airbaseAt`, and that is
 * worth stating because the other published test — `world.airbase.
 * insidePerimeter(x, z)`, the encounter agent's — reads like a second, larger
 * one. It is not: both are `inRect(FIELD_STRIP) || inRect(FIELD_APRON)` over
 * the L-shape `FENCE_POLY` walks. SWEPT on the live build, a 25 m lattice of
 * 5 329 points over a 1 800 m box centred on the base: 458 inside, and the two
 * predicates DISAGREED on none of them. So consulting `airbaseAt` here already
 * excludes the whole fenced base, and adding `insidePerimeter` alongside it
 * would be a second name for one fact (rule 12) that could only ever drift.
 * MEASURED with the crowd streaming for 600 frames from two Ridgeline cameras
 * (`mkt_afb`'s flightline composition and a lens on the tank apron, ambient
 * target 36 and 17): ZERO ambient pedestrians inside the perimeter on either,
 * the nearest at 118 m from the base centre. What DOES still reach a
 * flightline is a staged tableau — see `PedSystem.debugStage`, which had no
 * keep-out at all and now runs this same test.
 *
 *   - inside a field  -> reject the spawn outright (open ground, no crowd);
 *   - on the perimeter (a field edge within `AF_PERIMETER` of the point, i.e.
 *     on the ring road round the fence) -> keep only `AF_PERIMETER_KEEP` of
 *     spawns, so the ring reads as a quiet airport fence line, not a high
 *     street.
 *
 * This does NOT touch the assault guards (`peds.spawnHostile` / the hostiles
 * pool) — those are gameplay actors intentionally placed when the player
 * trespasses, on a different path entirely. Only the AMBIENT wander crowd is
 * gated here.
 *
 * `rng` is a `core/rng.js` instance (`ctx.rng` in the game, a seeded `Rng` in
 * the probe) — the perimeter coin flip is drawn from it, so the decision is
 * deterministic (hard rule 4) and only draws when a field is actually near, so
 * the rng stream — and therefore downtown density — is untouched away from a
 * field. `src/peds/airpedprobe.mjs` gates this; `peds.debugIgnoreAirfields`
 * is its live negative-control hatch (the `debugIgnorePause` pattern).
 */
export const AF_PERIMETER = 34;      // metres of ring band round a field
export const AF_PERIMETER_KEEP = 0.12; // fraction of perimeter spawns kept

// Eight unit compass offsets (N, NE, E, ... NW), flat, module-level so the
// probe below allocates nothing per spawn (hard rule 5).
const R2 = Math.SQRT1_2;
const AF_RING = [
  0, 1, R2, R2, 1, 0, R2, -R2,
  0, -1, -R2, -R2, -1, 0, -R2, R2,
];

function fieldAt(world, x, z) {
  return (world.airfieldAt && world.airfieldAt(x, z)) ||
    (world.airbaseAt && world.airbaseAt(x, z)) || null;
}

/**
 * True when an ambient pedestrian must NOT spawn at (x, z): inside a field, or
 * a sparse rejection on the perimeter ring. See the block comment above.
 */
export function airfieldSpawnBlocked(world, x, z, rng) {
  if (!world) return false;
  if (fieldAt(world, x, z)) return true;
  for (let i = 0; i < AF_RING.length; i += 2) {
    if (fieldAt(world, x + AF_RING[i] * AF_PERIMETER, z + AF_RING[i + 1] * AF_PERIMETER)) {
      return (rng ? rng.float() : 0) > AF_PERIMETER_KEEP;
    }
  }
  return false;
}

/* ---------------------------------------------------------- fountain --- */

/**
 * THE POINT FOUNTAIN'S BASIN IS NOT A PLAZA, AND NOTHING ABOUT ITS SURFACE
 * SAYS SO.
 *
 * `mkt_fountain` photographed four pedestrians strolling across the middle of
 * the flooded basin. Every check `_spawnNear` already had passed them: the
 * ground is not `water` (the basin's collider is tagged `concrete`), it is not
 * `asphalt`, `isOpen` is true because no building stands there, and no field
 * predicate covers a landmark. `world.isWater` answers for the three rivers,
 * not for 2 800 m^2 of standing water inside a granite wall.
 *
 * So the disqualifying fact is measured rather than named. `landmarks.js`
 * builds the basin as one collision box `T.box('concrete', x, gy + 0.55, z,
 * R*2, 1.1, R*2)` — a SHELF whose top is a single world height, laid over
 * terrain that is anything but flat here. MEASURED on the emitted frame, the
 * twenty-eight ambient pedestrians within 50 m of `lm_point`:
 *
 *     on the shelf (y = 3.80 exactly)   13   ground stands  +0.74 .. +4.84 m
 *                                             over the terrain beneath them
 *     off the shelf                     15   ground stands  -0.15 .. +0.22 m
 *
 * — two populations with half a metre of clear air between them and no
 * overlap, so "the resolved ground stands more than `BASIN_LIP` above the
 * terrain, inside the landmark's own published site" separates them exactly
 * and has margin on both sides. It also catches the
 * corners of that square shelf, which reach 42 m out over a granite apron
 * drawn a metre BELOW them, and it costs one distance test everywhere else in
 * the city.
 *
 * Both facts come from their owners: the centre and the site radius are
 * `world.landmarks` (the city's single source of truth for where a landmark
 * is), and the height is `world.heightAt`. This file adopts no basin
 * dimension of its own, so a reshaped fountain needs no edit here.
 *
 * `peds` applies it at the two places it PLACES a pedestrian (`_spawnNear`,
 * `debugStage`) and through `Wander.avoid` for the one who walks in — every
 * pedestrian measured in the basin was in `wander` mode, which is what the
 * Point's roadless plaza leaves them in.
 */
export const BASIN_LIP = 0.6;

/** Cache keyed on the published array's identity — see `fountainSite`. */
let _lmFor = null;
let _lmPoint = null;

/**
 * The Point fountain's published site — `{ x, z, r, r2 }` — or null. Cached
 * because this is on the spawn path and a `find` over the landmark table per
 * call is a scan (rule 5); keyed on the ARRAY, so a rebuilt world replaces it
 * rather than going stale. The REUSED record must not be mutated by a caller.
 */
export function fountainSite(world) {
  const list = world?.landmarks;
  if (!Array.isArray(list)) return null;
  if (list !== _lmFor) {
    _lmFor = list;
    const lm = list.find((l) => l.id === 'lm_point') ?? null;
    const r = lm?.site?.r ?? 46;
    _lmPoint = lm ? { x: lm.x, z: lm.z, r, r2: r * r } : null;
  }
  return _lmPoint;
}

/**
 * True when a pedestrian standing at (x, z) on ground `groundY` would be in the
 * fountain basin. `groundY` is what the CALLER resolved (a physics raycast, not
 * a guess) — the whole test is that number against the terrain. See above.
 */
export function fountainBasinBlocked(world, x, z, groundY) {
  if (!world || !Number.isFinite(groundY)) return false;
  const lm = fountainSite(world);
  if (!lm) return false;
  const dx = x - lm.x;
  const dz = z - lm.z;
  if (dx * dx + dz * dz > lm.r2) return false;
  const t = world.heightAt?.(x, z);
  return Number.isFinite(t) && groundY - t > BASIN_LIP;
}
