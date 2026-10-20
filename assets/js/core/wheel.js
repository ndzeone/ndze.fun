// Пиксельное колесо заданий на <canvas>. Используется в пульте (stream.html) и в оверлее OBS (overlay.html):
// оба получают один и тот же спин с сервера и докручивают колесо до одного и того же сектора.
import { GAMES, byId } from "../data/constants.js";

const COLORS = ["#5dd62c", "#202020", "#337418", "#2a2a2a", "#8b6cff", "#1f1f1f", "#ff3b4a", "#262626"];
const TAU = Math.PI * 2;
const ease = (t) => 1 - Math.pow(1 - t, 4);

/** Детерминированное число 0..1 из строки (id спина) — смещение внутри сектора одинаковое везде. */
function hash01(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** Границы секторов (радианы, от верха по часовой) пропорционально весу. */
function sectors(cands) {
  const total = cands.reduce((n, c) => n + (c.weight || 1), 0) || 1;
  let a = 0;
  return cands.map((c) => {
    const from = a;
    a += ((c.weight || 1) / total) * TAU;
    return { ...c, from, to: a };
  });
}

function shorten(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** Нарисовать колесо, повёрнутое на rot радиан. */
export function drawWheel(canvas, cands, rot = 0, { highlight = -1 } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = canvas.clientWidth || 360;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = c - 10;
  const secs = sectors(cands);

  // обод с «лампочками»
  ctx.fillStyle = "#0f0f0f";
  ctx.beginPath(); ctx.arc(c, c, r + 8, 0, TAU); ctx.fill();
  ctx.strokeStyle = "#5dd62c"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(c, c, r + 6, 0, TAU); ctx.stroke();

  secs.forEach((s, i) => {
    const a0 = s.from + rot - Math.PI / 2;
    const a1 = s.to + rot - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, r, a0, a1); ctx.closePath();
    ctx.fillStyle = i === highlight ? "#ffd166" : COLORS[i % COLORS.length];
    ctx.fill();
    ctx.strokeStyle = "#0f0f0f"; ctx.lineWidth = 2; ctx.stroke();
    // подпись вдоль радиуса
    const mid = (a0 + a1) / 2;
    const arc = (s.to - s.from) * r;
    if (arc < 14) return;
    ctx.save();
    ctx.translate(c, c);
    // на левой половине колеса поворачиваем подпись на 180°, чтобы она не читалась вверх ногами
    const flip = Math.cos(mid) < 0;
    ctx.rotate(flip ? mid + Math.PI : mid);
    const dark = i === highlight || ["#5dd62c", "#ffd166"].includes(COLORS[i % COLORS.length]);
    ctx.fillStyle = dark ? "#0f0f0f" : "#f8f8f8";
    ctx.font = `600 ${Math.max(10, Math.min(15, size / 28))}px "Pixelify Sans", "Tiny5 Cyr", monospace`;
    ctx.textAlign = flip ? "left" : "right"; ctx.textBaseline = "middle";
    const game = byId(GAMES, s.game)?.short || "";
    ctx.fillText(shorten(ctx, `${s.title}${game ? " · " + game : ""}`, r * 0.72), flip ? -(r - 12) : r - 12, 0);
    ctx.restore();
  });

  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + rot;
    ctx.fillStyle = i % 2 ? "#5dd62c" : "#f8f8f8";
    ctx.fillRect(c + Math.cos(a) * (r + 6) - 2, c + Math.sin(a) * (r + 6) - 2, 4, 4);
  }
  // центр-паутинка
  ctx.fillStyle = "#0f0f0f"; ctx.beginPath(); ctx.arc(c, c, r * 0.16, 0, TAU); ctx.fill();
  ctx.strokeStyle = "#5dd62c"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#ff3b4a"; ctx.font = `700 ${Math.round(r * 0.16)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("🕷", c, c + 1);
  // указатель сверху
  ctx.fillStyle = "#ff3b4a";
  ctx.beginPath(); ctx.moveTo(c - 13, 2); ctx.lineTo(c + 13, 2); ctx.lineTo(c, 28); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#0f0f0f"; ctx.lineWidth = 2; ctx.stroke();
}

/** Угол поворота, при котором под указателем окажется сектор winnerIndex (+ полные обороты). */
export function targetRotation(cands, winnerIndex, spinId, turns = 6) {
  const s = sectors(cands)[winnerIndex];
  if (!s) return 0;
  const inside = s.from + (s.to - s.from) * (0.2 + 0.6 * hash01(spinId));
  return turns * TAU - inside;
}

/** Прокрутить колесо до победителя. Возвращает Promise, который выполняется по остановке. */
export function spinWheel(canvas, spin, { duration = 6000, reduced = false } = {}) {
  const end = targetRotation(spin.candidates, spin.winnerIndex, spin.id);
  if (reduced) {
    drawWheel(canvas, spin.candidates, end, { highlight: spin.winnerIndex });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      drawWheel(canvas, spin.candidates, end * ease(p), { highlight: p >= 1 ? spin.winnerIndex : -1 });
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
