// Пульт → «Клипы · постройки · пасхалки»: модерация клипов и построек, ссылка на карту Penta, статистика квеста-пауков.
import { apiCall } from "../data/api.js";
import { $, esc, timeAgo, toast } from "../core/util.js";
import { ensureCss } from "../modules.js";
import { QUEST_HINTS } from "../core/quest.js";

ensureCss("community.css");

const EGG_LABELS = { home: "Главная", projects: "Проекты", forum: "Форум", review: "Оценка работ", 404: "Страница 404" };
const userUrl = (nick) => `user.html?u=${encodeURIComponent(nick)}`;

export function mount(container) {
  let alive = true;
  let clips = [];
  let builds = [];
  let mapUrl = "";
  let quest = null;
  let buildFilter = "all";

  container.innerHTML = '<div class="skeleton cm-skel"></div>';

  function clipsHTML() {
    if (!clips.length) return `<p class="muted">Клипов пока нет.</p>`;
    return `<ul class="cm-adm-list">${clips.map((c) => `<li class="cm-adm-row">
      <span class="cm-adm-main"><b>${esc(c.title)}</b>
        <small class="faint"><a class="cm-user" href="${esc(userUrl(c.author.nick))}">${esc(c.author.nick)}</a> · ${esc(timeAgo(c.createdAt))} · ▲ ${c.votes}</small></span>
      <a class="btn btn-ghost btn-xs" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Смотреть ↗</a>
      <button class="btn btn-danger btn-xs" type="button" data-del-clip="${esc(c.id)}">Удалить</button>
    </li>`).join("")}</ul>`;
  }

  function buildsHTML() {
    const list = buildFilter === "hidden" ? builds.filter((b) => b.status === "hidden") : builds;
    const hidden = builds.filter((b) => b.status === "hidden").length;
    return `<div class="chips cm-adm-chips" role="group" aria-label="Фильтр построек">
        <button class="chip" type="button" data-bfilter="all" aria-pressed="${buildFilter === "all"}">Все <span class="count">${builds.length}</span></button>
        <button class="chip" type="button" data-bfilter="hidden" aria-pressed="${buildFilter === "hidden"}">Скрытые <span class="count">${hidden}</span></button>
      </div>
      ${list.length ? `<ul class="cm-adm-list">${list.map((b) => `<li class="cm-adm-row${b.status === "hidden" ? " is-hidden" : ""}">
        <a class="cm-adm-thumb" href="${esc(b.imageUrl)}" target="_blank" rel="noopener"><img src="${esc(b.imageUrl)}" alt="" loading="lazy"></a>
        <span class="cm-adm-main"><b>${esc(b.title)}</b>
          <small class="faint"><a class="cm-user" href="${esc(userUrl(b.author.nick))}">${esc(b.author.nick)}</a> · ${esc(timeAgo(b.createdAt))} · ▲ ${b.votes}${b.coords ? ` · 📍 ${esc(b.coords)}` : ""}</small></span>
        ${b.status === "hidden" ? '<span class="badge warn">скрыта</span>' : ""}
        <button class="btn btn-ghost btn-xs" type="button" data-mod-build="${esc(b.id)}" data-status="${b.status === "visible" ? "hidden" : "visible"}">${b.status === "visible" ? "Скрыть" : "Показать"}</button>
        <button class="btn btn-danger btn-xs" type="button" data-del-build="${esc(b.id)}">Удалить</button>
      </li>`).join("")}</ul>` : `<p class="muted">${buildFilter === "hidden" ? "Скрытых построек нет." : "Построек пока нет."}</p>`}`;
  }

  function questHTML() {
    if (!quest) return `<p class="muted">Нет данных.</p>`;
    const max = Math.max(1, ...quest.eggs.map((e) => e.finds));
    return `<p class="muted">Охотников: <b>${quest.hunters}</b> · нашли всех пятерых: <b class="cm-lime">${quest.completed}</b></p>
      <ul class="cm-adm-eggs">${quest.eggs.map((e) => `<li title="${esc(QUEST_HINTS[e.egg] || "")}">
        <span>${esc(EGG_LABELS[e.egg] || e.egg)}</span>
        <span class="cm-adm-bar"><i style="width:${Math.round((e.finds / max) * 100)}%"></i></span>
        <b>${e.finds}</b></li>`).join("")}</ul>
      ${quest.recent.length ? `<p class="faint cm-adm-recent">Последние: ${quest.recent.map((r) => `<a class="cm-user" href="${esc(userUrl(r.nick))}">${esc(r.nick)}</a>`).join(", ")}</p>` : ""}`;
  }

  function render() {
    container.innerHTML = `<div class="cm-adm">
      <section class="cm-adm-box glass" aria-labelledby="cmAdmMap">
        <h3 id="cmAdmMap">🗺 Карта Penta</h3>
        <p class="muted">Ссылка на BlueMap или Dynmap (только https). Пусто — на вкладке «Penta: карта» заглушка «Карта появится, когда сервер откроется».</p>
        <form class="cm-adm-map" id="cmMapForm" novalidate>
          <div class="field">
            <input id="cmMapUrl" name="url" type="url" placeholder=" " inputmode="url" maxlength="300" value="${esc(mapUrl)}" aria-describedby="cmMapUrl-err">
            <label for="cmMapUrl">https://map.…</label><span class="error-msg" id="cmMapUrl-err"></span>
          </div>
          <button class="btn btn-primary btn-sm" type="submit"><span>Сохранить</span><span class="spinner" aria-hidden="true"></span></button>
        </form>
      </section>
      <section class="cm-adm-box glass" aria-labelledby="cmAdmQuest">
        <h3 id="cmAdmQuest">🕷 Квест «Найди 5 пауков»</h3>
        ${questHTML()}
      </section>
      <section class="cm-adm-box glass cm-adm-wide" aria-labelledby="cmAdmClips">
        <h3 id="cmAdmClips">🎬 Клипы <span class="faint">(${clips.length})</span></h3>
        ${clipsHTML()}
      </section>
      <section class="cm-adm-box glass cm-adm-wide" aria-labelledby="cmAdmBuilds">
        <h3 id="cmAdmBuilds">🏰 Постройки</h3>
        ${buildsHTML()}
      </section>
    </div>`;
  }

  async function load() {
    try {
      const [c, b, q] = await Promise.all([
        apiCall("clips", { query: { period: "all", sort: "new" } }),
        apiCall("builds", { query: { scope: "admin" } }),
        apiCall("quest/stats").catch(() => null),
      ]);
      if (!alive) return;
      clips = c.items;
      builds = b.items;
      mapUrl = b.mapUrl || "";
      quest = q;
      render();
    } catch (err) {
      if (alive) container.innerHTML = `<p class="muted">${esc(err.message || "Не удалось загрузить")}</p>`;
    }
  }

  async function act(btn, route, body, okText) {
    btn.disabled = true;
    try {
      await apiCall(route, { method: "POST", body });
      toast(okText);
      await load();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  }

  function onClick(e) {
    const t = e.target;
    const f = t.closest("[data-bfilter]");
    if (f) { buildFilter = f.dataset.bfilter; render(); return; }
    const dc = t.closest("[data-del-clip]");
    if (dc && confirm("Удалить клип вместе с голосами?")) return act(dc, "clip/delete", { id: dc.dataset.delClip }, "Клип удалён");
    const mb = t.closest("[data-mod-build]");
    if (mb) return act(mb, "build/moderate", { id: mb.dataset.modBuild, status: mb.dataset.status }, mb.dataset.status === "hidden" ? "Постройка скрыта" : "Постройка снова видна");
    const db = t.closest("[data-del-build]");
    if (db && confirm("Удалить постройку? Скриншот удалится с сервера.")) return act(db, "build/delete", { id: db.dataset.delBuild }, "Постройка удалена");
  }

  async function onSubmit(e) {
    const form = e.target.closest("#cmMapForm");
    if (!form) return;
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    const field = $(".field", form);
    const url = form.elements.url.value.trim();
    field.classList.remove("invalid");
    $(".error-msg", field).textContent = "";
    if (url && !/^https:\/\/[^\s"'<>`\\]+$/i.test(url)) {
      field.classList.add("invalid");
      $(".error-msg", field).textContent = "Нужна ссылка, начинающаяся с https://";
      return;
    }
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const r = await apiCall("penta/map", { method: "POST", body: { url } });
      mapUrl = r.mapUrl;
      toast(mapUrl ? "Карта подключена 🗺" : "Карта убрана — показываем заглушку");
    } catch (err) {
      field.classList.add("invalid");
      $(".error-msg", field).textContent = err.fields?.url || err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  load();

  return {
    destroy() {
      alive = false;
      container.removeEventListener("click", onClick);
      container.removeEventListener("submit", onSubmit);
    },
  };
}
