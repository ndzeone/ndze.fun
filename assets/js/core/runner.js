// Мини-игра «Человек-паук бежит по крышам» — бесконечный раннер на canvas с онлайн-таблицей рекордов.
// Стоит на странице 404, но встраивается куда угодно:
//
//   import { mountRunner } from "../core/runner.js";
//   const game = mountRunner(container, { compact: false }); // compact — без таблицы рекордов, ниже ростом
//   game.destroy();                                           // остановить цикл, снять обработчики, очистить контейнер
//
// Перед вызовом страница должна сделать `await mountLayout(...)` — от него берём пользователя и окно входа.
//
// Всё рисуется кодом, без картинок: логическое разрешение 320–420×180, увеличенное в целое число
// аппаратных пикселей (с учётом devicePixelRatio) — пиксель-арт остаётся чётким на любом экране.
//
// Очки: 1 за каждые 10 px пути + 5 за жетон-паутинку. Скорость растёт от 130 до 320 px/с,
// жетоны не чаще трёх на две крыши — темп не выше ~45 очков/с. Сервер (api/lib/minecraft.php)
// отклоняет больше 80 очков на секунду с момента api.gameStart(), так что честный забег проходит всегда.
import { api } from "../data/api.js";
import { getUser, onUserChange, openAuth } from "./layout.js";
import { esc, motion, toast, avatarHTML, plural } from "./util.js";

/* ---------- Константы мира (всё в логических пикселях и секундах) ---------- */
const H = 180;                 // высота сцены
const MIN_W = 320;             // ширина сцены подстраивается под экран в этих пределах
const MAX_W = 420;
const PX = 52;                 // экранная x героя (мир едет, герой стоит)
const HB_X = 2, HB_W = 8, HB_H = 15; // хитбокс внутри спрайта 12×16
const G = 1150;                // гравитация
const JUMP_V = -305;           // прыжок с зажатой кнопкой — ~40 px вверх
const CUT_V = -120;            // отпустил кнопку на взлёте — прыжок короче
const SWING_V = -265;          // второй прыжок в воздухе — рывок на паутине
const DIVE_V = 300;            // ↓ / S в воздухе — быстрее вниз
const MAX_FALL = 480;
const COYOTE = 0.08;           // можно прыгнуть чуть позже, чем крыша кончилась
const BUFFER = 0.12;           // нажатие чуть раньше приземления не теряется
const BASE_SPEED = 130;
const MAX_SPEED = 320;         // 32 очка/с за путь — далеко от серверного лимита 80/с
const ACCEL = 4.2;             // +px/с каждую секунду: максимум через ~45 с
const STEP = 1 / 120;          // фиксированный шаг физики — без «прострела» сквозь тонкие антенны
const COIN_BONUS = 5;
const TILE = 480;              // ширина повторяющегося слоя фона
const BEST_KEY = "ndze:runner:best";

/* ---------- Спрайты героя (12×16) ---------- */
const PAL = { R: "#e8303f", r: "#9e1c2a", B: "#2f5bd6", b: "#1b3584", W: "#f8f8f8", k: "#0f0f0f" };
const HEAD = [
  "....rRRr....",
  "...RRRRRR...",
  "..RRRRRRRR..",
  "..RWWRRWWR..",
  "..RkWRRWkR..",
  "..rRRRRRRr..",
  "...rRRRRr...",
];
const TORSO = {
  a: ["..BBRRRRBB..", ".BBRRkkRRBBR", ".BRRRkkRRB..", "RR.BRRRRB...", "...bBBBBb..."],
  b: ["..BBRRRRBB..", "RBBRRkkRRBB.", "..BRRkkRRRB.", "...BRRRRB.RR", "...bBBBBb..."],
  idle: ["..BBRRRRBB..", ".BBRRkkRRBB.", ".BRRRkkRRRB.", ".R.BRRRRB.R.", "...bBBBBb..."],
};
const LEGS = {
  run1: ["...BB..BB...", "..BB....BB..", ".rR......RR.", ".RR.......RR"],
  run2: ["....BBBB....", ".....BBB....", ".....RRR....", "....RRRR...."],
  run3: ["...BB.BB....", "...B...BB...", "..RR....RR..", "..R......RR."],
  run4: ["....BBBB....", "....BB.BB...", "....RR..RR..", "....RR......"],
  idle: ["...BB..BB...", "...BB..BB...", "...RR..RR...", "..RRR..RRR.."],
  jump: ["...BBBBBB...", "..BB....BB..", "..RR.....RR.", "............"],
};
// Рывок на паутине: правая рука вскинута вверх, кисть — точка, откуда тянется нить (10, 0)
const SWING = [
  "....rRRr..R.",
  "...RRRRRR.R.",
  "..RRRRRRRRB.",
  "..RWWRRWWRB.",
  "..RkWRRWkRB.",
  "..rRRRRRRrB.",
  "...rRRRRrB..",
  "..BBRRRRB...",
  ".BBRRkkRR...",
  "RBRRRkkRR...",
  ".R.BRRRRB...",
  "...bBBBBb...",
  ...LEGS.jump,
];

let SPR = null; // собираем один раз на все игры на странице
function buildSprites() {
  if (SPR) return SPR;
  const make = (rows) => {
    const c = document.createElement("canvas");
    c.width = 12;
    c.height = 16;
    const g = c.getContext("2d");
    rows.forEach((row, y) => {
      [...row.padEnd(12, ".")].slice(0, 12).forEach((ch, x) => {
        if (!PAL[ch]) return;
        g.fillStyle = PAL[ch];
        g.fillRect(x, y, 1, 1);
      });
    });
    return c;
  };
  SPR = {
    run: [
      make([...HEAD, ...TORSO.a, ...LEGS.run1]),
      make([...HEAD, ...TORSO.a, ...LEGS.run2]),
      make([...HEAD, ...TORSO.b, ...LEGS.run3]),
      make([...HEAD, ...TORSO.b, ...LEGS.run4]),
    ],
    idle: make([...HEAD, ...TORSO.idle, ...LEGS.idle]),
    jump: make([...HEAD, ...TORSO.a, ...LEGS.jump]),
    fall: make([...HEAD, ...TORSO.b, ...LEGS.run2]),
    swing: make(SWING),
  };
  return SPR;
}

