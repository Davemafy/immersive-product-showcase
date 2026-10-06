import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';

/*
  OBSIDIAN ATLAS
  Renderer architecture adapts patterns from the MIT-licensed Luminous Lake project:
  WebGL-first reliability, procedural environment, adaptive quality, cinematic cameras.
  Visual identity, narrative system, cultural topology and scene composition are original.
*/

const canvas = document.getElementById('world');
const app = document.getElementById('app');

app.innerHTML = `
  <div class="vignette"></div>
  <div class="topbar">
    <div class="brand"><span class="brand-mark"></span><span>OBSIDIAN ATLAS / CULTURAL WORLD</span></div>
    <div class="status"><span class="status-dot"></span><span class="desktop-only" id="worldState">DORMANT</span><button class="sound" id="soundBtn">SOUND OFF</button></div>
  </div>
  <div id="stage"></div>
  <div class="timeline" id="timeline" hidden>
    <span class="step" id="stepLabel">00</span>
    <div class="timeline-track"><div class="timeline-progress" id="timelineProgress"></div></div>
    <button class="next" id="nextBtn">CONTINUE</button>
  </div>
  <div class="boot" id="boot">
    <div class="boot-inner">
      <div class="boot-mark"></div>
      <h1>OBSIDIAN<br><em>ATLAS</em></h1>
      <p>REAL-TIME CULTURAL WORLD</p>
      <button class="pill primary" id="awaken">AWAKEN</button>
    </div>
  </div>
  <div class="compat" id="compat">
    <div><h2>Graphics context unavailable.</h2><p>The renderer could not start. Open this deployment in Chrome, Edge, Safari or Firefox with hardware acceleration enabled.</p></div>
  </div>
`;

const ui = {
  stage: document.getElementById('stage'),
  worldState: document.getElementById('worldState'),
  soundBtn: document.getElementById('soundBtn'),
  timeline: document.getElementById('timeline'),
  stepLabel: document.getElementById('stepLabel'),
  timelineProgress: document.getElementById('timelineProgress'),
  nextBtn: document.getElementById('nextBtn'),
  boot: document.getElementById('boot'),
  awaken: document.getElementById('awaken'),
  compat: document.getElementById('compat'),
};

const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 700;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isMobile,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
} catch (err) {
  ui.compat.classList.add('visible');
  throw err;
}

renderer.setClearColor(0x050607, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = isMobile ? 0.92 : 1.0;
renderer.shadowMap.enabled = !isMobile;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050607);
scene.fog = new THREE.FogExp2(0x080a0b, isMobile ? 0.012 : 0.009);

const camera = new THREE.PerspectiveCamera(isMobile ? 62 : 52, 1, 0.1, 1500);
camera.position.set(0, 8, 72);

const clock = new THREE.Clock();
const world = new THREE.Group();
scene.add(world);

const hemi = new THREE.HemisphereLight(0x9db7c9, 0x070706, 1.0);
scene.add(hemi);

const moonLight = new THREE.DirectionalLight(0xdde6ff, isMobile ? 1.5 : 2.4);
moonLight.position.set(-70, 95, -45);
moonLight.castShadow = !isMobile;
if (!isMobile) {
  moonLight.shadow.mapSize.set(2048, 2048);
  moonLight.shadow.camera.left = -90;
  moonLight.shadow.camera.right = 90;
  moonLight.shadow.camera.top = 90;
  moonLight.shadow.camera.bottom = -90;
}
scene.add(moonLight);

const keyLight = new THREE.PointLight(0xd8ff76, 0, 90, 2);
keyLight.position.set(0, 8, 0);
scene.add(keyLight);

// --- Sky: Three.js Sky example, tuned for a cold luminous night.
const sky = new Sky();
sky.scale.setScalar(900);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 9;
skyU.rayleigh.value = 1.1;
skyU.mieCoefficient.value = 0.018;
skyU.mieDirectionalG.value = 0.83;
const sun = new THREE.Vector3();
const phi = THREE.MathUtils.degToRad(90 - 4);
const theta = THREE.MathUtils.degToRad(228);
sun.setFromSphericalCoords(1, phi, theta);
skyU.sunPosition.value.copy(sun);

