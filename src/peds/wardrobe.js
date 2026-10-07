/**
 * PEDS — the wardrobe.
 *
 * Two tables and one function.
 *
 * `SHAPES` are the silhouettes: twenty complete outfits, each of which becomes
 * one shared skinned geometry. They differ in hem length, bulk, shoulder line,
 * leg garment, footwear, hair mass and headwear — the things that survive at
 * 30 m. Colour is deliberately NOT here.
 *
 * `ARCHETYPES` are who is on the street: office workers in the Golden Triangle
 * at one in the afternoon, millhands in Steel Row, drinkers on the South Side
 * at midnight, joggers and dog walkers in the parks. Each one weights the
 * shapes and supplies the colour families its people actually wear.
 *
 * `makeOutfit(rng, archetype, ctxOpts)` draws one person: a shape, a twelve
 * entry linear-RGB palette, a height, a set of gait parameters and any props.
 * Everything comes off the passed Rng, so a capture is reproducible.
 *
 * Colour values are LINEAR ALBEDO, because the material's baked map is a
 * UNIT-MEAN modulation and the palette is the reflectance (see materials.js
 * and `owPedGain` — the map used to average 0.76 and quietly ate a quarter of
 * every value in this file). A black wool overcoat really is 0.06; a hi-vis
 * vest really is 0.5. `crowdprobe.mjs` gates the result.
 */

/* ------------------------------------------------------------------ */
/* Colour families — linear albedo, rustbelt palette                   */
/* ------------------------------------------------------------------ */

/**
 * THESE ARE REFLECTANCES, AND THE FIRST SET OF THEM WERE NOT.
 *
 * The values below are what a spectrophotometer reads off the fabric, and the
 * whole set has been raised because the previous one was authored against the
 * intuition that a black coat is "nearly black". It is not. Measured diffuse
 * reflectance of real garments:
 *
 *   black cotton tee / wool coat   0.045 - 0.065   (never 0.02 — that is soot)
 *   charcoal suiting               0.07  - 0.09
 *   navy wool                      0.05  - 0.07
 *   mid-blue denim                 0.10  - 0.16
 *   brown leather                  0.08  - 0.12
 *   olive field jacket             0.09  - 0.12
 *   khaki chino                    0.16  - 0.22
 *   white cotton shirt             0.60  - 0.75
 *
 * The old table put the dark 60% of a crowd between 0.024 and 0.070, which
 * after the (then unnormalised) map modulation and the baked vertex AO landed
 * a whole pedestrian at an area-weighted 0.084 — DARKER THAN ASPHALT, half the
 * reflectance of the concrete pavement he is standing on, and the darkest
 * person in the crowd at 0.0285, which is three stops under that pavement.
 * That is the measured cause of the "featureless black silhouette on
 * clearly-lit pavement" defect: not a missing light, a missing surface. The lighting
 * path was verified separately (`lightprobe.mjs`) to track the engine's
 * indirect budget at ~100%.
 *
 * `crowdprobe.mjs` gates the result on the real emitted geometry.
 *
 * The palette is still a rustbelt palette — the crowd is still mostly dark
 * wool, denim and workwear, and DESIGN.md's amber/slag/teal/steel families are
 * all still here. It is the same wardrobe, correctly exposed.
 */
const C = {
  // dark neutrals: the backbone of a cold working city
  black: [0.062, 0.061, 0.065],
  charcoal: [0.078, 0.079, 0.085],
  slate: [0.104, 0.112, 0.126],
  graphite: [0.092, 0.090, 0.087],
  midGrey: [0.172, 0.175, 0.181],
  paleGrey: [0.272, 0.276, 0.281],
  bone: [0.372, 0.358, 0.328],
  cream: [0.440, 0.410, 0.352],
  white: [0.640, 0.640, 0.630],

  // blues
  navy: [0.058, 0.068, 0.102],
  steelBlue: [0.088, 0.116, 0.156],
  denim: [0.106, 0.142, 0.198],
  paleDenim: [0.196, 0.240, 0.300],
  riverTeal: [0.056, 0.132, 0.136],

  // earths and rust — the DESIGN.md signature
  rust: [0.168, 0.072, 0.034],
  slag: [0.236, 0.100, 0.030],
  brick: [0.120, 0.056, 0.042],
  oxblood: [0.090, 0.038, 0.036],
  maroon: [0.096, 0.040, 0.046],
  camel: [0.252, 0.192, 0.118],
  tan: [0.202, 0.154, 0.098],
  brown: [0.092, 0.064, 0.042],
  khaki: [0.178, 0.166, 0.108],
  mustard: [0.238, 0.178, 0.052],

  // greens
  olive: [0.098, 0.107, 0.060],
  forest: [0.058, 0.086, 0.060],
  moss: [0.126, 0.143, 0.082],

  // accents that a rustbelt crowd actually wears
  plum: [0.082, 0.048, 0.088],
  burgundy: [0.096, 0.034, 0.046],
  teal: [0.056, 0.126, 0.130],
  gold: [0.282, 0.200, 0.054],

  /**
   * BRIGHT NOTES — the ONE in six who is not wearing charcoal.
   *
   * These are authored garments, and they exist because the previous way of
   * producing a bright note was to multiply whatever family colour had just
   * been drawn by 2.1-4.2x. That is not how a dye works. Scaling a colour
   * scales its CHROMA with its value, so `plum` (0.082, 0.048, 0.088) came out
   * (0.344, 0.202, 0.370) — a fluorescent violet at 0.37 blue, brighter than
   * any wool ever woven and the single loudest thing in a downtown frame. It
   * is the "random saturated primaries" defect, and it was in a four-line
   * post-process rather than in the wardrobe, which is why the wardrobe read
   * correct at every review.
   *
   * A real bright garment is LESS saturated than a dark one of the same hue,
   * not more: pigment load falls as the base cloth gets whiter. So each of
   * these was authored at its own value, and `crowdprobe.mjs` gate SWATCH
   * holds every emitted top garment to within jitter of one of them.
   */
  shellRed: [0.232, 0.058, 0.044],
  shellOrange: [0.318, 0.132, 0.040],
  shellYellow: [0.352, 0.288, 0.074],
  shellTeal: [0.074, 0.208, 0.212],
  shellBlue: [0.078, 0.148, 0.286],
  shellGreen: [0.098, 0.196, 0.108],
  duffel: [0.286, 0.222, 0.140],
  raspberry: [0.196, 0.070, 0.098],

  // hi-vis is a genuinely bright pigment
  hivis: [0.430, 0.560, 0.036],
  hivisOrange: [0.600, 0.250, 0.026],
  reflective: [0.660, 0.670, 0.650],

  // hard goods
  plastic: [0.072, 0.075, 0.078],
  steel: [0.155, 0.160, 0.168],
  glassDark: [0.020, 0.021, 0.024],
};

