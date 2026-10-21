// «Движ» → «Penta: карта»: живая карта сервера (BlueMap/Dynmap по ссылке из пульта) и галерея построек игроков.
// Карта тяжёлая (WebGL) — грузится по клику. Скриншоты — через тот же конвейер картинок, что у работ.
import { apiCall } from "../data/api.js";
import { getUser, openAuth } from "../core/layout.js";
import { $, $$, esc, avatarHTML, plural, formatDate, toast } from "../core/util.js";
import { setupModal } from "../core/modal.js";
import { ensureCss } from "../modules.js";

ensureCss("community.css");

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const userUrl = (nick) => `user.html?u=${encodeURIComponent(nick)}`;
const votesLabel = (n) => plural(n, ["голос", "голоса", "голосов"]);

export function mount(container, ctx = {}) {
  const me = getUser() || ctx.user || null;
  const isAdmin = me?.role === "admin";
  let sort = "top";
  let data = null;
  let alive = true;
  let seq = 0;
  let current = -1; // индекс открытой в лайтбоксе постройки
  let previewUrl = "";

  container.innerHTML = '<div class="skeleton cm-skel"></div>';

  /* ---------- Окна: лайтбокс и форма загрузки (живут в body, убираются в destroy) ---------- */
  const lb = document.createElement("dialog");
  lb.className = "modal wide cm-lb";
  lb.setAttribute("aria-label", "Постройка");
  lb.innerHTML = `<div class="modal-frame"><div class="modal-card cm-lb-card">
    <button class="modal-close" type="button" data-close aria-label="Закрыть">✕</button>
    <div class="cm-lb-body" id="cmLbBody"></div>
  </div></div>`;
  const up = document.createElement("dialog");
  up.className = "modal cm-up";
  up.setAttribute("aria-labelledby", "cmUpTitle");
  up.innerHTML = `<div class="modal-frame"><div class="modal-card">
    <span class="modal-ticks" aria-hidden="true"><i></i><i></i><i></i></span>
    <button class="modal-close" type="button" data-close aria-label="Закрыть">✕</button>
    <p class="modal-logo">Penta · постройки</p>
    <h2 id="cmUpTitle">Показать постройку</h2>
    <form id="cmBuildForm" novalidate>
      <label class="cm-drop" id="cmDrop">
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only" aria-describedby="cmFile-err">
        <span class="cm-drop-preview" id="cmPreview"><span class="cm-drop-icon" aria-hidden="true">🖼</span><span>Выбери или перетащи скриншот<br><small class="faint">JPG, PNG, WEBP, GIF · до 10 МБ</small></span></span>
      </label>
      <span class="error-msg cm-file-err" id="cmFile-err" data-err="files"></span>
      <div class="field">
        <input id="cmBTitle" name="title" type="text" placeholder=" " maxlength="80" autocomplete="off" aria-describedby="cmBTitle-err">
        <label for="cmBTitle">Название</label><span class="error-msg" id="cmBTitle-err"></span>
      </div>
      <div class="field">
        <input id="cmBCoords" name="coords" type="text" placeholder=" " maxlength="40" autocomplete="off" aria-describedby="cmBCoords-err">
        <label for="cmBCoords">Координаты X Y Z (необязательно)</label><span class="error-msg" id="cmBCoords-err"></span>
      </div>
      <div class="field">
        <textarea id="cmBDesc" name="description" placeholder=" " rows="3" maxlength="500" aria-describedby="cmBDesc-err"></textarea>
        <label for="cmBDesc">Пара слов о постройке (необязательно)</label><span class="error-msg" id="cmBDesc-err"></span>
      </div>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit"><span>Опубликовать</span><span class="spinner" aria-hidden="true"></span></button>
    </form>
  </div></div>`;
  document.body.append(lb, up);
  const lbModal = setupModal(lb, { onClose: () => { current = -1; } });
  const upModal = setupModal(up, { onClose: resetForm });
  const form = $("#cmBuildForm", up);

  /* ---------- Разметка ---------- */
  function mapHTML(url) {
    if (!url) {
      return `<section class="cm-map cm-map-empty glass" aria-labelledby="cmMapTitle">
        <div class="cm-map-blocks" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => `<i style="--d:${(i * 37) % 23}"></i>`).join("")}</div>
        <div class="cm-map-msg">
          <p class="cm-kicker">🗺 Penta SMP</p>
          <h2 class="py-title" id="cmMapTitle">Карта появится, когда сервер откроется</h2>
          <p class="muted">А пока — показывай, что уже построил, и голосуй за чужие постройки.</p>
        </div>
      </section>`;
    }
    return `<section class="cm-map glass" aria-labelledby="cmMapTitle">
      <div class="cm-map-head">
        <h2 class="py-title" id="cmMapTitle">Карта Penta</h2>
        <a class="btn btn-ghost btn-xs" href="${esc(url)}" target="_blank" rel="noopener noreferrer">На весь экран ↗</a>
      </div>
      <div class="cm-map-frame" id="cmMapFrame">
        <button class="cm-map-load" type="button" data-map-load>
          <span class="cm-map-blocks" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => `<i style="--d:${(i * 37) % 23}"></i>`).join("")}</span>
          <span class="cm-map-cta"><span aria-hidden="true">🧭</span> Открыть живую карту</span>
        </button>
      </div>
    </section>`;
  }

  const buildCardHTML = (b, i) => `<button class="cm-build glass" type="button" data-open="${i}" aria-label="Постройка «${esc(b.title)}» от ${esc(b.author.nick)}" style="--i:${Math.min(i, 12)}">
    <span class="cm-build-img"><img src="${esc(b.imageUrl)}" alt="" loading="lazy" decoding="async"${b.width && b.height ? ` width="${b.width}" height="${b.height}"` : ""}></span>
    <span class="cm-build-info">
      <b>${esc(b.title)}</b>
      <span class="cm-build-meta">${avatarHTML(b.author.nick, b.author.avatarUrl, { size: "xs" })}${esc(b.author.nick)}</span>
    </span>
    <span class="cm-build-votes${b.myVote ? " is-on" : ""}" aria-hidden="true">▲ ${b.votes}</span>
  </button>`;

  function render() {
    const items = data.items;
    container.innerHTML = `<div class="cm-penta">
      ${mapHTML(data.mapUrl)}
      <section class="cm-builds-sec" aria-labelledby="cmBuildsTitle">
        <div class="cm-head">
          <h2 class="py-title" id="cmBuildsTitle">Постройки игроков</h2>
          <div class="chips" role="group" aria-label="Сортировка">
            <button class="chip" type="button" data-sort="top" aria-pressed="${sort === "top"}">Топ</button>
            <button class="chip" type="button" data-sort="new" aria-pressed="${sort === "new"}">Новые</button>
          </div>
          <span class="cm-spacer"></span>
          <button class="btn btn-primary btn-sm" type="button" data-upload>＋ Показать постройку</button>
        </div>
        ${items.length ? `<div class="cm-build-grid">${items.map(buildCardHTML).join("")}</div>`
          : `<div class="empty"><span class="empty-icon">🏰</span><p>Пока никто не хвастался постройками. Будь первым — за 3 постройки дают значок «Архитектор» 🏰</p></div>`}
      </section>
    </div>`;
  }

  function lightboxHTML(b) {
    const own = me && b.author.id === me.id;
    const canMod = isAdmin;
    return `<figure class="cm-lb-fig">
        <img src="${esc(b.imageUrl)}" alt="${esc(b.title)}"${b.width && b.height ? ` width="${b.width}" height="${b.height}"` : ""}>
        ${data.items.length > 1 ? `<button class="cm-lb-nav prev" type="button" data-nav="-1" aria-label="Предыдущая">‹</button>
          <button class="cm-lb-nav next" type="button" data-nav="1" aria-label="Следующая">›</button>` : ""}
      </figure>
      <div class="cm-lb-info">
        <div class="cm-lb-top">
          <h2>${esc(b.title)}</h2>
          ${b.status === "hidden" ? '<span class="badge warn">скрыта</span>' : ""}
        </div>
        <p class="cm-clip-meta"><a class="cm-user" href="${esc(userUrl(b.author.nick))}">${avatarHTML(b.author.nick, b.author.avatarUrl, { size: "xs" })}${esc(b.author.nick)}</a>
          <span class="faint">· ${esc(formatDate(b.createdAt))}</span></p>
        ${b.coords ? `<p class="cm-coords"><span>📍 <code>${esc(b.coords)}</code></span><button class="btn btn-ghost btn-xs" type="button" data-copy="${esc(b.coords)}">Копировать</button></p>` : ""}
        ${b.description ? `<p class="cm-lb-desc">${esc(b.description)}</p>` : ""}
        <div class="cm-clip-actions">
          <button class="cm-vote${b.myVote ? " is-on" : ""}" type="button" data-vote="${esc(b.id)}" aria-pressed="${b.myVote}"
            ${own || b.status !== "visible" ? "disabled" : ""} aria-label="Голос за постройку, сейчас ${b.votes}"><span aria-hidden="true">▲</span><b>${b.votes}</b></button>
          <span class="faint">${votesLabel(b.votes)}</span>
          <span class="cm-spacer"></span>
          ${canMod ? `<button class="btn btn-ghost btn-xs" type="button" data-mod="${b.status === "visible" ? "hidden" : "visible"}">${b.status === "visible" ? "Скрыть" : "Показать"}</button>` : ""}
          ${b.canDelete ? `<button class="btn btn-danger btn-xs" type="button" data-del>Удалить</button>` : ""}
        </div>
      </div>`;
  }

  function openLightbox(i) {
    if (!data.items[i]) return;
    current = i;
    $("#cmLbBody", lb).innerHTML = lightboxHTML(data.items[i]);
    lbModal.open();
  }

  /* ---------- Данные ---------- */
  async function load() {
    const my = ++seq;
    try {
      const d = await apiCall("builds", { query: { sort } });
      if (!alive || my !== seq) return;
      data = d;
      render();
    } catch (err) {
      if (!alive || my !== seq) return;
      container.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message || "Не удалось загрузить")}</p></div>`;
    }
  }

  /* ---------- Клики в панели ---------- */
  function onClick(e) {
    const t = e.target;
    const ml = t.closest("[data-map-load]");
    if (ml && data.mapUrl) {
      const frame = $("#cmMapFrame", container);
      frame.innerHTML = `<iframe src="${esc(data.mapUrl)}" title="Живая карта сервера Penta" loading="lazy" referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-pointer-lock" allow="fullscreen"></iframe>`;
      return;
    }
    const s = t.closest("[data-sort]");
    if (s && s.dataset.sort !== sort) { sort = s.dataset.sort; load(); return; }
    if (t.closest("[data-upload]")) {
      if (!me) return openAuth("login", "Войди, чтобы показать свою постройку");
      upModal.open();
      form.elements.title.focus();
      return;
    }
    const o = t.closest("[data-open]");
    if (o) openLightbox(Number(o.dataset.open));
  }

  /* ---------- Клики в лайтбоксе ---------- */
  async function onLbClick(e) {
    const b = data?.items[current];
    if (!b) return;
    const t = e.target;
    const nav = t.closest("[data-nav]");
    if (nav) return step(Number(nav.dataset.nav));
    const copy = t.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Координаты скопированы 📍"); } catch { toast(copy.dataset.copy); }
      return;
    }
    const v = t.closest("[data-vote]");
    if (v && !v.disabled) {
      if (!me) return openAuth("login", "Войди, чтобы голосовать за постройки");
      v.disabled = true;
      try {
        const r = await apiCall("build/vote", { method: "POST", body: { id: b.id } });
        Object.assign(b, { votes: r.votes, myVote: r.myVote });
        $("#cmLbBody", lb).innerHTML = lightboxHTML(b);
        const card = $(`[data-open="${current}"] .cm-build-votes`, container);
        if (card) { card.textContent = `▲ ${r.votes}`; card.classList.toggle("is-on", r.myVote); }
      } catch (err) {
        toast(err.message, "error");
        v.disabled = false;
      }
      return;
    }
    const m = t.closest("[data-mod]");
    if (m) {
      m.disabled = true;
      try {
        const r = await apiCall("build/moderate", { method: "POST", body: { id: b.id, status: m.dataset.mod } });
        toast(r.status === "hidden" ? "Постройка скрыта из галереи" : "Постройка снова видна");
        lbModal.close();
        load();
      } catch (err) {
        toast(err.message, "error");
        m.disabled = false;
      }
      return;
    }
    const d = t.closest("[data-del]");
    if (d && confirm(`Удалить постройку «${b.title}»? Скриншот удалится навсегда.`)) {
      d.disabled = true;
      try {
        await apiCall("build/delete", { method: "POST", body: { id: b.id } });
        toast("Постройка удалена");
        lbModal.close();
        load();
      } catch (err) {
        toast(err.message, "error");
        d.disabled = false;
      }
    }
  }

  function step(dir) {
    const n = data.items.length;
    if (n < 2 || current < 0) return;
    current = (current + dir + n) % n;
    $("#cmLbBody", lb).innerHTML = lightboxHTML(data.items[current]);
  }
  const onLbKey = (e) => {
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  };

  /* ---------- Форма загрузки ---------- */
  function setFile(file) {
    const errEl = $("#cmFile-err", up);
    errEl.textContent = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    form._file = null;
    if (!file) return;
    if (!TYPES.includes(file.type)) { errEl.textContent = "Нужен JPG, PNG, WEBP или GIF"; return; }
    if (file.size > MAX_BYTES) { errEl.textContent = "Файл больше 10 МБ"; return; }
    form._file = file;
    previewUrl = URL.createObjectURL(file);
    $("#cmPreview", up).innerHTML = `<img src="${esc(previewUrl)}" alt="Предпросмотр скриншота"><span class="cm-drop-name">${esc(file.name)}</span>`;
  }

  function resetForm() {
    form.reset();
    setFile(null);
    $("#cmPreview", up).innerHTML = `<span class="cm-drop-icon" aria-hidden="true">🖼</span><span>Выбери или перетащи скриншот<br><small class="faint">JPG, PNG, WEBP, GIF · до 10 МБ</small></span>`;
    clearErrors();
    const btn = $('button[type="submit"]', form);
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }

  function clearErrors() {
    $$(".field", form).forEach((f) => { f.classList.remove("invalid"); $(".error-msg", f).textContent = ""; });
    $("#cmFile-err", up).textContent = "";
    $(".form-error", form).textContent = "";
  }

  function showErrors(fields) {
    for (const [name, msg] of Object.entries(fields || {})) {
      if (name === "files") { $("#cmFile-err", up).textContent = msg; continue; }
      const el = form.elements[name];
      const field = el?.closest(".field");
      if (!field) continue;
      field.classList.add("invalid");
      $(".error-msg", field).textContent = msg;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    if (btn.disabled) return;
    clearErrors();
    const title = form.elements.title.value.trim();
    const coords = form.elements.coords.value.trim();
    const description = form.elements.description.value.trim();
    const errors = {};
    if (!form._file) errors.files = "Добавь скриншот постройки";
    if ([...title].length < 3 || [...title].length > 80) errors.title = "Название от 3 до 80 символов";
    if ([...coords].length > 40) errors.coords = "Не больше 40 символов";
    if ([...description].length > 500) errors.description = "Не больше 500 символов";
    if (Object.keys(errors).length) return showErrors(errors);
    const fd = new FormData();
    fd.append("title", title);
    fd.append("coords", coords);
    fd.append("description", description);
    fd.append("files[]", form._file, form._file.name);
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      await apiCall("build", { method: "POST", form: fd });
      toast("Постройка опубликована 🏰");
      upModal.close();
      sort = "new";
      load();
    } catch (err) {
      showErrors(err.fields);
      $(".form-error", form).textContent = err.message;
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }

  const onFileChange = (e) => { if (e.target.name === "file") setFile(e.target.files?.[0] || null); };
  const drop = $("#cmDrop", up);
  const onDrag = (e) => { e.preventDefault(); drop.classList.toggle("is-drag", e.type === "dragover"); };
  const onDrop = (e) => { e.preventDefault(); drop.classList.remove("is-drag"); setFile(e.dataTransfer?.files?.[0] || null); };
  const onFormInput = (e) => {
    const field = e.target.closest(".field.invalid");
    if (field) { field.classList.remove("invalid"); $(".error-msg", field).textContent = ""; }
  };

  container.addEventListener("click", onClick);
  lb.addEventListener("click", onLbClick);
  lb.addEventListener("keydown", onLbKey);
  form.addEventListener("submit", onSubmit);
  form.addEventListener("change", onFileChange);
  form.addEventListener("input", onFormInput);
  drop.addEventListener("dragover", onDrag);
  drop.addEventListener("dragleave", onDrag);
  drop.addEventListener("drop", onDrop);
  load();

  return {
    destroy() {
      alive = false;
      container.removeEventListener("click", onClick);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      lb.remove();
      up.remove();
      container.innerHTML = "";
    },
  };
}
