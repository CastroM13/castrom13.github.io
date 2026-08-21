'use strict';

const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const tipName = tooltip.querySelector('strong');
const tipSub = tooltip.querySelector('span');
const loader = document.getElementById('loader');
const statPeople = document.getElementById('statPeople');
const statLinks = document.getElementById('statLinks');
const resetBtn = document.getElementById('resetView');

const TAU = Math.PI * 2;
const FONT = `system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
const MIN_SCALE = 0.35, MAX_SCALE = 3.2;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; t -= 1; return 1 + c3 * t * t * t + c1 * t * t; };
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h * 31 + str.charCodeAt(i)) >>> 0) % 360;
  return h;
}

let W = 0, H = 0;
let nodes = [];
let links = [];
let stars = [];
let startTime = 0;

const neighbors = new Map();

const view = { x: 0, y: 0, scale: 1 };
let viewAnim = null;

let hoverNode = null;
let dragNode = null;
let mode = null;
let panLast = null;
let pinch = null;
const pointers = new Map();
const mouse = { x: -9999, y: -9999 };
let userNav = false;
let resizeTimer = null;

function scheduleRefit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!userNav && pointers.size === 0 && !viewAnim) fitView(true);
  }, 260);
}

const sim = {
  repulsion: 600,
  springK: 0.06,
  restLen: 165,
  gravity: 0.0006,
  damping: 0.9,
  forceScale: 0.02,
  maxSpeed: 14,
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  makeStars();
}

function makeStars() {
  stars = Array.from({ length: 130 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: Math.random() * 1.3 + 0.3,
    p: Math.random() * TAU,
    s: 0.5 + Math.random() * 1.6,
  }));
}

async function loadData() {
  const [peopleRes, connRes] = await Promise.all([
    fetch('data/people.json'),
    fetch('data/connections.json'),
  ]);
  if (!peopleRes.ok || !connRes.ok) throw new Error('HTTP ' + peopleRes.status + '/' + connRes.status);
  const peopleData = await peopleRes.json();
  const connData = await connRes.json();
  if (!Array.isArray(peopleData.people) || !Array.isArray(connData.connections)) {
    throw new Error('Invalid data format');
  }
  return [peopleData.people, connData.connections];
}

function buildGraph(people, connections) {
  const byId = new Map();
  nodes = people.map((p, i) => {
    const n = {
      id: String(p.id),
      name: String(p.name),
      photo: p.photo || '',
      x: (Math.random() - 0.5) * 700,
      y: (Math.random() - 0.5) * 700,
      vx: 0, vy: 0, fx: 0, fy: 0,
      r: 27,
      hue: hashHue(String(p.name)),
      phase: Math.random() * TAU,
      bornAt: i * 75,
      cache: null,
      fail: false,
      deg: 0,
      bornE: 0,
      _r: 27,
    };
    byId.set(n.id, n);
    return n;
  });

  links = [];
  for (const c of connections) {
    const a = byId.get(String(c.from));
    const b = byId.get(String(c.to));
    if (!a || !b || a === b) continue;
    if (links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))) continue;
    a.deg++; b.deg++;
    links.push({ a, b, phase: Math.random(), prog: 0, side: (links.length & 1) ? -1 : 1 });
  }

  neighbors.clear();
  for (const n of nodes) neighbors.set(n.id, new Set());
  for (const l of links) {
    neighbors.get(l.a.id).add(l.b.id);
    neighbors.get(l.b.id).add(l.a.id);
  }
}

function loadAvatars() {
  for (const n of nodes) {
    if (!n.photo) { n.fail = true; continue; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { try { cacheAvatar(n, img); } catch (_) { n.fail = true; } };
    img.onerror = () => { n.fail = true; };
    img.src = n.photo;
  }
}

function cacheAvatar(n, img) {
  const S = 192;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2, 0, TAU);
  g.clip();
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const side = Math.min(iw, ih);
  if (side <= 0) throw new Error('bad image');
  g.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, S, S);
  const sh = g.createLinearGradient(0, 0, 0, S);
  sh.addColorStop(0, 'rgba(255,255,255,0.10)');
  sh.addColorStop(0.55, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(2,6,23,0.35)');
  g.fillStyle = sh;
  g.fillRect(0, 0, S, S);
  n.cache = c;
}

function initialsOf(name) {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function stepPhysics(dt, now) {
  const N = nodes.length;
  for (let i = 0; i < N; i++) { nodes[i].fx = 0; nodes[i].fy = 0; }

  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < N; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      const minD = a.r + b.r + 58;
      let f;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 1;
        f = (minD - d) * 0.35;
        dx /= d; dy /= d;
        a.fx -= dx * f; a.fy -= dy * f;
        b.fx += dx * f; b.fy += dy * f;
      } else {
        const d = Math.sqrt(d2);
        f = sim.repulsion / d2;
        dx /= d; dy /= d;
        a.fx -= dx * f; a.fy -= dy * f;
        b.fx += dx * f; b.fy += dy * f;
      }
    }
  }

  for (const l of links) {
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - sim.restLen) * sim.springK;
    const nx = dx / d, ny = dy / d;
    l.a.fx += nx * f; l.a.fy += ny * f;
    l.b.fx -= nx * f; l.b.fy -= ny * f;
  }

  const damp = Math.pow(sim.damping, dt);
  const WALL = 640;
  for (const n of nodes) {
    if (n !== dragNode) {
      n.vx += (n.fx * sim.forceScale - n.x * sim.gravity + Math.sin(now * 0.0004 + n.phase) * 0.0035) * dt;
      n.vy += (n.fy * sim.forceScale - n.y * sim.gravity + Math.cos(now * 0.00035 + n.phase * 1.7) * 0.0035) * dt;
      const dc = Math.hypot(n.x, n.y);
      if (dc > WALL) {
        const f = (dc - WALL) * 0.004 * dt / dc;
        n.vx -= n.x * f;
        n.vy -= n.y * f;
      }
      n.vx *= damp; n.vy *= damp;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > sim.maxSpeed) { n.vx *= sim.maxSpeed / sp; n.vy *= sim.maxSpeed / sp; }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
    }
  }
}

function screenToWorld(sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

function zoomAt(sx, sy, k) {
  const ns = clamp(view.scale * k, MIN_SCALE, MAX_SCALE);
  const wx = (sx - view.x) / view.scale;
  const wy = (sy - view.y) / view.scale;
  view.scale = ns;
  view.x = sx - wx * ns;
  view.y = sy - wy * ns;
}

function pick(sx, sy) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.bornE <= 0.01) continue;
    const dx = sx - (view.x + n.x * view.scale);
    const dy = sy - (view.y + n.y * view.scale);
    const rr = n.r * view.scale + 10;
    if (dx * dx + dy * dy <= rr * rr) return n;
  }
  return null;
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewAnim = null;
  if (pointers.size === 1) {
    const n = pick(e.clientX, e.clientY);
    if (n) { mode = 'drag'; dragNode = n; }
    else { mode = 'pan'; panLast = { x: e.clientX, y: e.clientY }; }
  } else if (pointers.size >= 2) {
    mode = 'pinch';
    dragNode = null;
    const pts = [...pointers.values()];
    pinch = {
      d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      m: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
    };
  }
});

canvas.addEventListener('pointermove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  const pt = pointers.get(e.pointerId);
  if (!pt) return;
  pt.x = e.clientX; pt.y = e.clientY;

  if (mode === 'drag' && dragNode) {
    const w = screenToWorld(e.clientX, e.clientY);
    dragNode.vx = (w.x - dragNode.x) * 0.45;
    dragNode.vy = (w.y - dragNode.y) * 0.45;
    dragNode.x = w.x;
    dragNode.y = w.y;
  } else if (mode === 'pan' && panLast) {
    if (Math.abs(e.clientX - panLast.x) + Math.abs(e.clientY - panLast.y) > 1) userNav = true;
    view.x += e.clientX - panLast.x;
    view.y += e.clientY - panLast.y;
    panLast.x = e.clientX; panLast.y = e.clientY;
  } else if (mode === 'pinch' && pinch && pointers.size >= 2) {
    userNav = true;
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    view.x += m.x - pinch.m.x;
    view.y += m.y - pinch.m.y;
    if (pinch.d > 0) zoomAt(m.x, m.y, d / pinch.d);
    pinch.d = d; pinch.m = m;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    mode = null;
    dragNode = null;
    panLast = null;
    pinch = null;
  } else if (pointers.size === 1 && mode === 'pinch') {
    mode = 'pan';
    const p = [...pointers.values()][0];
    panLast = { x: p.x, y: p.y };
    pinch = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  viewAnim = null;
  userNav = true;
  const k = Math.exp(-e.deltaY * 0.0012);
  zoomAt(e.clientX, e.clientY, k);
}, { passive: false });

canvas.addEventListener('dblclick', () => { userNav = false; fitView(true); });

resetBtn.addEventListener('click', () => { userNav = false; fitView(true); });

function fitBounds() {
  if (!nodes.length) return null;
  let cx = 0, cy = 0;
  for (const n of nodes) { cx += n.x; cy += n.y; }
  cx /= nodes.length; cy /= nodes.length;
  const dists = nodes.map(n => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
  const cutoff = clamp(dists[Math.floor(dists.length * 0.85)] || 0, 300, 520);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const n of nodes) {
    if (Math.hypot(n.x - cx, n.y - cy) > cutoff) continue;
    count++;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!count) { minX = -100; minY = -100; maxX = 100; maxY = 100; }
  const pad = W < 700 ? clamp(Math.min(W, H) * 0.1, 40, 90) : 170;
  const bw = Math.max(maxX - minX, 50), bh = Math.max(maxY - minY, 50);
  const s = clamp(Math.min(W / (bw + pad * 2), H / (bh + pad * 2)), MIN_SCALE, 1.6);
  return {
    scale: s,
    x: W / 2 - (minX + maxX) / 2 * s,
    y: H / 2 - (minY + maxY) / 2 * s,
  };
}

function fitView(animate) {
  const target = fitBounds();
  if (!target) return;
  if (!animate) {
    view.x = target.x; view.y = target.y; view.scale = target.scale;
    viewAnim = null;
  } else {
    viewAnim = { from: { ...view }, to: target, t0: performance.now(), dur: 850 };
  }
}

function animateStat(el, to) {
  const from = parseInt(el.textContent, 10) || 0;
  const t0 = performance.now(), dur = 900;
  (function tick(now) {
    const p = clamp((now - t0) / dur, 0, 1);
    el.textContent = Math.round(lerp(from, to, easeOutCubic(p)));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

function drawBackground(now) {
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, W, H);

  let g = ctx.createRadialGradient(W * 0.16, H * 0.1, 0, W * 0.16, H * 0.1, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(91,33,182,0.30)');
  g.addColorStop(1, 'rgba(91,33,182,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  g = ctx.createRadialGradient(W * 0.86, H * 0.88, 0, W * 0.86, H * 0.88, Math.max(W, H) * 0.65);
  g.addColorStop(0, 'rgba(8,145,178,0.22)');
  g.addColorStop(1, 'rgba(8,145,178,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#c7d2fe';
  for (const s of stars) {
    ctx.globalAlpha = 0.12 + 0.28 * (0.5 + 0.5 * Math.sin(now * 0.001 * s.s + s.p));
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function edgeState(l) {
  if (!hoverNode) return { touched: false, dimmed: false };
  const nb = neighbors.get(hoverNode.id);
  const touches = l.a === hoverNode || l.b === hoverNode;
  return { touched: touches && !!(nb.has(l.a.id) && nb.has(l.b.id)), dimmed: !touches };
}

function shapeLink(l, dt) {
  const a = l.a, b = l.b;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  let qx = mx + px * len * 0.1 * l.side;
  let qy = my + py * len * 0.1 * l.side;
  for (let iter = 0; iter < 3; iter++) {
    let ox = 0, oy = 0, hit = false;
    for (const n of nodes) {
      if (n === a || n === b || n.bornE <= 0.01) continue;
      const R = n.r + 15;
      for (let k = 1; k < 5; k++) {
        const t = k / 5, it = 1 - t;
        const sx = it * it * a.x + 2 * it * t * qx + t * t * b.x;
        const sy = it * it * a.y + 2 * it * t * qy + t * t * b.y;
        const vx = sx - n.x, vy = sy - n.y;
        const dd = Math.hypot(vx, vy);
        if (dd < R && dd > 0.001) {
          hit = true;
          const w = (R - dd) / R;
          ox += (vx / dd) * w;
          oy += (vy / dd) * w;
        }
      }
    }
    if (!hit) break;
    const ol = Math.hypot(ox, oy) || 1;
    const strength = len * 0.22 * (1 - iter * 0.25);
    qx += (ox / ol) * strength;
    qy += (oy / ol) * strength;
  }
  if (!isFinite(l.qx)) {
    l.qx = qx; l.qy = qy;
  } else {
    const k = 1 - Math.pow(0.82, dt);
    l.qx += (qx - l.qx) * k;
    l.qy += (qy - l.qy) * k;
  }
}

function drawLinks(now, dt) {
  ctx.lineCap = 'round';
  for (const l of links) {
    if (l.prog <= 0) continue;
    shapeLink(l, dt);
    const st = edgeState(l);
    const alpha = (hoverNode ? (st.touched ? 0.85 : 0.07) : 0.32) * l.prog;
    if (alpha <= 0.004) continue;
    const p = l.prog, ip = 1 - p;
    const ex = ip * ip * l.a.x + 2 * ip * p * l.qx + p * p * l.b.x;
    const ey = ip * ip * l.a.y + 2 * ip * p * l.qy + p * p * l.b.y;
    const c1x = lerp(l.a.x, l.qx, p), c1y = lerp(l.a.y, l.qy, p);
    const grad = ctx.createLinearGradient(l.a.x, l.a.y, ex, ey);
    grad.addColorStop(0, hsl(l.a.hue, 70, 72, alpha));
    grad.addColorStop(1, hsl(l.b.hue, 70, 72, alpha));
    ctx.strokeStyle = grad;
    ctx.lineWidth = (st.touched ? 3 : 1.7) * clamp(1 / Math.sqrt(view.scale), 0.7, 1.6);
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.quadraticCurveTo(c1x, c1y, ex, ey);
    ctx.stroke();
  }
}

function drawParticles(now) {
  for (const l of links) {
    if (l.prog < 1) continue;
    const st = edgeState(l);
    if (hoverNode && st.dimmed) continue;
    const t = ((now / 8000) + l.phase) % 1;
    const it = 1 - t;
    const px = it * it * l.a.x + 2 * it * t * l.qx + t * t * l.b.x;
    const py = it * it * l.a.y + 2 * it * t * l.qy + t * t * l.b.y;
    const hue = (l.a.hue + l.b.hue) / 2;
    const boost = st.touched ? 1.5 : 1;
    const sc = clamp(1 / Math.sqrt(view.scale), 0.7, 1.5);
    ctx.globalAlpha = hoverNode ? 0.95 : 0.7;
    ctx.fillStyle = hsl(hue, 90, 80, 0.25 * boost);
    ctx.beginPath();
    ctx.arc(px, py, 6.5 * sc * boost, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(px, py, 2.1 * sc * boost, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function nodeDim(n) {
  return !!hoverNode && hoverNode !== n && !neighbors.get(hoverNode.id).has(n.id);
}

function drawNodes(now) {
  for (const n of nodes) {
    const bs = n.bornE;
    if (bs <= 0) continue;
    const R = n.r * bs * (n === hoverNode ? 1.12 : 1) * (1 + 0.015 * Math.sin(now * 0.002 + n.phase));
    n._r = R;
    const dim = nodeDim(n);
    ctx.globalAlpha = dim ? 0.26 : 1;

    const halo = ctx.createRadialGradient(n.x, n.y, R * 0.8, n.x, n.y, R * 2.4);
    halo.addColorStop(0, hsl(n.hue, 90, 60, dim ? 0.04 : 0.20));
    halo.addColorStop(1, hsl(n.hue, 90, 60, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(n.x, n.y, R * 2.4, 0, TAU);
    ctx.fill();

    ctx.fillStyle = hsl(n.hue, 45, 18);
    ctx.beginPath();
    ctx.arc(n.x, n.y, R, 0, TAU);
    ctx.fill();

    if (n.cache) {
      ctx.drawImage(n.cache, n.x - R, n.y - R, R * 2, R * 2);
    } else if (!n.fail) {
      const a0 = now * 0.004 + n.phase;
      ctx.strokeStyle = hsl(n.hue, 85, 70, 0.75);
      ctx.lineWidth = Math.max(2, R * 0.09);
      ctx.beginPath();
      ctx.arc(n.x, n.y, R * 0.82, a0, a0 + TAU / 3.5);
      ctx.stroke();
    } else {
      ctx.fillStyle = hsl(n.hue, 50, 22);
      ctx.beginPath();
      ctx.arc(n.x, n.y, R, 0, TAU);
      ctx.fill();
      ctx.fillStyle = hsl(n.hue, 90, 78);
      ctx.font = `800 ${Math.round(R * 0.72)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initialsOf(n.name), n.x, n.y + R * 0.04);
    }

    ctx.lineWidth = Math.max(1.6, R * 0.09);
    ctx.strokeStyle = hsl(n.hue, 85, 68, n === hoverNode ? 1 : 0.85);
    ctx.beginPath();
    ctx.arc(n.x, n.y, R, 0, TAU);
    ctx.stroke();

    if (n === hoverNode) {
      ctx.lineWidth = 1.4 / view.scale;
      ctx.strokeStyle = hsl(n.hue, 90, 75, 0.5);
      ctx.beginPath();
      ctx.arc(n.x, n.y, R * 1.25, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawLabels() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const sc = view.scale;
  for (const n of nodes) {
    if (n.bornE <= 0.01) continue;
    const fs = clamp(13 * sc, 9, 20);
    const sx = view.x + n.x * sc;
    const sy = view.y + (n.y + n._r + 9) * sc;
    const dim = nodeDim(n);
    ctx.font = `600 ${fs}px ${FONT}`;
    ctx.fillStyle = dim ? 'rgba(226,232,240,0.15)' : 'rgba(230,236,250,0.94)';
    ctx.shadowColor = 'rgba(2,6,23,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillText(n.name, sx, sy);
  }
  ctx.shadowBlur = 0;
}

function updateTooltip() {
  if (hoverNode && mode !== 'drag' && mode !== 'pinch') {
    tipName.textContent = hoverNode.name;
    tipSub.textContent = `${hoverNode.deg} conhecidos IRL`;
    tooltip.classList.add('show');
    const tw = tooltip.offsetWidth || 120;
    const th = tooltip.offsetHeight || 48;
    let tx = mouse.x + 16, ty = mouse.y - th - 10;
    if (tx + tw > W - 10) tx = mouse.x - tw - 16;
    if (ty < 10) ty = mouse.y + 18;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  } else {
    tooltip.classList.remove('show');
  }
}

function frame(now) {
  const dtms = now - (frame.last || now);
  frame.last = now;
  const dt = clamp(dtms, 0, 34) / 16.666;

  stepPhysics(dt, now);

  if (viewAnim) {
    const p = clamp((now - viewAnim.t0) / viewAnim.dur, 0, 1);
    const e = easeOutCubic(p);
    view.x = lerp(viewAnim.from.x, viewAnim.to.x, e);
    view.y = lerp(viewAnim.from.y, viewAnim.to.y, e);
    view.scale = lerp(viewAnim.from.scale, viewAnim.to.scale, e);
    if (p >= 1) viewAnim = null;
  }

  hoverNode = mode === 'drag' || mode === 'pinch' ? null : pick(mouse.x, mouse.y);
  canvas.style.cursor = mode === 'drag' || mode === 'pan' ? 'grabbing'
    : hoverNode ? 'pointer' : 'default';

  for (const n of nodes) {
    const target = clamp((now - startTime - n.bornAt) / 650, 0, 1);
    n.bornE = target <= 0 ? 0 : easeOutBack(target);
  }
  for (const l of links) {
    const start = Math.max(l.a.bornAt, l.b.bornAt) + 260;
    l.prog = easeOutCubic(clamp((now - startTime - start) / 800, 0, 1));
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(now);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  drawLinks(now, dt);
  drawParticles(now);
  drawNodes(now);
  ctx.restore();

  drawLabels();
  updateTooltip();

  requestAnimationFrame(frame);
}

(async function init() {
  resize();
  window.addEventListener('resize', () => { resize(); scheduleRefit(); });
  window.addEventListener('orientationchange', () => { resize(); scheduleRefit(); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { resize(); scheduleRefit(); });
  }
  requestAnimationFrame(frame);
  try {
    const [people, connections] = await loadData();
    buildGraph(people, connections);
    loadAvatars();
    startTime = performance.now();
    animateStat(statPeople, nodes.length);
    animateStat(statLinks, links.length);
    fitView(false);
    setTimeout(() => { if (!userNav) fitView(true); }, 1300);
    setTimeout(() => { if (!userNav) fitView(true); }, 2900);
    setTimeout(() => loader.classList.add('hide'), 350);
  } catch (err) {
    loader.classList.add('error');
    loader.innerHTML =
      '<p>Could not load data files.<br><br>' +
      'Browsers block fetch() on the file:// protocol — serve this folder over HTTP instead:<br><br>' +
      '<b>npx serve</b> &nbsp;or&nbsp; <b>python -m http.server</b></p>';
    console.error(err);
  }
})();
