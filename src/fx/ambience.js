import * as THREE from 'three';
import { P } from './atlas.js';
import { resetSpawn } from './particles.js';
import { V, cone } from './util.js';

/**
 * Always-on atmosphere.
 *
 * Three things, all subtle enough that you notice them only when they are gone:
 *
 *  - **Dust motes.** A population of tiny forward-scattering specks kept alive
 *    in a box that follows the camera, drifting on the same analytic turbulence
 *    as everything else. They are what makes a shaft of light look like air
 *    instead of a gradient.
 *  - **Heat shimmer.** Refraction sprites laid on the ground ahead of the
 *    player while the sun is high, so hot surfaces boil slightly.
 *  - **Smoke sources.** Long-lived emitters. `world` can tag any object with
 *    `userData.fxSmoke = { radius, rate }` and it will start smoking without
 *    either subsystem knowing about the other; explosions use the same pool for
 *    their smoke column.
 */

const TWO_PI = Math.PI * 2;
/**
 * 24 was the whole pool, and it was shared with explosions and burning wrecks.
 * The seven standing city producers below never expire, so the ceiling is
 * lifted by exactly that many and the transient budget is unchanged. An
 * emitter is a small record and the per-frame cost is one distance test.
 */
const MAX_EMITTERS = 32;

/**
 * ===========================================================================
 * THE CITY'S STANDING PRODUCERS
 * ===========================================================================
 *
 * NOTHING IN THIS CITY EMITTED SMOKE OR STEAM. Not the blast furnace, not the
 * market, not a grate — the tag route documented above (`userData.fxSmoke` on
 * any Object3D) has been correct and complete since it was written and has had
 * ZERO producers, so a dying mill town had five cold stacks in its signature
 * shot.
 *
 * The tag route is not what was missing. What is missing is a NODE to hang the
 * tag on: `buildings` merges every landmark into a per-tile static batch and
 * `TileBuilder.build()` returns a handful of meshes whose transforms are all
 * the identity, so there is no per-stack Object3D anywhere in the scene and
 * `_scan` has nothing to find. Fixing that is `src/buildings/tile.js`'s job,
 * not this file's.
 *
 * So there is a second route, and it obeys the same two rules the tag route
 * does:
 *
 *   WHERE a landmark is comes from `world.landmarks`, never from a copy —
 *   that is the authority, and the last time two subsystems each decided where
 *   a landmark was, the Point Fountain ended up 8.7 m under the Ohio.
 *
 *   HOW HIGH the flue is comes from `buildings`, which built the stack. It
 *   cannot be imported (rule 2), so it is mirrored here and the mirror is
 *   GATED: `src/fx/plumeprobe.mjs` imports `MILL_STACKS` and `MARKET_GRIDDLES`
 *   from `src/buildings/landmarks.js` alongside this table and fails if any
 *   anchor moves by more than 5 cm. A probe may reach across subsystems; a
 *   subsystem may not.
 *
 * `dx/dz/top` are metres from the landmark's published centre and its ground.
 * Exported for `plumeprobe.mjs` only — nothing in `src/` reads it.
 */
