import * as THREE from 'three';
import { P } from './atlas.js';
import { resetSpawn } from './particles.js';
import { clamp } from './util.js';

/**
 * THE POINT FOUNTAIN'S WATER.
 *
 * `buildings` owns the basin, the plinth and the nozzle ring (`pointFountain`
 * in src/buildings/landmarks.js); this file owns the water: a tall central jet
 * that rises, breaks up and falls back, spray blown off the top, the sheet of
 * white water coming down the plinth tiers, and the splash rings where the
 * sixteen perimeter jets land in the basin. Everything is spawned into the
 * shared lit particle ring (see particles.js) — the simulation is closed-form
 * in the vertex shader, so a fountain running all day costs the CPU only its
 * spawn writes (~3 per frame at ultra).
 *
 * WHERE THE FOUNTAIN IS IS NOT THIS FILE'S DECISION (ARCHITECTURE.md rule 12,
 * "one fact, one owner"). The centre comes from `world.landmarks` (lm_point),
 * and the HEIGHT is anchored to the EMITTED collision: a raycast straight down
 * at the centre hits the basin's concrete filler box. MEASURED on the live
 * build before this file existed: heightAt(-452, 46) = 2.6997 and the centre
 * ray hits 'concrete' at 3.7997 — exactly the builder's `gy + 1.1`. The plinth
 * cylinders do NOT carry colliders (the same measurement shows the ray passing
 * straight through the nozzle tip that a naive reading of `pointFountain`
 * says it should hit at gy + 5.8), so the basin box is the anchor and the
 * nozzle offsets below are ADOPTED from the builder's constants, not
 * re-measured:
 *
 *     basin walk surface   gy + 1.10   MEASURED (the collider the ray hits)
 *     ring nozzle mouths   gy + 2.45   adopted (cyl at gy+1.9, h 0.55, r 5.4)
 *     main nozzle tip      gy + 5.80   adopted (alu cyl gy+3.2, h 2.6)
 *
 * If `buildings` reshapes the plinth these two offsets are the only numbers
 * that move, and the anchor (the measured basin top) still keeps the water on
 * the fountain rather than under the Ohio — which is where a second authored
 * coordinate put it once already (see the header of landmarks.js).
 *
 * STREAMING. Landmarks are always-resident geometry, but their COLLISION is
 * only real triangles within the world's streaming radius of the camera, and a
 * bench boot (fx preview, headless probes) may have no world at all. So:
 *
 *   - nothing is emitted until the basin collider has been FOUND by the
 *     centre raycast (delta over terrain in (0.7, 2.5) m) — i.e. until the
 *     fountain is demonstrably streamed in;
 *   - the anchor is then cached: landmark geometry never unloads, so the
 *     fountain keeps playing when the camera crosses the collision horizon;
 *   - the one exception is the far vista (camera beyond raycast range with no
 *     anchor yet — the mkt_point aerial): there the tall jet alone runs from
 *     the landmark's published x,z and terrain height, gated on a `buildings`
 *     system being present, because at 400+ m the jet is a 40 px column and
 *     the basin detail is sub-pixel anyway. The moment the camera comes into
 *     range the measured anchor replaces the provisional one.
 *
 * BUDGET. `cap` is the fountain's whole steady-state allowance out of the
 * shared lit ring — 4.5% of `q.particleBudget`, floor 60, ceiling 900 — and
 * every per-stream rate is derived as share * cap / life, so the sum of the
 * steady-state populations is <= cap BY CONSTRUCTION. Low tier (< 4000)
 * drops the mist and the plinth cascade entirely and folds their share into
 * nothing: fewer, plainer particles, never a blown budget.
 * `src/fx/fountainprobe.mjs` measures both the arc and the cap on the emitted
 * records.
 *
 * DETERMINISM. All randomness is `fx.rng` (the fork `FxSystem.init` keeps),
 * same as rain; under `?capture=1` the fixed-step replay makes the emitted
 * stream byte-identical run to run.
 */

const TWO_PI = Math.PI * 2;

