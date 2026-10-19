// Визуальные эффекты, общие для всех страниц: курсор, паутина на фоне,
// магнитные кнопки, появление при скролле, 3D-наклон карточек.
import { $, $$, lerp, clamp, motion, fancyCursor } from "./util.js";

const root = document.documentElement;

/** Общее состояние мыши. inside=false для касаний — без «призрачного» курсора. */
export const mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: false };
addEventListener("pointermove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.inside = e.pointerType === "mouse";
}, { passive: true });
root.addEventListener("mouseleave", () => { mouse.inside = false; });

/** Один requestAnimationFrame на все анимации страницы. */
const tickers = new Set();
let looping = false;
export function onFrame(fn) {
  tickers.add(fn);
  if (!looping) {
    looping = true;
    const loop = (t) => {
      for (const tick of tickers) tick(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return () => tickers.delete(fn);
}

const HOVERABLE = "a, button, [role='button'], input, label, select, textarea, summary, .card, [data-hover]";

export function initCursor() {
  if (!fancyCursor) return;
  root.classList.add("has-cursor");
  const dot = $(".cursor-dot");
  const ring = $(".cursor-ring");
  let rx = mouse.x;
  let ry = mouse.y;
  let shown = false;
  onFrame(() => {
    rx = lerp(rx, mouse.x, 0.2);
    ry = lerp(ry, mouse.y, 0.2);
    dot.style.transform = `translate3d(${mouse.x}px, ${mouse.y}px, 0) translate(-50%, -50%)`;
    ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
    if (shown !== mouse.inside) {
      shown = mouse.inside;
      root.classList.toggle("cursor-on", shown);
    }
  });
  document.addEventListener("pointerover", (e) => ring.classList.toggle("is-hover", !!e.target.closest(HOVERABLE)));
  addEventListener("pointerdown", () => ring.classList.add("is-down"));
  addEventListener("pointerup", () => ring.classList.remove("is-down"));
  // над iframe события мыши не приходят — прячем свой курсор, там работает системный
  document.addEventListener("pointerover", (e) => {
    if (e.target.closest("iframe, .frame")) mouse.inside = false;
  });
}

/** Модальные окна живут в top layer — там нужен системный курсор. */
export function setCursorSuspended(suspended) {
  if (!fancyCursor) return;
  root.classList.toggle("has-cursor", !suspended);
}

/** Паутина на фоне: узлы тянутся к курсору, по клику — «выстрел» паутиной. */
export function initWebBackground() {
  const canvas = $("#web");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  const LINK = 130;
  const MOUSE_LINK = 190;
  const BURST_MS = 750;
  const nodes = [];
  const bursts = [];
  let w = 0;
  let h = 0;

  const makeNode = () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
  });

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = root.clientWidth; // без полосы прокрутки — иначе линии смещаются от курсора
    h = root.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = clamp(Math.round((w * h) / 18000), 24, 85);
    while (nodes.length < count) nodes.push(makeNode());
    nodes.length = count;
    for (const n of nodes) {
      n.x = clamp(n.x, 0, w);
      n.y = clamp(n.y, 0, h);
    }
  }

  function drawBurst(b, now) {
    const p = (now - b.t) / BURST_MS;
    const R = 80 * (1 - Math.pow(1 - p, 3));
    const spokes = 12;
    ctx.strokeStyle = `rgba(93, 214, 44, ${0.9 * (1 - p)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + b.rot;
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + Math.cos(a) * R, b.y + Math.sin(a) * R);
    }
    for (const k of [0.35, 0.65, 1]) {
      const r = R * k;
      for (let i = 0; i < spokes; i++) {
        const a1 = (i / spokes) * Math.PI * 2 + b.rot;
        const a2 = ((i + 1) / spokes) * Math.PI * 2 + b.rot;
        const am = (a1 + a2) / 2;
        ctx.moveTo(b.x + Math.cos(a1) * r, b.y + Math.sin(a1) * r);
        ctx.quadraticCurveTo(b.x + Math.cos(am) * r * 0.82, b.y + Math.sin(am) * r * 0.82, b.x + Math.cos(a2) * r, b.y + Math.sin(a2) * r);
      }
    }
    ctx.stroke();
  }

  function draw(now) {
    ctx.clearRect(0, 0, w, h);
    if (motion) {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        if (mouse.inside) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          if (dx * dx + dy * dy < MOUSE_LINK * MOUSE_LINK) {
            n.x += dx * 0.0025;
            n.y += dy * 0.0025;
          }
        }
      }
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < LINK) {
          ctx.strokeStyle = `rgba(93, 214, 44, ${(1 - d / LINK) * 0.22})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    if (mouse.inside) {
      ctx.lineWidth = 1.2;
      for (const n of nodes) {
        const d = Math.hypot(mouse.x - n.x, mouse.y - n.y);
        if (d < MOUSE_LINK) {
          ctx.strokeStyle = `rgba(93, 214, 44, ${(1 - d / MOUSE_LINK) * 0.65})`;
          ctx.beginPath();
          ctx.moveTo(mouse.x, mouse.y);
          ctx.lineTo(n.x, n.y);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = "rgba(248, 248, 248, .4)";
    for (const n of nodes) ctx.fillRect(n.x - 1, n.y - 1, 2, 2);

    for (let i = bursts.length - 1; i >= 0; i--) {
      if (now - bursts[i].t >= BURST_MS) bursts.splice(i, 1);
      else drawBurst(bursts[i], now);
    }
  }

  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      if (!motion) draw(0);
    }, 120);
  });
  resize();

  if (!motion) {
    draw(0);
    return;
  }
  onFrame(draw);
  addEventListener("pointerdown", (e) => {
    if (e.target.closest("dialog, input, textarea, select")) return;
    bursts.push({ x: e.clientX, y: e.clientY, t: performance.now(), rot: Math.random() * Math.PI });
  });
}

