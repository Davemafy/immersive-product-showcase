/**
 * The procedural human — one rig, three brothers.
 *
 * A single SkinnedMesh built from swept tubes and displaced ellipsoids, with
 * eight material groups so the garments read as separate objects rather than a
 * painted-on texture: bare skin, face, shirt, trousers, boot leather, boot sole,
 * hair, eyes.
 *
 * WHY SWEEPS. A capsule per limb is what every "procedural character" looks
 * like, and it is instantly readable as programmer art. Real limbs have a
 * profile: a calf is a teardrop, a thigh is thickest a third of the way down, a
 * forearm tapers to a bony wrist. Every tube here takes a `radius(t)` function
 * so those profiles are authored, and an optional `shape(angle, t)` so a shin
 * can be flattened at the front where the tibia is under the skin.
 *
 * The skeleton is authored in metres in a bind pose with the arms hanging (not a
 * T-pose): this character never raises its arms above the shoulder, so an
 * A-pose bind gives far better deltoid deformation than a T-pose would.
 *
 * Bind-space convention, shared with the whole game:
 *   +Y up · -Z forward (the character faces the same way as yaw = 0) · +X is the
 *   character's RIGHT.
 */

import * as THREE from 'three';

/* ====================================================================== */
/* Identity                                                               */
/* ====================================================================== */

/**
 * Per-brother identity: the FACE and the WARDROBE.
 *
 * `brothers.js` authors the physical scalars the skeleton needs (scale,
 * shoulder, limb, jaw, brow, nose). Those alone give three men of different
 * size wearing the same shirt with the same face at three magnifications, which
 * is what the review called out. This table is the other half — the feature
 * deltas that make a face somebody's, and the garment each man actually wears.
 *
 * Keyed by `build.id`. Callers that hand `buildCharacter()` a raw brothers.js
 * build (`camtest.mjs`, `anim/aimposeprobe.mjs`) carry no id, so `hair` — which
 * brothers.js authors one distinct value of per brother — is the fallback key.
 * `character/index.js` sets `id` explicitly and it always wins.
 *
 * FACE scalars are multipliers on named gaussians in `buildHead()`; 0 removes
 * the feature entirely, so "no bridge hump" is expressible and is not the same
 * shape as "a small one". They are read as ANATOMY:
 *
 *   bridge      dorsal hump on the nose         cheekHollow  sunken cheek
 *   alae        nostril-wing spread             fold         nasolabial crease
 *   tipDrop     nose tip droops (+) / lifts (-) temple       temporal hollow
 *   deepEye     how far the eye sits under the brow
 *   furrow      the horizontal crease above the brow (age)
 *   lip/mouthW  lip fullness and mouth width    cleft        chin cleft
 *   jawSquare   flare at the gonial angle
 */
export const IDENTITY = {
  carson: {
    hairKey: 'crop',
    // Eldest, weathered, off the water: heavy overhanging brow over deep-set
    // eyes, a nose broken once and set wide, hollow wind-burnt cheeks with the
    // folds to match, a thin mouth and a slab of a jaw.
    face: {
      bridge: 1.0, alae: 1.0, tipDrop: 0.9, cheekHollow: 1.0, fold: 1.0,
      temple: 1.0, furrow: 1.0, cleft: 0.45, deepEye: 1.0, lip: 0.62,
      mouthW: 1.08, jawSquare: 1.0, chinW: 1.0,
    },
    outfit: 'river',
    sleeve: 'rolledLong',
    cloth: 'canvas',
    /** Garment thickness over the ribs, metres — see `torsoRX`. */
    bulk: 0.015,
    /** 0 young .. 1 weathered — drives the face atlas, not the geometry. */
    age: 1.0,
    /** Beard coverage: 0 clean, 1 a full jaw of stubble. */
    beard: 0.85,
  },
  aidan: {
    hairKey: 'sweep',
    // Middle: the most regular face of the three. A long straight nose, a
    // cleft chin, a level brow and enough cheek to read as well fed.
    face: {
      bridge: 0.50, alae: 0.75, tipDrop: 0.25, cheekHollow: 0.50, fold: 0.55,
      temple: 0.3, furrow: 0.35, cleft: 1.0, deepEye: 0.62, lip: 1.0,
      mouthW: 1.0, jawSquare: 0.85, chinW: 0.72,
    },
    outfit: 'shop',
    sleeve: 'rolledShort',
    cloth: 'chambray',
    bulk: 0.004,
    age: 0.45,
    beard: 0.5,
  },
  dylan: {
    hairKey: 'mop',
    // Youngest: a short upturned nose, a narrow tapered jaw, a smooth forehead
    // and eyes that sit forward rather than under a shelf.
    face: {
      bridge: 0.0, alae: 0.1, tipDrop: -0.9, cheekHollow: 0.0, fold: 0.05,
      temple: 0.0, furrow: 0.0, cleft: 0.0, deepEye: 0.05, lip: 1.28,
      mouthW: 0.90, jawSquare: 0.10, chinW: 0.18,
    },
    outfit: 'courier',
    sleeve: 'cuffed',
    cloth: 'ripstop',
    bulk: 0.009,
    age: 0.08,
    beard: 0.16,
  },
};

const BASE_IDENTITY = {
  face: {
    bridge: 0.4, alae: 0.5, tipDrop: 0.3, cheekHollow: 0.4, fold: 0.4,
    temple: 0.3, furrow: 0.3, cleft: 0.4, deepEye: 0.5, lip: 0.9,
    mouthW: 1.0, jawSquare: 0.6, chinW: 0.6,
  },
  outfit: 'shop',
  sleeve: 'rolledShort',
  cloth: 'chambray',
  bulk: 0.006,
  age: 0.4,
  beard: 0.4,
};

const BY_HAIR = Object.fromEntries(
  Object.entries(IDENTITY).map(([id, v]) => [v.hairKey, { ...v, id }])
);

/**
 * The identity a given build resolves to. Never returns null.
 *
 * NEGATIVE CONTROL: `build.noIdentity` collapses every brother onto the shared
 * base — one face, one garment, one bulk — leaving only the physical scalars
 * `brothers.js` authors. `identityprobe.mjs` runs it and asserts the measured
 * separation between the three men falls off a cliff, which is what proves the
 * probe is reading this table and not the size difference underneath it.
 */
export function identityOf(build) {
  if (build?.noIdentity) return { ...BASE_IDENTITY, id: 'base' };
  const byId = build?.id ? IDENTITY[build.id] : null;
  if (byId) return { ...byId, id: build.id };
  const byHair = build?.hair ? BY_HAIR[build.hair] : null;
  if (byHair) return byHair;
  return { ...BASE_IDENTITY, id: 'base' };
}

/* ====================================================================== */
/* Skeleton                                                               */
/* ====================================================================== */

/**
 * [name, parent, x, y, z] — positions are BIND-POSE WORLD metres for a 1.78 m
 * body; the loader converts to parent-relative. Mirrored limbs are generated.
 */
const BONE_SPEC = [
  ['hips', null, 0, 0.945, 0],
  ['spine', 'hips', 0, 1.075, 0.006],
  ['chest', 'spine', 0, 1.248, 0.002],
  ['neck', 'chest', 0, 1.452, -0.012],
  ['head', 'neck', 0, 1.548, 0.004],
  ['headEnd', 'head', 0, 1.79, 0.004],
];

/**
 * AN ELBOW IS THE ANTI-KNEE, AND THIS TABLE USED TO FORGET IT.
 *
 * Every limb here bows in the sagittal plane: the middle joint sits off the
 * root->end chord, and WHICH SIDE it sits on is the whole readability of the
 * joint, because it is the only thing that says which way the limb hinges when
 * it is nearly straight. A knee points FORWARD. An elbow points BACKWARD. They
 * are opposite, and the arm chain below was authored with the LEG's signs:
 *
 *   MEASURED on the shipped table, deviation of the middle joint from the
 *   root->end chord, +ve = the anatomically correct side:
 *     player arm   -15.0 mm   <- elbow pointing FORWARD, i.e. hyperextended
 *     player leg   +27.0 mm
 *     ped arm      +10.6 mm   (`src/peds/rig.js`, the control: it is right)
 *     ped leg      +32.2 mm
 *
 * The elbow was 15 mm the wrong side of its own chord and the forearm therefore
 * carried BACKWARD out of it — a reversed hinge, held at every speed, and the
 * owner's report ("arms are bent the wrong way, seems contorted") is exactly
 * that. It reads loudest on carson because his `limb` girth and rolled-below-
 * the-elbow sleeve put the crease on the silhouette, not because his skeleton
 * differs: MEASURED, the three brothers' elbows agree to 0.1 degrees.
 *
 * The fix mirrors the arm's bow and nothing else. The magnitude is unchanged
 * (-15.0 -> +15.0 mm), the wrist moves 4 mm and every bone LENGTH moves under
 * 0.2 mm, so reach, the weapon hand and the IK targets are all where they were.
 *
 * NEGATIVE CONTROL: `build.legacyElbow === true` puts the leg-shaped bow back
 * (and the pre-fix lateral splay below, which is the other half of the same
 * defect). `identityprobe.mjs` runs it and requires the elbow sign to go red.
 */
const LIMB_SPEC = [
  // clavicle -> hand. The elbow sits BEHIND the shoulder->wrist chord and the
  // forearm carries forward out of it: a relaxed stand, ~6.6 degrees of flexion.
  ['clav', 'chest', 0.043, 1.418, 0.004],
  ['arm', 'clav', 0.176, 1.428, 0.002],
  ['forearm', 'arm', 0.199, 1.163, 0.016],
  ['hand', 'forearm', 0.214, 0.907, 0.000],
  ['handEnd', 'hand', 0.219, 0.772, -0.008],
  // leg. The knee sits IN FRONT of the hip->ankle chord — the opposite sign,
  // and the one this table already had right.
  ['thigh', 'hips', 0.094, 0.912, 0.004],
  ['shin', 'thigh', 0.099, 0.498, -0.014],
  ['foot', 'shin', 0.101, 0.086, 0.022],
  ['toe', 'foot', 0.101, 0.031, -0.108],
];

/** The pre-fix arm z, restored by `build.legacyElbow`. See LIMB_SPEC. */
const LEGACY_ARM_Z = { clav: 0.004, arm: 0.002, forearm: -0.012, hand: 0.004, handEnd: 0.012 };

/** The arm chain, girdle first. Everything else in LIMB_SPEC is a leg. */
const ARM_CHAIN = new Set(['clav', 'arm', 'forearm', 'hand', 'handEnd']);

/** Lateral bind x of the shoulder JOINT — the pivot the deltoid span moves. */
const SHOULDER_X = 0.176;

/** Names, in creation order. Index in this array is the skin index. */
export const BONE_NAMES = (() => {
  const out = BONE_SPEC.map((b) => b[0]);
  for (const side of ['R', 'L']) for (const l of LIMB_SPEC) out.push(l[0] + side);
  return out;
})();

export const BONE_INDEX = (() => {
  const m = Object.create(null);
  BONE_NAMES.forEach((n, i) => (m[n] = i));
  return m;
})();

/**
 * Bind-pose world positions, after the per-brother build has been applied.
 *
 * `shoulder` MOVES THE SHOULDER JOINT; IT DOES NOT STRETCH THE ARM BELOW IT.
 *
 * The deltoid span is a property of the girdle — the clavicle and the shoulder
 * joint it carries — and the arm hangs off that joint the same way on every
 * man. Scaling the whole chain's absolute x by `shoulder`, which is what this
 * did, also scaled the LATERAL DRIFT between shoulder, elbow and wrist, so a
 * broad man's forearm splayed further out than a narrow man's and the elbow
 * hinge tilted with the build: MEASURED, the upper arm's angle out of vertical
 * ran carson 5.50 / aidan 5.16 / dylan 4.66 degrees off one authored 4.96.
 * Small, but it is a per-build shear of the very axis the elbow turns about,
 * and the bulk deltas can only ever make it worse.
 *
 * So the girdle scales and everything distal to the shoulder joint is carried
 * RIGIDLY by the joint's own displacement. Carson's deltoid span — what
 * `identityprobe`'s silhouette gate reads — does not move; his wrist comes in
 * 4 mm; his elbow axis becomes the same axis as his brothers'.
 *
 * NEGATIVE CONTROL: `build.legacyElbow === true` restores the old x scaling as
 * well as the old sagittal bow. One defect, one switch — see LIMB_SPEC.
 */
function bindPositions(build) {
  const p = Object.create(null);
  const S = build.scale ?? 1;
  const shoulder = build.shoulder ?? 1;
  const limb = build.limb ?? 1;
  const legacy = build.legacyElbow === true;
  // How far the widened girdle carries the shoulder joint, and with it the arm.
  const armShift = SHOULDER_X * (shoulder - 1);
  const push = (name, x, y, z) => {
    p[name] = [x * S, y * S, z * S];
  };
  for (const [name, , x, y, z] of BONE_SPEC) push(name, x, y, z);
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    for (const [name, , x, y, z] of LIMB_SPEC) {
      if (!ARM_CHAIN.has(name)) {
        // Heavier legs sit slightly wider, at a damped rate.
        push(name + side, s * x * (1 + (limb - 1) * 0.45), y, z);
        continue;
      }
      // The girdle — clavicle and the shoulder joint it carries — scales with
      // the deltoid span; everything distal to that joint rides the SAME
      // displacement, so the elbow axis is the same on every build.
      const girdle = name === 'clav' || name === 'arm';
      const lx = legacy ? x * shoulder : girdle ? x * shoulder : x + armShift;
      push(name + side, s * lx, y, legacy ? LEGACY_ARM_Z[name] : z);
    }
  }
  return p;
}