/** Offsets ADOPTED from src/buildings/landmarks.js `pointFountain` — see header. */
const BASIN_TOP = 1.1; // gy -> basin walk surface (also what the anchor measures)
const RING_NOZZLE = 2.45 - BASIN_TOP; // basin top -> perimeter nozzle mouths
const NOZZLE_TIP = 5.8 - BASIN_TOP; // basin top -> main nozzle tip
/**
 * Basin top -> the DRAWN water plane, which is 35 cm BELOW the collider the
 * anchor measures (`pointFountain` puts the circle at gy + 0.75 and the filler
 * box's top at gy + 1.1). It matters for one thing and only one: a splash ring
 * is `flags = 2`, a ground-aligned mark that is supposed to lie ON a surface,
 * and a ground-aligned quad skips the soft-particle fade — so drawn at the
 * collider height it is a disc hovering a third of a metre over the water with
 * a hard edge, which is exactly the "hoop" the flag exists to avoid.
 */
const WATER_PLANE = 0.75 - BASIN_TOP;
const RING_R = 5.4; // radius of the 16-nozzle ring
const RING_N = 16;

/** Camera distances, metres. Beyond CULL nothing is emitted at all. */
const NEAR_FULL = 180; // full effect
const DETAIL_CUTOFF = 270; // rings / cascade / splash are sub-pixel past this
const JET_FADE0 = 380; // jet starts fading...
const CULL = 560; // ...and is gone here (the mkt_point aerial sits at ~460)
const ANCHOR_RANGE = 300; // raycast confirmation only inside the collision radius

/** Main-jet ballistics (authored): v0 ~21 m/s against g 12, k 0.1 -> ~17 m apex. */
const JET_APEX = 17;

/**
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE PLUME READ AS SMOKE, AND WHAT WHITE WATER NEEDS INSTEAD.
 * ───────────────────────────────────────────────────────────────────────────
 * MEASURED on the emitted `mkt_fountain` frame (1920x1080, 16.8 h scattered,
 * lens 48 m from the jet), the plume column against the sky on the SAME rows:
 *
 *     plume core   sRGB 155.4, 154.5, 152.4   luminance 0.335   R-B  +3
 *     sky beside   sRGB 158.1, 170.8, 180.2   luminance 0.404   R-B  -22
 *
 * — the water was DARKER than the sky it stands against (ratio 0.83) and
 * WARMER than neutral. Darker than the background and warm is the definition
 * of smoke; a backlit jet of water is the brightest thing in the frame.
 *
 * Two causes, both in what this file authored, neither in the shader:
 *
 *   1. INTENSITY DECAYED TO BLACK. `resetSpawn` leaves `i0 = 1, i1 = 0`, and
 *      the vertex shader takes `mix(i0, i1, n*n)` as a multiplier on the
 *      colour — so every droplet faded to black over its life INDEPENDENTLY of
 *      its alpha. That default is authored for a spark, whose colour genuinely
 *      dies; on a 3.5 s water droplet it is a column whose whole upper half is
 *      grey. Not one of the five streams here ever set the pair.
 *   2. THE AUTHORED COLOUR WAS A MID GREY (0.58-0.82) with a token blue tilt
 *      that the warm 16:48 key and the warm bounce in `uAmbBot` more than
 *      cancelled — hence R-B = +3 on a scene whose sky is at -22.
 *
 * So: hold the intensity up across the life, author near-white, and tilt the
 * colour cool by enough to CANCEL the key rather than to nod at it. The
 * `impacts.js` mortar-dust recipe is the precedent for the last part of it —
 * bias the authored colour by geometry rather than adding a shader term.
 *
 * SUN-FACING SCATTER, AND WHY THE GAIN IS ALLOWED PAST 1.
 *
 * The lit-particle shader ends its shading with `lit *= 1/PI` — an irradiance
 * to radiance conversion that assumes an ISOTROPIC scatterer of albedo 1, i.e.
 * a white lambertian surface. That is the right default for smoke and dust and
 * it is the wrong one for a cloud of water droplets, which is a strongly
 * FORWARD scatterer: with the sun behind it, most of what reaches the lens is
 * sunlight that went through the plume rather than off it, and the real phase
 * function peaks one to two orders of magnitude over isotropic. So the gain is
 * a phase term, applied where the recipe can see the geometry, and it is
 * clamped to a factor of three rather than to anything physical.
 *
 * The angle is between the LENS-TO-PLUME ray and `fx.sunWorld()` — the same
 * published sun direction the dust recipes bias off. Squared, because a
 * forward lobe is peaked and a linear ramp brightens the side-lit case (which
 * needs nothing) as fast as the backlit one (which needs all of it). The floor
 * is a touch over 1 because front-lit white water is still white.
 *
 * MEASURED on `mkt_fountain`, whose lens looks WNW into a 16:48 sun: the term
 * lands at `scatter` = 3.18 of a 1.15-3.60 range, i.e. 0.90 of the way to the
 * backlit end. Same box, same settle, same camera as the numbers above:
 *
 *                  plume core lum   sky beside   ratio   R-B
 *     before           0.335          0.404      0.829   +3.0
 *     after            0.469          0.413      1.137   +0.9
 *
 * — the column stops being a smudge 17% darker than the sky and becomes water
 * standing 14% out of it, at neutral rather than warm.
 *
 * CROSS-CHECKED against `?nofountain=1` (fx's own hatch), where the footprint
 * is the set of pixels the fountain MOVES rather than a box round where the jet
 * is supposed to be: over 17 800 px of column the water reads 0.402 against
 * 0.392 for what is behind those same pixels — ratio 1.027, and lower than the
 * box figure for a reason worth knowing, which is that brightening the plume
 * pushes its thinnest fringe THROUGH the background value, so those pixels stop
 * differing and drop out of the footprint. The two measurements bracket it.
 */