export const PRODUCERS = [
  {
    landmark: 'lm_mill',
    /**
     * The furnace crown at 66 m is the one that has to read from across the
     * river, so it is the only plume with a cull past 300 m. The three brick
     * stacks behind it run cooler and thinner — a working mill does not have
     * five identical columns, and the variation is most of what stops the
     * silhouette reading as a decal.
     */
    plumes: [
      { dx: 0, dz: 0, top: 66, r: 3.4, kind: 'smoke', rate: 9.0, rise: 2.6, dark: 0.125, cull: 420 },
      { dx: -34, dz: -20, top: 44, r: 2.00, kind: 'smoke', rate: 5.4, rise: 2.0, dark: 0.150, cull: 340 },
      { dx: -43, dz: -25, top: 38, r: 1.75, kind: 'smoke', rate: 4.8, rise: 1.9, dark: 0.170, cull: 320 },
      { dx: -52, dz: -30, top: 32, r: 1.50, kind: 'smoke', rate: 4.2, rise: 1.8, dark: 0.190, cull: 300 },
      { dx: 20, dz: -12, top: 57, r: 1.10, kind: 'steam', rate: 5.0, rise: 2.8, cull: 300 },
    ],
    /**
     * Refraction only, no particles at all (see `addHeat`): the cast house
     * runners are the hottest thing in the city and a whole mill site of these
     * is close to free.
     */
    heat: [{ dx: -4, dz: 24, top: 15.4, radius: 7, strength: 0.42, cull: 260 }],
  },
  {
    landmark: 'lm_market',
    plumes: [
      { dx: -12.6, dz: -9, top: 2.36, r: 0.30, kind: 'steam', rate: 4.4, rise: 1.7, cull: 110 },
      { dx: 12.6, dz: 21, top: 2.36, r: 0.30, kind: 'steam', rate: 4.0, rise: 1.6, cull: 110 },
    ],
    heat: [],
  },
];

class Emitter {
  constructor() {
    this.active = false;
    this.age = 0;
    this.duration = Infinity;
    this.acc = 0;
    this.rate = 6;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.radius = 0.25;
    this.rise = 1.2;
    this.dark = 0.16;
    this.life = 2.6;
    this.growth = 3;
    this.ember = 0;
    this.haze = 0;
    this.object = null;
    this.tag = 0;
    /** 0..1 — how much of the puff is drawn as burning gas rather than smoke. */
    this.fire = 0;
    /** 0..1 — how strongly the global wind carries the plume. */
    this.wind = 0.35;
    /** Peak alpha of a puff. */
    this.alpha = 0.45;
    /** Steam: white, near-neutral, condenses and vanishes rather than dispersing. */
    this.steam = false;
    /** Local offset applied in the object's own frame (exhaust pipe, bonnet). */
    this.ox = 0;
    this.oy = 0;
    this.oz = 0;
    this.local = false;
    /** Cull distance — an emitter beyond this stops spending particles. */
    this.cull = 140;
    /**
     * A permanent city fixture rather than a transient. Two consequences, both
     * in `update`: it is PREFILLED when the camera comes into range, and it is
     * the last thing `_acquire` will recycle.
     */
    this.standing = false;
    /** Has this emitter been prefilled since it last came into range? */
    this.warm = false;
  }
}

const _localP = new THREE.Vector3();

export class Ambience {
  constructor(fx, opts = {}) {
    this.fx = fx;
    this.emitters = [];
    for (let i = 0; i < MAX_EMITTERS; i++) this.emitters.push(new Emitter());
    this._tag = 1;

    this.moteCount = opts.motes ?? 240;
    this.moteLife = 9;
    this.moteAcc = 0;
    this.moteBox = opts.box ?? 22;
    this.moteEnabled = this.moteCount > 0;
    this.sunFactor = 1;

    this.shimmerAcc = 0;
    this.shimmerEnabled = opts.shimmer !== false;

    this._scanTimer = 0;
    this._tracked = new Set();
    /** PRODUCERS entry -> { x, z, gy, tags[], heat }. See `_producers`. */
    this._standing = new Map();
    this.heat = [];
    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._warm = 0;
  }

  /* --------------------------------------------------------------------- */
  /*  emitters                                                            */
  /* --------------------------------------------------------------------- */

  /**
   * A free slot, else the most spent one — and a STANDING city source is taken
   * only when there is nothing else at all. Without the last clause a busy
   * firefight could evict the mill, and since a standing source has infinite
   * duration its `age / duration` is 0, which made it tie with every other
   * infinite source and hand the decision to array order.
   */
  _acquire() {
    let oldest = null;
    let standing = null;
    for (const e of this.emitters) {
      if (!e.active) return e;
      if (e.standing) {
        if (!standing) standing = e;
        continue;
      }
      if (!oldest || e.age / e.duration > oldest.age / oldest.duration) oldest = e;
    }
    return oldest ?? standing;
  }