function buildSkeleton(build) {
  const P = bindPositions(build);
  const bones = [];
  const byName = Object.create(null);
  const parentOf = Object.create(null);

  const make = (name, parent) => {
    const b = new THREE.Bone();
    b.name = name;
    const pp = parent ? P[parent] : null;
    const me = P[name];
    b.position.set(me[0] - (pp ? pp[0] : 0), me[1] - (pp ? pp[1] : 0), me[2] - (pp ? pp[2] : 0));
    if (parent) byName[parent].add(b);
    bones.push(b);
    byName[name] = b;
    parentOf[name] = parent;
    return b;
  };

  for (const [name, parent] of BONE_SPEC) make(name, parent);
  for (const side of ['R', 'L']) {
    for (const [name, parent] of LIMB_SPEC) {
      const par = parent === 'chest' || parent === 'hips' ? parent : parent + side;
      make(name + side, par);
    }
  }
  return { bones, byName, positions: P, parentOf, root: byName.hips };
}

/* ====================================================================== */
/* Geometry builder                                                       */
/* ====================================================================== */

const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _tPrev = new THREE.Vector3();
const _axis = new THREE.Vector3();

/** Catmull-Rom through the control points, evaluated at parameter u in [0,1]. */
function crEval(path, u, out) {
  const n = path.length;
  const f = u * (n - 1);
  let i = Math.floor(f);
  if (i > n - 2) i = n - 2;
  if (i < 0) i = 0;
  const t = f - i;
  const p0 = path[Math.max(0, i - 1)];
  const p1 = path[i];
  const p2 = path[i + 1];
  const p3 = path[Math.min(n - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (
      2 * p1[k] +
      (-p0[k] + p2[k]) * t +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
    );
  }
  return out;
}

const _e0 = [0, 0, 0];
const _e1 = [0, 0, 0];

/**
 * Accumulates positions / uvs / skin data across every body part and emits one
 * indexed BufferGeometry with a material group per part family.
 */
class BodyBuilder {
  constructor(materialCount) {
    this.pos = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.index = [];
    /** index-buffer runs, one per material, merged into groups at the end. */
    this.runs = [];
    for (let i = 0; i < materialCount; i++) this.runs.push([]);
    this.seams = [];
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  _vert(x, y, z, u, v, w) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.si.push(w[0], w[2], 0, 0);
    this.sw.push(w[1], w[3], 0, 0);
    return this.vertexCount - 1;
  }

  /**
   * Sweep a tube along `path`.
   * @param o.path     control points [[x,y,z], ...]
   * @param o.rings    ring samples along the path
   * @param o.radial   segments around
   * @param o.radius   (t) => [rx, rz]   half-extents in the frame's two axes
   * @param o.weight   (t) => [i0, w0, i1, w1]
   * @param o.shape    (angle, t) => scalar multiplier, default 1
   * @param o.axis     world direction rx points along at ring 0 (auto by default)
   * @param o.uvOffU/V constant added to the uv. Only the head reads a NON-tiling
   *                   atlas, and the ears are tubes: without an offset they land
   *                   on the eye it is painted at u ~ 0.43 rather than on the
   *                   plain skin the atlas keeps behind the hairline.
   */
  tube(o) {
    const mat = o.material | 0;
    const run = this.runs[mat];
    const rings = o.rings;
    const radial = o.radial;
    const ref = o.axis ?? null;
    const shape = o.shape ?? null;
    const uvV = o.uvV ?? 3.0;
    const uvU = o.uvU ?? 1;
    const offU = o.uvOffU ?? 0;
    const offV = o.uvOffV ?? 0;
    const path = o.path;
    const straight = path.length === 2;

    let prevRow = -1;
    let firstRow = -1;
    let vSum = 0;
    const c = [0, 0, 0];
    const cPrev = [0, 0, 0];
    const cNext = [0, 0, 0];

    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      if (straight) {
        for (let k = 0; k < 3; k++) c[k] = path[0][k] + (path[1][k] - path[0][k]) * t;
      } else {
        crEval(path, t, c);
      }
      // tangent by central difference on the curve
      const dt = 1 / (rings - 1) * 0.5;
      if (straight) {
        for (let k = 0; k < 3; k++) {
          cPrev[k] = path[0][k] + (path[1][k] - path[0][k]) * Math.max(0, t - dt);
          cNext[k] = path[0][k] + (path[1][k] - path[0][k]) * Math.min(1, t + dt);
        }
      } else {
        crEval(path, Math.max(0, t - dt), cPrev);
        crEval(path, Math.min(1, t + dt), cNext);
      }
      _t.set(cNext[0] - cPrev[0], cNext[1] - cPrev[1], cNext[2] - cPrev[2]);
      if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
      _t.normalize();

      // PARALLEL TRANSPORT. Deriving the frame from a fixed reference axis on
      // every ring flips it wherever the tube turns past the reference (a boot
      // does exactly that: it starts vertical at the ankle and ends horizontal
      // at the toe), which twists the cross-section 90 degrees mid-limb. So the
      // frame is seeded once and then carried along the curve by the same
      // rotation that carries the tangent.
      if (i === 0) {
        // Seed: `axis` is the world direction the rx half-extent points along.
        // Default flips with the sweep direction so that N (the rz axis) always
        // comes out pointing FORWARD (-Z), which is the convention every
        // `shape(angle, t)` below is written against.
        if (ref) _ref.set(ref[0], ref[1], ref[2]);
        else _ref.set(_t.y > 0 ? -1 : 1, 0, 0);
        if (Math.abs(_ref.dot(_t)) > 0.9) _ref.set(0, 0, -1);
        if (Math.abs(_ref.dot(_t)) > 0.9) _ref.set(0, 1, 0);
        _b.copy(_ref).addScaledVector(_t, -_ref.dot(_t)).normalize();
      } else {
        _axis.crossVectors(_tPrev, _t);
        const s = _axis.length();
        if (s > 1e-7) {
          _axis.multiplyScalar(1 / s);
          _b.applyAxisAngle(_axis, Math.atan2(s, _tPrev.dot(_t)));
        }
        _b.addScaledVector(_t, -_b.dot(_t));
        if (_b.lengthSq() < 1e-10) _b.set(_t.y, -_t.x, 0);
        _b.normalize();
      }
      _tPrev.copy(_t);
      _n.crossVectors(_b, _t).normalize();

      if (i > 0) {
        vSum += Math.hypot(c[0] - _e0[0], c[1] - _e0[1], c[2] - _e0[2]);
      }
      _e0[0] = c[0]; _e0[1] = c[1]; _e0[2] = c[2];

      const r = o.radius(t, _e1);
      const rx = r[0], rz = r[1];
      const w = o.weight(t);
      const row = this.vertexCount;

      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const m = shape ? shape(a, t) : 1;
        const x = c[0] + _b.x * rx * ca * m + _n.x * rz * sa * m;
        const y = c[1] + _b.y * rx * ca * m + _n.y * rz * sa * m;
        const z = c[2] + _b.z * rx * ca * m + _n.z * rz * sa * m;
        this._vert(x, y, z, (j / radial) * uvU + offU, vSum * uvV + offV, w);
      }
      this.seams.push(row, row + radial);
      if (i === 0) firstRow = row;

      if (prevRow >= 0) {
        for (let j = 0; j < radial; j++) {
          const a0 = prevRow + j, a1 = prevRow + j + 1;
          const b0 = row + j, b1 = row + j + 1;
          run.push(a0, b0, b1, a0, b1, a1);
        }
      }
      prevRow = row;
    }

    // Both row indices are resolved BEFORE any cap vertex is appended, or the
    // second cap reads a row offset by the first cap's centre vertex.
    const lastRow = prevRow;
    if (o.capStart) this._cap(run, firstRow, 0, radial, o, true);
    if (o.capEnd) this._cap(run, lastRow, 1, radial, o, false);
  }

  _cap(run, row, t, radial, o, isStart) {
    // centroid
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < radial; j++) {
      const i = (row + j) * 3;
      cx += this.pos[i]; cy += this.pos[i + 1]; cz += this.pos[i + 2];
    }
    cx /= radial; cy /= radial; cz /= radial;
    const w = o.weight(t);
    // A cap on a TILING surface samples an arbitrary texel wherever it is put,
    // so (0.5, 0.5) has always done; a cap on the head ATLAS does not, and 0.5
    // there is the mouth. Only tubes that ask for an offset get the mapped
    // centre, so no existing cap's texel moves.
    const off = o.uvOffU !== undefined || o.uvOffV !== undefined;
    const cu = off ? (o.uvOffU ?? 0) + 0.5 * (o.uvU ?? 1) : 0.5;
    const cv = off ? (o.uvOffV ?? 0) + 0.5 * (o.uvV ?? 3.0) : 0.5;
    const centre = this._vert(cx, cy, cz, cu, cv, w);
    for (let j = 0; j < radial; j++) {
      if (isStart) run.push(centre, row + j + 1, row + j);
      else run.push(centre, row + j, row + j + 1);
    }
  }

  /**
   * A displaced ellipsoid. `deform(dir, p, out)` may move the surface point
   * anywhere; it is called with the unit direction and the base position.
   */
  ellipsoid(o) {
    const run = this.runs[o.material | 0];
    const lat = o.lat ?? 18;
    const lon = o.lon ?? 24;
    const w = o.weight;
    const c = o.center;
    const r = o.radius;
    const p = [0, 0, 0];
    const rows = [];
    const skip = o.skip ?? null;
    for (let i = 0; i <= lat; i++) {
      const v = i / lat;
      const theta = v * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const row = [];
      for (let j = 0; j <= lon; j++) {
        const u = j / lon;
        const phi = u * Math.PI * 2;
        const dx = st * Math.sin(phi), dy = ct, dz = st * Math.cos(phi);
        p[0] = c[0] + dx * r[0];
        p[1] = c[1] + dy * r[1];
        p[2] = c[2] + dz * r[2];
        if (o.deform) o.deform(dx, dy, dz, p);
        if (skip && skip(dx, dy, dz, p)) { row.push(-1); continue; }
        row.push(this._vert(p[0], p[1], p[2], u * (o.uvU ?? 2), v * (o.uvV ?? 2), w(dx, dy, dz, p)));
      }
      rows.push(row);
      if (i > 0) {
        const prev = rows[i - 1];
        for (let j = 0; j < lon; j++) {
          const a0 = prev[j], a1 = prev[j + 1], b0 = row[j], b1 = row[j + 1];
          if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0) continue;
          run.push(a0, b0, b1, a0, b1, a1);
        }
      }
    }
    for (const row of rows) {
      if (row[0] >= 0 && row[lon] >= 0) this.seams.push(row[0], row[lon]);
    }
  }

  /**
   * A parametric quad grid. Used where a surface needs its own boundary curve
   * rather than a slice of a sphere — the hair cap, whose edge must follow the
   * hairline exactly or it comes out as a staircase.
   * `point(u, v, out)` writes a world position; `wrap` closes the u seam.
   */
  grid(o) {
    const run = this.runs[o.material | 0];
    const rows = o.rows, cols = o.cols;
    const p = [0, 0, 0];
    const w = o.weight;
    const table = [];
    for (let i = 0; i <= rows; i++) {
      const v = i / rows;
      const line = [];
      for (let j = 0; j <= cols; j++) {
        const u = j / cols;
        o.point(u, v, p);
        line.push(this._vert(p[0], p[1], p[2], u * (o.uvU ?? 1), v * (o.uvV ?? 1), w(u, v, p)));
      }
      table.push(line);
      if (i > 0) {
        const prev = table[i - 1];
        for (let j = 0; j < cols; j++) {
          run.push(prev[j], line[j], line[j + 1], prev[j], line[j + 1], prev[j + 1]);
        }
      }
    }
    if (o.wrap !== false) for (const line of table) this.seams.push(line[0], line[cols]);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));

    const index = [];
    let start = 0;
    for (let m = 0; m < this.runs.length; m++) {
      const run = this.runs[m];
      for (let i = 0; i < run.length; i++) index.push(run[i]);
      if (run.length) g.addGroup(start, run.length, m);
      start += run.length;
    }
    g.setIndex(index);
    g.computeVertexNormals();

    // Weld normals across every tube/sphere seam, or the duplicated column of
    // vertices at u = 0 / u = 1 shows as a hard crease down the limb.
    const nrm = g.attributes.normal.array;
    for (let i = 0; i < this.seams.length; i += 2) {
      const a = this.seams[i] * 3, b = this.seams[i + 1] * 3;
      const x = nrm[a] + nrm[b], y = nrm[a + 1] + nrm[b + 1], z = nrm[a + 2] + nrm[b + 2];
      const l = Math.hypot(x, y, z) || 1;
      nrm[a] = nrm[b] = x / l;
      nrm[a + 1] = nrm[b + 1] = y / l;
      nrm[a + 2] = nrm[b + 2] = z / l;
    }
    g.attributes.normal.needsUpdate = true;
    g.computeBoundingSphere();
    return g;
  }
}

/* ====================================================================== */
/* Weight helpers                                                         */
/* ====================================================================== */

/**
 * Blend along a bone chain. `stops` is [[tCentre, boneName], ...] and the
 * weight ramps linearly between adjacent stops, so a knee bends without the
 * candy-wrapper pinch a hard assignment gives.
 */
function chain(stops) {
  const idx = stops.map((s) => BONE_INDEX[s[1]]);
  const ts = stops.map((s) => s[0]);
  const out = [0, 1, 0, 0];
  return (t) => {
    if (t <= ts[0]) { out[0] = idx[0]; out[1] = 1; out[2] = idx[0]; out[3] = 0; return out; }
    const last = ts.length - 1;
    if (t >= ts[last]) { out[0] = idx[last]; out[1] = 1; out[2] = idx[last]; out[3] = 0; return out; }
    let i = 0;
    while (i < last && t > ts[i + 1]) i++;
    const f = (t - ts[i]) / (ts[i + 1] - ts[i] || 1);
    // smoothstep the blend so the transition band is soft at both ends
    const s = f * f * (3 - 2 * f);
    out[0] = idx[i]; out[1] = 1 - s;
    out[2] = idx[i + 1]; out[3] = s;
    return out;
  };
}