/** Кнопки с классом .magnetic слегка тянутся за курсором. */
export function initMagnetic(scope = document) {
  if (!fancyCursor) return;
  for (const el of $$(".magnetic", scope)) {
    if (el.dataset.magnetic) continue;
    el.dataset.magnetic = "1";
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${(e.clientX - (r.left + r.width / 2)) * 0.25}px, ${(e.clientY - (r.top + r.height / 2)) * 0.35}px)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  }
}

/** Элементы .reveal плавно появляются при прокрутке. onReveal(el) — опциональный колбэк. */
export function initReveal(scope = document, onReveal) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      onReveal?.(e.target);
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -10% 0px" });
  $$(".reveal:not(.in)", scope).forEach((el) => io.observe(el));
}

/**
 * Подсветка за курсором + 3D-наклон для карточек внутри container.
 * Карточке нужны CSS-переменные --mx/--my (см. .card в стилях страницы).
 */
export function initTilt(container, selector = ".card", { maxX = 8, maxY = 10 } = {}) {
  if (!fancyCursor || !container) return;
  let current = null;
  const reset = (card) => { card.style.transform = ""; };
  container.addEventListener("pointermove", (e) => {
    const card = e.target.closest(selector);
    if (current && current !== card) reset(current);
    current = card;
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    card.style.setProperty("--mx", `${px * 100}%`);
    card.style.setProperty("--my", `${py * 100}%`);
    card.style.transform = `perspective(900px) rotateX(${(0.5 - py) * maxX}deg) rotateY(${(px - 0.5) * maxY}deg) translateY(-4px)`;
  });
  container.addEventListener("pointerleave", () => {
    if (current) reset(current);
    current = null;
  });
}

/** Подключает базовые эффекты страницы одним вызовом. */
export function initFx() {
  initCursor();
  initWebBackground();
  initMagnetic();
  initReveal();
}
