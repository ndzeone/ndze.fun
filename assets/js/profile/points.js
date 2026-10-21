// Кабинет → «Настройки»: рамка аватарки (с превью), команда сезона и серия бонусов, мои заказы в магазине.
import { ensureCss } from "../modules.js";
import { api, apiCall } from "../data/api.js";
import { esc, toast, avatarHTML, plural } from "../core/util.js";
import { orderHTML, pts } from "../play/shop.js";
import { TEAM_META } from "../play/season.js";
import { coinBurst } from "../header/daily.js";

ensureCss("points.css");

const days = (n) => `${n} ${plural(n, ["день", "дня", "дней"])}`;

export function mount(container, ctx) {
  let user = ctx.user;
  let frames = null; // GET me/frames
  let season = null; // GET season
  let daily = null; // GET daily
  let shop = null; // GET shop
  let alive = true;
  let busy = false;

  function framesCard() {
    if (!frames) return `<div class="pf-card glass"><h3>Рамка аватарки</h3><p class="muted">Не удалось загрузить рамки.</p></div>`;
    const opt = (id, title, sub, available) => {
      const on = (frames.current || null) === id;
      return `<button class="pt-frame-opt${on ? " is-on" : ""}${available ? "" : " is-locked"}" type="button" data-frame="${id ?? ""}"
          aria-pressed="${on}"${available ? "" : ` aria-disabled="true"`} title="${esc(available ? title : `${title}: ${sub}`)}">
        ${avatarHTML(user.nick, user.avatarUrl, { size: "lg", extra: id ? `frame-${id}` : "" })}
        <b>${esc(title)}</b>
        <small>${available ? (on ? "надета" : "открыта") : `🔒 ${esc(sub)}`}</small>
      </button>`;
    };
    const open = frames.frames.filter((f) => f.available).length;
    return `<div class="pf-card glass pt-frames-card">
      <h3>Рамка аватарки</h3>
      <p class="muted">Открыто <b>${open}</b> из ${frames.frames.length}. Рамки дают за топ-3 сезона, 5-й и 8-й уровни и серию ежедневных бонусов. Видна в шапке, на форуме и в таблицах.</p>
      <div class="pt-frames">${opt(null, "Без рамки", "", true)}${frames.frames.map((f) => opt(f.id, f.title, f.requirement, f.available)).join("")}</div>
    </div>`;
  }

  function teamCard() {
    const mine = season?.teams?.mine;
    const team = mine ? `<div class="pt-pf-team is-${mine}"><span aria-hidden="true">${TEAM_META[mine].icon}</span>
        <div><b>${esc(TEAM_META[mine].name)}</b><small>${season.teams[mine].score} XP команды · ${season.teams[mine].members} ${plural(season.teams[mine].members, ["участник", "участника", "участников"])}</small></div></div>`
      : `<p class="muted">Ты ещё не выбрал команду в этом сезоне.</p><a class="btn btn-ghost btn-sm" href="play.html#season">Выбрать команду →</a>`;
    const me = season?.me;
    const ready = daily && !daily.claimedToday;
    return `<div class="pf-card glass pt-pf-season">
      <h3>Сезон и бонус</h3>
      ${season ? `<p class="muted">${esc(season.label)}: ${me?.place ? `ты на <b>${me.place}</b> месте, <b>${me.xp}</b> XP` : "опыта в этом сезоне пока нет"}.</p>` : ""}
      ${season ? team : ""}
      ${daily ? `<div class="pt-pf-streak">
        <span class="pt-flame" aria-hidden="true">🔥</span>
        <div><b>Серия: ${days(daily.streak)}</b><small>лучшая — ${days(daily.maxStreak)}${daily.maxStreak < 7 ? " · 7 дней открывают рамку «Лайм»" : ""}</small></div>
        ${ready ? `<button class="btn btn-primary btn-sm" type="button" data-claim><span>Забрать +${daily.nextAmount}</span><span class="spinner" aria-hidden="true"></span></button>`
          : `<span class="badge lime">завтра +${daily.nextAmount}</span>`}
      </div>` : ""}
    </div>`;
  }

  function ordersCard() {
    const orders = shop?.orders || [];
    return `<div class="pf-card glass pt-pf-orders">
      <h3>Мои заказы</h3>
      <p class="muted">Баланс: <b>${shop ? pts(shop.balance) : "—"}</b>. Заказ ждёт, пока ndze его выполнит; при отмене баллы возвращаются.</p>
      ${orders.length ? `<ul class="pt-orders">${orders.map(orderHTML).join("")}</ul>`
        : `<p class="faint">Пока ничего не заказано.</p>`}
      <a class="btn btn-ghost btn-sm" href="play.html#shop">В магазин →</a>
    </div>`;
  }

  function render() {
    if (!alive) return;
    container.innerHTML = framesCard() + teamCard() + ordersCard();
  }

  async function load() {
    const [f, s, d, sh] = await Promise.allSettled([apiCall("me/frames"), apiCall("season"), apiCall("daily"), apiCall("shop")]);
    frames = f.value ?? null;
    season = s.value ?? null;
    daily = d.value ?? null;
    shop = sh.value ?? null;
    render();
  }

  container.addEventListener("click", async (e) => {
    const fr = e.target.closest("[data-frame]");
    if (fr && !busy) {
      const id = fr.dataset.frame || null;
      const def = frames?.frames.find((x) => x.id === id);
      if (id && !def?.available) { toast(`Рамка «${def?.title}» ещё закрыта: ${def?.requirement.toLowerCase()}`, "error"); return; }
      if ((frames.current || null) === id) return;
      busy = true;
      fr.classList.add("is-busy");
      try {
        const r = await apiCall("me/frame", { method: "POST", body: { frame: id } });
        frames = r;
        toast(id ? `Рамка «${def.title}» надета ✨` : "Рамка снята");
        render();
        api.getProfile().catch(() => {}); // обновит пользователя → шапка сайта и шапка кабинета перерисуются
      } catch (err) {
        toast(err.message, "error");
        fr.classList.remove("is-busy");
      } finally {
        busy = false;
      }
      return;
    }
    const claim = e.target.closest("[data-claim]");
    if (claim && !busy) {
      busy = true;
      claim.disabled = true;
      claim.classList.add("is-loading");
      try {
        const r = await apiCall("daily/claim", { method: "POST" });
        daily = r;
        if (shop) shop.balance = r.balance;
        coinBurst(claim, r.amount);
        toast(`+${r.amount} баллов, серия ${days(r.streak)} 🔥`);
        window.dispatchEvent(new CustomEvent("ndze:daily", { detail: r })); // кнопка в шапке перестанет светиться
        if (r.streak >= 7 && frames) frames = await apiCall("me/frames").catch(() => frames);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        busy = false;
        render();
      }
    }
  });

  // бонус забрали кнопкой в шапке
  const onPoints = (e) => {
    if (e.detail?.daily) daily = e.detail.daily;
    if (shop && typeof e.detail?.balance === "number") shop.balance = e.detail.balance;
    render();
  };
  window.addEventListener("ndze:points", onPoints);

  container.innerHTML = '<div class="pf-card glass"><div class="skeleton" style="min-height:160px"></div></div>';
  load();
  return { destroy() { alive = false; window.removeEventListener("ndze:points", onPoints); } };
}
