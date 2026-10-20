// «Веб-шутер» и пасхалка Konami.
// Зажал ЛКМ — из ближнего верхнего угла к курсору летит паутина с паучком.
// ↑↑↓↓←→←→BA — Человек-паук пролетает через весь экран.
// Один canvas-слой на оба эффекта, создаётся лениво; rAF крутится, только пока есть что рисовать.
import { lerp, clamp, motion, finePointer } from "./util.js";

const root = document.documentElement;
const WEB = "rgba(248, 248, 248, .85)";
const GLOW = "rgba(93, 214, 44, .16)";
const PIXEL_FONT = '"Tiny5 Cyr", "Pixelify Sans", monospace';

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/* ---------- стили ---------- */

function injectCSS() {
  if (document.getElementById("ndze-webshoot-css")) return;
  const s = document.createElement("style");
  s.id = "ndze-webshoot-css";
  s.textContent = `
.ws-layer { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 800; pointer-events: none; }
.ws-caption {
  position: fixed; left: 50%; bottom: 28px; z-index: 801; pointer-events: none; translate: -50% 0;
  max-width: calc(100vw - 32px); padding: 10px 18px; border-radius: 14px; text-align: center;
  border: 1px solid rgba(93, 214, 44, .45); background: rgba(15, 15, 15, .72);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  color: #f8f8f8; font: 700 1.05rem/1.3 var(--pixel, monospace); letter-spacing: .03em;
  box-shadow: 0 0 24px rgba(93, 214, 44, .25), inset 0 0 0 1px rgba(248, 248, 248, .04);
  animation: ws-cap-in .4s cubic-bezier(.2, .9, .3, 1.3) both;
}
.ws-caption.is-leaving { animation: ws-cap-out .3s ease forwards; }
@keyframes ws-cap-in { from { opacity: 0; transform: translateY(16px) scale(.9); } }
@keyframes ws-cap-out { to { opacity: 0; transform: translateY(10px); } }
@media (prefers-reduced-motion: reduce) { .ws-caption, .ws-caption.is-leaving { animation: none; } }`;
  document.head.append(s);
}

/* ---------- общий слой и цикл отрисовки ---------- */

let layer = null;
const drawers = new Set();
let raf = 0;
let last = 0;

function getLayer() {
  if (!layer) {
    injectCSS();
    const canvas = document.createElement("canvas");
    canvas.className = "ws-layer";
    canvas.setAttribute("aria-hidden", "true");
    canvas.hidden = true;
    document.body.append(canvas);
    layer = { canvas, ctx: canvas.getContext("2d"), w: 0, h: 0, dirty: true };
    addEventListener("resize", () => { layer.dirty = true; }, { passive: true });
  }
  if (layer.dirty) {
    const { canvas, ctx } = layer;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    [layer.w, layer.h] = [root.clientWidth, root.clientHeight]; // без полосы прокрутки
    [canvas.width, canvas.height] = [layer.w * dpr, layer.h * dpr];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false; // пиксели остаются пикселями
    layer.dirty = false;
  }
  return layer;
}

/** Добавляет функцию отрисовки fn(ctx, now, dt, layer). Вернула false — убираем. */
function animate(fn) {
  getLayer().canvas.hidden = false;
  drawers.add(fn);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}

function frame(now) {
  const dt = clamp(now - last, 0, 50);
  last = now;
  const L = getLayer();
  L.ctx.clearRect(0, 0, L.w, L.h);
  for (const fn of drawers) if (fn(L.ctx, now, dt, L) === false) drawers.delete(fn);
  if (drawers.size) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
    L.ctx.clearRect(0, 0, L.w, L.h);
    L.canvas.hidden = true;
  }
}

/* ---------- рисовалки ---------- */

/** Нить паутины: квадратичная кривая (для прямой — контрольная точка посередине). */
function rope(ctx, x1, y1, cx, cy, x2, y2, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(cx, cy, x2, y2);
  for (const [style, width] of [[GLOW, 5], [WEB, 1.6]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Пиксель-арт из строк в offscreen-canvas: каждый символ — цвет из палитры. */
function sprite(rows, px, pal) {
  const c = document.createElement("canvas");
  [c.width, c.height] = [rows[0].length * px, rows.length * px];
  const g = c.getContext("2d");
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (pal[ch]) (g.fillStyle = pal[ch]), g.fillRect(x * px, y * px, px, px);
  }));
  return c;
}

const PAL = { r: "#c8102e", b: "#1d3f9e", w: "#f8f8f8", k: "#0f0f0f", l: "rgba(248, 248, 248, .9)" };