  /** Finite-duration smoke column (explosions, burning wreck). */
  addColumn(x, y, z, o = {}) {
    const e = this._acquire();
    e.active = true;
    e.age = 0;
    e.acc = 0;
    e.duration = o.duration ?? 1.5;
    e.rate = o.rate ?? 8;
    e.x = x;
    e.y = y;
    e.z = z;
    e.radius = o.radius ?? 0.5;
    e.rise = o.rise ?? 1.5;
    e.dark = o.dark ?? 0.14;
    e.life = o.life ?? 3.2;
    e.growth = o.growth ?? 3;
    e.ember = o.ember ?? 0;
    e.haze = o.haze ?? 0;
    e.fire = o.fire ?? 0;
    e.wind = o.wind ?? 0.35;
    e.alpha = o.alpha ?? 0.45;
    e.steam = o.steam === true;
    e.ox = o.ox ?? 0;
    e.oy = o.oy ?? 0;
    e.oz = o.oz ?? 0;
    e.local = o.local === true;
    e.cull = o.cull ?? 140;
    e.standing = o.standing === true;
    e.warm = false;
    e.object = null;
    e.tag = this._tag++;
    return e.tag;
  }

  /** Persistent source; pass an Object3D to have it follow that object. */
  addSource(position, o = {}) {
    const tag = this.addColumn(position.x, position.y, position.z, {
      duration: o.duration ?? Infinity,
      rate: o.rate ?? 4.5,
      radius: o.radius ?? 0.35,
      rise: o.rise ?? 1.1,
      dark: o.dark ?? 0.13,
      life: o.life ?? 3.4,
      growth: o.growth ?? 3.4,
      ember: o.ember ?? 0.25,
      haze: o.haze ?? 0.35,
      fire: o.fire ?? 0,
      wind: o.wind ?? 0.35,
      alpha: o.alpha ?? 0.45,
      steam: o.steam,
      ox: o.ox, oy: o.oy, oz: o.oz, local: o.local,
      cull: o.cull,
      standing: o.standing,
    });
    if (o.object) {
      for (const e of this.emitters) if (e.tag === tag) e.object = o.object;
    }
    return tag;
  }

  /** Change an existing emitter in place — used to thicken engine smoke. */
  tune(tag, o) {
    if (!tag) return;
    for (const e of this.emitters) {
      if (e.tag !== tag || !e.active) continue;
      for (const k in o) if (o[k] !== undefined) e[k] = o[k];
      return;
    }
  }

  remove(tag) {
    for (const e of this.emitters) {
      if (e.tag === tag) {
        e.active = false;
        e.object = null;
      }
    }
  }