/**
 * Skin, linear albedo. Fitzpatrick I-II reads 0.35-0.45 in luminance and VI
 * reads 0.07-0.11 — the dark end of the old table was at 0.046/0.028/0.020,
 * which is darker than any human skin ever measured and made half the crowd's
 * faces unreadable at conversational distance.
 */
const SKIN = [
  [0.392, 0.302, 0.246],
  [0.348, 0.258, 0.204],
  [0.302, 0.216, 0.162],
  [0.252, 0.176, 0.126],
  [0.196, 0.130, 0.092],
  [0.146, 0.096, 0.068],
  [0.106, 0.068, 0.048],
  [0.082, 0.052, 0.038],
];

/**
 * Hair tones with a WEIGHT. A uniform draw over ten entries put three
 * pensioners in every six-person crowd; the weights below are roughly a real
 * street's distribution, and grey is deliberately dimmer than it looks in a
 * swatch because hair is never a flat 0.33 albedo in the field.
 */
const HAIR = [
  [0.030, 0.026, 0.023, 16],   // black — measured diffuse, not "black"
  [0.040, 0.031, 0.024, 14],
  [0.054, 0.037, 0.026, 18],   // dark brown
  [0.078, 0.051, 0.032, 16],   // brown
  [0.100, 0.055, 0.030, 7],    // auburn
  [0.158, 0.118, 0.062, 8],    // dark blond
  [0.232, 0.188, 0.104, 6],    // blond
  [0.112, 0.110, 0.105, 7],    // salt and pepper
  [0.196, 0.196, 0.190, 5],    // grey
  [0.290, 0.288, 0.278, 3],    // white
];
const HAIR_TOTAL = HAIR.reduce((a, h) => a + h[3], 0);

function pickHair(rng) {
  let r = rng.float() * HAIR_TOTAL;
  for (const h of HAIR) {
    r -= h[3];
    if (r <= 0) return [h[0], h[1], h[2]];
  }
  return [HAIR[0][0], HAIR[0][1], HAIR[0][2]];
}

const SHOE = ['black', 'charcoal', 'brown', 'graphite', 'oxblood', 'tan', 'midGrey'];

/* ------------------------------------------------------------------ */
/* Fabrics — what a garment is MADE of, not what colour it is          */
/* ------------------------------------------------------------------ */

/**
 * The crowd used to be one cloth material with twenty colours on it, which is
 * exactly what "one mesh in different colours" looks like: a leather bomber, a
 * nylon puffa, a wool overcoat and a hi-vis vest all shaded identically and
 * differing only in hue.
 *
 * Each entry is a vec4 uploaded per person per palette slot (see
 * `PedMaterials.createFabric`) — no extra geometry, no extra draw call, no
 * extra program:
 *
 *   [ roughness multiplier, detail-normal gain, detail tile multiplier, sheen ]
 *
 * `sheen` is the load-bearing one. It brightens the grazing sliver AND
 * suppresses the nap-extinction silhouette darkening by the same amount, so
 * one number moves a garment along the real axis from "matte felt that eats
 * its own outline" to "waxed cotton with a hot rim".
 *
 * Values are the shape of the real BRDFs: melton and fleece are the roughest
 * things a person wears, worsted suiting is smoother and slightly lustrous,
 * denim is rough with a coarse visible twill, leather is smooth and glossy
 * with a fine pebble, nylon is very smooth and very shiny at grazing, and
 * retroreflective tape is off the end of the scale on purpose.
 */
const FABRIC = {
  melton:   [1.00, 1.25, 0.80, 0.010],  // heavy wool coating: matte, hairy
  worsted:  [0.90, 0.85, 1.15, 0.055],  // suiting: fine, faintly lustrous
  poplin:   [0.92, 0.70, 1.45, 0.045],  // cotton shirting: fine, crisp
  denim:    [0.96, 1.45, 0.68, 0.030],  // coarse 3x1 twill, visible diagonal
  duck:     [0.99, 1.20, 0.85, 0.020],  // cotton duck / canvas workwear
  fleece:   [1.02, 1.55, 0.75, 0.008],  // brushed, the matte end of the scale
  knit:     [1.00, 1.70, 0.52, 0.014],  // chunky knit: big loops, no sheen
  leather:  [0.56, 0.95, 0.90, 0.150],  // pebbled, glossy, bright at grazing
  nylon:    [0.60, 0.50, 1.70, 0.190],  // quilted shell: smooth and shiny
  tech:     [0.68, 0.60, 1.55, 0.120],  // running kit
  lycra:    [0.72, 0.45, 1.80, 0.100],  // leggings
  hivis:    [0.74, 0.75, 1.20, 0.110],  // fluorescent polyester
  tape:     [0.32, 0.40, 1.10, 0.520],  // retroreflective banding
  rubber:   [0.86, 1.10, 1.00, 0.035],  // trainer sole, boot welt
  plastic:  [0.58, 0.55, 1.30, 0.130],  // hard hat, phone, buckles
  skin:     [1.00, 1.00, 1.00, 0.060],  // a face has a little specular sheen
  hair:     [0.74, 1.20, 0.85, 0.170],  // strand highlight
};

