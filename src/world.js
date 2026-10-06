import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const damp = (a, b, lambda, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const x = c.getContext('2d');
  draw(x, width, height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function textTexture(title, subtitle = '', options = {}) {
  const bg = options.bg || '#090a0b';
  const fg = options.fg || '#f0e8d8';
  const accent = options.accent || '#b88f57';
  const align = options.align || 'center';
  const serif = options.serif !== false;
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,255,255,.025)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(46, h - 36);
    ctx.lineTo(w - 46, h - 36);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = fg;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.font = serif ? '44px Georgia' : '600 38px Arial';
    const x = align === 'left' ? 48 : w / 2;
    ctx.fillText(title, x, h * 0.42);
    if (subtitle) {
      ctx.fillStyle = 'rgba(240,232,216,.68)';
      ctx.font = '500 20px Arial';
      ctx.fillText(subtitle, x, h * 0.68);
    }
  });
}

function posterTexture(seed, headline, sub = '') {
  const rnd = seeded(seed);
  return canvasTexture(512, 704, (ctx, w, h) => {
    const tones = ['#0c0c0d', '#1b1814', '#17191c', '#14120f'];
    ctx.fillStyle = tones[Math.floor(rnd() * tones.length)];
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(w * .45, h * .30, 20, w * .45, h * .3, w * .7);
    grad.addColorStop(0, 'rgba(236,228,210,.32)');
    grad.addColorStop(1, 'rgba(236,228,210,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w * .5, h * .35);
    ctx.rotate((rnd() - .5) * .16);
    ctx.fillStyle = 'rgba(236,228,210,.18)';
    if (rnd() > .5) {
      ctx.beginPath();
      ctx.arc(0, 0, 115 + rnd() * 55, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0e0e0f';
      ctx.beginPath();
      ctx.arc(0, 0, 40 + rnd() * 38, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillRect(-150, -145, 300, 290);
      ctx.fillStyle = '#0d0e0f';
      ctx.fillRect(-75, -75, 150, 150);
    }
    ctx.restore();
    ctx.fillStyle = '#efe7d7';
    ctx.textAlign = 'left';
    ctx.font = '38px Georgia';
    ctx.fillText(headline, 38, h - 110);
    ctx.fillStyle = 'rgba(239,231,215,.55)';
    ctx.font = '18px Arial';
    ctx.fillText(sub || 'OBSIDIAN ATLAS / CULTURAL WORLD', 38, h - 68);
    ctx.strokeStyle = 'rgba(239,231,215,.25)';
    ctx.strokeRect(20, 20, w - 40, h - 40);
  });
}

function windowTexture(seed, warm = true) {
  const rnd = seeded(seed);
  return canvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#070808';
    ctx.fillRect(0, 0, w, h);
    const cols = 6;
    const rows = 9;
    const gapX = 13;
    const gapY = 12;
    const cellW = (w - gapX * (cols + 1)) / cols;
    const cellH = (h - gapY * (rows + 1)) / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const lit = rnd() > .36;
        const px = gapX + x * (cellW + gapX);
        const py = gapY + y * (cellH + gapY);
        if (lit) {
          if (warm) {
            ctx.fillStyle = 'rgba(255,' + (176 + Math.floor(rnd() * 48)) + ',' + (108 + Math.floor(rnd() * 34)) + ',' + (.44 + rnd() * .42) + ')';
          } else {
            ctx.fillStyle = 'rgba(' + (130 + Math.floor(rnd() * 55)) + ',' + (180 + Math.floor(rnd() * 55)) + ',255,' + (.30 + rnd() * .45) + ')';
          }
        } else {
          ctx.fillStyle = 'rgba(30,34,35,.42)';
        }
        ctx.fillRect(px, py, cellW, cellH);
      }
    }
  });
}

function createLabelPlane(text, subtitle, width, height, options = {}) {
  const tex = textTexture(text, subtitle, options);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: options.opacity == null ? 1 : options.opacity,
    toneMapped: false,
    side: THREE.DoubleSide
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
}

function createPoster(seed, title, subtitle, width = 3.1, height = 4.3) {
  const tex = posterTexture(seed, title, subtitle);
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
  );
}

function createStreetLight(x, z, warm = true, realLight = true) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(.06, .085, 4.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x181817, metalness: .72, roughness: .35 })
  );
  pole.position.y = 2.3;
  g.add(pole);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(.36, .24, .16, 12),
    new THREE.MeshStandardMaterial({ color: 0x171716, metalness: .72, roughness: .32 })
  );
  cap.position.y = 4.62;
  g.add(cap);
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(.16, 12, 8),
    new THREE.MeshBasicMaterial({ color: warm ? 0xffd08a : 0x9fdcff })
  );
  orb.position.y = 4.44;
  g.add(orb);
  if (realLight) {
    const light = new THREE.PointLight(warm ? 0xffb668 : 0x8fd6ff, warm ? 9 : 6, 16, 2);
    light.position.y = 4.25;
    light.userData.baseIntensity = light.intensity;
    g.add(light);
  }
  return g;
}

