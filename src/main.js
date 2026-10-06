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
  rail: document.getElementById('rail')
};

const acts = [
  {
    label: '00 / ARRIVAL',
    title: 'The city is quiet.<br><em>Give it a reason to wake.</em>',
    body: 'One taste signal changes what the district reveals first.',
    mode: 'arrival'
  },
  {
    label: 'ACT I / FIRST SIGNAL',
    title: 'Give the city<br><em>something you love.</em>',
    body: 'This is not a search box. Your signal becomes the lens through which the district is lit.',
    mode: 'signal1'
  },
  {
    label: 'ACT II / WALK THE TERRITORY',
    title: 'The signal becomes<br><em>a neighborhood.</em>',
    body: 'Records, cinema, books, fashion, food and place stop behaving like separate shelves. The city makes the adjacency physical.',
    mode: 'territory'
  },
  {
    label: 'ACT III / SECOND SIGNAL',
    title: 'Now change<br><em>the weather of taste.</em>',
    body: 'A second signal does not add another recommendation. It changes which doors feel culturally close.',
    mode: 'signal2'
  },
  {
    label: 'ACT IV / AGENT',
    title: 'The agent has<br><em>three real places to go.</em>',
    body: 'All three satisfy the hard constraints. Ordinary metadata still picks the obvious route.',
    mode: 'agent'
  },
  {
    label: 'ACT V / REVERSAL',
    title: 'Qloo changes<br><em>where the night goes.</em>',
    body: 'Same city. Same options. Same constraints. The cultural graph changes the action.',
    mode: 'reversal'
  },
  {
    label: 'ACT VI / EVIDENCE',
    title: 'Walk backward through<br><em>why it moved.</em>',
    body: 'The recommendation is not the proof. The path is.',
    mode: 'evidence'
  },
  {
    label: 'ACT VII / ASCENT',
    title: 'One night.<br><em>One tiny region</em><br>of culture.',
    body: 'Change the signals and another version of the district wakes up.',
    mode: 'ascent'
  }
];

const firstSignals = ['FRANK OCEAN', 'THE BEAR', 'AĒSOP', 'DUNE', 'SEOUL'];
const secondSignals = ['JIL SANDER', 'BRIAN ENO', 'KYOTO', 'BLUE BOTTLE', 'CONTEMPORARY ART'];
let act = 0;
let first = 'FRANK OCEAN';
let second = 'JIL SANDER';
let entered = false;
let soundOn = false;
let audio = null;
let oscillators = [];

function buttonRow(items, active, kind) {
  return `<div class="signal-row">${items.map(item => `<button class="signal ${item === active ? 'active' : ''}" data-${kind}="${item}">${item}</button>`).join('')}</div>`;
}

function agentCards() {
  return `
    <div class="decision-grid">
      <button class="decision baseline"><span>A</span><b>Independent fashion</b><small>BASELINE PICK</small></button>
      <button class="decision"><span>B</span><b>Design hotel lobby</b><small>VALID</small></button>
      <button class="decision"><span>C</span><b>Listening room</b><small>VALID</small></button>
    </div>`;
}

function reversal() {
  return `
    <div class="reversal-grid">
      <div><small>WITHOUT QLOO</small><strong>A</strong><p>Independent fashion</p></div>
      <div class="with"><small>WITH QLOO</small><strong>C</strong><p>Listening room</p></div>
    </div>
    <div class="decision-law">SAME CANDIDATES&nbsp;&nbsp;·&nbsp;&nbsp;SAME CONSTRAINTS&nbsp;&nbsp;·&nbsp;&nbsp;DIFFERENT ACTION</div>`;
}

function evidence() {
  return `
    <div class="evidence-grid">
      <article><small>01 / SHARED TERRITORY</small><h3>Experimental sound × design</h3><p>Cross-domain proximity, not genre alone.</p></article>
      <article><small>02 / LOCALITY</small><h3>Seoul / late-night design crowd</h3><p>Local context changes which bridge is strongest.</p></article>
      <article><small>03 / BASELINE GAP</small><h3>Similarity ≠ cultural fit</h3><p>The obvious option wins on metadata and loses on broader taste.</p></article>
      <article><small>04 / DECISION LAW</small><h3>No signal, no claim</h3><p>If Qloo cannot separate candidates, the agent abstains.</p></article>
    </div>`;
}