  /**
   * @param {number} spread  when > 0 this is a PREFILL puff: its birth is
   *   backdated by up to `spread` seconds so it arrives already part-way along
   *   its own trajectory. The particle path is a closed form of age
   *   (`particles.js` vertex shader), so a backdated birth is not an
   *   approximation of an older puff — it IS one, at the position and size it
   *   would have reached. A prefilled emitter therefore has a full column the
   *   frame it starts rather than a stub growing out of a chimney for ten
   *   seconds while the player watches. The extras (fire, embers, haze) are
   *   skipped: they are short-lived, so backdating them produces one
   *   simultaneous burst that then dies all at once, which pulses.
   */
  _puff(e, now, dt, spread = 0) {
    const fx = this.fx;
    const rng = fx.rng;
    cone(V, rng, 0, 1, 0, 0.6, 0.7);
    const s = resetSpawn();
    const r = e.radius;
    s.x = e.x + rng.signed() * r * 0.6;
    s.y = e.y + rng.range(0, r * 0.4);
    s.z = e.z + rng.signed() * r * 0.6;
    s.vx = V.x * e.rise * 0.5 + rng.signed() * 0.25;
    s.vy = e.rise * rng.range(0.7, 1.25);
    s.vz = V.z * e.rise * 0.5 + rng.signed() * 0.25;
    s.tile = rng.float() < 0.5 ? P.SMOKE_A : P.SMOKE_B;
    s.size0 = r * rng.range(0.7, 1.2);
    s.size1 = r * e.growth * rng.range(0.8, 1.25);
    s.sizeCurve = 0.7;
    s.life = e.life * rng.range(0.75, 1.25);
    s.delay = spread > 0 ? -rng.float() * spread : -rng.float() * dt;
    s.drag = 0.75;
    s.gravity = 0.42; // buoyant, keeps accelerating upward
    s.rot = rng.float() * TWO_PI;
    s.spin = rng.signed() * 0.35;
    s.wind = e.wind;
    s.lightGain = 1.25;
    const d = e.dark;
    if (e.steam) {
      // STEAM, not smoke. Condensed water is near-white, brightest where it is
      // densest (it forward-scatters hard), it accelerates upward much faster
      // than smoke, and it does not disperse so much as EVAPORATE — so it
      // shrinks its own opacity to nothing on a sharp curve rather than
      // spreading into a thin grey haze.
      s.tile = rng.float() < 0.45 ? P.MIST : rng.float() < 0.5 ? P.PLUME : P.SMOKE_A;
      s.gravity = 1.5 + e.rise * 0.5;
      s.drag = 1.1;
      // Condensed water has no colour of its own: keep it neutral-to-cool so
      // the warm ground bounce cannot drag the plume brown.
      s.r0 = d * 0.99; s.g0 = d * 1.01; s.b0 = d * 1.05;
      s.r1 = d * 0.7; s.g1 = d * 0.72; s.b1 = d * 0.78;
      s.alpha = e.alpha * rng.range(0.6, 1.15);
      s.alphaCurve = 2.4;
      s.turb = r * 0.85;
      s.turbFreq = 0.9;
      s.lightGain = 1.8;
    } else {
      s.r0 = d; s.g0 = d * 0.97; s.b0 = d * 0.94;
      s.r1 = d * 1.9; s.g1 = d * 1.86; s.b1 = d * 1.8;
      s.alpha = e.alpha * rng.range(0.7, 1.25);
      s.alphaCurve = 1.7;
      s.turb = r * 0.5;
      s.turbFreq = 0.55;
    }
    s.soft = 0.8;
    s.fadeIn = 0.07;
    s.seed = rng.float();
    fx.emitLit(s);

    if (spread > 0) return;

    // ---- burning gas at the root -----------------------------------------
    if (e.fire > 0 && rng.float() < e.fire) {
      const f = resetSpawn();
      f.x = e.x + rng.signed() * r * 0.55;
      f.y = e.y + rng.range(-r * 0.1, r * 0.35);
      f.z = e.z + rng.signed() * r * 0.55;
      f.vx = rng.signed() * 0.5;
      f.vy = rng.range(1.6, 4.2) * (0.6 + e.rise * 0.3);
      f.vz = rng.signed() * 0.5;
      f.tile = P.FIRE;
      // Flame is not a stack of equal spheres: a wide spread of sizes plus a
      // hard turbulence term is what turns a column of FIRE billboards into
      // something with tongues.
      const lick = rng.float() < 0.45;
      f.size0 = r * (lick ? rng.range(0.22, 0.5) : rng.range(0.55, 1.1));
      f.size1 = r * (lick ? rng.range(0.5, 1.0) : rng.range(1.2, 2.3));
      f.sizeCurve = lick ? 0.32 : 0.5;
      f.life = lick ? rng.range(0.18, 0.42) : rng.range(0.4, 0.95);
      f.delay = -rng.float() * dt;
      f.drag = 2.4;
      f.gravity = 3.4; // flame is strongly buoyant
      // Velocity-ALIGNED, not tumbling. Flame does not roll; it licks upward,
      // and the sprite has to elongate along its own rise or a fire column is a
      // stack of orange spheres however much noise is in the tile.
      f.stretch = rng.range(0.1, 0.22);
      f.rot = 0;
      f.spin = 0;
      f.r0 = 1; f.g0 = rng.range(0.62, 0.88); f.b0 = rng.range(0.28, 0.5);
      f.i0 = rng.range(4, 11);
      f.r1 = 1; f.g1 = 0.2; f.b1 = 0.035; f.i1 = 0.22;
      f.alphaCurve = 0.6;
      f.soft = 0.35;
      f.turb = r * 0.85;
      f.turbFreq = rng.range(3.0, 5.5);
      f.wind = e.wind * 0.4;
      f.seed = rng.float();
      fx.emitAdd(f);
    }

    if (e.ember > 0 && rng.float() < e.ember) {
      const t = resetSpawn();
      t.x = s.x; t.y = e.y; t.z = s.z;
      t.vx = rng.signed() * 0.5;
      t.vy = rng.range(1.2, 3.2);
      t.vz = rng.signed() * 0.5;
      t.tile = P.SPARK;
      t.size0 = rng.range(0.006, 0.014);
      t.size1 = t.size0 * 0.5;
      t.life = rng.range(0.8, 1.9);
      t.drag = 0.9;
      t.gravity = 1.2;
      t.r0 = 1; t.g0 = 0.5; t.b0 = 0.16; t.i0 = rng.range(3, 9);
      t.r1 = 0.9; t.g1 = 0.14; t.b1 = 0.02; t.i1 = 0.1;
      t.flags = 1;
      t.alphaCurve = 1.2;
      t.turb = 0.12; t.turbFreq = 1.6;
      t.soft = 0.1;
      t.wind = e.wind * 0.8;
      t.seed = rng.float();
      fx.emitAdd(t);
    }
    if (e.haze > 0 && rng.float() < 0.35) {
      fx.haze(e.x, e.y + r * 0.6, e.z, r * 1.4, 2.4, 0.9, e.haze, P.SMOKE_A);
    }
  }

