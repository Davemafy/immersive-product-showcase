import './style.css';
import { createCulturalWorld } from './world.js';

const canvas = document.getElementById('world');
const root = document.getElementById('app');

root.innerHTML = `
  <div class="grain"></div>
  <div class="vignette"></div>
  <header class="hud-top">
    <div class="brand"><span class="brand-glyph">A</span><span>OBSIDIAN ATLAS</span></div>
    <div class="hud-right"><span id="state">DORMANT</span><button id="sound" class="plain-btn">SOUND OFF</button></div>
  </header>
  <aside class="district-rail" id="rail" aria-label="Cultural district">
    <span class="rail-title">DISTRICT</span>
    <span>RECORDS</span><span>CINEMA</span><span>BOOKS</span><span>ATELIER</span><span>CAFÉ</span><span>LISTENING</span>
  </aside>
  <main id="story" class="story"></main>
  <footer class="progress-shell" id="progressShell">
    <span id="step">00</span><div class="progress"><i id="progress"></i></div><button id="next" class="next-btn">CONTINUE <b>→</b></button>
  </footer>
  <div class="boot" id="boot">
    <div class="boot-copy">
      <span class="eyebrow">A CULTURAL WORLD</span>
      <h1>OBSIDIAN<br><em>ATLAS</em></h1>
      <p>Culture should feel like a place, not a database.</p>
      <button id="enter" class="enter">ENTER DISTRICT</button>
    </div>
  </div>
  <div class="error" id="error"><div><h2>Renderer failed.</h2><p>This deployment needs WebGL in a modern browser.</p></div></div>
`;

let world;
try {
  world = createCulturalWorld(canvas);
} catch (err) {
  console.error(err);
  document.getElementById('error').classList.add('show');
}

const els = {
  story: document.getElementById('story'),
  state: document.getElementById('state'),
  step: document.getElementById('step'),
  progress: document.getElementById('progress'),
  progressShell: document.getElementById('progressShell'),
  next: document.getElementById('next'),
  enter: document.getElementById('enter'),
  boot: document.getElementById('boot'),
  sound: document.getElementById('sound'),
  r...[truncated]