function single(name) {
  const i = BONE_INDEX[name];
  const out = [i, 1, i, 0];
  return () => out;
}

/* ====================================================================== */
/* Material groups                                                        */
/* ====================================================================== */

export const MAT = {
  skin: 0,
  face: 1,
  shirt: 2,
  pants: 3,
  leather: 4,
  sole: 5,
  hair: 6,
  eye: 7,
};
const MAT_COUNT = 8;

/* ====================================================================== */
/* The body                                                               */
/* ====================================================================== */

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Piecewise profile: `[[t, r], ...]` with smooth (cosine) interpolation between
 * the stops. Authoring a limb as a handful of measured radii reads far better
 * than stacking gaussian bumps and guessing what they sum to.
 */
function prof(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys.length - 1;
  if (t >= keys[last][0]) return keys[last][1];
  let i = 0;
  while (i < last && t > keys[i + 1][0]) i++;
  const f = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const e = 0.5 - 0.5 * Math.cos(f * Math.PI);
  return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * e;
}

/**
 * C1 profile with SECANT tangents — Catmull-Rom on non-uniform knots.
 *
 * `prof()` above blends with a cosine, which has ZERO slope at every stop. On a
 * curve that is meant to be a smooth taper that is a defect: the curve flattens
 * at each knot and the CURVATURE has to reverse to get to the next one. On the
 * skull's width/depth tables that shows as horizontal bands ringing the face —
 * MEASURED as full-width rows in the laplacian of the emitted depth map at
 * y = -0.011, -0.037 and -0.065, which are exactly the three stops. A secant
 * tangent carries the slope through the knot and the bands go with it.
 *
 * Not a replacement for `prof()`: a limb radius WANTS a stop it settles at.
 */
function profSmooth(t, keys) {
  const last = keys.length - 1;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[last][0]) return keys[last][1];
  let i = 0;
  while (i < last && t > keys[i + 1][0]) i++;
  const x0 = keys[i][0], x1 = keys[i + 1][0];
  const y0 = keys[i][1], y1 = keys[i + 1][1];
  const h = x1 - x0;
  const s = (t - x0) / h;
  const mL = i > 0 ? (y1 - keys[i - 1][1]) / (x1 - keys[i - 1][0]) : (y1 - y0) / h;
  const mR = i + 2 <= last ? (keys[i + 2][1] - y0) / (keys[i + 2][0] - x0) : (y1 - y0) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * mL
    + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * mR;
}

/** Smooth 0..1 bump centred on `c` with half-width `w`. */
function bump(x, c, w) {
  const d = (x - c) / w;
  return d <= -1 || d >= 1 ? 0 : Math.cos(d * Math.PI * 0.5) ** 2;
}

/* ====================================================================== */
/* Torso shell — shared by the shirt tube and everything sewn onto it      */
/* ====================================================================== */

/**
 * The torso is one swept tube, and every garment part (placket, zip, pocket,
 * yoke seam, chest strap) has to sit a few millimetres PROUD of it. Those parts
 * used to carry hand-copied z constants, which is how a pocket ends up half
 * inside a chest on the one brother whose `chest` scalar moved. The profile
 * lives here once and the garment reads the same functions the shirt is swept
 * from, so a patch is always exactly `standoff` off the surface it is sewn to.
 */
function torsoPath(P, S) {
  const hipY = P.hips[1], chestY = P.chest[1], neckY = P.neck[1];
  return [
    [0, hipY - 0.10 * S, 0.004 * S],
    [0, hipY + 0.03 * S, 0.006 * S],
    [0, lerp(hipY, chestY, 0.45), 0.004 * S],
    [0, chestY, -0.002 * S],
    [0, lerp(chestY, neckY, 0.62), -0.006 * S],
    [0, neckY + 0.052 * S, -0.012 * S],
  ];
}

/**
 * `bulk` is the GARMENT's own thickness: a canvas work shirt over a base layer
 * stands further off the ribs than a nylon shell does, and that difference is
 * half of what makes the three brothers read apart in silhouette at 20 m. It
 * only applies above the waist — a jacket does not thicken the hips.
 */
function torsoRX(t, build, ID) {
  const sh = build.shoulder ?? 1;
  const r = prof(t, [
    [0.00, 0.138], [0.10, 0.150], [0.34, 0.132 * (build.waist ?? 1)], [0.52, 0.140],
    [0.70, 0.156 * (build.chest ?? 1)], [0.80, 0.172 * sh], [0.88, 0.166 * sh],
    [0.94, 0.132 * sh], [1.00, 0.062],
  ]);
  return r + (ID?.bulk ?? 0) * Math.min(1, Math.max(0, (t - 0.28) / 0.26)) * (1 - bump(t, 1.0, 0.14));
}

function torsoRZ(t, build, ID) {
  const r = prof(t, [
    [0.00, 0.098], [0.10, 0.106], [0.34, 0.094 * (build.waist ?? 1)], [0.52, 0.104],
    [0.70, 0.118 * (build.chest ?? 1)], [0.80, 0.116], [0.88, 0.110],
    [0.94, 0.090], [1.00, 0.056],
  ]);
  return r + (ID?.bulk ?? 0) * Math.min(1, Math.max(0, (t - 0.28) / 0.26)) * (1 - bump(t, 1.0, 0.14));
}

/**
 * Flatten the front and back — a human torso is an oval, not a cylinder — and
 * leave a shallow groove down the spine.
 *
 * MEASURED, not assumed. The previous version rode `max(0, sin(a))` and put the
 * spine groove down the CHEST. A differential on the emitted hull at the
 * groove's own centre height — same build, groove term on and off — moves the
 * BACK by -5.33 mm and the front by 0.00 mm under `max(0, -sin(a))`, so this
 * sweep's frame has `sin(a) = +1` at the front and the groove belongs on the
 * negative lobe. Re-measure before flipping it back.
 */
function torsoShape(a, t) {
  const front = Math.sin(a);
  let m = 1 - 0.055 * Math.abs(front);
  m -= 0.05 * Math.max(0, -front) * bump(t, 0.72, 0.4); // spine groove
  return m;
}

/** Torso surface point (world) at path parameter t and sweep angle a. */
const _tsC = [0, 0, 0];
function torsoSurface(P, build, S, ID, t, a, out) {
  crEval(torsoPath(P, S), t, _tsC);
  const m = torsoShape(a, t);
  const rx = torsoRX(t, build, ID) * S * m;
  const rz = torsoRZ(t, build, ID) * S * m;
  out[0] = _tsC[0] - Math.cos(a) * rx;
  out[1] = _tsC[1];
  out[2] = _tsC[2] - Math.sin(a) * rz;
  return out;
}

/** The path parameter whose height is `y`. The sweep's y is monotone in t. */
function torsoTOfY(P, S, y) {
  const path = torsoPath(P, S);
  let lo = 0, hi = 1;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) * 0.5;
    crEval(path, mid, _tsC);
    if (_tsC[1] < y) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Build the whole body. Returns { geometry, skeleton } — the caller wraps it in
 * a SkinnedMesh with the material array.
 */