  /* --------------------------------------------------------------------- */
  /*  motes + shimmer                                                     */
  /* --------------------------------------------------------------------- */

  _motes(dt, now, camera) {
    const fx = this.fx;
    const rng = fx.rng;
    // Keep the population at `moteCount` by replacing what expires.
    const rate = this.moteCount / this.moteLife;
    // On the first couple of frames fill the volume in one go so the air is
    // never visibly empty when a shot is captured.
    let n;
    if (this._warm < 2) {
      this._warm++;
      n = this.moteCount;
    } else {
      this.moteAcc += rate * dt;
      n = Math.min(64, Math.floor(this.moteAcc));
      this.moteAcc -= n;
    }
    if (n <= 0) return;
    camera.getWorldDirection(this._fwd);
    const cx = camera.position.x + this._fwd.x * this.moteBox * 0.22;
    const cy = camera.position.y + this._fwd.y * this.moteBox * 0.1;
    const cz = camera.position.z + this._fwd.z * this.moteBox * 0.22;
    const half = this.moteBox * 0.5;
    const bright = 0.16 * this.sunFactor;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = cx + rng.signed() * half;
      s.y = cy + rng.signed() * half * 0.42;
      s.z = cz + rng.signed() * half;
      s.vx = rng.signed() * 0.09;
      s.vy = rng.range(-0.05, 0.06);
      s.vz = rng.signed() * 0.09;
      s.tile = P.MOTE;
      s.size0 = rng.range(0.0035, 0.011);
      s.size1 = s.size0;
      s.life = this.moteLife * rng.range(0.55, 1.45);
      // Spread the first fill through the lifetime so they do not all die at
      // once and pulse the whole volume.
      s.delay = this._warm <= 2 ? -rng.float() * s.life * 0.95 : -rng.float() * dt;
      s.drag = 0.22;
      s.gravity = -0.02;
      const b = bright * rng.range(0.35, 1.5);
      s.r0 = 1; s.g0 = 0.96; s.b0 = 0.9; s.i0 = b;
      s.r1 = 1; s.g1 = 0.94; s.b1 = 0.88; s.i1 = b * 0.6;
      s.alpha = rng.range(0.25, 0.7);
      s.alphaCurve = 1.1;
      s.soft = 0.05;
      s.turb = rng.range(0.05, 0.22);
      s.turbFreq = rng.range(0.15, 0.5);
      s.seed = rng.float();
      fx.emitMote(s);
    }
  }

  _shimmer(dt, now, camera) {
    const fx = this.fx;
    if (!this.shimmerEnabled || this.sunFactor < 0.35) return;
    this.shimmerAcc += dt;
    if (this.shimmerAcc < 0.22) return;
    this.shimmerAcc = 0;
    const rng = fx.rng;
    camera.getWorldDirection(this._fwd);
    const d = rng.range(3.5, 15);
    const sx = camera.position.x + this._fwd.x * d + rng.signed() * 4;
    const sz = camera.position.z + this._fwd.z * d + rng.signed() * 4;
    let gy = camera.position.y - 1.6;
    if (fx.physics?.groundHeight) {
      const h = fx.physics.groundHeight(sx, sz, camera.position.y + 6);
      if (Number.isFinite(h)) gy = h;
    }
    fx.haze(
      sx,
      gy + rng.range(0.15, 0.6),
      sz,
      rng.range(0.5, 1.2),
      1.9,
      rng.range(1.1, 2.0),
      rng.range(0.12, 0.3) * this.sunFactor,
      rng.float() < 0.5 ? P.SMOKE_A : P.MIST
    );
  }

  /* --------------------------------------------------------------------- */

  /**
   * Discover objects other subsystems tagged as emitting.
   *
   * Three tags, all read-only — `world`, `props` and `buildings` can make a
   * grate steam or a mill stack smoke by setting one field on an Object3D, and
   * neither side needs to know the other exists:
   *
   *   userData.fxSmoke = { radius, rate, dark, ... }   dirty industrial smoke
   *   userData.fxSteam = { radius, rate, ... }         white steam / vent plume
   *   userData.fxHeat  = { radius, strength }          refraction only, no smoke
   */
  _scan(scene) {
    scene.traverse((o) => {
      const ud = o.userData;
      if (!ud || this._tracked.has(o)) return;
      const smoke = ud.fxSmoke;
      const steam = ud.fxSteam;
      const heat = ud.fxHeat;
      if (!smoke && !steam && !heat) return;
      this._tracked.add(o);
      o.updateWorldMatrix(true, false);
      this._tmp.setFromMatrixPosition(o.matrixWorld);
      if (smoke) {
        this.addSource(this._tmp, {
          radius: smoke.radius ?? 0.35,
          rate: smoke.rate ?? 4,
          rise: smoke.rise ?? 1.1,
          dark: smoke.dark ?? 0.13,
          life: smoke.life ?? 3.4,
          growth: smoke.growth ?? 3.4,
          ember: smoke.ember ?? 0.2,
          haze: smoke.haze ?? 0.3,
          fire: smoke.fire ?? 0,
          wind: smoke.wind ?? 0.5,
          alpha: smoke.alpha ?? 0.45,
          cull: smoke.cull ?? 220,
          object: o,
        });
      }
      if (steam) {
        this.addSource(this._tmp, {
          radius: steam.radius ?? 0.3,
          rate: steam.rate ?? 5,
          rise: steam.rise ?? 1.9,
          dark: steam.dark ?? 0.68,
          life: steam.life ?? 2.2,
          growth: steam.growth ?? 4.2,
          ember: 0,
          haze: steam.haze ?? 0.14,
          steam: true,
          wind: steam.wind ?? 0.8,
          alpha: steam.alpha ?? 0.34,
          cull: steam.cull ?? 150,
          object: o,
        });
      }
      if (heat) this.addHeat(this._tmp, heat, o);
    });
  }

  /* --------------------------------------------------------------------- */
  /*  standing city producers                                             */
  /* --------------------------------------------------------------------- */

  /** Is `tag` still held by a live emitter? */
  _live(tag) {
    if (!tag) return false;
    for (const e of this.emitters) if (e.tag === tag && e.active) return true;
    return false;
  }

  /** Register one plume at a producer's resolved world position. */
  _standUp(pl, st) {
    this._tmp.set(st.x + pl.dx, st.gy + pl.top, st.z + pl.dz);
    if (pl.kind === 'steam') {
      return this.addSource(this._tmp, {
        radius: pl.r, rate: pl.rate, rise: pl.rise ?? 2.2,
        dark: 0.70, life: 3.0, growth: 4.6, ember: 0, haze: 0.12,
        steam: true, wind: 0.85, alpha: 0.32, cull: pl.cull, standing: true,
      });
    }
    return this.addSource(this._tmp, {
      radius: pl.r, rate: pl.rate, rise: pl.rise ?? 2.0,
      dark: pl.dark ?? 0.12,
      /**
       * Long-lived and fast-growing, because a mill plume is a SILHOUETTE
       * feature: it has to stay coherent for the two hundred metres of sky it
       * crosses before the wind shears it out, and a 3 s puff dies inside its
       * own chimney. The wind gain is near-full for the same reason — the
       * bend downwind is what tells you which way the weather is going, and
       * it is the difference between a plume and a stationary grey cone.
       */
      life: 9.5, growth: 5.4, ember: 0.06, haze: 0.32,
      wind: 0.92, alpha: 0.5, cull: pl.cull, standing: true,
    });
  }

  /**
   * Stand the city's standing producers up, once `world` can say where they
   * are. See the PRODUCERS note at the top of this file for why they are a
   * table here rather than a tag on a mesh.
   *
   * Runs on the same slow timer as `_scan`, and is IDEMPOTENT — deliberately.
   * `_acquire` recycles the oldest emitter when the pool is full, and although
   * an infinite-duration source is the last thing it will take (its
   * age/duration ratio is zero), "last" is not "never". A mill that goes out
   * for the rest of the session because a firefight needed a slot would be a
   * bug nobody could reproduce, so a plume whose tag is no longer live is
   * simply stood back up on the next pass.
   */
  _producers() {
    const world = this.fx?.ctx?.peek?.('world');
    const list = world?.landmarks;
    if (!Array.isArray(list) || list.length === 0) return;
    for (const p of PRODUCERS) {
      let st = this._standing.get(p);
      if (!st) {
        // `world` is the authority on where a landmark is (ARCHITECTURE.md
        // rule 12) and on the ground under it. Nothing here re-derives either.
        let lm = null;
        for (const l of list) if (l.id === p.landmark) { lm = l; break; }
        const gy = lm && world.heightAt?.(lm.x, lm.z);
        if (!Number.isFinite(gy)) continue;
        st = {
          x: lm.x, z: lm.z, gy,
          tags: new Array(p.plumes.length).fill(0),
          heat: new Array(p.heat.length).fill(null),
        };
        this._standing.set(p, st);
      }
      for (let i = 0; i < p.plumes.length; i++) {
        if (!this._live(st.tags[i])) st.tags[i] = this._standUp(p.plumes[i], st);
      }
      /**
       * The heat sources are re-checked by IDENTITY, not by a "did I do this"
       * flag, because `FXSystem._clearStageVents` empties `this.heat` wholesale
       * (`heat.length = 0`) whenever a debug stage is set up. A boolean would
       * have left the cast house cold for the rest of the session after
       * somebody pressed a dev key, which is the kind of bug that gets
       * reported as "the shimmer is flaky".
       */
      for (let i = 0; i < p.heat.length; i++) {
        if (st.heat[i] && this.heat.includes(st.heat[i])) continue;
        const h = p.heat[i];
        this._tmp.set(st.x + h.dx, st.gy + h.top, st.z + h.dz);
        this.addHeat(this._tmp, { radius: h.radius, strength: h.strength, cull: h.cull });
        st.heat[i] = this.heat[this.heat.length - 1];
      }
    }
  }

  /**
   * A pure refraction source — a blast furnace, a flare stack, a hot roof.
   * Costs no particles at all: it only writes into the half-res distortion
   * buffer, so a whole mill site of them is close to free.
   */
  addHeat(position, o = {}, object = null) {
    this.heat.push({
      x: position.x,
      y: position.y,
      z: position.z,
      radius: o.radius ?? 2.5,
      strength: o.strength ?? 0.5,
      rate: o.rate ?? 5,
      acc: 0,
      cull: o.cull ?? 260,
      object,
    });
    return this.heat.length - 1;
  }

  update(dt, now, camera, scene) {
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    for (const e of this.emitters) {
      if (!e.active) continue;
      e.age += dt;
      if (e.age > e.duration) {
        e.active = false;
        continue;
      }
      if (e.object) {
        if (!e.object.parent) {
          e.active = false;
          e.object = null;
          continue;
        }
        e.object.updateWorldMatrix(true, false);
        if (e.local && (e.ox || e.oy || e.oz)) {
          _localP.set(e.ox, e.oy, e.oz).applyMatrix4(e.object.matrixWorld);
          e.x = _localP.x; e.y = _localP.y; e.z = _localP.z;
        } else {
          this._tmp.setFromMatrixPosition(e.object.matrixWorld);
          e.x = this._tmp.x;
          e.y = this._tmp.y;
          e.z = this._tmp.z;
        }
      }
      // Distance cull, with a rate ramp rather than a switch: an emitter that
      // snaps on at 140 m is a visible pop.
      const dx = e.x - cx;
      const dy = e.y - cy;
      const dz = e.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const cull = e.cull;
      if (d2 > cull * cull) {
        e.acc = 0;
        e.warm = false;
        continue;
      }
      /**
       * A STANDING SOURCE IS ALREADY RUNNING WHEN YOU GET THERE.
       *
       * Without this, driving up to the mill shows four chimneys with a
       * three-metre stub over each, growing into a plume over the next ten
       * seconds — and a capture, which teleports the camera and presses the
       * shutter ninety frames later, photographs the stub. So the first frame
       * inside the cull radius pays for the emitter's whole backlog at once,
       * with the puffs' births spread across a full particle lifetime.
       * Bounded at 48 so no arrival costs more than one explosion would.
       */
      if (e.standing && !e.warm) {
        e.warm = true;
        const n = Math.min(48, Math.round(e.rate * e.life));
        for (let i = 0; i < n; i++) this._puff(e, now, dt, e.life);
      }
      const near = cull * 0.62;
      const fade = d2 < near * near ? 1 : 1 - (Math.sqrt(d2) - near) / (cull - near);
      e.acc += e.rate * fade * dt;
      let guard = 8;
      while (e.acc >= 1 && guard-- > 0) {
        e.acc -= 1;
        this._puff(e, now, dt);
      }
    }

    // Heat shimmer sources.
    const fx = this.fx;
    for (let i = 0; i < this.heat.length; i++) {
      const h = this.heat[i];
      if (h.object) {
        if (!h.object.parent) continue;
        h.object.updateWorldMatrix(true, false);
        this._tmp.setFromMatrixPosition(h.object.matrixWorld);
        h.x = this._tmp.x; h.y = this._tmp.y; h.z = this._tmp.z;
      }
      const dx = h.x - cx;
      const dy = h.y - cy;
      const dz = h.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > h.cull * h.cull) {
        h.acc = 0;
        continue;
      }
      h.acc += h.rate * dt;
      let guard = 4;
      const rng = fx.rng;
      while (h.acc >= 1 && guard-- > 0) {
        h.acc -= 1;
        // Rising cells of hot air: born at the source, growing and lifting.
        fx.haze(
          h.x + rng.signed() * h.radius,
          h.y + rng.range(0, h.radius * 0.8),
          h.z + rng.signed() * h.radius,
          h.radius * rng.range(0.45, 0.9),
          2.6,
          rng.range(1.4, 2.6),
          h.strength * rng.range(0.6, 1.25),
          rng.float() < 0.5 ? P.SMOKE_A : P.MIST
        );
      }
    }

    if (this.moteEnabled) this._motes(dt, now, camera);
    this._shimmer(dt, now, camera);

    this._scanTimer += dt;
    if (this._scanTimer > 2) {
      this._scanTimer = 0;
      if (scene) this._scan(scene);
      this._producers();
    }
  }
}
