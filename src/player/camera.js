/**
 * THE CAMERA RIG.
 *
 * Two solvers behind one output: a third-person boom for on foot, and a chase
 * camera for vehicles. Both write `position`, `rotation` and `fov`, and the rig
 * cross-fades between them so getting into a car is one continuous move.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ON-FOOT BOOM
 *
 * 1. PIVOT. A damped follow of the character's neck. Horizontal is tight
 *    (tau 55 ms) so the camera does not feel rubber-banded; vertical is loose
 *    (tau 155 ms) so stairs, kerbs and slopes do not jolt the frame. A hard
 *    leash caps the lag at 1.4 m — without it a teleport or a fall would leave
 *    the pivot behind for half a second.
 *
 * 2. ORBIT. Mouse yaw/pitch integrate into a *target* pair and the live pair
 *    chases them with a 28 ms time constant. That single filter is what turns a
 *    raw mouse delta into GTA's slightly weighty look. Pitch is clamped
 *    asymmetrically (-68 deg down, and up to the per-view ceiling in `VIEWS`),
 *    because in third person you look down at the character far more than you
 *    look up.
 *
 *    THE UP CEILING WAS +34 AND IS NOW +72 (chase/close; +66 far, +76 first
 *    person). A police helicopter orbits 50-70 deg above the horizon and could
 *    not be put under the reticle at all — and since `weapons` fires down the
 *    camera axis, that was the elevation limit of every gun in the game rather
 *    than a framing preference. Above +34 the boom tucks (see `CAMERA.highLook`
 *    and step 3b of `_solveFoot`) because the raised clamp on its own puts the
 *    camera in the pavement. `rig.highLook = false` reverts both halves;
 *    `src/player/camtest.mjs` (family `look`) and
 *    `src/player/aimhighprobe.mjs` gate it, the second by firing a real round
 *    at a target 50 m up.
 *
 * 3. BOOM GEOMETRY. The camera sits at
 *
 *      pos = pivot - forward*distance + right*lateral + up*height
 *
 *    with `forward/right/up` the pitched view basis. That construction has one
 *    very useful property: the character's SCREEN position is invariant to
 *    pitch, so looking up and down never re-frames him — which is also exactly
 *    why the up-ceiling used to be +34: the same invariance means the boom
 *    swings a metre under his feet for every 20 deg of elevation. `distance` grows and
 *    `height` shrinks with speed — the camera swings out and drops as you run,
 *    which is most of what makes a GTA sprint feel fast. Aiming collapses both
 *    and pushes `lateral` out to a shoulder offset that can swap sides.
 *
 * 4. COLLISION. A sphere cast from the pivot along the boom. The boom shortens
 *    to the first blocker, minus a pad. Pull-IN uses an 18 ms time constant
 *    (effectively instant, but still continuous — a hard set produces a visible
 *    step); push-OUT uses 340 ms plus a 6 cm hysteresis band. That asymmetry is
 *    the entire answer to camera jitter in a tight alley, where the cast
 *    flickers between hit and miss every frame: a flicker can only ever pull
 *    the camera in, and it takes a third of a second of sustained free space to
 *    let it back out.
 *
 * 5. When the boom is forced closer than 1.1 m the character fades out, so the
 *    camera never ends up rendering the inside of his skull.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VEHICLE CHASE
 *
 * The single thing that makes a GTA drift readable is that the camera frames
 * the car's DIRECTION OF TRAVEL, not its facing. `travelYaw` comes from the
 * velocity vector and the camera yaw chases it with a 260 ms time constant, so
 * when the back steps out the car rotates inside the frame and you look into
 * the slide. Below 3.2 m/s (and in reverse) it falls back to the car's facing,
 * or the camera would spin on the spot in a car park.
 *
 * On top of that: distance and FOV grow with speed, the boom drops as it grows,
 * and a small roll is driven by the centripetal acceleration.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VIEW CYCLE (V)
 *
 * GTA gives you four views and one key, and the same key does the same thing on
 * foot and in a car. There is no separate "first-person mode" here: the fourth
 * view is the third view with the boom driven to zero and the pivot walked onto
 * the head (on foot) or the bonnet (in a car). That is deliberate, and it is the
 * reason a view change does not register on the continuity meter — the boom
 * length and the pivot are already filtered channels, so cycling views is a
 * DOLLY along the existing solve rather than a cut between two solvers. Measured
 * over a full cycle the peak camera acceleration stays inside the same envelope
 * as a sprint start.
 *
 * The character fades out on its own once the boom is inside 1.1 m, which is
 * what stops the head filling the frame at zero distance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Nothing in here allocates after construction, and every filter is an
 * exponential with a real time constant, so the result is identical at 30 fps
 * and 240 fps.
 */

import * as THREE from 'three';
import { CAMERA, CHASE, STANCE, MOVE, VIEWS, VIEW_TIME, TOP_RUN_SPEED } from './tuning.js';
import {
  Spring, RecoilAxis, clamp, clamp01, lerp, approach, smootherstep,
  angleDelta, hashNoise, DEG,
} from './springs.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * THE FLIGHT CHASE — the framing classes `tuning.js` has no record for.
 *
 * `_resolveFrame`'s tag test read `/heli|chopper|rotor|aircraft/`, and not one
 * of the five fixed-wings in `vehicles/specs.js` matches it: `plane`,
 * `sportplane`, `bushplane`, `twinplane` and `jet` all fell through to `car`.
 * So every aeroplane in the game flew on a camera solved for a hatchback — a
 * 6.9 m boom pitched 9 degrees down at a machine that is 10 m long, climbs at
 * 20 m/s and banks to 60, with a sphere cast probing for kerbs 300 m under it.
 *
 * `CHASE.classFrame` is the right home for `dist` / `height`, and these seven
 * flight fields belong beside them — but `tuning.js` is another change's file,
 * so they live here and are exported for the gate to revert. See the followup.
 *
 * The FLIGHT fields, and what each is for:
 *   lagGain      multiplies the yaw settle. A car's 0.26 s reads as "loose"
 *                behind a car and as "welded on" behind an aeroplane, because
 *                a roll rate of 120 deg/s swings the travel vector far faster
 *                than any steering rack does. MEASURED on the emitted camera:
 *                0.5 s after a 69-degree step in travel the flight chase is
 *                still 17.2 degrees behind, against the car chase's 7.0.
 *   followGain   the same, for the pivot's positional lag — deliberately much
 *                smaller, because this one is paid in METRES. The pivot's
 *                steady-state lag is v * tau, so at 60 m/s each 0.075 s of
 *                time constant is 4.5 m of extra boom; 1.5 already takes the
 *                framing distance from 11 m at rest to 19 m at cruise.
 *   pitchClimb   radians of camera pitch per unit of sine-of-climb-angle.
 *                TUNED against the gate it serves rather than by feel: the
 *                target is that a climb does not move the aircraft in frame,
 *                and at 0.95 the emitted shift over climbs of +22, +10 and
 *                -15 m/s is 0.68 / 0.16 / 0.05 degrees, against the car
 *                framing's 6.51 / 2.92 / 4.25.
 *   pitchLow     the boom's tilt on the deck. Steeper than the car law's -9,
 *                because a low pass and an approach are the two things you fly
 *                by looking at the ground.
 *   pitchHigh    ...and at `altRef` and above, where the useful picture is the
 *                horizon and the sky ahead of the nose.
 *   altRef       metres of altitude over which the boom eases between them.
 *   noCollideAlt metres AGL past which the boom stops sphere-casting at all.
 *
 * The car law that these replace is a function of GROUND SPEED — -9 degrees
 * easing to -4.5 at `speedRef` (38 m/s). Every aeroplane in the game cruises
 * past that, so on the car camera the tilt was pinned at -4.5 for the whole
 * flight, from the runway to the ceiling. Altitude is the variable that
 * actually changes what is worth looking at up there; airspeed is not.
 */
export const FLIGHT = {
  lagGain: 1.9,
  followGain: 1.5,
  pitchClimb: 0.95,
  pitchLow: -12 * DEG,
  pitchHigh: 0,
  altRef: 90,
  noCollideAlt: 12,
};

/**
 * Framing classes owned here rather than by `tuning.js`. `sizeGain: false` for
 * the same reason the bus and the heli have it: a class with its own framing
 * must not ALSO take the per-metre length gain, or a 12 m twin is paid for
 * twice. 30/18 against the car's 18 is the widest of the four classes, which is
 * what a 15 m wingspan needs to sit inside the frame.
 */
export const EXTRA_FRAMES = {
  plane: {
    dist: CHASE.distBase * (30 / 18), height: 1.5, sizeGain: false, flight: true,
  },
};

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE RIDE CAMERA — what the lens does while you are a PASSENGER
 * ────────────────────────────────────────────────────────────────────────────
 * Riding the trolley or the incline is the one time in this game the player is
 * not steering anything, and a chase camera welded 7 m behind a vehicle he is
 * not driving is the worst possible answer: it frames the back of a box for two
 * minutes. So a passenger gets an AUTOMATIC camera — a short reel of authored
 * framings that CUT between each other every few seconds, the way a title
 * sequence covers a train.
 *
 * WHY CUTS AND NOT ONE MOVING SHOT. A single continuous camera has to solve
 * "where should I be" for every second of a 45 s ride, and the honest answer
 * changes: on the flat straight the picture is the car against the street, on
 * the climb it is the city opening up behind. One shot that tries to be both
 * spends its time travelling between them. Cutting is free, it is what film
 * does, and each shot then only has to be right for its own six seconds.
 *
 * THE REEL, and what each shot is for:
 *
 *   vista    THE POSTCARD, and the reason this exists. The camera stands on
 *            the far side of the car from `transit.vista` and looks back
 *            THROUGH the car at it — so on the incline the shot is the car
 *            climbing with downtown unfolding behind it, which is the single
 *            most photographed view in Pittsburgh and the whole point of
 *            riding the thing. Skipped by services with no vista (the trolley
 *            runs down a street; there is nothing behind it but the street).
 *   track    exterior tracking: the lens paces the car from off the flank,
 *            low, so the city streams past the window band.
 *   window   over-shoulder, INSIDE: the lens sits at the passenger's shoulder
 *            and looks forward and outboard through the glass. This is the one
 *            that sells "I am on the tram" rather than "I am watching a tram".
 *   reveal   a WORLD-FIXED wide: the camera is planted ahead of the car when
 *            the shot starts and does not move; the car travels through frame
 *            and out of it. The only shot with no camera motion at all, which
 *            is what makes the moving ones read as moving.
 *   orbit    a slow arc round the car at walking pace — 9 deg/s, so it reads
 *            as a drift rather than a spin.
 *
 * Every shot is a POSITION and a LOOK POINT, both solved analytically from the
 * subject's drawn pose and then eased with one time constant, and both SNAPPED
 * on a cut. Nothing here is random (hard rule 4): the reel is a fixed cycle and
 * the side flips on the shot index, so a capture of the same ride is the same
 * film twice.
 *
 * `dur` seconds, `fov` multiplies the base FOV, `lens` is the ease time
 * constant (a long lens on a static wide wants a slower hand than a tracking
 * shot).
 */