export function buildBody(build) {
  const sk = buildSkeleton(build);
  const P = sk.positions;
  const S = build.scale ?? 1;
  const G = build.limb ?? 1; // limb girth
  const CH = build.chest ?? 1;
  const WA = build.waist ?? 1;
  const ID = identityOf(build);
  const B = new BodyBuilder(MAT_COUNT);

  const r2 = [0, 0];
  const mk = (rx, rz) => { r2[0] = rx; r2[1] = rz; return r2; };

  /* ---------------------------------------------------------- torso ---- */
  // The shirt IS the torso: there is no naked body under it to see through,
  // and one surface means one silhouette without an inter-penetration seam.
  {
    const neckY = P.neck[1];
    B.tube({
      material: MAT.shirt,
      path: torsoPath(P, S),
      rings: 26,
      radial: 22,
      uvV: 11,
      uvU: 8,
      capStart: true,
      capEnd: true,
      // t: 0 hem -> 1 base of the neck. Measured half-widths for a 46 cm
      // shoulder span once the deltoids (which belong to the ARM tube) are
      // added on top at +-0.176.
      radius: (t) => mk(torsoRX(t, build, ID) * S, torsoRZ(t, build, ID) * S),
      shape: torsoShape,
      weight: chain([[0.0, 'hips'], [0.3, 'hips'], [0.5, 'spine'], [0.78, 'chest'], [1, 'chest']]),
    });

    // Collar: a folded band standing proud of the neck hole.
    B.tube({
      material: MAT.shirt,
      path: [
        [0, neckY - 0.028 * S, -0.010 * S],
        [0, neckY + 0.026 * S, -0.018 * S],
      ],
      rings: 5,
      radial: 18,
      uvV: 16,
      uvU: 7,
      radius: (t) => mk((0.074 + t * 0.020) * S, (0.066 + t * 0.020) * S),
      weight: chain([[0, 'chest'], [1, 'neck']]),
      // Opens at the THROAT. Same frame as the torso: sin(a) = +1 at the front.
      shape: (a) => 1 - 0.16 * Math.max(0, Math.sin(a)),
    });

    buildGarment(B, P, build, S, ID);
  }

  /* ----------------------------------------------------------- belt ---- */
  {
    const y = P.hips[1] - 0.055 * S;
    B.tube({
      material: MAT.leather,
      path: [[0, y - 0.021 * S, 0.004 * S], [0, y + 0.021 * S, 0.004 * S]],
      rings: 3,
      radial: 22,
      uvV: 10,
      uvU: 6,
      radius: () => mk(0.150 * S * WA, 0.104 * S * WA),
      weight: single('hips'),
      shape: (a) => 1 - 0.05 * Math.abs(Math.sin(a)),
    });
    // buckle
    B.tube({
      material: MAT.sole,
      path: [[0, y, -0.108 * S * WA], [0, y, -0.121 * S * WA]],
      rings: 2,
      radial: 4,
      uvV: 8,
      radius: () => mk(0.026 * S, 0.019 * S),
      capStart: true,
      capEnd: true,
      weight: single('hips'),
    });
  }

  /* ----------------------------------------------------------- neck ---- */
  {
    const y0 = P.chest[1] + 0.048 * S;
    const y1 = P.head[1] + 0.012 * S;
    // MAT.skin, not MAT.face. `face` now carries a NON-tiling atlas painted in
    // the skull's own (theta, phi) — a tube swept up the neck cannot sample it
    // (its v is arclength) and would drag the mouth up the throat. Both come
    // out of `makeSkin` with the same base and shadow tones, so the only
    // difference across the jawline is the tiling rate of the pore detail.
    B.tube({
      material: MAT.skin,
      path: [[0, y0, 0.010 * S], [0, lerp(y0, y1, 0.5), -0.002 * S], [0, y1 + 0.03 * S, -0.008 * S]],
      rings: 8,
      radial: 16,
      uvV: 4,
      capStart: true,
      radius: (t) => {
        const n = build.neck ?? 1;
        const k = prof(t, [[0, 0.062], [0.35, 0.052], [0.8, 0.048], [1, 0.043]]);
        return mk(k * n * S, (k * 0.94) * n * S);
      },
      // Sternocleidomastoid: two soft ridges down the front of the neck.
      shape: (a, t) => 1 + 0.07 * Math.max(0, -Math.sin(a)) * Math.abs(Math.cos(a)) * (1 - t),
      weight: chain([[0, 'chest'], [0.35, 'neck'], [1, 'head']]),
    });
  }

  /* ----------------------------------------------------------- head ---- */
  buildHead(B, P, build, S);

  /* ------------------------------------------------------------ arms --- */
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    const sh = P['arm' + side];
    const el = P['forearm' + side];
    const wr = P['hand' + side];
    const he = P['handEnd' + side];

    // Deltoid + upper arm, in skin (the sleeve covers its top half).
    //
    // THE CROWN IS LOWER AND NARROWER THAN IT WAS, and that is the fix for the
    // "puffed shoulder" read. The crown used to stand 52 mm above the joint at
    // r = 0.050, which is a ball, not a deltoid — and because the sleeve cap has
    // to CLEAR the crown (see the sleeve below, and `shirtprobe.mjs`), every
    // millimetre of crown was paid for twice: once in skin and again in the
    // fabric domed over it. Dropping it to 36 mm at r = 0.042 lets the cap come
    // down with it, and 0.042 * 2 + the acromion is still a real deltoid — the
    // shoulder POINT now sits at the acromion where a human's does, instead of
    // 16 mm above it.
    //
    // `build.sleeveShrink` reverts BOTH halves of the pre-fix shoulder — the
    // tall crown here and the open sleeve below — because they are one defect
    // and reverting only the sleeve understates it. Measured on the shirtcam
    // control: crown+sleeve 1525 exposed pixels, sleeve alone 364. Both are
    // decisively red against a zero gate, but the control is worth keeping at
    // its full strength rather than at a quarter of it.
    const preFix = build.sleeveShrink === true;
    B.tube({
      material: MAT.skin,
      path: [
        [sh[0] - s * 0.012 * S, sh[1] + (preFix ? 0.052 : 0.036) * S, sh[2]],
        [sh[0], sh[1] - 0.02 * S, sh[2]],
        [lerp(sh[0], el[0], 0.55), lerp(sh[1], el[1], 0.55), lerp(sh[2], el[2], 0.55) + 0.004 * S],
        [el[0], el[1], el[2]],
      ],
      rings: 14,
      radial: 14,
      uvV: 9,
      uvU: 3,
      capStart: true,
      radius: (t) => {
        const r = prof(t, preFix ? [
          [0.00, 0.050], [0.16, 0.055], [0.48, 0.047], [0.82, 0.039], [1.00, 0.037],
        ] : [
          [0.00, 0.042], [0.16, 0.050], [0.48, 0.046], [0.82, 0.039], [1.00, 0.037],
        ]) * G;
        return mk(r * S, (r * 1.03) * S);
      },
      weight: chain([[0, 'arm' + side], [0.82, 'arm' + side], [1, 'forearm' + side]]),
    });

    // Forearm: oval, thick at the belly, bony at the wrist.
    B.tube({
      material: MAT.skin,
      path: [
        [el[0], el[1] + 0.012 * S, el[2]],
        [lerp(el[0], wr[0], 0.4), lerp(el[1], wr[1], 0.4), lerp(el[2], wr[2], 0.4) - 0.006 * S],
        [wr[0], wr[1], wr[2]],
      ],
      rings: 12,
      radial: 14,
      uvV: 9,
      uvU: 3,
      radius: (t) => {
        const r = prof(t, [
          [0.00, 0.038], [0.24, 0.043], [0.62, 0.033], [1.00, 0.026],
        ]) * G;
        return mk(r * S, (r * (1.14 - t * 0.2)) * S);
      },
      weight: chain([[0, 'forearm' + side], [0.86, 'forearm' + side], [1, 'hand' + side]]),
    });

    buildHand(B, P, build, S, side, s);

    buildSleeve(B, P, build, S, ID, side, s);
  }

  /* ------------------------------------------------------------ legs --- */
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    const hp = P['thigh' + side];
    const kn = P['shin' + side];
    const an = P['foot' + side];
    const to = P['toe' + side];

    // Trouser leg, hip to ankle, with a knee break and a cuff over the boot.
    B.tube({
      material: MAT.pants,
      path: [
        [hp[0], hp[1] + 0.075 * S, hp[2] + 0.006 * S],
        [hp[0] + s * 0.004 * S, hp[1] - 0.06 * S, hp[2] + 0.008 * S],
        [lerp(hp[0], kn[0], 0.55), lerp(hp[1], kn[1], 0.55), lerp(hp[2], kn[2], 0.55) + 0.004 * S],
        [kn[0], kn[1], kn[2]],
        [lerp(kn[0], an[0], 0.55), lerp(kn[1], an[1], 0.55), lerp(kn[2], an[2], 0.55) - 0.008 * S],
        [an[0], an[1] + 0.062 * S, an[2] - 0.012 * S],
      ],
      rings: 26,
      radial: 18,
      uvV: 10,
      uvU: 7,
      capStart: true,
      radius: (t) => {
        // 0 crotch -> 1 cuff. Real measurements: thigh 55 cm around (r 8.8 cm),
        // knee 38 (6.0), calf 37 (5.9), ankle 23 (3.7) plus trouser slack.
        const r = prof(t, [
          [0.00, 0.092], [0.16, 0.087], [0.38, 0.075], [0.55, 0.063],
          [0.62, 0.061], [0.74, 0.066], [0.90, 0.050], [1.00, 0.055],
        ]) * G;
        const depth = prof(t, [
          [0.00, 0.098], [0.16, 0.092], [0.38, 0.079], [0.55, 0.066],
          [0.62, 0.066], [0.74, 0.072], [0.90, 0.052], [1.00, 0.056],
        ]) * G;
        return mk(r * S, depth * S);
      },
      // Slight flatten front-to-back at the shin, and the fabric hangs.
      shape: (a, t) => 1 - 0.04 * Math.abs(Math.sin(a)) * (1 - t) + 0.02 * Math.max(0, Math.sin(a)) * t,
      weight: chain([
        [0.0, 'hips'], [0.12, 'thigh' + side], [0.5, 'thigh' + side],
        [0.62, 'shin' + side], [0.93, 'shin' + side], [1, 'foot' + side],
      ]),
    });

    // Boot: upper, then a proud sole in a second material.
    const bootPath = [
      [an[0], an[1] + 0.085 * S, an[2] - 0.006 * S],
      [an[0], an[1] + 0.018 * S, an[2] + 0.004 * S],
      [an[0], an[1] - 0.028 * S, an[2] - 0.05 * S],
      [to[0], to[1] + 0.012 * S, to[2] - 0.028 * S],
      [to[0], to[1] + 0.016 * S, to[2] - 0.062 * S],
    ];
    B.tube({
      material: MAT.leather,
      path: bootPath,
      rings: 18,
      radial: 14,
      uvV: 8,
      uvU: 3,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const ankle = bump(t, 0.12, 0.3);
        const instep = bump(t, 0.55, 0.4);
        const toeCap = t > 0.88 ? Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.12) ** 2)) : 1;
        const rx = (0.047 + ankle * 0.005 + instep * 0.005) * G * toeCap;
        const rz = (0.046 - ankle * 0.002 - instep * 0.008) * G * toeCap;
        return mk(rx * S, rz * S);
      },
      shape: (a, t) => 1 + 0.1 * Math.max(0, -Math.cos(a)) * 0 + 0.06 * Math.max(0, -Math.sin(a)) * bump(t, 0.5, 0.5),
      weight: chain([[0, 'foot' + side], [0.62, 'foot' + side], [0.86, 'toe' + side], [1, 'toe' + side]]),
    });
    // Sole slab: sits under the boot, wider, with a heel.
    B.tube({
      material: MAT.sole,
      path: [
        [an[0], an[1] - 0.052 * S, an[2] + 0.03 * S],
        [an[0], an[1] - 0.056 * S, an[2] - 0.03 * S],
        [to[0], to[1] - 0.006 * S, to[2] - 0.03 * S],
        [to[0], to[1] - 0.004 * S, to[2] - 0.07 * S],
      ],
      rings: 12,
      radial: 12,
      uvV: 10,
      uvU: 4,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const heel = bump(t, 0.05, 0.2);
        const toeCap = t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) : 1;
        const rx = (0.051 + heel * 0.004) * G * toeCap;
        const rz = (0.016 + heel * 0.008) * G * toeCap;
        return mk(rx * S, rz * S);
      },
      weight: chain([[0, 'foot' + side], [0.6, 'foot' + side], [0.85, 'toe' + side], [1, 'toe' + side]]),
    });
    void s;
  }

  /* ------------------------------------------------------------ seat --- */
  // Bridge the two trouser legs so there is no gap at the crotch.
  {
    const hy = P.hips[1];
    B.tube({
      material: MAT.pants,
      path: [
        [P.thighL[0] * 1.0, hy + 0.05 * S, 0.006 * S],
        [0, hy - 0.055 * S, 0.006 * S],
        [P.thighR[0] * 1.0, hy + 0.05 * S, 0.006 * S],
      ],
      rings: 12,
      radial: 14,
      uvV: 10,
      uvU: 6,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const mid = bump(t, 0.5, 0.6);
        const r = (0.062 + mid * 0.022) * WA;
        return mk((r * 1.12) * S, (r * 0.98) * S);
      },
      weight: chain([[0, 'thighL'], [0.35, 'hips'], [0.65, 'hips'], [1, 'thighR']]),
    });
  }

  const geometry = B.build();
  return { geometry, skeleton: sk };
}

/* ====================================================================== */
/* Wardrobe                                                               */
/* ====================================================================== */

/**
 * Everything sewn onto the torso shell: the front closure, pockets, the yoke
 * seam, and whatever one brother wears that the others do not.
 *
 * THREE GARMENTS, NOT THREE COLOURS. Recolouring one shirt is what made the
 * three men read as one man in three palettes. The pieces here are chosen for
 * what survives a 20 m silhouette:
 *
 *   river    (carson)  canvas work shirt — two flapped chest pockets, a yoke
 *                      seam across the shoulders, a heavy hem band. Bulkiest.
 *   shop     (aidan)   shop shirt — button placket, one pocket, a name patch
 *                      in leather over the heart.
 *   courier  (dylan)   zip shell — a full-length zip in dark rubber, a storm
 *                      flap, and a crossbody strap that breaks the torso
 *                      diagonally. The strap is the read at distance.
 *
 * Everything is placed against `torsoSurface()` rather than against copied
 * constants, so a piece is always exactly `standoff` proud of the fabric it is
 * sewn to on every brother, whatever his chest and waist scalars are.
 */
function buildGarment(B, P, build, S, ID) {
  const r2 = [0, 0];
  const mk = (rx, rz) => { r2[0] = rx; r2[1] = rz; return r2; };
  const hipY = P.hips[1], chestY = P.chest[1], neckY = P.neck[1];
  const p = [0, 0, 0];

  /** A point `off` metres proud of the shirt at height `y`, angle `a`. */
  const on = (y, a, off) => {
    const t = torsoTOfY(P, S, y);
    torsoSurface(P, build, S, ID, t, a, p);
    const c = [0, 0, 0];
    crEval(torsoPath(P, S), t, c);
    const dx = p[0] - c[0], dz = p[2] - c[2];
    const l = Math.hypot(dx, dz) || 1;
    return [p[0] + (dx / l) * off, p[1], p[2] + (dz / l) * off];
  };
  const FRONT = Math.PI * 0.5; // measured: sin(a) = +1 on the chest

  const torsoWeight = chain([
    [0, 'hips'], [0.28, 'hips'], [0.5, 'spine'], [0.8, 'chest'], [1, 'chest'],
  ]);

  /* ---- front closure ---- */
  if (ID.outfit === 'courier') {
    // A zip, not a button placket: dark tape in MAT.sole against a purple
    // shell is the highest-contrast line on any of the three.
    B.tube({
      material: MAT.sole,
      path: [
        on(neckY - 0.020 * S, FRONT, 0.004 * S),
        on(lerp(chestY, neckY, 0.30), FRONT, 0.005 * S),
        on(lerp(hipY, chestY, 0.5), FRONT, 0.005 * S),
        on(hipY - 0.062 * S, FRONT, 0.004 * S),
      ],
      rings: 12,
      radial: 6,
      uvV: 22,
      radius: () => mk(0.011 * S, 0.007 * S),
      weight: torsoWeight,
    });
    // Storm flap: a wider, softer ridge behind the zip so the closure is two
    // steps of relief rather than one welt stuck to a cylinder.
    B.tube({
      material: MAT.shirt,
      path: [
        on(neckY - 0.030 * S, FRONT, 0.001 * S),
        on(lerp(hipY, chestY, 0.62), FRONT, 0.002 * S),
        on(hipY - 0.050 * S, FRONT, 0.001 * S),
      ],
      rings: 10,
      radial: 8,
      uvV: 9,
      radius: () => mk(0.030 * S, 0.008 * S),
      weight: torsoWeight,
    });
  } else {
    // Placket: the button strip down the front, a distinct raised ridge.
    B.tube({
      material: MAT.shirt,
      path: [
        on(neckY - 0.020 * S, FRONT, 0.004 * S),
        on(lerp(chestY, neckY, 0.35), FRONT, 0.006 * S),
        on(lerp(hipY, chestY, 0.5), FRONT, 0.006 * S),
        on(hipY - 0.060 * S, FRONT, 0.004 * S),
      ],
      rings: 10,
      radial: 8,
      uvV: 9,
      radius: () => mk(0.019 * S, 0.010 * S),
      weight: torsoWeight,
    });
    // Buttons. Four discs is four specular highlights down the centre line,
    // and they are the cheapest thing on the model that says "shirt".
    for (let i = 0; i < 4; i++) {
      const y = lerp(hipY + 0.02 * S, neckY - 0.075 * S, i / 3);
      const a0 = on(y, FRONT, 0.010 * S);
      const a1 = on(y, FRONT, 0.016 * S);
      B.tube({
        material: MAT.sole,
        path: [a0, a1],
        rings: 2,
        radial: 6,
        uvV: 6,
        capStart: true,
        capEnd: true,
        radius: () => mk(0.007 * S, 0.007 * S),
        weight: torsoWeight,
      });
    }
  }

  /* ---- chest pockets ---- */
  const pocket = (side, y0, h, halfW, flap) => {
    const a = FRONT + side * 0.42;
    B.tube({
      material: MAT.shirt,
      path: [on(y0 - h, a, 0.001 * S), on(y0, a, 0.006 * S), on(y0 + h, a, 0.001 * S)],
      rings: 6,
      radial: 10,
      uvV: 7,
      uvU: 2,
      capStart: true,
      capEnd: true,
      // Superellipse: a pocket is a rounded rectangle, and a circle in its
      // place reads as a badge.
      shape: (ang) => {
        const c = Math.abs(Math.cos(ang)), s2 = Math.abs(Math.sin(ang));
        return Math.pow(c ** 5 + s2 ** 5, -1 / 5);
      },
      radius: (t) => mk(halfW * (0.86 + 0.14 * Math.sin(t * Math.PI)) * S, 0.010 * S),
      weight: torsoWeight,
    });
    if (!flap) return;
    B.tube({
      material: MAT.shirt,
      path: [on(y0 + h * 0.55, a, 0.006 * S), on(y0 + h * 1.05, a, 0.013 * S)],
      rings: 4,
      radial: 10,
      uvV: 12,
      uvU: 2,
      capStart: true,
      capEnd: true,
      shape: (ang) => {
        const c = Math.abs(Math.cos(ang)), s2 = Math.abs(Math.sin(ang));
        return Math.pow(c ** 5 + s2 ** 5, -1 / 5);
      },
      radius: () => mk(halfW * 1.06 * S, 0.006 * S),
      weight: torsoWeight,
    });
  };

  if (ID.outfit === 'river') {
    pocket(1, lerp(chestY, neckY, 0.02), 0.046 * S, 0.044, true);
    pocket(-1, lerp(chestY, neckY, 0.02), 0.046 * S, 0.044, true);
  } else if (ID.outfit === 'shop') {
    pocket(1, lerp(chestY, neckY, 0.02), 0.042 * S, 0.040, false);
    // Name patch — an oval of leather over the heart. The one piece of the
    // outfit that is a different MATERIAL, so it reads at any light level.
    const a = FRONT - 0.42;
    const y = lerp(chestY, neckY, 0.06);
    B.tube({
      material: MAT.leather,
      path: [on(y, a, 0.003 * S), on(y, a, 0.008 * S)],
      rings: 3,
      radial: 12,
      uvV: 4,
      uvU: 2,
      capStart: true,
      capEnd: true,
      axis: [0, 1, 0],
      radius: () => mk(0.019 * S, 0.036 * S),
      weight: torsoWeight,
    });
  }

  /* ---- yoke seam / hem band ---- */
  // A welt ring round the chest at the shoulder line. Real work shirts are cut
  // with a yoke and the seam catches light across the whole back; without it
  // the torso is one unbroken sweep from hem to collar.
  if (ID.outfit !== 'courier') {
    const yY = lerp(chestY, neckY, 0.72);
    const tY = torsoTOfY(P, S, yY);
    B.tube({
      material: MAT.shirt,
      path: [
        [0, yY - 0.006 * S, 0],
        [0, yY + 0.006 * S, 0],
      ],
      rings: 3,
      radial: 22,
      uvV: 26,
      uvU: 5,
      radius: () => mk(
        (torsoRX(tY, build, ID) + 0.0026) * S,
        (torsoRZ(tY, build, ID) + 0.0026) * S
      ),
      shape: torsoShape,
      weight: single('chest'),
    });
  }

  // Hem band: the shirt stops somewhere, and a doubled hem is what stops it.
  {
    const yH = hipY - 0.086 * S;
    const tH = torsoTOfY(P, S, yH);
    B.tube({
      material: MAT.shirt,
      path: [[0, yH - 0.012 * S, 0.004 * S], [0, yH + 0.010 * S, 0.004 * S]],
      rings: 3,
      radial: 22,
      uvV: 22,
      uvU: 5,
      radius: () => mk(
        (torsoRX(tH, build, ID) + 0.0032) * S,
        (torsoRZ(tH, build, ID) + 0.0032) * S
      ),
      shape: torsoShape,
      weight: single('hips'),
    });
  }

  /* ---- courier strap ---- */
  if (ID.outfit === 'courier') {
    // Right shoulder to left hip. A diagonal is the only line on a human
    // torso that cannot be mistaken for anatomy, which is exactly why it
    // works as an identity read from behind and at distance.
    const yTop = lerp(chestY, neckY, 0.78);
    const yMid = lerp(hipY, chestY, 0.55);
    const yLow = hipY - 0.010 * S;
    B.tube({
      material: MAT.leather,
      path: [
        on(yTop, FRONT + 1.05, 0.008 * S),
        on(lerp(yMid, yTop, 0.55), FRONT + 0.55, 0.010 * S),
        on(yMid, FRONT - 0.10, 0.010 * S),
        on(yLow, FRONT - 0.66, 0.008 * S),
      ],
      rings: 14,
      radial: 6,
      uvV: 14,
      uvU: 2,
      capStart: true,
      capEnd: true,
      radius: () => mk(0.024 * S, 0.007 * S),
      weight: chain([[0, 'chest'], [0.45, 'chest'], [0.8, 'spine'], [1, 'hips']]),
    });
    // The same strap over the back, so it is a loop and not a stuck-on sash.
    B.tube({
      material: MAT.leather,
      path: [
        on(yTop, FRONT + 1.05, 0.008 * S),
        on(lerp(yMid, yTop, 0.5), FRONT + Math.PI * 0.72, 0.010 * S),
        on(yMid, FRONT + Math.PI * 1.06, 0.010 * S),
        on(yLow, FRONT - 0.66, 0.008 * S),
      ],
      rings: 14,
      radial: 6,
      uvV: 14,
      uvU: 2,
      capStart: true,
      capEnd: true,
      radius: () => mk(0.022 * S, 0.007 * S),
      weight: chain([[0, 'chest'], [0.45, 'chest'], [0.8, 'spine'], [1, 'hips']]),
    });
  }
}

