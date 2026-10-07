import * as THREE from 'three';
import {
  Accum, box, chamferBox, cyl, card, lathe, extrude, ngon, tube,
  combine, weather, paint, dent, newTrs, clamp01, lerp, TAU, hash3i, smoothNoise,
} from './geom.js';

/**
 * PROPS — signage and commerce.
 *
 * This is a night-time city: neon and sodium are the whole look (DESIGN.md,
 * "Art direction"). Every lit element here is an EMISSIVE material driven off
 * the sun altitude, never a punctual light — a downtown block carries fifty of
 * them and `q.lightSlots` is eight.
 *
 * The families:
 *   fascia      the horizontal signboard over a shopfront, with lit lettering
 *   blade       a sign projecting at right angles into the street
 *   neon        bent-tube word shapes, six of them, in the district's colour
 *   awning      sloped canvas with a valance, on a real frame
 *   menu/A-board the pavement clutter of a trading street
 *   poster      flyposting: overlapping, torn, on hoardings and shutters
 *   graffiti    aerosol strokes, raised a few millimetres off the wall
 *   ghost sign  the half-century-old painted advert on a brick gable
 */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * `?owNoSigns=` — THE NEGATIVE CONTROL FOR WHAT THIS LAYER COSTS AT NIGHT
 * ────────────────────────────────────────────────────────────────────────────
 * A night frame is FILL, not triangles: neon runs 3.0-3.8 emissive against a
 * bloom threshold, and every word carries an additive halo card behind it, so
 * a downtown block pays for the signage layer in overdraw and in bloom-taps
 * rather than in vertex work. None of that could be measured, because there
 * was no way to build the city WITHOUT it — and reverting the layer shifts the
 * RNG stream, which moves every building in Steel City and measures a
 * different picture.
 *
 * So the hatch does not remove a prototype, an instance, a material or a draw
 * call. It collapses the named family's GEOMETRY to zero area, which leaves
 * everything the layout decided identical and takes away exactly the fill.
 * `perfcheck --ab='.|owNoSigns=halo,.'` then reports one number: the frame
 * cost of the halo cards. Same convention as `?owNoFacadeKit=1`.
 *
 *   halo   the additive card behind every neon word
 *   neon   the bent-tube words themselves (the hot emitters)
 *   glow   `shop_glow`, the lit plane behind a shop window
 *   1      all three
 *
 * `=1` ALSO TRIPS `layout.js`'s OWN `owNoSigns=1` kill switch, which stops the
 * type layer being EMITTED at all (`Layout._type` / `_neonWord`). That is a
 * superset, not a conflict: `=1` is "what does the whole signage layer cost",
 * and the named values are "what does this one family's fill cost", which is
 * the question the layout switch cannot answer because it removes the
 * instances and the draw calls along with the pixels.
 *
 * WHAT IT MEASURED, and it is a negative result worth keeping. The gated
 * `night` scene has almost no signage IN IT: counted off the live frame after
 * `__SETTLED__`, one `neon_amber` mesh (1 instance, 64 tris), ZERO halo meshes,
 * one `window_glow` (12 tris) and three `shop_lit` (150 tris), against 2369
 * draw calls and 9.4 M triangles in the frame. Neon emissive and halo overdraw
 * cannot be the night frame's cost, because at the place the budget is measured
 * there is nothing of either to draw.
 */
const NO_SIGNS = (() => {
  if (typeof location === 'undefined') return '';
  const m = /[?&]owNoSigns=([^&]*)/.exec(location.search);
  return m ? decodeURIComponent(m[1]) : '';
})();
const signOff = (part) => NO_SIGNS === '1' || NO_SIGNS.split(',').includes(part);
/**
 * Zero area, not zero vertices: an empty geometry would change the draw-call
 * count and the instancing, and then the delta would be about bookkeeping
 * instead of about fill.
 */
const flatten = (g) => (g.scale(1e-4, 1e-4, 1e-4), g);

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

/** A stroke of spray paint: a flattened tube following a polyline. */
function stroke(pts, r = 0.05) {
  const g = tube(pts, r, 5);
  g.scale(1, 1, 0.3);
  return g;
}

/* ====================================================================== */
/* FASCIA + BLADE SIGNS                                                   */
/* ====================================================================== */

export function registerFascia(K) {
  /**
   * The signboard over a shopfront. Built at unit width (1 m) about the origin
   * so the layout can scale it to the shop's actual frontage — the only prop in
   * the kit that is deliberately scaled non-uniformly, because a fascia has to
   * fit its shop.
   */
  /**
   * NON-UNIFORM SCALE IS A TRAP. The board is stretched to the shop's actual
   * frontage, which is fine for boxes and fatal for anything with a round
   * cross-section: a 22 mm gooseneck tube stretched five times reads as a flat
   * ribbon. So the board carries only box geometry, and the two lamps over it
   * are their own prototype, placed at uniform scale.
   */
  P(K, 'fascia_board', () => {
    const parts = [];
    parts.push([chamferBox(1.0, 0.62, 0.14, 0.012), newTrs(0, 0, 0.07)]);
    parts.push([box(1.04, 0.05, 0.20), newTrs(0, 0.63, 0.07)]);
    parts.push([box(1.04, 0.04, 0.18), newTrs(0, -0.02, 0.07)]);
    const g = combine(parts, 'fascia');
    weather(g, { grimeBase: 0.7, grimeHeight: 3.0, wear: 0.6, seed: 601, up: 0.6 });
    return g;
  }, 'pole_dark');

  P(K, 'fascia_lamp', () => {
    const parts = [];
    parts.push([tube([
      { x: 0, y: 0.66, z: 0.06 },
      { x: 0, y: 0.86, z: 0.10 },
      { x: 0, y: 0.90, z: 0.26 },
      { x: 0, y: 0.82, z: 0.34 },
    ], 0.018, 5), null]);
    parts.push([lathe([[0.0, 0], [0.075, 0.01], [0.085, 0.05], [0.02, 0.075]], 8),
      newTrs(0, 0.80, 0.34, 0, 1, 1, 1, Math.PI)]);
    const g = combine(parts, 'fascialamp');
    weather(g, { grimeBase: 0.7, grimeHeight: 3.0, wear: 0.6, seed: 602, up: 0.6 });
    return g;
  }, 'pole_dark');

  /**
   * The face of the fascia — PAINTED sheet in four colourways, not a light.
   * Only the channel letters on top of it glow.
   */
  /**
   * The face is stretched to the shop's frontage, so every feature on it has to
   * survive an X scale of five. Boxes that run the FULL width do (a reveal rail
   * stays a reveal rail); anything with a fixed X extent does not, which is why
   * the border is two rails and not a picture frame. The old face was one flat
   * quad and read as a blank cream rectangle in every street capture.
   */
  for (const key of ['panel_cream', 'panel_navy', 'panel_maroon', 'panel_forest']) {
    P(K, `fascia_face_${key}`, () => {
      const parts = [];
      const g = new THREE.BoxGeometry(0.94, 0.48, 0.02);
      g.translate(0, 0.07, 0.152);
      parts.push([g, null]);
      // top and bottom reveal rails, proud of the field
      parts.push([box(0.97, 0.035, 0.045), newTrs(0, 0.285, 0.150)]);
      parts.push([box(0.97, 0.030, 0.045), newTrs(0, -0.185, 0.150)]);
      const out = combine(parts, 'fasciaface');
      paint(out, (x, y, z, nx, ny) => {
        const e = Math.max(Math.abs(x) / 0.47, Math.abs(y - 0.07) / 0.24);
        // sun-bleached toward the top, grime pooling along the bottom rail
        return [
          0.25 + 0.7 * Math.max(0, e - 0.66) / 0.34 + 0.25 * clamp01((y - 0.07) / 0.3),
          0.4 + (ny > 0.4 ? 0.5 : 0) + 0.45 * clamp01((-0.05 - y) / 0.2),
          0.1,
        ];
      });
      return out;
    }, key, { castShadow: false });
  }

  /**
   * SHOPFRONT LETTERING. Exposed neon script over the board — a word, in real
   * letterforms, sized to the board rather than to a fixed 70 cm. The first pass
   * put eight fat blocks on at a scale capped near 1.0, which on a five-metre
   * fascia was a small coloured smudge in the middle of a blank panel.
   */
  for (const key of ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet']) {
    P(K, `fascia_letters_${key}`, () => {
      const parts = [];
      const n = 5 + (key.length % 3);
      neonWord(parts, n, 701 + key.length, 0.245, 0.019, 0, 0.06, 0.175);
      return combine(parts, 'letters');
    }, key, { castShadow: false, noShadow: true });
  }

  /* ---- projecting blade signs ---------------------------------------- */
  P(K, 'blade_bracket', () => {
    const parts = [];
    parts.push([box(0.06, 0.62, 0.06), newTrs(0, 0, 0.04)]);
    parts.push([tube([
      { x: 0, y: 0.52, z: 0.06 },
      { x: 0, y: 0.55, z: 0.42 },
      { x: 0, y: 0.52, z: 0.78 },
    ], 0.025, 5), null]);
    parts.push([tube([
      { x: 0, y: 0.04, z: 0.08 },
      { x: 0, y: 0.34, z: 0.52 },
    ], 0.018, 4), null]);
    // scroll finial, because a bracket that is a plain L reads as a bracket
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      const a = t * Math.PI * 1.6;
      parts.push([cyl(0.012, 0.012, 0.06, 4),
        newTrs(0, 0.55 + Math.sin(a) * 0.09 * (1 - t), 0.80 + Math.cos(a) * 0.09 * (1 - t), 0, 1, 1, 1, Math.PI / 2)]);
    }
    const g = combine(parts, 'bladebracket');
    weather(g, { grimeBase: 0.72, grimeHeight: 4.0, wear: 0.75, seed: 607 });
    return g;
  }, 'pole_dark');

  P(K, 'blade_panel', () => {
    const parts = [];
    parts.push([box(0.055, 0.78, 0.86), newTrs(0, -0.12, 0.42)]);
    parts.push([box(0.08, 0.05, 0.92), newTrs(0, 0.29, 0.42)]);
    parts.push([box(0.08, 0.05, 0.92), newTrs(0, -0.53, 0.42)]);
    const g = combine(parts, 'bladepanel');
    weather(g, { grimeBase: 0.65, grimeHeight: 4.0, wear: 0.8, seed: 613, up: 0.6 });
    return g;
  }, 'pole_dark');

  /**
   * The lit part of a blade sign is the LETTERING, not the board. A solid
   * emissive card the size of the panel is a blank coloured rectangle by day and
   * a blown slab by night — a critic logged exactly that, twice. So: a neon
   * border on both faces, over the dark panel.
   *
   * THE THREE ABSTRACT GLYPHS INSIDE THE BORDER ARE GONE, and their removal is
   * the point of this edit rather than a tidy-up. They were `glyphStrokes`
   * shapes — letter-like, deliberately meaningless — sitting exactly where the
   * word goes. `layout._frontage` now paints a REAL word out of `SIGN_WORDS.blade`
   * on both faces of this panel (HOTEL, LOANS, BARBER), and two sets of letters
   * in one 0.42 x 0.60 m field is not a blade sign, it is a smear.
   */
  for (const key of ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet']) {
    P(K, `blade_face_${key}`, () => {
      const parts = [];
      const R = 0.019;
      const mk = (pts, x) => parts.push([
        tube(pts.map(([u, v]) => ({ x, y: -0.12 + v, z: 0.42 + u })), R, 4), null,
      ]);
      for (const x of [-0.036, 0.036]) {
        mk([[-0.36, -0.32], [0.36, -0.32], [0.36, 0.32], [-0.36, 0.32], [-0.36, -0.32]], x);
      }
      return combine(parts, 'bladeface');
    }, key, { castShadow: false, noShadow: true });
  }

  /** A vertical projecting sign — the big one, three storeys of hotel neon. */
  P(K, 'blade_tall_frame', () => {
    const parts = [];
    parts.push([box(0.10, 3.6, 0.10), newTrs(-0.0, -3.6, 0.10)]);
    parts.push([box(0.10, 3.6, 0.10), newTrs(-0.0, -3.6, 1.05)]);
    for (let i = 0; i <= 6; i++) {
      parts.push([box(0.08, 0.06, 1.0), newTrs(0, -3.6 + i * 0.6, 0.575)]);
    }
    parts.push([box(0.14, 0.10, 1.16), newTrs(0, 0.0, 0.575)]);
    parts.push([tube([{ x: 0, y: -0.1, z: 0.05 }, { x: 0, y: -0.9, z: -0.55 }], 0.022, 4), null]);
    const g = combine(parts, 'bladetall');
    weather(g, { grimeBase: 0.7, grimeHeight: 6.0, wear: 0.8, seed: 617 });
    return g;
  }, 'rust');
}