/** Leg garment -> fabric. */
const LEG_FABRIC = {
  jeans: 'denim', trouser: 'worsted', legging: 'lycra', skirt: 'melton', shorts: 'poplin',
};
/** Footwear -> fabric. */
const FOOT_FABRIC = {
  dress: 'leather', boot: 'leather', work: 'leather', heel: 'leather', trainer: 'tech',
};
/** Headwear -> fabric. */
const HAT_FABRIC = { beanie: 'knit', flat: 'worsted', ball: 'duck', hard: 'plastic' };

/**
 * One person's fabric block, in palette-slot order. Every entry gets a small
 * deterministic jitter so two wool coats in the same frame are not the same
 * wool coat — the same reason `pick()` jitters colour.
 */
function makeFabric(rng, S) {
  const j = (f, k = 0.11) => {
    const b = FABRIC[f] ?? FABRIC.duck;
    return [
      b[0] * (1 + rng.signed() * k),
      b[1] * (1 + rng.signed() * k * 1.5),
      b[2] * (1 + rng.signed() * k),
      Math.max(0, b[3] * (1 + rng.signed() * k * 2.2)),
    ];
  };
  const ex = new Set(S.extras ?? []);
  const outer = S.fab ?? 'duck';
  const f = new Array(12);
  f[0] = j('skin', 0.06);                                  // skin
  f[1] = j('hair', 0.16);                                  // hair
  f[2] = j(outer);                                         // top / outer garment
  // the layer under the coat is never the same cloth as the coat
  f[3] = j(outer === 'poplin' ? 'knit' : 'poplin');        // shirt / jumper
  f[4] = j(LEG_FABRIC[S.legs] ?? 'worsted');               // trousers
  f[5] = j(FOOT_FABRIC[S.feet] ?? 'leather');              // shoes
  f[6] = j(ex.has('hivis') ? 'hivis' : 'knit');            // scarf / tie / vest
  f[7] = j(HAT_FABRIC[S.hat] ?? outer);                    // hat
  f[8] = j('plastic');                                     // buttons, buckles
  f[9] = j('rubber');                                      // eyes, soles
  f[10] = j('skin', 0.06);                                 // lips
  f[11] = j(ex.has('hivis') ? 'tape' : ex.has('pack') ? 'nylon' : 'leather'); // bag
  return f;
}

/**
 * NEGATIVE CONTROL for `crowdprobe.mjs` gate SWATCH. `--legacypalette`
 * restores the multiply-a-dark-colour bright note, and the gate must go red:
 * a scaled colour lands within jitter of NO swatch in `C`.
 */
export const PALETTE_LEGACY = { brightScale: false };

/** Notes for an archetype that declares none. */
const NOTE_FALLBACK = ['bone', 'cream', 'camel', 'mustard', 'shellRed', 'shellTeal'];

/** Pull a colour with a small deterministic hue/value jitter. */
function pick(rng, names, jitter = 0.10) {
  const c = C[names[rng.u32() % names.length]] ?? C.charcoal;
  const v = 1 + rng.signed() * jitter;
  const h = rng.signed() * jitter * 0.35;
  return [
    Math.max(0.008, c[0] * v * (1 + h)),
    Math.max(0.008, c[1] * v),
    Math.max(0.008, c[2] * v * (1 - h)),
  ];
}

/* ------------------------------------------------------------------ */
/* Silhouettes                                                         */
/* ------------------------------------------------------------------ */

/**
 * One entry per shared geometry.
 *   hem       where the top garment stops (0.60 long coat … 0.88 tucked shirt)
 *   bulk      body mass multiplier on the torso shell
 *   flare     how far the hem swings clear of the hips
 *   bust/belly/waist/hipW/shoulder   the figure
 *   legs      'trouser' | 'jeans' | 'skirt' | 'legging' | 'shorts'
 *   feet      'dress' | 'boot' | 'trainer' | 'heel' | 'work'
 *   hair      'buzz' | 'short' | 'bob' | 'long' | 'bun' | 'tail' | 'bald'
 *   hat       null | 'beanie' | 'flat' | 'ball' | 'hard'
 *   extras    lapels, tie, hivis, hood, scarf, bag, pack, apron, open
 */
