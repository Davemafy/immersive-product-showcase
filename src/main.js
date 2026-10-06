import './style.css';
import { createCulturalWorld } from './world.js';

const canvas = document.getElementById('world');
const root = document.getElementById('app');

root.innerHTML = [
  '<div class="grain"></div>',
  '<header class="hud">',
    '<div class="brand"><span class="brand-glyph">A</span><span>OBSIDIAN ATLAS</span></div>',
    '<div class="hud-actions">',
      '<button id="signal" class="hud-button">FRANK OCEAN</button>',
      '<button id="sound" class="hud-button">SOUND OFF</button>',
    '</div>',
  '</header>',
  '<div class="crosshair"><i></i><b></b></div>',
  '<div id="nearby" class="nearby"></div>',
  '<div id="hint" class="hint"><span class="desktop">CLICK TO LOOK · WASD MOVE · SHIFT RUN · SPACE JUMP</span><span class="mobile">LEFT SIDE MOVE · RIGHT SIDE LOOK · TAP RIGHT TO JUMP</span></div>',
  '<div id="stick" class="stick"><i></i></div>',
  '<div class="error" id="error"><div><b>RENDERER FAILED</b><span>WEBGL COULD NOT START.</span></div></div>'
].join('');

let world = null;
try {
  world = createCulturalWorld(canvas);
} catch (error) {
  console.error(error);
  document.getElementById('error').classList.add('show');
}

const signalButton = document.getElementById('signal');
const soundButton = document.getElementById('sound');
const nearby = document.getElementById('nearby');
const hint = document.getElementById('hint');
const stick = document.getElementById('stick');

const signals = ['FRANK OCEAN', 'THE BEAR', 'AĒSOP', 'DUNE', 'SEOUL'];
let signalIndex = 0;

signalButton.addEventListener('click', (event) => {
  event.stopPropagation();
  signalIndex = (signalIndex + 1) % signals.length;
  const signal = signals[signalIndex];
  signalButton.textContent = signal;
  world?.setSignals(signal);
});

let audioContext = null;
let master = null;
let soundOn = false;

soundButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  soundOn = !soundOn;
  soundButton.textContent = soundOn ? 'SOUND ON' : 'SOUND OFF';

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    master = audioContext.createGain();
    master.gain.value = 0.0001;
    master.connect(audioContext.destination);

    const tones = [
      { frequency: 43.65, type: 'sine', gain: 0.42 },
      { frequency: 65.41, type: 'triangle', gain: 0.14 },
      { frequency: 87.31, type: 'sine', gain: 0.06 }
    ];

    tones.forEach((tone) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = tone.frequency;
      oscillator.type = tone.type;
      gain.gain.value = tone.gain;
      oscillator.connect(gain).connect(master);
      oscillator.start();
    });
  }

  await audioContext.resume();
  master.gain.setTargetAtTime(soundOn ? 0.024 : 0.0001, audioContext.currentTime, soundOn ? 0.8 : 0.35);
});

window.addEventListener('atlas-lock', (event) => {
  hint.classList.toggle('gone', event.detail.locked);
});

window.addEventListener('atlas-stick', (event) => {
  const data = event.detail;
  if (!data.active) {
    stick.classList.remove('active');
    return;
  }
  stick.classList.add('active');
  stick.style.left = data.x + 'px';
  stick.style.top = data.y + 'px';
});

setTimeout(() => hint.classList.add('soft'), 5200);

let lastNearby = '';
function updateHud() {
  if (world) {
    const state = world.getState();
    const item = state.nearby;
    const next = item ? item.name : '';
    if (next !== lastNearby) {
      lastNearby = next;
      nearby.textContent = next;
      nearby.classList.toggle('visible', Boolean(next));
    }
  }
  requestAnimationFrame(updateHud);
}
updateHud();