/* ---------- Случайности ---------- */
// Детерминированный генератор — фон один и тот же при каждом заходе
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = Math.random;
const randInt = (a, b, r = rnd) => a + Math.floor(r() * (b - a + 1));
const pick = (arr, r = rnd) => arr[Math.floor(r() * arr.length)];
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/* ---------- Фон: небо, луна, два слоя города ---------- */
const SKY = ["#07080f", "#0a0c18", "#0e1122", "#13152c", "#1a1734", "#241a3a", "#2e1d3c"];

function makeSky(w) {
  const [c, g] = newCanvas(w, H);
  const band = Math.ceil(H / SKY.length);
  SKY.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(0, i * band, w, band);
    if (i === 0) return;
    // шахматный дизеринг на стыке полос — градиент без размытия
    g.fillStyle = SKY[i - 1];
    for (let x = 0; x < w; x += 2) {
      g.fillRect(x, i * band, 1, 1);
      g.fillRect(x + 1, i * band + 2, 1, 1);
    }
  });
  const r = mulberry32(404);
  for (let i = 0; i < 46; i++) {
    g.fillStyle = r() < 0.25 ? "#f8f8f8" : r() < 0.5 ? "#9aa3c7" : "#5b6385";
    g.fillRect(Math.floor(r() * w), Math.floor(r() * 104), 1, 1);
  }
  // Луна с паучком на ниточке
  const cx = w - 74, cy = 50, rad = 14;
  g.fillStyle = "rgba(238, 243, 224, .07)";
  disc(g, cx, cy, rad + 4);
  g.fillStyle = "#eef3e0";
  disc(g, cx, cy, rad);
  g.fillStyle = "#cfd6c0";
  g.fillRect(cx - 6, cy - 4, 3, 3);
  g.fillRect(cx + 3, cy + 4, 4, 2);
  g.fillRect(cx - 2, cy + 7, 2, 2);
  g.fillRect(cx + 6, cy - 7, 2, 2);
  g.fillStyle = "#0f0f0f";
  g.fillRect(cx + 1, cy - rad - 6, 1, rad + 8); // нить
  g.fillRect(cx, cy + 2, 3, 2);                // паучок
  g.fillRect(cx - 1, cy + 1, 1, 1);
  g.fillRect(cx + 3, cy + 1, 1, 1);
  g.fillRect(cx - 1, cy + 4, 1, 1);
  g.fillRect(cx + 3, cy + 4, 1, 1);
  return c;
}

function disc(g, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy));
    g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

/** Повторяющийся слой силуэтов. Здания у правого края дорисовываются и слева — шов не виден. */
function makeLayer(seed, { color, edge, topMin, topMax, wMin, wMax, win, lit, litColors, winW, winH, stepX, stepY }) {
  const [c, g] = newCanvas(TILE, H);
  const r = mulberry32(seed);
  let x = 0;
  while (x < TILE) {
    const w = randInt(wMin, wMax, r);
    const top = randInt(topMin, topMax, r);
    const spire = r() < 0.22;
    const tank = !spire && r() < 0.18;
    const windows = [];
    for (let wy = top + 5; wy < H - 4; wy += stepY) {
      for (let wx = 3; wx < w - winW - 1; wx += stepX) {
        const on = r() < lit;
        windows.push([wx, wy - top, on ? pick(litColors, r) : win, r() < 0.5]);
      }
    }
    for (const off of [0, -TILE]) {
      const bx = x + off;
      g.fillStyle = color;
      g.fillRect(bx, top, w, H - top);
      if (edge) {
        g.fillStyle = edge;
        g.fillRect(bx, top, 1, H - top);
      }
      if (spire) {
        g.fillStyle = color;
        g.fillRect(bx + Math.floor(w / 2) - 1, top - 6, 3, 6);
        g.fillRect(bx + Math.floor(w / 2), top - 14, 1, 8);
      }
      if (tank) {
        g.fillStyle = color;
        g.fillRect(bx + 4, top - 7, 8, 5);
        g.fillRect(bx + 5, top - 2, 1, 2);
        g.fillRect(bx + 10, top - 2, 1, 2);
      }
      for (const [wx, wy, col, show] of windows) {
        if (!show && col === win) continue; // часть тёмных окон пропускаем — меньше «сетки»
        g.fillStyle = col;
        g.fillRect(bx + wx, top + wy, winW, winH);
      }
    }
    x += w + randInt(0, 6, r);
  }
  return c;
}

/* ---------- Передний план: фасады крыш ---------- */
const WIN_LIT = ["#ffd27a", "#ffd27a", "#ffbf5a", "#5dd62c", "#9fd3ff"];

function makeFacade(w, top) {
  const h = H - top + 2;
  const [c, g] = newCanvas(w, h);
  g.fillStyle = "#1e1e23";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#16161a";
  g.fillRect(w - 2, 0, 2, h);
  // карниз
  g.fillStyle = "#4a4a52";
  g.fillRect(0, 0, w, 1);
  g.fillStyle = "#2c2c33";
  g.fillRect(0, 1, w, 2);
  g.fillStyle = "#111114";
  g.fillRect(0, 3, w, 1);
  // окна
  const cols = Math.max(1, Math.floor((w - 6) / 10));
  const x0 = Math.floor((w - (cols * 10 - 5)) / 2);
  for (let y = 10; y < h - 4; y += 13) {
    for (let i = 0; i < cols; i++) {
      const lit = rnd() < 0.2;
      g.fillStyle = lit ? pick(WIN_LIT) : "#121216";
      g.fillRect(x0 + i * 10, y, 5, 7);
      if (lit) {
        g.fillStyle = "rgba(15, 15, 15, .35)";
        g.fillRect(x0 + i * 10, y + 3, 5, 1); // рама
      }
    }
  }
  return c;
}