export const SHAPES = {
  overcoatM: {
    fab: 'melton',
    stubble: 0.35,
    hem: 0.68, bulk: 1.02, flare: 1.20, waist: 0.99, shoulder: 1.06, thick: 0.012,
    legs: 'trouser', feet: 'dress', hair: 'short', hat: null,
    extras: ['lapels', 'buttons', 'scarf'], sleeveR: 0.053, doc: 'downtown overcoat',
  },
  suitM: {
    fab: 'worsted',
    stubble: 0.22,
    hem: 0.78, bulk: 0.97, flare: 0.85, waist: 0.95, shoulder: 1.10, thick: 0.006,
    legs: 'trouser', feet: 'dress', hair: 'short', hat: null,
    extras: ['lapels', 'tie', 'collar', 'buttons'], sleeveR: 0.047, doc: 'suit and tie',
  },
  officeF: {
    fab: 'worsted',
    hem: 0.80, bulk: 0.93, flare: 0.9, bust: 1.0, waist: 0.90, hipW: 1.07, shoulder: 0.95,
    thick: 0.005,
    legs: 'trouser', feet: 'heel', hair: 'bun', hat: null,
    extras: ['lapels', 'bag'], sleeveR: 0.043, doc: 'office blazer',
  },
  coatF: {
    fab: 'melton',
    hem: 0.64, bulk: 0.95, flare: 1.30, bust: 0.85, waist: 0.88, hipW: 1.08, shoulder: 0.94,
    thick: 0.012,
    legs: 'legging', feet: 'boot', hair: 'long', hat: null,
    extras: ['buttons', 'scarf', 'bag'], sleeveR: 0.049, doc: 'long winter coat',
  },
  dressF: {
    fab: 'poplin',
    hem: 0.86, bulk: 0.92, flare: 0.8, bust: 1.05, waist: 0.84, hipW: 1.10, shoulder: 0.92,
    thick: 0.003,
    legs: 'skirt', feet: 'heel', hair: 'bob', hat: null,
    extras: ['collar'], sleeveR: 0.039, doc: 'dress and cardigan',
  },
  jacketM: {
    fab: 'leather',
    stubble: 0.70, beard: 1.0,
    hem: 0.82, bulk: 1.04, flare: 0.95, shoulder: 1.05, thick: 0.010,
    legs: 'jeans', feet: 'boot', hair: 'short', hat: null,
    extras: ['collar', 'belt'], sleeveR: 0.051, doc: 'bomber and jeans',
  },
  jacketF: {
    fab: 'denim',
    hem: 0.83, bulk: 0.94, flare: 0.95, bust: 0.9, waist: 0.88, hipW: 1.08, shoulder: 0.95,
    thick: 0.009,
    legs: 'jeans', feet: 'boot', hair: 'tail', hat: null,
    extras: ['collar', 'bag'], sleeveR: 0.044, doc: 'denim jacket',
  },
  hoodieM: {
    fab: 'fleece',
    stubble: 0.85,
    hem: 0.80, bulk: 1.06, flare: 1.0, shoulder: 1.03, thick: 0.014,
    legs: 'jeans', feet: 'trainer', hair: 'buzz', hat: null,
    extras: ['hood'], sleeveR: 0.054, doc: 'hoodie, hood down',
  },
  hoodedM: {
    fab: 'fleece',
    stubble: 0.90,
    hem: 0.80, bulk: 1.06, flare: 1.0, shoulder: 1.03, thick: 0.014,
    legs: 'jeans', feet: 'trainer', hair: 'bald', hat: null,
    extras: ['hoodUp'], sleeveR: 0.054, doc: 'hoodie, hood up',
  },
  hoodieF: {
    fab: 'fleece',
    hem: 0.81, bulk: 0.97, flare: 1.0, bust: 0.8, waist: 0.93, hipW: 1.06, shoulder: 0.96,
    thick: 0.013,
    legs: 'legging', feet: 'trainer', hair: 'tail', hat: null,
    extras: ['hood'], sleeveR: 0.047, doc: 'hoodie and leggings',
  },
  puffaM: {
    fab: 'nylon',
    stubble: 0.60,
    hem: 0.74, bulk: 1.14, flare: 1.10, shoulder: 1.02, thick: 0.030,
    legs: 'jeans', feet: 'boot', hair: 'short', hat: 'beanie',
    extras: ['quilt', 'collar'], sleeveR: 0.063, doc: 'quilted puffa',
  },
  puffaF: {
    fab: 'nylon',
    hem: 0.72, bulk: 1.06, flare: 1.15, bust: 0.6, waist: 0.95, hipW: 1.06, shoulder: 0.96,
    thick: 0.028,
    legs: 'legging', feet: 'boot', hair: 'long', hat: 'beanie',
    extras: ['quilt', 'scarf'], sleeveR: 0.059, doc: 'quilted puffa',
  },
  workM: {
    fab: 'duck',
    stubble: 0.80, beard: 1.0,
    hem: 0.79, bulk: 1.10, flare: 0.95, belly: 0.35, shoulder: 1.08, thick: 0.014,
    legs: 'trouser', feet: 'work', hair: 'buzz', hat: 'hard',
    extras: ['hivis', 'collar', 'belt'], sleeveR: 0.056, doc: 'hi-vis and hard hat',
  },
  millM: {
    fab: 'duck',
    stubble: 0.90, beard: 1.0,
    hem: 0.80, bulk: 1.12, flare: 0.9, belly: 0.5, shoulder: 1.09, thick: 0.012,
    legs: 'trouser', feet: 'work', hair: 'short', hat: 'ball',
    extras: ['collar', 'belt', 'apron'], sleeveR: 0.055, doc: 'millhand',
  },
  shirtM: {
    fab: 'poplin',
    stubble: 0.30,
    hem: 0.88, bulk: 0.99, flare: 0.7, shoulder: 1.02, thick: 0.002,
    legs: 'trouser', feet: 'dress', hair: 'short', hat: null,
    extras: ['collar', 'belt', 'buttons'], sleeveR: 0.043, doc: 'shirtsleeves',
  },
  joggerM: {
    fab: 'tech',
    stubble: 0.45,
    hem: 0.86, bulk: 0.95, flare: 0.7, shoulder: 1.0, thick: 0.004,
    legs: 'legging', feet: 'trainer', hair: 'buzz', hat: null,
    extras: ['zip'], sleeveR: 0.040, doc: 'running kit',
  },
  joggerF: {
    fab: 'tech',
    hem: 0.90, bulk: 0.90, flare: 0.6, bust: 0.8, waist: 0.86, hipW: 1.06, shoulder: 0.93,
    thick: 0.003,
    legs: 'legging', feet: 'trainer', hair: 'tail', hat: 'ball',
    extras: ['zip'], sleeveR: 0.037, doc: 'running kit',
  },
  oldM: {
    fab: 'knit',
    stubble: 0.55, beard: 0.6, age: 1.0,
    hem: 0.76, bulk: 1.05, flare: 0.9, belly: 0.55, shoulder: 0.96, thick: 0.010,
    legs: 'trouser', feet: 'dress', hair: 'bald', hat: 'flat',
    extras: ['collar', 'buttons', 'stoop'], sleeveR: 0.051, doc: 'flat cap and cardigan',
  },
  oldF: {
    fab: 'melton',
    age: 1.0, stubble: 0,
    hem: 0.70, bulk: 1.0, flare: 1.18, bust: 0.5, waist: 0.98, hipW: 1.10, shoulder: 0.92,
    thick: 0.011,
    legs: 'skirt', feet: 'dress', hair: 'bob', hat: null,
    extras: ['buttons', 'scarf', 'bag', 'stoop'], sleeveR: 0.048, doc: 'long coat, headscarf',
  },
  studentM: {
    fab: 'denim',
    stubble: 0.55,
    hem: 0.84, bulk: 0.94, flare: 0.85, shoulder: 0.99, thick: 0.008,
    legs: 'jeans', feet: 'trainer', hair: 'long', hat: 'beanie',
    extras: ['pack', 'collar'], sleeveR: 0.046, doc: 'rucksack and beanie',
  },

  /* ---------------------------------------------------------------- *
   * BUILD, not just wardrobe.
   *
   * The twenty above are twenty GARMENTS on essentially one body: bulk runs
   * 0.90-1.14 and shoulder 0.92-1.10, which is a 24% spread on a crowd whose
   * real spread is more than double that. Geometry is shared per silhouette
   * and a body is pooled without regard to shape, so the only place build can
   * live is here — a heavy man and a rangy one have to be two entries, and
   * `height` in `makeOutfit` then scales each of them again.
   *
   * These six are deliberately at the ENDS of the range rather than more
   * points in the middle, because what "one silhouette a dozen times" means
   * in a screenshot is that nothing in frame is shaped unlike anything else.
   * ---------------------------------------------------------------- */
  heavyM: {
    fab: 'duck',
    stubble: 0.75, beard: 0.8,
    hem: 0.80, bulk: 1.26, flare: 0.92, belly: 0.95, waist: 1.06, hipW: 1.14, shoulder: 1.12,
    thick: 0.014,
    legs: 'jeans', feet: 'work', hair: 'buzz', hat: 'ball',
    extras: ['collar', 'belt', 'hem'], sleeveR: 0.068, doc: 'heavy build, chore coat',
  },
  leanM: {
    fab: 'melton',
    stubble: 0.25,
    hem: 0.62, bulk: 0.88, flare: 1.22, belly: 0, waist: 0.92, hipW: 0.94, shoulder: 1.14,
    thick: 0.011,
    legs: 'trouser', feet: 'dress', hair: 'short', hat: null,
    extras: ['lapels', 'buttons', 'scarf', 'hem'], sleeveR: 0.046, doc: 'tall, lean, long coat',
  },
  vestM: {
    fab: 'nylon',
    stubble: 0.85, beard: 1.0,
    hem: 0.86, bulk: 1.16, flare: 0.88, belly: 0.55, shoulder: 1.10, thick: 0.024,
    legs: 'jeans', feet: 'work', hair: 'short', hat: 'beanie',
    extras: ['quilt', 'collar', 'belt', 'hem'], sleeveR: 0.050, doc: 'gilet over flannel',
  },
  rainF: {
    fab: 'tech',
    stubble: 0,
    hem: 0.72, bulk: 1.02, flare: 1.16, bust: 0.7, waist: 0.97, hipW: 1.06, shoulder: 0.98,
    thick: 0.010,
    legs: 'legging', feet: 'boot', hair: 'tail', hat: null,
    extras: ['hoodUp', 'zip', 'hem'], sleeveR: 0.052, doc: 'rain shell, hood up',
  },
  parkaM: {
    fab: 'duck',
    stubble: 0.65,
    hem: 0.66, bulk: 1.12, flare: 1.05, shoulder: 1.06, thick: 0.020,
    legs: 'jeans', feet: 'boot', hair: 'short', hat: null,
    extras: ['hood', 'zip', 'pack', 'hem'], sleeveR: 0.058, doc: 'long parka and pack',
  },
  cardiganF: {
    fab: 'knit',
    stubble: 0, age: 0.4,
    hem: 0.68, bulk: 0.96, flare: 1.06, bust: 0.8, waist: 0.94, hipW: 1.12, shoulder: 0.90,
    thick: 0.016,
    legs: 'skirt', feet: 'boot', hair: 'bun', hat: null,
    extras: ['collar', 'bag', 'hem'], sleeveR: 0.052, doc: 'long cardigan and skirt',
  },
};

