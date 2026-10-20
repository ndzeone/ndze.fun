// «Общий холст» как r/place: 64×64 клетки, 16 цветов, один пиксель раз в N секунд
// (кулдаун считает сервер; у админа его нет). Монтируется в любой контейнер:
//
//   import { mountPlace } from "../core/place.js";
//   const place = mountPlace($("#placeTab"));   // стили — assets/css/place.css (префикс pl-)
//   …
//   place.destroy();                             // стоп опросу, таймерам и слушателям
//
// Отрисовка: холст хранится в Uint8Array (индекс цвета на клетку) → ImageData 64×64 →
// растягивается на <canvas> с целым числом физических пикселей на клетку (без размытия).
import { api } from "../data/api.js";
import { getUser, onUserChange, openAuth } from "./layout.js";
import { $, $$, esc, toast, motion, plural, clamp } from "./util.js";

const COLOR_KEY = "ndze:place:color";
const POLL_MS = 4000;          // опрос новых пикселей
const MAX_CSS = 640;           // максимальный размер холста на странице, CSS px
const MAX_ZOOM = 8;
const ZOOM_STEPS = [1, 2, 4, 8];
const BG = 1;                  // индекс цвета пустой клетки (графит) — фон таймлапса
const LOG_PAGE = 5000;
const AUTH_REASON = "Войди, чтобы ставить пиксели на холст";

const COLOR_NAMES = {
  "#0f0f0f": "чёрный", "#202020": "графитовый (фон)", "#5a5a5a": "тёмно-серый", "#a0a0a0": "светло-серый",
  "#f8f8f8": "белый", "#5dd62c": "лаймовый", "#337418": "лесной зелёный", "#2fd673": "мятный",
  "#4aa8ff": "голубой", "#1d3f9e": "синий", "#8b6cff": "фиолетовый", "#e05cff": "пурпурный",
  "#ff3b4a": "красный", "#ff8a3d": "оранжевый", "#ffd166": "жёлтый", "#7a4a2b": "коричневый",
};

let mounts = 0;

/* ---------- Мелочи ---------- */
const colorName = (hex) => COLOR_NAMES[String(hex).toLowerCase()] || String(hex);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** «5 минут», «1 минуту», «30 секунд» — для правил. */
function durText(sec) {
  if (sec >= 60 && sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? "минуту" : `${m} ${plural(m, ["минуту", "минуты", "минут"])}`;
  }
  return `${sec} ${plural(sec, ["секунду", "секунды", "секунд"])}`;
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function loadColor() {
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    const v = raw === null || raw === "" ? NaN : Number(raw);
    return Number.isInteger(v) && v >= 0 && v < 16 ? v : 5; // по умолчанию — лайм
  } catch {
    return 5;
  }
}
function saveColor(c) {
  try { localStorage.setItem(COLOR_KEY, String(c)); } catch { /* приватный режим — не страшно */ }
}