/**
 * The sleeve — a set-in garment shell that CAPS over the top of the shoulder
 * (the acromion / deltoid crown) and then runs as far down the arm as the
 * brother's outfit says.
 *
 * WHY THE TOP IS CLOSED. The upper arm is drawn in skin and its crown sits
 * proud of the joint. The pre-fix sleeve started INBOARD and LOW
 * (sh.x - 0.085, sh.y - 0.004), open at both ends, so it never domed over that
 * crown: a ring of bare skin showed at the acromion, and it widened as the arm
 * lifted because the torso (chest-weighted) receded from under the shoulder
 * while the crown did not. Measured exposed superior-shoulder skin before the
 * fix: carson 15343 mm2 / aidan 10441 / dylan 4079 at rest, ~30k raised. The
 * cap is weighted 100% to the arm bone, exactly like the skin crown it covers,
 * so the two are locked together: a cap that clears the crown in the bind pose
 * clears it under EVERY arm rotation. `shirtprobe.mjs` and `shirtcamprobe.mjs`
 * are the gates.
 *
 * WHY THE CAP IS SMALLER THAN IT WAS. It used to apex 76 mm above the joint at
 * r = 0.070 — a sphere sitting on a shoulder, which is the "puffed shoulder"
 * the review named. That size was forced by the skin crown underneath, which
 * has now come down to +36 mm / r 0.042 (see the deltoid tube), so the cap
 * comes down with it. Coverage is unchanged because the CLEARANCE is unchanged;
 * only the pair of radii moved, together.
 *
 * NEGATIVE CONTROL: `build.sleeveShrink === true` reverts this to the pre-fix
 * sleeve — inboard, low, open at the top — which re-opens the acromion gap.
 * Both shirt gates run it and assert they go RED.
 */
function buildSleeve(B, P, build, S, ID, side, s) {
  const G = build.limb ?? 1;
  const sh = P['arm' + side], el = P['forearm' + side], wr = P['hand' + side];
  const r2 = [0, 0];
  const mk = (rx, rz) => { r2[0] = rx; r2[1] = rz; return r2; };

  /** p in [0,1] runs shoulder -> elbow, [1,2] elbow -> wrist. */
  const at = (p) => (p <= 1
    ? [lerp(sh[0], el[0], p), lerp(sh[1], el[1], p), lerp(sh[2], el[2], p)]
    : [lerp(el[0], wr[0], p - 1), lerp(el[1], wr[1], p - 1), lerp(el[2], wr[2], p - 1)]);

  if (build.sleeveShrink === true) {
    B.tube({
      material: MAT.shirt,
      path: [
        [sh[0] - s * 0.085 * S, sh[1] - 0.004 * S, sh[2] - 0.004 * S],
        [sh[0] - s * 0.010 * S, sh[1] - 0.012 * S, sh[2]],
        at(0.40), at(0.50),
      ],
      rings: 14,
      radial: 16,
      uvV: 12,
      uvU: 6,
      radius: (t) => {
        const r = prof(t, [
          [0.00, 0.052], [0.16, 0.064], [0.34, 0.062], [0.70, 0.053], [0.90, 0.050], [1.00, 0.054],
        ]) * G;
        return mk(r * S, r * 1.04 * S);
      },
      weight: chain([[0, 'arm' + side], [0.1, 'arm' + side], [1, 'arm' + side]]),
    });
    return;
  }

  // The cap, identical for all three outfits. Apex centred over the skin crown
  // (sh.x - 0.012, sh.y + 0.036) so it domes symmetrically rather than swinging
  // off the outboard side.
  const CAP = [
    [sh[0] - s * 0.012 * S, sh[1] + 0.056 * S, sh[2] + 0.004 * S],
    [sh[0] - s * 0.004 * S, sh[1] + 0.024 * S, sh[2]],
    at(0.12),
  ];

  /**
   * [path, radius stops, weight stops, armhole seam t, hem t, hem radius].
   * The radius stops are in the tube's own t, which `crEval` distributes
   * uniformly over control-point index — so one stop per control point.
   */
  const V = {
    rolledShort: {
      path: [...CAP, at(0.30), at(0.44), at(0.52)],
      rings: 22,
      r: [[0.00, 0.030], [0.10, 0.050], [0.22, 0.058], [0.46, 0.056], [0.74, 0.052], [1.00, 0.050]],
      w: [[0, 'arm' + side], [1, 'arm' + side]],
      seam: 0.24,
      roll: [at(0.48), at(0.60)],
      rollR: [0.059, 0.053],
      rollW: [[0, 'arm' + side], [1, 'arm' + side]],
    },
    rolledLong: {
      // Rolled to just below the elbow: the forearms are the part of a river
      // hand you are meant to notice.
      path: [...CAP, at(0.34), at(0.62), at(0.90), at(1.10), at(1.34)],
      // RINGS SCALE WITH PATH LENGTH. Twenty-two rings over a sleeve twice as
      // long puts three rings across the cap instead of eight, and the straight
      // chord between two coarse rings cuts INSIDE the deltoid it is meant to
      // dome over — which is exactly how dylan's cuffed sleeve leaked 26 rays
      // at rest while the identical cap on aidan leaked none.
      rings: 30,
      r: [[0.00, 0.030], [0.09, 0.050], [0.19, 0.058], [0.40, 0.058], [0.58, 0.055],
        [0.74, 0.051], [0.88, 0.049], [1.00, 0.047]],
      w: [[0, 'arm' + side], [0.66, 'arm' + side], [0.80, 'forearm' + side], [1, 'forearm' + side]],
      seam: 0.17,
      roll: [at(1.28), at(1.52)],
      rollR: [0.055, 0.048],
      rollW: [[0, 'forearm' + side], [1, 'forearm' + side]],
    },
    cuffed: {
      path: [...CAP, at(0.38), at(0.70), at(0.96), at(1.34), at(1.72), at(1.96)],
      rings: 34,
      r: [[0.00, 0.032], [0.125, 0.056], [0.25, 0.056], [0.38, 0.053], [0.52, 0.050],
        [0.66, 0.047], [0.80, 0.042], [0.92, 0.035], [1.00, 0.031]],
      w: [[0, 'arm' + side], [0.55, 'arm' + side], [0.72, 'forearm' + side],
        [0.95, 'forearm' + side], [1, 'hand' + side]],
      seam: 0.15,
      roll: [at(1.92), at(2.06)],
      rollR: [0.033, 0.030],
      rollW: [[0, 'forearm' + side], [0.6, 'hand' + side], [1, 'hand' + side]],
    },
  }[ID.sleeve] ?? null;

  const v = V ?? {
    path: [...CAP, at(0.30), at(0.44), at(0.52)],
    rings: 22,
    r: [[0.00, 0.030], [0.10, 0.050], [0.22, 0.058], [0.46, 0.056], [0.74, 0.052], [1.00, 0.050]],
    w: [[0, 'arm' + side], [1, 'arm' + side]],
    seam: 0.24,
    roll: [at(0.48), at(0.60)],
    rollR: [0.059, 0.053],
    rollW: [[0, 'arm' + side], [1, 'arm' + side]],
  };

  B.tube({
    material: MAT.shirt,
    path: v.path,
    rings: v.rings,
    radial: 16,
    uvV: 12,
    uvU: 6,
    // capStart closes the apex over the acromion; the hem stays open.
    capStart: true,
    // The armhole welt: 2.2 mm of relief where the sleeve is set into the
    // body. It is what makes the shoulder read as a SEAM instead of a bulge,
    // and it costs nothing — it is a term in a radius function.
    radius: (t) => {
      const r = (prof(t, v.r) + 0.0022 * bump(t, v.seam, 0.055)) * G;
      return mk(r * S, r * 1.04 * S);
    },
    weight: chain(v.w),
  });

  // Rolled cuff / knit cuff: a short fatter band over the sleeve's own hem, so
  // the opening is a doubled edge rather than a cut-off cylinder.
  B.tube({
    material: MAT.shirt,
    path: v.roll,
    rings: 5,
    radial: 16,
    uvV: 20,
    uvU: 6,
    capEnd: true,
    radius: (t) => {
      const k = prof(t, [[0, v.rollR[0]], [0.55, v.rollR[0] * 1.03], [1, v.rollR[1]]]) * G;
      return mk(k * S, k * 1.04 * S);
    },
    weight: chain(v.rollW),
  });
}

/**
 * The hand. Five digits, because the player holds a weapon in frame for the
 * whole game and a mitten with a thumb is the first thing a reviewer names.
 *
 * The rig has only `hand` and `handEnd`, so the fingers cannot be animated —
 * they are authored in the RELAXED CURL a hand rests in, roughly 35 degrees of
 * total flexion, which is also close enough to a grip that a weapon in the same
 * hand does not read as being held by a plank. The curl is toward -X * side,
 * the palm side of a hanging arm.
 *
 * NEGATIVE CONTROL: `build.mittHands === true` restores the pre-fix hand — one
 * tapered tube and a thumb, no digits. `handprobe.mjs` asserts the digit count
 * it recovers from the EMITTED geometry falls from 5 to 1 per hand.
 */
