import * as THREE from 'three';
import { Engine } from 'decarlo-boyz/src/core/engine.js';
import { createConfig } from 'decarlo-boyz/src/core/config.js';
import { RenderSystem } from 'decarlo-boyz/src/render/index.js';
import { MaterialSystem } from 'decarlo-boyz/src/materials/index.js';
import { SkySystem } from 'decarlo-boyz/src/sky/index.js';
import { WorldSystem } from 'decarlo-boyz/src/world/index.js';
import { BuildingSystem } from 'decarlo-boyz/src/buildings/index.js';
import { PropSystem } from 'decarlo-boyz/src/props/index.js';
import { PhysicsSystem } from 'decarlo-boyz/src/physics/index.js';
import { PlayerSystem } from 'decarlo-boyz/src/player/index.js';
import { VehicleSystem } from 'decarlo-boyz/src/vehicles/index.js';
import { FunicularSystem } from 'decarlo-boyz/src/vehicles/funicular.js';
import { TrafficSystem } from 'decarlo-boyz/src/traffic/index.js';
import { PedSystem } from 'decarlo-boyz/src/peds/index.js';
import { FxSystem } from 'decarlo-boyz/src/fx/index.js';

const params=new URLSearchParams(location.search);
const config=createConfig({quality:params.get('q')||'high',fov:76,deterministic:false});
const canvas=document.getElementById('game');
const engine=new Engine({canvas,config});

engine.add(RenderSystem).add(MaterialSystem).add(PhysicsSystem).add(SkySystem).add(WorldSystem).add(BuildingSystem).add(PropSystem).add(PlayerSystem).add(VehicleSystem).add(FunicularSystem).add(TrafficSystem).add(PedSystem).add(FxSystem);

try{await engine.init()}catch(err){console.error('[atlas] init failed',err);document.getElementById('fail')?.classList.add('show');throw err}

const player=engine.ctx.peek('player'),sky=engine.ctx.peek('sky'),world=engine.ctx.peek('world');
player?.setCameraMode?.(3);
player?.teleport?.(new THREE.Vector3(-232,8,64),Math.PI*.96);

const states=[
{name:'FRANK OCEAN',hour:20.35,weather:'scattered',wet:.72},
{name:'SEOUL',hour:22.4,weather:'storm',wet:1},
{name:'AĒSOP',hour:6.45,weather:'overcast',wet:.36},
{name:'DUNE',hour:18.75,weather:'clear',wet:.04},
{name:'THE BEAR',hour:19.6,weather:'overcast',wet:.55}
];
let signalIndex=0;
const signalButton=document.getElementById('signal');
function applyState(s){
 signalButton.textContent=s.name;
 sky?.setTimeOfDay?.(s.hour);
 sky?.setWeather?.(s.weather,{immediate:true});
 engine.ctx.peek('materials')?.setWeather?.({wetness:s.wet,rain:s.weather==='storm'?.9:s.weather==='overcast'?.18:0,wind:s.weather==='storm'?.72:.28,puddleScale:.82});
}
signalButton.addEventListener('click',e=>{e.stopPropagation();signalIndex=(signalIndex+1)%states.length;applyState(states[signalIndex])});
applyState(states[0]);

document.getElementById('sound').addEventListener('click',e=>{e.stopPropagation();const el=e.currentTarget;const on=el.dataset.on==='1';el.dataset.on=on?'0':'1';el.textContent=on?'SOUND OFF':'SOUND ON'});

const hint=document.getElementById('hint'),locationEl=document.getElementById('location');
let hintT=0,lastDistrict='';
window.addEventListener('pointerlockchange',()=>hint.classList.toggle('dim',document.pointerLockElement===canvas));

const originalStep=engine.step.bind(engine);
engine.step=now=>{
 const r=originalStep(now);
 const p=player?.feetPosition??player?.movement?.feetPosition??player?.movement?.character?.position;
 if(p&&world?.districtAt){
   const d=world.districtAt(p.x,p.z),name=d?.name||d?.id||'';
   if(name!==lastDistrict){lastDistrict=name;locationEl.textContent=name?String(name).toUpperCase():'CULTURAL DISTRICT'}
 }
 hintT+=engine.time.dt||0;if(hintT>7)hint.classList.add('soft');
 return r;
};
window.__ATLAS__={engine,player,sky,world,states,applyState};
engine.start();