// --- Procedural terrain (adapted conceptually from Luminous Lake's height-ring approach).
function hash2(x,z){
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function smoothNoise(x,z){
  const xi=Math.floor(x), zi=Math.floor(z);
  const xf=x-xi, zf=z-zi;
  const u=xf*xf*(3-2*xf), v=zf*zf*(3-2*zf);
  const a=hash2(xi,zi), b=hash2(xi+1,zi), c=hash2(xi,zi+1), d=hash2(xi+1,zi+1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a,b,u),THREE.MathUtils.lerp(c,d,u),v);
}
function fbm(x,z){
  let f=0,a=.5,s=1;
  for(let i=0;i<5;i++){f+=a*smoothNoise(x*s,z*s);s*=2.03;a*=.5;}
  return f;
}
function heightAt(x,z){
  const r=Math.hypot(x,z);
  const basin=-5.5*(1-THREE.MathUtils.smoothstep(r,24,62));
  const ridge=THREE.MathUtils.smoothstep(r,48,170)*(4+fbm(x*.018+4,z*.018+9)*24);
  const cuts=(fbm(x*.052+15,z*.052+8)-.5)*5*THREE.MathUtils.smoothstep(r,42,150);
  return basin+ridge+cuts;
}
function createTerrain(){
  const size=420, seg=isMobile?90:170;
  const g=new THREE.PlaneGeometry(size,size,seg,seg);
  g.rotateX(-Math.PI/2);
  const p=g.attributes.position;
  const colors=new Float32Array(p.count*3);
  const c=new THREE.Color();
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),z=p.getZ(i),h=heightAt(x,z);
    p.setY(i,h);
    const n=fbm(x*.03+22,z*.03+11);
    if(h<-.25)c.setRGB(.045+.03*n,.075+.035*n,.07+.04*n);
    else if(h<3)c.setRGB(.14+.06*n,.145+.05*n,.12+.03*n);
    else if(h<12)c.setRGB(.055+.04*n,.07+.04*n,.058+.025*n);
    else c.setRGB(.12+.08*n,.12+.07*n,.11+.06*n);
    colors[i*3]=c.r;colors[i*3+1]=c.g;colors[i*3+2]=c.b;
  }
  g.setAttribute('color',new THREE.BufferAttribute(colors,3));
  g.computeVertexNormals();
  const m=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.98,metalness:.02});
  const mesh=new THREE.Mesh(g,m);
  mesh.receiveShadow=true;
  mesh.name='terrain';
  world.add(mesh);
}
createTerrain();

// --- Water. Desktop gets the proven Three Water reflector; mobile gets a cheap physically-lit lake.
let water;
if(!isMobile){
  const normalSize=128;
  const data=new Uint8Array(normalSize*normalSize*4);
  for(let y=0;y<normalSize;y++)for(let x=0;x<normalSize;x++){
    const i=(y*normalSize+x)*4;
    const n=Math.sin(x*.23)+Math.cos(y*.19)+Math.sin((x+y)*.11);
    data[i]=128+Math.floor(n*18);data[i+1]=128+Math.floor(Math.cos(n)*18);data[i+2]=255;data[i+3]=255;
  }
  const normals=new THREE.DataTexture(data,normalSize,normalSize,THREE.RGBAFormat);
  normals.wrapS=normals.wrapT=THREE.RepeatWrapping; normals.needsUpdate=true;
  water=new Water(new THREE.PlaneGeometry(115,115),{
    textureWidth:512,textureHeight:512,waterNormals:normals,
    sunDirection:new THREE.Vector3(-.4,.7,-.2).normalize(),
    sunColor:0xb8ccff,waterColor:0x071214,distortionScale:2.2,fog:true
  });
  water.rotation.x=-Math.PI/2;water.position.y=-.12;
}else{
  water=new THREE.Mesh(
    new THREE.CircleGeometry(58,72),
    new THREE.MeshPhysicalMaterial({color:0x061113,roughness:.18,metalness:.12,transparent:true,opacity:.92,clearcoat:.7,clearcoatRoughness:.12})
  );
  water.rotation.x=-Math.PI/2;water.position.y=-.14;
}
world.add(water);