/* ====================================================================== */
/* NEON — bent-tube letterforms and word shapes                           */
/* ====================================================================== */

/**
 * A NEON LETTERFORM, drawn in a cell 0.23 m wide by 0.37 m tall about its own
 * origin. Eight of them: not a real alphabet — a procedural city has no font —
 * but each has the stroke count and, crucially, the ASYMMETRY of a letter.
 *
 * That last word is the whole defect this replaces. The old vertical-sign shape
 * was a horizontal bar with a stem through its middle, which is a PLUS SIGN,
 * and the layout stacked five of them down a wall. Every daylight capture came
 * back with a column of five flat violet crosses on the building to the
 * camera's left, and three separate critics called it an unfinished placeholder.
 * Nothing in this kit may be left/right AND up/down symmetric.
 */
function glyphStrokes(k) {
  const w = 0.105;
  const h = 0.175;
  switch (((k % 8) + 8) % 8) {
    case 0: // H
      return [[[-w, -h], [-w, h]], [[w, -h], [w, h]], [[-w, 0.01], [w, 0.01]]];
    case 1: { // O
      const r = [];
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * TAU;
        r.push([Math.cos(a) * w, Math.sin(a) * h]);
      }
      return [r];
    }
    case 2: // T
      return [[[-w, h], [w, h]], [[0, h], [0, -h]]];
    case 3: // E
      return [
        [[-w, -h], [-w, h]], [[-w, h], [w * 0.85, h]],
        [[-w, 0.0], [w * 0.5, 0.0]], [[-w, -h], [w * 0.85, -h]],
      ];
    case 4: // L
      return [[[-w, h], [-w, -h]], [[-w, -h], [w * 0.9, -h]]];
    case 5: // A
      return [
        [[-w, -h], [0, h]], [[0, h], [w, -h]],
        [[-w * 0.55, -h * 0.15], [w * 0.55, -h * 0.15]],
      ];
    case 6: // R
      return [
        [[-w, -h], [-w, h]],
        [[-w, h], [w * 0.6, h * 0.72], [w * 0.62, h * 0.16], [-w, 0.0]],
        [[-w * 0.2, 0.0], [w, -h]],
      ];
    default: { // S
      const s = [];
      const pts = [
        [w, h * 0.72], [w * 0.2, h], [-w, h * 0.55], [w * 0.55, -h * 0.2],
        [w, -h * 0.62], [w * 0.1, -h], [-w * 0.95, -h * 0.6],
      ];
      for (const p of pts) s.push(p);
      return [s];
    }
  }
}

/** Lay `n` glyphs along +X, centred, at `pitch` metres. */
function neonWord(parts, n, seed, pitch = 0.255, R = 0.020, x0 = 0, y0 = 0, z0 = 0) {
  const span = (n - 1) * pitch;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(hash3i(seed, i, 7) * 8);
    const cx = x0 - span * 0.5 + i * pitch;
    for (const st of glyphStrokes(k)) {
      // 4 radial segments, not 5: a 19 mm tube seen from the street is a
      // stroke, and this geometry is multiplied by every shop unit in the city.
      parts.push([tube(st.map(([x, y]) => ({ x: cx + x, y: y0 + y, z: z0 })), R, 4), null]);
    }
  }
  return parts;
}

function neonShape(kind) {
  const parts = [];
  const R = 0.022;
  if (kind === 0) {
    // a cursive squiggle: three joined arcs
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push({ x: -0.62 + t * 1.24, y: Math.sin(t * Math.PI * 3.1) * 0.20, z: 0 });
    }
    parts.push([tube(pts, R, 5), null]);
    parts.push([tube([{ x: -0.68, y: -0.34, z: 0 }, { x: 0.68, y: -0.34, z: 0 }], R * 0.8, 5), null]);
  } else if (kind === 1) {
    // ring + crossbar
    const ring = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * TAU;
      ring.push({ x: Math.cos(a) * 0.36, y: Math.sin(a) * 0.36, z: 0 });
    }
    parts.push([tube(ring, R, 5), null]);
    parts.push([tube([{ x: -0.5, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }], R, 5), null]);
  } else if (kind === 2) {
    // a five-letter word on a rule
    neonWord(parts, 5, 1571, 0.255, R, 0, 0.09, 0);
    parts.push([tube([{ x: -0.66, y: -0.24, z: 0 }, { x: 0.66, y: -0.24, z: 0 }], R * 0.7, 5), null]);
  } else if (kind === 3) {
    // arrow
    parts.push([tube([{ x: -0.6, y: 0, z: 0 }, { x: 0.45, y: 0, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: 0.18, y: 0.30, z: 0 }, { x: 0.52, y: 0, z: 0 }, { x: 0.18, y: -0.30, z: 0 }], R, 5), null]);
  } else if (kind === 4) {
    // martini / diner glass
    parts.push([tube([{ x: -0.32, y: 0.32, z: 0 }, { x: 0, y: -0.06, z: 0 }, { x: 0.32, y: 0.32, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: -0.34, y: 0.32, z: 0 }, { x: 0.34, y: 0.32, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: 0, y: -0.06, z: 0 }, { x: 0, y: -0.42, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: -0.22, y: -0.44, z: 0 }, { x: 0.22, y: -0.44, z: 0 }], R, 5), null]);
  } else {
    // an outline rectangle with a diagonal — the "OPEN" box
    const w = 0.62;
    const h = 0.28;
    parts.push([tube([
      { x: -w, y: -h, z: 0 }, { x: w, y: -h, z: 0 }, { x: w, y: h, z: 0 },
      { x: -w, y: h, z: 0 }, { x: -w, y: -h, z: 0 },
    ], R, 5), null]);
    for (let i = 0; i < 4; i++) {
      parts.push([tube([
        { x: -0.46 + i * 0.31, y: -0.14, z: 0 },
        { x: -0.46 + i * 0.31, y: 0.14, z: 0 },
      ], R * 0.85, 5), null]);
    }
  }
  return combine(parts, 'neon');
}