function render() {
  const a = acts[act];
  els.state.textContent = act === 0 ? 'DORMANT' : act < 5 ? 'DISTRICT LIVE' : act === 5 ? 'DECISION CHANGED' : 'EVIDENCE LIVE';
  els.step.textContent = String(act).padStart(2, '0');
  els.progress.style.width = `${(act / 7) * 100}%`;
  els.next.style.visibility = act === 7 ? 'hidden' : 'visible';
  els.rail.classList.toggle('visible', entered && act >= 2);

  let extra = '';
  if (a.mode === 'signal1') extra = buttonRow(firstSignals, first, 'first');
  if (a.mode === 'signal2') extra = buttonRow(secondSignals, second, 'second');
  if (a.mode === 'territory') extra = `<div class="facts"><span><small>ORIGIN</small><b>${first}</b></span><span><small>WORLD</small><b>CONNECTED</b></span><span><small>STRONGEST TERRITORY</small><b>INDEPENDENT DESIGN</b></span></div>`;
  if (a.mode === 'agent') extra = agentCards();
  if (a.mode === 'reversal') extra = reversal();
  if (a.mode === 'evidence') extra = evidence();
  if (a.mode === 'ascent') extra = `<button class="restart" id="restart">ENTER ANOTHER SIGNAL ↺</button>`;

  els.story.innerHTML = `
    <section class="copy ${a.mode}">
      <span class="eyebrow">${a.label}</span>
      <h2>${a.title}</h2>
      <p class="lede">${a.body}</p>
      ${extra}
    </section>`;

  els.story.querySelectorAll('[data-first]').forEach(btn => {
    btn.addEventListener('click', () => {
      first = btn.dataset.first;
      world?.setSignals(first, second);
      world?.pulse('records');
      render();
    });
  });
  els.story.querySelectorAll('[data-second]').forEach(btn => {
    btn.addEventListener('click', () => {
      second = btn.dataset.second;
      world?.setSignals(first, second);
      world?.pulse('listening');
      render();
    });
  });
  document.getElementById('restart')?.addEventListener('click', () => {
    act = 1;
    first = 'FRANK OCEAN';
    second = 'JIL SANDER';
    world?.setSignals(first, second);
    world?.setAct(act);
    render();
  });
}

function go(delta) {
  if (!entered) return;
  const next = Math.max(1, Math.min(7, act + delta));
  if (next === act) return;
  act = next;
  world?.setAct(act);
  render();
}

els.enter.addEventListener('click', () => {
  entered = true;
  act = 1;
  els.boot.classList.add('gone');
  els.progressShell.classList.add('visible');
  world?.setAct(1);
  world?.setSignals(first, second);
  render();
});
els.next.addEventListener('click', () => go(1));

let wheelGate = false;
window.addEventListener('wheel', e => {
  if (!entered || wheelGate || Math.abs(e.deltaY) < 25) return;
  wheelGate = true;
  go(e.deltaY > 0 ? 1 : -1);
  setTimeout(() => wheelGate = false, 760);
}, { passive: true });

let touchStart = null;
window.addEventListener('touchstart', e => { touchStart = e.touches[0]?.clientY ?? null; }, { passive: true });
window.addEventListener('touchend', e => {
  if (!entered || touchStart == null) return;
  const end = e.changedTouches[0]?.clientY ?? touchStart;
  const d = touchStart - end;
  touchStart = null;
  if (Math.abs(d) > 58) go(d > 0 ? 1 : -1);
}, { passive: true });

els.sound.addEventListener('click', async () => {
  soundOn = !soundOn;
  els.sound.textContent = soundOn ? 'SOUND ON' : 'SOUND OFF';
  if (soundOn) {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
    if (!oscillators.length) {
      const master = audio.createGain();
      master.gain.value = .018;
      master.connect(audio.destination);
      [[43.65,'sine',.65],[65.41,'triangle',.22],[87.31,'sine',.12]].forEach(([freq,type,gain]) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.value = gain;
        o.connect(g).connect(master);
        o.start();
        oscillators.push({o,g,master});
      });
    }
    oscillators[0].master.gain.setTargetAtTime(.018, audio.currentTime, .7);
  } else if (audio && oscillators.length) {
    oscillators[0].master.gain.setTargetAtTime(.0001, audio.currentTime, .4);
  }
});

render();