// --- Instanced monolith/forest hybrid.
const trunkGeo=new THREE.CylinderGeometry(.18,.34,5.5,6);
const trunkMat=new THREE.MeshStandardMaterial({color:0x11120f,roughness:1});
const trunkCount=isMobile?150:430;
const trunks=new THREE.InstancedMesh(trunkGeo,trunkMat,trunkCount);
trunks.castShadow=!isMobile; trunks.receiveShadow=!isMobile;
const m4=new THREE.Matrix4(), q=new THREE.Quaternion(), s3=new THREE.Vector3(), pos3=new THREE.Vector3();
let ti=0;
for(let i=0;i<trunkCount*3 && ti<trunkCount;i++){
  const ang=Math.random()*Math.PI*2;
  const r=65+Math.random()*120;
  const x=Math.cos(ang)*r,z=Math.sin(ang)*r,h=heightAt(x,z);
  if(h<1)continue;
  pos3.set(x,h+2.6,z);
  q.setFromEuler(new THREE.Euler((Math.random()-.5)*.04,(Math.random()-.5)*.2,(Math.random()-.5)*.04));
  const sc=.7+Math.random()*1.8;s3.set(sc,sc*(1.1+Math.random()*1.8),sc);
  m4.compose(pos3,q,s3);trunks.setMatrixAt(ti++,m4);
}
trunks.count=ti;
world.add(trunks);

// --- Obsidian cultural structures.
const districtGroup=new THREE.Group(); world.add(districtGroup);
const districtDefs=[
  {name:'MUSIC',a:-2.38,r:33,color:0x8f9cff},
  {name:'DESIGN',a:-1.28,r:38,color:0xd8ff76},
  {name:'FILM',a:-.28,r:35,color:0xffb07d},
  {name:'PLACE',a:.72,r:41,color:0x7de4ff},
  {name:'FASHION',a:1.72,r:36,color:0xf1d0ff},
  {name:'FOOD',a:2.68,r:39,color:0xffdb77}
];
const districtObjects=[];
for(const d of districtDefs){
  const x=Math.cos(d.a)*d.r,z=Math.sin(d.a)*d.r;
  const g=new THREE.Group();g.position.set(x,heightAt(x,z)+1,z);
  const tower=new THREE.Mesh(
    new THREE.CylinderGeometry(2.8,4.2,16,5,1),
    new THREE.MeshPhysicalMaterial({color:0x090a0b,roughness:.28,metalness:.78,clearcoat:.75,clearcoatRoughness:.18})
  );
  tower.position.y=8;tower.castShadow=!isMobile;g.add(tower);
  const ring=new THREE.Mesh(
    new THREE.TorusGeometry(5.4,.08,8,90),
    new THREE.MeshBasicMaterial({color:d.color,transparent:true,opacity:.15,blending:THREE.AdditiveBlending})
  );
  ring.rotation.x=Math.PI/2;ring.position.y=1.4;g.add(ring);
  const core=new THREE.Mesh(new THREE.SphereGeometry(.46,16,10),new THREE.MeshBasicMaterial({color:d.color}));
  core.position.y=16.4;g.add(core);
  districtGroup.add(g);districtObjects.push({def:d,group:g,tower,ring,core,base:g.position.clone()});
}

// Central signal shrine
const shrine=new THREE.Group();world.add(shrine);
const shrineBase=new THREE.Mesh(new THREE.CylinderGeometry(7.5,9,1.6,8),new THREE.MeshStandardMaterial({color:0x0b0c0d,roughness:.5,metalness:.62}));
shrineBase.position.y=.45;shrine.add(shrineBase);
const signalCore=new THREE.Mesh(new THREE.IcosahedronGeometry(2.4,2),new THREE.MeshPhysicalMaterial({
  color:0x111213,emissive:0xd8ff76,emissiveIntensity:0,roughness:.18,metalness:.78,clearcoat:1
}));
signalCore.position.y=5;shrine.add(signalCore);
const coreHalo=new THREE.PointLight(0xd8ff76,0,55,2);coreHalo.position.y=5;shrine.add(coreHalo);
const orbitRing=new THREE.Mesh(new THREE.TorusGeometry(5.6,.045,6,128),new THREE.MeshBasicMaterial({color:0xd8ff76,transparent:true,opacity:0}));
orbitRing.position.y=5;orbitRing.rotation.x=Math.PI/2.4;shrine.add(orbitRing);