export function registerNeon(K) {
  const keys = ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet'];
  for (let k = 0; k < 6; k++) {
    for (const key of keys) {
      P(K, `neon_${k}_${key}`, () => neonShape(k), key, { castShadow: false, noShadow: true });
    }
  }
  /**
   * THE VERTICAL SIGN — the three-storey hotel/theatre blade.
   *
   * ONE prototype for the whole sign, not five copies of a small one stacked at
   * a pitch shorter than their own height (which is what produced the column of
   * overlapping crosses). Letters read DOWN the blade, tubes duplicated on both
   * faces because a projecting sign is lit from either side of the street, and
   * a chase of lamp bulbs down each margin.
   *
   * Authored to fill `blade_tall_frame`: x within +/-0.30, y within +/-1.55, so
   * it is placed unscaled at the frame's mid-height.
   */
  for (const key of keys) {
    P(K, `neon_vert_${key}`, () => {
      const parts = [];
      const R = 0.026;
      for (const face of [-0.055, 0.055]) {
        for (let i = 0; i < 6; i++) {
          const y = 1.19 - i * 0.475;
          const k = Math.floor(hash3i(1913, i, key.length) * 8);
          for (const st of glyphStrokes(k)) {
            parts.push([tube(st.map(([x, yy]) => ({ x: x * 1.35, y: y + yy * 1.28, z: face })), R, 4), null]);
          }
        }
        // margin chase: the running bulbs down both edges
        for (let i = 0; i < 9; i++) {
          const y = -1.5 + i * 0.37;
          for (const s of [-1, 1]) {
            parts.push([lathe([[0, 0], [0.030, 0.012], [0.030, 0.030], [0, 0.042]], 6),
              newTrs(s * 0.255, y, face)]);
          }
        }
        // the rule under the word
        parts.push([tube([{ x: -0.20, y: -1.62, z: face }, { x: 0.20, y: -1.62, z: face }], R * 0.7, 5), null]);
      }
      return combine(parts, 'neonvert');
    }, key, { castShadow: false, noShadow: true });
  }

  /** The dark backing board every neon is actually mounted on. */
  P(K, 'neon_backer', () => {
    const g = chamferBox(1.5, 0.95, 0.09, 0.01);
    g.translate(0, -0.475, -0.05);
    weather(g, { grimeBase: 0.75, grimeHeight: 4.0, wear: 0.6, seed: 631, up: 0.6 });
    return g;
  }, 'pole_dark');
}

/* ====================================================================== */
/* AWNINGS, BOARDS, SHUTTERS                                              */
/* ====================================================================== */

