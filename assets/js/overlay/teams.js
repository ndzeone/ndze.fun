// Оверлей OBS «Война команд»: overlay.html?w=teams&key=… — канат «Лаймовые vs Красные» с очками.
// Данные публичные (GET teams), обновляются раз в 15 секунд. ?compact=1 — только полоса без участников.
import { ensureCss } from "../modules.js";
import { apiCall } from "../data/api.js";
import { esc, plural } from "../core/util.js";
import { tugHTML } from "../play/season.js";

ensureCss("points.css");

const EVERY = 15_000;

export function mount(root, ctx) {
  const compact = ctx.params?.get("compact") === "1";
  let timer = 0;
  let alive = true;
  let last = "";

  function render(t) {
    const team = (id) => `<span class="pt-ov-team is-${id}"><b>${esc(t[id].name)}</b>
      <small>${t[id].members} ${plural(t[id].members, ["участник", "участника", "участников"])}${t[id].top3[0] ? ` · лучший: ${esc(t[id].top3[0].user.nick)}` : ""}</small></span>`;
    const html = `<section class="pt-ov${compact ? " is-compact" : ""}">
      <span class="ov-label">Война команд · ${esc(t.label)} · ndze.fun</span>
      ${compact ? "" : `<div class="pt-ov-names">${team("lime")}${team("red")}</div>`}
      ${tugHTML(t, { big: true })}
    </section>`;
    if (html === last) return;
    const first = !last;
    last = html;
    root.innerHTML = html;
    if (!first) root.querySelector(".pt-ov")?.classList.add("is-update");
  }

  async function tick() {
    try {
      const t = await apiCall("teams");
      if (alive) render(t);
    } catch (err) {
      if (alive) { last = ""; root.innerHTML = `<p class="ov-error">${esc(err.message)}</p>`; }
    }
    if (alive) timer = setTimeout(tick, EVERY);
  }
  tick();
  return { destroy() { alive = false; clearTimeout(timer); } };
}