// паучок на конце паутины (нить цепляется к верхней середине)
const SPIDER = [
  "....l....",
  ".l.rrr.l.",
  "l.lrrrl.l",
  "..rwrwr..",
  "l.lrrrl.l",
  ".l.rrr.l.",
  "l...r...l",
];

// Человек-паук с поднятой рукой; кулак — колонки 9–10 первой строки
const HERO = [
  ".........rr.",
  ".........rr.",
  ".........bb.",
  "..rrrrr..bb.",
  ".rrrrrrr.bb.",
  ".rwwrwwr.rr.",
  ".rkwrwkr.rr.",
  ".rrrrrrr.rr.",
  "..rrrrr.rr..",
  ".bbrrrbbr...",
  "bbrrkrrbb...",
  "b.rkrkr.b...",
  "r.rrrrr.r...",
  "..bbbbb.....",
  "..bb.bb.....",
  "..bb..bb....",
  ".rrr..rrr...",
];

/* ---------- обрывки паутины ---------- */

const bits = [];
function drawBits(ctx, now, dt) {
  ctx.strokeStyle = WEB;
  ctx.lineWidth = 1;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    b.life -= dt / 650;
    if (b.life <= 0) { bits.splice(i, 1); continue; }
    b.vy += 0.0009 * dt; // лёгкая гравитация
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.spin * dt;
    const cx = Math.cos(b.a) * b.len;
    const cy = Math.sin(b.a) * b.len;
    ctx.globalAlpha = b.life;
    ctx.beginPath();
    ctx.moveTo(b.x - cx, b.y - cy);
    ctx.lineTo(b.x + cx, b.y + cy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return bits.length > 0;
}
function spawnBits(x, y, n = 8) {
  const r = Math.random;
  for (let i = 0; i < n; i++) {
    bits.push({ x, y, life: 1, len: 2 + r() * 5, a: r() * Math.PI, vx: (r() - 0.5) * 0.3, vy: -r() * 0.25, spin: (r() - 0.5) * 0.02 });
  }
  animate(drawBits);
}

/* ---------- веб-шутер ---------- */

const NO_WEB = "a, button, input, textarea, select, label, [contenteditable], canvas, iframe, dialog, [data-no-web]";
const HOLD_MS = 180;
const SHOOT_MS = 120;
const BACK_MS = 280;
let shooterOn = false;

export function initWebShooter() {
  if (shooterOn) return;
  shooterOn = true;
  if (!motion || !finePointer) return;

  let state = "idle"; // idle → wait → shoot → hold → back → idle
  let timer = 0;
  let pid = -1;
  let t0 = 0;
  const p = { x: 0, y: 0 }; // курсор
  const a = { x: 0, y: 0 }; // якорь — верхний угол
  const tip = { x: 0, y: 0 }; // кончик паутины
  const from = { x: 0, y: 0 }; // откуда втягиваемся
  const c = { x: 0, y: 0, vx: 0, vy: 0 }; // контрольная точка провиса на пружине
  let spider = null;

  const selecting = () => {
    const s = getSelection();
    return !!s && !s.isCollapsed && s.toString().trim() !== "";
  };

  function shoot() {
    timer = 0;
    if (state !== "wait") return;
    if (selecting()) { state = "idle"; return; }
    const { w } = getLayer();
    spider ||= sprite(SPIDER, 3, PAL);
    Object.assign(a, { x: p.x < w / 2 ? 0 : w, y: 0 });
    Object.assign(c, { x: a.x, y: a.y, vx: 0, vy: 0 });
    state = "shoot";
    t0 = performance.now();
    animate(draw);
  }

  /** Отпустили/отменили: паутина обрывается и втягивается в угол. */
  function release() {
    clearTimeout(timer);
    timer = 0;
    pid = -1;
    if (state === "wait") state = "idle";
    if (state !== "shoot" && state !== "hold") return;
    spawnBits(tip.x, tip.y, 9);
    Object.assign(from, tip);
    state = "back";
    t0 = performance.now();
  }

  function draw(ctx, now, dt) {
    if (state === "idle" || state === "wait") return false;
    const k = dt / 16.7;
    if (state === "back") {
      const e = (now - t0) / BACK_MS;
      if (e >= 1) { state = "idle"; return false; }
      const q = easeInOut(e);
      [tip.x, tip.y] = [lerp(from.x, a.x, q), lerp(from.y, a.y, q)];
    } else {
      const e = state === "shoot" ? easeOut(clamp((now - t0) / SHOOT_MS, 0, 1)) : 1;
      if (e >= 1) state = "hold";
      [tip.x, tip.y] = [lerp(a.x, p.x, e), lerp(a.y, p.y, e)];
    }

    // провис: контрольная точка тянется к середине чуть ниже — пружина даёт раскачку
    const dx = tip.x - a.x;
    const dy = tip.y - a.y;
    const len = Math.hypot(dx, dy);
    const sag = state === "hold" ? Math.min(len * 0.18, 140) : len * 0.03;
    const tx = a.x + dx / 2 + Math.sin(now / 420) * len * 0.012;
    const ty = a.y + dy / 2 + sag;
    if (state === "shoot") {
      Object.assign(c, { x: tx, y: ty, vx: 0, vy: 0 });
    } else {
      const damp = 0.84 ** k;
      c.vx = (c.vx + (tx - c.x) * 0.1 * k) * damp;
      c.vy = (c.vy + (ty - c.y) * 0.1 * k) * damp;
      c.x += c.vx * k;
      c.y += c.vy * k;
    }

    const fade = state === "back" ? 1 - (now - t0) / BACK_MS * 0.6 : 1;
    rope(ctx, a.x, a.y, c.x, c.y, tip.x, tip.y, fade);
    // вторая нить чуть в стороне — паутина «скручена»
    ctx.globalAlpha = 0.4 * fade;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x + 4, c.y - 3, tip.x, tip.y);
    ctx.stroke();

    // поперечные нити и веер у кончика
    if (len > 40) {
      const pt = (t) => {
        const u = 1 - t;
        return { x: u * u * a.x + 2 * u * t * c.x + t * t * tip.x, y: u * u * a.y + 2 * u * t * c.y + t * t * tip.y };
      };
      const tan = (t) => {
        const x = 2 * (1 - t) * (c.x - a.x) + 2 * t * (tip.x - c.x);
        const y = 2 * (1 - t) * (c.y - a.y) + 2 * t * (tip.y - c.y);
        const d = Math.hypot(x, y) || 1;
        return { nx: -y / d, ny: x / d };
      };
      const span = Math.min(1, 60 / len); // веер ~60px от кончика
      ctx.globalAlpha = 0.75 * fade;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const f of [1, 0.6, 0.3]) {
        const t = 1 - span * f;
        const q = pt(t);
        const { nx, ny } = tan(t);
        const half = 10 * f;
        // поперечная нить чуть провисает к кончику
        ctx.moveTo(q.x - nx * half, q.y - ny * half);
        ctx.quadraticCurveTo(q.x + ny * 4, q.y - nx * 4, q.x + nx * half, q.y + ny * half);
        if (f === 1) {
          ctx.moveTo(q.x - nx * half, q.y - ny * half);
          ctx.lineTo(tip.x, tip.y);
          ctx.lineTo(q.x + nx * half, q.y + ny * half);
        }
      }
      ctx.stroke();
    }
    // паучок висит на короткой нити под курсором
    ctx.globalAlpha = fade;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x, tip.y + 12);
    ctx.stroke();
    ctx.drawImage(spider, Math.round(tip.x - spider.width / 2), Math.round(tip.y + 12));
    ctx.globalAlpha = 1;
    return true;
  }

  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    if (state === "wait" || state === "shoot" || state === "hold") return;
    if (!(e.target instanceof Element) || e.target.closest(NO_WEB)) return;
    if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) return; // полоса прокрутки
    [p.x, p.y, pid] = [e.clientX, e.clientY, e.pointerId];
    state = "wait";
    clearTimeout(timer);
    timer = setTimeout(shoot, HOLD_MS);
  }, { passive: true });

  addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid) return;
    [p.x, p.y] = [e.clientX, e.clientY];
    if (!(e.buttons & 1) || selecting()) release();
  }, { passive: true });

  const onUp = (e) => { if (e.pointerId === pid) release(); };
  addEventListener("pointerup", onUp, { passive: true });
  addEventListener("pointercancel", onUp, { passive: true });
  addEventListener("dragstart", release, { passive: true });
  addEventListener("blur", release);
  document.addEventListener("visibilitychange", release);
}