export function registerCommerce(K) {
  /** Sloped canvas awning, unit width, with a real tube frame and a valance. */
  P(K, 'awning_frame', () => {
    // Only what survives being stretched across a shopfront: the wall plate and
    // the front bar. The rakers are `awning_rib`, placed unscaled at each end.
    const parts = [];
    parts.push([box(1.04, 0.045, 0.045), newTrs(0, -0.42, 1.10)]);
    parts.push([box(1.06, 0.05, 0.06), newTrs(0, 0.0, 0.02)]);
    const g = combine(parts, 'awnframe');
    weather(g, { grimeBase: 0.7, grimeHeight: 4.0, wear: 0.7, seed: 641 });
    return g;
  }, 'pole_dark');

  P(K, 'awning_rib', () => {
    const parts = [];
    parts.push([tube([
      { x: 0, y: 0.0, z: 0.02 },
      { x: 0, y: -0.26, z: 0.60 },
      { x: 0, y: -0.42, z: 1.10 },
    ], 0.022, 5), null]);
    parts.push([tube([{ x: 0, y: 0.0, z: 0.02 }, { x: 0, y: -0.42, z: 1.06 }], 0.016, 4), null]);
    const g = combine(parts, 'awnrib');
    weather(g, { grimeBase: 0.7, grimeHeight: 4.0, wear: 0.7, seed: 642 });
    return g;
  }, 'pole_dark');

  for (const key of ['awning_red', 'awning_green', 'awning_cream']) {
    P(K, `awning_canvas_${key}`, () => {
      // A sagging sheet: 5x3 grid drooping between the ribs, plus the valance.
      const a = new Accum('awncanvas');
      const g = new THREE.PlaneGeometry(1.02, 1.16, 6, 4);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const v = y / 1.16 + 0.5;
        const ripple = Math.sin(x * 11.0) * 0.012 * v;
        pos.setZ(i, pos.getZ(i) + ripple);
      }
      g.computeVertexNormals();
      // lay it on the slope
      const m = new THREE.Matrix4();
      m.makeRotationX(-Math.PI / 2 + 0.37);
      m.setPosition(0, -0.21, 0.56);
      a.add(g, m, null, [0.45, 0.4, 0.1]);
      g.dispose();
      // valance: a scalloped hanging edge
      const val = new THREE.PlaneGeometry(1.04, 0.26, 8, 1);
      const vp = val.getAttribute('position');
      for (let i = 0; i < vp.count; i++) {
        if (vp.getY(i) < 0) vp.setY(i, vp.getY(i) + Math.abs(Math.sin(vp.getX(i) * 12)) * 0.06);
        vp.setZ(i, vp.getZ(i) + Math.sin(vp.getX(i) * 9) * 0.014);
      }
      val.computeVertexNormals();
      const m2 = new THREE.Matrix4();
      m2.makeTranslation(0, -0.55, 1.10);
      a.add(val, m2, null, [0.6, 0.55, 0.15]);
      val.dispose();
      return a.build();
    }, key, { castShadow: true });
  }

  /** A rolled security shutter over a closed shopfront. */
  P(K, 'shutter_unit', () => {
    const parts = [];
    const g = new THREE.PlaneGeometry(1.0, 1.0, 1, 14);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, pos.getZ(i) + Math.sin(pos.getY(i) * 44) * 0.012);
    }
    g.computeVertexNormals();
    g.translate(0, 0.5, 0);
    parts.push([g, null]);
    parts.push([box(1.06, 0.16, 0.16), newTrs(0, 1.0, 0.02)]);
    parts.push([box(0.06, 1.02, 0.10), newTrs(-0.52, 0, 0)]);
    parts.push([box(0.06, 1.02, 0.10), newTrs(0.52, 0, 0)]);
    parts.push([box(1.0, 0.07, 0.06), newTrs(0, 0.0, 0)]);
    const out = combine(parts, 'shutter');
    weather(out, { grimeBase: 0.8, grimeHeight: 2.2, wear: 0.7, seed: 653, up: 0.4 });
    return out;
  }, 'corrugated');

  /** A wall-mounted, internally lit menu case. */
  P(K, 'menu_case', () => {
    const parts = [];
    parts.push([chamferBox(0.62, 0.86, 0.09, 0.01), newTrs(0, 0, 0.045)]);
    parts.push([box(0.68, 0.05, 0.12), newTrs(0, 0.88, 0.045)]);
    const g = combine(parts, 'menucase');
    weather(g, { grimeBase: 0.72, grimeHeight: 2.4, wear: 0.6, seed: 659, up: 0.5 });
    return g;
  }, 'pole_grey');
  P(K, 'menu_lit', () => {
    const g = card(0.52, 0.74);
    g.translate(0, 0.06, 0.095);
    return g;
  }, 'shop_lit', { castShadow: false, noShadow: true });

  /** A-board on the pavement. Leans, and never squarely to the kerb. */
  P(K, 'a_board', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const p = box(0.66, 0.92, 0.035);
      const m = newTrs(0, 0.06, s * 0.16, 0, 1, 1, 1, s * 0.20);
      parts.push([p, m]);
      parts.push([box(0.70, 0.05, 0.05), newTrs(0, 1.0, s * 0.26)]);
      parts.push([box(0.05, 0.98, 0.05), newTrs(-0.34, 0.05, s * 0.17, 0, 1, 1, 1, s * 0.20)]);
      parts.push([box(0.05, 0.98, 0.05), newTrs(0.34, 0.05, s * 0.17, 0, 1, 1, 1, s * 0.20)]);
    }
    parts.push([box(0.60, 0.03, 0.03), newTrs(0, 0.34, 0)]);
    const g = combine(parts, 'aboard');
    weather(g, { grimeBase: 0.72, grimeHeight: 0.9, wear: 0.85, seed: 661, up: 0.6 });
    return g;
  }, 'chalkboard');

  /** A roadside hoarding on two legs — the billboard family. */
  P(K, 'billboard_frame', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      parts.push([cyl(0.10, 0.13, 3.6, 8), newTrs(s * 1.7, 0, 0)]);
      parts.push([tube([{ x: s * 1.7, y: 1.2, z: 0 }, { x: s * 1.7, y: 2.6, z: 0.55 }], 0.05, 5), null]);
    }
    parts.push([box(5.4, 0.14, 0.14), newTrs(0, 3.5, 0)]);
    parts.push([box(5.4, 0.14, 0.14), newTrs(0, 5.6, 0)]);
    for (let i = 0; i < 5; i++) parts.push([box(0.10, 2.2, 0.10), newTrs(-2.2 + i * 1.1, 3.5, 0)]);
    parts.push([box(5.6, 0.10, 0.28), newTrs(0, 5.78, 0.20)]);
    const g = combine(parts, 'billboard');
    weather(g, { grimeBase: 0.75, grimeHeight: 3.5, wear: 0.8, seed: 673 });
    return g;
  }, 'rust');
  /**
   * A BILLBOARD IS A POSTER, NOT A COLOURED RECTANGLE. The paper ground is one
   * card; the artwork on top of it is a second surface, so the panel has a
   * composition — a block of image, a headline rule, a strapline — instead of
   * being 11 square metres of flat orange. Both are paper surfaces the kit
   * already carries, so this costs no new material.
   */
  P(K, 'billboard_face', () => {
    const a = new Accum('bbface');
    const m = new THREE.Matrix4();
    const g = new THREE.PlaneGeometry(5.3, 2.15, 6, 3);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      // paper never lies flat on a hoarding: it bubbles between the boards
      pos.setZ(i, pos.getZ(i) + Math.sin(pos.getX(i) * 2.3) * 0.012
        + Math.sin(pos.getY(i) * 5.1) * 0.008);
    }
    g.computeVertexNormals();
    m.makeTranslation(0, 3.55 + 1.075, 0.10);
    a.add(g, m, null, [0.7, 0.55, 0.15]);
    g.dispose();
    return a.build();
  }, 'poster_d', { castShadow: false });

  P(K, 'billboard_art', () => {
    const a = new Accum('bbart');
    const m = new THREE.Matrix4();
    const put = (x, y, w, h, mask) => {
      const g = new THREE.PlaneGeometry(w, h);
      m.setPosition(x, 3.55 + y, 0.115);
      a.add(g, m, null, mask);
      g.dispose();
    };
    // the image block, off to one side, and the type stacked beside it
    put(-1.62, 1.06, 1.86, 1.62, [0.35, 0.6, 0.2]);
    put(0.92, 1.62, 2.94, 0.40, [0.55, 0.5, 0.15]);
    let x = -0.50;
    for (let i = 0; i < 6 && x < 2.3; i++) {
      const h0 = hash3i(677, i, 3);
      const w = 0.24 + h0 * 0.52;
      put(x + w * 0.5, 1.02, w, 0.19, [0.5 + 0.4 * h0, 0.55, 0.15]);
      x += w + 0.12;
    }
    put(1.30, 0.44, 2.1, 0.13, [0.6, 0.6, 0.15]);
    return a.build();
  }, 'poster_a', { castShadow: false });

  /**
   * The floodlights wash the poster after dark; they do not turn it into a lamp.
   * Two narrow bands under the lighting bar, not the whole panel.
   */
  P(K, 'billboard_lit', () => {
    const a = new Accum('bblit');
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      const g = new THREE.PlaneGeometry(1.18, 1.55);
      m.setPosition(-1.98 + i * 1.32, 3.55 + 1.28, 0.125);
      a.add(g, m);
      g.dispose();
    }
    return a.build();
  }, 'shop_lit', { castShadow: false, noShadow: true, noPrepass: true });

  /** A lamp-column banner, two per column. */
  P(K, 'banner_pair', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.44, 1.30, 3, 3);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, pos.getZ(i) + Math.sin(pos.getY(i) * 4 + s) * 0.03);
      }
      g.computeVertexNormals();
      g.translate(s * 0.32, -0.72, 0);
      parts.push([g, null, [0.5, 0.5, 0.2]]);
    }
    parts.push([cyl(0.014, 0.014, 0.9, 5), newTrs(0, -0.06, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    parts.push([cyl(0.014, 0.014, 0.9, 5), newTrs(0, -1.4, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    return combine(parts, 'banner');
  }, 'poster_b', { castShadow: false });

  /**
   * A lit shop window after dark.
   *
   * NOT one plane. A single emissive rectangle the width of a shopfront is a
   * white slab with no shape in it, which is exactly how the first night
   * capture read. Real light comes through GLAZING: three panes with mullions
   * between them, a dark transom band at the top, and the bottom third eaten by
   * the stallriser. The gaps are what give the light a silhouette.
   */
  P(K, 'shop_glow', () => {
    const a = new Accum('shopglow');
    const m = new THREE.Matrix4();
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(0.28, 0.60);
      m.makeTranslation(-0.32 + i * 0.32, 0.12, 0);
      a.add(g, m);
      g.dispose();
      // a transom light over each pane
      const t = new THREE.PlaneGeometry(0.28, 0.10);
      m.makeTranslation(-0.32 + i * 0.32, 0.50, 0);
      a.add(t, m);
      t.dispose();
    }
    return signOff('glow') ? flatten(a.build()) : a.build();
  }, 'window_glow', { castShadow: false, noShadow: true, noPrepass: true });
}

/* ====================================================================== */
/* PAINT: posters, tags, ghost signs                                      */
/* ====================================================================== */

export function registerPaint(K) {
  /** A flyposting cluster: six overlapping sheets, torn and skewed. */
  for (const key of ['poster_a', 'poster_b', 'poster_c', 'poster_d']) {
    P(K, `poster_cluster_${key}`, () => {
      const a = new Accum('posters');
      for (let i = 0; i < 6; i++) {
        const h0 = hash3i(801, i, key.length);
        const h1 = hash3i(802, i, key.length);
        const h2 = hash3i(803, i, key.length);
        const w = 0.42 + h0 * 0.26;
        const h = 0.58 + h1 * 0.36;
        const g = new THREE.PlaneGeometry(w, h, 2, 2);
        const pos = g.getAttribute('position');
        for (let k = 0; k < pos.count; k++) {
          // a torn corner and a lifted edge
          pos.setZ(k, pos.getZ(k) + (Math.abs(pos.getX(k)) / w) * h2 * 0.03);
        }
        g.computeVertexNormals();
        const m = new THREE.Matrix4();
        m.makeRotationZ((h2 - 0.5) * 0.22);
        m.setPosition(-0.7 + h0 * 1.4, 0.4 + h1 * 0.9, 0.004 + i * 0.0022);
        a.add(g, m, null, [0.5 + 0.5 * h1, 0.35 + 0.6 * h0, 0.15]);
        g.dispose();
      }
      return a.build();
    }, key, { castShadow: false });
  }

  /** Aerosol tags — four alphabets' worth of stroke, four colourways. */
  for (let v = 0; v < 4; v++) {
    for (const key of ['tag_a', 'tag_b', 'tag_c', 'tag_d']) {
      P(K, `tag_${v}_${key}`, () => {
        const parts = [];
        const seed = 900 + v * 13 + key.length;
        const n = 4 + (v % 3);
        for (let i = 0; i < n; i++) {
          const h0 = hash3i(seed, i, 1);
          const h1 = hash3i(seed, i, 2);
          const h2 = hash3i(seed, i, 3);
          const x0 = -0.85 + (i / n) * 1.7;
          const pts = [
            { x: x0, y: -0.34 + h0 * 0.16, z: 0 },
            { x: x0 + 0.10 + h1 * 0.16, y: 0.10 + h1 * 0.30, z: 0 },
            { x: x0 + 0.34 * h2 - 0.05, y: 0.40 + h2 * 0.22, z: 0 },
          ];
          parts.push([stroke(pts, 0.036 + h0 * 0.024), null]);
          if (h1 > 0.5) {
            parts.push([stroke([
              { x: x0 - 0.08, y: 0.02, z: 0 },
              { x: x0 + 0.30, y: -0.06 + h2 * 0.2, z: 0 },
            ], 0.03), null]);
          }
        }
        // the underline flourish every tag has
        parts.push([stroke([
          { x: -0.95, y: -0.46, z: 0 }, { x: -0.1, y: -0.56, z: 0 },
          { x: 0.6, y: -0.42, z: 0 }, { x: 1.0, y: -0.52, z: 0 },
        ], 0.032), null]);
        const g = combine(parts, 'tag');
        weather(g, { grimeBase: 0.4, grimeHeight: 2.0, wear: 0.9, seed: 907 + v });
        return g;
      }, key, { castShadow: false, noShadow: true });
    }
  }

  /** Small stickers, for poles, cabinets and the back of every sign. */
  P(K, 'sticker_cluster', () => {
    const a = new Accum('stickers');
    for (let i = 0; i < 7; i++) {
      const h0 = hash3i(951, i, 1);
      const h1 = hash3i(951, i, 2);
      const g = new THREE.PlaneGeometry(0.07 + h0 * 0.07, 0.05 + h1 * 0.06);
      const m = new THREE.Matrix4();
      m.makeRotationZ((h1 - 0.5) * 0.9);
      m.setPosition((h0 - 0.5) * 0.11, 1.0 + h1 * 0.55, 0.055 + i * 0.0004);
      a.add(g, m, null, [0.8, 0.4, 0.1]);
      g.dispose();
    }
    return a.build();
  }, 'poster_c', { castShadow: false, noShadow: true });

  /**
   * A GHOST SIGN. Unit-square so the layout can stretch it across whatever
   * gable it found; the interior "lettering" is a second, brighter set of
   * blocks so it reads as a sign rather than as a stain.
   */
  P(K, 'ghost_field', () => {
    // 8x8 so the wear mask can eat the field back RAGGEDLY. A 3x3 quad faded
    // linearly to its edges and read as a clean tan rectangle taped to a wall.
    const g = new THREE.PlaneGeometry(1, 1, 8, 8);
    paint(g, (x, y) => {
      const e = Math.max(Math.abs(x), Math.abs(y)) * 2;
      const blotch = smoothNoise(x * 7.3 + 11.2, y * 6.1 - 4.4);
      const scour = smoothNoise(x * 2.1 - 3.7, y * 3.4 + 8.1);
      return [
        clamp01(0.30 + 0.75 * e * e + 0.55 * (blotch - 0.35) + 0.4 * (0.5 - y)),
        clamp01(0.45 + 0.5 * (0.5 - y) + 0.5 * (scour - 0.5)),
        0.1,
      ];
    });
    return g;
  }, 'ghost', { castShadow: false, noShadow: true });

  /**
   * `ghost_letters` WAS HERE AND IS GONE. It was a unit-square block of
   * abstract bars — a headline of paired rectangles over two rules of body
   * copy — stretched with the field, and it is what a critic read as a stain
   * rather than a sign. `layout` now paints REAL words on the gable out of
   * `SIGN_WORDS.ghost` at uniform scale, weathered by a noise field in the
   * sign's own space (see the GHOST SIGN block in `layout._lotDressing`).
   *
   * Deleting it rather than leaving it registered is deliberate: `proto`
   * builds eagerly, so a prototype nothing places is geometry the whole city
   * pays for and never draws.
   */
}

/* ====================================================================== */
/* STEEL CITY TYPE — the letterforms, the words, and the signs that carry  */
/* them.                                                                   */
/* ====================================================================== */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS GEOMETRY AND NOT A TEXTURE ATLAS.
 * ─────────────────────────────────────────────────────────────────────────────
 * The obvious way to put readable words on a city is to bake type into a canvas
 * atlas and sample it off a quad. It was rejected on two measurements, not on
 * taste:
 *
 *  1. TEXTURE BUDGET. One 1024 RGBA atlas with its mip chain is 5.33 MiB, and
 *     the city is currently 47 MiB OVER its 640 MiB soft cap. Stroke geometry
 *     costs zero: every ink below resolves onto the `metal_painted` bake that
 *     `pole_dark` already made resident, because `materials._bakeKey` does not
 *     include `tint` (see the LETTERING block in `palette.js`).
 *
 *  2. THE BATCHER CAN INSTANCE IT. A word is a PROTOTYPE keyed by its own
 *     string, so the fourteen `BUTLER STREET` blades in a tile are fourteen
 *     matrices against one geometry — where an atlas quad would have needed a
 *     per-instance UV rect, which `ProtoLibrary` has no channel for
 *     (`instanceColor` is spoken for by the weathering mask triple).
 *
 * What it costs is triangles: a capital is 3.4 stroke segments on average and a
 * segment is one quad, so `DECARLO BODY SHOP` is 118 triangles. That is a fifth
 * of the fascia board it sits on.
 *
 * THE FONT. A stroke grotesque on a unit em: baseline at y = 0, CAP HEIGHT at
 * y = 1, and x running 0..1 across the glyph's own advance. It is not a
 * typeface — there are no optical corrections and the joints are square — but
 * it is KERNED (per-glyph advances, not a monospace grid), which is the
 * difference between a sign you can read at 30 m and a row of blocks. Round
 * letters are polygons: an O at eight segments is a letter at street distance
 * and a circle is not worth twice that on every shopfront in the city.
 */

/** Sample an ellipse inscribed in the unit box, `n` segments, closed. */
function ell(n = 9, x0 = 0, y0 = 0, x1 = 1, y1 = 1) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const p = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU + Math.PI / 2;
    p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return p;
}

/**
 * The alphabet. `[advance, ...polylines]`, polyline points in the unit box.
 *
 * Advances are real width classes — I/J narrow, M/W wide, the rest around
 * 0.62 — because a monospace grid is what made the previous pass's "lettering"
 * read as a bar code. Descenders (the comma, the Q tail) go below y = 0 on
 * purpose; `buildTextGeo` measures the extremes rather than assuming [0, 1].
 */
const GLYPHS = {
  A: [0.66, [[0, 0], [0.5, 1], [1, 0]], [[0.17, 0.34], [0.83, 0.34]]],
  B: [0.64, [[0, 0], [0, 1], [0.68, 1], [0.95, 0.8], [0.7, 0.55], [0, 0.55]],
    [[0.7, 0.55], [1, 0.3], [0.74, 0], [0, 0]]],
  C: [0.64, [[1, 0.78], [0.72, 0.98], [0.26, 1], [0.02, 0.72], [0, 0.28], [0.24, 0.02],
    [0.7, 0], [1, 0.22]]],
  D: [0.65, [[0, 0], [0, 1], [0.55, 1], [0.93, 0.72], [0.93, 0.28], [0.55, 0], [0, 0]]],
  E: [0.58, [[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.52], [0.8, 0.52]]],
  F: [0.55, [[1, 1], [0, 1], [0, 0]], [[0, 0.54], [0.78, 0.54]]],
  G: [0.68, [[1, 0.78], [0.72, 0.98], [0.26, 1], [0.02, 0.72], [0, 0.28], [0.24, 0.02],
    [0.72, 0], [1, 0.24], [1, 0.46], [0.56, 0.46]]],
  H: [0.66, [[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.52], [1, 0.52]]],
  I: [0.22, [[0.5, 0], [0.5, 1]]],
  J: [0.50, [[0.9, 1], [0.9, 0.26], [0.66, 0.02], [0.26, 0], [0, 0.22]]],
  K: [0.63, [[0, 0], [0, 1]], [[0.98, 1], [0.04, 0.44]], [[0.3, 0.6], [1, 0]]],
  L: [0.53, [[0, 1], [0, 0], [0.94, 0]]],
  M: [0.82, [[0, 0], [0, 1], [0.5, 0.32], [1, 1], [1, 0]]],
  N: [0.68, [[0, 0], [0, 1], [1, 0], [1, 1]]],
  O: [0.72, ell(9)],
  P: [0.60, [[0, 0], [0, 1], [0.7, 1], [0.97, 0.77], [0.7, 0.52], [0, 0.52]]],
  Q: [0.74, ell(9), [[0.58, 0.24], [1, -0.1]]],
  R: [0.63, [[0, 0], [0, 1], [0.7, 1], [0.97, 0.77], [0.7, 0.52], [0, 0.52]],
    [[0.5, 0.52], [1, 0]]],
  S: [0.61, [[0.98, 0.8], [0.7, 1], [0.22, 0.98], [0.02, 0.76], [0.24, 0.57], [0.76, 0.45],
    [0.98, 0.24], [0.76, 0.02], [0.26, 0], [0, 0.18]]],
  T: [0.60, [[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [0.66, [[0, 1], [0, 0.26], [0.26, 0], [0.74, 0], [1, 0.26], [1, 1]]],
  V: [0.64, [[0, 1], [0.5, 0], [1, 1]]],
  W: [0.90, [[0, 1], [0.24, 0], [0.5, 0.6], [0.76, 0], [1, 1]]],
  X: [0.64, [[0, 0], [1, 1]], [[0, 1], [1, 0]]],
  Y: [0.62, [[0, 1], [0.5, 0.52], [1, 1]], [[0.5, 0.52], [0.5, 0]]],
  Z: [0.60, [[0, 1], [1, 1], [0, 0], [1, 0]]],
  0: [0.66, ell(9), [[0.16, 0.22], [0.84, 0.78]]],
  1: [0.40, [[0.1, 0.78], [0.52, 1], [0.52, 0]], [[0.06, 0], [0.98, 0]]],
  2: [0.60, [[0, 0.78], [0.28, 1], [0.72, 1], [0.98, 0.76], [0.82, 0.5], [0, 0], [1, 0]]],
  3: [0.60, [[0, 0.9], [0.34, 1], [0.8, 0.94], [0.95, 0.74], [0.56, 0.55], [0.95, 0.34],
    [0.8, 0.06], [0.3, 0], [0, 0.12]]],
  4: [0.62, [[0.74, 0], [0.74, 1], [0, 0.3], [1, 0.3]]],
  5: [0.60, [[1, 1], [0.12, 1], [0.04, 0.56], [0.5, 0.62], [0.9, 0.48], [0.96, 0.22],
    [0.6, 0], [0.14, 0.06]]],
  6: [0.62, [[0.9, 0.9], [0.5, 1], [0.1, 0.72], [0.04, 0.3], [0.34, 0], [0.7, 0],
    [0.96, 0.24], [0.7, 0.5], [0.26, 0.5], [0.06, 0.34]]],
  7: [0.56, [[0, 1], [1, 1], [0.34, 0]]],
  8: [0.64, ell(8, 0.06, 0.52, 0.94, 1), ell(8, 0, 0, 1, 0.54)],
  9: [0.62, [[0.1, 0.1], [0.5, 0], [0.9, 0.28], [0.96, 0.7], [0.66, 1], [0.3, 1],
    [0.04, 0.76], [0.3, 0.5], [0.74, 0.5], [0.94, 0.66]]],
  '&': [0.72, [[1, 0], [0.2, 0.72], [0.2, 0.9], [0.42, 1], [0.62, 0.9], [0.6, 0.72],
    [0.02, 0.3], [0.06, 0.08], [0.36, 0], [0.7, 0.16], [0.9, 0.44]]],
  '.': [0.28, [[0.42, 0.05], [0.58, 0.05]]],
  ',': [0.28, [[0.56, 0.1], [0.36, -0.16]]],
  "'": [0.22, [[0.5, 1], [0.4, 0.68]]],
  '-': [0.46, [[0.08, 0.5], [0.92, 0.5]]],
  '/': [0.48, [[0, 0], [1, 1]]],
  ':': [0.26, [[0.42, 0.06], [0.58, 0.06]], [[0.42, 0.62], [0.58, 0.62]]],
  '!': [0.26, [[0.5, 1], [0.5, 0.3]], [[0.42, 0.05], [0.58, 0.05]]],
  // The interpunct is this city's own separator — GREASE FM 98.3 . ALL NIGHT.
  '·': [0.36, [[0.4, 0.5], [0.6, 0.5]]],
  ' ': [0.34],
};

/** Letter-space, in em. Deliberately loose: a painted sign is not a book. */
const TRACKING = 0.13;
/** Line leading, in em, measured baseline to baseline. */
const LEADING = 1.42;

/** Advance width of one string in em, tracking included, no trailing space. */
export function textWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]] ?? GLYPHS[' '];
    w += g[0] + TRACKING;
  }
  return Math.max(0.001, w - TRACKING);
}