const SCATTER_MIN = 1.15;
const SCATTER_MAX = 3.6;

export class FountainFx {
  /**
   * @param {object} fx     the FxSystem
   * @param {object} opts   { budget } — config.q.particleBudget
   */
  constructor(fx, opts = {}) {
    this.fx = fx;
    const budget = opts.budget ?? 6000;
    /** Steady-state particle allowance — the number the probe holds us to. */
    this.cap = Math.round(clamp(budget * 0.045, 60, 900));
    /** Low tier: no mist, no cascade — degrade, don't starve the ring. */
    this.mist = budget >= 4000;

    /**
     * share * cap / life = spawn rate, so share sums <= 1 keep us under cap.
     *
     * REBALANCED, not grown. The crown mist and the basin splashes are the two
     * streams that say "water" from the plaza — the halo the jet breaks up
     * into, and the rings where sixteen perimeter jets land — and at 48 m both
     * were sub-threshold. They are paid for out of the jet and the ring jets,
     * which at that range are a solid column and a solid crown of spray and do
     * not miss the records: jet 0.50 -> 0.44, ring 0.18 -> 0.16, mist 0.16 ->
     * 0.22, splash 0.10 -> 0.12. The sum is still exactly 1, so the
     * steady-state population — the thing `fountainprobe` holds against `cap`
     * — is unchanged by construction.
     */
    const share = this.mist
      ? { jet: 0.44, ring: 0.16, mist: 0.22, splash: 0.12, cascade: 0.06 }
      : { jet: 0.6, ring: 0.2, mist: 0, splash: 0.2, cascade: 0 };
    this.rateJet = (share.jet * this.cap) / 3.8;
    this.rateRing = (share.ring * this.cap) / 1.7;
    this.rateMist = (share.mist * this.cap) / 2.6;
    this.rateSplash = (share.splash * this.cap) / 1.05;
    this.rateCascade = (share.cascade * this.cap) / 1.2;

    /** Set true to hold the water with no code edit — the probe's negative
     *  control, same pattern as `debugIgnorePause` (ARCHITECTURE.md). */
    this.debugDisable = false;

    // anchor state
    this.anchored = false;
    this.provisional = false;
    this.cx = 0;
    this.cz = 0;
    /** Basin walk surface (the measured collider top). */
    this.waterY = 0;
    /** The DRAWN water plane — see WATER_PLANE. Where a splash mark belongs. */
    this.surfaceY = 0;
    this.ringY = 0;
    this.nozzleY = 0;
    this._lm = null;
    this._anchorTimer = 0;
    this._verifyTimer = 0;
    this._misses = 0;

    // spawn accumulators (fractional carry, like rain's)
    this.jetAcc = 0;
    this.ringAcc = 0;
    this.mistAcc = 0;
    this.splashAcc = 0;
    this.cascadeAcc = 0;
    this.spawned = 0;

    /**
     * The sun-facing scatter gain, recomputed once per frame in `update`, and
     * published because it is the one number in this file a reviewer will want
     * to read back off a live session. See the SCATTER note above.
     */
    this.scatter = SCATTER_MIN;

    this._camPos = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._rayD = new THREE.Vector3(0, -1, 0);
  }