function createPerson(seed, umbrella = false) {
  const rnd = seeded(seed);
  const g = new THREE.Group();
  const dark = new THREE.Color().setHSL(.08 + rnd() * .08, .05, .055 + rnd() * .04);
  const coat = new THREE.MeshStandardMaterial({ color: dark, roughness: .92 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.22, 1.0, 4, 8), coat);
  body.position.y = 1.15;
  body.scale.set(.9 + rnd() * .25, .9 + rnd() * .18, .9 + rnd() * .2);
  g.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(.17, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x5b4438, roughness: .9 })
  );
  head.position.y = 2.08;
  g.add(head);
  if (umbrella) {
    const umb = new THREE.Mesh(
      new THREE.SphereGeometry(.74, 18, 8, 0, TAU, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x090a0b, roughness: .46, metalness: .12, side: THREE.DoubleSide })
    );
    umb.position.set(.18, 2.6, 0);
    umb.scale.y = .42;
    g.add(umb);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(.018, .018, 1.3, 6),
      new THREE.MeshStandardMaterial({ color: 0x18191a, metalness: .7, roughness: .3 })
    );
    stem.position.set(.18, 2.02, 0);
    g.add(stem);
  }
  g.userData.phase = rnd() * TAU;
  g.userData.walk = rnd() > .45;
  return g;
}

function createStorefront(spec, isMobile) {
  const g = new THREE.Group();
  g.position.set(spec.x, 0, spec.z);
  g.rotation.y = spec.side === 'left' ? Math.PI / 2 : -Math.PI / 2;
  const width = spec.width || 12;
  const height = spec.height || 8;
  const depth = spec.depth || 8;

  const building = new THREE.Mesh(
    new THREE.BoxGeometry(depth, height + 7, width),
    new THREE.MeshStandardMaterial({ color: spec.stone || 0x151513, roughness: .78, metalness: .08 })
  );
  building.position.set(spec.side === 'left' ? -depth / 2 - .2 : depth / 2 + .2, (height + 7) / 2, 0);
  building.castShadow = !isMobile;
  building.receiveShadow = true;
  g.add(building);

  const interior = new THREE.Mesh(
    new THREE.BoxGeometry(.32, height - 1.0, width - 1.0),
    new THREE.MeshBasicMaterial({ color: spec.lightColor || 0xffb86a })
  );
  interior.position.set(spec.side === 'left' ? -.18 : .18, (height - .5) / 2, 0);
  g.add(interior);

  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(width - .7, height - .7),
    new THREE.MeshPhysicalMaterial({
      color: 0x1f2528,
      transparent: true,
      opacity: .42,
      roughness: .08,
      metalness: .02,
      transmission: isMobile ? 0 : .12,
      clearcoat: 1,
      clearcoatRoughness: .12,
      side: THREE.DoubleSide
    })
  );
  glass.position.set(spec.side === 'left' ? .02 : -.02, height / 2, 0);
  glass.rotation.y = Math.PI / 2;
  g.add(glass);

  for (let i = -2; i <= 2; i++) {
    const mull = new THREE.Mesh(
      new THREE.BoxGeometry(.1, height - .5, .08),
      new THREE.MeshStandardMaterial({ color: 0x121211, metalness: .72, roughness: .35 })
    );
    mull.position.set(spec.side === 'left' ? .04 : -.04, height / 2, i * (width - .7) / 5);
    g.add(mull);
  }

  const sign = createLabelPlane(spec.name, spec.subtitle || '', width * .88, 2.0, {
    bg: '#08090a',
    fg: spec.signColor || '#f0e6d2',
    accent: spec.accent || '#b88f57',
    serif: true
  });
  sign.rotation.y = Math.PI / 2;
  sign.position.set(spec.side === 'left' ? .12 : -.12, height + .65, 0);
  g.add(sign);

  const glow = new THREE.PointLight(spec.lightColor || 0xffad66, isMobile ? 2.2 : 5.5, 13, 2);
  glow.position.set(spec.side === 'left' ? 1.1 : -1.1, 3.4, 0);
  glow.userData.baseIntensity = glow.intensity;
  glow.userData.store = spec.key;
  g.add(glow);

  for (let i = -2; i <= 2; i++) {
    const shelf = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, .08, .52),
      new THREE.MeshStandardMaterial({ color: 0x241d16, roughness: .74 })
    );
    shelf.rotation.y = Math.PI / 2;
    shelf.position.set(spec.side === 'left' ? -.48 : .48, 1.2 + (i + 2) * .78, i * 1.6);
    g.add(shelf);
  }

  return { group: g, glow, sign, spec };
}