/* ---------- Препятствия ---------- */
const OBSTACLES = [
  { type: "chimney", weight: 3, from: 0, make: () => ({ w: randInt(8, 10), h: randInt(11, 18) }) },
  { type: "ac", weight: 3, from: 0, make: () => ({ w: 14, h: 9 }) },
  { type: "vent", weight: 2, from: 0, make: () => ({ w: 6, h: randInt(10, 15) }) },
  { type: "antenna", weight: 2, from: 150, make: () => ({ w: 3, h: randInt(20, 26) }) },
  { type: "tank", weight: 1.5, from: 185, make: () => ({ w: 18, h: 22 }) },
];

function makeObstacle(speed) {
  const pool = OBSTACLES.filter((o) => speed >= o.from);
  let roll = rnd() * pool.reduce((s, o) => s + o.weight, 0);
  const def = pool.find((o) => (roll -= o.weight) < 0) || pool[0];
  return { type: def.type, ...def.make(), x: 0, y: 0 };
}

function drawObstacle(g, o, sx, clock) {
  const { y, w, h } = o;
  switch (o.type) {
    case "chimney":
      g.fillStyle = "#7a3328";
      g.fillRect(sx, y + 2, w, h - 2);
      g.fillStyle = "#55211a";
      for (let i = 4; i < h; i += 3) g.fillRect(sx, y + i, w, 1);
      for (let i = 4, odd = 0; i < h - 1; i += 3, odd ^= 1) g.fillRect(sx + (odd ? 2 : 5), y + i + 1, 1, 2);
      g.fillStyle = "#3d3d44";
      g.fillRect(sx - 1, y, w + 2, 2);
      g.fillStyle = "#5a5a63";
      g.fillRect(sx - 1, y, w + 2, 1);
      break;
    case "ac":
      g.fillStyle = "#3a3e46";
      g.fillRect(sx + 1, y + h - 1, 2, 1);
      g.fillRect(sx + w - 3, y + h - 1, 2, 1);
      g.fillStyle = "#9097a3";
      g.fillRect(sx, y, w, h - 1);
      g.fillStyle = "#b9c0cb";
      g.fillRect(sx, y, w, 1);
      g.fillStyle = "#5b6270";
      g.fillRect(sx + 2, y + 2, 7, 5);
      g.fillStyle = "#2e333c";
      g.fillRect(sx + 5, y + 2, 1, 5);
      g.fillRect(sx + 2, y + 4, 7, 1);
      g.fillStyle = "#6c7380";
      g.fillRect(sx + 10, y + 2, 2, 1);
      g.fillRect(sx + 10, y + 4, 2, 1);
      break;
    case "vent":
      g.fillStyle = "#5d6852";
      g.fillRect(sx + 1, y + 3, w - 2, h - 3);
      g.fillStyle = "#7a8a6a";
      g.fillRect(sx + 1, y + 3, 1, h - 3);
      g.fillStyle = "#8b9878";
      g.fillRect(sx, y, w, 2);
      g.fillStyle = "#2d3328";
      g.fillRect(sx + 1, y + 2, w - 2, 1);
      break;
    case "antenna": {
      g.fillStyle = "#9aa0aa";
      g.fillRect(sx + 1, y + 3, 1, h - 3);
      g.fillRect(sx - 2, y + 8, 7, 1);
      g.fillRect(sx - 1, y + 13, 5, 1);
      g.fillStyle = "#5b6070";
      g.fillRect(sx, y + h - 2, 3, 2);
      const on = !motion || Math.sin(clock * 5) > -0.2;
      g.fillStyle = on ? "#ff3b4a" : "#5a1a20";
      g.fillRect(sx + 1, y, 1, 2);
      if (on) {
        g.fillStyle = "rgba(255, 59, 74, .35)";
        g.fillRect(sx, y - 1, 3, 4);
      }
      break;
    }
    case "tank":
      g.fillStyle = "#4e351d";
      g.fillRect(sx + 2, y + 14, 2, h - 14);
      g.fillRect(sx + w - 4, y + 14, 2, h - 14);
      g.fillRect(sx + 2, y + 18, w - 4, 1);
      g.fillStyle = "#7a5530";
      g.fillRect(sx, y + 3, w, 11);
      g.fillStyle = "#8f6a3e";
      g.fillRect(sx + 1, y + 3, 2, 11);
      g.fillStyle = "#4e351d";
      g.fillRect(sx, y + 6, w, 1);
      g.fillRect(sx, y + 11, w, 1);
      g.fillStyle = "#5c3f22";
      g.fillRect(sx + 2, y + 1, w - 4, 2);
      g.fillRect(sx + 6, y, w - 12, 1);
      break;
  }
}

/** Пиксельная линия (Брезенхем) — нить паутины. */
function pixelLine(g, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 600; n++) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/* ---------- Локальный рекорд ---------- */
function loadBest() {
  try {
    return Math.max(0, parseInt(localStorage.getItem(BEST_KEY), 10) || 0);
  } catch {
    return 0;
  }
}
function saveBest(n) {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch { /* приватный режим — просто не запомним */ }
}

const pad = (n) => String(n).padStart(5, "0");
const points = (n) => plural(n, ["очко", "очка", "очков"]);

/* ---------- Разметка ---------- */
let uid = 0;