  /* ===================================================================== */

  update(dt, now, camera) {
    if (this.debugDisable) return;
    const fx = this.fx;
    const world = fx.ctx.peek('world');
    if (!world) return;
    const lm = this._lm ?? (this._lm = world.landmarks?.find?.((l) => l.id === 'lm_point') ?? null);
    if (!lm) return;

    camera.getWorldPosition(this._camPos);
    const dx = this._camPos.x - lm.x;
    const dz = this._camPos.z - lm.z;
    const dh = Math.hypot(dx, dz);
    if (dh > CULL) return;

    this._anchor(dt, world, lm, dh);
    if (!this.anchored) return;

    const dy = this._camPos.y - this.nozzleY;
    const d = Math.hypot(dh, dy);
    if (d > CULL) return;

    // Jet reads to the horizon of its cull; detail work only near the basin.
    const jetGain = 1 - clamp((d - JET_FADE0) / (CULL - JET_FADE0), 0, 1);
    const nearGain = 1 - clamp((d - NEAR_FULL) / (DETAIL_CUTOFF - NEAR_FULL), 0, 1);
    // A 30 cm droplet is sub-pixel at 300 m; grow sprites with distance so the
    // column still reads as white water in the vista instead of vanishing.
    const distScale = clamp(1 + (d - 140) / 320, 1, 2);
    this._sunScatter();

    this._jet(dt, jetGain, distScale);
    if (this.mist) this._mist(dt, jetGain, distScale);
    if (!this.provisional && nearGain > 0.01) {
      this._ringJets(dt, nearGain);
      this._splashes(dt, nearGain);
      if (this.mist) this._cascade(dt, nearGain);
    }
  }

  /**
   * How hard the plume is being backlit, this frame, as a gain on the authored
   * radiance of every droplet. See the SCATTER note at the top of the file.
   *
   * The ray is the LENS to the middle of the column (half an apex over the
   * nozzle), not the lens to the basin: the top two thirds of the jet is what
   * stands against the sky and what the measurement is taken on. `sunWorld` is
   * `fx`'s published world direction TOWARD the sun, so +1 is shooting into it.
   * Runs once per frame, allocates nothing.
   */
  _sunScatter() {
    const sun = this.fx.sunWorld();
    const vx = this.cx - this._camPos.x;
    const vy = this.nozzleY + JET_APEX * 0.5 - this._camPos.y;
    const vz = this.cz - this._camPos.z;
    const len = Math.hypot(vx, vy, vz) || 1;
    const toward = (vx * sun.x + vy * sun.y + vz * sun.z) / len;
    const t = clamp(toward * 0.5 + 0.5, 0, 1);
    this.scatter = SCATTER_MIN + (SCATTER_MAX - SCATTER_MIN) * t * t;
  }

  /* ===================================================================== */
  /*  anchor                                                               */
  /* ===================================================================== */

  /**
   * Find the basin by measuring it. The centre raycast against MASK.WORLD hits
   * the basin's concrete filler box at gy + 1.1 when the fountain is streamed
   * in, and bare ground (delta ~0) when it is not — which is exactly the
   * "don't water an empty plaza" test. Outside collision range the analytic
   * ground fallback answers, delta ~0, and we correctly stay unanchored.
   */
  _anchor(dt, world, lm, dh) {
    if (this.anchored && !this.provisional) {
      // Landmarks never unload; re-verify only occasionally, and only where
      // the raycast can actually see triangles.
      this._verifyTimer -= dt;
      if (this._verifyTimer > 0 || dh > ANCHOR_RANGE) return;
      this._verifyTimer = 11;
      const top = this._basinTop(world, lm);
      if (top === null) this.anchored = false;
      else this._adopt(lm, top, false);
      return;
    }

    this._anchorTimer -= dt;
    if (this._anchorTimer > 0) return;
    this._anchorTimer = 0.7;

    if (dh <= ANCHOR_RANGE) {
      const top = this._basinTop(world, lm);
      if (top !== null) {
        this._misses = 0;
        this._adopt(lm, top, false);
      } else if (!this.provisional) {
        this.anchored = false;
      } else if (++this._misses >= 4) {
        // A provisional (far-vista) anchor that the ray, now in range, still
        // cannot confirm after ~3 s is watering an empty plaza. Stop.
        this.anchored = false;
        this.provisional = false;
      }
      return;
    }

    // Far vista: no collider to measure. The landmark is always-resident
    // geometry once `buildings` has booted, so its presence is the gate; the
    // provisional height is terrain + the builder's basin offset, and the
    // measured anchor replaces it the moment the camera comes into range.
    if (!this.anchored && this.fx.ctx.peek('buildings')) {
      const terrain = world.heightAt?.(lm.x, lm.z);
      if (Number.isFinite(terrain)) this._adopt(lm, terrain + BASIN_TOP, true);
    }
  }