export function createCulturalWorld(canvas) {
  const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 700;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isMobile,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = isMobile ? 1.22 : 1.38;
  renderer.setClearColor(0x101923, 1);
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, .04);
  envScene.dispose();
  pmrem.dispose();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x142231);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.0;
  scene.fog = new THREE.FogExp2(0x172431, isMobile ? .0105 : .0072);

  const camera = new THREE.PerspectiveCamera(isMobile ? 65 : 54, 1, .08, 500);
  camera.position.set(0, 1.72, 50);

  const world = new THREE.Group();
  scene.add(world);

  const hemi = new THREE.HemisphereLight(0x9db8d6, 0x3a2418, isMobile ? 1.8 : 2.35);
  scene.add(hemi);
  const cityFill = new THREE.AmbientLight(0x6e7f91, isMobile ? .62 : .82);
  scene.add(cityFill);

  const moon = new THREE.DirectionalLight(0xcfe0ff, isMobile ? 2.0 : 3.4);
  moon.position.set(-26, 58, 12);
  moon.castShadow = !isMobile;
  if (!isMobile) {
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -50;
    moon.shadow.camera.right = 50;
    moon.shadow.camera.top = 55;
    moon.shadow.camera.bottom = -55;
  }
  scene.add(moon);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(220, 28, 18),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x0b1b2d) },
        bottomColor: { value: new THREE.Color(0x4a3b32) },
        offset: { value: 18 },
        exponent: { value: .65 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main(){
          vec4 wp = modelMatrix * vec4(position,1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main(){
          float h = normalize(vWorldPosition + vec3(0.0,offset,0.0)).y;
          float f = max(pow(max(h,0.0),exponent),0.0);
          gl_FragColor = vec4(mix(bottomColor,topColor,f),1.0);
        }`,
      depthWrite: false
    })
  );
  scene.add(dome);

  const moonDisc = new THREE.Mesh(
    new THREE.CircleGeometry(2.8, 48),
    new THREE.MeshBasicMaterial({ color: 0xe8edf3, transparent: true, opacity: .7, toneMapped: false })
  );
  moonDisc.position.set(-54, 42, -120);
  moonDisc.lookAt(camera.position);
  scene.add(moonDisc);

  const streetMat = new THREE.MeshPhysicalMaterial({
    color: 0x101113,
    roughness: .15,
    metalness: .18,
    clearcoat: 1,
    clearcoatRoughness: .08
  });
  const street = new THREE.Mesh(new THREE.BoxGeometry(18, .22, 150), streetMat);
  street.position.set(0, -.12, -14);
  street.receiveShadow = true;
  world.add(street);

  const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x20201d, roughness: .76, metalness: .04 });
  for (const x of [-11.7, 11.7]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(5.2, .38, 150), sidewalkMat);
    walk.position.set(x, .06, -14);
    walk.receiveShadow = true;
    world.add(walk);
  }

  for (let i = 0; i < 28; i++) {
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(13.5, .01, .035),
      new THREE.MeshBasicMaterial({ color: 0x5c5c58, transparent: true, opacity: .08 })
    );
    line.position.set(0, .012, 52 - i * 5.3);
    world.add(line);
  }

  if (!isMobile) {
    const configs = [
      [-3.8, 36, 3.2, 1.1, -.16],
      [4.3, 14, 4.6, 1.3, .09],
      [-2.6, -10, 5.4, 1.0, -.04],
      [3.2, -36, 4.2, 1.2, .13]
    ];
    for (const [x,z,w,h,r] of configs) {
      const refl = new Reflector(new THREE.PlaneGeometry(w,h), {
        textureWidth: 512,
        textureHeight: 256,
        color: 0x0b0d10,
        clipBias: .002
      });
      refl.rotation.x = -Math.PI / 2;
      refl.rotation.z = r;
      refl.position.set(x,.015,z);
      world.add(refl);
    }
  }

  const stores = {};
  const storeSpecs = [
    { key:'records', name:'OBSIDIAN RECORDS', subtitle:'MUSIC · PEOPLE · PLACES', side:'left', x:-14.2, z:29, width:12.5, height:7.8, lightColor:0xffa34f, accent:'#c49a63' },
    { key:'books', name:'ATLAS BOOKS', subtitle:'IDEAS TRAVEL FURTHER', side:'left', x:-14.2, z:11, width:10.5, height:8.2, lightColor:0xffc37d, accent:'#a7b49b' },
    { key:'cinema', name:'ATLAS CINEMA', subtitle:'GOOD FILMS · BRIGHTER PEOPLE', side:'left', x:-14.2, z:-8, width:13.2, height:9.1, lightColor:0xffb07e, accent:'#d6c09c' },
    { key:'listening', name:'ATLAS LISTENING ROOM', subtitle:'SOUND AFTER DARK', side:'right', x:14.2, z:17, width:12.8, height:9.0, lightColor:0xff9c5a, accent:'#c4b590' },
    { key:'cafe', name:'ATLAS CAFÉ', subtitle:'OPEN LATE', side:'right', x:14.2, z:-3, width:11.2, height:7.6, lightColor:0xffa854, accent:'#a88d68' },
    { key:'atelier', name:'THE ATELIER', subtitle:'SEOUL · NEW YORK · LONDON', side:'right', x:14.2, z:-23, width:12.8, height:9.4, lightColor:0xffc27e, accent:'#d2c6a9' }
  ];
  for (const spec of storeSpecs) {
    const s = createStorefront(spec, isMobile);
    world.add(s.group);
    stores[spec.key] = s;
  }

  const facadeMats = [
    new THREE.MeshStandardMaterial({ color: 0x161615, roughness: .86 }),
    new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: .78 }),
    new THREE.MeshStandardMaterial({ color: 0x111315, roughness: .82 })
  ];
  let buildingSeed = 100;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const z = 47 - i * 13.6;
      const x = side * (19 + (i % 3) * 2.8);
      const w = 10 + (i % 2) * 3;
      const h = 14 + ((i * 7) % 15);
      const d = 12 + (i % 3) * 3;
      const b = new THREE.Mesh(new THREE.BoxGeometry(d,h,w), facadeMats[(i + (side > 0 ? 1 : 0)) % facadeMats.length]);
      b.position.set(x,h/2-.1,z);
      b.castShadow = !isMobile;
      b.receiveShadow = true;
      world.add(b);
      const tex = windowTexture(buildingSeed++, i % 3 !== 0);
      const wm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: .82, toneMapped: false });
      const windows = new THREE.Mesh(new THREE.PlaneGeometry(w*.82,h*.72),wm);
      windows.rotation.y = side > 0 ? -Math.PI/2 : Math.PI/2;
      windows.position.set(side*(Math.abs(x)-d/2-.012),h*.52,z);
      world.add(windows);
    }
  }

  const posterDefs = [
    [-13.92, 4.2, 35.4, Math.PI/2, 1, 'NIGHT STUDIES', 'VOL. 08'],
    [-13.92, 4.1, 18.4, Math.PI/2, 2, 'LISTEN CLOSER', 'SEOUL'],
    [-13.92, 4.6, -.9, Math.PI/2, 3, 'THE LONG CUT', 'ATLAS CINEMA'],
    [13.92, 4.4, 26.8, -Math.PI/2, 4, 'AFTER HOURS', 'LISTENING SERIES'],
    [13.92, 4.0, 6.6, -Math.PI/2, 5, 'OBJECT / PLACE', 'DESIGN NOTES'],
    [13.92, 4.4, -15.6, -Math.PI/2, 6, 'FORM / MEMORY', 'THE ATELIER']
  ];
  for (const [x,y,z,rot,seed,title,sub] of posterDefs) {
    const p = createPoster(seed,title,sub);
    p.position.set(x,y,z);
    p.rotation.y = rot;
    world.add(p);
  }

  const marquee = new THREE.Mesh(
    new THREE.BoxGeometry(5.5,.32,10.5),
    new THREE.MeshStandardMaterial({ color:0x0b0b0b, metalness:.7, roughness:.25 })
  );
  marquee.position.set(-9.5,6.5,-8);
  marquee.castShadow = !isMobile;
  world.add(marquee);
  for (let i = -4; i <= 4; i++) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.08,8,6),new THREE.MeshBasicMaterial({ color:0xffd9a0 }));
    bulb.position.set(-6.72,6.34,-8+i*1.05);
    world.add(bulb);
  }

  const vinyl = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2,3.2,.18,48),
    new THREE.MeshStandardMaterial({ color:0x080808, roughness:.24, metalness:.55 })
  );
  vinyl.rotation.z = Math.PI/2;
  vinyl.position.set(10.1,4.8,17);
  world.add(vinyl);
  const vinylLabel = new THREE.Mesh(
    new THREE.CylinderGeometry(.62,.62,.20,32),
    new THREE.MeshBasicMaterial({ color:0x7e5f3d })
  );
  vinylLabel.rotation.z = Math.PI/2;
  vinylLabel.position.set(9.98,4.8,17);
  world.add(vinylLabel);

  for (let i = 0; i < 4; i++) {
    const z = -1 + i * 2.4;
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(.48,.52,.08,16),
      new THREE.MeshStandardMaterial({ color:0x33271d,roughness:.7 })
    );
    table.position.set(8.4,.74,z-6);
    world.add(table);
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(.04,.06,1.35,8),
      new THREE.MeshStandardMaterial({ color:0x171717,metalness:.75,roughness:.35 })
    );
    leg.position.set(8.4,.02,z-6);
    world.add(leg);
    const candle = new THREE.Mesh(new THREE.SphereGeometry(.055,8,6),new THREE.MeshBasicMaterial({color:0xffca78}));
    candle.position.set(8.4,.92,z-6);
    world.add(candle);
  }

  for (let i = 0; i < 13; i++) {
    const z = 43 - i * 8.4;
    world.add(createStreetLight(-8.9,z,true,!isMobile && i % 2 === 0));
    world.add(createStreetLight(8.9,z,true,!isMobile && i % 2 === 1));
  }

  const way = createLabelPlane('ATLAS', 'CINEMA · RECORDS · BOOKS · FASHION · CAFÉ · LISTENING ROOM', 8.2, 2.5, {
    bg:'#08090a', fg:'#eee5d4', accent:'#b88f57', serif:true
  });
  way.position.set(8.6,5.3,37);
  way.rotation.y = -Math.PI/2;
  world.add(way);

  const people = new THREE.Group();
  world.add(people);
  const rnd = seeded(808);
  const personCount = isMobile ? 24 : 52;
  for (let i = 0; i < personCount; i++) {
    const p = createPerson(900+i, rnd() > .62);
    const lane = rnd() > .5 ? -1 : 1;
    p.position.set(lane * (5.4 + rnd() * 3.1), 0, 48 - rnd() * 105);
    p.rotation.y = rnd() * TAU;
    p.scale.setScalar(.88 + rnd() * .18);
    people.add(p);
  }

  for (let i = 0; i < 4; i++) {
    const bike = new THREE.Group();
    for (const zOff of [-.48,.48]) {
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(.38,.025,6,24),
        new THREE.MeshStandardMaterial({ color:0x0b0b0b,metalness:.6,roughness:.35 })
      );
      wheel.rotation.y = Math.PI/2;
      wheel.position.set(0,.42,zOff);
      bike.add(wheel);
    }
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(.035,.035,.92),
      new THREE.MeshStandardMaterial({ color:0x2d2d2b,metalness:.7,roughness:.3 })
    );
    frame.position.y=.62;
    bike.add(frame);
    bike.position.set(i%2 ? 10.2 : -10.2,0,-4-i*13.4);
    bike.rotation.y=Math.PI/2;
    world.add(bike);
  }

  const stairs = new THREE.Group();
  for (let i=0;i<24;i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(17,.28,1.25),
      new THREE.MeshStandardMaterial({ color:0x1a1b1b,roughness:.72,metalness:.04 })
    );
    step.position.set(0,i*.22,-65-i*1.05);
    stairs.add(step);
  }
  world.add(stairs);

  const skyline = new THREE.Group();
  world.add(skyline);
  const skyRnd = seeded(1717);
  for(let i=0;i<(isMobile?28:52);i++){
    const w=2+skyRnd()*5,d=2+skyRnd()*5,h=10+skyRnd()*45;
    const x=(skyRnd()-.5)*95;
    const z=-105-skyRnd()*70;
    const b=new THREE.Mesh(
      new THREE.BoxGeometry(w,h,d),
      new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(.56,.08,.06+skyRnd()*.06),roughness:.8})
    );
    b.position.set(x,h/2+4,z);
    skyline.add(b);
    if(i%3===0){
      const wt=windowTexture(3000+i,false);
      const wp=new THREE.Mesh(
        new THREE.PlaneGeometry(w*.78,h*.72),
        new THREE.MeshBasicMaterial({map:wt,transparent:true,opacity:.52,toneMapped:false})
      );
      wp.position.set(x,h*.55+4,z+d/2+.02);
      skyline.add(wp);
    }
  }
  const tower = new THREE.Group();
  const towerShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(.4,.8,34,10),
    new THREE.MeshStandardMaterial({color:0x20252a,metalness:.65,roughness:.28})
  );
  towerShaft.position.y=17;
  tower.add(towerShaft);
  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2,2.4,2.3,20),
    new THREE.MeshStandardMaterial({color:0x24282c,metalness:.65,roughness:.24})
  );
  deck.position.y=32;
  tower.add(deck);
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(.11,.24,15,8),
    new THREE.MeshBasicMaterial({color:0xbcd7ff})
  );
  antenna.position.y=40;
  tower.add(antenna);
  const ringLight=new THREE.Mesh(new THREE.TorusGeometry(2.65,.08,8,32),new THREE.MeshBasicMaterial({color:0x8ec9ff,toneMapped:false}));
  ringLight.rotation.x=Math.PI/2;
  ringLight.position.y=32;
  tower.add(ringLight);
  tower.position.set(-24,10,-150);
  skyline.add(tower);

  const rainCount = isMobile ? 700 : 2400;
  const rainGeo = new THREE.BufferGeometry();
  const rainPos = new Float32Array(rainCount * 3);
  const rainSpeed = new Float32Array(rainCount);
  const rainRnd = seeded(2026);
  for (let i=0;i<rainCount;i++) {
    rainPos[i*3]=(rainRnd()-.5)*85;
    rainPos[i*3+1]=rainRnd()*38;
    rainPos[i*3+2]=58-rainRnd()*145;
    rainSpeed[i]=.55+rainRnd()*.9;
  }
  rainGeo.setAttribute('position',new THREE.BufferAttribute(rainPos,3));
  rainGeo.setAttribute('aSpeed',new THREE.BufferAttribute(rainSpeed,1));
  const rainMat=new THREE.ShaderMaterial({
    transparent:true,
    depthWrite:false,
    blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uOpacity:{value:isMobile ? .24 : .34}},
    vertexShader:`
      attribute float aSpeed;
      uniform float uTime;
      void main(){
        vec3 p=position;
        float span=38.0;
        p.y=mod(p.y-uTime*(15.0+22.0*aSpeed),span);
        if(p.y<0.0)p.y+=span;
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        gl_Position=projectionMatrix*mv;
        gl_PointSize=1.0;
      }`,
    fragmentShader:`
      uniform float uOpacity;
      void main(){gl_FragColor=vec4(0.72,0.82,0.92,uOpacity);}
    `
  });
  const rain=new THREE.Points(rainGeo,rainMat);
  scene.add(rain);

  const hazeTex=canvasTexture(256,128,(ctx,w,h)=>{
    const g=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);
    g.addColorStop(0,'rgba(185,205,218,.18)');
    g.addColorStop(1,'rgba(185,205,218,0)');
    ctx.fillStyle=g;
    ctx.fillRect(0,0,w,h);
  });
  const hazeGroup=new THREE.Group();
  for(let i=0;i<(isMobile?5:10);i++){
    const p=new THREE.Mesh(
      new THREE.PlaneGeometry(18+Math.random()*25,4+Math.random()*5),
      new THREE.MeshBasicMaterial({map:hazeTex,transparent:true,opacity:.12,depthWrite:false,side:THREE.DoubleSide})
    );
    p.position.set((Math.random()-.5)*50,2+Math.random()*6,25-Math.random()*120);
    p.rotation.y=(Math.random()-.5)*.5;
    hazeGroup.add(p);
  }
  scene.add(hazeGroup);

  let composer = null;
  if(!isMobile){
    try{
      composer=new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene,camera));
      const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.36,.72,.92);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }catch(err){
      console.warn('[atlas] post effects disabled',err);
      composer=null;
    }
  }

  // ---------------------------------------------------------------------------
  // FREE WORLD CONTROLS
  // Adapted from the movement architecture in imsarah/threejs-world (MIT):
  // grounded WASD + pointer-lock on desktop, split move/look touch on mobile.
  // There is no authored camera rail and no narrative step progression.
  // ---------------------------------------------------------------------------
  const POIS = [
    { key:'records', name:'OBSIDIAN RECORDS', x:-10.4, z:29 },
    { key:'books', name:'ATLAS BOOKS', x:-10.4, z:11 },
    { key:'cinema', name:'ATLAS CINEMA', x:-10.4, z:-8 },
    { key:'listening', name:'ATLAS LISTENING ROOM', x:10.4, z:17 },
    { key:'cafe', name:'ATLAS CAFÉ', x:10.4, z:-3 },
    { key:'atelier', name:'THE ATELIER', x:10.4, z:-23 }
  ];

  const signals = {
    'FRANK OCEAN': { focus:['records','listening','atelier'], fog:0x172431, sky:0x9db8d6 },
    'THE BEAR': { focus:['cafe','cinema','atelier'], fog:0x2a2421, sky:0xb9a38e },
    'AĒSOP': { focus:['atelier','books','cafe'], fog:0x202824, sky:0xa9b9a8 },
    'DUNE': { focus:['cinema','books','listening'], fog:0x302721, sky:0xc0a58c },
    'SEOUL': { focus:['listening','cafe','atelier'], fog:0x162633, sky:0x9dc8dd }
  };

  let activeSignal = 'FRANK OCEAN';
  function applySignal(name){
    activeSignal = signals[name] ? name : activeSignal;
    const cfg = signals[activeSignal];
    scene.fog.color.setHex(cfg.fog);
    hemi.color.setHex(cfg.sky);
    const focus = new Set(cfg.focus);
    for(const key of Object.keys(stores)){
      const s=stores[key];
      const base=s.glow.userData.baseIntensity || 5;
      s.glow.intensity=focus.has(key) ? base*1.55 : base*.72;
      s.sign.material.opacity=focus.has(key) ? 1 : .82;
    }
  }

  class FreeWalk {
    constructor(camera, dom){
      this.camera=camera;
      this.dom=dom;
      this.keys=new Set();
      this.yaw=0;
      this.pitch=-.045;
      this.vel=new THREE.Vector3();
      this.wish=new THREE.Vector3();
      this.forward=new THREE.Vector3();
      this.right=new THREE.Vector3();
      this.eye=1.72;
      this.vy=0;
      this.air=0;
      this.grounded=true;
      this.locked=false;
      this.moveId=null;
      this.lookId=null;
      this.joyStart={x:0,y:0};
      this.joy={x:0,y:0};
      this.lookLast={x:0,y:0};
      this.lookStart={x:0,y:0,t:0};
      this.mouseDown=false;
      this.bob=0;
      this.baseFov=isMobile?66:58;

      camera.position.set(0,this.eye,50);
      camera.rotation.order='YXZ';
      camera.rotation.set(this.pitch,this.yaw,0);

      window.addEventListener('keydown',e=>{
        this.keys.add(e.code);
        if(e.code==='Space' && this.grounded){
          this.vy=6.7;
          this.grounded=false;
        }
      });
      window.addEventListener('keyup',e=>this.keys.delete(e.code));
      window.addEventListener('blur',()=>this.keys.clear());

      if(!isMobile){
        dom.addEventListener('click',()=>{
          if(document.pointerLockElement!==dom){
            const p=dom.requestPointerLock();
            if(p && p.catch) p.catch(()=>{});
          }
        });
        document.addEventListener('pointerlockchange',()=>{
          this.locked=document.pointerLockElement===dom;
          window.dispatchEvent(new CustomEvent('atlas-lock',{detail:{locked:this.locked}}));
        });
        document.addEventListener('mousemove',e=>{
          if(!this.locked)return;
          this.look(e.movementX,e.movementY);
        });
      }else{
        dom.addEventListener('touchstart',e=>this.touchStart(e),{passive:false});
        dom.addEventListener('touchmove',e=>this.touchMove(e),{passive:false});
        dom.addEventListener('touchend',e=>this.touchEnd(e),{passive:false});
        dom.addEventListener('touchcancel',e=>this.touchEnd(e),{passive:false});
      }
    }

    look(dx,dy){
      this.yaw-=dx*.00235;
      this.pitch-=dy*.00215;
      this.pitch=Math.max(-1.32,Math.min(1.28,this.pitch));
    }

    touchStart(e){
      e.preventDefault();
      const half=innerWidth*.5;
      for(const t of Array.from(e.changedTouches)){
        if(t.clientX<half && this.moveId===null){
          this.moveId=t.identifier;
          this.joyStart.x=t.clientX;
          this.joyStart.y=t.clientY;
          this.joy.x=0;
          this.joy.y=0;
          window.dispatchEvent(new CustomEvent('atlas-stick',{detail:{x:t.clientX,y:t.clientY,active:true}}));
        }else if(this.lookId===null){
          this.lookId=t.identifier;
          this.lookLast.x=t.clientX;
          this.lookLast.y=t.clientY;
          this.lookStart={x:t.clientX,y:t.clientY,t:performance.now()};
        }
      }
    }

    touchMove(e){
      e.preventDefault();
      for(const t of Array.from(e.changedTouches)){
        if(t.identifier===this.moveId){
          const dx=t.clientX-this.joyStart.x;
          const dy=t.clientY-this.joyStart.y;
          const r=58;
          this.joy.x=Math.max(-1,Math.min(1,dx/r));
          this.joy.y=Math.max(-1,Math.min(1,-dy/r));
          window.dispatchEvent(new CustomEvent('atlas-stick',{detail:{x:t.clientX,y:t.clientY,active:true}}));
        }else if(t.identifier===this.lookId){
          this.look(t.clientX-this.lookLast.x,t.clientY-this.lookLast.y);
          this.lookLast.x=t.clientX;
          this.lookLast.y=t.clientY;
        }
      }
    }

    touchEnd(e){
      e.preventDefault();
      for(const t of Array.from(e.changedTouches)){
        if(t.identifier===this.moveId){
          this.moveId=null;
          this.joy.x=0;this.joy.y=0;
          window.dispatchEvent(new CustomEvent('atlas-stick',{detail:{active:false}}));
        }else if(t.identifier===this.lookId){
          const moved=Math.hypot(t.clientX-this.lookStart.x,t.clientY-this.lookStart.y);
          if(performance.now()-this.lookStart.t<220 && moved<14 && this.grounded){
            this.vy=6.7;this.grounded=false;
          }
          this.lookId=null;
        }
      }
    }

    update(dt){
      let mx=this.joy.x;
      let mz=this.joy.y;
      if(this.keys.has('KeyW')||this.keys.has('ArrowUp'))mz+=1;
      if(this.keys.has('KeyS')||this.keys.has('ArrowDown'))mz-=1;
      if(this.keys.has('KeyA')||this.keys.has('ArrowLeft'))mx-=1;
      if(this.keys.has('KeyD')||this.keys.has('ArrowRight'))mx+=1;

      const len=Math.hypot(mx,mz);
      if(len>1){mx/=len;mz/=len;}

      const sprint=this.keys.has('ShiftLeft')||this.keys.has('ShiftRight');
      const speed=sprint?7.8:4.35;
      const sin=Math.sin(this.yaw),cos=Math.cos(this.yaw);
      this.forward.set(-sin,0,-cos);
      this.right.set(cos,0,-sin);
      this.wish.set(
        this.forward.x*mz+this.right.x*mx,
        0,
        this.forward.z*mz+this.right.z*mx
      );
      if(this.wish.lengthSq()>0)this.wish.normalize().multiplyScalar(speed);
      const d=1-Math.exp(-dt*11);
      this.vel.lerp(this.wish,d);

      const p=this.camera.position;
      p.x+=this.vel.x*dt;
      p.z+=this.vel.z*dt;

      // Keep the visitor in the authored district while preserving free movement.
      p.x=Math.max(-12.2,Math.min(12.2,p.x));
      p.z=Math.max(-64,Math.min(56,p.z));

      this.vy-=20.5*dt;
      this.air=Math.max(0,this.air+this.vy*dt);
      if(this.air<=0){this.air=0;this.vy=0;this.grounded=true;}

      const moving=this.vel.length();
      if(moving>.15 && this.grounded)this.bob+=dt*(sprint?11:8.2);
      const bobY=this.grounded?Math.sin(this.bob*2)*.018*Math.min(1,moving/4):0;
      p.y=this.eye+this.air+bobY;

      this.camera.rotation.set(this.pitch,this.yaw,Math.sin(this.bob)*.0016*Math.min(1,moving/4));
      const targetFov=this.baseFov+(sprint&&moving>5?5:0);
      this.camera.fov=damp(this.camera.fov,targetFov,6,dt);
      this.camera.updateProjectionMatrix();
    }
  }

  const controls=new FreeWalk(camera,renderer.domElement);

  let frameTime=0,frameCount=0,pixelRatio=1;
  const clock=new THREE.Clock();

  function resize(){
    const w=innerWidth,h=innerHeight;
    camera.aspect=w/h;
    camera.fov=(w/h<.8)?68:controls.baseFov;
    camera.updateProjectionMatrix();
    pixelRatio=Math.min(devicePixelRatio||1,isMobile?1.12:1.55);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w,h,false);
    if(composer)composer.setSize(w,h);
  }

  function animate(){
    const dt=Math.min(.05,clock.getDelta());
    const t=clock.elapsedTime;

    controls.update(dt);
    rainMat.uniforms.uTime.value=t;
    hazeGroup.position.x=Math.sin(t*.035)*2.2;
    vinyl.rotation.x=t*.04;

    people.children.forEach((p,i)=>{
      if(p.userData.walk){
        p.position.z-=dt*(.12+(i%5)*.018);
        if(p.position.z<-58)p.position.z=48;
      }
      p.position.y=Math.sin(t*1.3+p.userData.phase)*.012;
    });

    frameTime+=dt;frameCount++;
    if(frameTime>2.4){
      const fps=frameCount/frameTime;
      frameTime=0;frameCount=0;
      if(fps<39&&pixelRatio>.78){
        pixelRatio=Math.max(.78,pixelRatio-.12);
        renderer.setPixelRatio(pixelRatio);
      }
    }

    if(composer)composer.render();else renderer.render(scene,camera);
    requestAnimationFrame(animate);
  }

  function nearest(){
    const p=camera.position;
    let best=null,dist=1e9;
    for(const poi of POIS){
      const d=Math.hypot(p.x-poi.x,p.z-poi.z);
      if(d<dist){dist=d;best=poi;}
    }
    return dist<12 ? {key:best.key,name:best.name,distance:dist} : null;
  }

  applySignal(activeSignal);
  resize();
  animate();
  addEventListener('resize',resize);

  return {
    renderer,scene,camera,isMobile,
    setSignals(a){if(a)applySignal(a);},
    pulse(key){
      const s=stores[key];
      if(!s)return;
      const base=s.glow.userData.baseIntensity||5;
      s.glow.intensity=base*2.8;
      setTimeout(()=>applySignal(activeSignal),480);
    },
    getState(){
      return {
        signal:activeSignal,
        isMobile,
        pixelRatio,
        locked:controls.locked,
        position:{x:camera.position.x,y:camera.position.y,z:camera.position.z},
        nearby:nearest()
      };
    }
  };
}