// Cultural bridges
const bridges=new THREE.Group();world.add(bridges);
for(let i=0;i<districtObjects.length;i++){
  const a=shrine.position.clone().add(new THREE.Vector3(0,2.2,0));
  const b=districtObjects[i].group.position.clone().add(new THREE.Vector3(0,3,0));
  const curve=new THREE.QuadraticBezierCurve3(a,new THREE.Vector3((a.x+b.x)*.45,8,(a.z+b.z)*.45),b);
  const geo=new THREE.TubeGeometry(curve,38,.045,5,false);
  const mat=new THREE.MeshBasicMaterial({color:districtDefs[i].color,transparent:true,opacity:0});
  const tube=new THREE.Mesh(geo,mat);tube.userData.baseOpacity=.3;bridges.add(tube);
}

// Dust / firefly-like cultural signal particles
const pCount=isMobile?550:1500;
const pPos=new Float32Array(pCount*3);
const pSeed=new Float32Array(pCount);
for(let i=0;i<pCount;i++){
  const r=16+Math.random()*110,a=Math.random()*Math.PI*2;
  pPos[i*3]=Math.cos(a)*r;pPos[i*3+1]=1+Math.random()*28;pPos[i*3+2]=Math.sin(a)*r;
  pSeed[i]=Math.random();
}
const pGeo=new THREE.BufferGeometry();pGeo.setAttribute('position',new THREE.BufferAttribute(pPos,3));
const particles=new THREE.Points(pGeo,new THREE.PointsMaterial({color:0xcfd5c7,size:isMobile?.055:.075,transparent:true,opacity:.23,depthWrite:false,blending:THREE.AdditiveBlending}));
particles.userData.seed=pSeed;world.add(particles);

// Evidence pylons hidden until act 6
const evidencePylons=new THREE.Group();world.add(evidencePylons);
for(let i=0;i<4;i++){
  const g=new THREE.Group();
  const stone=new THREE.Mesh(new THREE.BoxGeometry(2.2,10+i*1.2,2.2),new THREE.MeshStandardMaterial({color:0x090a0b,roughness:.36,metalness:.62}));
  stone.position.y=(10+i*1.2)/2;
  const line=new THREE.Mesh(new THREE.BoxGeometry(.04,8+i*.6,.04),new THREE.MeshBasicMaterial({color:i===3?0xd8ff76:0xffffff}));
  line.position.set(1.13,4+i*.5,1.13);
  g.add(stone,line);
  const a=-.7+i*.47,r=22+i*2;g.position.set(Math.cos(a)*r,heightAt(Math.cos(a)*r,Math.sin(a)*r),Math.sin(a)*r);
  g.visible=false;evidencePylons.add(g);
}

// Optional post-processing: desktop only, and failure never blocks rendering.
let composer=null;
if(!isMobile){
  try{
    composer=new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene,camera));
    const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.46,.78,.86);
    composer.addPass(bloom);composer.addPass(new OutputPass());
  }catch(err){console.warn('post fx disabled',err);composer=null;}
}

// --- Camera rail
const cameraTargets=[
  {p:[0,8,72],l:[0,4,0]},
  {p:[0,5.5,48],l:[0,4,0]},
  {p:[-35,22,58],l:[0,3,0]},
  {p:[36,13,47],l:[-3,5,0]},
  {p:[8,8,31],l:[-16,5,14]},
  {p:[-13,7,25],l:[14,4,-10]},
  {p:[32,18,24],l:[4,6,0]},
  {p:[0,128,118],l:[0,3,0]}
].map(x=>({p:new THREE.Vector3(...x.p),l:new THREE.Vector3(...x.l)}));
const camPos=new THREE.Vector3(),camLook=new THREE.Vector3(),lookCurrent=new THREE.Vector3(0,4,0);
let cameraStage=0;

function setCameraStage(n){cameraStage=Math.max(0,Math.min(cameraTargets.length-1,n));}

