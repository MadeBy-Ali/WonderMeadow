/* Wonder Meadow — the opener.
 * A full-screen, scroll-driven prelude on first load. The feel is borrowed from
 * igloo.inc (one smooth value driven by your scroll, glitchy chromatic edges when you
 * move fast) but it uses big words instead of 3D scenes.
 *
 *  - wheel / touch / arrow keys all feed ONE eased `progress` value (no native scrollbar)
 *  - the sections loop forever; "Enter the meadow" is always on screen (Enter/Esc work too)
 *  - shown once per browser; ?intro=1 forces it, ?intro=0 skips it, clicking the brand replays it
 *  - while it is up, main.js pauses the 3D world (window.__openerActive)
 * Words and tones live in intro.config.js.
 */
const KEY = 'meadow-intro-seen';
const html = document.documentElement;
const root = document.getElementById('opener');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  active: false, built: false,
  p: 0, target: 0,          // progress in "sections"; integer = a section exactly centred
  last: 0, lastInput: -1e9, // timestamps (ms)
  touchY: null,
  sections: [],
};
const $ = (sel) => root.querySelector(sel);

async function build() {
  // load the config with the same ?v= as this file, so one version bump refreshes both
  const { default: cfg } = await import(`./intro.config.js${new URL(import.meta.url).search}`);
  const box = $('.op-sections');
  box.innerHTML = '';
  state.sections = cfg.sections.map((s, i) => {
    const sec = document.createElement('section');
    sec.className = 'op-section';
    sec.dataset.tone = s.tone === 'dark' ? 'dark' : 'light';
    const words = document.createElement('h2');
    words.className = 'op-words';
    for (const line of String(s.text).split('\n')) {
      const span = document.createElement('span');
      span.className = 'op-line';
      span.textContent = line;
      words.appendChild(span);
    }
    sec.appendChild(words);
    sec.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
    box.appendChild(sec);
    sec._lines = [...words.children];
    return sec;
  });
  if (cfg.brand) $('.op-brand').textContent = cfg.brand;
  if (cfg.hint) $('.op-hint').textContent = `${cfg.hint} ↓`;
  if (cfg.enterLabel) $('.op-enter').textContent = `${cfg.enterLabel} →`;
  state.built = true;
}

function render(velocity) {
  const N = state.sections.length;
  if (!N) return;
  let glow = 0;
  state.sections.forEach((el, i) => {
    // signed distance from the centre, wrapped so the loop never ends (0 = fully in view)
    let d = (((state.p - i) % N) + N) % N;
    if (d > N / 2) d -= N;
    const a = Math.abs(d);
    const vis = Math.max(0, 1 - a * 1.35);
    el.style.opacity = vis.toFixed(3);
    el.style.visibility = vis > 0.001 ? 'visible' : 'hidden';
    if (!reduceMotion) {
      el.style.transform = `translate3d(0, ${(-d * 22).toFixed(2)}vh, 0) scale(${(1 - a * 0.12).toFixed(3)})`;
      el.style.filter = a > 0.002 ? `blur(${(a * 14).toFixed(1)}px)` : 'none';
      const mid = (el._lines.length - 1) / 2;
      el._lines.forEach((ln, j) => { ln.style.transform = `translate3d(${((j - mid) * d * 5).toFixed(2)}vw, 0, 0)`; });
    }
    if (el.dataset.tone === 'dark') glow += vis;
    el.setAttribute('aria-hidden', a < 0.5 ? 'false' : 'true');
  });
  $('.op-glow').style.opacity = Math.min(1, glow).toFixed(3);
  root.classList.toggle('op-lit', glow > 0.5); // HUD + button turn black over the lilac moment
  // chromatic "glitch" edges that grow with scroll speed, igloo-style
  const g = reduceMotion ? 0 : Math.max(-9, Math.min(9, velocity * 6));
  root.style.setProperty('--op-glitch', `${g.toFixed(2)}px`);
  const idx = ((Math.round(state.p) % N) + N) % N;
  $('.op-count').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(N).padStart(2, '0')}`;
}

function frame(now) {
  if (!state.active) return;
  const dt = Math.min(0.05, Math.max(0.001, (now - state.last) / 1000));
  state.last = now;
  // once you stop scrolling, settle gently onto the nearest section
  if (now - state.lastInput > 260) state.target += (Math.round(state.target) - state.target) * Math.min(1, dt * 5);
  const prev = state.p;
  state.p += (state.target - state.p) * Math.min(1, dt * (reduceMotion ? 20 : 6));
  render((state.p - prev) / dt);
  requestAnimationFrame(frame);
}

// ---- input -------------------------------------------------------------------
const nudge = (sections) => { state.target += sections; state.lastInput = performance.now(); };
const step = (n) => { state.target = Math.round(state.target) + n; state.lastInput = -1e9; };

function onWheel(e) {
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;               // lines -> px
  else if (e.deltaMode === 2) dy *= innerHeight; // pages -> px
  nudge(dy / 900);
}
function onTouchStart(e) { state.touchY = e.touches[0].clientY; }
function onTouchMove(e) {
  if (state.touchY == null) return;
  e.preventDefault();
  const y = e.touches[0].clientY;
  nudge((state.touchY - y) / (innerHeight * 0.45));
  state.touchY = y;
}
function onTouchEnd() { state.touchY = null; }
function onKey(e) {
  if (e.key === 'Escape' || (e.key === 'Enter' && e.target === document.body)) { e.preventDefault(); enter(); return; }
  if (['ArrowDown', 'PageDown'].includes(e.key) || (e.key === ' ' && e.target === document.body)) { e.preventDefault(); step(1); }
  if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
}
const onEnterClick = () => enter();

function listen(on) {
  const m = on ? 'addEventListener' : 'removeEventListener';
  root[m]('wheel', onWheel, { passive: false });
  root[m]('touchstart', onTouchStart, { passive: true });
  root[m]('touchmove', onTouchMove, { passive: false });
  root[m]('touchend', onTouchEnd);
  window[m]('keydown', onKey);
  $('.op-enter')[m]('click', onEnterClick);
}

// ---- show / leave ----------------------------------------------------------------
async function show() {
  if (state.active) return;
  html.classList.add('opener-on');
  root.classList.remove('leaving');
  window.__openerActive = true;
  state.active = true;
  if (!state.built) await build();
  state.p = state.target = 0;
  state.last = performance.now();
  listen(true);
  requestAnimationFrame(frame);
  // (no auto-focus on the button: Space should advance a section, not leave the opener;
  //  keyboard users reach the button with Tab, and Enter/Esc always work)
}

function enter() {
  if (!state.active) return;
  state.active = false;
  listen(false);
  try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it will just show again */ }
  window.__openerActive = false;                       // the meadow starts rendering underneath...
  window.dispatchEvent(new CustomEvent('meadow:enter')); // ...and its camera descent begins
  root.classList.add('leaving');                       // while the opener fades and blurs away
  setTimeout(() => { if (!state.active) { html.classList.remove('opener-on'); root.classList.remove('leaving'); } }, 1100);
}

window.__meadowOpener = { show, enter, state }; // (state exposed for poking around in the console)
// the tiny inline script in index.html already decided (before first paint) whether to show it
if (html.classList.contains('opener-on')) show();
