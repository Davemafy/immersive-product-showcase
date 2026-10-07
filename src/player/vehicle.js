/**
 * Getting in and out of cars.
 *
 * `vehicles` owns the car; this file owns the ACTOR — where he stands, how he
 * reaches the handle, when the capsule leaves the world, and what the driving
 * input is forwarded as. Everything it reads off a vehicle is duck-typed, so
 * the subsystem can evolve its internals without breaking the player.
 *
 * The sequence, GTA-style:
 *
 *   PROMPT   nearest vehicle within reach and a free seat -> `ui` shows [F]
 *   OPEN     the actor steps to the door anchor and the near hand reaches the
 *            handle. Sprinting straight at a car skips this and dives in.
 *   JACK     if the seat is taken, the actor hauls the driver out first
 *   IN       the body is carried along a curve from the door to the seat while
 *            the capsule is disabled; the door shuts behind him
 *   DRIVE    input is forwarded to vehicles.setInput() and the body is pinned
 *            to the seat with hands on the wheel
 *   OUT      the reverse, ending with the capsule re-enabled beside the car
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR THINGS THAT WERE WRONG AND ARE MEASURED NOW
 *
 * 1. THE CAR MOVES. Every anchor used to be resolved once, at the instant F was
 *    pressed. Against parked cars that is invisible; against the traffic the
 *    player actually meets, the actor walked to where the door WAS and got in
 *    through thin air fifteen metres behind a car that had driven off. Every
 *    anchor is now stored in VEHICLE-LOCAL space and re-composed from the car's
 *    live transform each frame, so the whole sequence tracks a car that is still
 *    rolling — which is what a carjack is.
 *
 * 2. NOTHING WAS EVER PULLED OUT. The jack phase called `vehicles.eject()`,
 *    which does not exist and never has, so "PULL OUT" played the animation and
 *    left the driver sitting in the car with the player on top of him. The
 *    driver is a PED: `peds.pullFromVehicle(vehicle, doorPoint)` is the call,
 *    and it also panics the street, which is the half of a carjack you see.
 *
 * 2b. ...AND THEN THE WRONG SUBSYSTEM PULLED HIM OUT, IN THE WRONG PLACE.
 *    REPORTED, from play: "when I steal a car that is being driven, the
 *    occupant should be pulled out by my character". The call above was here,
 *    but it ran SECOND and it almost always found an empty car, because
 *    `_haulOut` opened by handing the vehicle to `traffic.abandon()` — and
 *    `abandon` is `traffic`'s FLEEING-DRIVER path: it ejects the body itself,
 *    at `vehicle.position.x + 1.4` (the middle of the car, plus a metre and a
 *    half of nothing), stands the car on its handbrake and files it in the
 *    ageing list that `_ageAbandoned` is entitled to delete from. So the
 *    occupant teleported out of the roof while the player was still walking to
 *    the door, and the car the player then inherited was one `traffic` had
 *    written off. `traffic`'s own header says so in as many words, beside
 *    `release()`: "This is deliberately NOT abandon()".
 *
 *    The order is now the one the fiction requires and the APIs were built
 *    for: PULL THE OCCUPANT OUT FIRST, at `doorPos` — the live door anchor
 *    this file already tracks against a moving car — and only then hand the
 *    car over with `traffic.release(v, 'enter')`, which lets go and touches
 *    nothing else. A car the AI is driving with no body in it yet (the seating
 *    sweep is budgeted, so a car can be under AI control with nobody rendered
 *    in it) has one materialised through `peds.attachDriver` and dragged out
 *    the same way, so the verb never silently does nothing. `peds` owns what
 *    he does next — the stagger, then the roll between running, freezing and
 *    squaring up.
 *
 * 2c. AND IT IS A RACE, WHICH REORDERING ALONE DOES NOT WIN. `traffic` does not
 *    wait for `vehicle:enter`: `TrafficSystem.fixedUpdate` compares every
 *    driver's car against `playerVehicle()` each tick and releases on the spot,
 *    and `release()` clears the seat itself. `player.vehicle` starts pointing
 *    at the car on the FIRST frame of the jack (`m.setDriving(true)` in
 *    `tryEnter`), so `traffic` got there ~0.35 s before the actor's hand did,
 *    every time — traced live on the real bus:
 *
 *      TrafficSystem.fixedUpdate -> release -> pullFromVehicle  => ped
 *      VehicleHandler._haulOut   ->           pullFromVehicle  => null
 *
 *    So `tryEnter` now RESERVES the occupant — `peds.holdOccupant(v, player)`
 *    — and `peds.pullFromVehicle` refuses anyone but the holder while that
 *    stands. `traffic` still hands the CAR over on its own schedule, which is
 *    its business; the BODY is the player's, and it stays in the seat until the
 *    animation reaches it. Every exit from the transition drops the hold, and
 *    `peds` lapses one anyway, so it cannot strand a car.
 *    `debugLegacyJack` restores the old order, the old call and the lost race
 *    on a live build: the negative control for `interactprobe`'s carjack
 *    section, which measures where the occupant ends up.
 *
 * 3. THE BODY DID NOT RIDE THE CAR. The live seat solve looked for
 *    `v.object3D ?? v.mesh ?? v.root`; a Vehicle exposes `model.root`, so the
 *    lookup returned null, the solve returned early, and the driver stayed
 *    parked at the seat position he had when the door shut.
 *
 * 4. THE EXIT WAS UNCONDITIONAL. It put you at the door anchor whatever was
 *    there — inside a wall, inside the next car in the queue, off the edge of a
 *    bridge. Five candidate spots are now capsule-tested in priority order and
 *    the first clear one wins; if every one is blocked you stay in the car,
 *    which is also what GTA does.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND ONE THING YOU CAN NOW DO THAT YOU COULD NOT: RIDE.
 *
 * REPORTED, from play: "I don't see any trollys — add riding the trolly or the
 * incline". The trolley and the funicular both existed; neither could be
 * boarded, because the only way into a vehicle in this file was the DRIVER'S
 * seat, and a passenger is a different verb with different rules:
 *
 *   - you may only get on while the car is STANDING AT A STOP. Stepping into
 *     a 19.5 t carriage doing 9 m/s is not a carjack, it is an accident, and
 *     `tryEnter` refuses it outright — which is also the negative control the
 *     gates assert on;
 *   - you have NO CONTROLS. `_stepRide` forwards nothing: the service keeps
 *     its own timetable and the player is freight. The only input that does
 *     anything is F (get off) and a move key (take the camera back);
 *   - there is no fare, no jack, no door handle and no driver to haul out;
 *   - the ride camera runs (see `CINE` in `camera.js`) because a passenger who
 *     is not steering wants a picture, not a chase boom.
 *
 * THE CONTRACT IS `v.transit`, and nothing else. `src/vehicles/tram.js`
 * publishes it on each trolley's `Vehicle`; `src/vehicles/funicular.js`
 * publishes one per incline car on a lightweight handle that quacks like a
 * Vehicle (the incline cars are scene geometry, not `Vehicle`s, and making
 * them into `Vehicle`s to be rideable would put two counterweighted cabins
 * into the tyre model). This file imports neither and knows the difference
 * between them nowhere: it reads a seat anchor, a door z, a half width, a
 * railhead plane and one boolean, `dwelling`.
 *
 * THE PHASE IS STILL `drive`, DELIBERATELY. `src/player/index.js` routes the F
 * edge with `if (v.phase === 'drive') v.tryExit(m); else if (!v.busy)
 * v.tryEnter(m)`, and `src/game/freeroam.js` reads the same string for its exit
 * verb. A fifth phase string would have been the honest name and would have
 * left F doing nothing at all aboard a tram until two files in other
 * subsystems agreed to learn about it. `passenger` is the flag that separates
 * them, `driving` and `seated` keep their old meanings, and every existing
 * reader of `phase` keeps working with no edit anywhere else.
 *
 * 5. IT RODE THE WRONG CAR. Fixing (3) put the body on `v.position` — the
 *    PHYSICS pose — while the renderer draws the car interpolated between the
 *    last two fixed steps. MEASURED (`camlagtest` check 3, kinematic drive, the
 *    drawn body expressed in the DRAWN car's frame): the driver slid 0.1250 m
 *    at 54 km/h and 0.2500 m at 108 km/h, and because the interpolation alpha
 *    alternates it is a BEAT, not an offset — the head visibly swimming through
 *    the seat back at speed. Half of that was here (`_drawnPose`, below) and
 *    half was `movement.sampleRender` lerping the finished seat AGAIN by the
 *    fixed-step alpha; both are now measured separately and gated.
 */