function buildHand(B, P, build, S, side, s) {
  const G = build.limb ?? 1;
  const wr = P['hand' + side], he = P['handEnd' + side];
  const r2 = [0, 0];
  const mk = (rx, rz) => { r2[0] = rx; r2[1] = rz; return r2; };
  const W = chain([[0, 'hand' + side], [0.25, 'hand' + side], [1, 'handEnd' + side]]);

  if (build.mittHands === true) {
    B.tube({
      material: MAT.skin,
      path: [
        [wr[0], wr[1], wr[2]],
        [lerp(wr[0], he[0], 0.35), lerp(wr[1], he[1], 0.35), lerp(wr[2], he[2], 0.35) - 0.004 * S],
        [lerp(wr[0], he[0], 0.78), lerp(wr[1], he[1], 0.78), lerp(wr[2], he[2], 0.78)],
        [he[0], he[1], he[2] + 0.004 * S],
      ],
      rings: 12,
      radial: 14,
      uvV: 8,
      uvU: 2,
      capEnd: true,
      radius: (t) => {
        const taper = t > 0.80 ? Math.sqrt(Math.max(0, 1 - ((t - 0.80) / 0.20) ** 2)) : 1;
        const rx = prof(t, [[0, 0.014], [0.3, 0.017], [1, 0.014]]) * G * taper;
        const rz = prof(t, [[0, 0.031], [0.28, 0.044], [0.7, 0.040], [1, 0.032]]) * G * taper;
        return mk(rx * S, rz * S);
      },
      shape: (a, t) => 1 + 0.06 * Math.max(0, Math.sin(a)) * bump(t, 0.55, 0.4),
      weight: W,
    });
    B.tube({
      material: MAT.skin,
      path: [
        [wr[0] - s * 0.006 * S, wr[1] - 0.018 * S, wr[2] - 0.026 * S],
        [wr[0] - s * 0.016 * S, wr[1] - 0.05 * S, wr[2] - 0.044 * S],
        [wr[0] - s * 0.02 * S, wr[1] - 0.078 * S, wr[2] - 0.05 * S],
      ],
      rings: 7,
      radial: 9,
      uvV: 8,
      capEnd: true,
      radius: (t) => {
        const taper = t > 0.7 ? Math.sqrt(Math.max(0, 1 - ((t - 0.7) / 0.3) ** 2)) : 1;
        return mk(0.0125 * G * S * taper, 0.0135 * G * S * taper);
      },
      weight: single('hand' + side),
    });
    return;
  }

  // Knuckle plane: the palm is 52% of wrist-to-fingertip, which is the human
  // ratio and also where the fingers have to start for the hand to be as long
  // as the skeleton says it is.
  const K = [
    lerp(wr[0], he[0], 0.52),
    lerp(wr[1], he[1], 0.52),
    lerp(wr[2], he[2], 0.52),
  ];

  // Palm: a flat block, thicker on the knuckle side (+X * s), with the thenar
  // pad standing off the palm side.
  B.tube({
    material: MAT.skin,
    path: [
      [wr[0], wr[1], wr[2]],
      [lerp(wr[0], K[0], 0.45), lerp(wr[1], K[1], 0.45), lerp(wr[2], K[2], 0.45) - 0.003 * S],
      [K[0], K[1], K[2]],
    ],
    rings: 9,
    radial: 14,
    uvV: 8,
    uvU: 2,
    capEnd: true,
    radius: (t) => {
      const rx = prof(t, [[0, 0.0145], [0.35, 0.0180], [1, 0.0172]]) * G;
      const rz = prof(t, [[0, 0.0300], [0.30, 0.0420], [1, 0.0400]]) * G;
      return mk(rx * S, rz * S);
    },
    // cos(a) is +X in this sweep's frame; the knuckle ridge is on the back of
    // the hand and the thenar pad on the palm side, so both are s-signed.
    shape: (a, t) => 1
      + 0.07 * Math.max(0, Math.cos(a) * s) * bump(t, 0.92, 0.35)
      + 0.10 * Math.max(0, -Math.cos(a) * s) * bump(t, 0.30, 0.5) * Math.max(0, Math.sin(a)),
    weight: W,
  });

  /**
   * [name, z offset across the palm, length, base radius]. z is world: the arm
   * hangs with the palm facing the thigh, so the fingers spread front-to-back
   * and the index is the FORWARD one.
   */
  const FINGERS = [
    ['index', -0.0300, 0.066, 0.0086],
    ['middle', -0.0100, 0.070, 0.0088],
    ['ring', 0.0100, 0.064, 0.0082],
    ['little', 0.0295, 0.052, 0.0072],
  ];

  for (const [, z, len, rad] of FINGERS) {
    const L = len * S;
    const zz = z * S * G;
    // Fan: the tips spread slightly wider than the knuckles, which is what a
    // relaxed hand does and what stops four parallel rods reading as a comb.
    const fan = z * 0.28;
    const base = [K[0], K[1], K[2] + zz];
    B.tube({
      material: MAT.skin,
      path: [
        base,
        [base[0] - s * 0.06 * L, base[1] - 0.40 * L, base[2] + fan * 0.30 * S],
        [base[0] - s * 0.30 * L, base[1] - 0.71 * L, base[2] + fan * 0.75 * S],
        [base[0] - s * 0.56 * L, base[1] - 0.86 * L, base[2] + fan * 1.00 * S],
      ],
      rings: 9,
      radial: 7,
      uvV: 16,
      uvU: 2,
      capStart: true,
      radius: (t) => {
        const tip = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1;
        // Knuckle swellings at the two interphalangeal joints — a finger that
        // tapers smoothly is a cone, not a finger.
        const k = (prof(t, [[0, 1.0], [0.4, 0.90], [0.75, 0.84], [1, 0.80]])
          + 0.06 * bump(t, 0.38, 0.13) + 0.05 * bump(t, 0.70, 0.13)) * rad * G;
        return mk(k * tip * S, k * 1.06 * tip * S);
      },
      weight: chain([[0, 'hand' + side], [0.18, 'handEnd' + side], [1, 'handEnd' + side]]),
    });
  }

  // Thumb: off the base of the palm, forward and across, with the metacarpal
  // and the phalanx at different angles so it opposes the fingers.
  B.tube({
    material: MAT.skin,
    path: [
      [wr[0] - s * 0.004 * S, wr[1] - 0.014 * S, wr[2] - 0.020 * S],
      [wr[0] - s * 0.014 * S, wr[1] - 0.040 * S, wr[2] - 0.044 * S],
      [wr[0] - s * 0.026 * S, wr[1] - 0.062 * S, wr[2] - 0.052 * S],
      [wr[0] - s * 0.038 * S, wr[1] - 0.074 * S, wr[2] - 0.048 * S],
    ],
    rings: 9,
    radial: 8,
    uvV: 14,
    uvU: 2,
    capStart: true,
    radius: (t) => {
      const tip = t > 0.84 ? Math.sqrt(Math.max(0, 1 - ((t - 0.84) / 0.16) ** 2)) : 1;
      const k = (prof(t, [[0, 0.0142], [0.34, 0.0122], [0.66, 0.0110], [1, 0.0100]])
        + 0.0007 * bump(t, 0.55, 0.16)) * G;
      return mk(k * tip * S, k * 1.05 * tip * S);
    },
    weight: single('hand' + side),
  });
}

/* ====================================================================== */
/* Head                                                                   */
/* ====================================================================== */

/**
 * The head is an ellipsoid pushed around by a list of gaussian "features".
 * Each feature is evaluated against the UNDEFORMED surface point so the
 * displacements compose predictably.
 *
 * Feature = [cx, cy, cz, sx, sy, sz, dx, dy, dz, amount]
 * (centre, gaussian half-widths, push direction, magnitude — all in head-local
 * metres for a 1.78 m body).
 */