/**
 * One stroke segment as a quad in the XY plane, facing +Z.
 *
 * The ends are EXTENDED by the half-weight rather than butted, which squares
 * off the cap and — the reason it is done this way — closes the notch at every
 * polyline joint without a round join and its extra triangles. On a 0.17 em
 * stroke the overshoot is 1.5 % of a cap height and invisible; the notch was
 * not.
 */
function strokeQuad(out, ax, ay, bx, by, h, z) {
  let dx = bx - ax;
  let dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const ex = dx * h;
  const ey = dy * h;
  const nx = -dy * h;
  const ny = dx * h;
  const base = out.n;
  out.p.push(
    ax - ex + nx, ay - ey + ny, z,
    bx + ex + nx, by + ey + ny, z,
    bx + ex - nx, by + ey - ny, z,
    ax - ex - nx, ay - ey - ny, z
  );
  for (let i = 0; i < 4; i++) out.nrm.push(0, 0, 1);
  out.uv.push(0, 1, 1, 1, 1, 0, 0, 0);
  out.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
  out.n += 4;
}

/**
 * Build one or more lines of type as a single geometry.
 *
 * The result is in EM UNITS about its own centre — cap height 1, width
 * whatever the string needs — and the caller scales it UNIFORMLY to the board
 * it is painting on. That is the whole reason this returns its metrics: the
 * fascia board is stretched to its shop's frontage and a word that rode that
 * stretch would be a 25 cm slab on a wide shop and a smudge on a narrow one,
 * which is the defect the `fascia_letters` comment already documents. Type
 * never rides a non-uniform scale.
 *
 * `opts.weight` is the stroke half-width in em (default 0.085 → a 0.17 em
 * stroke, which is a bold grotesque and the weight a painted sign is cut at).
 * `opts.wear(x, y, line)` returns the mask triple per vertex; that is where
 * weathering and the eaten-back edges of a ghost sign come from.
 */