import * as THREE from 'three';
import { clamp, clamp01, smoothstep, smootherstep, approach } from './springs.js';
import { GAIT, NITRO } from './tuning.js';

/** How far from the vehicle's BOX (not its origin) the prompt appears. */
const ENTER_REACH = 2.2;
/** Vehicles further than this from the player are not even considered. */
const SCAN_RADIUS = 14;

const PHASE = {
  none: 'none',
  open: 'open',
  jack: 'jack',
  in: 'in',
  drive: 'drive',
  out: 'out',
};

const T = {
  open: 0.46,
  jack: 0.85,
  in: 0.62,
  dive: 0.34,
  out: 0.7,
};

/** Above this the actor is thrown clear rather than stepping out. */
const BAIL_SPEED = 7.0;

/**
 * How close to a transit car the RIDE prompt appears, measured to its box.
 * Wider than `ENTER_REACH` because a 14 m carriage's box distance is measured
 * to the flank and a platform is a couple of paces back from the running edge.
 */
const RIDE_REACH = 3.4;

/**
 * A transit door anchor may only be dropped onto ground within this much of
 * the car's own railhead plane.
 *
 * The incline car dwells on a TRESTLE: `phys.groundHeight` under it answers
 * with the hillside, which on the steep middle of the run is up to fifteen
 * metres below the platform. Without the band the actor walks to the door and
 * steps off the side of the mountain. Inside the band the ground query still
 * wins, because a real platform, a kerb or the ballast shoulder is exactly what
 * it is there to find.
 */
const TRANSIT_STEP_BAND = 1.6;

/** World up, for the yaw the animator has already written onto the root. */
const UP = new THREE.Vector3(0, 1, 0);
/** A vehicle's nose is +Z and an actor's facing is -Z: `seatYaw = heading + PI`. */
const FLIP = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
/** The tilt of a man who is not in a car. */
const IDENTITY = new THREE.Quaternion();

/**
 * How fast the seated body adopts the car's roll and pitch, in seconds.
 *
 * It cannot be zero. A chassis quaternion carries the suspension, so it chatters
 * over cobbles, tram rails and kerbs at the spring frequency — riding it raw
 * puts that chatter straight into the head, one metre from the chase lens, and
 * it reads as a flinch rather than as a road surface. MEASURED on the emitted
 * skeleton (`camtest`, `tilt.cobbles` / `tilt.holds`): an 8 Hz, 4-degree
 * peak-to-peak chatter riding on a 14-degree bank arrives at the head as
 * **0.93 degrees peak-to-peak — 23% of the chassis** — while the mean body roll
 * holds 13.99 degrees against the bank's 14.00.
 *
 * RATCHET. 0.085 is where this pass got to. The honest tuning wants a human on
 * a real cobbled street — lower it if the head still twitches, and never raise
 * it to make a gate go green.
 */
const TILT_TAU = 0.085;

export class VehicleHandler {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.phase = PHASE.none;
    this.t = 0;
    this.duration = 0;
    this.vehicle = null;
    this.seat = 0;
    this.candidate = null;
    this.dive = false;
    this._jacked = false;
    /** The car whose occupant we have reserved for this jack. See `_holdOccupant`. */
    this._held = null;

    this.doorPos = new THREE.Vector3();
    this.seatPos = new THREE.Vector3();
    this.exitPos = new THREE.Vector3();
    this.startPos = new THREE.Vector3();
    this.bodyPos = new THREE.Vector3();
    /** Anchors in VEHICLE-LOCAL space — the whole point of tracking a mover. */
    this.seatLocal = new THREE.Vector3();
    this.doorLocal = new THREE.Vector3();
    this.seatYaw = 0;
    this.doorYaw = 0;
    this.side = 1;
    this.door = 0;

    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.lateral = 0;
    this._prevVel = new THREE.Vector3();
    this._mv = { x: 0, y: 0 };

