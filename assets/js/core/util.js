// Мелкие общие помощники. Без зависимостей.

export const $ = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Экранирует строку для вставки в HTML (текст и атрибуты). */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
export const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
export const fancyCursor = motion && finePointer;

/** Русское склонение: plural(5, ["работа", "работы", "работ"]) → "работ". */
export function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
/** «5 минут назад», «вчера», «3 мес. назад». */
export function timeAgo(date) {
  const sec = (new Date(date).getTime() - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, s] of units) if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  return "только что";
}

export const formatDate = (date) =>
  new Date(date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

export function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/** Всплывающее уведомление. type: "ok" | "error". */
export function toast(message, type = "ok", ms = 3800) {
  let box = $(".toasts");
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  box.append(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Ссылка на публичный профиль зрителя. */
export const userUrl = (nick) => `user.html?u=${encodeURIComponent(nick)}`;

/** Первая буква ника для аватарки. */
export const initial = (nick) => ([...String(nick || "?")][0] || "?").toUpperCase();

/**
 * Аватарка: картинка поверх первой буквы ника. Не загрузилась — остаётся буква.
 * size: "" | "sm" | "lg" | "xl"; extra — дополнительные классы.
 */
export function avatarHTML(nick, url, { size = "", extra = "" } = {}) {
  const cls = ["avatar", size, extra, url ? "has-img" : ""].filter(Boolean).join(" ");
  const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : "";
  return `<span class="${cls}" aria-hidden="true">${esc(initial(nick))}${img}</span>`;
}

// Битая картинка аватарки → показываем букву (событие error не всплывает — ловим на погружении)
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("avatar")) {
    img.parentElement.classList.remove("has-img");
    img.remove();
  }
}, true);
