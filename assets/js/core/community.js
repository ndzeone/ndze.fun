// Discord-серверы и Minecraft: снимок data/discord.json (делает tools/sync-discord.ps1 при деплое)
// + живые цифры из браузера. Discord и его CDN в РФ открываются не у всех — тогда остаются цифры снимка.
import { plural } from "./util.js";

export const ROOT = new URL("../../../", import.meta.url); // корень сайта (файл лежит в assets/js/core/)
export const people = (n) => plural(n, ["участник", "участника", "участников"]);
export const playersLabel = (n) => plural(n, ["игрок", "игрока", "игроков"]);

let snapshot;
/** { [invite]: { id, name, description, icon, members, online, channel } } — пустой объект, если снимка нет. */
export function loadDiscord() {
  snapshot ??= fetch(new URL("data/discord.json", ROOT), { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => j.servers || {})
    .catch(() => ({}));
  return snapshot;
}

/** Абсолютный URL иконки сервера из снимка или "". */
export const iconUrl = (info) => (info?.icon ? new URL(info.icon, ROOT).href : "");

/** Живые участники/онлайн с discord.com или null. */
export async function liveInvite(code) {
  try {
    const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`, {
      signal: AbortSignal.timeout?.(5000), credentials: "omit", referrerPolicy: "no-referrer",
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!Number.isFinite(j.approximate_member_count)) return null;
    return { members: j.approximate_member_count, online: j.approximate_presence_count };
  } catch {
    return null;
  }
}

/** Статус Minecraft-сервера (api.mcstatus.io): { online, players, max, version } или null, если не узнать. */
export async function minecraftStatus(ip) {
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout?.(6000), credentials: "omit", referrerPolicy: "no-referrer",
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { online: !!j.online, players: j.players?.online ?? 0, max: j.players?.max ?? 0, version: j.version?.name_clean || "" };
  } catch {
    return null;
  }
}

/** Статус Minecraft-сервера в блоке с [data-mc-state]: «Онлайн: 12 игроков из 100» или «пока офлайн». */
export function showMinecraft(box, st) {
  const el = box?.querySelector("[data-mc-state]");
  if (!el) return;
  el.classList.toggle("is-on", !!st?.online);
  el.classList.toggle("is-off", st ? !st.online : false);
  el.querySelector("span").textContent = !st ? "Minecraft-сервер: статус недоступен"
    : st.online ? `Онлайн: ${st.players} ${playersLabel(st.players)}${st.max ? ` из ${st.max}` : ""}${st.version ? ` · ${st.version}` : ""}`
      : "Minecraft-сервер пока офлайн";
}

/** Плавно обновить число в элементе (с «прыжком», если изменилось). */
export function setCount(el, n) {
  if (!el || el.textContent === String(n)) return;
  el.textContent = n;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}