export function buildTextGeo(lines, opts = {}) {
  const h = opts.weight ?? 0.085;
  const z = opts.z ?? 0;
  const rows = Array.isArray(lines) ? lines : [lines];
  const lead = opts.leading ?? LEADING;
  const out = { p: [], nrm: [], uv: [], i: [], n: 0 };
  let maxW = 0;
  for (const r of rows) maxW = Math.max(maxW, textWidth(r));
  // Baselines run DOWN from the top line; the block is then centred on the
  // full inked height, caps included, so a one-line and a two-line sign hang
  // from the same anchor.
  const blockH = (rows.length - 1) * lead + 1;
  const y0 = blockH / 2 - 1;

  for (let r = 0; r < rows.length; r++) {
    const s = rows[r];
    const lineW = textWidth(s);
    let x = -lineW / 2;
    const by = y0 - r * lead;
    for (let i = 0; i < s.length; i++) {
      const g = GLYPHS[s[i]] ?? GLYPHS[' '];
      const gw = g[0];
      for (let k = 1; k < g.length; k++) {
        const poly = g[k];
        for (let j = 0; j + 1 < poly.length; j++) {
          strokeQuad(out,
            x + poly[j][0] * gw, by + poly[j][1],
            x + poly[j + 1][0] * gw, by + poly[j + 1][1], h, z);
        }
      }
      x += gw + TRACKING;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  geo.setIndex(out.i);
  const wear = opts.wear;
  if (wear) paint(geo, (x, y) => wear(x, y, maxW, blockH));
  else {
    // The default ageing of painted lettering: it bleaches from the TOP (that
    // is where the sun and the rain get at it) and grime collects in the
    // bottom of every stroke. Both are per-vertex, so one glyph is never the
    // same as the one beside it.
    paint(geo, (x, y) => {
      const n = smoothNoise(x * 4.3 + 17.1, y * 5.7 - 3.3);
      const up = clamp01((y + blockH / 2) / Math.max(0.6, blockH));
      return [clamp01(0.35 + 0.5 * up + 0.45 * (n - 0.5)),
        clamp01(0.4 + 0.45 * (1 - up) + 0.3 * (n - 0.5)), 0.25];
    });
  }
  return { geo, w: maxW, h: blockH };
}

/** A filesystem-safe, collision-free key for a string. */
function slug(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Register (once) the prototype for one piece of type, and return its id.
 *
 * LAZY ON PURPOSE. `ProtoLibrary.proto` builds eagerly, so registering the
 * whole vocabulary up front would build several hundred geometries whether the
 * camera ever stood in front of them or not — and the STREET names are not
 * even knowable up front, they come out of `world.streetAt`. Registering on
 * first use means a tile pays for the words it actually says, once, for the
 * lifetime of the library.
 *
 * The metrics ride on the proto record, not in a module-level map, so they die
 * with `ProtoLibrary.dispose()` instead of outliving it and handing the next
 * city a width for a geometry that has been freed.
 */
export function signTextProto(K, lines, surface, opts = {}) {
  const rows = Array.isArray(lines) ? lines : [lines];
  /**
   * THE ID CARRIES EVERY INPUT THAT CHANGES THE GEOMETRY. `weight`, `leading`
   * and a caller-supplied `wear` all do; if they are not in the key, the
   * second caller asking for the same words at a different stroke weight
   * silently gets the FIRST caller's geometry. That is the classic shared-
   * cache bug and it stays invisible until a ghost sign comes back crisp.
   */
  const id = `sgn_${slug(rows.join('\u001f') + '|' + (opts.key ?? '')
    + '|' + (opts.weight ?? '') + '|' + (opts.leading ?? '')
    + '|' + (opts.wear ? 'w' : ''))}_${surface}`;
  const known = K.get?.(id);
  if (known) return id;
  const built = buildTextGeo(rows, opts);
  P(K, id, () => built.geo, surface, {
    castShadow: false,
    noShadow: true,
    ...(opts.proto ?? {}),
  });
  const rec = K.get?.(id);
  if (rec) rec.owText = { w: built.w, h: built.h, text: rows.join(' ') };
  return id;
}

/** Metrics of a registered piece of type: `{ w, h, text }` in em, or null. */
export function textMeta(K, id) {
  return K.get?.(id)?.owText ?? null;
}

/**
 * The uniform scale that fits a registered word into a `fw` x `fh` field, with
 * a margin. Returns 0 when the word cannot be made to fit legibly — the caller
 * then draws NO sign, which is the right answer: an unreadable sign is the
 * defect, not the absence of one.
 */
export function fitScale(K, id, fw, fh, margin = 0.88) {
  const m = textMeta(K, id);
  if (!m) return 0;
  const s = Math.min((fw * margin) / m.w, (fh * margin) / m.h);
  return s < 0.035 ? 0 : s;
}

/* ---------------------------------------------------------------------- */
/* THE VOCABULARY                                                          */
/* ---------------------------------------------------------------------- */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY WORD THIS CITY SAYS. STEEL CITY ORIGINALS, NO EXCEPTIONS.
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN.md is the content bible and it is the source for every authored name
 * below: the shops and safehouses (DeCarlo Body Shop, Rustbelt Respray, Foundry
 * Supply, Primo's Sandwich, Incline Diner, Row Hardware), the six radio
 * stations (GREASE FM, BLACK & GOLD, REDLINE, SLACKWATER, FURNACE 101, INCLINE
 * AM), the vehicle marques (Peregrine, Ironside, Riverjack, Slagbolt, Millhand,
 * Foundry Van) and the rivals (Duke Marrow, the Harbormaster, Viper Lane).
 *
 * Everything else is an ORIGINAL COINAGE in the same register — rustbelt trade
 * names built out of the industry's own vocabulary: slag, coke, ladle, tipple,
 * hearth, bessemer, tap, ingot, wharf. `signprobe.mjs` holds a denylist of real
 * marks and fails on any of them, and it fails on a NEGATIVE CONTROL too, so
 * the check is known to be able to fail.
 *
 * A NAME THAT SOUNDS REAL IS THE POINT AND IS ALSO THE TRAP. "IRON CITY" is a
 * real beer; "FURNACE 101" is ours and is in DESIGN.md. When in doubt, coin
 * from the process rather than from memory.
 */
export const SIGN_WORDS = {
  /** Named businesses, by the district character they belong to. */
  core: ['MERCANTILE TRUST', 'GOLDEN TRIANGLE LOAN', 'STANWIX OPTICAL', 'THE POINT ARCADE',
    'ALLEGHENY OUTFITTERS', 'BLACK & GOLD RADIO', 'TRIANGLE HABERDASHER', 'OLIVER & SONS',
    'CENTRE CAMERA', 'SMITHFIELD SHOES', 'DUQUESNE DRUG CO', 'THE STEEL TOWER GRILL'],
  market: ['LADLE & SPOON', 'PIG IRON PIZZA', 'STRIP MARKET PRODUCE', 'MON WHARF FISH',
    'COKE OVEN COFFEE', 'MARROW BROS MEATS', 'TERMINAL WAY GROCER', 'HEARTH BAKERY',
    'RAILROAD ST SPICE', 'THE TIPPLE TAVERN', 'PENN AVE OLIVES', 'SLAG RING BAKERY'],
  row: ['BUTLER ST BARBER', 'THE OPEN HEARTH', 'FORTIETH ST LAUNDRY', 'RIVET & RIB',
    'CHARLOTTE ST BOOKS', 'DOYLE HARDWARE', 'SLACKWATER LOUNGE', 'HOLMES ST DINER',
    'KEYSTONE SHOE REPAIR', 'BERLIN WAY RECORDS', 'THE LADLE ROOM', 'FISK ST FLORIST'],
  mill: ['MILL GATE SUPPLY', 'INGOT WELDING', 'STEEL ROW SALVAGE', 'TAPHOLE TOOL',
    'SLAGMASTER OIL', 'FOUNDRY CANTEEN', 'SCRAP & SPAR', 'HAZELWOOD AXLE',
    'BLAST LANE MOTORS', 'ORE DOCK DINER'],
  hill: ['GRANDVIEW GROCER', 'INCLINE HARDWARE', 'BOGGS AVE BAKERY', 'THE OVERLOOK CAFE',
    'SHILOH ST SHOES', 'MERRIMAC LAUNDRY', 'HILLTOP BARBER'],
  civic: ['SHORE LOFT REALTY', 'FEDERAL ST DINER', 'NORTH SIDE PRINT', 'STEEL BOWL TICKETS',
    'ANDERSON ST CAFE', 'RIVERSIDE SPORTING'],
  park: ['POINT MARINA STORES', 'FOUNTAIN CAFE', 'PORTAGE PATH KIOSK'],

  /** What a projecting blade says: one word, read from a moving car. */
  blade: ['HOTEL', 'DINER', 'BAR', 'LOANS', 'SHOES', 'BARBER', 'DRUGS', 'PIZZA',
    'TAVERN', 'BOOKS', 'CAFE', 'GRILL', 'PAWN', 'BAKERY', 'RECORDS', 'TOOLS',
    'PARTS', 'LAUNDRY', 'BEER'],

  /** Neon: short, because a tube is bent by hand and every letter costs. */
  neon: ['OPEN', 'BAR', 'COLD BEER', 'DINER', 'EATS', 'HOTEL', 'PIE', 'GRILL',
    'LOUNGE', 'ALE', 'CHOP SUEY', 'BOWL'],

  /**
   * ROOFTOP AND ROADSIDE HOARDINGS. Period painted-board advertising for Steel
   * City products — the radio stations and the marques out of DESIGN.md, plus
   * the motor oil and coffee a rustbelt city sold itself.
   */
  billboard: [
    ['SLAGMASTER', 'MOTOR OIL'],
    ['GREASE FM', 'GARAGE ROCK 98.3'],
    ['FURNACE 101', 'THE MILL NEVER SLEEPS'],
    ['BLACK & GOLD', 'SOUL ALL NIGHT'],
    ['REDLINE 104.7', 'DRIVE IT HARDER'],
    ['SLACKWATER 90.1', 'EASY ON THE RIVER'],
    ['INCLINE AM', 'OLD COUNTRY 1250'],
    ['COKE OVEN', 'COFFEE'],
    ['PEREGRINE GT', 'THE WEDGE'],
    ['IRONSIDE 440', 'ALL THE TORQUE'],
    ['SLAGBOLT', 'MOTORCYCLES'],
    ['MILLHAND SIX', 'TRUCKS THAT WORK'],
    ['RIVERJACK', 'OUTBOARD BOATS'],
    ['DECARLO BODY SHOP', 'DENTS OUT BY FRIDAY'],
    ['THREE RIVERS', 'SAVINGS & LOAN'],
    ['HEARTH BRAND', 'FLOUR'],
  ],

  /**
   * GHOST SIGNS. Half-century-old painted wall adverts — the single most
   * Pittsburgh texture there is. These are companies that CLOSED: the register
   * is pre-war wholesale, and the third line is the giveaway ("WHOLESALE ONLY",
   * a phone exchange, a street number).
   */
  ghost: [
    ['BESSEMER BROS', 'WHOLESALE', 'DRY GOODS'],
    ['MON VALLEY', 'COAL & COKE'],
    ['HEARTH BRAND', 'FLOUR', 'BEST BY TEST'],
    ['RIVERTON', 'MILLING CO'],
    ['STEEL CITY', 'DRY GOODS'],
    ['ALLEGHENY', 'ICE & COAL'],
    ['TAPHOLE', 'FIRE BRICK'],
    ['DUQUESNE WORKS', 'No 4'],
    ['SLAG RING', 'FOUNDRY CO'],
    ['WHARF ST', 'STORAGE', 'BONDED'],
    ['LADLE & CO', 'IRON MERCHANTS'],
    ['KEYSTONE', 'AWNING WORKS'],
  ],
};

/** Which vocabulary a district's `kind` (see `DISTRICT_STYLE`) draws from. */
export function shopWords(kind) {
  return SIGN_WORDS[kind] ?? SIGN_WORDS.row;
}

/**
 * LAMP-COLUMN BANNERS, by district id.
 *
 * A civic banner exists to name the neighbourhood it hangs in, so this is
 * keyed by `world.districtAt`'s id rather than by the `kind` the shop names
 * use — a banner that says THE STRIP on Butler Street is worse than a blank
 * one. Two lines, and every word is kept short on purpose: the sheet is
 * 0.44 m wide, and MEASURED through `fitScale`, a nine-letter line comes out
 * under a 45 mm cap and `_type` refuses to draw it at all.
 */
export const BANNER_WORDS = {
  point: ['THE', 'POINT'],
  downtown: ['GOLDEN', 'TRIANGLE'],
  strip: ['THE', 'STRIP'],
  lawren: ['BUTLER', 'STREET'],
  northsh: ['NORTH', 'SHORE'],
  troy: ['TROY', 'HILL'],
  southside: ['SOUTH', 'SIDE'],
  mtwash: ['GRAND', 'VIEW'],
  steelrow: ['STEEL', 'ROW'],
  westend: ['WEST', 'END'],
  northside: ['NORTH', 'SIDE'],
  hazel: ['HAZEL', 'WOOD'],
};

/**
 * THE INK A DISTRICT WRITES IN, and it is an ERA rather than a taste.
 *
 * `gilt` is gold leaf burnished onto the inside of shop glass — a downtown
 * trade that survives on the professions and dies out two streets from the
 * Triangle. `box` is the post-war internally-lit plastic fascia, which is what
 * the arterials and the market street re-fronted with. `painted` is the sign
 * writer's board and is what everywhere else still has, because nobody spent
 * the money.
 */
const DISTRICT_INK = {
  core: ['gilt', 'box', 'gilt', 'painted'],
  market: ['box', 'painted', 'box', 'painted'],
  row: ['painted', 'painted', 'box', 'painted'],
  mill: ['painted', 'painted', 'painted', 'box'],
  hill: ['painted', 'painted', 'painted', 'gilt'],
  civic: ['box', 'painted', 'box', 'painted'],
  park: ['painted', 'gilt'],
};

/**
 * Resolve an ink to the surface that carries it, given the board underneath.
 *
 * CONTRAST IS THE ONLY RULE. Black type on a navy board is an unreadable sign,
 * which is a worse defect than no sign — so this reads the panel the layout
 * already chose and picks the ink that survives against it.
 */
export function inkSurface(ink, panelKey) {
  if (ink === 'gilt') return 'sign_gilt';
  if (ink === 'box') return 'shop_lit';
  const dark = panelKey === 'panel_navy' || panelKey === 'panel_maroon'
    || panelKey === 'panel_forest';
  return dark ? 'sign_pale' : 'sign_ink';
}

/** Ink for a district kind, deterministic in the mount's own seed. */
export function pickInk(kind, u) {
  const list = DISTRICT_INK[kind] ?? DISTRICT_INK.row;
  return list[Math.floor(u * list.length) % list.length];
}

/**
 * STREET-BLADE ABBREVIATION.
 *
 * `world.streetAt` speaks the real vocabulary — "Boulevard of the Allies",
 * "General Robinson Street" — and a 1.05 m blade at a legible cap height holds
 * about twelve characters. Cities solved this a century ago by abbreviating
 * the type and dropping the article, so this does the same rather than
 * shrinking the type until nobody can read it.
 */
const STREET_ABBREV = [
  [/\bBoulevard\b/g, 'BLVD'], [/\bAvenue\b/g, 'AVE'], [/\bStreet\b/g, 'ST'],
  [/\bDrive\b/g, 'DR'], [/\bPlace\b/g, 'PL'], [/\bTerrace\b/g, 'TER'],
  [/\bParkway\b/g, 'PKWY'], [/\bBridge\b/g, 'BR'], [/\bLane\b/g, 'LN'],
  [/\bRoad\b/g, 'RD'], [/\bCourt\b/g, 'CT'], [/\bSquare\b/g, 'SQ'],
  [/\bHighway\b/g, 'HWY'], [/\bof the\b/g, ''], [/\bWalk\b/g, 'WALK'],
];

export function streetPlateText(name) {
  if (!name) return null;
  let s = String(name);
  for (const [re, to] of STREET_ABBREV) s = s.replace(re, to);
  s = s.toUpperCase().replace(/\s+/g, ' ').trim();
  // Anything still over the blade's capacity loses its last word rather than
  // its legibility. "TWENTY-SECOND ST" is a street name; 4 mm type is not.
  while (textWidth(s) > 9.4 && s.includes(' ')) s = s.slice(0, s.lastIndexOf(' '));
  return s.length ? s : null;
}

/* ---------------------------------------------------------------------- */
/* NEON WORDS — the readable half of the neon family                       */
/* ---------------------------------------------------------------------- */

/**
 * A word in bent tube.
 *
 * This is the same font, swept as a 22 mm tube instead of stroked as a quad,
 * because that is physically what the difference between a painted sign and a
 * neon sign IS — and at four radial segments the round cross-section is what
 * gives the letter its specular line and its bloom footprint. It is also eight
 * times the triangles of the painted form, which is why neon words are capped
 * at ten characters and why `SIGN_WORDS.neon` is a list of short ones.
 *
 * DEAD TUBES. A deterministic fraction of the strokes are pulled OUT of the
 * emissive geometry and returned separately, to be drawn in cold glass. Every
 * neon street in the world has a letter out; a wall of perfect signs is the
 * thing that reads as a kit. This is a STATIC failure per word, not an animated
 * flicker — `props._driveLights` drives intensity per MATERIAL off the sun
 * altitude and there is one material per colour, so a per-sign animation would
 * have to live in a subsystem this file does not own.
 */
function neonTubeWord(text, seed, opts = {}) {
  const R = opts.r ?? 0.021;
  const lit = [];
  const dead = [];
  const w = textWidth(text);
  let x = -w / 2;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]] ?? GLYPHS[' '];
    const gw = g[0];
    for (let s = 1; s < g.length; s++) {
      const poly = g[s].map(([px, py]) => ({ x: x + px * gw, y: py - 0.5, z: 0 }));
      if (poly.length < 2) continue;
      const t = tube(poly, R, 4);
      // ~7% of strokes are out. Keyed on the WORD's seed and the stroke index,
      // so the same sign is dark in the same place every time it streams in.
      (hash3i(seed, k, 3) < 0.07 ? dead : lit).push([t, null]);
      k++;
    }
    x += gw + TRACKING;
  }
  return {
    lit: lit.length ? combine(lit, 'neonword') : null,
    dead: dead.length ? combine(dead, 'neondead') : null,
    w,
  };
}

/**
 * Register a neon word and return `{ id, dead, halo, w }` — up to three
 * prototypes, any of which may be null.
 *
 * The halo is a single card behind the word, its mask ramped to zero at the
 * rim so the additive surface has no edge (see `neon_halo_warm` in
 * `palette.js`). It is a QUARTER the word's own footprint in draw terms
 * because the whole family shares one surface per temperature.
 */
export function neonWordProto(K, text, key, opts = {}) {
  const seed = (slug(text).charCodeAt(0) * 2654435761) >>> 0;
  const idBase = `nw_${slug(text)}`;
  const id = `${idBase}_${key}`;
  const deadId = `${idBase}_dead`;
  const warm = key === 'neon_amber' || key === 'neon_red';
  const haloSurface = warm ? 'neon_halo_warm' : 'neon_halo_cool';
  const haloId = `${idBase}_halo_${warm ? 'w' : 'c'}`;
  let w = textMeta(K, id)?.w ?? 0;
  if (!K.has?.(id)) {
    const built = neonTubeWord(text, seed, opts);
    w = built.w;
    if (built.lit) {
      if (signOff('neon')) flatten(built.lit);
      /**
       * `noPrepass`, and it costs the sign nothing it had.
       *
       * A neon word is an UNLIT emitter: it takes no shadow, no AO and no
       * shading of any kind, and it never moves — the tubes are welded to a
       * facade. The depth/normal/velocity prepass exists to give moving, shaded
       * surfaces their motion vectors and their occlusion, and for static
       * unlit geometry the camera-only velocity TAA falls back to is not an
       * approximation, it is the same answer. So the prepass was drawing eight
       * times the triangles of the painted form of the same word for a result
       * nothing reads. The dead tubes go with them for the same reason and the
       * additive halo already had the flag (see `batch.js`).
       */
      P(K, id, () => built.lit, key,
        { castShadow: false, noShadow: true, noPrepass: true });
      const rec = K.get?.(id);
      if (rec) rec.owText = { w: built.w, h: 1, text };
    }
    if (built.dead && !K.has?.(deadId)) {
      P(K, deadId, () => built.dead, 'glass_prop',
        { castShadow: false, noShadow: true, noPrepass: true });
    } else if (built.dead) {
      built.dead.dispose();
    }
  }
  if (!K.has?.(haloId)) {
    const g = new THREE.PlaneGeometry(w + 0.5, 1.9, 5, 3);
    paint(g, (x, y) => {
      const e = Math.max(Math.abs(x) / ((w + 0.5) / 2), Math.abs(y) / 0.95);
      const f = clamp01(1 - e);
      const s = f * f * (3 - 2 * f);
      return [s, s, s];
    });
    if (signOff('halo')) flatten(g);
    P(K, haloId, () => g, haloSurface,
      { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 3 });
  }
  return { id: K.has?.(id) ? id : null, dead: K.has?.(deadId) ? deadId : null, halo: haloId, w };
}

/* ---------------------------------------------------------------------- */
/* THE SIGNS THE TYPE GOES ON                                              */
/* ---------------------------------------------------------------------- */

export function registerSignText(K) {
  /**
   * THE ROOFTOP HOARDING. A billboard on a roof deck is not the roadside one
   * on two legs: it stands on a raked steel A-frame with its back legs on the
   * deck behind it, and it is the silhouette that reads from three streets
   * away, so the frame is authored and only the face is scaled.
   *
   * Unit width about the origin, standing UP from y = 0 — matching the
   * 'billboard' mount kind in `tile.js`'s contract, where `h` is HEADROOM
   * above the deck rather than a centred half-height.
   */
  /**
   * EVERY MEMBER IS A BOX, INCLUDING THE RAKED STAY. This prototype is the one
   * in the kit that is scaled to thirteen metres in x and four in y, and a
   * round section cannot survive that — a 48 mm tube stretched thirteen times
   * reads as a flat ribbon, which is the trap `fascia_board` documents. The
   * stay is therefore a rotated box: it distorts into a parallelogram section
   * under the same scale, which is what a rolled steel angle looks like anyway.
   */
  P(K, 'roof_board_frame', () => {
    const parts = [];
    const rake = Math.atan2(0.75, 0.66);
    for (const s of [-1, 1]) {
      // front post, raked back stay, and the foot each stands on
      parts.push([box(0.16, 1.0, 0.16), newTrs(s * 0.46, 0.5, 0)]);
      parts.push([box(0.10, 1.0, 0.10),
        newTrs(s * 0.46, 0.63, -0.375, 0, 1, 1, 1, rake)]);
      parts.push([box(0.30, 0.10, 0.30), newTrs(s * 0.46, 0.05, -0.75)]);
    }
    parts.push([box(1.04, 0.09, 0.10), newTrs(0, 0.99, 0)]);
    parts.push([box(1.04, 0.09, 0.10), newTrs(0, 0.36, 0)]);
    for (let i = 0; i < 4; i++) {
      parts.push([box(0.07, 0.66, 0.07), newTrs(-0.33 + i * 0.22, 0.67, 0)]);
    }
    // the lighting bar over the top
    parts.push([box(1.06, 0.07, 0.20), newTrs(0, 1.06, 0.13)]);
    const g = combine(parts, 'roofboard');
    weather(g, { grimeBase: 0.8, grimeHeight: 4.0, wear: 0.85, seed: 691 });
    return g;
  }, 'rust');

  /**
   * Its board. Unit box, so the layout stretches it to the hoarding.
   *
   * TWO THINGS HERE ARE NOT FREE CHOICES.
   *
   * z = 0.13 puts the board PROUD of the front posts, whose 0.16 m section
   * reaches +0.08. The layout scales this prototype in x and y only for
   * exactly this reason: if the z scale rode the hoarding's height, a 4 m
   * board would have 0.64 m deep posts and the paper would be buried inside
   * them.
   *
   * `panel_cream` and not `poster_d`, which is what the roadside hoarding
   * uses. `TileBatch`'s `DETAIL_SURFACES` puts every poster surface under a
   * `THREE.LOD` that empties at 145 m — right for flyposting at eye level and
   * exactly wrong here, because a ROOFTOP hoarding is a skyline object and its
   * whole job is to be read from the far bank. On `poster_d` the frame stayed
   * and the advert vanished at 145 m, which is a hoarding with no poster on it.
   */
  P(K, 'roof_board_face', () => {
    const g = new THREE.PlaneGeometry(0.98, 0.60, 6, 3);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, pos.getZ(i) + Math.sin(pos.getX(i) * 14.3) * 0.006);
    }
    g.computeVertexNormals();
    g.translate(0, 0.68, 0.13);
    paint(g, (x, y) => [0.55 + 0.3 * smoothNoise(x * 6, y * 6), 0.5, 0.15]);
    return g;
  }, 'panel_cream', { castShadow: false });

  /**
   * A FREE-STANDING PLATE ON TWO POSTS — bridge name plaques, the mill gate,
   * the incline station board. One prototype, three jobs, because they are the
   * same object in the real city: a painted steel plate bolted to two channel
   * posts set in concrete.
   *
   * Unit WIDTH (x within +/-0.5) and authored height, so the layout scales x to
   * the words and leaves y alone — the plate is 0.62 m deep whatever it says.
   */
  P(K, 'plaque_posts', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      parts.push([box(0.10, 2.05, 0.10), newTrs(s * 0.40, 1.02, 0)]);
      parts.push([box(0.24, 0.12, 0.24), newTrs(s * 0.40, 0.06, 0)]);
    }
    const g = combine(parts, 'plaqueposts');
    weather(g, { grimeBase: 0.75, grimeHeight: 1.6, wear: 0.7, seed: 693 });
    return g;
  }, 'pole_dark');

  P(K, 'plaque_plate', () => {
    const parts = [];
    parts.push([chamferBox(1.0, 0.62, 0.05, 0.012), newTrs(0, 1.72, 0.05)]);
    // a raised bead round the plate: what stops it reading as a flat rectangle
    parts.push([box(1.02, 0.045, 0.075), newTrs(0, 2.00, 0.055)]);
    parts.push([box(1.02, 0.045, 0.075), newTrs(0, 1.44, 0.055)]);
    const g = combine(parts, 'plaqueplate');
    weather(g, { grimeBase: 0.7, grimeHeight: 2.2, wear: 0.65, seed: 694, up: 0.55 });
    return g;
  }, 'sign_green');

  /**
   * THE MILL GATE HEADER — a riveted arch over the works entrance, which is how
   * every steel plant in the valley announced itself. Two heavy stanchions and
   * a bowed top rail; the words go on the rail.
   */
  P(K, 'gate_arch', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      parts.push([box(0.34, 5.4, 0.34), newTrs(s * 3.5, 2.7, 0)]);
      parts.push([box(0.62, 0.22, 0.62), newTrs(s * 3.5, 0.11, 0)]);
      parts.push([tube([
        { x: s * 3.5, y: 4.2, z: 0 }, { x: s * 2.6, y: 5.3, z: 0 },
      ], 0.07, 5), null]);
    }
    const rail = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      rail.push({ x: -3.5 + t * 7, y: 5.4 + Math.sin(t * Math.PI) * 0.55, z: 0 });
    }
    parts.push([tube(rail, 0.10, 5), null]);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const y = 5.4 + Math.sin(t * Math.PI) * 0.55;
      parts.push([box(0.09, 0.9, 0.09), newTrs(-3.5 + t * 7, y - 0.5, 0)]);
    }
    parts.push([box(7.1, 0.10, 0.14), newTrs(0, 4.92, 0)]);
    const g = combine(parts, 'gatearch');
    weather(g, { grimeBase: 0.85, grimeHeight: 6.0, wear: 0.95, seed: 697 });
    return g;
  }, 'rust');
}

export function registerSignKit(K) {
  registerFascia(K);
  registerNeon(K);
  registerCommerce(K);
  registerPaint(K);
  registerSignText(K);
}