const STORY=[
  {
    kicker:'00 / DORMANT',
    headline:'Culture is invisible<br>until things <em>connect.</em>',
    deck:'One signal is enough to wake an entire cultural neighborhood.',
    actions:[['AWAKEN','awaken']]
  },
  {
    kicker:'ACT I / FIRST SIGNAL',
    headline:'Give the world<br><em>something you love.</em>',
    deck:'Pick one signal. The landscape will assemble around it.',
    signalPicker:['FRANK OCEAN','DUNE','AĒSOP','SEOUL','THE BEAR']
  },
  {
    kicker:'ACT II / TERRITORY',
    headline:'The signal becomes<br><em>a landscape.</em>',
    deck:'Music, film, fashion, place and design stop behaving like separate databases. Distance becomes affinity.',
    meta:[['ORIGIN','Frank Ocean'],['STRONGEST TERRITORY','Independent design'],['WORLD STATE','Connected']]
  },
  {
    kicker:'ACT III / SECOND SIGNAL',
    headline:'Now change<br><em>the picture.</em>',
    deck:'Add a second signal. The world should not merely add another recommendation — it should reorganize.',
    signalPicker:['JIL SANDER','KYOTO','BRIAN ENO','BLUE BOTTLE','CONTEMPORARY ART']
  },
  {
    kicker:'ACT IV / AGENT',
    headline:'Finding connections is easy.<br><em>Choosing is harder.</em>',
    deck:'Four valid cultural moves. Hard constraints leave three. Ordinary metadata prefers the obvious one.',
    cards:[
      ['A','Independent fashion','SELECTED'],
      ['B','Design hotels','VALID'],
      ['C','Listening rooms','VALID'],
      ['D','Gallery dining','CONSTRAINT']
    ]
  },
  {
    kicker:'ACT V / REVERSAL',
    headline:'Then Qloo changes<br><em>the decision.</em>',
    deck:'Same candidates. Same constraints. Same agent. Only the cultural graph changes.',
    meta:[['WITHOUT QLOO','Independent fashion / A'],['WITH QLOO','Listening rooms / C'],['DECISION','CHANGED']]
  },
  {
    kicker:'ACT VI / WALK THE EVIDENCE',
    headline:'Do not trust<br><em>the recommendation.</em>',
    deck:'Walk backwards through the evidence that moved the decision.',
    evidence:[
      ['01 / SHARED TERRITORY','Experimental sound × design','Cross-domain proximity, not genre alone.'],
      ['02 / LOCALITY','Seoul / late-night design crowd','Local context reshapes the strongest bridge.'],
      ['03 / BASELINE GAP','Music similarity ≠ cultural fit','The obvious option wins on surface metadata.'],
      ['04 / DECISION LAW','No signal, no claim','If Qloo cannot separate candidates, the agent abstains.']
    ]
  },
  {
    kicker:'ACT VII / ASCENT',
    headline:'One decision.<br><em>One tiny region</em><br>of culture.',
    deck:'Change the signals and the topology changes with them.',
    actions:[['ENTER ANOTHER SIGNAL ↺','replay']]
  }
];

let act=0;
let firstSignal='FRANK OCEAN',secondSignal='JIL SANDER';
let worldAwake=false;
let soundOn=false;
let audioCtx=null,drone=null,droneGain=null;

function renderStory(){
  const s=STORY[act];
  ui.worldState.textContent=act===0?'DORMANT':act<5?'CONNECTED':act===5?'DECISION CHANGED':'EVIDENCE LIVE';
  ui.stepLabel.textContent=String(act).padStart(2,'0');
  ui.timelineProgress.style.width=`${(act/7)*100}%`;
  ui.timeline.hidden=act===0;
  ui.nextBtn.style.display=act===7?'none':'flex';

  let html=`<div class="scene-copy"><div class="kicker">${s.kicker}</div><h1 class="headline">${s.headline}</h1><p class="deck">${s.deck}</p>`;
  if(s.actions){
    html+=`<div class="actions">${s.actions.map(([label,id])=>`<button class="pill primary" data-action="${id}">${label}</button>`).join('')}</div>`;
  }
  if(s.signalPicker){
    html+=`<div class="actions">${s.signalPicker.map((x,i)=>`<button class="pill ${i===0?'active':''}" data-signal="${x}">${x}</button>`).join('')}</div>`;
  }
  html+='</div>';
  if(s.meta){
    html+=`<div class="meta">${s.meta.map(([a,b])=>`<div class="meta-row"><span>${a}</span><span>${b}</span></div>`).join('')}</div>`;
  }
  if(s.cards){
    html+=`<div class="card-stack">${s.cards.map((x,i)=>`<button class="choice-card ${i===0?'active':''}"><span class="letter">${x[0]}</span><span><b>${x[1]}</b><small>${i===0?'Baseline metadata preference':'Culturally valid alternate'}</small></span><span class="tag">${x[2]}</span></button>`).join('')}</div>`;
  }
  if(s.evidence){
    html+=`<div class="evidence">${s.evidence.map(x=>`<div class="evidence-item"><div class="n">${x[0]}</div><h3>${x[1]}</h3><p>${x[2]}</p></div>`).join('')}</div>`;
  }
  ui.stage.innerHTML=html;

  ui.stage.querySelectorAll('[data-action]').forEach(btn=>btn.addEventListener('click',()=>{
    const action=btn.dataset.action;
    if(action==='replay'){act=1;firstSignal='FRANK OCEAN';secondSignal='JIL SANDER';applyAct(true);return;}
    if(action==='awaken'){act=1;applyAct(true);}
  }));
  ui.stage.querySelectorAll('[data-signal]').forEach(btn=>btn.addEventListener('click',()=>{
    ui.stage.querySelectorAll('[data-signal]').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
    if(act===1)firstSignal=btn.dataset.signal; else secondSignal=btn.dataset.signal;
    pulseWorld();
  }));
}