/* ---------- Разметка ---------- */
function shellHTML(uid) {
  return `<div class="pl-in">
  <div class="pl-stage glass">
    <div class="pl-toolbar">
      <span class="pl-live" data-state="loading"><span class="pl-live-dot" aria-hidden="true"></span><span class="pl-live-text">подключаюсь…</span></span>
      <span class="pl-coords" aria-hidden="true">—</span>
      <div class="pl-zoom" role="group" aria-label="Масштаб холста">
        <button class="pl-zbtn" type="button" data-act="zoom-out" aria-label="Отдалить">−</button>
        <button class="pl-zbtn pl-zlevel" type="button" data-act="zoom-reset" aria-label="Сбросить масштаб">×1</button>
        <button class="pl-zbtn" type="button" data-act="zoom-in" aria-label="Приблизить">+</button>
      </div>
    </div>
    <div class="pl-frame">
      <div class="pl-board">
        <canvas class="pl-canvas" role="img" tabindex="0" width="64" height="64" aria-label="Общий пиксельный холст" aria-describedby="${uid}-hint"></canvas>
        <span class="pl-tl-badge" hidden><span aria-hidden="true">▶</span> Таймлапс <b class="pl-tl-pct">0%</b></span>
        <div class="pl-overlay"><span class="spinner light" aria-hidden="true"></span><span class="sr-only">Загружаю холст…</span></div>
      </div>
    </div>
    <p class="pl-hint" id="${uid}-hint">
      <span class="pl-hint-fine">Клик — выбрать клетку, ещё клик — поставить пиксель. С клавиатуры: стрелки двигают выбор, Enter ставит, +/− — масштаб, Ctrl + колесо — зум.</span>
      <span class="pl-hint-touch">Тап — выбрать клетку, ещё тап — поставить. Приблизь щипком или кнопкой «+», чтобы попадать точнее; при зуме холст двигается пальцем.</span>
    </p>
  </div>

  <div class="pl-side">
    <div class="pl-card glass pl-brush">
      <p class="pl-eyebrow"><span class="pl-px" aria-hidden="true"></span>Общий холст <span class="pl-size">64×64</span></p>
      <div class="pl-palette" role="group" aria-label="Палитра"></div>
      <div class="pl-pick">
        <span class="pl-pick-sw" aria-hidden="true"><span class="pl-sw-from"></span><span class="pl-pick-arrow">→</span><span class="pl-sw-to"></span></span>
        <span class="pl-pick-text">Выбери клетку на холсте</span>
      </div>
      <button class="btn btn-primary pl-place" type="button" data-act="place" disabled><span>Поставить пиксель</span><span class="spinner" aria-hidden="true"></span></button>
      <div class="pl-cool">
        <div class="pl-cool-guest" hidden>
          <p>Войди, чтобы рисовать</p>
          <button class="btn btn-ghost btn-sm" type="button" data-act="login">Войти</button>
        </div>
        <div class="pl-cool-user">
          <p class="pl-cool-text">—</p>
          <div class="pl-progress" role="progressbar" aria-label="Перезарядка пикселя" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span class="pl-progress-fill"></span></div>
        </div>
      </div>
    </div>

    <div class="pl-card glass pl-info">
      <dl class="pl-stats">
        <div><dt>Версия</dt><dd class="pl-ver">—</dd></div>
        <div><dt>Вживую</dt><dd class="pl-session">0</dd></div>
      </dl>
      <p class="pl-rules">1 пиксель раз в 5 минут, рисуйте вместе.</p>
      <p class="pl-demo" hidden>Демо-режим: холст только для просмотра.</p>
      <button class="btn btn-ghost btn-sm pl-tl-btn" type="button" data-act="timelapse"><span class="pl-tl-label">▶ Таймлапс</span><span class="spinner light" aria-hidden="true"></span></button>
    </div>
  </div>
  </div>
  <p class="sr-only pl-sr" aria-live="polite"></p>`;
}

/**
 * Монтирует холст в container. Возвращает { destroy() }.
 * @param {HTMLElement} container
 */