export const CINE = {
  /** Cross-fade in and out of the reel, seconds. A cut INSIDE it is instant. */
  blendTau: 0.32,
  /** How fast the shot solves ease toward their ideal, seconds. */
  tau: 0.30,
  /** Framing radius floor after a collision pull-in, metres. */
  minRadius: 1.4,
  /** Seconds a live shot may stay blocked before the reel cuts away from it. */
  blockGrace: 0.5,
  /**
   * A framing is only offered if at least this much of the way from the
   * subject to the lens is free when the cut happens. See `_cineClearance`.
   */
  minClear: 0.6,
  shots: [
    /**
     * The postcard is the ONE shot that has to hold two subjects at once — the
     * car, steeply below the lens, and a city on the horizon — so it is the one
     * shot with a wide lens. At 1.45 the vertical half-angle is ~45 deg, which
     * is what lets a 47 deg separation sit inside the frame at all; at the
     * reel's normal 0.9-1.0 it cannot, and no amount of aiming fixes that.
     */
    { id: 'vista', dur: 7.0, fov: 1.45, vista: true },
    { id: 'track', dur: 6.0, fov: 1.00 },
    { id: 'window', dur: 5.0, fov: 1.02 },
    { id: 'reveal', dur: 6.5, fov: 0.86 },
    { id: 'orbit', dur: 6.0, fov: 1.00 },
  ],
};

