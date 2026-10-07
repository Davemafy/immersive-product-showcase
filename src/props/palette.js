import * as THREE from 'three';

/**
 * PROPS — the surface table.
 *
 * Every material a prop can wear, named once here and resolved through
 * `ctx.get('materials')` at build time (ARCHITECTURE.md rule 2 — the material
 * system is never imported). Keeping them in one table is what makes the tile
 * batcher work: geometry is merged per SURFACE KEY, so the number of draw calls
 * a tile costs is the number of entries below it actually touched.
 *
 * `scale` is metres per texture tile. Props are small, so almost everything
 * here is a prop-scale variant of a library surface — a 2 m concrete tiling on
 * a 0.9 m bollard is one sixth of a brick and reads as flat grey.
 *
 * `uvMode: 'planar'` (the library default) projects in WORLD space, which is
 * quietly one of the most valuable things in this file: two hundred identical
 * lamp posts sample two hundred different parts of the same texture, so the
 * instanced kit does not read as a stamped clone even before the per-instance
 * yaw and scale jitter goes on.
 */

/** Sodium is the signature light of this city. Everything warm keys off it. */
export const SODIUM = 0xffb266;
export const SODIUM_DEEP = 0xff8a2b;
export const MERCURY = 0xc9e2ff;

const wear = (w, g, a) => ({ wear: [w, g, a, 0] });

/**
 * THE PAINTED-METAL TRAP. `metal_painted` bakes a METALLIC ORM, so tinting it
 * for a colour that is actually paint over steel resolves to a tinted mirror
 * that returns the sky — every sign came out pale grey-blue. Paint is a
 * dielectric film: drop the metalness to a whisper (enough that the chipped
 * arris still glints) and floor the roughness at 0.34.
 */
const PAINTED = { three: { metalness: 0.09 } };

