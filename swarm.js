/* ==================================================================
   SWARM: the page starts blank and a swarm of multiplayer cursors
   rebuilds it live: dragging out boxes, typing text, drawing lines
   with a pen and snapping to guides. Scroll and the swarm follows you.
   ================================================================== */
(() => {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const body = doc.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ABORT = Symbol('abort');

  const NAMES = ['Node', 'React', 'Laravel', 'Python', 'Docker', 'Vue', 'Redis', 'AWS', 'NestJS', 'Postgres', 'Next.js', 'TypeScript'];
  const COLORS = ['#ff2d46', '#f5f5f6', '#ff7a8a', '#e0112b', '#ffb3bc', '#ff4d6a', '#c40f26', '#ffd6db', '#ff5c5c', '#ffffff', '#ff8f6b', '#d9142f'];

  // What gets rebuilt, and how. First matching rule wins; descendants of
  // text/pop/line targets are built together with their parent.
  const RULES = [
    ['.nav, .footer', 'box'],
    ['.logo', 'pop'],
    ['.rule', 'line'],
    ['.chip, .project-icon, .mini-icon, .tl', 'pop'],
    ['.btn, .card', 'box'],
    ['h1, h2, h3, p, .bullets li, .kicker, .brand-name, .nav-links a, .stat-num, .stat-label, .code-file, pre.code', 'text'],
  ];

  // ---------------- state ----------------
  const state = { mode: 'idle', speed: 1, tour: false, done: 0, started: 0, finishedIn: 0 };
  let gen = 0;               // bumping this aborts all in-flight animations
  let tasks = [];
  let agents = [];
  let mouse = null;
  const typers = new Set();
  const MAX_AGENTS = 12;

  // ---------------- helpers ----------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const rectOf = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };
  };
  const fg = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.62 ? '#0a0a0b' : '#ffffff';
  };
  const fadeRemove = (el, ms = 320) => { el.style.opacity = '0'; setTimeout(() => el.remove(), ms); };

  // ---------------- tween engine (one rAF loop) ----------------
  const tweens = new Set();
  function tween(dur, fn) {
    const g = gen;
    return new Promise((resolve, reject) => {
      tweens.add({ dur: Math.max(1, dur), fn, resolve, reject, g, start: null });
    });
  }
  const sleep = (ms) => tween(ms, null);

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;
    for (const tw of tweens) {
      if (tw.g !== gen) { tweens.delete(tw); tw.reject(ABORT); continue; }
      if (tw.start === null) tw.start = now;
      const p = Math.min(1, (now - tw.start) / tw.dur);
      try { if (tw.fn) tw.fn(p); } catch (err) { tweens.delete(tw); tw.reject(err); continue; }
      if (p >= 1) { tweens.delete(tw); tw.resolve(); }
    }
    followTick(now);
    tourTick(now, dt);
    requestAnimationFrame(frame);
  }

  // ---------------- DOM layers ----------------
  const layer = make('div', 'sw-layer sw-ui');
  layer.setAttribute('aria-hidden', 'true');
  body.appendChild(layer);

  const bar = make('div', 'sw-bar sw-ui');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Live build controls');
  body.appendChild(bar);

  // ---------------- collect targets ----------------
  function collect() {
    const map = new Map();
    const list = [];
    const selector = RULES.map((r) => r[0]).join(',');
    doc.querySelectorAll(selector).forEach((el) => {
      if (el.closest('.sw-ui')) return;
      let p = el.parentElement;
      let parent = null;
      while (p && p !== body) {
        if (map.has(p)) { parent = map.get(p); break; }
        p = p.parentElement;
      }
      if (parent && parent.type !== 'box') return;
      const type = RULES.find((r) => el.matches(r[0]))[1];
      const t = { el, type, parent, taken: false, done: false, heading: /^H[12]$/.test(el.tagName) };
      map.set(el, t);
      list.push(t);
    });
    return list;
  }

  function reveal(t, anim = 'sw-reveal') {
    const el = t.el;
    el.classList.remove('sw-pending');
    if (anim) {
      el.classList.add(anim);
      el.addEventListener('animationend', () => el.classList.remove(anim), { once: true });
    }
  }

  // ---------------- typing (layout-stable) ----------------
  // Each text node is split into [typed text][caret][hidden remainder], so the
  // paragraph keeps its final shape while it is being typed.
  function makeTyper(el, color) {
    if (/flex|grid/.test(getComputedStyle(el).display) && !el.querySelector(':scope > .sw-wrap')) {
      const w = make('span', 'sw-wrap');
      while (el.firstChild) w.appendChild(el.firstChild);
      el.appendChild(w);
    }
    const items = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.data.length) items.push({ node: n, full: n.data, shown: -1, ghost: null });
    for (const it of items) {
      const g = make('span', 'sw-ghost');
      it.node.parentNode.insertBefore(g, it.node.nextSibling);
      it.ghost = g;
    }
    const caret = make('span', 'sw-caret');
    caret.style.setProperty('--sw-c', color);
    let caretAt = null;
    const total = items.reduce((s, i) => s + i.full.length, 0);

    const typer = {
      el, total, caret,
      set(k) {
        let off = 0;
        let target = null;
        for (const it of items) {
          const want = clamp(k - off, 0, it.full.length);
          if (want !== it.shown) {
            it.node.data = it.full.slice(0, want);
            it.ghost.textContent = it.full.slice(want);
            it.shown = want;
          }
          if (!target && want < it.full.length) target = it;
          off += it.full.length;
        }
        target = target || items[items.length - 1];
        if (target && caretAt !== target) {
          target.node.parentNode.insertBefore(caret, target.ghost);
          caretAt = target;
        }
      },
      finish() {
        for (const it of items) { it.node.data = it.full; it.ghost.remove(); }
        caret.remove();
        typers.delete(typer);
      },
    };
    typers.add(typer);
    typer.set(0);
    return typer;
  }
  const finishTypers = () => [...typers].forEach((t) => t.finish());

  // ---------------- agents (cursors) ----------------
  const ARROW = (c, s) => `<svg class="sw-arrow" width="20" height="22" viewBox="0 0 20 22"><path d="M2 1.5V18.5L6.6 14.3L9.6 20.6L12.5 19.3L9.6 13.1H16Z" fill="${c}" stroke="${s}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  const PEN = (c, s) => `<svg class="sw-pen" width="22" height="22" viewBox="0 0 22 22"><path d="M2.5 19.5L4 14L15.5 2.5a2.1 2.1 0 0 1 3 3L7 17Z" fill="${c}" stroke="${s}" stroke-width="1.4" stroke-linejoin="round"/><path d="M13.5 4.5l3 3" stroke="${s}" stroke-width="1.4"/></svg>`;

  function setPos(a, x, y) {
    a.x = x; a.y = y;
    a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  function spawn(x, y, delay = 0) {
    const i = agents.length;
    const color = COLORS[i % COLORS.length];
    const textColor = fg(color);
    const stroke = textColor === '#0a0a0b' ? '#0a0a0b' : '#ffffff';
    const el = make('div', 'sw-cursor');
    el.style.setProperty('--sw-c', color);
    el.innerHTML = ARROW(color, stroke) + PEN(color, stroke) +
      `<span class="sw-name" style="background:${color};color:${textColor}">${NAMES[i % NAMES.length]}</span>`;
    layer.appendChild(el);
    const a = { el, x, y, color, fg: textColor, bend: (Math.random() < 0.5 ? -1 : 1) * rand(0.4, 1), i };
    setPos(a, x, y);
    agents.push(a);
    run(a, gen, delay);
    return a;
  }

  function moveTo(a, x, y) {
    const sx = a.x, sy = a.y, dx = x - sx, dy = y - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return Promise.resolve();
    const dur = clamp(160 + dist * 0.55, 180, 760) / state.speed;
    const bend = a.bend * Math.min(dist * 0.12, 42);
    const nx = -dy / dist, ny = dx / dist;
    return tween(dur, (p) => {
      const e = easeInOut(p);
      const b = Math.sin(Math.PI * p) * bend;
      setPos(a, sx + dx * e + nx * b, sy + dy * e + ny * b);
    });
  }

  async function press(a) {
    a.el.classList.add('click');
    const r = make('div', 'sw-ripple');
    r.style.setProperty('--sw-c', a.color);
    r.style.left = a.x + 'px';
    r.style.top = a.y + 'px';
    layer.appendChild(r);
    setTimeout(() => r.remove(), 520);
    await sleep(110 / state.speed);
    a.el.classList.remove('click');
  }

  // ---------------- build actions ----------------
  async function doBox(a, t) {
    const r = rectOf(t.el);
    if (r.w < 2 || r.h < 2) return reveal(t, null);
    await moveTo(a, r.x, r.y);
    await press(a);
    const box = make('div', 'sw-box');
    box.style.setProperty('--sw-c', a.color);
    box.innerHTML = '<i class="sw-handle h-tl"></i><i class="sw-handle h-tr"></i><i class="sw-handle h-bl"></i><i class="sw-handle h-br"></i>';
    box.style.left = r.x + 'px';
    box.style.top = r.y + 'px';
    const size = make('div', 'sw-size');
    size.style.background = a.color;
    size.style.color = a.fg;
    size.style.transform = 'translateX(-50%)';
    layer.append(box, size);
    try {
      const dur = clamp(260 + (r.w + r.h) * 0.4, 380, 950) / state.speed;
      await tween(dur, (p) => {
        const e = easeOut(p);
        const w = Math.max(1, r.w * e), h = Math.max(1, r.h * e);
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
        size.style.left = r.x + w / 2 + 'px';
        size.style.top = r.y + h + 8 + 'px';
        setPos(a, r.x + w, r.y + h);
      });
      reveal(t);
      await sleep(80 / state.speed);
    } finally {
      fadeRemove(box);
      fadeRemove(size);
    }
  }

  function drawGuides(a, r) {
    const h = make('div', 'sw-guide');
    h.style.setProperty('--sw-c', a.color);
    h.style.left = '0px';
    h.style.width = '100%';
    h.style.top = r.y + 'px';
    const label = make('span', 'sw-size');
    label.style.background = a.color;
    label.style.color = a.fg;
    label.style.left = r.x + 'px';
    label.textContent = `y ${Math.round(r.y)}`;
    h.appendChild(label);
    const v = make('div', 'sw-guide-v');
    v.style.setProperty('--sw-c', a.color);
    v.style.left = r.x + 'px';
    v.style.top = r.y - 40 + 'px';
    v.style.height = r.h + 80 + 'px';
    layer.append(h, v);
    return [h, v];
  }

  async function doText(a, t) {
    const el = t.el;
    const r = rectOf(el);
    if (r.w < 1 && r.h < 1) return reveal(t, null);
    let guides = [];
    let ty = null;
    try {
      if (t.heading) {
        await moveTo(a, r.x - 8, r.y - 6);
        guides = drawGuides(a, r);
        await press(a);
        await sleep(160 / state.speed);
      } else {
        await moveTo(a, r.x, r.y + Math.min(r.h, 24) * 0.8);
      }
      ty = makeTyper(el, a.color);
      el.classList.remove('sw-pending');
      const total = ty.total;
      const perChar = el.tagName === 'PRE' ? 7 : t.heading ? 34 : 13;
      const dur = clamp(total * perChar, 240, 2400) / state.speed;
      await tween(dur, (p) => {
        ty.set(Math.ceil(total * p));
        const c = ty.caret.getBoundingClientRect();
        if (c.top || c.left) setPos(a, c.left + scrollX + 3, c.top + scrollY + 3);
      });
    } finally {
      if (ty) ty.finish();
      guides.forEach((g) => fadeRemove(g, 420));
    }
  }

  async function doLine(a, t) {
    const r = rectOf(t.el);
    if (r.w < 2) return reveal(t, null);
    const y = r.y + r.h / 2;
    await moveTo(a, r.x, y);
    a.el.classList.add('pen');
    const line = make('div', 'sw-pen-line');
    line.style.background = a.color;
    line.style.left = r.x + 'px';
    line.style.top = y - 1 + 'px';
    line.style.width = '0px';
    layer.appendChild(line);
    try {
      await press(a);
      const dur = clamp(r.w * 0.7, 350, 1000) / state.speed;
      await tween(dur, (p) => {
        const w = r.w * easeInOut(p);
        line.style.width = w + 'px';
        setPos(a, r.x + w, y);
      });
      reveal(t);
    } finally {
      fadeRemove(line);
      a.el.classList.remove('pen');
    }
  }

  async function doPop(a, t) {
    const r = rectOf(t.el);
    if (r.w < 1 && r.h < 1) return reveal(t, null);
    await moveTo(a, r.x + r.w * 0.55, r.y + r.h * 0.6);
    await press(a);
    reveal(t, 'sw-pop-in');
    await sleep(50 / state.speed);
  }

  const PERFORM = { box: doBox, text: doText, line: doLine, pop: doPop };

  // ---------------- scheduling ----------------
  function pickTask() {
    const top = scrollY - 160;
    const bottom = scrollY + innerHeight + 60;
    for (const t of tasks) {
      if (t.taken) continue;
      if (t.parent && !t.parent.done) continue;
      const b = t.el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) { // hidden at this breakpoint
        t.taken = t.done = true; reveal(t, null); state.done++; progress();
        continue;
      }
      const y1 = b.top + scrollY, y2 = b.bottom + scrollY;
      if (y2 < top || y1 > bottom) continue;
      return t;
    }
    return null;
  }

  async function idle(a) {
    const W = innerWidth, H = innerHeight, vy = scrollY;
    const inView = a.y > vy + 60 && a.y < vy + H - 100;
    const tx = inView ? clamp(a.x + rand(-140, 140), 30, W - 80) : rand(W * 0.2, W * 0.8);
    const ty = inView ? clamp(a.y + rand(-90, 90), vy + 90, vy + H - 130) : vy + rand(H * 0.3, H * 0.7);
    await moveTo(a, tx, ty);
    await sleep(rand(200, 600) / state.speed);
  }

  async function run(a, g, delay) {
    try {
      if (delay) await sleep(delay);
      while (g === gen && state.mode === 'building') {
        const t = pickTask();
        if (!t) { await idle(a); continue; }
        t.taken = true;
        try {
          await PERFORM[t.type](a, t);
        } catch (err) {
          if (err === ABORT) throw err;
          console.error('[swarm]', err);
          [...typers].filter((ty) => ty.el === t.el).forEach((ty) => ty.finish());
          reveal(t, null);
        }
        t.done = true;
        state.done++;
        progress();
      }
    } catch (err) {
      if (err !== ABORT) console.error('[swarm]', err);
    }
  }

  // ---------------- follow & tour ----------------
  function followTick(now) {
    if (state.mode !== 'done' || !agents.length) return;
    const n = agents.length;
    agents.forEach((a, i) => {
      let tx, ty;
      if (mouse) {
        const ang = (i / n) * Math.PI * 2 + now * 0.00035;
        const rad = 54 + (i % 3) * 16;
        tx = mouse.x + scrollX + Math.cos(ang) * rad;
        ty = mouse.y + scrollY + Math.sin(ang) * rad;
      } else {
        tx = innerWidth / 2 + (i - (n - 1) / 2) * 30;
        ty = scrollY + innerHeight - 96;
      }
      const k = 0.06 + (i % 4) * 0.018;
      setPos(a, a.x + (tx - a.x) * k, a.y + (ty - a.y) * k);
    });
  }

  let tourAcc = 0, tourCheck = 0, tourBusy = 0;
  function tourTick(now, dt) {
    if (!state.tour || state.mode !== 'building') return;
    const maxY = root.scrollHeight - innerHeight;
    if (scrollY >= maxY - 2) { state.tour = false; renderBar(); return; }
    if (now - tourCheck > 200) {
      tourCheck = now;
      const top = scrollY, bottom = scrollY + innerHeight * 0.85;
      tourBusy = 0;
      for (const t of tasks) {
        if (t.done) continue;
        const b = t.el.getBoundingClientRect();
        const y1 = b.top + scrollY, y2 = b.bottom + scrollY;
        if (y1 < bottom && y2 > top) tourBusy++;
      }
    }
    if (tourBusy <= Math.max(2, Math.floor(agents.length * 0.8))) {
      tourAcc += dt * 0.11 * state.speed;
      if (tourAcc >= 1) {
        const step = Math.floor(tourAcc);
        tourAcc -= step;
        window.scrollTo({ top: scrollY + step, behavior: 'instant' });
      }
    }
  }

  // ---------------- lifecycle ----------------
  function clearAgents() {
    agents.forEach((a) => a.el.remove());
    agents = [];
    layer.replaceChildren();
  }

  function start() {
    state.mode = 'building';
    state.done = 0;
    state.started = performance.now();
    renderBar();
    const logo = doc.querySelector('.logo');
    const r = logo ? rectOf(logo) : { x: 40, y: scrollY + 30, w: 0, h: 0 };
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const count = innerWidth < 700 ? 4 : 7;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      spawn(cx + Math.cos(ang) * 30, cy + Math.sin(ang) * 22 + 10, i * 110);
    }
    progress();
  }

  function complete() {
    gen++; // stop idle wandering, hand cursors to the follow loop
    state.mode = 'done';
    state.tour = false;
    state.finishedIn = (performance.now() - state.started) / 1000;
    renderBar();
    const g = gen;
    setTimeout(() => { if (g === gen && state.mode === 'done') goLive(); }, 12000);
  }

  function goLive() {
    gen++;
    finishTypers();
    tasks.forEach((t) => {
      if (t.el.classList.contains('sw-pending')) reveal(t);
      t.taken = t.done = true;
    });
    state.mode = 'live';
    state.tour = false;
    agents.forEach((a) => { a.el.style.opacity = '0'; });
    const old = agents;
    agents = [];
    setTimeout(() => { old.forEach((a) => a.el.remove()); layer.replaceChildren(); }, 420);
    layer.querySelectorAll('.sw-box, .sw-size, .sw-guide, .sw-guide-v, .sw-pen-line').forEach((e) => fadeRemove(e));
    renderBar();
  }

  function replay() {
    gen++;
    finishTypers();
    clearAgents();
    tasks.forEach((t) => {
      t.taken = t.done = false;
      t.el.classList.remove('sw-reveal', 'sw-pop-in');
      t.el.classList.add('sw-pending');
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
    start();
  }

  // ---------------- control bar ----------------
  let pctEl = null, fillEl = null;
  function renderBar() {
    if (state.mode === 'building') {
      bar.innerHTML =
        `<div class="sw-status"><span class="sw-live"></span><span>Building</span>` +
        `<span class="sw-progress"><i></i></span><span class="sw-pct">0%</span></div>` +
        `<span class="sw-sep"></span>` +
        `<div class="sw-speed" role="group" aria-label="Build speed">` +
        [1, 2, 3].map((v) => `<button data-act="speed" data-v="${v}" aria-pressed="${state.speed === v}" aria-label="${v}× speed">${v}×</button>`).join('') +
        `</div>` +
        `<button data-act="tour" aria-pressed="${state.tour}" title="Auto-scroll at the swarm's pace">Tour</button>` +
        `<button data-act="live" class="sw-primary" title="Skip the build (Esc)">Go live</button>`;
      pctEl = bar.querySelector('.sw-pct');
      fillEl = bar.querySelector('.sw-progress i');
      progress();
    } else if (state.mode === 'done') {
      bar.innerHTML =
        `<div class="sw-status done"><span class="sw-live"></span><span>Built in ${state.finishedIn.toFixed(1)}s</span></div>` +
        `<span class="sw-sep"></span>` +
        `<button data-act="replay">↻ Replay</button>` +
        `<button data-act="live" class="sw-primary">Go live</button>`;
    } else {
      bar.innerHTML = `<button data-act="replay" title="Alt+Shift+S">${state.started ? '↻ Replay build' : '▶ Watch it build'}</button>`;
    }
  }

  function progress() {
    if (!tasks.length) return;
    const pct = Math.round((state.done / tasks.length) * 100);
    if (pctEl) pctEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
    if (state.mode === 'building' && state.done >= tasks.length) complete();
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'speed') {
      state.speed = +b.dataset.v;
      bar.querySelectorAll('[data-act="speed"]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.v === state.speed)));
    } else if (act === 'tour') {
      state.tour = !state.tour;
      b.setAttribute('aria-pressed', String(state.tour));
    } else if (act === 'live') goLive();
    else if (act === 'replay') replay();
  });

  // ---------------- input ----------------
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') mouse = { x: e.clientX, y: e.clientY }; }, { passive: true });

  let lastY = scrollY, lastT = performance.now(), lastSpawn = 0;
  addEventListener('scroll', () => {
    const now = performance.now();
    const dy = scrollY - lastY;
    const v = Math.abs(dy) / Math.max(1, now - lastT);
    lastY = scrollY; lastT = now;
    // Scroll fast and more agents join the swarm.
    if (state.mode === 'building' && !state.tour && v > 1.2 && agents.length < MAX_AGENTS && now - lastSpawn > 300) {
      lastSpawn = now;
      spawn(rand(innerWidth * 0.15, innerWidth * 0.85), scrollY + (dy > 0 ? innerHeight + 10 : -10));
    }
  }, { passive: true });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.mode === 'building' || state.mode === 'done')) goLive();
    else if (e.altKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); replay(); }
  });

  // ---------------- boot ----------------
  const year = doc.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  tasks = collect();
  requestAnimationFrame(frame);

  if (reduced) {
    state.mode = 'live';
    root.classList.remove('sw-boot');
    renderBar();
    return;
  }

  tasks.forEach((t) => t.el.classList.add('sw-pending'));
  root.classList.remove('sw-boot');
  if (!location.hash) {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
  }
  const fontsReady = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => setTimeout(start, 250));
})();