export class CameraRig {
  constructor(ctx) {
    this.ctx = ctx;
    const C = CAMERA;

    /* ---- orbit ---- */
    this.yaw = 0;
    this.pitch = C.orbit.restPitch;
    this.yawTarget = 0;
    this.pitchTarget = C.orbit.restPitch;
    this.yawRate = 0;
    this.lookIdle = 0;

    /* ---- pivot ---- */
    this.pivot = new THREE.Vector3();
    this.pivotTarget = new THREE.Vector3();
    this.anchor = STANCE.stand.anchor;

    /* ---- boom ---- */
    this.distance = C.boom.distIdle;
    this.distIdeal = C.boom.distIdle;
    this.height = C.boom.heightIdle;
    this.lateral = C.boom.lateralIdle;
    this.shoulder = 1; // +1 right, -1 left
    this.shoulderBlend = 1;
    this.collideRadius = C.boom.distIdle;
    this.characterFade = 1;
    /**
     * NEGATIVE CONTROL for the elevation work, and the only switch that turns
     * it off: false restores the +34 deg third-person ceiling AND the untucked
     * boom, i.e. exactly the build that could not put a reticle on a police
     * helicopter. Both halves are one flag on purpose — reverting the clamp
     * without the tuck is a build nobody shipped, so a control that reverted
     * only one of them would be measuring a third thing.
     * `src/player/camtest.mjs --control=look` flips it.
     */
    this.highLook = true;
    /** 0..1 share of the pitch range above the knee. Published for the gates. */
    this.highLookT = 0;
    /**
     * Rings of recent free-space measurements. The boom uses the MINIMUM over
     * the window, so a single frame in which the sphere cast happens to miss
     * can never release the camera into a wall. That is the other half of the
     * anti-jitter story; the first half is the asymmetric time constants.
     */
    this._freeRing = new Float32Array(C.collide.window).fill(C.boom.distIdle);
    this._freeCursor = 0;
    this._chaseRing = new Float32Array(C.collide.window).fill(CHASE.distBase);
    this._chaseCursor = 0;

    /* ---- vehicle ---- */
    this.vehicle = null;
    this.vehicleBlend = 0;
    this.chaseYaw = 0;
    this.chasePitch = CHASE.pitchBase;
    this.chaseDist = CHASE.distBase;
    this.chaseHeight = CHASE.heightIdle;
    this.chaseRoll = 0;
    this.chaseFov = 0;
    this.chaseTravelYaw = 0;
    this.chasePrevTravel = 0;
    this.chaseRadius = CHASE.distBase;
    this.chasePivot = new THREE.Vector3();
    this._footFov = ctx.config.fov * CAMERA.fovScale;
    this._chaseFov = this._footFov;
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.manualAge = 99;
    /* ---- view cycle (V) ---- */
    this.view = 0;
    /** Smoothed 0..1 "how first-person are we", so a cycle is a dolly. */
    this.nearBlend = 0;
    this._viewDist = 1;
    this._viewHeight = 1;
    this._viewLateral = 1;
    /** Timed transition, 0..1. See VIEW_TIME. */
    this._viewT = 1;
    this._viewDur = VIEW_TIME.min;
    this._viewFrom = { dist: 1, height: 1, lateral: 1, near: 0 };
    this._bonnet = new THREE.Vector3();
    /** True when the fourth view sits in a cabin. See `_resolveFrame`.
     * Published via `interiorEye` — `player` collapses the head bone off it
     * so the lens never sits inside a rendered skull. */
    this._interiorEye = false;

    this._chasePos = new THREE.Vector3();
    this._chaseQuat = new THREE.Quaternion();
    this._footPos = new THREE.Vector3();
    this._footQuat = new THREE.Quaternion();
    this._vehPos = new THREE.Vector3();
    this._vehVel = new THREE.Vector3();
    this._vehFwd = new THREE.Vector3();
    this._vehRight = new THREE.Vector3();
    this._vehQuat = new THREE.Quaternion();

    /* ---- feel channels (unchanged public API) ---- */
    this.dip = new Spring(C.land.freq, C.land.damping, 0);
    this.step = new Spring(C.step.freq, C.step.damping, 0);
    this.recoilPitch = new RecoilAxis(C.recoil.freq, C.recoil.damping, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilYaw = new RecoilAxis(C.recoil.freq * 1.08, C.recoil.damping + 0.06, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilRoll = new RecoilAxis(C.recoil.freq * 0.86, C.recoil.damping + 0.1, C.recoil.residualTau, 0.24);
    this.punch = new Spring(C.recoil.punchFreq, C.recoil.punchDamping, 0);
    this.kickPitch = new RecoilAxis(11, 0.58, 0.22, 0.28);
    this.kickYaw = new RecoilAxis(11.5, 0.6, 0.22, 0.28);
    this.kickRoll = new RecoilAxis(9, 0.62, 0.22, 0.22);
    this.trauma = 0;
    this.shakeTime = 0;
    this.breathPhase = 0;
    this.strafeRoll = 0;
    this.turnRoll = 0;
    this.airRoll = 0;

    /* ---- fov ---- */
    this.baseFov = ctx.config.fov * CAMERA.fovScale;
    this.fov = this.baseFov;
    this.fovMove = 0;
    this.fovAim = 1;
    /** 0..1 filter of `movement.sprinting` — see the boom section of update(). */
    this.sprintCommit = 0;

    /* ---- the ride camera (see CINE) ---- */
    /**
     * `active` is the request, `blend` is how much of the frame it owns. They
     * are separate so ending the reel is a cross-fade back to the chase rather
     * than a cut to it — a cut INTO gameplay reads as a glitch, where a cut
     * between two authored shots reads as editing.
     */
    this.cine = {
      active: false,
      target: null,
      blend: 0,
      /** Index into `CINE.shots`, and seconds spent in it. */
      shot: 0,
      t: 0,
      /** How many cuts this ride has made — published for the gates. */
      cuts: 0,
      /** Seeded per shot so the solve is stable across the shot. */
      side: 1,
      /** True on the frame a cut happened, for a harness that samples it. */
      cut: false,
    };
    this._cinePos = new THREE.Vector3();
    this._cineQuat = new THREE.Quaternion();
    this._cineLook = new THREE.Vector3();
    this._cineWant = new THREE.Vector3();
    this._cineWantLook = new THREE.Vector3();
    this._cineAnchor = new THREE.Vector3();
    this._cineSubPos = new THREE.Vector3();
    this._cineSubQuat = new THREE.Quaternion();
    /** Where a world-fixed shot was planted at its cut. */
    this._cineFixed = new THREE.Vector3();
    this._cineFov = this._footFov;
    this._cineFresh = false;
    /** Seconds the live shot has been obstructed. See CINE.blockGrace. */
    this._cineBlockT = 0;

    /* ---- outputs ---- */
    this.position = new THREE.Vector3();
    this.eyePosition = this.position; // legacy alias
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ');
    this.quaternion = new THREE.Quaternion();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.viewKick = { pitch: 0, yaw: 0, roll: 0, punch: 0 };
    this.bobPhase = 0;
    this.eye = STANCE.stand.eye;

    /* ---- scratch ---- */
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');

    /* ---- framing class ---- */
    /** Resolved once per vehicle, never per frame — see `_resolveFrame`. */
    this.frameClass = 'car';
    this._frame = CHASE.classFrame.car;
    /** Live align rate, published for tools. NOT what any gate asserts on. */
    this.alignRate = 0;

    /* ---- the world shaking the camera ---- */
    this._offEvents = [];
    this._bindEvents(ctx);
  }

  /* ==================================================================== */
  /* the world shaking the camera                                         */
  /* ==================================================================== */

  /**
   * `police` has been emitting `camera:shake` on every scripted ram since it
   * was written, with a comment saying the player camera may not consume it
   * yet. `vehicles` has been emitting `vehicle:collision` for every impact in
   * the city. Nothing listened to either, so a crash produced sparks, a metal
   * transient, real damage and a real change of velocity — and a camera that
   * did not so much as flinch.
   *
   * Subscribing here rather than in `src/player/index.js` keeps the whole feel
   * model in one file and, more usefully, makes it testable without standing
   * up a PlayerSystem: `camtest.mjs` drives these with a four-line emitter.
   */
  _bindEvents(ctx) {
    const on = ctx?.events?.on;
    if (typeof on !== 'function') return;
    const sub = (type, fn) => {
      const off = ctx.events.on(type, fn);
      if (typeof off === 'function') this._offEvents.push(off);
    };
    sub('camera:shake', (e) => this._onShake(e));
    sub('vehicle:collision', (e) => this._onVehicleCollision(e));
  }

  dispose() {
    for (const off of this._offEvents) off();
    this._offEvents.length = 0;
  }

  /**
   * 1 at the impact, 0 far away. Distances are measured from the camera's own
   * last emitted position, not from the character — the camera is what is
   * being shaken, and in a car it is six metres behind him.
   */
  _proximity(p) {
    if (!p || !Number.isFinite(p.x)) return 1;
    const C = CAMERA.crash;
    const dx = p.x - this.position.x;
    const dy = p.y - this.position.y;
    const dz = p.z - this.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return 1 - clamp01((d - C.near) / Math.max(1e-4, C.far - C.near));
  }

  /** `camera:shake { amount, position }` — police's scripted cruiser ram. */
  _onShake(e) {
    const a = (e?.amount ?? 0) * CAMERA.crash.shakeScale;
    if (!(a > 0)) return;
    this.addTrauma(a * this._proximity(e.position));
  }

  /**
   * `vehicle:collision { vehicle, other, point, normal, impulse, speed }`.
   *
   * `other` is the thing that was hit. `vehicles` fills it from
   * `staticWorld.objectOf(tri)?.mesh` for a strike against the city and with
   * the other Vehicle for a car-to-car shunt — so "does it have a velocity and
   * a spec" is the discriminator, and it does not depend on agreeing a naming
   * convention with a subsystem being written in parallel.
   */
  _onVehicleCollision(e) {
    const v = e?.vehicle;
    if (!v) return;
    const C = CAMERA.crash;
    const mass = v.mass ?? v.spec?.mass ?? 1200;
    const dv = (e.impulse ?? 0) / Math.max(1, mass);
    const sev = clamp01((dv - C.dvMin) / Math.max(1e-4, C.dvFull - C.dvMin));
    if (sev <= 0) return;
    const mine = v === this.vehicle;
    // A car-to-car shunt is reported twice, once from each side. Without this
    // the player's own collision would be counted again as a bystander's.
    //
    // The `this.vehicle` guard is not decoration: `other` is null when a car
    // hits city geometry that has no mesh behind it, and on foot `this.vehicle`
    // is null too — so without it, `null === null` swallowed every building
    // crash the player was standing next to.
    if (!mine && this.vehicle && e.other === this.vehicle) return;
    const hitVehicle = !!(e.other && e.other.velocity && e.other.spec);
    const base = hitVehicle ? C.vehicle : C.building;
    const scale = mine ? 1 : C.remoteScale * this._proximity(e.point);
    if (!(scale > 0)) return;
    this.addTrauma(base * sev * scale);
  }

  /**
   * Which framing this vehicle wants. Resolved on `setVehicle`, never in
   * `update` — the tag test builds a string and hard rule 5 says nothing
   * allocates per frame.
   *
   * The bus and helicopter classes may not have landed in `vehicles` yet, so
   * this matches on anything it might plausibly publish rather than on one
   * field name agreed in advance, and anything unrecognised lands on `car` and
   * keeps exactly today's framing.
   */
  _resolveFrame(v) {
    this.frameClass = 'car';
    if (v) {
      const spec = v.spec ?? v.def ?? null;
      const explicit = v.cameraClass ?? spec?.cameraClass;
      const tag = (`${spec?.kind ?? ''} ${spec?.class ?? ''} ${spec?.id ?? ''} ` +
        `${spec?.type ?? ''} ${v.type ?? ''}`).toLowerCase();
      /**
       * ROTORCRAFT FIRST, then fixed-wing. The two tests overlap — a spec that
       * says `heli` and a spec that says `plane` are both aircraft, and the
       * `fly` flag says only that it leaves the ground — so the order is what
       * decides, and putting the rotor test first is what keeps a `newsheli`
       * out of the fixed-wing framing. An unqualified `aircraft` tag stays on
       * the rotor class it has always resolved to.
       */
      const rotor = /heli|chopper|rotor|aircraft/.test(tag);
      const wing = /plane|jet|glider|wing/.test(tag);
      if (explicit && (CHASE.classFrame[explicit] || EXTRA_FRAMES[explicit])) {
        this.frameClass = explicit;
      } else if (rotor) {
        this.frameClass = 'heli';
      } else if (wing) {
        this.frameClass = 'plane';
      } else if (spec?.fly === true || spec?.air === true || v.fly === true) {
        this.frameClass = 'heli';
      } else if (/bus|coach|transit/.test(tag)) {
        this.frameClass = 'bus';
      }
    }
    this._frame = EXTRA_FRAMES[this.frameClass] ??
      CHASE.classFrame[this.frameClass] ?? CHASE.classFrame.car;
    /**
     * DOES THIS THING HAVE A CABIN TO SIT IN. Resolved here, with the frame,
     * so the fourth-view pivot never has to test a string per frame.
     *
     * `vehicles/build.js` builds `buildInterior` — a dash across a cowl, a
     * headliner under a roofline, door cards against a sill — for `kind: 'car'`
     * and for nothing else; bikes, boats, aircraft, trams and the tank all take
     * the empty interior. So that is exactly the set that gets an eye point in
     * a cabin, and everything else keeps the bonnet mount it has always had.
     *
     * The style fields the construction needs must all be present, or a spec
     * that publishes a partial style would put the lens at NaN.
     */
    const st = v?.spec?.kind === 'car' ? v.spec.style : null;
    this._interiorEye = !!st &&
      Number.isFinite(st.groundY) && Number.isFinite(st.sillY) &&
      Number.isFinite(st.beltY) && Number.isFinite(st.roofY) &&
      Number.isFinite(st.hwMax) && Number.isFinite(st.cowlZ);
    return this.frameClass;
  }

  /* ==================================================================== */
  /* control                                                              */
  /* ==================================================================== */

  reset(anchor = STANCE.stand.anchor, pos = null, yaw = null) {
    this.anchor = anchor;
    if (yaw !== null) {
      this.yaw = this.yawTarget = yaw;
      this.pitch = this.pitchTarget = CAMERA.orbit.restPitch;
    }
    if (pos) {
      this.pivotTarget.set(pos.x, pos.y + anchor, pos.z);
      this.pivot.copy(this.pivotTarget);
    }
    // The player's chosen view survives a teleport; its channels are snapped
    // rather than filtered, or every respawn would dolly from the default.
    const V = VIEWS[this.view];
    this.nearBlend = V.near;
    this._viewDist = V.dist;
    this._viewHeight = V.height;
    this._viewLateral = V.lateral;
    this._viewT = 1;
    this._viewDur = VIEW_TIME.min;
    const d0 = CAMERA.boom.distIdle * V.dist;
    this.distance = this.distIdeal = this.collideRadius = d0;
    // Seed the history, or a teleport inherits the previous location's minimum.
    this._freeRing?.fill(d0);
    this._chaseRing?.fill(CHASE.distBase * V.dist);
    this.chaseRadius = CHASE.distBase * V.dist;
    this.height = CAMERA.boom.heightIdle * V.height;
    this.lateral = CAMERA.boom.lateralIdle * V.lateral;
    this.dip.reset(0);
    this.step.reset(0);
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.recoilRoll.reset();
    this.kickPitch.reset();
    this.kickYaw.reset();
    this.kickRoll.reset();
    this.punch.reset(0);
    this.trauma = 0;
    this.strafeRoll = this.turnRoll = this.airRoll = 0;
    this.fovMove = 0;
    this.fovAim = 1;
    this.sprintCommit = 0;
    this.characterFade = 1;
    this.manualYaw = this.manualPitch = 0;
    this.vehicleBlend = this.vehicle ? 1 : 0;
  }

  /** Mouse / stick look. Deltas are already in radians. */
  addLook(dYaw, dPitch) {
    if (dYaw === 0 && dPitch === 0) {
      return;
    }
    this.lookIdle = 0;
    /**
     * MOUSE LOOK DOES NOT END THE REEL, AND IT DOES NOT BANK EITHER.
     *
     * The ride camera is deliberately exited on a MOVE key or F (see
     * `src/player/vehicle.js`) and not on a mouse delta — a twitch of the hand
     * must not throw away an authored shot the player is watching. But the
     * deltas cannot be integrated in the meantime either: `manualYaw` would
     * accumulate through a 45 s ride and the chase camera would come back
     * pointing at the sky. Swallow them; pointer lock is untouched either way,
     * which is what keeps `src/ui/lockuxprobe.mjs` measuring the same thing.
     */
    if (this.cine.active) return;
    if (this.vehicle) {
      this.manualYaw = clamp(this.manualYaw + dYaw, -Math.PI, Math.PI);
      this.manualPitch = clamp(
        this.manualPitch + dPitch, CHASE.lookPitchMin, CHASE.lookPitchMax
      );
      this.manualAge = 0;
      return;
    }
    this.yawTarget += dYaw;
    if (this.yawTarget > Math.PI) this.yawTarget -= Math.PI * 2;
    else if (this.yawTarget < -Math.PI) this.yawTarget += Math.PI * 2;
    this.pitchTarget = clamp(this.pitchTarget + dPitch, CAMERA.orbit.pitchMin, this.pitchMax);
  }

  /* ==================================================================== */
  /* the view cycle                                                       */
  /* ==================================================================== */

  /**
   * How far up this view is allowed to look. See VIEWS in tuning.js.
   *
   * First person is exempt from the control switch: its 76 deg predates the
   * elevation work and has nothing to do with the boom, which is 3 cm long.
   */
  get pitchMax() {
    const pm = VIEWS[this.view].pitchMax;
    if (this.highLook || VIEWS[this.view].near === 1) return pm;
    return Math.min(pm, CAMERA.orbit.pitchMax);
  }

  get viewSpec() {
    return VIEWS[this.view];
  }

  get viewId() {
    return VIEWS[this.view].id;
  }

  /** True once the fourth view has actually arrived, not merely been asked for. */
  get firstPerson() {
    return this.nearBlend > 0.72;
  }

  /** True while the fourth view's eye sits inside a modelled cabin. */
  get interiorEye() {
    return this._interiorEye;
  }

  /** Snapshot where the channels are NOW and start a fresh timed ease. */
  _beginViewChange() {
    this._viewFrom.dist = this._viewDist;
    this._viewFrom.height = this._viewHeight;
    this._viewFrom.lateral = this._viewLateral;
    this._viewFrom.near = this.nearBlend;
    this._viewT = 0;
  }

  /** Time the ease by how far the boom actually has to travel. */
  _viewDuration(next) {
    const travel = Math.abs(next.dist - this._viewDist) * CAMERA.boom.distIdle;
    return clamp(
      VIEW_TIME.min + travel * VIEW_TIME.perMetre, VIEW_TIME.min, VIEW_TIME.max
    );
  }

  /** V. Advances the cycle and returns the new spec. */
  cycleView(dir = 1) {
    const next = VIEWS[(this.view + dir + VIEWS.length * 2) % VIEWS.length];
    this._viewDur = this._viewDuration(next);
    this._beginViewChange();
    this.view = (this.view + dir + VIEWS.length * 2) % VIEWS.length;
    // Coming back out of the fourth view must not leave the pitch stuck above
    // the third-person clamp, or the boom starts underneath the character.
    const pm = this.pitchMax;
    if (this.pitchTarget > pm) this.pitchTarget = pm;
    if (this.pitch > pm) this.pitch = pm;
    return VIEWS[this.view];
  }

  setView(idOrIndex) {
    const i = typeof idOrIndex === 'number'
      ? idOrIndex
      : VIEWS.findIndex((v) => v.id === idOrIndex);
    if (i < 0 || i >= VIEWS.length) return VIEWS[this.view];
    if (i !== this.view) {
      this._viewDur = this._viewDuration(VIEWS[i]);
      this._beginViewChange();
    }
    this.view = i;
    return VIEWS[this.view];
  }

  setVehicle(v) {
    if (v === this.vehicle) return;
    this.vehicle = v ?? null;
    this._resolveFrame(this.vehicle);
    if (this.vehicle) {
      this.manualYaw = this.manualPitch = 0;
      this.manualAge = 99;
    } else {
      // Hand the orbit back to the on-foot solver where the chase left it.
      this.yawTarget = this.yaw = this.chaseYaw;
      this.pitchTarget = this.pitch = clamp(
        this.chasePitch, CAMERA.orbit.pitchMin, CAMERA.orbit.pitchMax
      );
    }
  }

  /* ==================================================================== */
  /* the ride camera                                                      */
  /* ==================================================================== */

  /** True while the reel owns any of the frame — including the fade out. */
  get cinematicActive() {
    return this.cine.active;
  }

  /** The shot on screen right now, or null. Published for the gates and `ui`. */
  get cinematicShot() {
    return this.cine.active || this.cine.blend > 0 ? CINE.shots[this.cine.shot].id : null;
  }

  /**
   * Start the reel on `target` — anything that publishes a drawn pose and a
   * `transit` record (see `src/vehicles/tram.js`). Idempotent: calling it again
   * with the same target does not restart the reel, so a per-frame caller is
   * safe.
   */
  beginCinematic(target) {
    if (!target) return false;
    if (this.cine.active && this.cine.target === target) return true;
    this.cine.active = true;
    this.cine.target = target;
    this.cine.t = 0;
    this.cine.cuts = 0;
    this.cine.cut = true;
    this._cineFresh = true;
    // Open on the postcard when the service has one, on the tracking shot
    // when it does not — never on the interior, which means nothing until the
    // player has seen the outside of the thing he just got into.
    this.cine.shot = target.transit?.vista ? 0 : 1;
    this.cine.side = 1;
    return true;
  }

  /**
   * Hand the frame back to the normal camera. The fade is in `update`, and the
   * TARGET IS DELIBERATELY KEPT until the fade completes: the last shot goes on
   * tracking the car while the frame dissolves back to the chase. Dropping it
   * here instead makes `_solveCine` publish the chase pose it is fading FROM,
   * so the cross-fade has nothing to cross and the hand-back is a cut — which
   * is exactly the glitch the fade exists to avoid.
   */
  endCinematic() {
    if (!this.cine.active) return false;
    this.cine.active = false;
    return true;
  }

  /** Advance to the next framing in the reel. A CUT: the solve is snapped. */
  _cineCut() {
    const shots = CINE.shots;
    const hasVista = !!this.cine.target?.transit?.vista;
    let n = this.cine.shot;
    for (let i = 0; i < shots.length; i++) {
      n = (n + 1) % shots.length;
      if (!shots[n].vista || hasVista) break;
    }
    this.cine.shot = n;
    this.cine.t = 0;
    this.cine.cuts++;
    this.cine.cut = true;
    this.cine.side = this.cine.cuts % 2 === 0 ? 1 : -1;
    this._cineFresh = true;
  }

  /**
   * Place shot `S`: fill `want` with where the lens goes and `look` with what
   * it points at, both in world space, from the subject basis this frame's
   * `_solveCine` has already built.
   *
   * Split out of the solver so a framing can be TRIED before it is committed —
   * see `_cineClearance` and the shot rejection in `_solveCine`.
   */
  _cineFrame(S, v, want, look, fresh) {
    const seat = v.transit?.seat;
    const half = v.spec?.half;
    const len = half ? half.z * 2 : 6;
    const hw = v.transit?.hw ?? (half ? half.x : 1.2);
    const side = this.cine.side;
    look.copy(this._cineAnchor);

    switch (S.id) {
      case 'vista': {
        /**
         * THE POSTCARD. Stand UPHILL of the car — on the far side of it from
         * `transit.vista` — and look back down THROUGH the car at the vista, so
         * the climb, the carriage and the city behind it are one picture.
         * `_tmp` is the horizontal bearing from the vista to the car; the lens
         * is that bearing continued past the car, swung out to one flank and
         * lifted well clear of the trestle.
         *
         * IT HAS TO BE AN AERIAL, and that is geometry rather than taste.
         * "Uphill of the car" on a funicular is THE HILL: MEASURED on the
         * emitted incline, an offset of 25 m up the run gains about 25 m of
         * terrain, so a lens set 12 m above the car 25 m behind it is inside
         * Mt. Washington — the first capture of this shot photographed the
         * inside of the lower station's headhouse for exactly that reason. The
         * rise is therefore steeper than the hill's (26 m over ~18 m of
         * offset, ~55 deg against the run's ~50), which is also the angle the
         * real postcard is taken from.
         *
         * It is still legitimately unavailable at the bottom of the run, where
         * the headhouse is; that is not handled here but by the shot being
         * REJECTED at the cut (see `_cineClearance`), which is the right place
         * for it because every exterior shot has the same failure mode
         * somewhere in a city.
         */
        const vp = v.transit.vista;
        this._tmp.set(this._cineAnchor.x - vp.x, 0, this._cineAnchor.z - vp.z);
        if (this._tmp.lengthSq() < 1e-4) this._tmp.copy(this._vehFwd);
        this._tmp.normalize();
        want.copy(this._cineAnchor)
          .addScaledVector(this._tmp, len * 0.6 + 10)
          .addScaledVector(this._vehRight, side * (len * 0.5 + 7));
        want.y = this._cineAnchor.y + 26.0;
        /**
         * AIM BETWEEN THE TWO, not at the car.
         *
         * The lens is 26 m above the car and 16 m behind it — 52 degrees down —
         * while the city it is meant to show is 500 m out and 5 degrees down.
         * Pointing at the car puts the city off the top of the frame and
         * pointing at the city loses the car off the bottom; the shot is the
         * bisector, weighted slightly toward the subject. `_tmp` and `_tmp2`
         * are the two unit directions; the blend is the EXACT bisector and is
         * renormalised because they are ~47 degrees apart and their sum is not
         * a unit vector. MEASURED at 0.55/0.45 (car-weighted): the city sat
         * 34 degrees off the axis against a 36.5 degree half-frame — inside
         * the glass but on the edge of it. The bisector puts both at ~31.
         */
        this._tmp.subVectors(this._cineAnchor, want).normalize();
        this._tmp2.set(vp.x - want.x, vp.y - want.y, vp.z - want.z).normalize();
        this._tmp.multiplyScalar(0.5).addScaledVector(this._tmp2, 0.5).normalize();
        look.copy(want).addScaledVector(this._tmp, 60);
        break;
      }
      case 'track': {
        // Off the flank, low and a little behind: the window band fills the
        // frame and the street rips past behind it.
        want.copy(this._cineAnchor)
          .addScaledVector(this._vehRight, side * (len * 0.55 + 7.5))
          .addScaledVector(this._vehFwd, -len * 0.15);
        want.y = this._cineAnchor.y + 1.4;
        break;
      }
      case 'window': {
        /**
         * LOOKING OUT OF THE WINDOW, from just inboard of the glass at window
         * height, aimed forward and OUTBOARD along the band.
         *
         * The first cut of this was an over-the-shoulder from the seat aimed
         * slightly down, and the frame it produced was two thirds red floor:
         * `vehicles/build.js` builds `buildInterior` for `kind: 'car'` and for
         * nothing else, so the inside of a trolley is the inside of its own
         * painted shell — there is no saloon to frame. What IS authored in
         * there is the full-length window band and the lit strip behind it, so
         * the shot is composed on that and on the city moving past it, with the
         * pillars cutting the frame. The eye is level: a downward tilt inside a
         * 2.6 m box is a tilt into the floor.
         *
         * ...AND IT SITS ON THE CENTRELINE, WHICH IS THE SECOND CORRECTION.
         * Pressed against the glass at `hw * 0.55` the lens was 0.4 m from the
         * emissive saloon strip `tram.js` insets at `hw - 0.20` — the frame
         * came back a white slab with a sliver of city at the top. On the
         * centreline the strips are over a metre away on BOTH flanks and read
         * as what they are: lit windows either side of a corridor. So the shot
         * looks down the length of the car and slightly out, not across it.
         */
        want.copy(this._cineSubPos)
          .addScaledVector(this._vehRight, -side * hw * 0.34)
          .addScaledVector(this._up, (seat?.y ?? 0.6) + 0.44)
          .addScaledVector(this._vehFwd, (seat?.z ?? 0) - 1.2);
        // Aimed ACROSS the car and out, level, with a touch of lead. The roof
        // crown is above the band and the floor is below it, so anything but
        // a level lateral axis photographs paint.
        look.copy(want)
          .addScaledVector(this._vehRight, side * 22)
          .addScaledVector(this._vehFwd, 7)
          .addScaledVector(this._up, 0.8);
        break;
      }
      case 'reveal': {
        /**
         * WORLD-FIXED. Planted once, on the cut, ahead of where the car is
         * going, then never moved again — so the car crosses the frame under
         * its own power. The cut is the only place a shot is allowed to latch
         * world state, and it is why this one reads as a locked-off camera
         * instead of a lazy follow.
         */
        if (fresh) {
          this._cineFixed.copy(this._cineAnchor)
            .addScaledVector(this._vehFwd, len * 3.0 + 34)
            .addScaledVector(this._vehRight, side * 20);
          this._cineFixed.y = this._cineAnchor.y + 13;
        }
        want.copy(this._cineFixed);
        break;
      }
      default: {
        // orbit — a slow arc, 9 deg/s, elevated.
        const a = this.cine.t * 0.157 * side;
        const r = len * 0.9 + 10;
        want.set(
          this._cineAnchor.x + Math.sin(a) * r,
          this._cineAnchor.y + 5.0,
          this._cineAnchor.z + Math.cos(a) * r
        );
        break;
      }
    }
  }

  /**
   * How much of the way to `want` is actually free, 0..1, cast from the point
   * the shot is framing. 1 is clear sky.
   *
   * This is the same sphere cast the chase boom uses, asked a different
   * question: not "how far can the boom go" but "is this framing available at
   * all". Without it the reel cheerfully cuts to a locked-off wide inside a
   * warehouse, and the collision pull-in then plants the lens 1.4 m from the
   * car with brick filling the frame — which is exactly what the first capture
   * of the incline's postcard shot photographed, from inside the lower
   * station's headhouse.
   */
  _cineClearance(want) {
    const phys = this.ctx.peek('physics');
    if (!phys) return 1;
    this._dir.subVectors(want, this._cineAnchor);
    const r = this._dir.length();
    if (r < 1e-3) return 1;
    this._dir.multiplyScalar(1 / r);
    const hit = phys.sphereCast(
      this._cineAnchor, this._dir, CHASE.collideRadius, r, phys.MASK.WORLD
    );
    if (!hit.hit) return 1;
    return Math.max(0, hit.distance - CAMERA.collide.pad) / r;
  }

  /**
   * Solve this frame's authored framing.
   *
   * The subject pose is read the same way `_solveChase` reads it — off
   * `model.root`'s world matrix, which is what actually gets DRAWN, with the
   * physics pose as the fallback every offline rig uses (rule 12: frame the
   * picture, not the intermediate).
   */
  _solveCine(dt) {
    const v = this.cine.target;
    if (!v) {
      // Nothing to frame and nothing to overwrite: hold the last authored pose
      // so the fade in `update` has something to cross-fade FROM. See
      // `endCinematic`.
      return;
    }
    const obj = v.object3D ?? v.mesh ?? v.root ?? v.model?.root ?? null;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._cineSubPos.setFromMatrixPosition(obj.matrixWorld);
      this._cineSubQuat.setFromRotationMatrix(obj.matrixWorld);
    } else {
      this._cineSubPos.copy(v.position ?? this.pivotTarget);
      if (v.quaternion) this._cineSubQuat.copy(v.quaternion);
      else this._cineSubQuat.identity();
    }

    this.cine.t += dt;
    if (this.cine.active && this.cine.t >= CINE.shots[this.cine.shot].dur) this._cineCut();

    /* ---- the subject's own basis, and the cabin point we frame ---- */
    // +Z is the nose (see `_solveChase`); the trolley and the incline car are
    // both built that way, and the transit seat is in the same frame.
    this._vehFwd.set(0, 0, 1).applyQuaternion(this._cineSubQuat);
    this._vehRight.set(1, 0, 0).applyQuaternion(this._cineSubQuat);
    this._up.set(0, 1, 0).applyQuaternion(this._cineSubQuat);
    const seat = v.transit?.seat;
    // The look point is the SALOON, not the chassis origin: on a 14 m carriage
    // those are a metre and a half apart vertically and it is the difference
    // between framing the car and framing the underframe.
    this._cineAnchor.copy(this._cineSubPos)
      .addScaledVector(this._up, (seat?.y ?? 0.6))
      .addScaledVector(this._vehFwd, (seat?.z ?? 0) * 0.35);

    const want = this._cineWant;
    const look = this._cineWantLook;

    /**
     * PICK A FRAMING THAT EXISTS. Only on a cut — a per-frame re-pick would
     * thrash the reel every time the car passed a lamp post, and a shot the
     * player is already watching should ride out its own six seconds. The
     * interior shot is exempt: it is inside the body it would cast against.
     */
    if (this._cineFresh) {
      for (let i = 0; i < CINE.shots.length; i++) {
        const S = CINE.shots[this.cine.shot];
        this._cineFrame(S, v, want, look, true);
        if (S.id === 'window' || this._cineClearance(want) >= CINE.minClear) break;
        this._cineCut();
      }
    }
    const S = CINE.shots[this.cine.shot];
    this._cineFrame(S, v, want, look, this._cineFresh);

    /* ---- ease, then keep the lens out of the scenery ---- */
    if (this._cineFresh) {
      this._cinePos.copy(want);
      this._cineLook.copy(look);
      this._cineFresh = false;
      this.cine.cut = true;
    } else {
      const k = 1 - Math.exp(-dt / CINE.tau);
      this._cinePos.lerp(want, k);
      this._cineLook.lerp(look, k);
      this.cine.cut = false;
    }

    /**
     * The chosen framing was clear when it was chosen; the world still moves
     * THROUGH it — a trolley runs behind a warehouse, an incline car climbs
     * past a hillside block — so the cast runs every frame, the boom still
     * pulls in, and a shot that STAYS blocked is cut out of rather than ridden
     * to the end of its six seconds staring at brick. Half a second of grace
     * first: a lamp post or a passing van is a wipe, not a ruined shot.
     */
    if (S.id !== 'window') {
      const free = this._cineClearance(this._cinePos);
      this._cineBlockT = free < CINE.minClear ? this._cineBlockT + dt : 0;
      if (this.cine.active && this._cineBlockT > CINE.blockGrace) {
        this._cineBlockT = 0;
        this._cineCut();
      }
      if (free < 1) {
        this._dir.subVectors(this._cinePos, this._cineAnchor);
        const r = this._dir.length();
        if (r > 1e-3) {
          this._dir.multiplyScalar(1 / r);
          this._cinePos.copy(this._cineAnchor)
            .addScaledVector(this._dir, Math.max(CINE.minRadius, r * free));
        }
      }
    }

    /* ---- aim ---- */
    this._tmp2.subVectors(this._cineLook, this._cinePos);
    const flat = Math.hypot(this._tmp2.x, this._tmp2.z);
    const pitch = Math.atan2(this._tmp2.y, Math.max(1e-4, flat));
    const yaw = Math.atan2(-this._tmp2.x, -this._tmp2.z);
    this._e.set(clamp(pitch, -CAMERA.pitchLimit, CAMERA.pitchLimit), yaw, 0);
    this._cineQuat.setFromEuler(this._e);
    this._cineFov = this.ctx.config.fov * CAMERA.fovScale * S.fov;
  }

  /* ==================================================================== */
  /* impulses — public feel API (unchanged)                               */
  /* ==================================================================== */

  addRecoil(pitch = 0, yaw = 0, roll = 0, punch = 0) {
    this.recoilPitch.kick(pitch);
    this.recoilYaw.kick(yaw);
    this.recoilRoll.kick(roll);
    if (punch) this.punch.impulse(-punch * 14);
  }

  addKick(pitch = 0, yaw = 0, roll = 0) {
    this.kickPitch.kick(pitch);
    this.kickYaw.kick(yaw);
    this.kickRoll.kick(roll);
  }

  addTrauma(a) {
    this.trauma = clamp01(this.trauma + a);
  }

  onLand(speed) {
    const L = CAMERA.land;
    const t = clamp01((speed - L.minSpeed) / (L.fullSpeed - L.minSpeed));
    if (t <= 0) return 0;
    const mag = Math.pow(t, 0.72);
    this.dip.impulse(-L.dipImpulse * mag);
    this.recoilPitch.kick(L.pitch * mag);
    this.addTrauma(L.trauma * mag * mag);
    return mag;
  }

  onFootstep(running, stance) {
    const S = CAMERA.step;
    let amp = S.impulse * (running ? S.sprintScale : 1);
    if (stance === 'crouch') amp *= 0.55;
    this.step.impulse(-amp);
  }

  onSlideStart() {}

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  /**
   * @param dt
   * @param m       the Movement machine
   * @param health  { fraction, suppression }
   */
  update(dt, m, health) {
    this._stepSprings(dt);

    const blendTarget = this.vehicle ? 1 : 0;
    this.vehicleBlend = approach(this.vehicleBlend, blendTarget, CHASE.blendTau, dt);
    if (Math.abs(this.vehicleBlend - blendTarget) < 0.002) this.vehicleBlend = blendTarget;

    // Always solve the foot boom: it is the fallback, and it keeps the pivot
    // tracking the character during the enter/exit animation.
    this._solveFoot(dt, m, health);

    if (this.vehicle || this.vehicleBlend > 0) {
      this._solveChase(dt, m);
    }

    const b = this.vehicleBlend;
    if (b <= 0) {
      this.position.copy(this._footPos);
      this.quaternion.copy(this._footQuat);
      this.fov = this._footFov;
    } else if (b >= 1) {
      this.position.copy(this._chasePos);
      this.quaternion.copy(this._chaseQuat);
      this.fov = this._chaseFov;
    } else {
      const t = b * b * (3 - 2 * b);
      this.position.lerpVectors(this._footPos, this._chasePos, t);
      this.quaternion.copy(this._footQuat).slerp(this._chaseQuat, t);
      this.fov = lerp(this._footFov, this._chaseFov, t);
    }

    /**
     * THE RIDE CAMERA SITS ON TOP OF THE WHOLE SOLVE, not inside it.
     *
     * Both solvers keep running underneath — the chase because it is what the
     * reel fades back to and it must be settled when it gets the frame, the
     * foot boom because it is the chase's own fallback. This costs nothing
     * when nobody is riding anything: `blend` is 0, `active` is false, and the
     * whole block is one comparison.
     */
    if (this.cine.active || this.cine.blend > 0) {
      this.cine.blend = approach(this.cine.blend, this.cine.active ? 1 : 0, CINE.blendTau, dt);
      if (!this.cine.active && this.cine.blend < 0.004) {
        this.cine.blend = 0;
        this.cine.target = null;   // only once the fade has actually landed
      }
      if (this.cine.blend > 0) {
        this._solveCine(dt);
        const cb = this.cine.blend;
        const t = cb * cb * (3 - 2 * cb);
        this.position.lerp(this._cinePos, t);
        this.quaternion.slerp(this._cineQuat, t);
        this.fov = lerp(this.fov, this._cineFov, t);
      }
    }

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.rotation.setFromQuaternion(this.quaternion, 'YXZ');

    this.viewKick.pitch = this.recoilPitch.value + this.kickPitch.value;
    this.viewKick.yaw = this.recoilYaw.value + this.kickYaw.value;
    this.viewKick.roll = this.recoilRoll.value + this.kickRoll.value;
    this.viewKick.punch = this.punch.value;
  }

  _stepSprings(dt) {
    this.dip.step(dt);
    this.step.step(dt);
    this.punch.step(dt);
    this.recoilPitch.step(dt);
    this.recoilYaw.step(dt);
    this.recoilRoll.step(dt);
    this.kickPitch.step(dt);
    this.kickYaw.step(dt);
    this.kickRoll.step(dt);
    this.trauma = Math.max(0, this.trauma - CAMERA.shake.decay * dt);
    this.shakeTime += dt * CAMERA.shake.freq;
    this.breathPhase += dt;
    this.lookIdle += dt;
    this.manualAge += dt;

    // The view cycle is a timed ease between two parameter sets, never a cut.
    if (this._viewT < 1) {
      this._viewT = Math.min(1, this._viewT + dt / this._viewDur);
      const k = smootherstep(this._viewT);
      const V = VIEWS[this.view];
      const F = this._viewFrom;
      this._viewDist = lerp(F.dist, V.dist, k);
      this._viewHeight = lerp(F.height, V.height, k);
      this._viewLateral = lerp(F.lateral, V.lateral, k);
      this.nearBlend = lerp(F.near, V.near, k);
    }
  }

  /* -------------------------------------------------------------------- */

  _solveFoot(dt, m, health) {
    const C = CAMERA;
    const O = C.orbit;
    const B = C.boom;
    const phys = this.ctx.peek('physics');

    /* ---- 1. pivot ---- */
    const base = m.sampleRender(this.ctx.time.alpha);
    const crouch = clamp01(m.crouchBlend ?? 0);
    this.eye = lerp(STANCE.stand.eye, STANCE.crouch.eye, crouch);
    // The fourth view walks the pivot from the base of the neck up to the eyes.
    this.anchor = lerp(
      lerp(STANCE.stand.anchor, STANCE.crouch.anchor, crouch),
      this.eye,
      this.nearBlend
    ) * (m.bodyScale ?? 1);
    this.pivotTarget.set(base.x, base.y + this.anchor, base.z);

    const tauY = m.grounded ? C.follow.tauY : C.follow.tauYAir;
    this.pivot.x = approach(this.pivot.x, this.pivotTarget.x, C.follow.tauXZ, dt);
    this.pivot.z = approach(this.pivot.z, this.pivotTarget.z, C.follow.tauXZ, dt);
    this.pivot.y = approach(this.pivot.y, this.pivotTarget.y, tauY, dt);
    // Hard leash so a teleport or a long fall can never strand the pivot.
    this._tmp.subVectors(this.pivotTarget, this.pivot);
    const lag = this._tmp.length();
    if (lag > C.follow.maxLag) {
      this.pivot.addScaledVector(this._tmp, 1 - C.follow.maxLag / lag);
    }

    /* ---- 2. orbit ---- */
    // Auto-centre: only when moving fast, only after the player has let go of
    // the look, and gently enough that it never fights an active input.
    const speed = m.horizontalSpeed;
    if (
      speed > O.autoSpeed && this.lookIdle > O.autoDelay &&
      (m.aiming !== true) && m.grounded
    ) {
      const behind = m.faceYaw;
      const d = angleDelta(this.yawTarget, behind);
      const k = 1 - Math.exp(-dt / O.autoTau);
      this.yawTarget += d * k * clamp01((speed - O.autoSpeed) / 3);
      const dp = angleDelta(this.pitchTarget, O.restPitch);
      this.pitchTarget += dp * k * 0.5;
    }
    // Leaving the fourth view narrows the pitch range under an already-tilted
    // target; ease rather than snap so the change is still a continuous move.
    if (this.pitchTarget > this.pitchMax) {
      this.pitchTarget = approach(this.pitchTarget, this.pitchMax, 0.08, dt);
    }

    const ky = 1 - Math.exp(-dt / O.tau);
    this.yawRate = angleDelta(this.yaw, this.yawTarget) * ky / Math.max(1e-4, dt);
    this.yaw += angleDelta(this.yaw, this.yawTarget) * ky;
    this.pitch += (this.pitchTarget - this.pitch) * ky;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    /* ---- 3. boom ---- */
    const aim = clamp01(m.adsAmount ?? 0);
    /**
     * Normalise against the CAST's top speed (DESIGN.md's fastest brother), not
     * against `MOVE.sprintSpeed`. Dividing by 6.9 clamped Dylan's 7.9 m/s sprint
     * to the same 1.0 as Aidan's 6.9, so the fastest brother in the game was
     * framed exactly like the middle one and his last metre per second bought
     * nothing. See `TOP_RUN_SPEED` for why per-brother normalisation is worse
     * still. Boom distance, boom height and FOV all hang off this one number,
     * so it is most of what makes the three feel different to move.
     */
    const speedT = clamp01(speed / TOP_RUN_SPEED);
    const vaulting = m.mantleMotion?.active ? 1 : 0;

    /**
     * ...and commit on the STATE, not only on the speed. Sprint has to be
     * legible the instant it engages: speed alone ramps the boom in over the
     * 0.24 s filter AND over the acceleration, so the player gets no immediate
     * confirmation that Shift did anything. `sprintT` adds a small, separate
     * push that keys off `m.sprinting` directly.
     */
    this.sprintCommit = approach(this.sprintCommit, m.sprinting ? 1 : 0, 0.12, dt);
    const sprintT = this.sprintCommit;

    let wantDist = lerp(B.distIdle, B.distSprint, speedT * speedT) + sprintT * B.distSprintCommit;
    wantDist += crouch * B.distCrouch + vaulting * B.distVault;
    let wantHeight = lerp(B.heightIdle, B.heightSprint, speedT);
    let wantLateral = B.lateralIdle;
    if (aim > 0) {
      wantDist = lerp(wantDist, B.distAim, aim);
      wantHeight = lerp(wantHeight, B.heightAim, aim);
      wantLateral = lerp(wantLateral, B.lateralAim * this.shoulderBlend, aim);
    }
    // The view cycle scales what the solver already asked for.
    wantDist *= this._viewDist;
    wantHeight *= this._viewHeight;
    wantLateral *= this._viewLateral;
    this.shoulderBlend = approach(this.shoulderBlend, this.shoulder, B.swapTau, dt);

    /**
     * ---- 3b. HIGH LOOK ----
     *
     * The boom hangs off `-forward`, so every degree the lens gains looking up
     * costs the camera height and pushes it back through the character. Past
     * `highLook.knee` the arm therefore stops following the lens one-for-one:
     * it keeps a share of the swing (`boomFollow`), shortens (`distScale`) and
     * rides up the view basis (`heightGain`). See CAMERA.highLook for why the
     * three move together and what they are solved against.
     *
     * This is a NO-OP below the knee — `above` is zero there and every term
     * collapses — so no framing this game already ships can move. It is also a
     * no-op in first person, where the boom is 3 cm and there is nothing to
     * tuck; `nearBlend` fades it out over the view change rather than at it.
     *
     * `boomPitch` is the PLACEMENT only. The lens keeps `this.pitch`, which is
     * what the reticle and `weapons`' fire direction are built from — the point
     * of the whole change is that those two reach 72 deg.
     */
    const HL = C.highLook;
    let boomPitch = this.pitch;
    this.highLookT = 0;
    if (this.highLook && this.pitch > HL.knee) {
      const above = this.pitch - HL.knee;
      const near = 1 - this.nearBlend;
      const t = clamp01(above / Math.max(1e-3, this.pitchMax - HL.knee)) * near;
      this.highLookT = t;
      boomPitch = this.pitch - above * (1 - HL.boomFollow) * near;
      wantDist *= lerp(1, HL.distScale, t);
      wantHeight += HL.heightGain * t;
    }

    const viewing = this._viewT < 1;
    const tau = viewing ? B.viewTau : (aim > 0.02 ? B.aimTau : B.tau);
    this.distIdeal = approach(this.distIdeal, wantDist, tau, dt);
    this.height = approach(this.height, wantHeight, tau, dt);
    this.lateral = approach(this.lateral, wantLateral, tau, dt);

    /* ---- 4. basis ---- */
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(boomPitch), cp = Math.cos(boomPitch);
    this._fwd.set(-sy * cp, sp, -cy * cp);
    this._right.set(cy, 0, -sy);
    this._up.crossVectors(this._right, this._fwd);

    /* ---- 5. collision ---- */
    this._dir.set(0, 0, 0)
      .addScaledVector(this._fwd, -1)
      .addScaledVector(this._right, this.lateral / Math.max(0.2, this.distIdeal))
      .addScaledVector(this._up, this.height / Math.max(0.2, this.distIdeal));
    const dirLen = this._dir.length() || 1;
    this._dir.multiplyScalar(1 / dirLen);
    const wantRadius = this.distIdeal * dirLen;

    let free = wantRadius;
    if (phys) {
      const hit = phys.sphereCast(
        this.pivot, this._dir, C.collide.radius, wantRadius, phys.MASK.WORLD
      );
      // NEVER clamp UP to a minimum distance here. Doing that — the obvious way
      // to keep the camera off the character — shoves it straight THROUGH any
      // blocker closer than the minimum, which is precisely what happens under
      // a bridge, in a doorway, or against a low ceiling. Measured: 313 of 520
      // frames of the motion test had the camera inside static geometry. The
      // floor is a hard 12 cm so the near plane stays outside the blocker, and
      // the character is faded out instead.
      if (hit.hit) free = Math.max(0.12, hit.distance - C.collide.pad);
    }
    this._freeRing[this._freeCursor] = free;
    this._freeCursor = (this._freeCursor + 1) % this._freeRing.length;
    let held = this._freeRing[0];
    for (let i = 1; i < this._freeRing.length; i++) {
      if (this._freeRing[i] < held) held = this._freeRing[i];
    }
    /**
     * Asymmetric: pull in fast, push out slowly and only past the hysteresis
     * band. With the windowed minimum above, this is what kills alley jitter.
     *
     * The target is `min(free space, what the solver asked for)`, and it has to
     * be, because the obvious alternative — chase the free space and then hard
     * clamp to `wantRadius` afterwards — PINS the boom while `wantRadius` sweeps
     * down past it and then hands over to the clamp in one frame. That is a
     * velocity step from 0 to 11 m/s and the continuity meter reports it as
     * exactly what it is (measured 699 m/s^2 entering first person). It never
     * showed up before because no filtered channel used to move five metres in
     * half a second; the view cycle does.
     */
    /* During a view change the boom is moving metres under its OWN power, so
     * the eight-frame minimum — which exists to stop a stationary boom chasing
     * a sphere cast that flickers hit/miss against a wall — becomes a staircase
     * the filter has to climb, and the per-frame steps stop scaling with dt.
     * Use this frame's measurement instead; the 130 ms pull-in absorbs the
     * flicker the window was there to hide. */
    const target = Math.min(viewing ? free : held, wantRadius);
    if (target < this.collideRadius) {
      this.collideRadius = approach(
        this.collideRadius, target,
        viewing ? C.collide.tauInView : C.collide.tauIn, dt
      );
    } else if (target > this.collideRadius + C.collide.hysteresis) {
      this.collideRadius = approach(
        this.collideRadius, target,
        viewing ? C.collide.tauInView : C.collide.tauOut, dt
      );
    }
    /* The boom may never exceed the request. This clamp has to be
     * UNCONDITIONAL: suspending it during a view change lets the filter lag two
     * metres behind, and the frame the change completes it re-engages and drops
     * the boom by all of it at once — measured 5143 m/s^2, a far worse spike
     * than the one suspending it was meant to avoid. It is safe precisely
     * because `wantRadius` is now C1 (a smootherstep through two first-order
     * lags), so on the shrink the clamp IS the smooth path. */
    this.collideRadius = Math.min(this.collideRadius, wantRadius);

    /* ---- 6. compose ---- */
    this._footPos.copy(this.pivot).addScaledVector(this._dir, this.collideRadius);

    // Feel offsets ride on top, in the view basis.
    const shake = this.trauma * this.trauma;
    let shakeX = 0, shakeY = 0, shakePitch = 0, shakeYaw = 0, shakeRoll = 0;
    if (shake > 1e-4) {
      const S = C.shake;
      shakePitch = hashNoise(this.shakeTime, 11) * shake * S.rot * DEG;
      shakeYaw = hashNoise(this.shakeTime + 31.7, 23) * shake * S.rot * DEG;
      shakeRoll = hashNoise(this.shakeTime + 57.1, 37) * shake * S.rot * 0.7 * DEG;
      shakeX = hashNoise(this.shakeTime * 0.8 + 13.3, 41) * shake * S.pos;
      shakeY = hashNoise(this.shakeTime * 0.8 + 71.9, 53) * shake * S.pos;
    }
    const vert = this.dip.value + this.step.value + shakeY;
    this._footPos.addScaledVector(this._up, vert);
    this._footPos.addScaledVector(this._right, shakeX);
    this._footPos.addScaledVector(this._fwd, this.punch.value);

    /* ---- 7. rotation ---- */
    const R = C.roll;
    const strafeTarget = -(m.moveX ?? 0) * R.strafe * (m.grounded ? 1 : 0.4);
    this.strafeRoll = approach(this.strafeRoll, strafeTarget, R.tau, dt);
    const turnTarget = clamp(this.yawRate * R.yawRate, -R.yawRateMax, R.yawRateMax);
    this.turnRoll = approach(this.turnRoll, turnTarget, R.tau * 1.5, dt);
    const airTarget = m.grounded ? 0 : clamp(-m.velocity.y * 0.02, -1, 1) * R.air;
    this.airRoll = approach(this.airRoll, airTarget, 0.22, dt);

    const Bf = C.breath;
    let amp = Bf.amp;
    amp *= lerp(1, Bf.adsScale, aim);
    amp *= lerp(1, Bf.lowHealthScale, 1 - clamp01(health?.fraction ?? 1));
    amp *= lerp(1, Bf.suppressionScale, clamp01(health?.suppression ?? 0));
    amp *= 1 - Bf.moveDamp * clamp01(speed / 2.2);
    const bA = Math.sin(this.breathPhase * Math.PI * 2 * Bf.freqA);
    const bB = Math.sin(this.breathPhase * Math.PI * 2 * Bf.freqB + 1.7);
    const breathPitch = (bA * 0.7 + bB * 0.3) * amp;
    const breathYaw = (bB * 0.75 - bA * 0.25) * amp * 1.15;

    const pitch = clamp(
      this.pitch + this.recoilPitch.value + this.kickPitch.value + breathPitch + shakePitch,
      -CAMERA.pitchLimit, CAMERA.pitchLimit
    );
    const yaw = this.yaw + this.recoilYaw.value + this.kickYaw.value + breathYaw + shakeYaw;
    const roll = this.strafeRoll + this.turnRoll + this.airRoll +
      this.recoilRoll.value + this.kickRoll.value + shakeRoll;
    this._e.set(pitch, yaw, roll);
    this._footQuat.setFromEuler(this._e);

    /* ---- 8. fov ---- */
    const F = C.fov;
    // First person wants the config FOV it was authored for, not the 62-degree
    // third-person value.
    this.baseFov = this.ctx.config.fov * lerp(C.fovScale, C.fovScaleNear, this.nearBlend);
    // Speed does most of it; the sprint state adds an immediate, separate kick
    // so pressing Shift is visible before the legs have caught up.
    let fovTarget = speedT * speedT * F.sprintGain + this.sprintCommit * F.sprintCommitGain;
    if (!m.grounded) fovTarget += F.airGain;
    this.fovMove = approach(this.fovMove, fovTarget, F.tau, dt);
    this.fovAim = approach(this.fovAim, lerp(1, F.aimScale, aim), F.aimTau, dt);
    this._footFov = (this.baseFov + this.fovMove) * this.fovAim;

    /* ---- 9. character fade ---- */
    const dist = this._footPos.distanceTo(this.pivotTarget);
    const fade = clamp01((dist - C.collide.fadeEnd) / (C.collide.fadeStart - C.collide.fadeEnd));
    this.characterFade = approach(this.characterFade, fade, 0.05, dt);

    this.bobPhase = m.stepPhase ?? 0;
  }

  /* -------------------------------------------------------------------- */

  /**
   * The vehicle chase camera. `this.vehicle` is whatever the vehicles system
   * handed us; we duck-type its transform so we do not depend on its internals.
   */
  _solveChase(dt, m) {
    const v = this.vehicle;
    const phys = this.ctx.peek('physics');
    if (!v) {
      this._chasePos.copy(this._footPos);
      this._chaseQuat.copy(this._footQuat);
      this._chaseFov = this._footFov;
      return;
    }

    /* ---- read the vehicle, tolerantly ---- */
    /**
     * `model.root` IS THE THING THAT GETS DRAWN, and it was missing from this
     * chain. A real `Vehicle` carries no `object3D`, `mesh` or `root` — it
     * exposes `model.root`, which `syncTransforms()` writes each frame with the
     * pose the renderer then draws (`lerpVectors(prevPosition, position,
     * alpha)`). MEASURED on a live Vehicle: object3D/mesh/root all undefined.
     *
     * So this fell through to `v.position`, the raw un-interpolated PHYSICS
     * pose, and the camera framed a car up to one fixed step (8.3 ms of travel,
     * 0.23 m at 100 km/h) ahead of the one on screen — by a margin that
     * oscillates with the interpolation alpha, i.e. a judder rather than an
     * offset. src/player/vehicle.js line 39 records the identical lookup
     * failing for the seat solve, which is why the driver did not ride the car.
     *
     * MEASURED before/after, on a uniform drive at dt = 1.5/120 s (the drawn car
     * in the emitted camera basis, camlagtest.mjs): the framing moved 0.034 m at
     * 54 km/h and 0.187 m at 108 km/h, and the cadence-locked judder in the
     * framing fell from 0.005196 / 0.010393 m to an exact 0.000000 at both
     * speeds. The bound is one fixed step of travel, v/120, NOT v*dt — at 34 fps
     * the same correction measures 0.025 m / 0.061 m, i.e. SMALLER than at
     * 80 fps. Anyone quoting a frame-proportional figure for this is quoting the
     * ordering bug (see `cameraUpdate` in index.js) rather than this one.
     *
     * THIS LINE ONLY WORKS FROM `player.cameraUpdate`. `model.root` is written
     * by `vehicles.update()`, which the registry runs AFTER `player.update()`,
     * so reading it from `update()` yields last frame's pose — 0.245 m / 0.373 m
     * adrift, worse than the bug this fixes. The two changes are one change.
     *
     * The `v.position` branch below is still the right fallback and is still
     * live: the offline rigs (src/player/camtest.mjs, drivetest.mjs) build a
     * Vehicle on a stub model whose `root` is null and never sync a scene graph
     * at all.
     */
    const obj = v.object3D ?? v.mesh ?? v.root ?? v.model?.root ?? null;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._vehPos.setFromMatrixPosition(obj.matrixWorld);
      this._vehQuat.setFromRotationMatrix(obj.matrixWorld);
    } else if (v.position) {
      this._vehPos.copy(v.position);
      if (v.quaternion) this._vehQuat.copy(v.quaternion);
    } else {
      this._vehPos.copy(this.pivotTarget);
    }
    if (v.velocity) this._vehVel.copy(v.velocity);
    else this._vehVel.set(0, 0, 0);

    /**
     * A VEHICLE'S NOSE IS +Z. The camera's own basis is -Z (see the `_fwd`
     * built from `yaw` below, and `Object3D`), and this line was written in
     * that convention — so the chase camera solved for a yaw 180 degrees out
     * and parked itself in FRONT of the car, looking back at the windscreen.
     *
     * From in front the car reads as facing the wrong way — reverse looks like
     * the only direction that works: holding W drives the car AT the lens and
     * the world scrolls the wrong way, while S backs it away from the lens and
     * reads as driving off. The car was always doing the right thing
     * (`forwardSpeed` +5.9 m/s on W, measured).
     *
     * `src/vehicles/dynamics.js` takes `forwardSpeed` along +Z, `vehicles`'
     * own cockpit shot looks along +Z, and `tools/steercheck.mjs` confirms the
     * handedness empirically. +Z is not negotiable; this was.
     */
    this._vehFwd.set(0, 0, 1).applyQuaternion(this._vehQuat);
    this._vehRight.set(1, 0, 0).applyQuaternion(this._vehQuat);
    this._vehFwd.y = 0;
    if (this._vehFwd.lengthSq() < 1e-6) this._vehFwd.set(0, 0, 1);
    this._vehFwd.normalize();

    const vx = this._vehVel.x, vz = this._vehVel.z;
    const speed = Math.hypot(vx, vz);
    const forwardDot = vx * this._vehFwd.x + vz * this._vehFwd.z;
    const facingYaw = Math.atan2(-this._vehFwd.x, -this._vehFwd.z);

    /**
     * Per-state framing. `F` is the framing class for whatever is being framed
     * — see `CHASE.classFrame` and `EXTRA_FRAMES`. Resolved on `setVehicle`,
     * read here.
     *
     * THE FLIGHT CHANNELS, both read off what `vehicles` already publishes so
     * the camera adds no rays of its own:
     *
     *   `v.altitude`  metres AGL, written every step by `plane.js` / `heli.js`
     *                 (`Math.max(0, position.y - gear - ground)`). Anything
     *                 without it — a car, a stub in a bench — reads 0, which is
     *                 exactly the grounded behaviour that came before.
     *   `climb`       the sine of the flight path angle, from the velocity the
     *                 solver has already copied. Horizontal speed alone cannot
     *                 see a climb, which is why a car camera loses an aeroplane
     *                 off the top of the frame the moment it rotates.
     */
    const F = this._frame;
    const flight = F.flight === true;
    const alt = flight && Number.isFinite(v.altitude) ? Math.max(0, v.altitude) : 0;
    const altT = flight ? clamp01(alt / FLIGHT.altRef) : 0;
    const climb = flight
      ? clamp(this._vehVel.y / Math.max(6, this._vehVel.length()), -1, 1)
      : 0;

    /* ---- travel yaw: the whole point of a chase camera ---- */
    let travelYaw = facingYaw;
    if (speed > CHASE.travelMinSpeed && forwardDot > 0) {
      const tYaw = Math.atan2(-vx / speed, -vz / speed);
      // Blend toward pure travel with speed, so a slow crawl still frames the
      // nose and a power slide frames the direction the car is actually going.
      // A bonnet camera is bolted to the car, so it frames FACING: the point of
      // it is that a slide is read off the road going sideways past the wing,
      // which is exactly the information the chase view throws away.
      const wgt = CHASE.travelWeight * clamp01((speed - CHASE.travelMinSpeed) / 6)
        * (1 - this.nearBlend);
      travelYaw = facingYaw + angleDelta(facingYaw, tYaw) * wgt;
    }
    // How hard the direction is changing — loosen the follow through a slide,
    // and use the same rate for the centripetal roll below.
    const swing = angleDelta(this.chasePrevTravel, travelYaw) / Math.max(1e-4, dt);
    this.chasePrevTravel = travelYaw;
    // ...and an aeroplane's travel vector swings far faster than a steering
    // rack can move a car's, so the same time constant reads as a camera welded
    // to the tailplane. `lagGain` is the whole "wider lag" of the flight chase.
    const yawTau = lerp(CHASE.yawTau, CHASE.yawTauFast, clamp01(Math.abs(swing) / 2.6)) *
      (flight ? FLIGHT.lagGain : 1);
    const k = 1 - Math.exp(-dt / yawTau);
    this.chaseYaw += angleDelta(this.chaseYaw, travelYaw) * k;
    if (this.chaseYaw > Math.PI) this.chaseYaw -= Math.PI * 2;
    else if (this.chaseYaw < -Math.PI) this.chaseYaw += Math.PI * 2;

    /* ---- speed-proportional auto-align ----------------------------------- */
    /**
     * The player's look offset eases back behind the car at a rate that rises
     * with road speed, and at exactly zero while the look control is live.
     *
     * Two properties matter and they pull in opposite directions, which is why
     * a single time constant could never serve both: at 40 m/s the camera has
     * to come home in a few tenths or the player spends the whole chase
     * hand-steering it, and at walking pace it must barely move or it is
     * wrestling him for the view in a car park. A rate proportional to speed
     * serves both.
     *
     * `manualAge` is the time since the look control last produced a delta, so
     * `< suppress` means the stick is still live. The ramp after it is what
     * makes the resume gentle: without it, releasing the stick at speed hands
     * the camera a 0.44 s time constant on the same frame and reads as the game
     * snatching the view back.
     */
    const A = CHASE.align;
    let rate = 0;
    if (this.manualAge >= A.suppress) {
      rate = clamp(speed * A.perSpeed, A.floor, A.rateMax) *
        smootherstep(clamp01((this.manualAge - A.suppress) / A.ease));
    }
    this.alignRate = rate;
    if (rate > 0) {
      const ka = 1 - Math.exp(-rate * dt);
      this.manualYaw -= this.manualYaw * ka;
      this.manualPitch -= this.manualPitch * ka;
    }

    const speedT = clamp01(speed / CHASE.speedRef);
    /**
     * HOW BIG IS THIS THING. `spec.half` is the only dimension a real Vehicle
     * actually carries — `v.length`, `v.height` and `v.size` are all undefined
     * on every vehicle in the game, which the bonnet mount below already knew
     * (it reads `v.spec?.half`) and this did not.
     *
     * So `distSizeGain`, `heightSizeGain` and the boom lift have been reading
     * 4.5 m and 1.4 m for a 7.2 m truck and a 9.6 m bus since they were
     * written: every size term in the chase camera was inert and a pickup was
     * framed exactly like a hatchback. The duck-typed fields stay first so a
     * stand-in object can still override, but the spec is what answers.
     */
    const half = v.spec?.half;
    const size = v.length ?? v.size?.z ?? (half ? half.z * 2 : 4.5);
    const tall = v.height ?? v.size?.y ?? (half ? half.y * 2 : 1.4);

    // A class with its own framing does not also take the per-metre length
    // gain, or it would be paid for twice. (`F` was resolved above.)
    const sizeTerm = F.sizeGain ? Math.max(0, size - 4.5) * CHASE.distSizeGain : 0;

    const nb = this.nearBlend;
    this.chaseDist = approach(
      this.chaseDist,
      (F.dist + CHASE.distSpeedGain * speedT + sizeTerm) * this._viewDist,
      0.3, dt
    );
    this.chaseHeight = approach(
      this.chaseHeight,
      (lerp(CHASE.heightIdle, CHASE.heightFast, speedT) * F.height +
        Math.max(0, tall - 1.4) * 0.45) * this._viewHeight,
      0.35, dt
    );
    /**
     * PITCH, and the two terms an aeroplane adds to it.
     *
     * The car law tips the boom down (`pitchBase` -9 deg, easing to -4.5 flat
     * out) because what a driver needs in frame is road. Both of its premises
     * fail in the air:
     *
     *   1. THE SUBJECT CLIMBS. A Skylark rotates at 15 degrees and a Talon at
     *      more, and it keeps climbing; a camera whose pitch is a function of
     *      ground speed alone holds still while the aircraft walks up out of
     *      the frame. `climb` is the sine of the flight-path angle, so the boom
     *      follows the nose up and down and the machine stays where it was.
     *   2. SPEED IS NOT THE VARIABLE. `speedT` saturates at 38 m/s, which every
     *      aeroplane in the game passes before it leaves the runway, so the car
     *      law is pinned at -4.5 degrees for the whole flight. ALTITUDE is what
     *      changes what is worth looking at: the ground on a low pass and an
     *      approach, the horizon at height. So the flight class replaces the
     *      speed ramp outright rather than nudging it.
     */
    let pitchWant = lerp(lerp(CHASE.pitchBase, CHASE.pitchFast, speedT), CHASE.pitchBonnet, nb);
    if (flight) {
      pitchWant = lerp(
        lerp(FLIGHT.pitchLow, FLIGHT.pitchHigh, altT) + climb * FLIGHT.pitchClimb,
        CHASE.pitchBonnet, nb
      );
    }
    this.chasePitch = approach(this.chasePitch, pitchWant, CHASE.pitchTau, dt);

    /* ---- roll into the corner (centripetal a = v * dPsi/dt) ---- */
    const latAcc = clamp(speed * swing, -14, 14);
    this.chaseRoll = approach(
      this.chaseRoll,
      clamp(-latAcc * CHASE.roll, -CHASE.rollMax, CHASE.rollMax),
      CHASE.rollTau, dt
    );

    /* ---- pivot (its own, so a blend never fights the on-foot pivot) ---- */
    const px = this._vehPos.x, pz = this._vehPos.z;
    const py = this._vehPos.y + CHASE.heightBase + Math.max(0, tall - 1.4) * CHASE.heightSizeGain;
    this._tmp.set(px, py, pz);
    if (nb > 0.002) {
      /**
       * ────────────────────────────────────────────────────────────────────
       * THE FOURTH VIEW IN A CAR IS THE DRIVER'S SEAT, NOT THE BONNET
       * ────────────────────────────────────────────────────────────────────
       * `bonnetUp` x half-height puts the lens ON TOP OF the bodywork looking
       * forward over it: a hood-cam. That is a real camera in a racing game and
       * it is the wrong one for a game with a modelled cabin, because it never
       * shows the cabin — the dash, the wheel and the glass are all behind the
       * lens, and the near plane sits a few centimetres off a painted panel.
       *
       * A car that HAS a cabin gets an eye point in it. The construction is the
       * one `vehicles` uses for the seated driver's head, restated here rather
       * than imported (hard rule 2): the head sits in the GLASS and under the
       * HEADLINER, not at a fixed fraction of the body.
       *
       *   floor = groundY + max(0.10, sillY - 0.16)      the pan he sits over
       *   hip   = floor + 0.22
       *   head  = max( hip + 0.42,
       *                min( beltY + 0.20, roofY - 0.30, floor + 1.05 ) )
       *
       * ...offset to the DRIVER'S SIDE. A body facing +Z has its right along
       * -X, so the car's left — Pittsburgh's driver side — is +X, the same
       * constant `vehicles/index.js` calls `DRIVER_SIDE` and `interior.js`
       * calls `WHEEL_SIDE`. Sitting on the centreline is the tell that a first
       * person camera was never sat in.
       *
       * Z is the seat, forward of the headrest by 10 cm so the eye is where the
       * eye is rather than where the head bone is: too far back and a 65 degree
       * lens is nine tenths steering wheel, which is the failure `vehicles`
       * wrote its own note about.
       *
       * Everything without a cabin — bikes, boats, aircraft, the tank — keeps
       * the bonnet mount, which is the right camera for a machine you sit ON.
       */
      const half = v.spec?.half;
      const hz = half?.z ?? size * 0.5;
      const hy = half?.y ?? tall * 0.5;
      const st = this._interiorEye ? v.spec.style : null;
      if (st) {
        const floorY = st.groundY + Math.max(0.10, st.sillY - 0.16);
        const hip = floorY + 0.22;
        const head = Math.max(
          hip + 0.42,
          Math.min(st.beltY + 0.20, st.roofY - 0.30, floorY + 1.05)
        );
        this._bonnet.set(
          st.hwMax * 0.82 * 0.46,
          head - (v.spec.comY ?? 0),
          st.cowlZ - 0.85
        );
      } else {
        // +Z is the nose (see `_vehFwd` above) — this used to sit on the BOOT.
        this._bonnet.set(0, hy * CHASE.bonnetUp, hz * CHASE.bonnetFore);
      }
      this._bonnet.applyQuaternion(this._vehQuat).add(this._vehPos);
      this._tmp.lerp(this._bonnet, nb);
    }
    const followTau = CHASE.followTau * (flight ? FLIGHT.followGain : 1);
    if (this.chasePivot.lengthSq() < 1e-8 || this.vehicleBlend < 0.02) this.chasePivot.copy(this._tmp);
    else this.chasePivot.lerp(this._tmp, 1 - Math.exp(-dt / followTau));

    /* ---- basis + collision ---- */
    const yaw = this.chaseYaw + this.manualYaw;
    const pitch = clamp(this.chasePitch + this.manualPitch, -1.35, 1.0);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    this._fwd.set(-sy * cp, sp, -cy * cp);
    this._right.set(cy, 0, -sy);
    this._up.crossVectors(this._right, this._fwd);

    this._dir.set(0, 0, 0)
      .addScaledVector(this._fwd, -1)
      .addScaledVector(this._up, this.chaseHeight / Math.max(0.5, this.chaseDist));
    const dirLen = this._dir.length() || 1;
    this._dir.multiplyScalar(1 / dirLen);
    const wantRadius = this.chaseDist * dirLen;

    /**
     * NO GROUND SNAP AT ALTITUDE. The boom cast is what stops the camera
     * standing inside a wall, and behind a climbing aeroplane it is a menace:
     * the climb term above pitches the boom UP, which points the cast BACKWARD
     * AND DOWN — straight into the runway and the hillside the aircraft has
     * just left. It reports a hit, the boom collapses to 0.6 m, and the camera
     * snaps onto the tailplane with clear sky all round it.
     *
     * Above `noCollideAlt` the cast is skipped outright and `free` stays at the
     * full radius — a skipped frame must publish "clear" rather than leave the
     * ring holding a stale minimum, or one low pass would pin the boom in for
     * the length of the collision window.
     *
     * THE TRADE, stated plainly: at 12 m AGL and above, a fixed-wing flown
     * between downtown towers can push the camera through one. That is a
     * deliberate choice of the rarer artefact — nobody threads the Steel
     * Building at 40 knots, and everybody takes off. It is scoped to the
     * fixed-wing class alone: a helicopter hovers next to buildings for a
     * living and keeps its cast at every height.
     */
    let free = wantRadius;
    if (phys && !(flight && alt > FLIGHT.noCollideAlt)) {
      const hit = phys.sphereCast(
        this.chasePivot, this._dir, CHASE.collideRadius, wantRadius, phys.MASK.WORLD
      );
      if (hit.hit) free = Math.max(0.6, hit.distance - CAMERA.collide.pad);
    }
    this._chaseRing[this._chaseCursor] = free;
    this._chaseCursor = (this._chaseCursor + 1) % this._chaseRing.length;
    let held = this._chaseRing[0];
    for (let i = 1; i < this._chaseRing.length; i++) {
      if (this._chaseRing[i] < held) held = this._chaseRing[i];
    }
    if (held < this.chaseRadius) {
      this.chaseRadius = approach(this.chaseRadius, held, CAMERA.collide.tauIn, dt);
    } else if (held > this.chaseRadius + CAMERA.collide.hysteresis) {
      this.chaseRadius = approach(this.chaseRadius, held, CAMERA.collide.tauOut, dt);
    }
    this.chaseRadius = Math.min(this.chaseRadius, wantRadius);

    this._chasePos.copy(this.chasePivot).addScaledVector(this._dir, this.chaseRadius);

    /**
     * THE FEEL CHANNELS, composed the same way the foot boom composes them.
     *
     * This block used to take the positional shake and `recoilPitch`/
     * `recoilYaw`/`recoilRoll`/`kickPitch` only — no rotational shake, no
     * `kickYaw`, no `kickRoll`, no punch. The published `viewKick` moved on
     * every one of those, so an instrument reading `viewKick` saw a response
     * the emitted camera transform did not have; and a crash, which is the one
     * thing that happens almost exclusively while you are IN a car, arrived as
     * two millimetres of translation and nothing else.
     */
    const full = CHASE.fullKick;
    const shake = this.trauma * this.trauma * CHASE.shakeGain;
    let shakePitch = 0, shakeYaw = 0, shakeRoll = 0;
    if (shake > 1e-4) {
      const S = CAMERA.shake;
      this._chasePos.addScaledVector(this._right, hashNoise(this.shakeTime * 0.8 + 13.3, 41) * shake * S.pos);
      this._chasePos.addScaledVector(this._up, hashNoise(this.shakeTime * 0.8 + 71.9, 53) * shake * S.pos);
      if (full) {
        shakePitch = hashNoise(this.shakeTime, 11) * shake * S.rot * DEG;
        shakeYaw = hashNoise(this.shakeTime + 31.7, 23) * shake * S.rot * DEG;
        shakeRoll = hashNoise(this.shakeTime + 57.1, 37) * shake * S.rot * 0.7 * DEG;
      }
    }
    if (full) this._chasePos.addScaledVector(this._fwd, this.punch.value);

    this._e.set(
      clamp(
        pitch + this.recoilPitch.value + this.kickPitch.value + shakePitch,
        -CAMERA.pitchLimit, CAMERA.pitchLimit
      ),
      yaw + this.recoilYaw.value + (full ? this.kickYaw.value : 0) + shakeYaw,
      this.chaseRoll + this.recoilRoll.value + (full ? this.kickRoll.value : 0) + shakeRoll
    );
    this._chaseQuat.setFromEuler(this._e);

    this.baseFov = this.ctx.config.fov * CAMERA.fovScale;
    this.chaseFov = approach(this.chaseFov, speedT * speedT * CHASE.fovGain, CHASE.fovTau, dt);
    this._chaseFov = this.baseFov * CHASE.fovBase + this.chaseFov;
    this.characterFade = 1;
    void m;
  }

  /* ==================================================================== */

  /** Write the composed transform onto the engine camera. */
  applyTo(camera) {
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quaternion);
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }
}

export { UP };
