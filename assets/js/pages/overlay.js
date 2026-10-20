// Оверлеи для OBS (Источник «Браузер»): overlay.html?w=all|task|top|work|wheel|qr&key=<ключ из пульта>.
// Фон прозрачный, данные обновляются каждые 3 с. Колесо появляется, только когда в пульте нажали «Крутить».
import { api } from "../data/api.js";
import { GAMES, byId } from "../data/constants.js";
import { spinWheel } from "../core/wheel.js";

const params = new URLSearchParams(location.search);
const W = ["all", "task", "top", "work", "wheel", "qr"].includes(params.get("w")) ? params.get("w") : "all";
const KEY = params.get("key") || "";
const root = document.getElementById("ov");
root.dataset.w = W;
const show = (w) => W === "all" || W === w;
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

root.innerHTML = `
  ${show("task") ? '<section class="ov-task" id="task" hidden></section>' : ""}
  ${show("top") ? '<section class="ov-top" id="top" hidden></section>' : ""}
  ${show("work") ? '<section class="ov-work" id="work" hidden></section>' : ""}
  ${show("qr") ? '<section class="ov-qr" id="qr"><div class="ov-qr-code" id="qrCode"></div><b>ndze.fun</b><small>задания · оценка работ · движ</small></section>' : ""}
  ${show("wheel") ? '<section class="ov-wheel" id="wheelBox" hidden><canvas id="wheel" width="640" height="640"></canvas><div class="ov-win" id="win" hidden></div></section>' : ""}
  <p class="ov-error" id="err" hidden></p>`;
const $ = (id) => document.getElementById(id);

/* ---------- QR ---------- */
function drawQr() {
  const box = $("qrCode");
  if (!box) return;
  if (typeof window.qrcode !== "function") return setTimeout(drawQr, 300);
  const qr = window.qrcode(0, "M");
  qr.addData("https://ndze.fun");
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 1, scalable: true });
}
drawQr();

/* ---------- Блоки ---------- */
let lastTaskId = null;
function renderTask(t) {
  const el = $("task");
  if (!el) return;
  el.hidden = !t;
  if (!t) return;
  const g = byId(GAMES, t.game);
  el.innerHTML = `<span class="ov-label">Задание на стриме</span>
    <div class="ov-task-row"><span class="ov-game" style="--c:${esc(g?.color || "#5dd62c")}">${esc(g?.short || t.game)}</span>
    <div><b>${esc(t.title)}</b><small>от @${esc(t.authorNick)} · ▲ ${t.votes}</small></div></div>`;
  if (t.id !== lastTaskId && !reduced) {
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  }
  lastTaskId = t.id;
}

function renderTop(list) {
  const el = $("top");
  if (!el) return;
  el.hidden = !list.length;
  el.innerHTML = `<span class="ov-label">Топ заданий · ndze.fun</span><ol>${list.map((t, i) => {
    const g = byId(GAMES, t.game);
    return `<li><span class="ov-place">${i + 1}</span><span class="ov-game sm" style="--c:${esc(g?.color || "#5dd62c")}">${esc(g?.short || "")}</span><b>${esc(t.title)}</b><span class="ov-votes">▲ ${t.votes}</span></li>`;
  }).join("")}</ol>`;
}

function renderWork(w) {
  const el = $("work");
  if (!el) return;
  el.hidden = !w;
  if (!w) return;
  el.innerHTML = `<span class="ov-label">Последняя работа на оценку</span>
    ${w.imageUrl ? `<img src="${esc(w.imageUrl)}" alt="">` : ""}
    <b>${esc(w.title)}</b><small>@${esc(w.authorNick)}</small>`;
}

/* ---------- Колесо: крутим только новый спин ---------- */
let lastSpinId;
let spinning = false;
async function handleWheel(spin) {
  const box = $("wheelBox");
  if (!box || !spin) return;
  // при открытии оверлея старый спин (старше 30 с) не показываем, свежий — докручиваем
  if (lastSpinId === undefined) lastSpinId = Date.now() - Date.parse(spin.at) < 30_000 ? null : spin.id;
  if (spinning || spin.id === lastSpinId) return;
  lastSpinId = spin.id;
  spinning = true;
  box.hidden = false;
  box.classList.add("in");
  $("win").hidden = true;
  await spinWheel($("wheel"), spin, { reduced, duration: 7000 });
  const w = spin.candidates[spin.winnerIndex];
  $("win").innerHTML = `<span>Выпало!</span><b>${esc(w.title)}</b>`;
  $("win").hidden = false;
  setTimeout(() => {
    box.classList.remove("in");
    setTimeout(() => { box.hidden = true; spinning = false; }, 600);
  }, 9000);
}

/* ---------- Опрос сервера ---------- */
async function tick() {
  if (!KEY) {
    $("err").hidden = false;
    $("err").textContent = "Нет ключа оверлея — скопируй ссылку из «Пульта» на ndze.fun";
    return;
  }
  try {
    const d = await api.overlay(KEY);
    $("err").hidden = true;
    renderTask(d.currentTask);
    renderTop(d.topTasks || []);
    renderWork(d.lastWork);
    handleWheel(d.wheel);
  } catch (e) {
    $("err").hidden = false;
    $("err").textContent = e.message;
    if (e.code === "forbidden") return; // неверный ключ: не долбим сервер
  }
  setTimeout(tick, 3000);
}
tick();