  /** Measured basin walk surface, or null when the fountain is not there. */
  _basinTop(world, lm) {
    const ph = this.fx.physics;
    if (!ph?.raycast) return null;
    const terrain = world.heightAt?.(lm.x, lm.z);
    if (!Number.isFinite(terrain)) return null;
    this._rayO.set(lm.x, terrain + 25, lm.z);
    const hit = ph.raycast(this._rayO, this._rayD, 60, ph.MASK.WORLD);
    if (!hit?.hit) return null;
    const delta = hit.point.y - terrain;
    // MEASURED: the basin box top sits at exactly +1.10. Bare plaza is ~0,
    // and anything past +2.5 is not the basin (a prop, a bridge deck).
    if (delta < 0.7 || delta > 2.5) return null;
    return hit.point.y;
  }

  _adopt(lm, basinTop, provisional) {
    this.anchored = true;
    this.provisional = provisional;
    this.cx = lm.x;
    this.cz = lm.z;
    this.waterY = basinTop;
    this.surfaceY = basinTop + WATER_PLANE;
    this.ringY = basinTop + RING_NOZZLE;
    this.nozzleY = basinTop + NOZZLE_TIP;
  }

  /* ===================================================================== */
  /*  the water                                                            */
  /* ===================================================================== */

  /** The central jet: clumps of white water thrown ~17 m up off the nozzle. */
  _jet(dt, gain, distScale) {
    const fx = this.fx;
    const rng = fx.rng;
    const sun = fx.sunWorld();
    this.jetAcc += dt * this.rateJet * gain;
    let n = Math.min(6, Math.floor(this.jetAcc));
    this.jetAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      const a = rng.float() * TWO_PI;
      const rr = rng.float() * 0.14;
      s.x = this.cx + Math.cos(a) * rr;
      s.y = this.nozzleY - rng.float() * 0.3;
      s.z = this.cz + Math.sin(a) * rr;
      // Slight lateral scatter is what breaks the column into water; the
      // closed-form drag/gravity in the vertex shader does the arc.
      s.vx = rng.signed() * 0.9;
      s.vy = rng.range(19.5, 23);
      s.vz = rng.signed() * 0.9;
      s.drag = 0.1;
      s.gravity = -12;
      s.life = rng.range(3.3, 3.75);
      s.delay = -rng.float() * dt;
      const kind = rng.float();
      if (kind < 0.55) {
        s.tile = P.SPLASH;
        s.stretch = 0.07;
      } else if (kind < 0.82) {
        s.tile = P.SPRAY;
        s.stretch = 0.1;
      } else {
        s.tile = P.DROPLET;
        s.stretch = 0.2;
      }
      s.size0 = rng.range(0.2, 0.4) * distScale;
      s.size1 = rng.range(0.9, 1.7) * distScale;
      s.sizeCurve = 0.6;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 0.8;
      /**
       * WHITE, HELD WHITE, AND TILTED COOL ENOUGH TO CANCEL A GOLDEN KEY.
       *
       * `b` is near-white now (0.86-1.0 against the old 0.58-0.82) and the
       * end colour barely darkens — a droplet that has been in the air for
       * three seconds is still water. The 0.93 : 0.97 : 1.03 tilt is sized
       * against the MEASURED cast, not chosen as a mood: the frame came back
       * at R-B = +3 with an authored tilt of 0.95 : 1.03, so the light adds
       * about a tenth more red than blue and this cancels it.
       *
       * `sunSide` is the same trick `impacts.js` uses on mortar dust — bias
       * the AUTHORED colour by which way the droplet was thrown — applied to
       * the lateral scatter that breaks the column up, so the side of the
       * plume facing the sun is a third of a stop hotter than the side in its
       * own shadow. Without it a whitened column is one flat sheet.
       */
      const lat = Math.hypot(s.vx, s.vz) || 1e-4;
      const sunSide = 0.9 + 0.34 * Math.max(0, (s.vx * sun.x + s.vz * sun.z) / lat);
      const inten = this.scatter * sunSide;
      const b = rng.range(0.86, 1.0);
      s.r0 = b * 0.90; s.g0 = b * 0.965; s.b0 = b * 1.045;
      s.i0 = inten;
      s.r1 = b * 0.84; s.g1 = b * 0.895; s.b1 = b * 0.975;
      s.i1 = inten * 0.82;
      s.alpha = rng.range(0.28, 0.5);
      s.alphaCurve = 1.3;
      s.soft = 0.35;
      s.fadeIn = 0.03;
      s.turb = 0.12;
      s.turbFreq = 0.8;
      // The top of a tall jet leans downwind — cheap sway off the shared wind.
      s.wind = rng.range(0.04, 0.12);
      // White water lives or dies on catching light — headlights, the flash
      // pool, whatever `sky` keys the night with (same reasoning as rain spray).
      s.lightGain = 2.3;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /**
   * THE HALO AT THE CROWN — spray blown off the top of the jet where it breaks
   * up, and the silhouette element that tells a viewer at fifty metres that the
   * column is water rather than exhaust.
   *
   * It was in the frame already and could not be seen: alpha 0.07-0.16 over a
   * bright sky is under a twentieth of the contrast the sky itself carries
   * across the crown band, and the spawn disc was 1.6 m — narrower than the
   * column it was meant to wreathe, so what it drew was more column. Widened to
   * a 3.2 m disc with the density on the OUTSIDE of it (`Math.sqrt` on the
   * radius is a uniform disc; the 0.35 floor keeps the middle clear), given the
   * jet's own whiteness and held-up intensity, and roughly doubled in alpha.
   */
  _mist(dt, gain, distScale) {
    const fx = this.fx;
    const rng = fx.rng;
    const sun = fx.sunWorld();
    this.mistAcc += dt * this.rateMist * gain;
    let n = Math.min(4, Math.floor(this.mistAcc));
    this.mistAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      const a = rng.float() * TWO_PI;
      const rr = (0.35 + 0.65 * Math.sqrt(rng.float())) * 3.2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      s.x = this.cx + ca * rr;
      s.y = this.nozzleY + JET_APEX * rng.range(0.62, 1.04);
      s.z = this.cz + sa * rr;
      // Outward as well as up: a crown spreads, it does not hang.
      s.vx = ca * rng.range(0.3, 1.0) + rng.signed() * 0.3;
      s.vy = rng.range(-0.4, 1.1);
      s.vz = sa * rng.range(0.3, 1.0) + rng.signed() * 0.3;
      s.tile = rng.float() < 0.6 ? P.MIST : P.PLUME;
      s.size0 = rng.range(0.6, 1.3) * distScale;
      s.size1 = rng.range(2.4, 4.6) * distScale;
      s.sizeCurve = 0.5;
      s.life = rng.range(1.6, 2.8);
      s.drag = rng.range(2.6, 4);
      s.gravity = -1.8;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 0.5;
      // Same cool-white and same sun side as the jet — this IS the jet, three
      // metres later — but off the spawn bearing rather than the velocity,
      // because a halo's lit side is the side of the ring, not of a droplet.
      const sunSide = 0.9 + 0.34 * Math.max(0, ca * sun.x + sa * sun.z);
      const inten = this.scatter * sunSide;
      const b = rng.range(0.84, 0.98);
      s.r0 = b * 0.90; s.g0 = b * 0.965; s.b0 = b * 1.045;
      s.i0 = inten;
      s.r1 = b * 0.82; s.g1 = b * 0.875; s.b1 = b * 0.955;
      s.i1 = inten * 0.8;
      s.alpha = rng.range(0.14, 0.3);
      s.alphaCurve = 1.8;
      s.soft = 0.6;
      s.fadeIn = 0.09;
      s.turb = rng.range(0.2, 0.5);
      s.turbFreq = 0.5;
      s.wind = rng.range(0.5, 0.85);
      s.lightGain = 2.1;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /** The sixteen perimeter nozzles, arcing outward into the basin. */
  _ringJets(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    const sun = fx.sunWorld();
    this.ringAcc += dt * this.rateRing * gain;
    let n = Math.min(4, Math.floor(this.ringAcc));
    this.ringAcc -= n;
    for (let i = 0; i < n; i++) {
      const idx = (rng.float() * RING_N) | 0;
      const a = (idx / RING_N) * TWO_PI;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const s = resetSpawn();
      s.x = this.cx + ca * RING_R + rng.signed() * 0.05;
      s.y = this.ringY + rng.float() * 0.1;
      s.z = this.cz + sa * RING_R + rng.signed() * 0.05;
      const out = rng.range(2.4, 3.4);
      s.vx = ca * out + rng.signed() * 0.25;
      s.vy = rng.range(6.8, 8.6);
      s.vz = sa * out + rng.signed() * 0.25;
      s.drag = 0.12;
      s.gravity = -12;
      s.life = rng.range(1.35, 1.7);
      s.delay = -rng.float() * dt;
      s.tile = rng.float() < 0.6 ? P.SPRAY : P.SPLASH;
      s.stretch = 0.12;
      s.size0 = rng.range(0.14, 0.26);
      s.size1 = rng.range(0.55, 0.92);
      s.sizeCurve = 0.55;
      s.rot = rng.float() * TWO_PI;
      // Same white and the same held intensity as the main jet — sixteen
      // arcs of the same water. `ca, sa` is the nozzle's outward bearing, so
      // the half of the ring throwing into the sun is the bright half.
      const sunSide = 0.9 + 0.34 * Math.max(0, ca * sun.x + sa * sun.z);
      const inten = this.scatter * sunSide;
      const b = rng.range(0.84, 0.98);
      s.r0 = b * 0.90; s.g0 = b * 0.965; s.b0 = b * 1.045;
      s.i0 = inten;
      s.r1 = b * 0.84; s.g1 = b * 0.895; s.b1 = b * 0.975;
      s.i1 = inten * 0.82;
      s.alpha = rng.range(0.3, 0.5);
      s.alphaCurve = 1.4;
      s.soft = 0.25;
      s.fadeIn = 0.03;
      s.wind = 0.06;
      s.lightGain = 2.3;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /**
   * SPLASH RINGS IN THE BASIN — ground-aligned rings and bounce puffs where the
   * sixteen perimeter jets come down.
   *
   * Judged from the plaza rather than from the coping, which is the view every
   * frame of this landmark is shot from. A 0.8 m ring seen from 48 m at eight
   * degrees of depression is about ten pixels across and two high; at alpha
   * 0.2-0.4 on water that is already glittering, it is nothing. So the rings
   * spread to 1.5-2.6 m and live 0.75-1.3 s (the rate is re-derived off that
   * life, so the population is unchanged), and both halves get the jet's white
   * and its held-up intensity instead of fading to a grey two thirds.
   *
   * They stay INSIDE the basin: r 6.8-11.5 m is where a 3 m/s launch off the
   * r 5.4 nozzle ring lands, and the basin wall is at 30 m.
   *
   * MEASURED on the same before/after `mkt_fountain` pair, over the 28 860 px
   * band the sixteen arcs and their landings occupy: mean luminance 0.0653 ->
   * 0.0734, i.e. this water now contributes an eighth of the light in the band
   * it lives in instead of disappearing into the glitter on the basin.
   */
  _splashes(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    this.splashAcc += dt * this.rateSplash * gain;
    let n = Math.min(4, Math.floor(this.splashAcc));
    this.splashAcc -= n;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * TWO_PI;
      // Where the ring jets actually come down: launched outward at ~3 m/s off
      // r 5.4, they land r ~7-11 into the basin.
      const rr = rng.range(6.8, 11.5);
      const x = this.cx + Math.cos(a) * rr;
      const z = this.cz + Math.sin(a) * rr;
      if (rng.float() < 0.62) {
        const s = resetSpawn();
        s.x = x; s.y = this.surfaceY + 0.012; s.z = z;
        s.tile = P.RING;
        s.size0 = 0.06;
        s.size1 = rng.range(1.5, 2.6);
        s.sizeCurve = 0.45;
        s.life = rng.range(0.75, 1.3);
        s.drag = 6;
        s.rot = rng.float() * TWO_PI;
        s.flags = 2; // ground-aligned: a mark ON the water, not a hoop
        const w = rng.range(0.86, 1.0);
        s.r0 = w * 0.92; s.g0 = w * 0.985; s.b0 = w * 1.055;
        s.i0 = this.scatter;
        s.r1 = w * 0.84; s.g1 = w * 0.895; s.b1 = w * 0.975;
        s.i1 = this.scatter * 0.7;
        s.alpha = rng.range(0.3, 0.55);
        s.alphaCurve = 1.5;
        s.soft = 0.12;
        s.fadeIn = 0.1;
        s.lightGain = 2.2;
        s.seed = rng.float();
        fx.emitLit(s);
      } else {
        const m = resetSpawn();
        m.x = x; m.y = this.surfaceY + rng.range(0.03, 0.12); m.z = z;
        m.vx = rng.signed() * 0.4;
        m.vy = rng.range(0.5, 1.6);
        m.vz = rng.signed() * 0.4;
        m.tile = P.MIST;
        m.size0 = rng.range(0.1, 0.2);
        m.size1 = rng.range(0.7, 1.5);
        m.sizeCurve = 0.45;
        m.life = rng.range(0.7, 1.3);
        m.drag = rng.range(3.5, 5.5);
        m.gravity = -1.8;
        m.rot = rng.float() * TWO_PI;
        const b = rng.range(0.84, 0.98);
        m.r0 = b * 0.90; m.g0 = b * 0.965; m.b0 = b * 1.045;
        m.i0 = this.scatter;
        m.r1 = b * 0.84; m.g1 = b * 0.895; m.b1 = b * 0.975;
        m.i1 = this.scatter * 0.75;
        m.alpha = rng.range(0.2, 0.4);
        m.alphaCurve = 1.7;
        m.soft = 0.14;
        m.fadeIn = 0.05;
        m.wind = rng.range(0.4, 0.7);
        m.lightGain = 2.2;
        m.seed = rng.float();
        fx.emitLit(m);
      }
      this.spawned++;
    }
  }

  /** White water sheeting down the plinth tiers under the main jet. */
  _cascade(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    this.cascadeAcc += dt * this.rateCascade * gain;
    let n = Math.min(2, Math.floor(this.cascadeAcc));
    this.cascadeAcc -= n;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * TWO_PI;
      const rr = rng.range(2.6, 4.4);
      const f = Math.pow(rng.float(), 1.5);
      const s = resetSpawn();
      s.x = this.cx + Math.cos(a) * rr;
      s.y = this.waterY + 0.3 + (this.nozzleY - 1.6 - (this.waterY + 0.3)) * f;
      s.z = this.cz + Math.sin(a) * rr;
      s.vx = Math.cos(a) * 0.3;
      s.vy = rng.range(-0.5, -0.1);
      s.vz = Math.sin(a) * 0.3;
      s.drag = 2.2;
      s.gravity = -6;
      s.life = rng.range(0.7, 1.2);
      s.tile = rng.float() < 0.6 ? P.SPLASH : P.MIST;
      s.size0 = rng.range(0.2, 0.35);
      s.size1 = rng.range(0.55, 0.9);
      s.sizeCurve = 0.5;
      s.rot = rng.float() * TWO_PI;
      // The plinth sheet is the same water in shade under the jet: white and
      // held, but a stop under the sunlit column rather than equal to it.
      const b = rng.range(0.7, 0.86);
      s.r0 = b * 0.90; s.g0 = b * 0.965; s.b0 = b * 1.045;
      s.i0 = this.scatter * 0.85;
      s.r1 = b * 0.82; s.g1 = b * 0.875; s.b1 = b * 0.955;
      s.i1 = this.scatter * 0.7;
      s.alpha = rng.range(0.15, 0.3);
      s.alphaCurve = 1.5;
      s.soft = 0.28;
      s.fadeIn = 0.05;
      s.lightGain = 2.2;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  dispose() {}
}