function markup(id, compact) {
  const board = compact ? "" : `
    <aside class="rn-board glass" aria-labelledby="${id}-bt">
      <div class="rn-board-head">
        <h2 class="rn-board-title" id="${id}-bt">Рекорды</h2>
        <div class="rn-tabs" role="tablist" aria-label="Период">
          <button type="button" role="tab" id="${id}-tab-all" aria-controls="${id}-panel" aria-selected="true" data-tab="all">Всё время</button>
          <button type="button" role="tab" id="${id}-tab-week" aria-controls="${id}-panel" aria-selected="false" data-tab="week" tabindex="-1">Неделя</button>
        </div>
      </div>
      <div class="rn-board-panel" id="${id}-panel" role="tabpanel" aria-labelledby="${id}-tab-all">
        <ol class="rn-list" data-ref="list" aria-busy="true">${'<li class="rn-row-skel skeleton"></li>'.repeat(5)}</ol>
      </div>
      <p class="rn-board-note" data-ref="boardNote"></p>
    </aside>`;

  return `
  <div class="rn-layout">
    <div class="rn-play">
      <div class="rn-frame" data-ref="frame">
        <div class="rn-stage" data-ref="stage" tabindex="0" role="group" aria-roledescription="мини-игра"
             aria-label="Человек-паук бежит по крышам" aria-describedby="${id}-hint">
          <canvas class="rn-canvas" data-ref="canvas" role="img"
                  aria-label="Пиксельный ночной город: Человек-паук бежит по крышам и перепрыгивает трубы, антенны и пропасти между домами"></canvas>

          <div class="rn-hud">
            <p class="rn-hud-score"><span>счёт</span> <b data-ref="score">00000</b></p>
            <div class="rn-hud-right">
              <p class="rn-hud-best"><span>рекорд</span> <b data-ref="best">00000</b></p>
              <button class="rn-pause-btn" type="button" data-act="pause" aria-label="Пауза" hidden><i></i><i></i></button>
            </div>
          </div>

          <div class="rn-screen" data-screen="ready">
            <p class="rn-kicker">мини-игра</p>
            <h2 class="rn-title">Человек-паук бежит по&nbsp;крышам</h2>
            <p class="rn-text">Перепрыгивай трубы, антенны и пропасти. В воздухе — ещё рывок на паутине.</p>
            <button class="btn btn-primary btn-sm" type="button" data-act="start">Начать забег</button>
            <p class="rn-keys">Пробел · ↑ · W · тап</p>
          </div>

          <div class="rn-screen" data-screen="paused" hidden>
            <h2 class="rn-title">Пауза</h2>
            <button class="btn btn-primary btn-sm" type="button" data-act="resume">Продолжить</button>
            <p class="rn-keys">Esc · P — продолжить</p>
          </div>

          <div class="rn-screen" data-screen="over" hidden>
            <p class="rn-kicker">забег окончен</p>
            <p class="rn-over-score"><b data-ref="overScore">0</b> <span data-ref="overUnit">очков</span></p>
            <p class="rn-over-best" data-ref="overBest"></p>
            <button class="btn btn-primary btn-sm" type="button" data-act="start">Ещё раз</button>
            <p class="rn-keys">Пробел · Enter · R</p>
          </div>
        </div>
      </div>
      <div class="rn-status" data-ref="status" role="status" aria-live="polite"></div>
      <p class="rn-hint" id="${id}-hint">
        <kbd>Пробел</kbd>, <kbd>↑</kbd>, <kbd>W</kbd> или тап — прыжок, держи — выше. В воздухе ещё раз — рывок на паутине,
        <kbd>↓</kbd> — вниз быстрее. <kbd>Esc</kbd> / <kbd>P</kbd> — пауза.
      </p>
    </div>
    ${board}
  </div>`;
}

/* =========================================================
   mountRunner
   ========================================================= */