function pulseWorld(){
  keyLight.intensity=5.5;
  signalCore.material.emissiveIntensity=2.8;
  coreHalo.intensity=10;
  setTimeout(()=>{keyLight.intensity=worldAwake?1.2:0;signalCore.material.emissiveIntensity=worldAwake?1.1:0;coreHalo.intensity=worldAwake?3.8:0;},420);
}

function applyAct(force=false){
  worldAwake=act>0;
  setCameraStage(act);
  const targetStrength=worldAwake?1:0;
  signalCore.material.emissiveIntensity=worldAwake?1.15:0;
  coreHalo.intensity=worldAwake?3.8:0;
  orbitRing.material.opacity=worldAwake?.45:0;

  bridges.children.forEach((b,i)=>{
    b.material.opacity = act>=2 ? (act===3?.42:.25) : 0;
  });
  evidencePylons.children.forEach(g=>g.visible=act===6);

  // Reorganise the topology for the second signal and decision acts.
  districtObjects.forEach((o,i)=>{
    const base=o.base;
    let mult=1;
    if(act>=3){
      const weights=[.78,.66,1.13,.82,.62,1.06];
      mult=weights[i];
    }
    if(act>=5 && i===0)mult=1.18; // baseline music-like option retreats
    if(act>=5 && i===1)mult=.55; // design territory pulls inward
    o.group.userData.target=new THREE.Vector3(base.x*mult,base.y,base.z*mult);
    o.ring.material.opacity = act>=2 ? (i===1 && act>=5?.68:.2) : .05;
  });

  if(act===5)pulseWorld();
  renderStory();
}

ui.nextBtn.addEventListener('click',()=>{if(act<7){act++;applyAct();}});
ui.awaken.addEventListener('click',()=>{
  ui.boot.classList.add('hidden');
  ui.timeline.hidden=false;
  act=1;applyAct(true);
});

let wheelLock=false;
addEventListener('wheel',(e)=>{
  if(!ui.boot.classList.contains('hidden') || wheelLock)return;
  if(Math.abs(e.deltaY)<18)return;
  wheelLock=true;
  act=Math.max(1,Math.min(7,act+(e.deltaY>0?1:-1)));
  applyAct();
  setTimeout(()=>wheelLock=false,720);
},{passive:true});

let touchY=null;
addEventListener('touchstart',e=>{touchY=e.touches[0]?.clientY??null},{passive:true});
addEventListener('touchend',e=>{
  if(touchY==null||!ui.boot.classList.contains('hidden'))return;
  const y=e.changedTouches[0]?.clientY??touchY,dy=touchY-y;touchY=null;
  if(Math.abs(dy)>55){act=Math.max(1,Math.min(7,act+(dy>0?1:-1)));applyAct();}
},{passive:true});