    /**
     * NITRO, 0..NITRO.max. The driver's bottle, not the car's — swapping cars
     * does not hand you a fresh tank, which is what makes it a resource. Stored
     * on the player state rather than per vehicle, so a pickup economy has one
     * place to top up.
     */
    this.nitro = NITRO.max;
    /** True on the frames the bottle is actually open. `ui` reads this. */
    this.nitroOn = false;

    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, boost: 0 };
    this._enterPayload = { vehicle: null, actor: player, seat: 0 };
    this._exitPayload = { vehicle: null, actor: player };
    this._jackPayload = { vehicle: null, actor: player, seat: 0, ped: null };
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._cap0 = new THREE.Vector3();
    this._cap1 = new THREE.Vector3();
    /** The DRAWN vehicle pose for this frame — see `_drawnPose`. */
    this._drawnPos = new THREE.Vector3();
    this._drawnQuat = new THREE.Quaternion();
    /**
     * NEGATIVE CONTROL, read by `src/player/camlagtest.mjs --control=seat` and
     * by nothing else: false composes the seat from the raw physics pose again,
     * which is the build that put the driver one fixed step off his seat.
     */
    this.debugSeatDrawnPose = true;

    /**
     * SEATED ATTITUDE — the roll and pitch the body wears in the seat.
     *
     * `setSeatTransform` carries a position and a YAW SCALAR, and the animator
     * writes the root as `setFromAxisAngle(UP, faceYaw)` — so the driver was
     * upright in world space whatever the car was doing. On the Mt. Washington
     * inclines and every kerb ramp in the city that is a body standing through
     * its own sheet metal: `drivetest`'s own facing check already carried the
     * gap in prose ("the rider does not lean with the machine yet") and gave
     * bikes a 12-degree tolerance to hide it.
     *
     * The fix is a rotation applied to the character root AFTER the animator
     * has posed it, never a change to the pose request — the seated pose solves
     * its pedals and wheel through `root.localToWorld`, so it is already
     * body-local and a rigid post-rotation carries all of it.
     *
     * `_seatTilt` is the tilt in BODY space (the residual once the yaw the
     * animator already applied is divided out), which is why it can be filtered
     * without the filter ever fighting `faceYaw`.
     */
    this._seatTilt = new THREE.Quaternion();
    this._tiltTarget = new THREE.Quaternion();
    this._yawQuat = new THREE.Quaternion();
    /**
     * NEGATIVE CONTROL, read by `src/player/camtest.mjs --control=tilt` and by
     * nothing else: false pins the tilt to identity, which is the build that
     * drove the driver bolt upright through the roof on every slope.
     */
    this.debugSeatTilt = true;
    /**
     * NEGATIVE CONTROL, read by `src/game/interactprobe.mjs` and by nothing
     * else: true restores the pre-fix carjack — `traffic.abandon()` first, so
     * the occupant is ejected by `traffic` into the middle of the car before
     * the player reaches the door and the car arrives with the handbrake on.
     * See note 2b in the header.
     */
    this.debugLegacyJack = false;
    /** Local-space exit candidates, filled in `_pickExit`. */
    this._exitTry = [];
    for (let i = 0; i < 6; i++) this._exitTry.push(new THREE.Vector3());
    /** What `ui` should offer, or null. */
    this.prompt = null;
    this._promptRec = { key: 'F', text: 'ENTER', sub: '' };

    /* ---- riding as a passenger (see the header) ---- */
    /** True for the whole of a RIDE — set on `tryEnter`, cleared on the way out. */
    this.passenger = false;
    /** The `transit` record of whatever is being ridden, or null. */
    this.transit = null;
    /**
     * "I want the next stop." Pressing F aboard a moving car arms this instead
     * of refusing, and `_stepRide` spends it the moment the car stands — which
     * is what a bell cord does and what the report asked for ("disembark at the
     * next stop"). Cleared by every exit out of the ride.
     */
    this.alightRequested = false;
    /** Reused scan list for transit handles that are not `Vehicle`s. */
    this._rides = [];
    /** Running best of `_consider`, so `_scan` allocates no closure. */
    this._scanBest = null;
    this._scanD = Infinity;

    /** Diagnostics the playtest harness reads. */
    this.stats = { enters: 0, jacks: 0, exits: 0, exitBlocked: 0, bails: 0, rides: 0 };
  }

  get active() {
    return this.phase !== PHASE.none;
  }

  /** True while the actor is in the seat (the seated pose is on). */
  get seated() {
    return this.phase === PHASE.drive || this.phase === PHASE.in;
  }

  get driving() {
    return this.phase === PHASE.drive;
  }

  get busy() {
    return this.phase === PHASE.open || this.phase === PHASE.jack ||
      this.phase === PHASE.in || this.phase === PHASE.out;
  }

  /* ==================================================================== */

  /**
   * The tilt the body wears this frame, filtered toward the car's own.
   *
   * Runs on every phase, including `none`: coming out of a car on a hill the
   * tilt has to decay to upright on the same curve it arrived on, or the actor
   * pops vertical on the frame the door shuts. The target is identity for
   * anything except `drive`, because that is the only phase whose yaw is
   * `seatYaw` — through `open` / `in` / `out` the body is turning between the
   * door and the seat, and a tilt resolved against a yaw the root does not have
   * would tip him sideways.
   */
  _stepSeatTilt(dt) {
    const want = this.phase === PHASE.drive && this.debugSeatTilt !== false
      ? this._tiltTarget : IDENTITY;
    const k = dt > 0 ? 1 - Math.exp(-dt / TILT_TAU) : 1;
    this._seatTilt.slerp(want, k);
  }

  /**
   * Wear it. `PlayerSystem` calls this immediately after `animator.update()`,
   * which is the only moment it can be called: the animator opens by writing
   * `root.quaternion` from the yaw alone and closes by solving the seated legs
   * and arms against `root.localToWorld`, so the pose underneath is body-local
   * and a rigid post-rotation carries every bone of it.
   *
   * The world matrices are rebuilt here rather than left to the renderer's own
   * pass, because four things read a bone matrix between now and the draw —
   * the weapon mount, the hitbox sync, `headPosition` and the shot harness —
   * and a body that is banked on screen but upright to every query is the same
   * class of bug in a different place. It is a hierarchy of ~30 bones, and only
   * while somebody is in a seat.
   *
   * Returns true when it actually rotated the root, so a harness can tell "no
   * tilt" apart from "not seated".
   */
  applySeatAttitude(root) {
    if (!root) return false;
    // 1 - |w| < 1e-6 is under a fifth of a degree of tilt: not worth a multiply
    // and a world-matrix rebuild on every frame the player is on foot.
    if (1 - Math.abs(this._seatTilt.w) < 1e-6) return false;
    root.quaternion.multiply(this._seatTilt);
    root.updateMatrixWorld(true);
    return true;
  }

  /** Called from PlayerSystem.update, before the camera solves. */
  update(dt, m) {
    const vehicles = this.ctx.peek('vehicles');
    if (this.phase === PHASE.none) {
      this._stepSeatTilt(dt);
      // The bottle refills on foot too, so walking to the next car is not dead
      // time. Only `_stepDrive` can ever open the valve.
      this._stepNitro(dt, false);
      this._scan(vehicles, m);
      return;
    }
    this.prompt = null;
    // A car that blew up, despawned or was streamed out under us is not a car.
    if (!this.vehicle || this.vehicle.destroyed) {
      if (this.phase === PHASE.drive || this.phase === PHASE.in) { this._forceOut(m); return; }
      if (!this.vehicle) { this.abort(m); return; }
    }
    this.t += dt;
    const u = this.duration > 0 ? clamp01(this.t / this.duration) : 1;

    switch (this.phase) {
      case PHASE.open: this._stepOpen(u, m); break;
      case PHASE.jack: this._stepJack(u, m); break;
      case PHASE.in: this._stepIn(u, m); break;
      case PHASE.drive: this._stepDrive(dt, m, vehicles); break;
      case PHASE.out: this._stepOut(u, m); break;
      default: break;
    }
    // After the step, so the filter reads the target this frame's
    // `_composeAnchors` just wrote rather than the previous frame's.
    this._stepSeatTilt(dt);
  }

  /* ---- prompt ------------------------------------------------------- */

  /**
   * Distance from the player to the vehicle's oriented box, not to its origin.
   * A Millhand 6 is 7.2 m long: measuring to the origin means you can stand
   * against the cab door and be told there is no vehicle here.
   */
  _boxDistance(v, p) {
    const half = v?.spec?.half;
    if (!half) return this._v.copy(v.position).distanceTo(p) - 1.6;
    this._v.copy(p).sub(v.position);
    if (v.quaternion) this._v.applyQuaternion(this._q.copy(v.quaternion).invert());
    const dx = Math.max(0, Math.abs(this._v.x) - half.x);
    const dy = Math.max(0, Math.abs(this._v.y) - half.y);
    const dz = Math.max(0, Math.abs(this._v.z) - half.z);
    return Math.hypot(dx, dy * 0.5, dz);
  }

  /**
   * Transit cars that are not `Vehicle`s and are therefore not in
   * `vehicles.vehicles` — today that is the two incline cabins, published by
   * `src/vehicles/funicular.js` as `riders`. Reached with `ctx.peek` (hard
   * rule 2) and returned through one reused array (hard rule 5). A build with
   * no funicular subsystem gets an empty list and never notices.
   */
  _transitRides() {
    const out = this._rides;
    out.length = 0;
    const f = this.ctx.peek('funicular');
    const list = f?.riders;
    if (Array.isArray(list)) for (let i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  /**
   * One ranking step, over cars and transit alike. The reach and the gate
   * differ by kind and by nothing else:
   *
   *   a car      ENTER_REACH to its box, whether it is moving or not — a
   *              carjack of a rolling car is a feature (see note 1).
   *   a transit  RIDE_REACH, and ONLY while it is standing at a stop. This is
   *   car        the whole "boarding a moving trolley does nothing" rule, and
   *              it lives HERE as well as in `tryEnter` so the prompt never
   *              offers a verb the press would refuse.
   *
   * A METHOD, NOT A CLOSURE. The obvious shape for this is an arrow inside
   * `_scan` capturing `p` and the running best — and `_scan` runs every frame
   * the player is on foot, so that is a fresh function object sixty times a
   * second for as long as the game is open (hard rule 5). The running best
   * lives on the handler instead.
   */
  _consider(v, p) {
    if (!v || v.destroyed || v._staged) return;
    const dx = v.position.x - p.x, dz = v.position.z - p.z;
    if (dx * dx + dz * dz > SCAN_RADIUS * SCAN_RADIUS) return;
    if (Math.abs(v.position.y - p.y) > 4) return;
    const t = v.transit;
    if (t && !t.dwelling) return;
    const d = this._boxDistance(v, p);
    if (d < (t ? RIDE_REACH : ENTER_REACH) && d < this._scanD) {
      this._scanD = d;
      this._scanBest = v;
    }
  }

  _scan(vehicles, m) {
    this.prompt = null;
    this.candidate = null;
    if (!m.grounded || m.swimming) return;
    const p = m.position;
    this._scanBest = null;
    this._scanD = Infinity;
    try {
      // `nearest` sorts by origin distance, which is the wrong metric for a
      // truck, so widen the query and re-rank by box distance.
      const list = vehicles?.vehicles;
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) this._consider(list[i], p);
      } else if (typeof vehicles?.nearest === 'function') {
        const n = vehicles.nearest(p.x, p.y, p.z, ENTER_REACH + 2.4);
        if (n && !(n.transit && !n.transit.dwelling)) this._scanBest = n;
      }
      const rides = this._transitRides();
      for (let i = 0; i < rides.length; i++) this._consider(rides[i], p);
    } catch {
      return;
    }
    const best = this._scanBest;
    if (!best) return;
    this.candidate = best;
    const t = best.transit;
    if (t) {
      this._promptRec.text = 'RIDE';
      this._promptRec.sub = t.stopName ? `${t.line} · ${t.stopName}` : t.line;
      this.prompt = this._promptRec;
      /**
       * PUBLISH IT OURSELVES, and only for a transit car.
       *
       * `src/player/index.js` writes this record to `ui` only on the frame its
       * text CHANGES, and `game.freeroam` re-asserts the same single slot every
       * frame and clears it on its own falling edge (that file's `_publish`
       * documents the "two caches over one slot" problem from the other side).
       * A car is fine either way because `freeroam` offers its own, better
       * worded TAKE line for one. Nothing in `game` knows the incline cabins
       * exist — they are not `Vehicle`s and its scan cannot see them — so
       * without this the one prompt telling the player he can ride the postcard
       * is whichever cache wrote last. Re-asserting is free: `ui.setPrompt`
       * change-guards every string it touches.
       */
      const ui = this.ctx.peek('ui');
      try { ui?.setPrompt?.(this._promptRec); } catch { /* stub */ }
      return;
    }
    this._promptRec.text = this._occupied(best, 0) ? 'PULL OUT' : 'ENTER';
    this._promptRec.sub = best.spec?.name ?? best.name ?? best.type ?? '';
    this.prompt = this._promptRec;
  }

  /**
   * Is seat `seat` taken? A Vehicle carries `driver` (the actor at the wheel)
   * and `occupants` (a flat push-array, NOT indexed by seat — reading it as if
   * it were is what used to send the player round to the passenger door of a
   * car he had just been told to pull someone out of).
   */
  _occupied(v, seat) {
    if (!v) return false;
    if (seat === 0) {
      if (v.driver !== undefined && v.driver !== null) return v.driver !== this.player;
      const peds = this.ctx.peek('peds');
      if (peds?.driverOf) { try { if (peds.driverOf(v)) return true; } catch { /* stub */ } }
      // A moving traffic car is being DRIVEN — by a `Driver` object rather than
      // by a ped, because `traffic` only materialises a body when it abandons a
      // car. Reading only `v.driver` therefore said every car in the city was
      // empty, offered ENTER instead of PULL OUT, and let the player climb into
      // a car whose AI was still steering it.
      if (this._trafficDriver(v)) return true;
      return !!v.occupant;
    }
    const n = Array.isArray(v.occupants) ? v.occupants.length : 0;
    return n > seat;
  }

  /** The `traffic` Driver bound to this car, if it owns it. */
  _trafficDriver(v) {
    const traffic = this.ctx.peek('traffic');
    if (!v || !traffic || typeof traffic.driverOf !== 'function') return null;
    try { return traffic.driverOf(v); } catch { return null; }
  }

  /**
   * Take the car off `traffic`. Without this the AI keeps calling
   * `vehicles.setInput()` at 60 Hz on the car the player is sitting in and the
   * two controllers fight over the throttle for as long as you are in it —
   * `traffic.fixedUpdate` drives every entry in `drivers` unconditionally and
   * its `isPlayerVehicle` check is only wired to the horn.
   *
   * `release(v, 'enter')` is the HANDOVER door and it is the right one: it
   * drops the driver, forgets the parking claim and touches nothing else. The
   * call this used to make — `abandon()` — is `traffic`'s fleeing-driver path,
   * which puts the handbrake on and files the car for ageing, and it took the
   * body out of the roof before the player had reached the door. See note 2b
   * in the header; `debugLegacyJack` puts it back for the negative control.
   *
   * Idempotent, and false when `traffic` never owned the car.
   */
  _releaseTraffic(v) {
    const d = this._trafficDriver(v);
    if (!d) return false;
    const traffic = this.ctx.peek('traffic');
    try {
      if (this.debugLegacyJack !== true && typeof traffic.release === 'function') {
        return traffic.release(v, 'enter') === true;
      }
      traffic.abandon(d, this.ctx);
      return true;
    } catch { return false; }
  }

  /* ==================================================================== */
  /* transitions                                                          */
  /* ==================================================================== */

  /** @returns true if an enter actually started. */
  tryEnter(m) {
    if (this.phase !== PHASE.none) return false;
    const v = this.candidate;
    if (!v || v.destroyed) return false;
    /**
     * THE ONE RULE OF BOARDING A SERVICE: it has to be standing at a stop.
     *
     * Asserted here and not only in `_scan`, because `game.freeroam._board`
     * sets `candidate` and calls straight through — so this is the gate a
     * scripted board, a touch button and the F key all pass. It is also the
     * negative control the gates read: `tramprobe`'s ride section and
     * `interactprobe`'s trolley section both press F at a moving car and
     * assert the player is still on the pavement.
     */
    const transit = v.transit ?? null;
    if (transit && !transit.dwelling) return false;
    this.transit = transit;
    this.passenger = !!transit;
    this.alightRequested = false;
    this.vehicle = v;
    // The player always goes for the wheel. If somebody is in it, that is a
    // carjack, not a reason to ride shotgun.
    this.seat = 0;
    this._resolveAnchors(v, this.seat, m);
    this._composeAnchors(v, m.position.y);

    this.startPos.copy(m.position);
    const reach = this.startPos.distanceTo(this.doorPos);
    this.dive = m.horizontalSpeed > 4.2;
    // The handler owns the actor's transform for the whole sequence, not just
    // the seated part: the capsule comes out of the world right now.
    m.setDriving(true, m.position, m.faceYaw);
    if (this._occupied(v, this.seat)) {
      this.phase = PHASE.jack;
      this.duration = T.jack;
      /**
       * CLAIM THE MAN IN THE SEAT, on the frame the verb starts.
       *
       * `m.setDriving(true)` one line up is what makes `player.vehicle` point
       * at this car, and `traffic.fixedUpdate` releases a car the instant it
       * sees that — clearing the seat ITSELF, at the chassis centre, a third of
       * a second before the actor's hand reaches the door. Traced live:
       * `TrafficSystem.fixedUpdate -> release -> pullFromVehicle => ped`, then
       * `_haulOut -> pullFromVehicle => null`. The hold makes the occupant
       * ours until `_haulOut` takes him; `traffic` still hands the CAR over on
       * its own schedule, which is what it is for. Skipped under
       * `debugLegacyJack`, because losing that race IS the pre-fix behaviour.
       */
      this._holdOccupant(v);
    } else {
      this.phase = PHASE.open;
      // Cover the ground at a believable rate rather than in a fixed time: a
      // dive-in from four metres is a lunge, from half a metre it is a step.
      this.duration = this.dive
        ? clamp(reach / 8.5, 0.14, 0.45)
        : clamp(reach / 2.6, 0.18, T.open);
    }
    this.t = 0;
    this._jacked = false;
    // Both committed gaits — you do not arrive at the door still running OR
    // still jogging. See `Movement._endCommittedGait`.
    m._endCommittedGait();
    return true;
  }

  tryExit(m) {
    if (this.phase !== PHASE.drive) return false;
    const v = this.vehicle;
    /**
     * PULL THE CORD. A passenger who presses F between stops is not refused —
     * that is the report's wording, "disembark at the next stop", and it is
     * what the bell does on a real car. `_stepRide` spends the request on the
     * first frame the service stands still.
     *
     * It returns TRUE so `game.freeroam`'s exit branch (which calls this a
     * second time off the same key press) reports the action as performed
     * rather than toasting "NO ROOM TO GET OUT" at a man on a moving tram.
     */
    if (this.passenger && this.transit && !this.transit.dwelling) {
      this.alightRequested = true;
      return true;
    }
    if (!this._pickExit(v, m)) {
      this.stats.exitBlocked++;
      return false;
    }
    this.phase = PHASE.out;
    const speed = v?.speed ?? Math.hypot(v?.velocity?.x ?? 0, v?.velocity?.z ?? 0);
    // Bailing out of a moving car is a tumble, not a step down.
    this._bail = speed > BAIL_SPEED;
    this.duration = this._bail ? 0.26 : T.out;
    this.t = 0;
    this.startPos.copy(this.seatPos);
    this.nitroOn = false;
    this._setInput(0, 0, 0, false);
    const vehicles = this.ctx.peek('vehicles');
    if (vehicles && v) { try { vehicles.setInput(v, this._input); } catch { /* stub */ } }
    return true;
  }

  /**
   * Where the actor stands, where he sits, and which side he came from. Every
   * anchor is converted into VEHICLE-LOCAL space so `_composeAnchors` can
   * rebuild it against the car's live transform every frame.
   *
   * `vehicles.seatAnchor()` is authoritative when it exists; otherwise the
   * anchors are derived from the spec's half extents. `seatAnchor` allocates,
   * so it is called exactly once per enter and never per frame.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * THE ANCHOR IS THE DRIVER'S HEAD. THE ROOT IS HIS FEET.
   *
   * `seatAnchor` is a point ON THE BODY, not a place to stand: `vehicles` puts
   * its own cockpit camera there (`vehicles/index.js`, the 'cockpit' pose), so
   * it is head height. `setSeatTransform` writes the actor's ROOT, which the
   * animator uses as the feet (`anim/animator.js` sets `root.position` from it
   * and the bind skeleton stacks upward from there).
   *
   * Copying one into the other lifted the whole body by a head height. Measured
   * on a sedan: root 1.01 m over the road, crown 2.80 m, roof 1.40 m — the
   * player was standing a metre and a half clear of the roof, which is the
   * "sits on top of the car" in the report. Subtracting the SEATED head height
   * (`GAIT.seat`) puts the head where `vehicles` asked for it and the rest of
   * the body underneath it, in the cabin, for every class from the sports car
   * to the truck without this file knowing anything about either.
   */
  _resolveAnchors(v, seat, m) {
    const half0 = v?.spec?.half;
    /**
     * A PASSENGER'S ANCHORS COME FROM `transit`, NOT FROM `vehicles`.
     *
     * `seatAnchor` solves a DRIVER's place from a car's style block, and a
     * trolley has no wheel to put him behind — the tram spec even declares
     * `seats: 0`. The service knows where its saloon is; this reads it and
     * nothing else, in the same head-anchor convention `seatAnchor` publishes,
     * so the head-height subtraction below is shared by both paths.
     */
    if (this.transit) {
      const t = this.transit;
      this.seatLocal.set(t.seat.x, t.seat.y, t.seat.z);
      // Board by the door on the side the player is already standing on.
      this._v.copy(m.position).sub(v.position);
      if (v.quaternion) this._v.applyQuaternion(this._q.copy(v.quaternion).invert());
      this.side = this._v.x >= 0 ? 1 : -1;
      let dz = t.doorZ[0];
      for (const z of t.doorZ) if (Math.abs(z - this._v.z) < Math.abs(dz - this._v.z)) dz = z;
      this.doorLocal.set(this.side * (t.hw + 0.65), t.railY, dz);
      this.seatLocal.y -= GAIT.seat.headHeight * (m?.bodyScale ?? 1);
      this._halfW = half0?.x ?? t.hw;
      this._halfL = half0?.z ?? 5;
      this._halfH = half0?.y ?? 1.6;
      return;
    }

    const vehicles = this.ctx.peek('vehicles');
    let anchor = null;
    if (vehicles && typeof vehicles.seatAnchor === 'function') {
      try { anchor = vehicles.seatAnchor(v, seat); } catch { anchor = null; }
    }

    const half = v?.spec?.half;
    const halfW = half?.x ?? (v?.width ?? 2.0) * 0.5;
    const halfL = half?.z ?? (v?.length ?? 4.6) * 0.5;
    const halfH = half?.y ?? 0.7;

    if (anchor?.local) {
      this.seatLocal.copy(anchor.local);
      this.side = anchor.side ?? -1;
    } else {
      // Which side of the car is the player already on? (Only used when the
      // vehicle system cannot tell us; the driver's door wins for seat 0.)
      this._v.copy(m.position).sub(v.position);
      if (v.quaternion) this._v.applyQuaternion(this._q.copy(v.quaternion).invert());
      this.side = seat === 0 ? -1 : (this._v.x >= 0 ? 1 : -1);
      this.seatLocal.set(
        this.side * halfW * 0.46,
        (v?.seatHeight ?? 0.32),
        seat < 2 ? halfL * 0.12 : -halfL * 0.4
      );
    }
    // Head anchor -> body root. See the note above; `GAIT.seat` is the same
    // record `anim/animator.js` poses the seated body from, so the head lands
    // back exactly where `vehicles` put it.
    this.seatLocal.y -= GAIT.seat.headHeight * (m?.bodyScale ?? 1);

    /* DELIBERATELY THE PHYSICS POSE, unlike `_composeAnchors`. This is an
     * INVERSION of a world point `vehicles.seatAnchor` composed from
     * `v.position` / `v.quaternion`; inverting it with any other transform
     * bakes the difference into the local anchor and then applies it again
     * every frame. What comes out of here is vehicle-LOCAL and pose-free — the
     * drawn pose is applied to it later, in `_composeAnchors`. */
    if (anchor?.enter && v.quaternion) {
      this.doorLocal.copy(anchor.enter).sub(v.position)
        .applyQuaternion(this._q.copy(v.quaternion).invert());
    } else if (anchor?.door && v.quaternion) {
      this.doorLocal.copy(anchor.door).sub(v.position)
        .applyQuaternion(this._q.copy(v.quaternion).invert());
    } else {
      this.doorLocal.set(this.side * (halfW + 0.5), -halfH, this.seatLocal.z);
    }
    this._halfW = halfW;
    this._halfL = halfL;
    this._halfH = halfH;
  }

  /**
   * THE POSE THE CAR IS DRAWN AT THIS FRAME — not the one physics finalised.
   *
   * `v.position` / `v.quaternion` are the end of the last FIXED step. The
   * renderer draws `lerp(prevPosition, position, alpha)` (`Vehicle.syncTransforms`,
   * `vehicles/dynamics.js`), so a body seated on the physics pose rides a car
   * that is up to one whole fixed step ahead of the one on screen — and because
   * `alpha` oscillates with the step cadence, it is a BEAT rather than a
   * constant offset. MEASURED, `camlagtest` check 3, kinematic drive, the drawn
   * body expressed in the DRAWN car's own frame: with `movement.sampleRender`'s
   * half of the same bug already fixed, this one on its own slid the driver
   * **0.0625 m at 54 km/h and 0.1250 m at 108 km/h** fore/aft, every frame —
   * the driver's head visibly swimming through the seat back. Both halves
   * together were 0.1250 / 0.2500 m; the table is in `camlagtest`'s header.
   *
   * This is the same defect `camera.js` fixed for the framing, and it is fixed
   * the same way — read the DRAWN transform — but NOT by reading `model.root`.
   * `vehicles.update()` writes that, and the registry topo-sorts `player`
   * BEFORE `vehicles`, so from here `model.root` still holds LAST frame's pose:
   * `camlagtest` measured that arm of the camera fix at 0.245 m / 0.373 m
   * adrift, i.e. worse than the bug. Recomposing the same lerp from
   * `prevPosition` / `position` / `ctx.time.alpha` is byte-identical to what
   * `syncTransforms` is about to write and depends on no ordering at all, so it
   * is correct whether `vehicles` has run yet or not.
   *
   * Falls back to the physics pose on anything that does not carry the previous
   * step (a stub in a harness, a vehicle mid-spawn) — which is exactly today's
   * behaviour, so nothing that works now can start throwing.
   */
  _drawnPose(v) {
    const p = this._drawnPos, q = this._drawnQuat;
    const alpha = this.ctx.time?.alpha;
    if (
      this.debugSeatDrawnPose === false || !Number.isFinite(alpha) ||
      !v.prevPosition || !v.prevQuaternion || !v.quaternion
    ) {
      p.copy(v.position);
      if (v.quaternion) q.copy(v.quaternion); else q.identity();
      return;
    }
    p.lerpVectors(v.prevPosition, v.position, alpha);
    q.copy(v.prevQuaternion).slerp(v.quaternion, alpha);
  }

  /** Rebuild the world anchors from the car's DRAWN transform. No allocation. */
  _composeAnchors(v, feetY) {
    if (!v) return;
    this._drawnPose(v);
    const q = this._drawnQuat;
    const at = this._drawnPos;
    this.seatPos.copy(this.seatLocal);
    this.seatPos.applyQuaternion(q);
    this.seatPos.add(at);

    this._v.copy(this.doorLocal);
    this._v.applyQuaternion(q);
    this._v.add(at);
    this.doorPos.set(this._v.x, this._v.y, this._v.z);
    const phys = this.ctx.peek('physics');
    if (phys) {
      const g = phys.groundHeight(this.doorPos.x, this.doorPos.z, this.doorPos.y + 2.4);
      // A transit door only accepts ground within a step of its own railhead
      // plane — see TRANSIT_STEP_BAND, and the incline's trestle.
      const ok = Number.isFinite(g) &&
        (!this.transit || Math.abs(g - this._v.y) <= TRANSIT_STEP_BAND);
      if (ok) this.doorPos.y = g + 0.02;
      else if (!this.transit && feetY !== undefined) this.doorPos.y = feetY;
    }

    /**
     * TWO DIFFERENT YAW CONVENTIONS MEET HERE, and taking the car's without
     * converting it seats the driver facing out of the back window.
     *
     *   a vehicle's nose is +Z          -> heading H points along ( sinH,  cosH)
     *   the actor's `faceYaw` is -Z     -> facing F points along (-sinF, -cosF)
     *      (`anim/animator.js` builds the body's forward as (-sin, 0, -cos);
     *       so does `index.js._buildPose` and `_pickExit` below)
     *
     * Equal numbers therefore mean OPPOSITE directions: `seatYaw = heading` put
     * the body at exactly 180 degrees to the car, which is measured, not
     * inferred — `drivetest.mjs` read 179.99 deg before this line was fixed.
     */
    const heading =
      Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    this.seatYaw = heading + Math.PI;
    if (this.seatYaw > Math.PI) this.seatYaw -= Math.PI * 2;
    // Face the car while opening the door.
    this.doorYaw = Math.atan2(
      -(at.x - this.doorPos.x), -(at.z - this.doorPos.z)
    );

    /**
     * ...AND THE OTHER TWO AXES, which nothing carried at all.
     *
     * `heading` above throws the roll and the pitch away — it is the yaw of a
     * quaternion that also describes a car sat at 14 degrees on a plaza kerb or
     * hanging off an incline. The residual is what the body owes the car:
     *
     *     wanted root  = q * FLIP                  (the car's full attitude)
     *     animator has = Ry(seatYaw)               (the yaw, and only the yaw)
     *     so the tilt  = Ry(seatYaw)^-1 * q * FLIP
     *
     * which is a pure roll/pitch in BODY space, because `seatYaw` was extracted
     * from this same `q` one line up. That is the property the filter in
     * `update` needs: it can lag the tilt as hard as a cobbled street requires
     * without ever putting the body's yaw behind the car's.
     */
    this._yawQuat.setFromAxisAngle(UP, this.seatYaw).invert();
    this._tiltTarget.copy(this._yawQuat).multiply(q).multiply(FLIP);
  }

  /* ==================================================================== */
  /* phases                                                               */
  /* ==================================================================== */

  _stepOpen(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    // Walk (or dive) the last stride to the handle, turning to face the door.
    const e = this.dive ? smootherstep(u) : smoothstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.doorPos, e);
    if (this.dive) this.bodyPos.y += Math.sin(e * Math.PI) * 0.1;
    m.setSeatTransform(this.bodyPos, this._turnTo(m.faceYaw, this.doorYaw, e));
    this.door = e; // 0..1 door swing, read by `vehicles` if it wants it
    this._pushDoor(u);
    if (u >= 1) {
      this.phase = PHASE.in;
      this.duration = this.dive ? T.dive * 1.2 : T.in;
      this.t = 0;
      this.startPos.copy(this.doorPos);
    }
  }

  _stepJack(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    const e = smoothstep(clamp01(u / 0.45));
    this.bodyPos.lerpVectors(this.startPos, this.doorPos, e);
    m.setSeatTransform(this.bodyPos, this._turnTo(m.faceYaw, this.doorYaw, e));
    this._pushDoor(clamp01(u / 0.3));
    if (u > 0.42 && !this._jacked) {
      this._jacked = true;
      this._haulOut();
    }
    if (u >= 1) {
      this.phase = PHASE.in;
      this.duration = T.in;
      this.t = 0;
      this.startPos.copy(this.doorPos);
    }
  }

  /**
   * Claim the occupant for the duration of the jack, and give the claim back.
   * `_dropHold` is called from every exit out of the transition — the pull
   * itself, `abort`, and the door closing — so a cancelled jack can never
   * strand a car. (`peds` also lapses a hold on its own, which is the belt to
   * this brace: a leak here would be silent and permanent.)
   */
  _holdOccupant(v) {
    if (this.debugLegacyJack === true) return false;
    const peds = this.ctx.peek('peds');
    if (!peds?.holdOccupant) return false;
    try { this._held = peds.holdOccupant(v, this.player) ? v : null; } catch { this._held = null; }
    return !!this._held;
  }

  _dropHold() {
    const v = this._held;
    if (!v) return;
    this._held = null;
    const peds = this.ctx.peek('peds');
    try { peds?.releaseOccupant?.(v, this.player); } catch { /* stub */ }
  }

  /**
   * The actual carjack. `peds` owns the driver, so `peds` takes him out of the
   * car — at the DOOR the player is standing at, not at the car's centre — and
   * leaves him on the road; only then does `traffic` hand the car over and
   * `vehicles` get told the seat is free. The order is the fix; see note 2b.
   */
  _haulOut() {
    const v = this.vehicle;
    const peds = this.ctx.peek('peds');
    const vehicles = this.ctx.peek('vehicles');
    const legacy = this.debugLegacyJack === true;
    // THE PRE-FIX ORDER, and only for the negative control: `traffic` first,
    // which ejects the body itself, in the wrong place, before we get there.
    const jumped = legacy ? this._releaseTraffic(v) : false;

    let ped = null;
    if (peds?.pullFromVehicle) {
      try { ped = peds.pullFromVehicle(v, this.doorPos, this.player); } catch { ped = null; }
    }
    /**
     * A CAR UNDER AI CONTROL WITH NOBODY DRAWN IN IT. `traffic`'s seating
     * sweep is budgeted out of `q.pedBudget` and only bodies the cars near the
     * player, so "being driven" and "has a driver you can grab" are different
     * facts. Materialise one through the published door and drag him out the
     * same way, rather than letting the headline verb quietly do nothing —
     * this is the one useful thing `abandon()` used to do for us.
     */
    if (!ped && !legacy && peds?.attachDriver && this._trafficDriver(v)) {
      try {
        if (peds.attachDriver(v, 0, JACK_ARCH)) {
          ped = peds.pullFromVehicle(v, this.doorPos, this.player);
        }
      } catch { ped = null; }
    }
    this._dropHold();
    const hadTraffic = this._releaseTraffic(v) || jumped;
    if (hadTraffic && !ped) {
      // Nobody to grab (the pool was spent, or the legacy path beat us to it):
      // it is still a jack, and the car has still changed hands.
      ped = peds?.driverOf?.(v) ?? null;
      this._jacked = true;
    }
    if (!ped && v?.driver && vehicles?.clearDriver) {
      // Not a ped (a `traffic` driver, a stub): just take the wheel off them.
      // `police` books a carjack off the ped's own `vehicle:exit`, so only the
      // non-ped case has to be reported by hand or it would double-count.
      const driver = v.driver;
      try { vehicles.clearDriver(v, driver); } catch { /* stub */ }
      const police = this.ctx.peek('police');
      try { police?.reportCrime?.('carjack', this.doorPos, 1); } catch { /* stub */ }
    }
    // Legacy hook, kept because it costs nothing and a future `vehicles` may
    // want to animate the door and the body itself.
    try { vehicles?.eject?.(v, this.seat, 'jack'); } catch { /* not implemented */ }
    if (ped || hadTraffic) this.stats.jacks++;
    this._jackPayload.vehicle = v;
    this._jackPayload.seat = this.seat;
    this._jackPayload.ped = ped;
    this.ctx.events.emit('vehicle:jack', this._jackPayload);
  }

  _stepIn(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    // Rise into the seat on an arc — hips up over the sill, then across.
    const e = smootherstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.seatPos, e);
    this.bodyPos.y += Math.sin(e * Math.PI) * 0.13;
    m.setSeatTransform(this.bodyPos, this._turnTo(this.doorYaw, this.seatYaw, e));
    this._pushDoor(1 - smoothstep(clamp01((u - 0.45) / 0.55)));
    if (u >= 1) {
      this.phase = PHASE.drive;
      this.t = 0;
      this.stats.enters++;
      /**
       * A PASSENGER TAKES NO SEAT OFF THE SERVICE.
       *
       * `vehicles.setDriver` starts the engine, marks the tank as the player's
       * and claims the seat — every one of which is wrong for a fare-free
       * passenger on a kinematic car that is driving itself, and two of which
       * would make `traffic`, `police` and the despawn guard think the player
       * is at the controls of a trolley. The event still goes out, flagged, so
       * anything listening for "the player got into something" still hears it.
       */
      if (this.passenger) {
        this.stats.rides++;
        this._enterPayload.vehicle = this.vehicle;
        this._enterPayload.seat = this.seat;
        this._enterPayload.passenger = true;
        this.ctx.events.emit('vehicle:enter', this._enterPayload);
        // The reel starts the instant the doors shut, not on the way in — a
        // cut away from the body mid-animation loses the boarding beat.
        this.player?.rig?.beginCinematic?.(this.vehicle);
        return;
      }
      const vehicles = this.ctx.peek('vehicles');
      this._enterPayload.vehicle = this.vehicle;
      this._enterPayload.seat = this.seat;
      this._enterPayload.passenger = false;
      // `setDriver` starts the engine, marks the tank as the player's (so fuel
      // burns) and raises `vehicle:enter` itself — do not double-emit.
      // Belt and braces: a car entered without a jack (parked, or one the AI
      // picked up mid-sequence) must still come off the AI's books.
      this._releaseTraffic(this.vehicle);
      let claimed = false;
      if (vehicles?.setDriver) {
        try { vehicles.setDriver(this.vehicle, this.player, this.seat); claimed = true; }
        catch { claimed = false; }
      }
      if (!claimed) this.ctx.events.emit('vehicle:enter', this._enterPayload);
    }
  }

  _stepDrive(dt, m, vehicles) {
    const v = this.vehicle;
    if (!v) { this._forceOut(m); return; }

    // Pin the body to the seat — from the LIVE transform, so it rides the
    // suspension instead of staying where the door shut.
    this._composeAnchors(v, m.position.y);
    m.setSeatTransform(this.seatPos, this.seatYaw);

    if (this.passenger) { this._stepRide(dt, m); return; }

    const input = this.ctx.input;
    if (this.player.controlEnabled && input && !this.player.health.dead) {
      /**
       * `m.scriptedInput` is how the harness holds a control without
       * synthesising key events, and `Movement.latchInput` has honoured it for
       * years — but this path read `ctx.input` only, so a scripted `{y: 1}`
       * moved a character on foot and did NOTHING once he was behind a wheel.
       * `playtest.mjs --script=car` therefore reported on a car that was
       * coasting, which is half of why a car that would not drive survived a
       * green harness.
       */
      const s = m.scriptedInput;
      const mv = this._mv;
      if (s) { mv.x = s.x ?? 0; mv.y = s.y ?? 0; }
      else input.moveVector(mv);
      const throttle = Math.max(0, mv.y);
      const brake = Math.max(0, -mv.y);
      this.throttle = approach(this.throttle, throttle, 0.05, dt);
      this.brake = approach(this.brake, brake, 0.04, dt);
      this.steer = approach(this.steer, mv.x, 0.07, dt);
      /**
       * NITRO on the SPRINT control. Shift runs on foot and boosts in a car —
       * one control, two contexts. No new key is needed and none is added:
       * `src/core/input.js` already has `sprint`.
       */
      const want = s ? !!s.boost : input.action('sprint');
      /**
       * FLIGHT KINDS TAKE THE SPRINT CHANNEL RAW, NOT THROUGH THE BOTTLE.
       *
       * `plane.js` reads `input.boost` as the THROTTLE LEVER (Shift winds it up)
       * and `heli.js` reads it as DESCENT. The nitro bottle is a car mechanic —
       * it only opens above a throttle pedal (`throttle > minThrottle`) and
       * drains in 3.6 s — and on an aircraft the "throttle pedal" is the
       * ELEVATOR (`this.throttle` = stick-forward = nose down). MEASURED on the
       * real key path: holding Shift in a Skylark delivered `input.boost 0` for
       * ten seconds — the bottle never opened because no forward stick was held —
       * so the lever stayed at 0 and the aeroplane never rolled. That is the
       * "airplane does not take off or move" report, and it is the same defect
       * heli.js's header flagged as `player/vehicle.js`'s to remove (which left
       * the helicopter unable to DESCEND on Shift). Forward the sprint press
       * straight through for a flying machine; the car path is untouched.
       */
      const flying = v.spec?.kind === 'plane' || v.spec?.kind === 'heli';
      this._stepNitro(dt, flying ? false : want);
      this._setInput(
        this.throttle, this.brake, this.steer,
        // Space is the handbrake in a car — the same key the harness scripts
        // as `jump`, which is what it is on foot.
        s ? !!s.jump : input.action('jump'),
        s ? !!s.horn : input.action('horn'),
        flying ? (want ? 1 : 0) : (this.nitroOn ? 1 : 0)
      );
      if (vehicles && typeof vehicles.setInput === 'function') {
        try { vehicles.setInput(v, this._input); } catch { /* stub */ }
      }
    }

    // Lateral load for the lean-into-corners head pose.
    if (v.velocity) {
      this._v.copy(v.velocity).sub(this._prevVel);
      this._prevVel.copy(v.velocity);
      const right = this._v2.set(1, 0, 0);
      if (v.quaternion) right.applyQuaternion(v.quaternion);
      const a = dt > 1e-4 ? (this._v.x * right.x + this._v.z * right.z) / dt : 0;
      this.lateral = approach(this.lateral, clamp(a / 9, -1, 1), 0.14, dt);
    }
  }

  /**
   * RIDING. The seat is already pinned by the caller; this is everything else.
   *
   * The list of things it does NOT do is the point: no `setInput`, no nitro, no
   * lateral load, no handbrake, no horn. A passenger cannot make a 19.5 t
   * carriage do anything, and forwarding a throttle to a `kinematic` vehicle
   * that ignores it would be a lie the next reader has to disprove.
   *
   * Two inputs are live, and they are the two the report named:
   *
   *   any move key   takes the camera back. The ride continues — you are still
   *                  on the tram, you just want to look at it yourself. This is
   *                  deliberately NOT the mouse: see `addLook` in camera.js.
   *   F              handled by `tryExit` (get off, or ring for the next stop).
   *
   * ...and the third thing, which is not an input at all: a `alightRequested`
   * armed between stops is spent the moment the service stands.
   */
  _stepRide(dt, m) {
    void dt;
    const rig = this.player?.rig;
    const t = this.transit;

    // The service can be wrecked, streamed out or disposed under a rider.
    if (!t || this.vehicle?.destroyed) { this._forceOut(m); return; }

    if (rig?.cinematicActive) {
      const s = m.scriptedInput;
      const mv = this._mv;
      if (s) { mv.x = s.x ?? 0; mv.y = s.y ?? 0; }
      else if (this.ctx.input) this.ctx.input.moveVector(mv);
      else { mv.x = 0; mv.y = 0; }
      if (Math.abs(mv.x) > 0.2 || Math.abs(mv.y) > 0.2) rig.endCinematic();
    }

    if (this.alightRequested && t.dwelling) {
      this.alightRequested = false;
      // `tryExit` re-enters here with `dwelling` true, so it takes the real
      // exit branch rather than arming the request again.
      this.tryExit(m);
    }
  }

  _stepOut(u, m) {
    // The exit target was chosen and validated at tryExit against the car's
    // pose THEN; a car that is still rolling drags it along, so re-compose.
    if (this.vehicle) {
      this._composeAnchors(this.vehicle, m.position.y);
      this._exitWorld(this.vehicle, this._exitLocal, this.exitPos);
    }
    const e = this._bail ? u : smoothstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.exitPos, e);
    this.bodyPos.y += Math.sin(e * Math.PI) * (this._bail ? 0.22 : 0.1);
    m.setSeatTransform(this.bodyPos, this._turnTo(this.seatYaw, this.doorYaw, e));
    this._pushDoor(Math.sin(clamp01(u) * Math.PI));
    if (u >= 1) this._forceOut(m);
  }

  /* ==================================================================== */
  /* exit placement                                                       */
  /* ==================================================================== */

  _exitWorld(v, local, out) {
    // The DRAWN pose, for the same reason `_composeAnchors` uses it: the step
    // out is a body the player watches leave a car he can see.
    this._drawnPose(v);
    out.copy(local);
    out.applyQuaternion(this._drawnQuat);
    out.add(this._drawnPos);
    const phys = this.ctx.peek('physics');
    if (phys) {
      const g = phys.groundHeight(out.x, out.z, out.y + 3.0);
      /**
       * SAME BAND AS THE DOOR ANCHOR, and for a worse reason. `groundHeight`
       * under an incline cabin answers with the HILLSIDE, which mid-run is up
       * to fifteen metres below the trestle it is standing on — and unlike the
       * door anchor, this point is where `_forceOut` TELEPORTS the actor. A
       * step off a tram onto ground a storey down is a fall down Mt.
       * Washington the player did not ask for. Inside the band the ground
       * query still wins, which is what puts him on the platform.
       */
      const ok = Number.isFinite(g) &&
        (!this.transit || Math.abs(g - out.y) <= TRANSIT_STEP_BAND);
      if (ok) out.y = g + 0.03;
    }
    return out;
  }

  /**
   * Choose somewhere the player can actually stand. Candidates, in order:
   * the door he came in by, the far door, behind, in front, then the roof.
   * Each is capsule-tested against the static world; the first clear one wins.
   * Returns false when every one is blocked — in which case you stay in.
   */
  _pickExit(v, m) {
    if (!v) return false;
    const phys = this.ctx.peek('physics');
    const hw = this._halfW ?? 1.0;
    const hl = this._halfL ?? 2.3;
    const hh = this._halfH ?? 0.7;
    const z = this.doorLocal.z;
    const c = this._exitTry;
    c[0].set(this.side * (hw + 0.55), -hh, z);
    c[1].set(-this.side * (hw + 0.55), -hh, z);
    c[2].set(0, -hh, hl + 0.8);
    c[3].set(0, -hh, -(hl + 0.8));
    c[4].set(this.side * (hw + 1.35), -hh, z);
    c[5].set(0, hh + 0.1, 0); // the roof, so a wedged car is never a soft-lock

    const r = 0.32;
    const height = 1.78 * (m?.bodyScale ?? 1);
    for (let i = 0; i < c.length; i++) {
      this._exitWorld(v, c[i], this._v3);
      if (!phys) { this._exitLocal = c[i]; this.exitPos.copy(this._v3); return true; }
      this._cap0.set(this._v3.x, this._v3.y + r + 0.04, this._v3.z);
      this._cap1.set(this._v3.x, this._v3.y + Math.max(r + 0.05, height - r), this._v3.z);
      if (phys.checkCapsule(this._cap0, this._cap1, r * 0.94, phys.MASK.CHARACTER)) {
        this._exitLocal = c[i];
        this.exitPos.copy(this._v3);
        // Step out facing away from the car. `_exitWorld` has just left the
        // drawn pose in `_drawnPos`, and `exitPos` is expressed against it.
        this.doorYaw = Math.atan2(
          -(this.exitPos.x - this._drawnPos.x), -(this.exitPos.z - this._drawnPos.z)
        );
        return true;
      }
    }
    return false;
  }

  _forceOut(m) {
    const v = this.vehicle;
    this._dropHold();
    const phys = this.ctx.peek('physics');
    if (v) this._exitWorld(v, this._exitLocal ?? this.doorLocal, this.exitPos);
    let y = this.exitPos.y;
    if (phys) {
      const g = phys.groundHeight(this.exitPos.x, this.exitPos.z, this.exitPos.y + 3.0);
      if (Number.isFinite(g)) y = g + 0.03;
    }
    m.setDriving(false);
    m.teleport(this.exitPos.x, y, this.exitPos.z, this.doorYaw);
    // Bailing out of a moving car carries the car's momentum into the tumble.
    if (this._bail && v?.velocity) {
      m.velocity.set(v.velocity.x * 0.55, 1.2, v.velocity.z * 0.55);
      m.grounded = false;
      m.beginStumble(1);
      this.stats.bails++;
    }
    this._bail = false;
    this.stats.exits++;

    const wasPassenger = this.passenger;
    this._endRide();
    const vehicles = this.ctx.peek('vehicles');
    let released = false;
    // A passenger never took the seat (see `_stepIn`), so there is nothing to
    // give back and `clearDriver` would be handed a handle that is not in the
    // fleet at all. Raise the exit ourselves.
    if (!wasPassenger && v && vehicles?.clearDriver) {
      // `clearDriver` raises `vehicle:exit` itself.
      try { vehicles.clearDriver(v, this.player); released = true; } catch { released = false; }
    }
    if (!released) {
      this._exitPayload.vehicle = v;
      this.ctx.events.emit('vehicle:exit', this._exitPayload);
    }
    this.phase = PHASE.none;
    this.vehicle = null;
    this.t = 0;
    this.steer = this.throttle = this.brake = this.lateral = 0;
    this._prevVel.set(0, 0, 0);
  }

  /* ==================================================================== */

  _turnTo(from, to, t) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    return from + d * t;
  }

  _pushDoor(open) {
    // A transit car's doors are the service's business, and the incline cabins
    // are not `Vehicle`s at all — `setDoor` would be handed an object with no
    // `model.doors` to swing.
    if (this.transit) return;
    const vehicles = this.ctx.peek('vehicles');
    vehicles?.setDoor?.(this.vehicle, this.seat, clamp01(open));
  }

  /** Everything a ride has to give back, wherever it ends. Idempotent. */
  _endRide() {
    if (!this.passenger) return;
    this.passenger = false;
    this.transit = null;
    this.alightRequested = false;
    this.player?.rig?.endCinematic?.();
  }

  /**
   * Burn or refill the bottle for this step, and decide whether it is open.
   *
   * Two gates: an empty tank does nothing, and boost off the throttle does
   * nothing — so it cannot be spent standing still or
   * used to shove a car that is braking. `cutoff` keeps the last drop from
   * stuttering the boost on and off frame by frame as the tank empties.
   */
  _stepNitro(dt, want) {
    const open = want && this.nitro > NITRO.cutoff && this.throttle > NITRO.minThrottle;
    this.nitro = clamp(
      this.nitro + (open ? -NITRO.drain : NITRO.charge) * dt,
      0, NITRO.max
    );
    this.nitroOn = open;
    return open;
  }

  /** 0..1, for the HUD gauge. */
  get nitroFraction() {
    return clamp01(this.nitro / NITRO.max);
  }

  _setInput(throttle, brake, steer, handbrake, horn, boost = 0) {
    this._input.throttle = throttle;
    this._input.brake = brake;
    this._input.steer = steer;
    this._input.handbrake = !!handbrake;
    this._input.horn = !!horn;
    this._input.boost = boost;
  }

  /** Drop out of any vehicle immediately (death, teleport, control loss). */
  abort(m) {
    if (this.phase === PHASE.none) return;
    this._dropHold();
    const v = this.vehicle;
    const wasPassenger = this.passenger;
    this._endRide();
    const vehicles = this.ctx.peek('vehicles');
    let released = false;
    if (!wasPassenger && v && vehicles?.clearDriver) {
      try { vehicles.clearDriver(v, this.player); released = true; } catch { released = false; }
    }
    if (v && !released) {
      this._exitPayload.vehicle = v;
      this.ctx.events.emit('vehicle:exit', this._exitPayload);
    }
    this.phase = PHASE.none;
    this.vehicle = null;
    this.prompt = null;
    this._bail = false;
    this.steer = this.throttle = this.brake = this.lateral = 0;
    // The bottle keeps its charge across cars; only the valve shuts.
    this.nitroOn = false;
    this._input.boost = 0;
    m?.setDriving(false);
  }
}

/** The body materialised for a jack of an AI car that had none. See `_haulOut`. */
const JACK_ARCH = Object.freeze({ archetype: 'street' });

export { PHASE };