/* ---------- Konami ---------- */

const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];
const ALIAS = { "и": "b", "ф": "a" }; // русская раскладка
let konamiOn = false;
let playing = false;

/** Подпись в стиле тоста, своя — чтобы была по центру и в пиксельном шрифте. */
function caption(text, ms) {
  injectCSS();
  document.querySelector(".ws-caption")?.remove();
  const el = document.createElement("div");
  el.className = "ws-caption";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/** Человек-паук пролетает через экран на 2–3 паутинах (~3 с). */
function swingShow(done) {
  const { w, h } = getLayer();
  // 2–3 качания так, чтобы дуга была крупной: паутина ~60% высоты, размах ±55°
  const n = clamp(Math.round((w + 140) / (2 * Math.sin(0.96) * h * 0.6)), 2, 3);
  const T = 3000 / n;
  const half = (w + 140) / (2 * n); // полуразмах одного качания
  const L = clamp(half / Math.sin(0.96), 120, h * 0.72); // длина паутины
  const th0 = Math.asin(Math.min(0.98, half / L));
  const px = clamp(Math.round(Math.min(w, h) / 150), 3, 6);
  const hero = sprite(HERO, px, PAL);
  const dir = Math.random() < 0.5 ? 1 : -1;
  const anchor = (j) => { const x = -70 + half * (2 * j + 1); return dir > 0 ? x : w - x; };
  const lowY = L * Math.cos(th0); // высота руки в крайних точках
  const t0 = performance.now();

  animate((ctx, now) => {
    const t = now - t0;
    if (t >= n * T + 260) { done(); return false; }
    const k = Math.floor(t / T);
    const local = t - k * T;

    // прошлая паутина отцепляется и втягивается вверх
    if (k > 0 && local < 260) {
      const e = easeOut(local / 260);
      const pa = anchor(k - 1);
      const sx = lerp(pa + dir * half, pa, e);
      const sy = lerp(lowY, 0, e);
      rope(ctx, pa, 0, (pa + sx) / 2, sy / 2, sx, sy, 1 - e);
    }
    if (k >= n) return true;

    const th = -th0 * Math.cos(Math.PI * (local / T)); // маятник: быстрее всего внизу
    const ax = anchor(k);
    const hx = ax + dir * L * Math.sin(th);
    const hy = L * Math.cos(th);

    // «thwip»: нить выстреливает от руки к верху экрана
    const shot = easeOut(clamp(local / 90, 0, 1));
    const ex = lerp(hx, ax, shot);
    const ey = lerp(hy, 0, shot);
    rope(ctx, hx, hy, (hx + ex) / 2, (hy + ey) / 2, ex, ey);
    if (shot === 1) {
      ctx.strokeStyle = WEB;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const ang = Math.PI * (0.15 + i * 0.175);
        ctx.moveTo(ax, 0);
        ctx.lineTo(ax + Math.cos(ang) * 16, Math.sin(ang) * 16);
      }
      ctx.stroke();
    }

    // герой: повёрнут вдоль паутины; на стыке качаний — плавный переворот
    let rot = -th * dir;
    if (k > 0) rot = lerp(-th0 * dir, rot, easeOut(clamp(local / 220, 0, 1)));
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(rot);
    ctx.scale(dir, 1);
    ctx.shadowColor = "rgba(93, 214, 44, .45)";
    ctx.shadowBlur = 14;
    ctx.drawImage(hero, -10 * px, -px);
    ctx.restore();

    // пиксельное «thwip!»
    if (local < 650) {
      const e = local / 650;
      ctx.globalAlpha = 1 - e * e;
      ctx.font = `700 ${14 + px * 2}px ${PIXEL_FONT}`;
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#0f0f0f";
      const tx = anchor(k) - dir * half * 0.55;
      const ty = lowY * 0.5 - e * 24;
      ctx.strokeText("thwip!", tx, ty);
      ctx.fillStyle = "#5dd62c";
      ctx.fillText("thwip!", tx, ty);
      ctx.globalAlpha = 1;
    }
    return true;
  });
}

function spiderSense() {
  if (playing) return;
  playing = true;
  caption("Паучье чутьё активировано 🕷", motion ? 3600 : 2800);
  const done = () => {
    playing = false;
    dispatchEvent(new CustomEvent("ndze:konami"));
  };
  if (motion) swingShow(done);
  else done();
}

export function initKonami() {
  if (konamiOn) return;
  konamiOn = true;
  let i = 0;
  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && (t.closest("input, textarea, select") || t.isContentEditable)) return;
    const key = String(e.key || "").toLowerCase();
    const k = e.code === "KeyB" ? "b" : e.code === "KeyA" ? "a" : ALIAS[key] || key;
    if (k === KONAMI[i]) i++;
    else if (!(i === 2 && k === "arrowup")) i = k === KONAMI[0] ? 1 : 0; // ↑↑↑ — всё ещё в игре
    if (i === KONAMI.length) {
      i = 0;
      spiderSense();
    }
  });
}