// Lightweight procedural audio; starts only on user gesture.
function toggleSound(){
  soundOn=!soundOn;ui.soundBtn.textContent=soundOn?'SOUND ON':'SOUND OFF';
  if(soundOn){
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    if(!drone){
      drone=audioCtx.createOscillator();drone.type='sine';drone.frequency.value=46;
      const drone2=audioCtx.createOscillator();drone2.type='triangle';drone2.frequency.value=69.2;
      droneGain=audioCtx.createGain();droneGain.gain.value=.0001;
      const g2=audioCtx.createGain();g2.gain.value=.018;
      drone.connect(droneGain);drone2.connect(g2);droneGain.connect(audioCtx.destination);g2.connect(audioCtx.destination);
      drone.start();drone2.start();drone.userData={drone2,g2};
    }
    droneGain.gain.setTargetAtTime(.026,audioCtx.currentTime,.8);
    drone.userData.g2.gain.setTargetAtTime(.012,audioCtx.currentTime,.8);
  }else if(audioCtx&&droneGain){
    droneGain.gain.setTargetAtTime(.0001,audioCtx.currentTime,.35);
    drone.userData.g2.gain.setTargetAtTime(.0001,audioCtx.currentTime,.35);
  }
}
ui.soundBtn.addEventListener('click',toggleSound);

// --- resize / adaptive quality
let pixelRatio=1;
function resize(){
  const w=innerWidth,h=innerHeight;
  camera.aspect=w/h;camera.fov=(w/h<.8)?66:52;camera.updateProjectionMatrix();
  pixelRatio=Math.min(devicePixelRatio||1,isMobile?1.15:1.65);
  renderer.setPixelRatio(pixelRatio);renderer.setSize(w,h,false);
  if(composer)composer.setSize(w,h);
}
addEventListener('resize',resize);resize();

let fpsWindow=0,fpsFrames=0,lastFps=60;
function adaptiveQuality(dt){
  fpsWindow+=dt;fpsFrames++;
  if(fpsWindow>2.2){
    lastFps=fpsFrames/fpsWindow;fpsWindow=0;fpsFrames=0;
    if(lastFps<38 && pixelRatio>.75){pixelRatio=Math.max(.75,pixelRatio-.12);renderer.setPixelRatio(pixelRatio);}
  }
}

// --- render loop
const targetQ=new THREE.Quaternion(),lookM=new THREE.Matrix4();
function animate(){
  const dt=Math.min(.05,clock.getDelta());
  const t=clock.elapsedTime;

  const target=cameraTargets[cameraStage];
  camPos.copy(target.p);
  if(reducedMotion)camera.position.copy(camPos);else camera.position.lerp(camPos,1-Math.exp(-dt*1.45));
  lookCurrent.lerp(target.l,1-Math.exp(-dt*1.6));
  lookM.lookAt(camera.position,lookCurrent,camera.up);targetQ.setFromRotationMatrix(lookM);
  camera.quaternion.slerp(targetQ,1-Math.exp(-dt*1.6));

  signalCore.rotation.x=t*.18;signalCore.rotation.y=t*.28;
  orbitRing.rotation.z=t*.07;orbitRing.rotation.x=Math.PI/2.4+Math.sin(t*.15)*.08;
  if(!isMobile && water.material?.uniforms?.time)water.material.uniforms.time.value+=dt*.5;
  else if(isMobile)water.material.roughness=.17+Math.sin(t*.35)*.025;

  particles.rotation.y=t*.006;
  const pp=particles.geometry.attributes.position;
  for(let i=0;i<Math.min(pCount,isMobile?90:190);i++){
    const idx=(i*7)%pCount;
    const y=pp.getY(idx)+Math.sin(t*.45+pSeed[idx]*12)*.0025;
    pp.setY(idx,y);
  }
  pp.needsUpdate=true;

  districtObjects.forEach((o,i)=>{
    if(o.group.userData.target)o.group.position.lerp(o.group.userData.target,1-Math.exp(-dt*.8));
    o.core.position.y=16.4+Math.sin(t*.7+i)*.25;
    o.ring.rotation.z=t*.025*(i%2?1:-1);
  });

  if(composer)composer.render();else renderer.render(scene,camera);
  adaptiveQuality(dt);
  requestAnimationFrame(animate);
}

applyAct(true);
animate();

// First-frame smoke test: if GL exists but rendering throws, reveal compatibility state.
setTimeout(()=>{
  try{
    const gl=renderer.getContext();
    if(!gl || gl.isContextLost())ui.compat.classList.add('visible');
  }catch{ui.compat.classList.add('visible');}
},1000);