export const SHAPE_IDS = Object.keys(SHAPES);

/* ------------------------------------------------------------------ */
/* Archetypes                                                          */
/* ------------------------------------------------------------------ */

/**
 * `shapes`  weighted silhouette pool
 * `top/under/bottom/accent/hat` colour families
 * `speed`   [walk, jog] base ground speed, m/s
 * `idle`    idle behaviours this archetype actually does
 */
export const ARCHETYPES = {
  office: {
    shapes: {
      overcoatM: 3, suitM: 3, officeF: 3, coatF: 2, dressF: 1, shirtM: 2, studentM: 1,
      leanM: 2, cardiganF: 1, rainF: 1,
    },
    top: ['charcoal', 'navy', 'black', 'slate', 'graphite', 'camel', 'midGrey', 'forest'],
    // a downtown bright note is a scarf-grade colour, never a primary
    note: ['camel', 'bone', 'cream', 'shellBlue', 'raspberry', 'duffel', 'shellTeal'],
    under: ['white', 'paleGrey', 'paleDenim', 'bone', 'cream', 'steelBlue'],
    bottom: ['charcoal', 'navy', 'black', 'graphite', 'slate', 'midGrey'],
    accent: ['burgundy', 'navy', 'teal', 'oxblood', 'mustard', 'charcoal', 'plum'],
    hat: ['charcoal', 'black', 'navy'],
    speed: [1.42, 3.2],
    idle: ['phone', 'talk', 'wait', 'smoke'],
    props: { phone: 0.30, umbrella: 0.18, coffee: 0.16 },
  },
  mill: {
    shapes: { workM: 4, millM: 4, jacketM: 3, puffaM: 2, hoodieM: 2, oldM: 1, heavyM: 4, vestM: 3 },
    top: ['olive', 'khaki', 'navy', 'charcoal', 'rust', 'brown', 'denim', 'graphite'],
    // the workwear note is safety colour or nothing
    note: ['hivisOrange', 'hivis', 'shellOrange', 'shellYellow', 'duffel', 'rust'],
    under: ['midGrey', 'khaki', 'paleGrey', 'olive', 'bone'],
    bottom: ['denim', 'khaki', 'charcoal', 'brown', 'olive', 'graphite'],
    accent: ['hivis', 'hivisOrange', 'rust', 'mustard', 'slag'],
    hat: ['hivisOrange', 'hivis', 'white', 'navy', 'charcoal'],
    speed: [1.32, 2.9],
    idle: ['smoke', 'talk', 'phone', 'wait'],
    props: { phone: 0.14, coffee: 0.10 },
  },
  street: {
    shapes: {
      jacketM: 3, jacketF: 3, hoodieM: 3, hoodieF: 2, hoodedM: 2, puffaM: 2, puffaF: 2,
      studentM: 2, coatF: 2, oldM: 1, oldF: 1, shirtM: 1,
      heavyM: 2, leanM: 2, vestM: 2, parkaM: 2, rainF: 2, cardiganF: 1,
    },
    top: ['charcoal', 'navy', 'olive', 'denim', 'black', 'maroon', 'brown', 'forest', 'slate', 'rust', 'plum'],
    note: ['shellRed', 'shellTeal', 'shellBlue', 'shellGreen', 'mustard', 'duffel', 'bone', 'camel'],
    under: ['midGrey', 'paleGrey', 'bone', 'white', 'burgundy', 'teal'],
    bottom: ['denim', 'charcoal', 'black', 'khaki', 'graphite', 'paleDenim'],
    accent: ['burgundy', 'mustard', 'teal', 'gold', 'oxblood', 'paleGrey', 'slag'],
    hat: ['charcoal', 'black', 'maroon', 'navy', 'olive', 'gold'],
    speed: [1.34, 3.0],
    idle: ['phone', 'talk', 'smoke', 'wait', 'lean'],
    props: { phone: 0.26, umbrella: 0.12, coffee: 0.10 },
  },
  nightlife: {
    shapes: {
      jacketF: 3, dressF: 3, jacketM: 3, shirtM: 3, hoodieM: 2, coatF: 2, hoodedM: 1, officeF: 1,
      leanM: 2, vestM: 1,
    },
    top: ['black', 'oxblood', 'plum', 'burgundy', 'navy', 'charcoal', 'teal', 'maroon'],
    note: ['raspberry', 'gold', 'cream', 'white', 'shellRed', 'bone'],
    under: ['white', 'bone', 'gold', 'burgundy', 'paleGrey'],
    bottom: ['black', 'charcoal', 'denim', 'graphite'],
    accent: ['gold', 'burgundy', 'teal', 'slag', 'plum'],
    hat: ['black', 'charcoal'],
    speed: [1.24, 2.9],
    idle: ['smoke', 'talk', 'phone', 'lean'],
    props: { phone: 0.34, cigarette: 0.22 },
  },
  residential: {
    shapes: {
      oldM: 3, oldF: 3, jacketM: 2, coatF: 2, hoodieF: 2, puffaF: 2, shirtM: 2, studentM: 1,
      cardiganF: 3, heavyM: 2, parkaM: 2, vestM: 1,
    },
    top: ['brown', 'olive', 'camel', 'maroon', 'navy', 'midGrey', 'forest', 'tan'],
    note: ['duffel', 'cream', 'bone', 'mustard', 'shellGreen', 'raspberry'],
    under: ['cream', 'bone', 'paleGrey', 'white'],
    bottom: ['brown', 'charcoal', 'khaki', 'denim', 'graphite'],
    accent: ['mustard', 'burgundy', 'teal', 'moss'],
    hat: ['brown', 'charcoal', 'olive'],
    speed: [1.18, 2.4],
    idle: ['talk', 'wait', 'phone', 'dog'],
    props: { phone: 0.14, umbrella: 0.14 },
  },
  park: {
    shapes: { joggerM: 4, joggerF: 4, hoodieF: 2, hoodieM: 2, oldM: 1, oldF: 1, studentM: 1, rainF: 2, parkaM: 1 },
    top: ['charcoal', 'slag', 'teal', 'navy', 'forest', 'hivis', 'graphite', 'plum'],
    // running kit is the one place a real crowd IS bright
    note: ['hivis', 'shellYellow', 'shellTeal', 'shellRed', 'shellBlue', 'shellGreen'],
    under: ['paleGrey', 'white', 'bone'],
    bottom: ['black', 'charcoal', 'graphite', 'navy'],
    accent: ['hivis', 'slag', 'teal', 'gold'],
    hat: ['charcoal', 'black', 'slag'],
    speed: [1.5, 3.9],
    idle: ['wait', 'talk', 'dog'],
    props: { phone: 0.10 },
    joggerBias: 0.62,
  },
  market: {
    shapes: {
      millM: 2, jacketM: 3, coatF: 3, oldF: 3, oldM: 2, hoodieM: 2, shirtM: 2, officeF: 1,
      cardiganF: 3, heavyM: 2, parkaM: 1,
    },
    top: ['brown', 'olive', 'rust', 'navy', 'camel', 'maroon', 'charcoal', 'tan', 'moss'],
    note: ['duffel', 'mustard', 'shellRed', 'cream', 'camel', 'shellGreen'],
    under: ['cream', 'bone', 'paleGrey', 'white', 'khaki'],
    bottom: ['denim', 'brown', 'charcoal', 'khaki'],
    accent: ['mustard', 'slag', 'teal', 'burgundy', 'gold'],
    hat: ['brown', 'charcoal', 'maroon'],
    speed: [1.10, 2.3],
    idle: ['talk', 'wait', 'phone'],
    props: { phone: 0.16, umbrella: 0.10 },
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

/**
 * Which archetypes are on the street in a district at an hour, and how dense
 * the crowd is (0..1, multiplied into the streaming budget).
 *
 * District ids come from DESIGN.md. Anything `world` reports that is not in the
 * table falls back to `street`.
 */
const DISTRICT_MIX = {
  downtown: { day: ['office', 'office', 'street'], night: ['nightlife', 'street'], peak: 13 },
  point: { day: ['office', 'park', 'street'], night: ['street'], peak: 12 },
  strip: { day: ['market', 'market', 'street'], night: ['nightlife', 'street'], peak: 11 },
  lawren: { day: ['street', 'residential', 'market'], night: ['nightlife', 'street'], peak: 19 },
  northsh: { day: ['office', 'street', 'park'], night: ['nightlife', 'street'], peak: 18 },
  troy: { day: ['residential', 'street'], night: ['residential'], peak: 17 },
  southside: { day: ['mill', 'street', 'residential'], night: ['nightlife', 'nightlife', 'street'], peak: 23 },
  mtwash: { day: ['residential', 'park'], night: ['residential'], peak: 17 },
  steelrow: { day: ['mill', 'mill', 'street'], night: ['mill'], peak: 7 },
  westend: { day: ['residential', 'street'], night: ['residential'], peak: 18 },
  northside: { day: ['residential', 'street', 'market'], night: ['street'], peak: 18 },
  hazel: { day: ['mill', 'residential'], night: ['mill'], peak: 8 },
};

/** Density curve over the day, per district family. 0 at 4 am, peak at noon. */
export function densityAt(hour, district) {
  const d = DISTRICT_MIX[district?.id] ?? null;
  const peak = d?.peak ?? 13;
  // two humps: a commute/lunch peak and a smaller evening one
  const h = ((hour % 24) + 24) % 24;
  const bell = (c, w) => Math.exp(-(((h - c + 36) % 24 - 12) ** 2) / (2 * w * w));
  let k = 0.14 + 0.86 * bell(peak, 4.2) + 0.42 * bell((peak + 7) % 24, 2.6);
  // dead of night
  k *= 0.10 + 0.90 * Math.min(1, Math.max(0, (h - 4.5) / 2.2)) * Math.min(1, Math.max(0, (25.5 - h) / 2.0));
  return Math.min(1, Math.max(0.03, k));
}

/** Archetype for a district at an hour. */
export function archetypeAt(rng, hour, district) {
  const d = DISTRICT_MIX[district?.id];
  if (!d) return 'street';
  const h = ((hour % 24) + 24) % 24;
  const list = h >= 7 && h < 19 ? d.day : d.night;
  return list[rng.u32() % list.length];
}

/* ------------------------------------------------------------------ */
/* Draw one person                                                     */
/* ------------------------------------------------------------------ */

function weightedShape(rng, table) {
  let total = 0;
  for (const k in table) total += table[k];
  let r = rng.float() * total;
  for (const k in table) {
    r -= table[k];
    if (r <= 0) return k;
  }
  return Object.keys(table)[0];
}

/**
 * @returns {{
 *   shape:string, archetype:string, palette:number[][], height:number,
 *   scale:number, gait:object, props:object, speed:number[], idle:string[]
 * }}
 */
export function makeOutfit(rng, archetypeId, opts = {}) {
  const A = ARCHETYPES[archetypeId] ?? ARCHETYPES.street;
  const shape = opts.shape ?? weightedShape(rng, A.shapes);
  const S = SHAPES[shape];

  const skin = SKIN[rng.u32() % SKIN.length];
  const hair = pickHair(rng);

  /**
   * One person in six wears something that is not charcoal — drawn from the
   * archetype's OWN note list, not manufactured by scaling a dark colour. See
   * the `shell*` block in `C`. `PALETTE_LEGACY` puts the scaling back for
   * `crowdprobe.mjs` gate SWATCH's negative control.
   */
  /**
   * THE DRAW COUNT AND ORDER ARE PART OF THE CONTRACT.
   *
   * This is one shared `Rng` walked once per pedestrian, and everything after
   * it — the height, the gait, the props, and through `peds/index.js` the next
   * pedestrian's spawn point — comes off the same stream. Choosing the bright
   * note with its own extra `pick()` (three draws where there was one) shifted
   * every subsequent value in the city: the crowd came out standing in
   * different places, and `shadowprobe.mjs` lost the pedestrian it measures the
   * contact shadow on. So the note is selected from THE SAME SINGLE DRAW the
   * old scale factor used, in the same position, and the stream is unchanged.
   */
  const family = pick(rng, A.top, 0.13);
  let top = family;
  if (rng.float() < 0.22) {
    const g = rng.range(2.1, 4.2);
    if (PALETTE_LEGACY.brightScale) {
      top = [
        Math.min(0.50, family[0] * g), Math.min(0.50, family[1] * g), Math.min(0.50, family[2] * g),
      ];
    } else {
      const list = A.note ?? NOTE_FALLBACK;
      const u = (g - 2.1) / 2.1;                       // 0..1
      const c = C[list[Math.min(list.length - 1, Math.floor(u * list.length))]] ?? C.camel;
      // the fractional part carries the value jitter, so one draw does both
      const v = 1 + (((u * list.length) % 1) - 0.5) * 0.16;
      top = [Math.max(0.008, c[0] * v), Math.max(0.008, c[1] * v), Math.max(0.008, c[2] * v)];
    }
  }
  // a jumper or shirt under the coat, related to but never equal to the top
  const under = pick(rng, A.under, 0.14);
  const bottom = pick(rng, A.bottom, 0.12);
  const accent = pick(rng, A.accent, 0.16);
  const hatCol = S.hat === 'hard'
    ? pick(rng, ['hivisOrange', 'hivis', 'white', 'navy'], 0.08)
    : pick(rng, A.hat ?? A.top, 0.13);
  const shoeCol = pick(rng, SHOE, 0.16);

  const palette = new Array(12);
  palette[0] = skin;
  palette[1] = hair;
  palette[2] = top;
  palette[3] = under;
  palette[4] = bottom;
  palette[5] = shoeCol;
  palette[6] = S.extras.includes('hivis') ? C.hivis.slice() : accent;
  palette[7] = hatCol;
  palette[8] = [0.072, 0.075, 0.078];                  // hard goods
  palette[9] = [0.026, 0.026, 0.028];                  // eyes, rubber soles
  palette[10] = [0.44, 0.42, 0.40];                    // sclera
  palette[11] = S.extras.includes('hivis')
    ? C.reflective.slice()                             // retroreflective tape
    : pick(rng, A.accent, 0.2);                        // bag body, second accent

  // Height. Adult range 1.54-1.94 m about a 1.75 m reference, drawn from a
  // truncated normal so a crowd has a believable spread rather than a uniform
  // one — which is what "every ped the same height" actually looks like when
  // you over-correct it.
  const g = Math.max(-2.2, Math.min(2.2, rng.gauss()));
  const female = /F$/.test(shape);
  const base = female ? 1.663 : 1.784;
  const height = base + g * (female ? 0.062 : 0.068);
  const scale = height / 1.75;

  // Per-character gait. These are the numbers that stop a crowd from marching
  // in lockstep: stride frequency, how far the arms swing, how much the pelvis
  // rolls, how far the feet turn out, how much the torso leans.
  const gait = {
    strideK: 0.86 + rng.float() * 0.34,      // stride length multiplier
    armSwing: 0.55 + rng.float() * 0.95,
    armBias: rng.signed() * 3.0,             // one arm carried differently
    bounce: 0.75 + rng.float() * 0.6,
    sway: 0.7 + rng.float() * 0.75,
    roll: 0.6 + rng.float() * 0.9,
    splay: rng.range(-1.5, 4.5),             // toe-out
    lean: rng.range(-1.6, 4.2),
    headBob: 0.5 + rng.float() * 1.0,
    shoulderDrop: rng.signed() * 2.2,
    phase: rng.float(),
    stoop: S.extras.includes('stoop') ? rng.range(3, 8) : rng.range(-1, 2.4),
    speedK: 0.86 + rng.float() * 0.30,
    heelK: S.feet === 'heel' ? 1.3 : 1.0,
    idleRate: 0.7 + rng.float() * 0.7,
  };

  const props = {};
  const pr = opts.props ?? A.props ?? {};
  if (pr.phone && rng.float() < pr.phone) props.phone = true;
  if (pr.cigarette && rng.float() < pr.cigarette) props.cigarette = true;
  if (opts.rain > 0.25 && pr.umbrella !== undefined && rng.float() < 0.55 + opts.rain * 0.4) {
    props.umbrella = true;
  } else if (pr.umbrella && rng.float() < pr.umbrella * 0.4) {
    props.umbrellaClosed = true;
  }

  return {
    shape,
    archetype: archetypeId,
    palette,
    fabric: makeFabric(rng, S),
    height,
    scale,
    gait,
    props,
    speed: A.speed,
    idle: A.idle,
    jogger: (A.joggerBias ?? 0) > rng.float(),
    female,
  };
}

export { C as COLOURS, SKIN as SKIN_TONES, HAIR as HAIR_TONES };