export function mountRunner(container, { compact = false } = {}) {
  const id = `rn${++uid}`;
  const spr = buildSprites();
  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });

  container.innerHTML = `<div class="rn${compact ? " is-compact" : ""}">${markup(id, compact)}</div>`;
  const root = container.firstElementChild;
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const stage = ref("stage");
  const canvas = ref("canvas");
  const ctx = canvas.getContext("2d");
  const screens = Object.fromEntries([...root.querySelectorAll("[data-screen]")].map((el) => [el.dataset.screen, el]));
  const hud = { score: ref("score"), best: ref("best"), pause: root.querySelector('[data-act="pause"]') };
  const statusEl = ref("status");
  const listEl = ref("list");

  // Фоновые слои — один раз на игру
  const far = makeLayer(7, {
    color: "#121828", edge: null, topMin: 62, topMax: 122, wMin: 16, wMax: 42,
    win: "#1d2538", lit: 0.05, litColors: ["#6b5b2a", "#3f6b2a"], winW: 1, winH: 1, stepX: 4, stepY: 5,
  });
  const mid = makeLayer(21, {
    color: "#191f30", edge: "#232b42", topMin: 92, topMax: 146, wMin: 24, wMax: 58,
    win: "#222a3f", lit: 0.12, litColors: ["#e0b85a", "#c99a3c", "#5dd62c", "#7fb6ff"], winW: 2, winH: 2, stepX: 5, stepY: 6,
  });

  /* ---------- Состояние ---------- */
  let W = MIN_W;         // логическая ширина сцены
  let scale = 0;         // аппаратных пикселей на логический
  let sky = null;
  let state = "ready";   // ready | running | paused | dying | over
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let clock = 0;         // время анимаций (мигание, звёзды)
  let drift = 0;         // медленный дрейф фона на заставке
  let dirty = true;
  let onScreen = true;
  let destroyed = false;

  let cam = 0, dist = 0, bonus = 0, runT = 0, speed = BASE_SPEED;
  let buildings = [], obstacles = [], solids = [], coins = [], particles = [];
  let coinsPrev = false;
  let deathT = 0, shake = 0;
  let web = null;        // { x, y } — точка крепления нити в мире
  const hero = { y: 0, vy: 0, grounded: true, coyote: 0, buffer: 0, swing: 0, swingUsed: false, canCut: false, anim: 0 };

  let held = false;      // кнопка прыжка зажата
  let queued = false;    // нажатие ждёт обработки на ближайшем шаге
  let pointerId = null;
  let overAt = 0;

  let best = loadBest();
  let shownScore = -1;

  // Сеть: запросы забега строго по очереди, чтобы gameScore прошлого забега не обогнал gameStart следующего
  let net = Promise.resolve();
  const queue = (fn) => {
    const p = net.then(fn, fn);
    net = p.catch(() => {});
    return p;
  };
  let runStart = null;   // Promise от api.gameStart() текущего забега (только для вошедших)
  let runUserId = null;
  let statusKind = "idle";

  /* ---------- Размер: целый масштаб под ширину колонки ---------- */
  function fit() {
    const avail = ref("frame").clientWidth;
    if (!avail) return;
    const dpr = window.devicePixelRatio || 1;
    const maxCssH = compact ? 300 : 540;
    let k = Math.max(1, Math.floor((avail * dpr) / MIN_W));
    while (k > 1 && (H * k) / dpr > maxCssH) k--;
    const w = clampN(Math.floor((avail * dpr) / k), MIN_W, MAX_W);
    const cssW = Math.min(avail, (w * k) / dpr); // уже 320 логических — ужимаем (очень узкие экраны)
    stage.style.width = `${cssW}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${(cssW * H) / w}px`;
    if (w === W && k === scale) return;
    W = w;
    scale = k;
    canvas.width = W * k;
    canvas.height = H * k;
    sky = makeSky(W);
    dirty = true;
    render();
  }

  /* ---------- Мир ---------- */
  function resetWorld() {
    cam = 0; dist = 0; bonus = 0; runT = 0; speed = BASE_SPEED; acc = 0;
    deathT = 0; shake = 0; web = null; coinsPrev = false;
    buildings = []; obstacles = []; solids = []; coins = []; particles = [];
    const first = { x: -40, top: 134, w: 440, first: true };
    first.facade = makeFacade(first.w, first.top);
    buildings.push(first);
    solids.push({ x: first.x, y: first.top, w: first.w, h: 400 });
    Object.assign(hero, { y: first.top - HB_H, vy: 0, grounded: true, coyote: 0, buffer: 0, swing: 0, swingUsed: false, canCut: false, anim: 0 });
    ensureWorld();
  }

  function addBuilding() {
    const prev = buildings[buildings.length - 1];
    const sp = Math.max(speed, BASE_SPEED);
    const gapMax = Math.round(Math.min(26 + sp * 0.24, sp * 0.36));
    const gap = rnd() < 0.78 ? randInt(16, Math.max(18, gapMax)) : 0;
    // Через пропасть — выше не больше чем на 14 px; вплотную — уступ вниз или невысокая стенка
    let top = gap > 0 ? prev.top + randInt(-14, 20) : prev.top + (rnd() < 0.55 ? randInt(6, 18) : randInt(-10, -6));
    top = clampN(top, 104, 150);
    const b = { x: prev.x + prev.w + gap, top, w: randInt(110, 220) + Math.round(sp * 0.25) };
    b.facade = makeFacade(b.w, b.top);
    buildings.push(b);
    solids.push({ x: b.x, y: b.top, w: b.w, h: 400 });
    placeObstacles(b, sp, gap);
    placeCoins(b);
  }

  function placeObstacles(b, sp, gap) {
    // Свободные зоны: после прыжка через пропасть герой приземляется примерно в 0.2·скорости от края —
    // даём ещё ~0.5 с на реакцию; перед краем крыши — место для разбега к следующему прыжку.
    const end = b.x + b.w - Math.max(44, Math.round(sp * 0.5));
    const spacing = Math.round(sp * 0.75) + 24; // после приземления успеть прыгнуть снова
    const chance = Math.min(0.85, 0.45 + (sp - BASE_SPEED) / 400);
    let x = b.x + Math.max(56, Math.round(sp * (gap > 0 ? 0.75 : 0.4))) + randInt(0, 30);
    while (x < end) {
      if (rnd() < chance) {
        const o = makeObstacle(sp);
        if (x + o.w > end) break;
        o.x = x;
        o.y = b.top - o.h;
        obstacles.push(o);
        solids.push(o);
        x += o.w + spacing + randInt(0, 60);
      } else {
        x += randInt(40, 80);
      }
    }
  }

  function placeCoins(b) {
    // Жетоны — дугой над крышей, не чаще чем на каждой второй (держим темп очков в рамках)
    if (coinsPrev || b.w < 140 || rnd() > 0.4) {
      coinsPrev = false;
      return;
    }
    coinsPrev = true;
    const x0 = b.x + randInt(40, b.w - 70);
    const y0 = b.top - randInt(22, 32);
    for (let i = 0; i < 3; i++) {
      const c = { x: x0 + i * 12, y: y0 - (i === 1 ? 5 : 0), taken: false };
      const blocked = obstacles.some((o) => c.x + 5 > o.x - 2 && c.x < o.x + o.w + 2 && c.y + 5 > o.y - 2);
      if (!blocked) coins.push(c);
    }
  }

  function ensureWorld() {
    while (buildings[buildings.length - 1].x + buildings[buildings.length - 1].w < cam + W + 120) addBuilding();
    if (buildings[0].x + buildings[0].w < cam - 40) {
      const alive = (o) => o.x + o.w > cam - 40;
      buildings = buildings.filter(alive);
      obstacles = obstacles.filter(alive);
      solids = solids.filter(alive);
      coins = coins.filter((c) => !c.taken && c.x + 5 > cam - 20);
    }
  }

  /* ---------- Частицы ---------- */
  function burst(x, y, n, colors, spread = 60, up = 80) {
    if (!motion) return; // без анимаций — без конфетти
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y, vx: (rnd() - 0.5) * spread * 2, vy: -rnd() * up, life: 0.35 + rnd() * 0.35, color: pick(colors),
      });
    }
  }

  /* ---------- Физика ---------- */
  const score = () => Math.floor(dist / 10) + bonus;

  function doJump() {
    hero.vy = JUMP_V;
    hero.grounded = false;
    hero.coyote = 0;
    hero.buffer = 0;
    hero.canCut = true;
    burst(cam + PX + 6, hero.y + HB_H, 4, ["#55555e", "#3c3c44"], 30, 20);
  }

  function doSwing() {
    hero.vy = SWING_V;
    hero.swingUsed = true;
    hero.canCut = false;
    hero.swing = 0.35;
    web = { x: Math.round(cam + PX + 58 + rnd() * 18), y: 0 };
  }

  function tick(h) {
    clock += h;
    if (state === "running") {
      runT += h;
      speed = Math.min(MAX_SPEED, BASE_SPEED + ACCEL * runT);
      dist += speed * h;
    } else {
      speed = Math.max(0, speed - 520 * h); // dying: мир тормозит
    }
    cam += speed * h;
    if (shake > 0) shake -= h;

    updateHero(h);
    ensureWorld();

    // жетоны
    const L = cam + PX + HB_X, top = hero.y;
    for (const c of coins) {
      if (c.taken || state !== "running") continue;
      if (c.x < L + HB_W && c.x + 5 > L && c.y < top + HB_H && c.y + 5 > top) {
        c.taken = true;
        bonus += COIN_BONUS;
        burst(c.x + 2, c.y + 2, 6, ["#5dd62c", "#b6f59a", "#f8f8f8"], 40, 50);
      }
    }
    // частицы
    for (const p of particles) {
      p.life -= h;
      p.vy += 300 * h;
      p.x += p.vx * h;
      p.y += p.vy * h;
    }
    if (particles.length) particles = particles.filter((p) => p.life > 0);

    if (state === "dying") {
      deathT += h;
      if (deathT > 0.9 || hero.y > H + 60) gameOver();
    }
  }

  function updateHero(h) {
    const p = hero;
    p.anim += h * (6 + speed / 28);
    if (state === "dying") {
      p.vy = Math.min(MAX_FALL, p.vy + G * h);
      p.y += p.vy * h;
      return;
    }
    p.coyote -= h;
    p.buffer -= h;
    if (p.swing > 0) p.swing -= h;

    if (queued) {
      queued = false;
      if (p.grounded || p.coyote > 0) doJump();
      else if (!p.swingUsed) doSwing();
      else p.buffer = BUFFER;
    }
    if (!held && p.canCut && p.vy < CUT_V) {
      p.vy = CUT_V;
      p.canCut = false;
    }

    const prevBottom = p.y + HB_H;
    p.vy = Math.min(MAX_FALL, p.vy + G * h);
    p.y += p.vy * h;

    const L = cam + PX + HB_X, R = L + HB_W;
    const wasGrounded = p.grounded;
    p.grounded = false;

    // Приземление: были над верхом опоры, стали на нём или ниже
    if (p.vy >= 0) {
      let land = Infinity;
      for (const s of solids) {
        if (s.x < R && s.x + s.w > L && prevBottom <= s.y + 0.5 && p.y + HB_H >= s.y) land = Math.min(land, s.y);
      }
      if (land !== Infinity) {
        p.y = land - HB_H;
        p.vy = 0;
        p.grounded = true;
      }
    }

    // Удар сбоку (стена дома или препятствие). Ступеньку до 3 px перешагиваем.
    for (const s of solids) {
      const bottom = p.y + HB_H;
      if (s.x < R && s.x + s.w > L && s.y < bottom - 0.5 && s.y + s.h > p.y) {
        if (bottom - s.y <= 3 && p.vy >= 0) {
          p.y = s.y - HB_H;
          p.vy = 0;
          p.grounded = true;
          continue;
        }
        crash();
        return;
      }
    }

    if (p.grounded) {
      p.coyote = COYOTE;
      p.swingUsed = false;
      p.canCut = false;
      if (!wasGrounded) {
        burst(cam + PX + 6, p.y + HB_H, 5, ["#55555e", "#3c3c44", "#6a6a74"], 40, 30);
        if (p.buffer > 0) doJump();
      }
    }

    if (p.y > H + 8) fall();
  }

  function crash() {
    state = "dying";
    deathT = 0;
    hero.vy = -170;
    hero.swing = 0;
    shake = motion ? 0.25 : 0;
    burst(cam + PX + 6, hero.y + 6, 16, ["#e8303f", "#2f5bd6", "#f8f8f8"], 70, 120);
    hud.pause.hidden = true;
  }

  function fall() {
    state = "dying";
    deathT = 0.5; // герой уже под крышами — экран итогов чуть раньше
    hud.pause.hidden = true;
  }

  /* ---------- Отрисовка ---------- */
  function drawLayer(img, off) {
    const o = ((Math.round(off) % TILE) + TILE) % TILE;
    for (let x = -o; x < W; x += TILE) ctx.drawImage(img, x, 0);
  }

  function render() {
    if (!sky) return;
    const g = ctx;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(sky, 0, 0);

    // мерцающие звёзды
    if (motion) {
      for (let i = 0; i < 8; i++) {
        const a = Math.sin(clock * (1.3 + i * 0.37) + i * 2.1);
        if (a < 0.55) continue;
        g.fillStyle = a > 0.9 ? "#f8f8f8" : "#8f98bd";
        g.fillRect((i * 53 + 17) % W, 6 + ((i * 29) % 90), 1, 1);
      }
    }

    // Параллакс. Без анимаций дальние слои почти стоят — меньше движения на экране.
    const pf = motion ? 1 : 0.3;
    drawLayer(far, cam * 0.12 * pf + drift * 0.5);
    drawLayer(mid, cam * 0.35 * pf + drift);

    let sxShake = 0, syShake = 0;
    if (shake > 0) {
      sxShake = Math.round((rnd() - 0.5) * 4);
      syShake = Math.round((rnd() - 0.5) * 4);
      g.setTransform(scale, 0, 0, scale, sxShake * scale, syShake * scale);
    }

    const camR = Math.round(cam);
    for (const b of buildings) {
      const sx = b.x - camR;
      if (sx > W || sx + b.w < 0) continue;
      g.drawImage(b.facade, sx, b.top);
    }
    for (const o of obstacles) {
      const sx = o.x - camR;
      if (sx > W + 4 || sx + o.w < -4) continue;
      drawObstacle(g, o, sx, clock);
    }

    // жетоны-паутинки: крутятся (ширина 5 → 3 → 1 → 3)
    const spin = motion ? [5, 3, 1, 3][Math.floor(clock * 8) % 4] : 5;
    for (const c of coins) {
      if (c.taken) continue;
      const sx = Math.round(c.x) - camR;
      if (sx > W || sx < -6) continue;
      const cy = Math.round(c.y);
      const x0 = sx + Math.floor((5 - spin) / 2);
      g.fillStyle = "#337418";
      g.fillRect(x0, cy + 1, spin, 3);
      g.fillStyle = "#5dd62c";
      g.fillRect(x0, cy + 1, spin, 2);
      g.fillRect(x0 + (spin > 2 ? 1 : 0), cy, Math.max(1, spin - 2), 5);
      g.fillStyle = "#f8f8f8";
      g.fillRect(sx + 2, cy + 2, 1, 1);
    }

    // нить паутины
    const hy = Math.round(hero.y) - 1;
    if (web && hero.swing > 0 && state !== "dying") {
      g.fillStyle = "rgba(248, 248, 248, .85)";
      pixelLine(g, PX + 10, hy, web.x - camR, web.y);
    }

    // герой
    let img;
    if (state === "dying") img = Math.floor(deathT * 12) % 2 ? spr.fall : spr.jump;
    else if ((state === "ready" || state === "over") && hero.grounded) img = spr.idle;
    else if (hero.swing > 0) img = spr.swing;
    else if (!hero.grounded) img = hero.vy < 0 ? spr.jump : spr.fall;
    else img = spr.run[Math.floor(hero.anim) % 4];
    if (state !== "dying" || deathT < 0.9) g.drawImage(img, PX, hy);

    for (const p of particles) {
      g.fillStyle = p.color;
      g.fillRect(Math.round(p.x) - camR, Math.round(p.y), 1, 1);
    }
  }

  /* ---------- Цикл ---------- */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (state === "running" || state === "dying") {
      acc += dt;
      while (acc >= STEP && (state === "running" || state === "dying")) {
        tick(STEP);
        acc -= STEP;
      }
      updateHud();
      dirty = true;
    } else if (state === "ready" && motion) {
      clock += dt;
      drift += dt * 6;
      dirty = true;
    }
    if (dirty && onScreen) {
      render();
      dirty = false;
    }
  }

  function updateHud() {
    const s = score();
    if (s === shownScore) return;
    shownScore = s;
    hud.score.textContent = pad(s);
  }

  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  }

  /* ---------- Управление забегом ---------- */
  function start() {
    // Фокус — до скрытия экрана: иначе он пропадёт вместе с кнопкой и сработает автопауза
    stage.focus({ preventScroll: true });
    resetWorld();
    state = "running";
    held = false;
    queued = false;
    shownScore = -1;
    showScreen(null);
    hud.pause.hidden = false;
    updateHud();
    last = performance.now();

    const u = getUser();
    runUserId = u?.id ?? null;
    runStart = null;
    if (u && api.mode !== "local") {
      runStart = queue(() => api.gameStart());
      runStart.catch(() => {}); // ошибку покажем после забега
    }
    if (statusKind !== "idle" && statusKind !== "saving") idleStatus();
  }

  function pause() {
    if (state !== "running") return;
    state = "paused";
    held = false;
    queued = false;
    hud.pause.hidden = true;
    showScreen("paused");
    dirty = true;
  }

  function resume() {
    if (state !== "paused") return;
    stage.focus({ preventScroll: true });
    state = "running";
    showScreen(null);
    hud.pause.hidden = false;
    last = performance.now();
  }

  function gameOver() {
    state = "over";
    overAt = performance.now();
    held = false;
    queued = false;
    web = null;
    const s = score();
    const record = s > best;
    if (record) {
      best = s;
      saveBest(best);
      hud.best.textContent = pad(best);
    }
    ref("overScore").textContent = s;
    ref("overUnit").textContent = points(s);
    ref("overBest").textContent = record && s > 0 ? "Новый рекорд!" : `Рекорд: ${best}`;
    ref("overBest").classList.toggle("is-record", record && s > 0);
    showScreen("over");
    dirty = true;
    submit(s);
  }

  /** Нажатие «прыжка» — смысл зависит от состояния игры. */
  function press() {
    if (state === "ready") return start();
    if (state === "over") {
      if (performance.now() - overAt > 450) start(); // не перезапускать случайно тем же нажатием
      return;
    }
    if (state === "paused") return resume();
    if (state !== "running") return;
    held = true;
    queued = true;
  }

  function release() {
    held = false;
  }

  /* ---------- Рекорды на сервере ---------- */
  function setStatus(html, kind = "info", tone = "") {
    statusKind = kind;
    statusEl.className = `rn-status${tone ? ` is-${tone}` : ""}`;
    statusEl.innerHTML = html;
  }

  const loginBtn = `<button class="btn btn-ghost btn-xs" type="button" data-act="login">Войти</button>`;

  function idleStatus() {
    const u = getUser();
    if (api.mode === "local") setStatus("Демо-режим: здесь просто бегаем — таблица рекордов работает на ndze.fun.", "idle");
    else if (!u) setStatus(`<span>Войди, чтобы попасть в таблицу рекордов. Играть можно и так.</span>${loginBtn}`, "idle");
    else setStatus(`<span>Бежишь как <b>${esc(u.nick)}</b> — результаты попадут в таблицу рекордов.</span>`, "idle");
  }

  function submit(s) {
    const u = getUser();
    const what = `${s} ${points(s)}`;
    if (api.mode === "local") {
      setStatus(`<span>${what}! Рекорды сохраняются на ndze.fun — здесь демо-режим.</span>`, "result");
      return;
    }
    if (!u) {
      setStatus(`<span>${what}! Войди, чтобы попасть в таблицу рекордов.</span>${loginBtn}`, "guest");
      return;
    }
    if (!runStart || runUserId !== u.id) {
      setStatus(`<span>${what}. Этот забег начат без входа — следующий попадёт в таблицу.</span>`, "result");
      return;
    }
    if (s <= 0) {
      setStatus("<span>Ноль очков в таблицу не идёт — попробуй ещё раз!</span>", "result");
      return;
    }
    const startP = runStart;
    runStart = null; // один результат на забег
    setStatus(`<span>${what} — сохраняем результат…</span>`, "saving");
    queue(async () => {
      await startP;
      return api.gameScore(s);
    }).then(
      (r) => {
        if (destroyed) return;
        if (statusKind === "saving") {
          setStatus(`<span>Записали ${Number(r.score)} ${points(Number(r.score))}! Твой лучший — ${Number(r.best)}, место в таблице — <b>#${Number(r.rank)}</b>.</span>`, "result", "ok");
        }
        loadBoard();
      },
      (err) => {
        if (destroyed) return;
        toast(err.message, "error");
        if (statusKind === "saving") setStatus(`<span>Результат не сохранился: ${esc(err.message)}</span>`, "result", "error");
      },
    );
  }

  /* ---------- Таблица рекордов ---------- */
  let top = null;
  let boardTab = "all";
  let boardSeq = 0;

  async function loadBoard() {
    if (!listEl) return;
    const seq = ++boardSeq;
    listEl.setAttribute("aria-busy", "true");
    try {
      const data = await api.gameTop();
      if (seq !== boardSeq || destroyed) return;
      top = data;
      renderBoard();
    } catch (err) {
      if (seq !== boardSeq || destroyed) return;
      listEl.innerHTML = `<li class="rn-board-empty"><span>Не удалось загрузить рекорды: ${esc(err.message)}</span>
        <button class="btn btn-ghost btn-xs" type="button" data-act="retry">Ещё раз</button></li>`;
    } finally {
      if (seq === boardSeq && !destroyed) listEl.setAttribute("aria-busy", "false");
    }
  }

  function renderBoard() {
    if (!listEl || !top) return;
    const rows = top[boardTab] || [];
    const me = getUser()?.id ?? null;
    if (!rows.length) {
      listEl.innerHTML = `<li class="rn-board-empty"><span class="rn-board-icon" aria-hidden="true">🕸</span>
        <span>${boardTab === "week" ? "На этой неделе ещё никто не бегал" : "Пока никто не бегал"} — стань первым!</span></li>`;
    } else {
      listEl.innerHTML = rows.map((r, i) => {
        const mine = me !== null && r.user?.id === me;
        return `<li class="rn-row${mine ? " is-me" : ""}${i < 3 ? ` is-top${i + 1}` : ""}"${mine ? ' aria-current="true"' : ""}>
          <span class="rn-rank">${i + 1}</span>
          ${avatarHTML(r.user?.nick, r.user?.avatarUrl, { size: "sm" })}
          <span class="rn-nick"><span class="rn-nick-t">${esc(r.user?.nick)}</span>${mine ? '<span class="rn-you">ты</span>' : ""}</span>
          <span class="rn-score">${Number(r.score) || 0}</span>
        </li>`;
      }).join("");
    }
    const note = ref("boardNote");
    if (api.mode === "local") note.textContent = "Демо-режим: настоящая таблица — на ndze.fun.";
    else note.textContent = boardTab === "week" ? "Лучшие пять за последние 7 дней." : "Лучший забег каждого игрока.";
  }

  function setTab(next, focus = false) {
    boardTab = next;
    for (const b of root.querySelectorAll("[data-tab]")) {
      const sel = b.dataset.tab === next;
      b.setAttribute("aria-selected", String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus();
    }
    root.querySelector(".rn-board-panel")?.setAttribute("aria-labelledby", `${id}-tab-${next}`);
    renderBoard();
  }

  /* ---------- События ---------- */
  const JUMP_KEYS = new Set(["Space", "ArrowUp", "KeyW"]);

  on(stage, "keydown", (e) => {
    const onStage = e.target === stage; // на кнопках внутри сцены Пробел/Enter работают как обычно
    const code = e.code;
    if (JUMP_KEYS.has(code) && onStage) {
      e.preventDefault(); // не прокручивать страницу, пока игра в фокусе
      if (e.repeat) held = state === "running";
      else press();
    } else if ((code === "Enter" || code === "NumpadEnter") && onStage) {
      e.preventDefault();
      if (state === "ready" || state === "over" || state === "paused") press();
    } else if (code === "KeyR" && (state === "over" || state === "ready")) {
      e.preventDefault();
      press();
    } else if (code === "Escape" || code === "KeyP") {
      if (state === "running") pause();
      else if (state === "paused") resume();
      else return;
      e.preventDefault();
    } else if ((code === "ArrowDown" || code === "KeyS") && onStage) {
      e.preventDefault();
      if (state === "running" && !hero.grounded) hero.vy = Math.max(hero.vy, DIVE_V);
    }
  });
  on(stage, "keyup", (e) => {
    if (JUMP_KEYS.has(e.code)) release();
  });

  on(stage, "pointerdown", (e) => {
    if (e.target.closest("button, a")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); // не выделять текст и не терять фокус сцены
    stage.focus({ preventScroll: true });
    pointerId = e.pointerId;
    press();
  });
  const pointerEnd = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    release();
  };
  on(window, "pointerup", pointerEnd);
  on(window, "pointercancel", pointerEnd);
  on(stage, "contextmenu", (e) => { if (state === "running") e.preventDefault(); }); // долгий тап на телефоне

  // Фокус ушёл со сцены (клик мимо, Tab, другое окно) — пауза
  on(stage, "focusout", (e) => {
    if (state === "running" && !stage.contains(e.relatedTarget)) pause();
  });
  on(document, "visibilitychange", () => {
    if (document.hidden) pause();
    last = performance.now();
  });

  on(root, "click", (e) => {
    const btn = e.target.closest("[data-act], [data-tab]");
    if (!btn) return;
    if (btn.dataset.tab) return setTab(btn.dataset.tab);
    switch (btn.dataset.act) {
      case "start":
        if (state === "ready" || state === "over") start();
        break;
      case "pause":
        pause();
        break;
      case "resume":
        resume();
        break;
      case "login":
        openAuth("login", "Войди, чтобы сохранять рекорды");
        break;
      case "retry":
        loadBoard();
        break;
    }
  });
  // Стрелки по вкладкам рекордов
  on(root, "keydown", (e) => {
    const tab = e.target.closest?.("[data-tab]");
    if (!tab || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    setTab(boardTab === "all" ? "week" : "all", true);
  });

  const offUser = onUserChange(() => {
    if (statusKind === "idle" || statusKind === "guest") {
      if (statusKind === "guest" && getUser()) {
        setStatus("<span>Готово! Следующий забег попадёт в таблицу рекордов.</span>", "idle", "ok");
      } else idleStatus();
    }
    renderBoard();
  });

  const ro = new ResizeObserver(() => fit());
  ro.observe(ref("frame"));
  on(window, "resize", fit);

  // Игра уехала за экран — не рисуем, а забег ставим на паузу
  const io = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (!onScreen) pause();
    else dirty = true;
  }, { threshold: 0.25 });
  io.observe(stage);

  /* ---------- Старт ---------- */
  hud.best.textContent = pad(best);
  resetWorld();
  fit();
  idleStatus();
  loadBoard();
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      ac.abort();
      ro.disconnect();
      io.disconnect();
      offUser();
      container.innerHTML = "";
    },
  };
}