export function mountPlace(container) {
  const uid = `pl${++mounts}`;
  const root = document.createElement("div");
  root.className = "pl";
  root.innerHTML = shellHTML(uid);
  container.append(root);

  const canvas = $(".pl-canvas", root);
  const ctx = canvas.getContext("2d");
  const frame = $(".pl-frame", root);
  const off = document.createElement("canvas"); // холст 1 клетка = 1 пиксель
  const offCtx = off.getContext("2d");
  const ui = {
    live: $(".pl-live", root), liveText: $(".pl-live-text", root), coords: $(".pl-coords", root),
    zlevel: $(".pl-zlevel", root), zin: $('[data-act="zoom-in"]', root), zout: $('[data-act="zoom-out"]', root),
    overlay: $(".pl-overlay", root), tlBadge: $(".pl-tl-badge", root), tlPct: $(".pl-tl-pct", root),
    palette: $(".pl-palette", root), from: $(".pl-sw-from", root), to: $(".pl-sw-to", root), pickText: $(".pl-pick-text", root),
    place: $(".pl-place", root), guest: $(".pl-cool-guest", root), user: $(".pl-cool-user", root),
    coolText: $(".pl-cool-text", root), progress: $(".pl-progress", root), fill: $(".pl-progress-fill", root),
    ver: $(".pl-ver", root), session: $(".pl-session", root), rules: $(".pl-rules", root), demo: $(".pl-demo", root),
    tlBtn: $(".pl-tl-btn", root), tlLabel: $(".pl-tl-label", root), sr: $(".pl-sr", root), size: $(".pl-size", root),
  };

  /* ---------- Состояние ---------- */
  let W = 64, H = 64;
  let palette = [];            // ["#hex"]
  let rgb = [];                // [[r,g,b]]
  let grid = null;             // Uint8Array W·H — живой холст
  let img = null;              // ImageData живого холста
  let version = 0, epoch = 0, cooldown = 300;
  let readyAt = 0;             // Date.now(), когда можно ставить (0 — уже можно)
  let color = loadColor();
  let sel = null, hover = null; // { x, y }
  let busy = false;
  let loaded = false;
  let sessionChanges = 0;
  let dead = false;
  let loadSeq = 0;
  let pollTimer = 0, tickTimer = 0, raf = 0, pollBusy = false;
  let tl = null;               // таймлапс: { grid, img, items, i, t0, dur, endAt }
  let tlLoading = false;
  let flashes = [];            // вспышки над свежими пикселями
  let lastSec = -1;

  // Вид: базовый размер клетки в физических пикселях, зум и сдвиг (физ. px, целые)
  let dpr = 1, dev = 64, base = 1, zoom = 1, ox = 0, oy = 0;
  const cellPx = () => Math.max(1, Math.round(base * zoom));

  ui.demo.hidden = api.mode !== "local";

  /* ---------- Палитра ---------- */
  function renderPalette() {
    ui.palette.innerHTML = palette.map((hex, i) =>
      `<button class="pl-swatch" type="button" data-c="${i}" style="--c:${esc(hex)}" aria-label="Цвет: ${esc(colorName(hex))}" title="${esc(colorName(hex))}" aria-pressed="${i === color}"></button>`).join("");
  }

  function setColor(c) {
    color = c;
    saveColor(c);
    $$(".pl-swatch", ui.palette).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.c) === c)));
    updatePick();
    requestDraw();
  }

  /* ---------- Пиксели ---------- */
  function paint(target, i, c) {
    const [r, g, b] = rgb[c] || [0, 0, 0];
    const d = target.data, o = i * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }

  /** Ставит цвет в живой холст. Возвращает true, если клетка изменилась. */
  function setPixel(x, y, c, flash = "") {
    if (x < 0 || y < 0 || x >= W || y >= H || c < 0 || c >= palette.length) return false;
    const i = y * W + x;
    if (grid[i] === c) return false;
    grid[i] = c;
    paint(img, i, c);
    if (flash && motion && !tl) addFlash(x, y, flash);
    requestDraw();
    return true;
  }

  function addFlash(x, y, tone) {
    flashes.push({ x, y, tone, t0: performance.now() });
    if (flashes.length > 60) flashes.shift();
  }

  function makeImage(g) {
    const im = new ImageData(W, H);
    for (let i = 0; i < g.length; i++) paint(im, i, g[i]);
    return im;
  }

  /* ---------- Загрузка и опрос ---------- */
  async function load() {
    const seq = ++loadSeq;
    try {
      const r = await api.canvas();
      if (dead || seq !== loadSeq) return;
      const sizeChanged = r.w !== W || r.h !== H;
      W = r.w; H = r.h;
      const palChanged = palette.join() !== r.palette.join();
      palette = r.palette;
      rgb = palette.map(hexToRgb);
      if (color >= palette.length) color = 0;
      grid = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) grid[i] = parseInt(r.data[i], 16) || 0;
      img = makeImage(grid);
      off.width = W; off.height = H;
      version = r.version; epoch = r.epoch; cooldown = r.cooldown;
      setWait(r.wait ?? 0);
      if (palChanged) renderPalette();
      if (sizeChanged) { sel = hover = null; resize(); }
      if (sel && (sel.x >= W || sel.y >= H)) sel = null;
      loaded = true;
      ui.overlay.hidden = true;
      ui.size.textContent = `${W}×${H}`;
      ui.rules.textContent = cooldown > 0
        ? `1 пиксель раз в ${durText(cooldown)}, рисуйте вместе.`
        : "Ставь пиксели без ожидания, рисуйте вместе.";
      setLive("ok");
      updateInfo();
      updatePick();
      updateCool();
      requestDraw();
      schedulePoll();
    } catch (err) {
      if (dead || seq !== loadSeq) return;
      if (!loaded) {
        ui.overlay.hidden = false;
        ui.overlay.innerHTML = `<div class="pl-error"><p>Не удалось загрузить холст: ${esc(err.message)}</p>
          <button class="btn btn-ghost btn-sm" type="button" data-act="retry">Попробовать ещё раз</button></div>`;
      } else {
        setLive("error");
        schedulePoll();
      }
    }
  }

  const visible = () => !document.hidden && root.isConnected && root.getClientRects().length > 0;

  function schedulePoll(ms = POLL_MS) {
    clearTimeout(pollTimer);
    if (!dead) pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (dead || !loaded) return;
    if (!visible()) {
      setLive("paused");
      return schedulePoll();
    }
    if (pollBusy) return schedulePoll();
    pollBusy = true;
    const seq = loadSeq;
    try {
      const r = await api.canvasChanges(version, epoch);
      if (dead || seq !== loadSeq) return;
      if (r.reset) {
        if (tl) stopTimelapse();
        toast("Холст обновили — загружаю заново");
        await load();
        return;
      }
      let n = 0;
      for (const [x, y, c] of r.changes || []) if (setPixel(x, y, c, "live")) n++;
      if (typeof r.version === "number" && r.version > version) version = r.version;
      sessionChanges += n;
      setLive("ok");
      updateInfo();
      if (n && sel) updatePick();
    } catch {
      if (!dead) setLive("error");
    } finally {
      pollBusy = false;
      if (!dead) schedulePoll();
    }
  }

  function setLive(state) {
    ui.live.dataset.state = state;
    ui.liveText.textContent = state === "ok" ? "обновляется вживую" : state === "paused" ? "на паузе" : state === "error" ? "нет связи, пробую снова" : "подключаюсь…";
  }

  function updateInfo() {
    ui.ver.textContent = `#${version}`;
    ui.session.textContent = `+${sessionChanges}`;
    ui.session.title = `${sessionChanges} ${plural(sessionChanges, ["правка", "правки", "правок"])} с момента открытия`;
  }

  const onVisibility = () => {
    if (dead) return;
    if (document.hidden) setLive("paused");
    else if (loaded) schedulePoll(0);
  };
  document.addEventListener("visibilitychange", onVisibility);

  /* ---------- Кулдаун ---------- */
  function setWait(sec) {
    readyAt = sec > 0 ? Date.now() + sec * 1000 : 0;
    lastSec = -1;
    updateCool();
  }
  const remaining = () => (readyAt ? Math.max(0, Math.ceil((readyAt - Date.now()) / 1000)) : 0);

  function updateCool() {
    const user = getUser();
    ui.guest.hidden = !!user;
    ui.user.hidden = !user;
    if (!user) { updatePlaceBtn(); return; }
    const left = remaining();
    if (left === lastSec) return;
    const wasWaiting = lastSec > 0;
    lastSec = left;
    if (left > 0) {
      ui.coolText.innerHTML = `Следующий пиксель через <b>${mmss(left)}</b>`;
      ui.coolText.classList.remove("is-ready");
    } else {
      ui.coolText.innerHTML = user.role === "admin" && cooldown > 0 ? "Можно ставить! <small>без кулдауна</small>" : "Можно ставить!";
      ui.coolText.classList.add("is-ready");
      if (wasWaiting) {
        ui.sr.textContent = "Можно ставить следующий пиксель";
        if (motion) { ui.coolText.classList.remove("pop"); void ui.coolText.offsetWidth; ui.coolText.classList.add("pop"); }
      }
    }
    const pct = left > 0 && cooldown > 0 ? Math.round(100 * (1 - left / cooldown)) : 100;
    ui.fill.style.width = `${clamp(pct, 0, 100)}%`;
    ui.progress.setAttribute("aria-valuenow", String(pct));
    ui.progress.classList.toggle("is-full", left === 0);
    updatePlaceBtn();
  }
  tickTimer = setInterval(updateCool, 250);

  function updatePlaceBtn() {
    const user = getUser();
    ui.place.disabled = !loaded || !sel || busy || !!tl || (!!user && remaining() > 0);
    ui.place.classList.toggle("is-loading", busy);
  }

  /* ---------- Выбор клетки ---------- */
  function select(x, y, { announce = false } = {}) {
    sel = { x: clamp(x, 0, W - 1), y: clamp(y, 0, H - 1) };
    ensureVisible(sel.x, sel.y);
    updatePick();
    requestDraw();
    if (announce) ui.sr.textContent = `Клетка ${sel.x}, ${sel.y}: ${colorName(palette[grid[sel.y * W + sel.x]])}`;
  }

  function updatePick() {
    ui.to.style.setProperty("--c", palette[color] || "transparent");
    if (sel && grid) {
      const cur = palette[grid[sel.y * W + sel.x]];
      ui.from.style.setProperty("--c", cur);
      ui.pickText.innerHTML = `Клетка <b>${sel.x}, ${sel.y}</b>`;
      root.classList.add("has-sel");
      canvas.setAttribute("aria-label", `Общий пиксельный холст ${W} на ${H}. Выбрана клетка ${sel.x}, ${sel.y}, сейчас ${colorName(cur)}. Enter — поставить ${colorName(palette[color])}.`);
    } else {
      ui.pickText.textContent = "Выбери клетку на холсте";
      root.classList.remove("has-sel");
      canvas.setAttribute("aria-label", `Общий пиксельный холст ${W} на ${H}. Выбери клетку стрелками.`);
    }
    updateCoords();
    updatePlaceBtn();
  }

  function updateCoords() {
    const p = hover || sel;
    ui.coords.textContent = p ? `${p.x}, ${p.y}` : "—";
  }

  /* ---------- Постановка ---------- */
  async function place() {
    if (!loaded || !sel || busy || tl) return;
    if (!getUser()) return openAuth("login", AUTH_REASON);
    const left = remaining();
    if (left > 0) return toast(`Следующий пиксель через ${mmss(left)}`, "error");
    const { x, y } = sel;
    const i = y * W + x;
    const c = color;
    const prev = grid[i];
    if (prev === c) return toast("Эта клетка уже такого цвета — выбери другой");
    busy = true;
    setPixel(x, y, c, "mine"); // оптимистично
    updatePick();
    try {
      const r = await api.placePixel(x, y, c);
      if (dead) return;
      setWait(r.wait || 0);
      ui.sr.textContent = `Пиксель поставлен: ${x}, ${y}`;
      toast(`Пиксель на ${x}, ${y} — готово!`);
    } catch (err) {
      if (dead) return;
      if (grid[i] === c) { grid[i] = prev; paint(img, i, prev); requestDraw(); } // откат
      if (err.code === "rate_limited" && err.fields?.wait) setWait(Number(err.fields.wait) || 0);
      if (err.code === "auth_required") openAuth("login", AUTH_REASON);
      toast(err.message, "error", 5000);
    } finally {
      if (!dead) {
        busy = false;
        updatePick();
      }
    }
  }

  /* ---------- Таймлапс ---------- */
  async function startTimelapse() {
    if (tl) return stopTimelapse();
    if (tlLoading || !loaded) return;
    tlLoading = true;
    ui.tlBtn.classList.add("is-loading");
    ui.tlBtn.disabled = true;
    const items = [];
    try {
      let after = 0;
      for (let page = 0; page < 50; page++) {
        const r = await api.canvasLog(after, LOG_PAGE);
        if (dead) return;
        for (const it of r.items) items.push(it);
        if (!r.more || !r.items.length) break;
        after = r.items[r.items.length - 1][0];
      }
    } catch (err) {
      if (!dead) toast(err.message, "error");
      return;
    } finally {
      tlLoading = false;
      if (!dead) {
        ui.tlBtn.classList.remove("is-loading");
        ui.tlBtn.disabled = false;
      }
    }
    if (!items.length) return toast("История пока пустая — поставь первый пиксель!");
    const g = new Uint8Array(W * H).fill(BG);
    // ~10 с на любую историю; совсем короткую не растягиваем
    const dur = items.length >= 100 ? 10000 : Math.max(3500, items.length * 100);
    tl = { grid: g, img: makeImage(g), items, i: 0, t0: performance.now(), dur, endAt: 0 };
    hover = null;
    root.classList.add("is-tl");
    ui.tlBadge.hidden = false;
    ui.tlPct.textContent = "0%";
    ui.tlLabel.textContent = "■ Стоп";
    ui.sr.textContent = `Таймлапс: ${items.length} ${plural(items.length, ["пиксель", "пикселя", "пикселей"])}`;
    updatePlaceBtn();
    requestDraw();
  }

  function stepTimelapse(now) {
    const t = tl;
    if (t.endAt) {
      if (now >= t.endAt) stopTimelapse();
      return;
    }
    const p = Math.min(1, (now - t.t0) / t.dur);
    const target = Math.min(t.items.length, Math.ceil(t.items.length * p));
    for (; t.i < target; t.i++) {
      const [, x, y, c] = t.items[t.i];
      if (x < 0 || y < 0 || x >= W || y >= H || c >= palette.length) continue;
      const i = y * W + x;
      t.grid[i] = c;
      paint(t.img, i, c);
    }
    ui.tlPct.textContent = `${Math.round(p * 100)}%`;
    if (p >= 1) t.endAt = now + 1200; // пауза на готовой картинке, потом — к живому холсту
  }

  function stopTimelapse() {
    if (!tl) return;
    tl = null;
    root.classList.remove("is-tl");
    ui.tlBadge.hidden = true;
    ui.tlLabel.textContent = "▶ Таймлапс";
    updatePlaceBtn();
    requestDraw();
  }

  /* ---------- Размер и масштаб ---------- */
  function resize() {
    const avail = Math.min(frame.clientWidth, MAX_CSS);
    if (!avail) return;
    const oldCell = cellPx();
    dpr = window.devicePixelRatio || 1;
    // целое число физических пикселей на клетку → чёткие края
    const nextDev = Math.max(W, Math.floor((avail * dpr) / W) * W);
    if (nextDev !== dev || canvas.width !== nextDev) {
      const cx = (ox + dev / 2) / oldCell, cy = (oy + dev / 2) / oldCell; // центр вида в клетках
      dev = nextDev;
      base = dev / W;
      canvas.width = canvas.height = dev;
      ox = cx * cellPx() - dev / 2;
      oy = cy * cellPx() - dev / 2;
      clampPan();
    }
    canvas.style.width = canvas.style.height = `${dev / dpr}px`;
    requestDraw();
  }

  function clampPan() {
    const max = cellPx() * W - dev;
    ox = Math.round(clamp(ox, 0, Math.max(0, max)));
    oy = Math.round(clamp(oy, 0, Math.max(0, cellPx() * H - dev)));
  }

  /** Зум вокруг точки (px, py) в физ. пикселях холста. */
  function zoomAt(next, px = dev / 2, py = dev / 2) {
    const z = clamp(next, 1, MAX_ZOOM);
    const c0 = cellPx();
    const wx = (px + ox) / c0, wy = (py + oy) / c0;
    zoom = z;
    const c1 = cellPx();
    ox = wx * c1 - px;
    oy = wy * c1 - py;
    clampPan();
    updateZoomUI();
    requestDraw();
  }

  function zoomStep(dir) {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.01) ?? MAX_ZOOM : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.01) ?? 1;
    if (sel && next > 1) {
      // приближаем к выбранной клетке
      const c = cellPx();
      zoomAt(next, (sel.x + 0.5) * c - ox, (sel.y + 0.5) * c - oy);
    } else zoomAt(next);
  }

  function updateZoomUI() {
    const z = Math.round(zoom * 10) / 10;
    ui.zlevel.textContent = `×${z}`;
    ui.zin.disabled = zoom >= MAX_ZOOM - 0.01;
    ui.zout.disabled = ui.zlevel.disabled = zoom <= 1.01;
    canvas.classList.toggle("is-zoomed", zoom > 1.01);
  }

  function ensureVisible(x, y) {
    if (zoom <= 1.01) return;
    const c = cellPx();
    const sx = x * c - ox, sy = y * c - oy;
    const pad = c * 2;
    if (sx < 0 || sx + c > dev) ox = sx < 0 ? x * c - pad : x * c + c + pad - dev;
    if (sy < 0 || sy + c > dev) oy = sy < 0 ? y * c - pad : y * c + c + pad - dev;
    clampPan();
  }

  /* ---------- Рисование ---------- */
  function requestDraw() {
    if (!raf && !dead) raf = requestAnimationFrame(frameTick);
  }

  function frameTick(now) {
    raf = 0;
    if (dead) return;
    if (tl) stepTimelapse(now);
    draw(now);
    if (tl || flashes.length) requestDraw();
  }

  /** Рамка толщиной t снаружи прямоугольника (x, y, w, h). */
  function frameOut(x, y, w, h, t, fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x - t, y - t, w + 2 * t, t);
    ctx.fillRect(x - t, y + h, w + 2 * t, t);
    ctx.fillRect(x - t, y, t, h);
    ctx.fillRect(x + w, y, t, h);
  }

  function draw(now = performance.now()) {
    const src = tl ? tl.img : img;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0f0f0f";
    ctx.fillRect(0, 0, dev, dev);
    if (!src) return;
    offCtx.putImageData(src, 0, 0);
    const c = cellPx();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, -ox, -oy, c * W, c * H);

    // сетка — когда клетки крупные
    if (c / dpr >= 12) {
      ctx.fillStyle = "rgba(248, 248, 248, .07)";
      const lw = Math.max(1, Math.floor(dpr));
      for (let x = Math.floor(ox / c); x <= Math.ceil((ox + dev) / c); x++) ctx.fillRect(x * c - ox, 0, lw, dev);
      for (let y = Math.floor(oy / c); y <= Math.ceil((oy + dev) / c); y++) ctx.fillRect(0, y * c - oy, dev, lw);
    }

    const thin = Math.max(1, Math.round(dpr));
    const thick = Math.max(2, Math.round(2 * dpr));

    if (!tl) {
      if (sel) {
        const sx = sel.x * c - ox, sy = sel.y * c - oy;
        // перекрестие по строке и столбцу
        ctx.fillStyle = "rgba(93, 214, 44, .12)";
        ctx.fillRect(sx, 0, c, sy);
        ctx.fillRect(sx, sy + c, c, dev - sy - c);
        ctx.fillRect(0, sy, sx, c);
        ctx.fillRect(sx + c, sy, dev - sx - c, c);
        // предпросмотр выбранного цвета
        ctx.fillStyle = palette[color];
        ctx.globalAlpha = busy ? 1 : 0.92;
        ctx.fillRect(sx, sy, c, c);
        ctx.globalAlpha = 1;
        frameOut(sx, sy, c, c, thick, "#5dd62c");
        frameOut(sx - thick, sy - thick, c + 2 * thick, c + 2 * thick, thin, "rgba(15, 15, 15, .9)");
      }
      if (hover && !(sel && sel.x === hover.x && sel.y === hover.y)) {
        frameOut(hover.x * c - ox, hover.y * c - oy, c, c, thin, "rgba(248, 248, 248, .85)");
        frameOut(hover.x * c - ox - thin, hover.y * c - oy - thin, c + 2 * thin, c + 2 * thin, thin, "rgba(15, 15, 15, .55)");
      }
    }

    // вспышки над свежими пикселями
    if (flashes.length) {
      flashes = flashes.filter((f) => now - f.t0 < 700);
      for (const f of flashes) {
        const t = (now - f.t0) / 700;
        const grow = Math.round(t * Math.max(c, 6 * dpr));
        ctx.globalAlpha = 1 - t;
        frameOut(f.x * c - ox - grow, f.y * c - oy - grow, c + 2 * grow, c + 2 * grow, f.tone === "mine" ? thick : thin,
          f.tone === "mine" ? "#5dd62c" : "#f8f8f8");
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- Указатель: выбор, панорама, щипок ---------- */
  const pointers = new Map(); // pointerId → { x, y } (client)
  let drag = null;            // { id, sx, sy, ox0, oy0, moved }
  let pinch = null;           // { d0, z0 }

  function toDev(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const k = dev / (r.width || 1);
    return [(clientX - r.left) * k, (clientY - r.top) * k];
  }
  function cellAt(clientX, clientY) {
    const [px, py] = toDev(clientX, clientY);
    const c = cellPx();
    const x = Math.floor((px + ox) / c), y = Math.floor((py + oy) / c);
    return x >= 0 && y >= 0 && x < W && y < H && px >= 0 && py >= 0 && px < dev && py < dev ? { x, y } : null;
  }

  function onPointerDown(e) {
    if (!loaded || (e.pointerType === "mouse" && e.button !== 0)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* уже отпущен */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox0: ox, oy0: oy, moved: false };
    }
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const [px, py] = toDev((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAt(pinch.z0 * (d / pinch.d0), px, py);
      return;
    }
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved && zoom > 1.01) {
        const k = dev / (canvas.getBoundingClientRect().width || 1);
        ox = drag.ox0 - dx * k;
        oy = drag.oy0 - dy * k;
        clampPan();
        canvas.classList.add("is-panning");
        requestDraw();
      }
    }
    if (e.pointerType === "mouse" && !tl) {
      const h = cellAt(e.clientX, e.clientY);
      if (h?.x !== hover?.x || h?.y !== hover?.y) {
        hover = h;
        updateCoords();
        requestDraw();
      }
    }
  }

  function onPointerUp(e) {
    const wasPinch = !!pinch;
    const d = drag && drag.id === e.pointerId ? drag : null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (wasPinch) { drag = null; canvas.classList.remove("is-panning"); return; }
    drag = null;
    canvas.classList.remove("is-panning");
    if (!d || d.moved || tl) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    canvas.focus({ preventScroll: true });
    if (sel && sel.x === cell.x && sel.y === cell.y) place();
    else select(cell.x, cell.y);
  }

  function onPointerCancel(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    canvas.classList.remove("is-panning");
  }

  function onPointerLeave(e) {
    if (e.pointerType !== "mouse" || !hover) return;
    hover = null;
    updateCoords();
    requestDraw();
  }

  // Колесо: зумим только с Ctrl (и щипком тачпада) или когда уже приближено — иначе не мешаем прокрутке страницы
  function onWheel(e) {
    if (!loaded || (!e.ctrlKey && zoom <= 1.01)) return;
    e.preventDefault();
    const [px, py] = toDev(e.clientX, e.clientY);
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(zoom * Math.exp(-dy * 0.0025), px, py);
  }

  function onKey(e) {
    if (!loaded || e.altKey || e.metaKey || (e.ctrlKey && !["+", "=", "-"].includes(e.key))) return;
    const step = e.shiftKey ? 8 : 1;
    const start = sel || hover || { x: W >> 1, y: H >> 1 };
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      if (tl) return;
      const [dx, dy] = sel ? moves[e.key] : [0, 0];
      select(start.x + dx, start.y + dy, { announce: true });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!sel) select(start.x, start.y, { announce: true });
      else place();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomStep(1);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomStep(-1);
    } else if (e.key === "Escape" && sel) {
      sel = null;
      updatePick();
      requestDraw();
    } else if (e.key === "Escape" && tl) stopTimelapse();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("contextmenu", (e) => { if (zoom > 1.01) e.preventDefault(); });

  /* ---------- Кнопки ---------- */
  root.addEventListener("click", (e) => {
    const sw = e.target.closest(".pl-swatch");
    if (sw) return setColor(Number(sw.dataset.c));
    const act = e.target.closest("[data-act]");
    if (!act || act.disabled) return;
    switch (act.dataset.act) {
      case "place": return place();
      case "login": return openAuth("login", AUTH_REASON);
      case "zoom-in": return zoomStep(1);
      case "zoom-out": return zoomStep(-1);
      case "zoom-reset": return zoomAt(1);
      case "timelapse": return startTimelapse();
      case "retry":
        ui.overlay.innerHTML = `<span class="spinner light" aria-hidden="true"></span>`;
        return load();
    }
  });

  /* ---------- Вход/выход и размеры ---------- */
  const offUser = onUserChange(() => {
    if (dead) return;
    readyAt = 0;
    lastSec = -1;
    updateCool();
    load(); // новый wait для этого пользователя
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(frame);
  resize();
  updateZoomUI();
  updateCool();
  load();

  return {
    destroy() {
      if (dead) return;
      dead = true;
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      offUser();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("wheel", onWheel);
      tl = null;
      root.remove();
    },
  };
}