export const SURFACES = {
  // ---------------------------------------------------------- structural --
  /** Lamp columns, sign posts, railings — painted steel, chipped to primer. */
  pole_dark: {
    name: 'metal_painted', opts: {
      scale: 0.7, tint: 0x2c3230, vertexMasks: true, ...wear(0.75, 0.8, 0.55),
      roughness: [0.92, 0.05, 0.34], grime: [0.5, 2.2, 0.9, 0.35],
      detail: [0, 0.9, 0.5, 14], detailWorld: 0.20, ...PAINTED,
    },
  },
  pole_green: {
    name: 'metal_painted', opts: {
      scale: 0.7, tint: 0x2f4038, vertexMasks: true, ...wear(0.8, 0.75, 0.5),
      roughness: [0.92, 0.04, 0.34], grime: [0.5, 2.2, 0.9, 0.35], ...PAINTED,
    },
  },
  pole_grey: {
    name: 'metal_painted', opts: {
      scale: 0.8, tint: 0x9a9d99, vertexMasks: true, ...wear(0.85, 0.7, 0.5),
      roughness: [0.92, 0.08, 0.36], ...PAINTED,
    },
  },
  galv: {
    name: 'metal_brushed', opts: {
      scale: 0.6, tint: 0xa9aeb2, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [1, 0.18, 0.22], grime: [0.6, 2.0, 1.0, 0.5],
    },
  },
  /**
   * CONDUCTOR. Weathered aluminium and black polyethylene at 18-32 mm: almost
   * no diffuse, a hard specular line down the top of every strand, and dark
   * enough that a span reads against the sky rather than glowing on it.
   */
  wire: {
    name: 'metal_brushed', opts: {
      scale: 0.35, tint: 0x2a2c2e, vertexMasks: true, ...wear(0.5, 0.9, 0.2),
      roughness: [0.7, 0.10, 0.14], normalStrength: 0.5,
      detail: [0, 0.5, 0.2, 8], meso: [0.055, 0.1, 0.05, 0],
    },
  },
  rust: {
    name: 'metal_rust', opts: {
      scale: 0.8, vertexMasks: true, ...wear(0.9, 0.9, 0.6),
      grime: [0.7, 2.6, 1.0, 0.55],
    },
  },
  steel: {
    name: 'plate_steel', opts: { scale: 1.1, vertexMasks: true, ...wear(0.7, 0.8, 0.5) },
  },
  corrugated: {
    name: 'corrugated', opts: { scale: 1.0, vertexMasks: true, ...wear(0.8, 0.9, 0.5) },
  },
  concrete_prop: {
    name: 'concrete', opts: {
      scale: 0.55, vertexMasks: true, ...wear(0.7, 0.9, 0.6),
      grime: [0.65, 1.4, 1.0, 0.4], roughness: [1, 0.05, 0.35],
    },
  },
  kerbstone: {
    name: 'kerb', opts: { scale: 0.7, vertexMasks: true, ...wear(0.8, 0.95, 0.6) },
  },
  wood_prop: {
    name: 'wood', opts: {
      scale: 0.45, vertexMasks: true, ...wear(0.85, 0.9, 0.55),
      grime: [0.6, 1.6, 1.0, 0.45], roughness: [1, 0.08, 0.3],
    },
  },
  wood_grey: {
    name: 'wood', opts: {
      scale: 0.45, tint: 0x8d8a80, vertexMasks: true, ...wear(0.9, 0.95, 0.6),
      grime: [0.75, 1.8, 1.0, 0.5],
    },
  },
  brickface: {
    name: 'pgh_brick_old', opts: { scale: 1.6, vertexMasks: true, ...wear(0.6, 0.9, 0.5) },
  },

  // ------------------------------------------------------------ plastics --
  plastic: {
    name: 'trim_plastic', opts: {
      scale: 0.5, vertexMasks: true, ...wear(0.5, 0.9, 0.5), roughness: [1, 0.05, 0.2],
    },
  },
  plastic_red: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0xd6503a, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  plastic_blue: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0x3f7ec0, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  plastic_green: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0x44855a, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  bag: {
    // 0x1b1c1e (RGB 27,28,30) at 0.85 roughness caught almost no light, so a
    // refuse sack in any shadow read as a black VOID — a hole in the pavement,
    // not an object. A real bin bag is a dark charcoal that still takes a sheen
    // of skylight on its top folds. Lifted the tint to 0x33353a and dropped the
    // base roughness so the crown catches enough light to show the lumpy form.
    name: 'rubber', opts: {
      scale: 0.4, tint: 0x33353a, vertexMasks: true, ...wear(0.35, 0.7, 0.6),
      roughness: [0.72, 0.04, 0.2],
    },
  },
  tyre: {
    name: 'tyre', opts: { scale: 0.4, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  cardboard: {
    name: 'burlap', opts: {
      scale: 0.55, tint: 0xa48a68, vertexMasks: true, ...wear(0.85, 0.95, 0.5),
      roughness: [1, 0.15, 0.5],
    },
  },

  // -------------------------------------------------------------- fabric --
  awning_red: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0xb0453a, vertexMasks: true, ...wear(0.7, 0.7, 0.35),
      cloth: [0.42, 0.78, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },
  awning_green: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0x4b7458, vertexMasks: true, ...wear(0.7, 0.7, 0.35),
      cloth: [0.42, 0.78, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },
  awning_cream: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0xcfc0a0, vertexMasks: true, ...wear(0.8, 0.7, 0.35),
      cloth: [0.45, 0.8, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },

  // --------------------------------------------------------------- glass --
  glass_prop: {
    name: 'glass', opts: {
      scale: 1.2, three: { transparent: true, opacity: 0.30, side: THREE.DoubleSide },
    },
  },

  // ------------------------------------------------------------ signfaces --
  sign_white: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xd8d6cf, vertexMasks: true, ...wear(0.9, 0.85, 0.4),
      roughness: [0.9, -0.05, 0.34], grime: [0.55, 3.0, 0.8, 0.6], ...PAINTED,
    },
  },
  sign_green: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x1f5b3a, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [0.9, -0.04, 0.34], ...PAINTED,
    },
  },
  sign_blue: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x1d3f77, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },
  sign_amber: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xc9821c, vertexMasks: true, ...wear(0.95, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },
  sign_red: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x9c2018, vertexMasks: true, ...wear(0.95, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },

  /**
   * ────────────────────────────────────────────────────────────────────────
   * LETTERING. The three inks the sign painter of this city owns.
   * ────────────────────────────────────────────────────────────────────────
   *
   * These carry the WORDS — see the STEEL CITY TYPE section of `kit_sign.js`.
   * A shop name is stroke geometry, not a texture, so the whole signage layer
   * costs nothing in the texture budget: `materials._bakeKey` is
   * `name|size|seed|tintA|tintB|param|relief|worldSize` and `tint` is NOT in
   * it, so every entry below resolves onto the SAME `metal_painted` bake that
   * `pole_dark`, `sign_white` and the tags already made resident. MEASURED as
   * the reason this design was chosen over a canvas atlas: one 1024 RGBA atlas
   * with mips is 5.3 MiB and the city is already 47 MiB over its soft cap.
   *
   * Three and only three, because each one that a tile touches is a draw call
   * (`TileBatch.build` merges per surface key). Ink, pale and gilt is the whole
   * palette of shopfront lettering between 1910 and 1975, and the layout picks
   * between them for CONTRAST against the board it is painting on rather than
   * for variety.
   */
  /** Sign-writer's black — the default, on cream, white and gilt-edged boards. */
  sign_ink: {
    name: 'metal_painted', opts: {
      scale: 0.55, tint: 0x14171b, vertexMasks: true, ...wear(0.95, 0.85, 0.35),
      roughness: [0.95, 0.04, 0.36], grime: [0.55, 3.0, 0.8, 0.6],
      wearMaterial: [0.55, 0, 0, 0.45], ...PAINTED,
    },
  },
  /** Bone white / cream, for lettering on a dark board or a green blade. */
  sign_pale: {
    name: 'metal_painted', opts: {
      scale: 0.55, tint: 0xece3cd, vertexMasks: true, ...wear(0.95, 0.85, 0.35),
      roughness: [0.92, 0.05, 0.36], grime: [0.6, 3.0, 0.85, 0.6],
      wearMaterial: [0.55, 0, 0, 0.45], ...PAINTED,
    },
  },
  /**
   * GOLD LEAF ON GLASS — downtown, and the one place `PAINTED` does not apply.
   * Leaf IS metal: it is beaten gold burnished onto a size, so it keeps a
   * conductor's specular and goes almost black in shadow, which is exactly what
   * separates a jeweller's door from a painted board two streets away.
   */
  sign_gilt: {
    name: 'metal_painted', opts: {
      scale: 0.5, tint: 0xc79a2e, vertexMasks: true, ...wear(0.8, 0.7, 0.35),
      roughness: [0.42, 0.06, 0.16], three: { metalness: 0.82 },
      grime: [0.5, 3.0, 0.7, 0.5],
    },
  },

  /**
   * SIGNBOARD FACES. Painted sheet, not a light. The first pass made the whole
   * fascia an emissive panel and by daylight every shopfront was a flat cream
   * rectangle with no texture in it — a direct hit on the "no flat/untextured
   * surfaces" rule. Only the channel letters glow.
   */
  panel_cream: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0xcfc0a4, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_navy: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x24384f, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_maroon: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x5b2622, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_forest: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x233c2c, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },

  // ---------------------------------------------------------- vegetation --
  bark_street: {
    name: 'bark', opts: { scale: 0.85, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  bark_plane: {
    name: 'bark_plane', opts: { scale: 0.9, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  bark_smooth: {
    name: 'bark_smooth', opts: { scale: 0.8, vertexMasks: true, ...wear(0.35, 0.85, 0.55) },
  },

  /**
   * FOLIAGE — four numbers here decide whether a tree reads, and every one of
   * them has been wrong at some point. In order of how much damage they do:
   *
   * `three.alphaTest` — THE DISTANCE FUNCTION. There is no MSAA in this
   *   renderer (HDR post, so no alpha-to-coverage) and nothing rescales the
   *   cutout's alpha down the mip chain. At 0.42 a canopy past about sixty
   *   metres kept only the texels where two blades overlapped and collapsed
   *   into chunky rectangular blocks with holes — the "blocky, ragged clumps"
   *   defect. At 0.21 the mip-averaged card fills IN instead of falling apart,
   *   so a far crown reads as a soft mass, and near the camera the leaf edge
   *   gains a fraction of a millimetre and gets softer rather than harder.
   *
   * `bake.param.y` — DENSITY, and it is the ceiling on how solid a card can be.
   *   The bake draws one ellipse of ~0.26 cell^2 per cell, so even at 1.0 a
   *   card is only a quarter covered; anything less and the crown is an
   *   early-spring tree that has not come into leaf. Held at 1.0 everywhere.
   *
   * `wear[1]` — GRIME, and `grimeColor` on this surface is a near-black soot.
   *   Leaves get dusty, not filthy: at 0.55, with a canopy that pushed the mask
   *   toward 1.0 in the crown interior, half the cards rendered at a fifth of
   *   their authored albedo, which is the "black speckle that reads as dirt or
   *   missing texels". Grime is now a third of what it was and the crown
   *   interior is darkened with AO instead — which is what is physically there.
   *
   * `cloth[0]` — TRANSMISSION. This is the OW_CLOTH forward-scatter lobe, the
   *   single thing that separates a leaf from a piece of card: a blade between
   *   the camera and the sun has to GLOW and its veins have to show as dark
   *   lines inside that glow. It had been trimmed to 0.34; the library authored
   *   0.55 and foliage wants more than that, not less.
   *
   * The WEAR channel stays near zero: `wearColor` is a grey stone tint, perfect
   * for a chipped kerb and poison for a leaf — at 0.55 the outer half of every
   * canopy washed to pale sage and the street read as a dusty olive grove.
   */
  leaf_a: {
    name: 'leaf', opts: {
      /**
       * The tint is a MULTIPLY on albedo, so a colour whose green:red ratio is
       * higher than the bake's own saturates the leaf instead of washing it.
       * Under a bright sky IBL an unmodified dark-green card renders as pale
       * sage — the canopy loses its colour long before it loses its shape.
       */
      vertexMasks: true, wear: [0.05, 0.20, 0.62, 0], tint: 0x93c95e,
      cloth: [0.48, 0.50, 0.0, 0], macro: [0.42, 0.22, 0.20, 0.55],
      bake: { param: [0.06, 1.0, 0.10, 0] }, roughness: [1, 0.05, 0.54],
      three: {
        alphaTest: 0.21, sheen: 0.14, sheenColor: 0x9ec469, sheenRoughness: 0.72,
      },
    },
  },
  leaf_b: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.05, 0.18, 0.60, 0], tint: 0xafd96e,
      cloth: [0.52, 0.48, 0.0, 0], macro: [0.30, 0.24, 0.22, 0.6],
      bake: { seed: 181, param: [0.02, 1.0, 0.08, 0] }, roughness: [1, 0.05, 0.54],
      three: {
        alphaTest: 0.21, sheen: 0.13, sheenColor: 0xb0cf72, sheenRoughness: 0.68,
      },
    },
  },
  leaf_c: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.06, 0.24, 0.58, 0], tint: 0x76a94c,
      cloth: [0.46, 0.52, 0.0, 0], macro: [0.55, 0.22, 0.18, 0.5],
      bake: { seed: 233, param: [0.18, 1.0, 0.18, 0] }, roughness: [1, 0.05, 0.56],
      three: {
        alphaTest: 0.21, sheen: 0.12, sheenColor: 0x86a05c, sheenRoughness: 0.76,
      },
    },
  },
  /**
   * AUTUMN IS THREE SURFACES, NOT ONE, AND THE SEASON DOES THE WORK.
   *
   * There used to be a single `leaf_autumn`, so every turning tree in the city
   * was the same orange and two of them within sight of each other read as one
   * asset instanced twice. The three greens above already vary by `bake.seed`
   * and `param`; autumn had never been given the same treatment.
   *
   * WHAT MAKES THEM DIFFERENT IS `bake.param.x`, NOT THE TINT, and that
   * distinction is the whole design. `LEAF_CARD` mixes summer green into
   * `mix(cAutumn, cDry, per-leaf)` by `smoothstep(0.55, 1.0, season)`, so
   * season decides HOW MANY of the leaves on one card have turned and how far,
   * per leaf. A tint cannot do that: it is one multiply over the whole card, so
   * a tinted orange tree is uniformly orange and a half-turned tree is the one
   * thing it can never be. Measured off the curve the shader actually uses:
   *
   *   season 0.76  ->  45 % turned   green with gold coming through it
   *   season 0.93  ->  93 % turned   the orange tree that was already here
   *   season 1.00  -> 100 % turned   the deep end, autumn and dry per leaf
   *
   * The tint then sets WHICH autumn each one is, and it is a MULTIPLY, so the
   * rule from `leaf_a` applies with its sign flipped: `cAutumn` has a red:green
   * ratio of 1.79, and a tint above that saturates the leaf toward russet while
   * one below it washes the card back toward sand. `_c` is at 1.96 on purpose.
   *
   * `bake.seed` and `param.z` (blade shape) vary too. They cost nothing extra
   * — `_bakeKey` already keys on `param`, so these are separate bakes whatever
   * the seed says — and without them the three would share one blade layout
   * and read as one tree recoloured, which is the defect one level down.
   */
  leaf_autumn: {
    name: 'leaf_autumn', opts: {
      vertexMasks: true, wear: [0.05, 0.22, 0.58, 0], cloth: [0.50, 0.54, 0.0, 0],
      tint: 0xe8bd86, macro: [0.45, 0.24, 0.20, 0.55], roughness: [1, 0.05, 0.54],
      bake: { param: [0.93, 1.0, 0.16, 0] },
      three: { alphaTest: 0.21, sheen: 0.14, sheenColor: 0xd7a765, sheenRoughness: 0.7 },
    },
  },
  /** ON THE TURN — a canopy still half green, gold coming up through it. */
  leaf_autumn_b: {
    name: 'leaf_autumn', opts: {
      vertexMasks: true, wear: [0.05, 0.20, 0.60, 0], cloth: [0.52, 0.52, 0.0, 0],
      tint: 0xe0d074, macro: [0.38, 0.24, 0.20, 0.55], roughness: [1, 0.05, 0.54],
      bake: { seed: 197, param: [0.76, 1.0, 0.10, 0] },
      three: { alphaTest: 0.21, sheen: 0.15, sheenColor: 0xc9bd66, sheenRoughness: 0.68 },
    },
  },
  /** FULLY OVER — russet and dry, the last week before the street is bare. */
  leaf_autumn_c: {
    name: 'leaf_autumn', opts: {
      vertexMasks: true, wear: [0.06, 0.26, 0.56, 0], cloth: [0.48, 0.56, 0.0, 0],
      tint: 0xdc7038, macro: [0.52, 0.24, 0.18, 0.5], roughness: [1, 0.05, 0.56],
      bake: { seed: 251, param: [1.0, 1.0, 0.34, 0] },
      three: { alphaTest: 0.21, sheen: 0.12, sheenColor: 0xb86a3c, sheenRoughness: 0.74 },
    },
  },
  leaf_needle: {
    name: 'leaf_needle', opts: {
      vertexMasks: true, wear: [0.05, 0.22, 0.55, 0], tint: 0x8ab478,
      cloth: [0.44, 0.48, 0.0, 0],
      bake: { param: [0.30, 1.0, 1.0, 0] },
      three: { alphaTest: 0.21 },
    },
  },
  scrub: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.07, 0.30, 0.52, 0], tint: 0x86b455,
      cloth: [0.48, 0.54, 0.0, 0], macro: [0.6, 0.26, 0.22, 0.5],
      bake: { seed: 311, param: [0.16, 1.0, 0.30, 0] }, roughness: [1, 0.05, 0.56],
      three: { alphaTest: 0.21, sheen: 0.12 },
    },
  },
  /**
   * GRASS BLADES. The clump is real tapered geometry now (see `kit_green.js`),
   * so this only has to supply colour along the blade — hence `uvMode: 'mesh'`,
   * which reads the narrow vertical UV streak each blade was authored with.
   * The old entry was a WORLD-PLANAR ground texture on a standing quad: a lawn
   * stood on its edge, which is precisely the "green fur" read.
   */
  grass_blade: {
    name: 'grass_verge', opts: {
      uvMode: 'mesh', scale: 1, vertexMasks: true, wear: [0.10, 0.35, 0.55, 0],
      tint: 0xbfd98a, cloth: [0.55, 0.45, 0.0, 0],
      three: { side: THREE.DoubleSide, roughness: 0.85 },
    },
  },
  grass_tuft: {
    name: 'grass_dry', opts: {
      scale: 0.5, vertexMasks: true, ...wear(0.6, 0.8, 0.4),
      three: { side: THREE.DoubleSide },
    },
  },
  verge: {
    name: 'grass_verge', opts: { scale: 1.4, vertexMasks: true, ...wear(0.5, 0.8, 0.5) },
  },
  soil: {
    name: 'mud', opts: { scale: 0.8, vertexMasks: true, ...wear(0.4, 0.9, 0.7) },
  },

  // ------------------------------------------------------ paint on walls --
  /**
   * A GHOST SIGN: half a century of weather on a hand-painted advert across a
   * brick gable. Blended, not opaque, so the brick course still reads through
   * it, and the wear mask eats it back to nothing at the arris.
   */
  ghost: {
    name: 'plaster', opts: {
      scale: 2.4, tint: 0xc8b79a, vertexMasks: true, wear: [1.0, 0.9, 0.3, 0],
      grime: [0.8, 6.0, 0.6, 0.5], roughness: [1, 0.1, 0.4],
      three: {
        transparent: true, opacity: 0.38, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        side: THREE.DoubleSide,
      },
    },
  },
  /**
   * THE INK of a ghost sign. It has to be a SEPARATE surface from the field:
   * lettering drawn in the field's own material is lettering you cannot see, and
   * the gable then reads as a blank tan rectangle bolted to a brick wall — which
   * is what a critic panel logged as "blank white rectangles standing in for
   * signage". Old lead-white paint over a red field, chalked back to nothing at
   * the top where fifty years of rain got at it first.
   */
  ghost_ink: {
    name: 'plaster', opts: {
      scale: 1.7, tint: 0x6d4a3c, vertexMasks: true, wear: [1.0, 0.85, 0.25, 0],
      grime: [0.75, 6.0, 0.7, 0.55], roughness: [1, 0.12, 0.45],
      three: {
        transparent: true, opacity: 0.46, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
        side: THREE.DoubleSide,
      },
    },
  },
  /** Flyposting. Paper goes grey, curls and tears; four colourways of it. */
  poster_a: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xb8452f, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_b: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0x2a4f86, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_c: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xc9b871, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_d: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xdad4c8, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  /** Aerosol. Bright, flat, slightly gloss, and raised a few millimetres. */
  tag_a: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0xdd2f6a, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_b: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0x2fd9c9, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_c: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0xf0e24a, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_d: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0x17181c, vertexMasks: true, ...wear(0.75, 0.7, 0.3),
      roughness: [0.95, 0.02, 0.36], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  chalkboard: {
    name: 'metal_painted', opts: {
      scale: 0.5, tint: 0x1b201d, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [1, 0.1, 0.5], ...PAINTED,
    },
  },

  // ------------------------------------------------------------ COLOR PARK --
  /**
   * AEROSOL, IN QUANTITY — the eight cans Color Park is painted out of, plus
   * the tarmac they are sprayed on. See `props/colorpark.js`.
   *
   * WHY THESE ARE THEIR OWN KEYS AND NOT `tag_a..d`. There are four aerosol
   * surfaces in this file and they are authored for a TAG: a scrawl a metre
   * across on a rowhouse gable, at a wear and grime that says "this has been
   * here two winters". A legal wall is the opposite claim — the paint is
   * fresh, it is the brightest thing in the frame, and there is 150 m of it —
   * so it wants its own tints and a fraction of the weathering. Tinted
   * variants of ONE bake (`metal_painted`, the same one every painted sign in
   * the city already resolves onto), so eight more colours cost eight material
   * records and zero extra texture memory. That is the whole reason this file
   * is a table of tints (see the header).
   *
   * `polygonOffset` on every one of them: they lie ON a surface — the tarmac
   * on the terrain, the murals on the retaining wall — and a millimetre of
   * depth bias is cheaper and steadier than lifting them until the shadow
   * separates.
   */
  cp_tarmac: {
    name: 'road_asphalt_worn', opts: {
      scale: 3.2, tint: 0x2b2a2c, vertexMasks: true, ...wear(0.55, 0.8, 0.45),
      roughness: [1, 0.06, 0.62],
      three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    },
  },
  cp_pink: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xff2f7a, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  cp_teal: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x18e0c8, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  cp_yellow: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xffd21e, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  cp_blue: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x2b6bff, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  cp_orange: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xff7418, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  cp_green: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x63e02a, vertexMasks: true, ...wear(0.26, 0.3, 0.22),
      roughness: [0.85, 0.03, 0.32], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 },
    },
  },
  /** The two cans every writer owns: an outline black and a highlight white. */
  cp_black: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x101014, vertexMasks: true, ...wear(0.24, 0.34, 0.28),
      roughness: [0.92, 0.03, 0.36], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 },
    },
  },
  cp_white: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xf2f4ef, vertexMasks: true, ...wear(0.3, 0.38, 0.28),
      roughness: [0.9, 0.03, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
      three: { metalness: 0.09, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 },
    },
  },

  // ---------------------------------------------------------- road decals --
  /**
   * Everything here lies ON the road, so it renders after it. `world` already
   * paints lane lines, dashes, junction crossings, stop bars, gullies, manholes
   * and cut-and-fill patches (see `world/roadmesh.js`) — the props decal layer
   * deliberately only adds what it does NOT: kerb bay lines, utility spray
   * marks, oil, skid scuff and standing water.
   */
  decal_paint: {
    name: 'road_line', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_yellow: {
    name: 'road_line_yellow', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_arrow: {
    name: 'road_arrow', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_arrow_turn: {
    name: 'road_arrow_turn', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_hatch: {
    name: 'road_hatch', opts: { scale: 1, uvMode: 'mesh' },
  },
  oil: {
    name: 'road_asphalt_worn', opts: {
      scale: 1.6, tint: 0x151417, vertexMasks: true, ...wear(0.2, 1, 0.7),
      three: { transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  /**
   * STANDING WATER. Not the river material — a puddle is a thin mirror lying in
   * a hollow. Near-zero roughness so it takes the sky, the sodium lamps and
   * whatever SSR can find, and blended at the rim so it does not read as a
   * cut-out sticker.
   */
  puddle: {
    name: 'road_asphalt', opts: {
      scale: 3.0, tint: 0x141619, vertexMasks: true, wear: [0, 0.35, 0.6, 0],
      roughness: [0.05, 0.0, 0.02], normalStrength: 0.15,
      detail: [0, 0.05, 0.02, 6], meso: [0.055, 0.04, 0.02, 0.0],
      weather: [0, 0, 0, 0], wet: [1, 1, 1, 1],
      three: {
        transparent: true, opacity: 0.88, depthWrite: false, metalness: 0.0,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      },
    },
  },
  tarpatch: {
    name: 'road_asphalt_patched', opts: {
      scale: 1.4, vertexMasks: true, ...wear(0.4, 0.9, 0.4),
      three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    },
  },
  gravelbed: {
    name: 'gravel', opts: { scale: 1.0, vertexMasks: true, ...wear(0.4, 0.8, 0.5) },
  },
};

/**
 * EMISSIVE surfaces are built here rather than fetched: `materials` produces
 * physically-shaded PBR, and a neon tube is a light source, not a surface.
 * Their intensity is driven from the sun altitude every frame — a night city is
 * thousands of signs and `q.lightSlots` is eight, so this is emissive + bloom,
 * exactly as ARCHITECTURE.md requires.
 *
 * `base` is the daytime intensity; the night multiplier is applied on top.
 */
export const EMISSIVE = {
  sodium_lamp: { color: 0xffc17a, base: 0.22, night: 5.5, rough: 0.35 },
  /**
   * The pool of light a sodium lamp throws on the road, and — measured, not
   * assumed — the only thing lighting the carriageway beyond the two or three
   * lamps that hold a real punctual slot. With it switched off entirely, the
   * road centreline beside the five nearest carriageway lamps on `night` reads
   * 8.4 / 5.9 / 13.7 / 23.7 / 28.5 of 255. It is not a hint any more; the
   * comment here used to call it one.
   *
   * ONLY `peak` DRIVES IT. `base` and `night` are the non-additive path's
   * fields (`props._driveLights`) and this entry used to carry both, inert, at
   * 0.0 and 1.0 — a knob that looks live and moves nothing.
   *
   * `peak` IS HALF THE BRIGHTNESS. The other half is the vertex ramp in
   * `kit_street.js` (`POOL_PEAK`), so what actually reaches the road is
   *
   *     peak x POOL_PEAK x litMix^2       0.045 x 0.72 = 0.0324 at full night
   *
   * and the two were tuned in separate passes by people who could each only see
   * their own half. Read them together or not at all.
   *
   * COLOUR IS WHY THIS NUMBER MOVED, not brightness. The pool ran at
   * `SODIUM_DEEP` while the punctual light from the SAME lamp head runs at
   * `SODIUM` (`props.SODIUM_LIGHT`) — i.e. the bounce off the asphalt was more
   * saturated than the source that made it, which is backwards in the one
   * direction a surface cannot be: reflected light picks up the surface's grey
   * and the ambient, it does not gain chroma. An additive layer that saturated
   * is a filter over everything it covers, and it is what turned the near
   * carriageway and the footway beside it into one hueless orange sheet.
   *
   * MEASURED on `night`, 1280x720, one boot, one variable at a time — road
   * centreline luminance beside the five nearest carriageway lamps (mean), and
   * the r-b spread over the washed region as the "how orange is it" number:
   *
   *   0.055 SODIUM_DEEP   crown mean 41.8   r-b 54.2   shipped before this
   *   0.0403 SODIUM       crown mean 43.1   r-b 36.4   luminance-matched swap
   *   0.045 SODIUM        crown mean 45.2   r-b 37.8   shipped
   *   0.050 SODIUM        crown mean 47.6   r-b 39.6
   *   0.045 0xffa050      crown mean 42.6   r-b 42.5   half-way hue, worse both
   *
   * So the swap buys a THIRD off the chroma and the road gets brighter rather
   * than darker, because luminance per unit opacity is higher at the lighter
   * hue. 0.045 banks 3.4 of that as crown headroom and leaves the rest.
   *
   * WHY NOT MORE. Additive light knows nothing about albedo, so every stop it
   * gains compresses the ratio between asphalt and the concrete kerb beside it:
   * MEASURED at the nearest lamp, road:pavement runs 8.4:91 unlit, 37.3:131.5
   * at the old value and 42.1:137.8 here — a real surface holds ~1:4 and the
   * fill is walking it toward 1:3. Past this the frame reads as a decal, which
   * is the failure the sweep in `kit_street.js` documents from the other side.
   * The next stop for a brighter road is REAL light (`props._submitLamps`, and
   * its budget scales with `q.lightSlots` now) or a narrower pool, not a bigger
   * number here.
   */
  sodium_glow: { color: SODIUM, additive: true, peak: 0.045 },
  /**
   * INTENSITY SCALES WITH AREA, NOT WITH IMPORTANCE. A 22 mm neon tube can sit
   * five stops over white and still read as a tube, because bloom has almost
   * no area to smear. A 4 m lit sign box at the same intensity is a blown white
   * slab with no shape in it — which is exactly what the first night capture
   * showed. So the thin emitters run hot and the broad ones run cool.
   */
  neon_amber: { color: 0xff9a2e, base: 0.12, night: 3.8 },
  neon_teal: { color: 0x2ee2d0, base: 0.12, night: 3.4 },
  neon_violet: { color: 0xc07cff, base: 0.12, night: 3.4 },
  neon_red: { color: 0xff3b30, base: 0.13, night: 3.6 },
  neon_white: { color: 0xdfe8ff, base: 0.12, night: 3.0 },
  signal_red: { color: 0xff2a18, base: 0.5, night: 2.6 },
  signal_amber: { color: 0xffa018, base: 0.5, night: 2.6 },
  signal_green: { color: 0x22ff77, base: 0.5, night: 2.6 },
  /**
   * Broad area: an ad panel or an illuminated menu case.
   *
   * RE-TUNED AGAINST THE LANDED EXPOSURE FIX. These two were deliberately held
   * near zero to survive a meter that wound to 13.77 on a night frame against a
   * ceiling of 15 — at that gain any broad emitter was a white slab. `render`
   * has since added the night compensation curve (`exposure.js` uNight) and the
   * same frame now settles at ~5.3, so the compensation here is 2.5 stops of
   * darkness that nothing is asking for any more: measured on `night`, p99 is
   * 174/255 with 0.08% of pixels blown, i.e. there is headroom and the city's
   * shopfronts were simply unlit. The AREA argument above still holds, so these
   * stay well under the neon — they are just no longer invisible.
   */
  shop_lit: { color: 0xffcf93, base: 0.11, night: 0.85 },
  /**
   * The plane of light behind a shop window. It exists ONLY after dark — by day
   * it would be a flat pale rectangle sitting inside the glass.
   */
  window_glow: { color: 0xffd6a4, base: 0, night: 0.95, nightOnly: true },
  /**
   * ────────────────────────────────────────────────────────────────────────
   * THE NEON HALO — the only additive surface in the signage layer.
   * ────────────────────────────────────────────────────────────────────────
   *
   * A neon tube in air is not just a bright line: the discharge lights the
   * dust and the glazing around it, and at 22 mm the tube itself is far too
   * small an area for bloom to build that out of. So the word carries a card
   * BEHIND it whose vertex mask ramps to zero at the rim — the same trick
   * `sodium_glow` uses on the road, and for the same reason: an additive
   * surface multiplied to black contributes nothing, so the disc has no edge.
   *
   * TWO ENTRIES, NOT FIVE. Halo colour has to follow the tube — an amber halo
   * behind a teal word is a filter, which is the exact defect `sodium_glow`'s
   * comment documents from the other side — but every entry here is a draw
   * call on any tile that touches it, so the five tube colours collapse onto
   * the warm/cool pair they actually divide into.
   *
   * `peak` is a quarter of `sodium_glow`'s. A halo is a metre across against a
   * lamp pool's eight, and additive brightness is area times opacity.
   */
  neon_halo_warm: { color: 0xff9a4e, additive: true, peak: 0.012 },
  neon_halo_cool: { color: 0x7fe4e8, additive: true, peak: 0.011 },
};

/** Neon colour rotation per district — this is how a district reads at night. */
export const DISTRICT_NEON = {
  downtown: ['neon_teal', 'neon_white', 'neon_amber', 'neon_violet'],
  point: ['neon_teal', 'neon_white'],
  strip: ['neon_red', 'neon_amber', 'neon_white'],
  lawren: ['neon_amber', 'neon_red', 'neon_teal'],
  northsh: ['neon_teal', 'neon_white', 'neon_amber'],
  troy: ['neon_amber', 'neon_red'],
  southside: ['neon_violet', 'neon_amber', 'neon_red'],
  mtwash: ['neon_amber', 'neon_white'],
  steelrow: ['neon_amber', 'neon_red'],
  westend: ['neon_amber', 'neon_teal'],
  northside: ['neon_amber', 'neon_white'],
  hazel: ['neon_red', 'neon_amber'],
};

/**
 * DISTRICT DRESSING WEIGHTS.
 *
 * What each district actually has on its street — this is most of what makes
 * twelve districts read as twelve places rather than one kit laid down twelve
 * times. `trees` and `litter` are densities; `kind` biases which furniture and
 * signage families get picked.
 */
export const DISTRICT_STYLE = {
  downtown: { trees: 0.75, litter: 0.55, meters: 1.0, signage: 1.0, wires: 0.25, scaffold: 0.5, lampKind: 'twin', hydrant: 1.0, benches: 0.8, kind: 'core' },
  point: { trees: 1.5, litter: 0.2, meters: 0.1, signage: 0.15, wires: 0.1, scaffold: 0.05, lampKind: 'park', hydrant: 0.4, benches: 1.4, kind: 'park' },
  strip: { trees: 0.35, litter: 1.4, meters: 0.7, signage: 1.3, wires: 0.9, scaffold: 0.7, lampKind: 'cobra', hydrant: 0.9, benches: 0.4, kind: 'market' },
  lawren: { trees: 0.95, litter: 0.9, meters: 0.5, signage: 1.0, wires: 1.0, scaffold: 0.5, lampKind: 'acorn', hydrant: 1.0, benches: 0.5, kind: 'row' },
  northsh: { trees: 0.9, litter: 0.5, meters: 0.8, signage: 0.7, wires: 0.5, scaffold: 0.4, lampKind: 'cobra', hydrant: 0.8, benches: 0.9, kind: 'civic' },
  troy: { trees: 1.1, litter: 0.6, meters: 0.15, signage: 0.45, wires: 1.2, scaffold: 0.2, lampKind: 'acorn', hydrant: 0.7, benches: 0.3, kind: 'row' },
  southside: { trees: 0.55, litter: 1.1, meters: 0.4, signage: 1.1, wires: 1.1, scaffold: 0.5, lampKind: 'cobra', hydrant: 0.9, benches: 0.4, kind: 'row' },
  mtwash: { trees: 1.2, litter: 0.45, meters: 0.1, signage: 0.35, wires: 1.15, scaffold: 0.15, lampKind: 'acorn', hydrant: 0.6, benches: 0.7, kind: 'hill' },
  steelrow: { trees: 0.2, litter: 1.5, meters: 0.05, signage: 0.5, wires: 1.4, scaffold: 0.9, lampKind: 'cobra', hydrant: 0.6, benches: 0.1, kind: 'mill' },
  westend: { trees: 1.0, litter: 0.55, meters: 0.1, signage: 0.4, wires: 1.15, scaffold: 0.2, lampKind: 'acorn', hydrant: 0.6, benches: 0.4, kind: 'hill' },
  northside: { trees: 0.9, litter: 0.7, meters: 0.25, signage: 0.6, wires: 1.1, scaffold: 0.35, lampKind: 'acorn', hydrant: 0.8, benches: 0.5, kind: 'row' },
  hazel: { trees: 0.6, litter: 1.2, meters: 0.1, signage: 0.5, wires: 1.25, scaffold: 0.4, lampKind: 'cobra', hydrant: 0.7, benches: 0.25, kind: 'mill' },
};

export const DEFAULT_STYLE = DISTRICT_STYLE.lawren;

/** ARCHITECTURE.md surface tags, for the collision proxies props registers. */
export const SURFACE_TAG = {
  pole_dark: 'metal', pole_green: 'metal', pole_grey: 'metal', galv: 'metal',
  rust: 'metal', steel: 'metal', corrugated: 'metal', concrete_prop: 'concrete',
  kerbstone: 'concrete', wood_prop: 'wood', wood_grey: 'wood', brickface: 'concrete',
  plastic: 'plastic', bag: 'fabric', tyre: 'rubber', glass_prop: 'glass',
  sign_ink: 'metal', sign_pale: 'metal', sign_gilt: 'metal',
  bark_street: 'wood', bark_plane: 'wood', bark_smooth: 'wood',
  leaf_a: 'foliage', leaf_b: 'foliage', leaf_autumn: 'foliage',
  leaf_autumn_b: 'foliage', leaf_autumn_c: 'foliage',
  leaf_needle: 'foliage',
  leaf_c: 'foliage', scrub: 'foliage', grass_tuft: 'foliage',
  grass_blade: 'grass', verge: 'grass',
  soil: 'dirt', gravelbed: 'gravel',
};