function buildHead(B, P, build, S) {
  const hb = P.head; // head bone, bind space
  const hs = (build.headScale ?? 1) * S;
  const ID = identityOf(build);
  const F = ID.face;
  // `noIdentity` removes ALL per-brother facial authoring, not just this
  // module's table — brothers.js's jaw/brow/nose scalars too. That makes the
  // control's three faces literally the same shape, so `identityprobe.mjs`
  // gate 1 has a zero to measure against instead of a residual.
  const flat = build.noIdentity === true;
  const jaw = flat ? 1 : (build.jaw ?? 1);
  const brow = flat ? 1 : (build.brow ?? 1);
  const nose = flat ? 1 : (build.nose ?? 1);

  // Skull centre relative to the head bone.
  const c = [hb[0], hb[1] + 0.096 * hs, hb[2] + 0.004 * hs];
  // 143 x 214 x 191 mm — a measured male head. The first version was 167 mm
  // wide, and a head that broad turns every facial feature into a dimple.
  const r = [0.0715 * hs, 0.108 * hs, 0.0935 * hs];

  const EYE_X = 0.0305 * hs, EYE_Y = 0.008 * hs, EYE_Z = -0.070 * hs;

  /**
   * Fewer, cleaner features. An earlier version had thirty-four overlapping
   * gaussians and they fought each other into a lumpy caricature; at the range
   * a third-person camera actually sits, what reads is the SILHOUETTE (brow,
   * nose wedge, jaw, chin) and the VALUE (dark sockets, dark hair) — not
   * micro-anatomy. Everything that did not contribute to one of those is gone.
   *
   * THE IDENTITY BLOCK BELOW is what makes the three heads three men rather
   * than one head at three magnifications. Every entry is scaled by a named
   * `IDENTITY.face` term, and every one of those terms reaches ZERO on at least
   * one brother — a feature that is merely smaller on Dylan than on Carson
   * reads as the same face slightly resized, which is the failure this is here
   * to fix. `identityprobe.mjs` measures the separation on the emitted surface.
   */
  const feats = [
    // cranium: occiput out at the back, temples in, forehead flattened
    [0, 0.010, 0.066, 0.078, 0.078, 0.050, 0, 0, 1, 0.012],
    [0.060, 0.038, -0.008, 0.024, 0.034, 0.042, -1, 0, 0, 0.010],
    [-0.060, 0.038, -0.008, 0.024, 0.034, 0.042, 1, 0, 0, 0.010],
    [0, 0.062, -0.044, 0.038, 0.026, 0.030, 0, 0, 1, 0.010],

    // brow ridge — the shadow it casts is most of what says "face" at range
    [0.026, 0.031, -0.054, 0.024, 0.013, 0.034, 0, 0.3, -1, 0.018 * brow],
    [-0.026, 0.031, -0.054, 0.024, 0.013, 0.034, 0, 0.3, -1, 0.018 * brow],
    [0, 0.031, -0.066, 0.009, 0.011, 0.022, 0, 0, 1, 0.006],

    // eye sockets + lids
    [0.0305, 0.008, -0.064, 0.022, 0.015, 0.024, 0, 0, 1, 0.020],
    [-0.0305, 0.008, -0.064, 0.022, 0.015, 0.024, 0, 0, 1, 0.020],
    [0.0305, 0.022, -0.056, 0.022, 0.009, 0.022, 0, 0.7, -1, 0.014],
    [-0.0305, 0.022, -0.056, 0.022, 0.009, 0.022, 0, 0.7, -1, 0.014],

    // CHEEKBONE — and the reason it is this soft. It used to push 10 mm
    // forward through a 18 mm-tall gaussian sitting 40 mm above an equally
    // hard mandible push; the VALLEY between the two ran right round the lower
    // face and met under the nose, and every brother had a permanent grin
    // carved into him. Rendered from the front it was the single most
    // disfiguring thing on the model. Taller, softer, less forward.
    [0.046, -0.014, -0.040, 0.022, 0.027, 0.032, 0.75, 0.15, -0.8, 0.0075],
    [-0.046, -0.014, -0.040, 0.022, 0.027, 0.032, -0.75, 0.15, -0.8, 0.0075],

    // MAXILLA. A broad, shallow forward mass filling the band between the
    // cheek and the mouth. MEASURED: a laplacian map of the emitted depth
    // showed a concave line running the FULL WIDTH of the face at y = -0.046,
    // because every forward push in this list sat either above it (brow,
    // cheekbone, nose) or below it (lips, mandible) and nothing filled the
    // gap. From the front that valley reads as a fixed grin, and it was on all
    // three brothers and survived removing every identity gaussian — which is
    // how it was finally traced, after two wrong guesses at the atlas.
    [0, -0.044, -0.052, 0.042, 0.022, 0.030, 0, 0, -1, 0.009],
    [0.030, -0.040, -0.046, 0.026, 0.022, 0.026, 0.25, 0, -1, 0.006],
    [-0.030, -0.040, -0.046, 0.026, 0.022, 0.026, -0.25, 0, -1, 0.006],

    // NOSE: a narrow wedge from between the brows to a projecting tip
    [0, 0.018, -0.070, 0.008, 0.017, 0.020, 0, 0, -1, 0.011 * nose],
    [0, -0.008, -0.074, 0.009, 0.014, 0.020, 0, 0, -1, 0.020 * nose],
    [0, -0.026, -0.076, 0.011, 0.010, 0.020, 0, 0, -1, 0.028 * nose],
    [0, -0.037, -0.070, 0.010, 0.006, 0.016, 0, -0.8, 0.6, 0.012 * nose],
    [0.014, -0.032, -0.064, 0.008, 0.009, 0.017, 0.85, -0.2, -0.9, 0.011 * nose],
    [-0.014, -0.032, -0.064, 0.008, 0.009, 0.017, -0.85, -0.2, -0.9, 0.011 * nose],

    // Mouth: two lips and the seam between them. The pair used to stand 16 mm
    // proud between them, which with the muzzle-shaped valley round it read as
    // a snout; the LINE between the lips does the work now and it is painted
    // in the atlas as well as cut here.
    [0, -0.055, -0.063, 0.018 * F.mouthW, 0.008, 0.019, 0, 0.3, -1, 0.0055 + 0.0045 * F.lip],
    [0, -0.067, -0.061, 0.017 * F.mouthW, 0.009, 0.019, 0, -0.3, -1, 0.0045 + 0.0055 * F.lip],
    [0, -0.061, -0.065, 0.021 * F.mouthW, 0.0035, 0.017, 0, 0, 1, 0.008],

    // chin pad, with the crease above it. Pushed FORWARD only — an earlier
    // downward component turned the chin into a beak.
    [0, -0.074, -0.056, 0.016, 0.008, 0.015, 0, 0, 1, 0.005],
    [0, -0.084, -0.048, 0.024, 0.020, 0.024, 0, 0, -1, 0.016 * jaw],
    // Mental protuberance: the flat front plane of the mandible, carrying the
    // chin and the jaw forward together instead of leaving the chin as a knob
    // on the end of a slope.
    [0, -0.068, -0.050, 0.034, 0.024, 0.026, 0, 0, -1, 0.011],

    // Mandible line, then the tuck under it into the neck. Softened in y for
    // the same reason as the cheekbone: this is the lower lip of that valley.
    [0.048, -0.054, -0.008, 0.026, 0.030, 0.032, 1, -0.2, 0, 0.0085 * jaw],
    [-0.048, -0.054, -0.008, 0.026, 0.030, 0.032, -1, -0.2, 0, 0.0085 * jaw],
    [0, -0.086, 0.024, 0.046, 0.024, 0.040, 0, 1, 0, 0.011],

    /* ---------------------------------------------------- identity ----
     * AMPLITUDES ARE SMALL AND THAT IS THE LESSON. The first pass of this
     * block ran at roughly twice these numbers and stacked `jawSquare` and
     * `chinW` straight on top of the mandible and chin-pad gaussians that were
     * already there. Rendered, all three brothers came out as lumpy
     * caricatures with a square shelf where the jaw angle should be — the
     * exact failure the note above this list records from the 34-gaussian
     * version. What separates three faces is WHICH features exist, not how far
     * each one is pushed: `bridge` at 9.5 mm on carson and 0 on dylan reads as
     * two different noses; the same pair at 19 mm reads as two deformities.
     * `identityprobe.mjs` gate 1 says the separation survived the climb-down. */
    // Dorsal hump. Carson's nose was broken once; Dylan's line is dead
    // straight, so `bridge` is 0 on him and the gaussian vanishes entirely.
    [0, 0.000, -0.0755, 0.007, 0.013, 0.015, 0, 0.15, -1, 0.0095 * F.bridge],
    // Nostril wings: the difference between a wide working nose and a narrow
    // one is 3 mm of ala, and it is the most legible 3 mm on the whole head.
    [0.0165, -0.0325, -0.0605, 0.0075, 0.0085, 0.015, 1, -0.15, -0.35, 0.0075 * F.alae],
    [-0.0165, -0.0325, -0.0605, 0.0075, 0.0085, 0.015, -1, -0.15, -0.35, 0.0075 * F.alae],
    // Tip: droops on the eldest, lifts on the youngest. Signed, so one term
    // authors both directions.
    [0, -0.031, -0.0775, 0.009, 0.008, 0.014, 0, -1, -0.25, 0.0095 * F.tipDrop],
    // Deep-set eyes: pull the whole socket floor back under the brow.
    [0.0305, 0.006, -0.062, 0.020, 0.016, 0.020, 0, 0, 1, 0.0075 * F.deepEye],
    [-0.0305, 0.006, -0.062, 0.020, 0.016, 0.020, 0, 0, 1, 0.0075 * F.deepEye],
    // Hollow cheek under the zygomatic — weather and years, not weight.
    [0.043, -0.034, -0.050, 0.019, 0.020, 0.024, -0.75, 0, 1, 0.0085 * F.cheekHollow],
    [-0.043, -0.034, -0.050, 0.019, 0.020, 0.024, 0.75, 0, 1, 0.0085 * F.cheekHollow],
    // Nasolabial fold: a crease from the ala down past the mouth corner.
    [0.021, -0.049, -0.062, 0.007, 0.014, 0.013, -0.5, 0, 1, 0.0055 * F.fold],
    [-0.021, -0.049, -0.062, 0.007, 0.014, 0.013, 0.5, 0, 1, 0.0055 * F.fold],
    // Temporal hollow above the cheekbone — the first thing a face loses.
    [0.052, 0.036, -0.032, 0.017, 0.021, 0.021, -1, 0, 0, 0.0055 * F.temple],
    [-0.052, 0.036, -0.032, 0.017, 0.021, 0.021, 1, 0, 0, 0.0055 * F.temple],
    // Brow furrow: one horizontal crease above the ridge.
    [0, 0.048, -0.062, 0.028, 0.005, 0.016, 0, 0, 1, 0.004 * F.furrow],
    // Chin cleft.
    [0, -0.082, -0.053, 0.0045, 0.009, 0.012, 0, 0, 1, 0.006 * F.cleft],
    // Gonial flare — the corner of the jaw, square or tapered.
    [0.044, -0.070, 0.020, 0.017, 0.014, 0.020, 0.8, -0.6, 0.1, 0.0065 * F.jawSquare],
    [-0.044, -0.070, 0.020, 0.017, 0.014, 0.020, -0.8, -0.6, 0.1, 0.0065 * F.jawSquare],
    // Chin width: a slab of a chin on the eldest, a point on the youngest.
    [0.016, -0.081, -0.048, 0.010, 0.012, 0.015, 0.85, 0, -0.4, 0.0050 * F.chinW],
    [-0.016, -0.081, -0.048, 0.010, 0.012, 0.015, -0.85, 0, -0.4, 0.0050 * F.chinW],
  ];

  const headW = single('head');

  /**
   * The skull's silhouette, as measured width/depth scales down the vertical
   * axis. This is what makes a head read as a head rather than an egg: widest
   * at the cheekbones, tapering hard into the chin, and shallower at the crown.
   */
  const WIDTH = [
    [-1.00, 0.28], [-0.82, 0.50], [-0.60, 0.74], [-0.34, 0.90],
    [-0.10, 0.98], [0.14, 1.00], [0.42, 0.97], [0.72, 0.86], [1.00, 0.52],
  ];
  /**
   * THE LOWER HALF OF THIS CURVE IS WHY THE FACE USED TO GRIN. Profiled on the
   * emitted surface, aidan's face fell from z = -0.073 at the cheekbone to
   * -0.020 at the jaw — 53 mm of recession over 54 mm of height, a 45-degree
   * undercut — and the mouth then stood proud out of the middle of it. The
   * boundary between the receding plane and the mouth mound is a hard curved
   * crease sweeping from the nostrils out to the cheeks, and from the front
   * that reads, unmistakably, as a fixed smile. It was on all three brothers
   * and it survived every change to the identity block, which is how it was
   * found: removing every identity gaussian left it exactly where it was.
   *
   * A real head is nearly as deep at the chin as at the brow. These numbers
   * carry the mandible forward so the lower face is a plane the mouth sits IN
   * rather than a slope the mouth sits ON.
   */
  const DEPTH = [
    [-1.00, 0.48], [-0.82, 0.67], [-0.60, 0.82], [-0.34, 0.925],
    [-0.10, 0.985], [0.14, 1.00], [0.42, 0.98], [0.72, 0.90], [1.00, 0.58],
  ];

  const applyFeatures = (dx, dy, dz, p) => {
    // Vertical profile. `jaw` pulls the lower half in or out per brother.
    const yn = Math.max(-1, Math.min(1, (p[1] - c[1]) / r[1]));
    let w = profSmooth(yn, WIDTH);
    let d = profSmooth(yn, DEPTH);
    if (yn < 0) {
      const t = -yn;
      w *= 1 + (jaw - 1) * t * 0.9;
      d *= 1 + (jaw - 1) * t * 0.45;
    }
    p[0] = c[0] + (p[0] - c[0]) * w;
    p[2] = c[2] + (p[2] - c[2]) * d;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const ex = (p[0] - c[0]) / hs - f[0];
      const ey = (p[1] - c[1]) / hs - f[1];
      const ez = (p[2] - c[2]) / hs - f[2];
      const g = Math.exp(-((ex * ex) / (f[3] * f[3]) + (ey * ey) / (f[4] * f[4]) + (ez * ez) / (f[5] * f[5])));
      if (g < 0.02) continue;
      const a = f[9] * g * hs;
      p[0] += f[6] * a;
      p[1] += f[7] * a;
      p[2] += f[8] * a;
    }
  };

  /**
   * The face surface as a function of (theta, phi) — the deformed skull, not
   * the ellipsoid it started as. Anything that has to SIT ON the face rather
   * than near it (eyebrows, the hair fringe) has to be placed against this,
   * because the feature gaussians move the surface by up to 30 mm and geometry
   * authored against the raw ellipsoid ends up buried inside the result.
   */
  const surfaceAt = (theta, phi, out) => {
    const st = Math.sin(theta), ct = Math.cos(theta);
    const dx = st * Math.sin(phi), dy = ct, dz = st * Math.cos(phi);
    out[0] = c[0] + dx * r[0];
    out[1] = c[1] + dy * r[1];
    out[2] = c[2] + dz * r[2];
    applyFeatures(dx, dy, dz, out);
    return out;
  };

  /**
   * Move `p` horizontally (in XZ, keeping its height) until it stands
   * `clearance` proud of the face at that height.
   *
   * The push is deliberately NOT radial from the skull centre: on the forehead
   * a radial push is mostly +Y, so it would undo the very drop the hair fringe
   * had just applied and the fringe would never descend. Real hair falls in
   * FRONT of the brow, and so does an eyebrow — move them forward and leave
   * their height alone.
   *
   * `surfaceAt`'s y falls monotonically with theta, so the surface point at
   * p's own height is one bisection away.
   */
  const _sp = [0, 0, 0];
  const clearFace = (p, clearance) => {
    const dx = p[0] - c[0], dz = p[2] - c[2];
    const R = Math.hypot(dx, dz);
    if (R < 1e-5) return; // straight over the crown: nothing in front of it
    const ex = dx / R, ez = dz / R;
    const phi = Math.atan2(ex, ez);
    let lo = 0, hi = Math.PI;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) * 0.5;
      surfaceAt(mid, phi, _sp);
      if (_sp[1] > p[1]) lo = mid;
      else hi = mid;
    }
    surfaceAt((lo + hi) * 0.5, phi, _sp);
    const need = (_sp[0] - c[0]) * ex + (_sp[2] - c[2]) * ez + clearance;
    if (R >= need) return;
    p[0] = c[0] + ex * need;
    p[2] = c[2] + ez * need;
  };

  /**
   * THE HEAD IS THE ONE SURFACE IN THE GAME WITH A UNIQUE UV. Everything else
   * tiles a detail map; a face cannot, because a mouth is not a repeating
   * pattern. uvU = uvV = 1 makes the ellipsoid's own (phi, theta) the atlas
   * `makeFaceAtlas()` paints into: u = 0.5 is dead ahead and v runs crown (0) to
   * chin (~0.79), so lips, sockets, beard and creases land where the geometry
   * put them. That is what the review meant by "a flat untextured face" — not
   * that there was no texture, but that the texture could not know where
   * anything was. Gate 6 of `headprobe.mjs` measures the agreement between the
   * emitted uv and the painted landmark, and fails the atlas if it drifts.
   */
  B.ellipsoid({
    material: MAT.face,
    center: c,
    radius: r,
    // 54 x 56, up from 42 x 52. The skull's rows are ~8 mm apart at 42 and the
    // lower face's curvature changes faster than that: carson's `jaw` of 1.1
    // multiplies the width profile in the bottom half and the tessellation
    // reads as horizontal ripples across his chin in a 640 px headshot. +1680
    // triangles on the one mesh in the game that is on screen every frame and
    // photographed at 0.75 m.
    lat: 54,
    lon: 56,
    uvU: 1,
    uvV: 1,
    weight: headW,
    deform: applyFeatures,
  });

  /* ---- ears ---- */
  for (const s of [1, -1]) {
    // Helix: a flattened ring standing off the skull, thickest at the top.
    B.tube({
      material: MAT.face,
      path: [
        [c[0] + s * 0.064 * hs, c[1] + 0.030 * hs, c[2] + 0.000 * hs],
        [c[0] + s * 0.072 * hs, c[1] + 0.020 * hs, c[2] + 0.014 * hs],
        [c[0] + s * 0.071 * hs, c[1] - 0.008 * hs, c[2] + 0.016 * hs],
        [c[0] + s * 0.072 * hs, c[1] - 0.028 * hs, c[2] + 0.004 * hs],
      ],
      rings: 10,
      radial: 8,
      // The ears are TUBES on a head whose material now carries a non-tiling
      // atlas, so they need parking: u 0.03..0.09 / v 0.10..0.32 is the plain
      // skin the atlas keeps behind the hairline. Without the offset a helix
      // samples across the painted eye.
      uvU: 0.13,
      uvV: 0.34,
      uvOffU: 0.02,
      uvOffV: 0.06,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, t * 1.06) * Math.PI) * 0.45 + 0.55;
        return [0.0090 * hs * k, 0.0125 * hs * k];
      },
      weight: headW,
    });
    // Lobe / concha: a small pad filling the ring so it is not a floating loop.
    B.tube({
      material: MAT.face,
      path: [
        [c[0] + s * 0.060 * hs, c[1] + 0.024 * hs, c[2] + 0.004 * hs],
        [c[0] + s * 0.064 * hs, c[1] - 0.014 * hs, c[2] + 0.006 * hs],
      ],
      rings: 5,
      radial: 8,
      uvU: 0.11,
      uvV: 0.26,
      uvOffU: 0.03,
      uvOffV: 0.10,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, 0.15 + t * 0.85) * Math.PI) * 0.4 + 0.6;
        return [0.0075 * hs * k, 0.013 * hs * k];
      },
      weight: headW,
    });
  }

  /* ---- eyes ----
   * The eyeball centre has to sit just BEHIND the socket floor so the lids
   * overlap its top and bottom and only a lens of it shows. Push it in by its
   * own radius and it disappears inside the skull entirely. */
  for (const s of [1, -1]) {
    B.ellipsoid({
      material: MAT.eye,
      // 11.6 mm radius sunk to -0.0650, from 12.2 mm at -0.0672. The eyeball
      // is the right size either way; what changed is how much of it the lids
      // leave showing, and the old pair read as googly at every bearing.
      // `headprobe.mjs` gate 2 is the floor and it is CLOSE: at -0.0638 the
      // gate went red on dylan and only dylan, because `deepEye` is 0.05 on
      // him and his socket floor therefore sits furthest forward of the three.
      // The shallowest socket sets this number.
      center: [c[0] + s * EYE_X, c[1] + EYE_Y, c[2] - 0.0650 * hs],
      radius: [0.0116 * hs, 0.0116 * hs, 0.0116 * hs],
      lat: 12,
      lon: 16,
      uvU: 1,
      uvV: 1,
      weight: headW,
    });
  }

  /* ---- eyebrows ----
   * Authored on the bare ellipsoid, then pushed out onto the face the feature
   * gaussians actually produced. Without that last step the brow ridge — which
   * pushes the surface forward by up to 18 mm, and `brow` scales it further per
   * brother — swallows the tube whole: every eyebrow vertex on all three men
   * sat up to 23 mm INSIDE the head, so nobody had eyebrows at all. `clearance`
   * is well under the tube radius on purpose, so the brow beds into the skin
   * like a ridge of hair instead of floating off it like a caterpillar. */
  for (const s of [1, -1]) {
    const brows = [
      [c[0] + s * 0.010 * hs, c[1] + 0.026 * hs, c[2] - 0.076 * hs],
      [c[0] + s * 0.029 * hs, c[1] + 0.032 * hs, c[2] - 0.070 * hs],
      [c[0] + s * 0.047 * hs, c[1] + 0.024 * hs, c[2] - 0.050 * hs],
    ];
    for (const p of brows) clearFace(p, 0.0016 * hs);
    B.tube({
      material: MAT.hair,
      path: brows,
      rings: 6,
      radial: 6,
      uvV: 12,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, t) * Math.PI) * 0.5 + 0.5;
        return [0.0055 * hs * k, 0.0035 * hs * k];
      },
      weight: headW,
    });
  }

  /* ---- hair ---- */
  const style = build.hair ?? 'crop';
  /**
   * The hairline, in head-local metres for the 1.78 m reference body; the skull
   * only spans y = -0.108 .. +0.108, so these are small numbers by construction.
   *
   * THREE HEIGHTS, and every one of them is ANATOMY, not taste. The shell is
   * only `thick` proud of the skull while the features it would have to cross
   * stand much further out than that, so a hairline in the wrong place either
   * lets a feature punch back out through the hair or leaves bare scalp:
   *
   *   front  the FOREHEAD hairline. Bounded BELOW by the face: the brow ridge
   *          stands 18 mm proud at y = +0.031 and the eyebrow tube sits on top
   *          of that reaching y = +0.036, so a front hairline under it puts the
   *          brow, the cheekbones and the nose straight back out through the
   *          hair. This is the number the FIRST hair bug was about (sweep's
   *          lowest hair was at +0.017 and mop's at -0.012 — a fringe over the
   *          eyes and down onto the nostrils) and it has not moved since.
   *   ear    the hairline OVER THE EAR. Bounded BELOW by the ear, whose helix
   *          tops out at y = +0.037 and stands ~11 mm proud of a skull the
   *          shell is up to 24 mm thick over: let the hairline fall past the
   *          ear and the shell simply eats it.
   *   nape   the hairline at the CENTRE BACK. Bounded by nothing but the
   *          collar, and this is the number the SECOND hair bug was about.
   *
   * WHY THE BACK IS ITS OWN NUMBER RATHER THAN A DROP GATED BY |x|. The
   * previous table had ONE hairline plus a `nape` drop gated by `(1 - side)`,
   * where `side` was |x| / 0.072 on the skull. But |x| is large over most of the
   * back of a head, not only at the temple, so that gate cancelled the nape
   * everywhere except a narrow strip down the centre-back — and with the temple
   * drop cut to 8 mm to keep the ear out of the shell, what was left was a
   * hairline pinned near y = +0.05 right the way round. That is a swim cap on
   * the crown with both temples and the whole back of the skull left as bare
   * scalp, and from the third-person camera it reads as a bald patch.
   *
   * The gate is now the AZIMUTH round the skull, because that is what actually
   * separates "in front of the ear" from "behind it":
   *
   *   u = atan2(|x| / 0.0715, -z / 0.0935) / PI
   *     u = 0     dead ahead (forehead)
   *     u = 0.5   the ear
   *     u = 1     dead behind (nape)
   *
   * and u is INDEPENDENT OF THETA down a meridian — both |x| and -z carry the
   * same sin(theta), which cancels inside the atan2. So `line` is one constant
   * per meridian and `y - line` falls monotonically from the crown to the
   * hairline, which is what lets the boundary scan below find the one root it
   * is looking for instead of the first of several.
   *
   * `node src/player/character/headprobe.mjs` is the gate on all of this: it
   * fires a ray at the head from 24 000 directions and exits non-zero if skin
   * is the nearest surface anywhere on the cranium — plus four more checks that
   * stop this from being traded against the fringe, the brows or the ears.
   * RUN IT BEFORE YOU TOUCH ANY NUMBER IN THIS BLOCK. Both hair bugs shipped
   * because the change was only ever looked at from the front.
   */
  const HAIR = {
    crop: { front: 0.072, ear: 0.043, nape: -0.036, thick: 0.010, fringe: 0.0 },
    sweep: { front: 0.071, ear: 0.041, nape: -0.052, thick: 0.017, fringe: 0.018 },
    mop: { front: 0.070, ear: 0.040, nape: -0.074, thick: 0.024, fringe: 0.026 },
  }[style] ?? { front: 0.071, ear: 0.042, nape: -0.046, thick: 0.013, fringe: 0.010 };

  /**
   * Hairline height against azimuth. Held FLAT across u = 0.40 .. 0.58 because
   * that brackets the ear's own footprint (front edge z = -0.005, u = 0.48;
   * back edge z = +0.028, u = 0.60) and hair does not grow on an ear. Gate 4 of
   * `headprobe.mjs` is what proves the shell still is not eating them: the
   * number of ray directions whose nearest surface is an ear is 439 right and
   * 436 left in 24 000, IDENTICAL to before this change.
   *
   * The moment it is past the ear it DIVES: on a real head the hairline behind
   * the ear is already down at lobe height, and it runs back and down from
   * there to the nape. Easing gently out of `ear` all the way to u = 1 instead
   * (the obvious reading of "it drops at the back") leaves the whole
   * back-quarter of the skull above the ear bare, which in profile is a bald
   * wedge running from the temple to the crown.
   */
  const HAIRLINE = [
    [0.00, HAIR.front],
    [0.26, HAIR.front - 0.010],
    [0.40, HAIR.ear],
    [0.58, HAIR.ear],
    [0.68, HAIR.ear - 0.048],
    [1.00, HAIR.nape],
  ];
  /** Metres of skull between the hairline and full shell thickness. */
  const HAIR_RAMP = 0.035;
  /**
   * Floor on how far the shell stands off the skull, metres.
   *
   * Thickness reaches zero AT the hairline, which would leave the cap's rim
   * vertices exactly COPLANAR with the skull — and the straight chord between
   * two adjacent meridians then cuts slightly inside a convex skull, worst
   * behind the ear where the hairline drops ~16 mm per meridian. The ray gate
   * passes either way (measured: 0 leaking directions in 60 000 with and
   * without), so this is not load-bearing; it is there so the depth prepass and
   * the shadow cascades never have to resolve two coincident surfaces. 1.5 mm
   * is under a seventh of the thinnest style's shell and subpixel in play.
   */
  const EDGE_LIFT = 0.0015;

  /**
   * Hair thickness at a surface point: zero below the hairline, ramping to the
   * full shell thickness `HAIR_RAMP` above it — get that shape wrong and the
   * character is either bald or wearing a helmet.
   */
  const hairThickness = (px, py, pz) => {
    const x = (px - c[0]) / hs;
    const y = (py - c[1]) / hs;
    const z = (pz - c[2]) / hs;
    const u = Math.atan2(Math.abs(x) / 0.0715, -z / 0.0935) / Math.PI;
    // A widow's peak. Without it the front hairline is a band ruled straight
    // across the forehead, which is the single thing that makes procedural
    // hair read as a swim cap rather than as hair.
    const peak = Math.exp(-(x * x) / 0.00035) * Math.max(0, 1 - u / 0.34);
    const line = prof(u, HAIRLINE) - peak * 0.013;
    const t = (y - line) / HAIR_RAMP;
    if (t <= 0) return 0;
    const k = Math.min(1, t);
    return HAIR.thick * k * k * (3 - 2 * k);
  };

  /**
   * The cap is parameterised from the crown DOWN TO THE HAIRLINE along every
   * meridian, so its edge *is* the hairline. Cutting a hair region out of a
   * sphere grid instead (the obvious approach) leaves a staircase you can count
   * the quads on, which is the single most obvious "procedural" tell there is.
   *
   * thetaLine(phi) is a coarse scan plus twelve bisections, run once at build
   * time for fifty-six meridians — about 3000 evaluations, under a millisecond.
   */
  // The cap now runs from the crown to a nape at theta ~ 2.3 rad instead of
  // stopping near the equator, so it needs more rows to keep the quad size
  // (and therefore the silhouette of the edge) where it was.
  const HLAT = 26, HLON = 56;
  const probe = [0, 0, 0];
  const LIMIT = Math.PI * 0.96;
  const thetaLine = new Float32Array(HLON + 1);
  for (let j = 0; j <= HLON; j++) {
    const phi = (j / HLON) * Math.PI * 2;
    let lo = 0, hi = LIMIT;
    for (let k = 1; k <= 48; k++) {
      const th = (k / 48) * LIMIT;
      surfaceAt(th, phi, probe);
      if (hairThickness(probe[0], probe[1], probe[2]) <= 0) {
        hi = th;
        lo = ((k - 1) / 48) * LIMIT;
        break;
      }
    }
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) * 0.5;
      surfaceAt(mid, phi, probe);
      if (hairThickness(probe[0], probe[1], probe[2]) > 0) lo = mid;
      else hi = mid;
    }
    thetaLine[j] = lo;
  }
  // Smooth the boundary so one noisy meridian cannot notch the hairline.
  const edge = Float32Array.from(thetaLine);
  for (let j = 0; j <= HLON; j++) {
    const a = thetaLine[(j - 1 + HLON) % HLON];
    const b = thetaLine[j % HLON];
    const d = thetaLine[(j + 1) % HLON];
    edge[j] = (a + b * 2 + d) * 0.25;
  }
  edge[HLON] = edge[0];

  B.grid({
    material: MAT.hair,
    rows: HLAT,
    cols: HLON,
    uvU: 3.4,
    uvV: 1.6,
    weight: headW,
    point: (u, v, out) => {
      const jf = u * HLON;
      const j0 = Math.floor(jf), f = jf - j0;
      const line = edge[j0] * (1 - f) + edge[Math.min(HLON, j0 + 1)] * f;
      // Bias the rows toward the edge: that is where the silhouette is.
      const theta = line * (v * v * 0.4 + v * 0.6);
      const phi = u * Math.PI * 2;
      surfaceAt(theta, phi, out);
      const th = hairThickness(out[0], out[1], out[2]);
      const nx = (out[0] - c[0]) / r[0];
      const ny = (out[1] - c[1]) / r[1];
      const nz = (out[2] - c[2]) / r[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      // Fade the clump variation out at the crown. Every meridian collapses to
      // the same point at theta = 0, so a per-phi displacement there fans the
      // pole into a star — which is exactly the spike that stood up out of the
      // top of all three heads.
      const pole = Math.min(1, theta / 0.30);
      const clump = 0.78 + 0.22 * Math.sin(phi * 6.0) * Math.sin(theta * 8.0 + 1.3) * pole;
      const amt = Math.max(th * clump, EDGE_LIFT) * hs;
      out[0] += (nx / l) * amt;
      out[1] += (ny / l) * amt;
      out[2] += (nz / l) * amt;
      if (HAIR.fringe > 0 && nz < -0.25) {
        out[1] -= HAIR.fringe * hs * Math.max(0, -nz - 0.25) * 1.6;
        // Only the fringe needs this. Every other vertex is already `amt` off
        // the very surface it was built from, and pushing those out again
        // would inflate the crown.
        clearFace(out, Math.max(amt, 0.005 * hs));
      }
    },
  });
}

/* ====================================================================== */
/* Assembly                                                               */
/* ====================================================================== */

/**
 * Build the full SkinnedMesh for one brother.
 * @returns {{ mesh, skeleton, bones, geometry, materials, boneIndex }}
 */
export function buildCharacter(build, materials) {
  const { geometry, skeleton: sk } = buildBody(build);

  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.name = 'player:body';
  // The body is skinned far from its bind bounds; culling it by that box makes
  // it vanish at the edge of frame.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Never let the physics auto-scan turn the player's own body into static
  // collision — he would then be standing inside a wall shaped like himself.
  mesh.userData.collision = false;
  mesh.userData.noCollision = true;

  const root = new THREE.Group();
  root.name = 'player:character';
  root.add(sk.root);
  root.add(mesh);
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(sk.bones);
  mesh.bind(skeleton, new THREE.Matrix4());

  return {
    root,
    mesh,
    skeleton,
    bones: sk.byName,
    boneList: sk.bones,
    geometry,
    bindPositions: sk.positions,
  };
}
