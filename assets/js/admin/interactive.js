// Пульт → «Опросы · розыгрыши · бинго · квизы · тир-листы» (stream.html, только админ).
// Пять подразделов: создание, закрытие, удаление; в бинго — отметка случившихся событий; ссылки на оверлеи OBS.
import { api, apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, plural, timeAgo } from "../core/util.js";

ensureCss("interactive.css");

const SECTIONS = [
  { id: "polls", label: "Опросы", icon: "📊" },
  { id: "giveaways", label: "Розыгрыши", icon: "🎁" },
  { id: "bingo", label: "Бинго", icon: "🎱" },
  { id: "quiz", label: "Квизы", icon: "🧠" },
  { id: "tierlists", label: "Тир-листы", icon: "🏅" },
];
const OVERLAYS = [
  { w: "poll", label: "Опрос", hint: "последний открытый опрос, 760×480" },
  { w: "giveaway", label: "Розыгрыш", hint: "счётчик и рулетка победителя, 760×360" },
  { w: "bingo", label: "Бинго", hint: "случившиеся события и победители, 760×600" },
];
const STATUS = {
  open: ["Открыт", "lime"], closed: ["Закрыт", "plain"], drawn: ["Разыгран", "info"], draft: ["Черновик", "warn"],
};
const badge = (s) => `<span class="badge ${(STATUS[s] || STATUS.closed)[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
const field = (name, label, { type = "text", max = 0, value = "", tag = "input", extra = "" } = {}) => tag === "textarea"
  ? `<div class="field"><textarea name="${name}" placeholder=" " ${max ? `maxlength="${max}"` : ""} ${extra}>${esc(value)}</textarea><label>${esc(label)}</label></div>`
  : `<div class="field"><input name="${name}" type="${type}" placeholder=" " ${max ? `maxlength="${max}"` : ""} value="${esc(value)}" ${extra}><label>${esc(label)}</label></div>`;
const btn = (label, data, cls = "btn-ghost") => `<button class="btn ${cls} btn-xs" type="button" ${data}>${label}</button>`;
const lines = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
// «⛏ Minecraft» → { emoji: "⛏", text: "Minecraft" }
const EMOJI_RE = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})[️‍\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]*)\s*(.+)$/u;
const parseTierItem = (line) => {
  const m = line.match(EMOJI_RE);
  return m ? { emoji: m[1], text: m[2].trim() } : { emoji: null, text: line };
};

export function mount(root) {
  let data = null;
  let tab = "polls";
  let overlayKey = "";
  let qid = 0; // счётчик для имён радио-кнопок в конструкторе квиза
  root.classList.add("ix", "ix-admin");

  /* ---------- Каркас ---------- */
  function shell() {
    root.innerHTML = `
      <div class="ix-atabs" role="tablist">${SECTIONS.map((s) => `<button class="chip" type="button" role="tab" data-sec="${s.id}" aria-selected="${s.id === tab}" aria-pressed="${s.id === tab}"><span aria-hidden="true">${s.icon}</span>${esc(s.label)}</button>`).join("")}</div>
      <div data-form></div>
      <div class="ix-alist" data-list></div>
      <h3 class="ix-sub">Оверлеи OBS</h3>
      <p class="ix-note">Данные этих оверлеев публичные. «Источник → Браузер», фон прозрачный.</p>
      <div class="ix-ovlinks" data-ov></div>`;
    renderOverlays();
    renderForm();
    renderList();
  }

  function renderOverlays() {
    root.querySelector("[data-ov]").innerHTML = OVERLAYS.map((o) => {
      const url = new URL(`overlay.html?w=${o.w}${overlayKey ? `&key=${encodeURIComponent(overlayKey)}` : ""}`, location.href).href;
      return `<div class="glass"><b>${esc(o.label)}</b><small>${esc(o.hint)}</small>
        <div class="ix-arow-actions">${btn("Копировать ссылку", `data-copy="${esc(url)}"`)}<a class="btn btn-ghost btn-xs" href="${esc(url)}" target="_blank" rel="noopener">Открыть</a></div></div>`;
    }).join("");
  }

  function setTab(id) {
    tab = id;
    root.querySelectorAll("[data-sec]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.sec === id));
      b.setAttribute("aria-pressed", String(b.dataset.sec === id));
    });
    renderForm();
    renderList();
  }

  /* ---------- Формы создания ---------- */
  function questionBlock(n) {
    const id = ++qid;
    return `<div class="ix-qb" data-qb>
      <div class="ix-qb-head"><b class="ix-sub" data-qn>Вопрос ${n}</b>${btn("Убрать", "data-qdel", "btn-danger")}</div>
      ${field("q", "Текст вопроса (до 200 символов)", { max: 200 })}
      ${[0, 1, 2, 3].map((k) => `<div class="ix-qb-opt"><input type="radio" name="c${id}" value="${k}"${k === 0 ? " checked" : ""} aria-label="Вариант ${k + 1} — правильный">
        ${field("o", `Вариант ${k + 1}${k > 1 ? " (необязательно)" : ""}`, { max: 200 })}</div>`).join("")}
    </div>`;
  }

  function renderForm() {
    const box = root.querySelector("[data-form]");
    let html = "";
    if (tab === "polls") {
      html = `<form class="ix-form glass" data-create="poll" novalidate>
        <h3 class="ix-h3">Новый опрос</h3>
        ${field("question", "Вопрос, например «Во что играть в пятницу?»", { max: 160 })}
        <div class="ix-form-row">${[0, 1, 2, 3, 4, 5].map((i) => field("opt", `Вариант ${i + 1}${i > 1 ? " (необязательно)" : ""}`, { max: 60 })).join("")}</div>
        <div class="ix-form-actions"><button class="btn btn-primary btn-sm" type="submit">Запустить опрос</button></div>
      </form>`;
    } else if (tab === "giveaways") {
      html = `<form class="ix-form glass" data-create="giveaway" novalidate>
        <h3 class="ix-h3">Новый розыгрыш</h3>
        <div class="ix-form-row">${field("title", "Название", { max: 120 })}${field("prize", "Приз", { max: 160 })}</div>
        <p class="ix-note">Секрет загадывается сразу, зрители видят его sha256 — после розыгрыша секрет раскроется и победителя можно проверить.</p>
        <div class="ix-form-actions"><button class="btn btn-primary btn-sm" type="submit">Открыть приём участников</button></div>
      </form>`;
    } else if (tab === "bingo") {
      html = `<form class="ix-form glass" data-create="bingo" novalidate>
        <h3 class="ix-h3">Новый раунд бинго</h3>
        <div class="ix-form-row">${field("title", "Название раунда", { max: 120 })}${field("reward", "Награда за 1-е место, баллов", { type: "number", value: "100", extra: 'min="0" max="10000" inputmode="numeric"' })}</div>
        ${field("items", "События — по одному в строке (от 24, до 60 символов)", { tag: "textarea", extra: 'rows="8"' })}
        <div class="ix-form-actions"><span class="ix-counter" data-count>0 / 24</span><button class="btn btn-primary btn-sm" type="submit">Начать раунд</button></div>
      </form>`;
    } else if (tab === "quiz") {
      html = `<form class="ix-form glass" data-create="quiz" novalidate>
        <h3 class="ix-h3">Новый квиз (черновик)</h3>
        <div class="ix-form-row">${field("title", "Название", { max: 120 })}${field("reward", "Баллов за верный ответ", { type: "number", value: "10", extra: 'min="0" max="1000" inputmode="numeric"' })}</div>
        <p class="ix-note">Отметь кружком правильный вариант. От 3 до 15 вопросов, 2–4 варианта.</p>
        <div class="ix" data-qlist>${[1, 2, 3].map(questionBlock).join("")}</div>
        <div class="ix-form-actions">${btn("+ Вопрос", "data-qadd")}<button class="btn btn-primary btn-sm" type="submit">Сохранить черновик</button></div>
      </form>`;
    } else {
      html = `<form class="ix-form glass" data-create="tierlist" novalidate>
        <h3 class="ix-h3">Новый тир-лист</h3>
        ${field("title", "Название, например «Игры стрима»", { max: 120 })}
        ${field("items", "Предметы — по одному в строке, можно с эмодзи в начале: «⛏ Minecraft»", { tag: "textarea", extra: 'rows="7"' })}
        <div class="ix-form-actions"><span class="ix-counter" data-count>0 / 4–30</span><button class="btn btn-primary btn-sm" type="submit">Открыть голосование</button></div>
      </form>`;
    }
    box.innerHTML = html;
  }

  function renumber(form) {
    form.querySelectorAll("[data-qb]").forEach((b, i) => { b.querySelector("[data-qn]").textContent = `Вопрос ${i + 1}`; });
  }

  function collect(form) {
    const kind = form.dataset.create;
    const v = (n) => form.elements[n]?.value ?? "";
    if (kind === "poll") return ["poll/create", { question: v("question"), options: [...form.querySelectorAll('[name="opt"]')].map((i) => i.value).filter((s) => s.trim()) }];
    if (kind === "giveaway") return ["giveaway/create", { title: v("title"), prize: v("prize") }];
    if (kind === "bingo") return ["bingo/create", { title: v("title"), reward: Number(v("reward") || 0), items: lines(v("items")) }];
    if (kind === "tierlist") return ["tierlist/create", { title: v("title"), items: lines(v("items")).map(parseTierItem) }];
    const questions = [...form.querySelectorAll("[data-qb]")].map((b, n) => {
      const opts = [...b.querySelectorAll('[name="o"]')].map((i, k) => ({ text: i.value.trim(), k })).filter((o) => o.text);
      const checked = Number(b.querySelector("input[type=radio]:checked")?.value ?? -1);
      const correct = opts.findIndex((o) => o.k === checked);
      if (correct < 0) throw new Error(`Вопрос ${n + 1}: правильный вариант пустой`);
      return { q: b.querySelector('[name="q"]').value, options: opts.map((o) => o.text), correct };
    });
    return ["quiz/create", { title: v("title"), reward: Number(v("reward") || 0), questions }];
  }

  /* ---------- Списки ---------- */
  function pollRow(p) {
    return `<article class="ix-arow glass">
      <div class="ix-arow-head">${badge(p.status)}<b>${esc(p.question)}</b><span class="ix-meta">${p.total} ${plural(p.total, ["голос", "голоса", "голосов"])} · ${esc(timeAgo(p.createdAt))}</span></div>
      <ul class="ix-opts">${p.options.map((o) => `<li><div class="ix-opt"><span class="ix-bar" style="--w:${o.percent}%"></span><span class="ix-opt-text">${esc(o.text)}</span><span class="ix-opt-num">${o.percent}%<small>${o.votes}</small></span></div></li>`).join("")}</ul>
      <div class="ix-arow-actions">
        ${p.status === "open" ? btn("Закрыть", `data-act="poll/update" data-id="${esc(p.id)}" data-action="close"`) : btn("Открыть снова", `data-act="poll/update" data-id="${esc(p.id)}" data-action="open"`)}
        ${btn("Удалить", `data-act="poll/update" data-id="${esc(p.id)}" data-action="delete" data-confirm="Удалить опрос «${esc(p.question)}»?"`, "btn-danger")}
      </div></article>`;
  }

  function giveawayRow(g) {
    const id = esc(g.id);
    return `<article class="ix-arow glass">
      <div class="ix-arow-head">${badge(g.status)}<b>${esc(g.title)}</b><span class="ix-meta">🎁 ${esc(g.prize)} · ${g.entries} ${plural(g.entries, ["участник", "участника", "участников"])}</span></div>
      ${g.winner ? `<div class="ix-winner"><div><small>Победитель</small><b>${esc(g.winner.nick)}</b></div></div>` : ""}
      <div class="ix-meta">sha256: <code class="ix-mono">${esc(g.seedHash)}</code></div>
      <div class="ix-arow-actions">
        ${g.status === "open" ? btn("Закрыть приём", `data-act="giveaway/update" data-id="${id}" data-action="close"`) : ""}
        ${g.status === "closed" ? btn("Открыть приём", `data-act="giveaway/update" data-id="${id}" data-action="open"`) : ""}
        ${g.status !== "drawn" ? btn("🎲 Разыграть", `data-act="giveaway/update" data-id="${id}" data-action="draw" data-confirm="Разыграть «${esc(g.title)}» среди ${g.entries} участников? Приём закроется."`, "btn-primary") : ""}
        ${btn("Удалить", `data-act="giveaway/update" data-id="${id}" data-action="delete" data-confirm="Удалить розыгрыш «${esc(g.title)}»?"`, "btn-danger")}
      </div></article>`;
  }

  function bingoRow(r) {
    const id = esc(r.id);
    const on = new Set(r.marked);
    const open = r.status === "open";
    return `<article class="ix-arow glass">
      <div class="ix-arow-head">${badge(r.status)}<b>${esc(r.title)}</b><span class="ix-meta">${r.marked.length}/${r.items.length} отмечено · награда ${r.reward}</span></div>
      ${open ? `<p class="ix-note">Нажимай на событие, когда оно случилось на стриме (повторное нажатие — отмена).</p>` : ""}
      <div class="ix-marks">${r.items.map((t, i) => open
        ? `<button class="ix-mark" type="button" data-mark="${id}" data-idx="${i}" aria-pressed="${on.has(i)}">${esc(t)}</button>`
        : `<span class="ix-mark" aria-pressed="${on.has(i)}">${esc(t)}</span>`).join("")}</div>
      ${r.claims.length ? `<ol class="ix-winners">${r.claims.map((c) => `<li><span class="ix-place">${c.place}</span><b>${esc(c.user.nick)}</b><span class="ix-prize">+${c.prize}</span></li>`).join("")}</ol>` : '<p class="ix-note">Бинго ещё никто не собрал.</p>'}
      <div class="ix-arow-actions">
        ${btn("Обновить", "data-reload")}
        ${open ? btn("Завершить раунд", `data-act="bingo/update" data-id="${id}" data-action="close" data-confirm="Завершить раунд «${esc(r.title)}»?"`) : ""}
        ${btn("Удалить", `data-act="bingo/update" data-id="${id}" data-action="delete" data-confirm="Удалить раунд «${esc(r.title)}» вместе с победителями?"`, "btn-danger")}
      </div></article>`;
  }

  function quizRow(q) {
    const id = esc(q.id);
    return `<article class="ix-arow glass">
      <div class="ix-arow-head">${badge(q.status)}<b>${esc(q.title)}</b><span class="ix-meta">${q.questions.length} ${plural(q.questions.length, ["вопрос", "вопроса", "вопросов"])} · ${q.reward} за ответ · ${q.answers} ${plural(q.answers, ["участник", "участника", "участников"])}</span></div>
      <details><summary class="ix-note">Вопросы и ответы</summary>
        <ol class="ix-review">${q.questions.map((x) => `<li><b>${esc(x.q)}</b><div class="ix-ans">${x.options.map((o, k) => `<span class="${k === x.correct ? "is-correct" : ""}">${esc(o)}</span>`).join("")}</div></li>`).join("")}</ol>
      </details>
      <div class="ix-arow-actions">
        ${q.status === "draft" ? btn("▶ Открыть", `data-act="quiz/update" data-id="${id}" data-action="open"`, "btn-primary") : ""}
        ${q.status === "open" ? btn("Закрыть и показать ответы", `data-act="quiz/update" data-id="${id}" data-action="close" data-confirm="Закрыть квиз «${esc(q.title)}»? Ответы станут видны всем."`) : ""}
        ${btn("Удалить", `data-act="quiz/update" data-id="${id}" data-action="delete" data-confirm="Удалить квиз «${esc(q.title)}» и все ответы?"`, "btn-danger")}
      </div></article>`;
  }

  function tierRow(l) {
    const id = esc(l.id);
    const top = l.items.map((it, i) => ({ it, c: l.community[i] })).filter((x) => x.c).sort((a, b) => b.c.avg - a.c.avg).slice(0, 5);
    return `<article class="ix-arow glass">
      <div class="ix-arow-head">${badge(l.status)}<b>${esc(l.title)}</b><span class="ix-meta">${l.items.length} предметов · ${l.votes} ${plural(l.votes, ["голос", "голоса", "голосов"])}</span></div>
      ${top.length ? `<div class="ix-meta">Топ: ${top.map((x) => `<span class="badge plain">${esc(x.c.tier)} · ${x.it.emoji ? esc(x.it.emoji) + " " : ""}${esc(x.it.text)}</span>`).join("")}</div>` : ""}
      <div class="ix-arow-actions">
        ${l.status === "open" ? btn("Закрыть", `data-act="tierlist/update" data-id="${id}" data-action="close"`) : btn("Открыть снова", `data-act="tierlist/update" data-id="${id}" data-action="open"`)}
        ${btn("Удалить", `data-act="tierlist/update" data-id="${id}" data-action="delete" data-confirm="Удалить тир-лист «${esc(l.title)}» и все голоса?"`, "btn-danger")}
      </div></article>`;
  }

  function renderList() {
    const box = root.querySelector("[data-list]");
    if (!box) return;
    if (!data) { box.innerHTML = '<div class="skeleton"></div>'; return; }
    const map = { polls: [data.polls, pollRow], giveaways: [data.giveaways, giveawayRow], bingo: [data.bingo, bingoRow], quiz: [data.quizzes, quizRow], tierlists: [data.tierlists, tierRow] };
    const [list, row] = map[tab];
    box.innerHTML = list.length ? list.map(row).join("") : '<p class="ix-note">Пока пусто — создай первый.</p>';
  }

  async function reload() {
    try {
      data = await apiCall("interactive/admin");
      renderList();
    } catch (err) {
      const box = root.querySelector("[data-list]");
      if (box) box.innerHTML = `<p class="ix-note">${esc(err.message)}</p>`;
    }
  }

  /* ---------- События ---------- */
  async function onClick(e) {
    const sec = e.target.closest("[data-sec]");
    if (sec) return setTab(sec.dataset.sec);
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast("Ссылка скопирована — вставь её в OBS");
      } catch {
        toast("Не удалось скопировать — открой ссылку и скопируй из адресной строки", "error");
      }
      return;
    }
    if (e.target.closest("[data-reload]")) return reload();
    const form = e.target.closest("form");
    if (e.target.closest("[data-qadd]") && form) {
      const n = form.querySelectorAll("[data-qb]").length;
      if (n >= 15) return toast("Не больше 15 вопросов", "error");
      form.querySelector("[data-qlist]").insertAdjacentHTML("beforeend", questionBlock(n + 1));
      form.querySelector("[data-qb]:last-child input[name='q']")?.focus();
      return;
    }
    if (e.target.closest("[data-qdel]") && form) {
      if (form.querySelectorAll("[data-qb]").length <= 3) return toast("Нужно минимум 3 вопроса", "error");
      e.target.closest("[data-qb]").remove();
      renumber(form);
      return;
    }
    const mark = e.target.closest("[data-mark]");
    if (mark) {
      const on = mark.getAttribute("aria-pressed") !== "true";
      mark.setAttribute("aria-pressed", String(on)); // сразу, без ожидания сервера
      try {
        const r = await apiCall("bingo/mark", { method: "POST", body: { id: mark.dataset.mark, index: Number(mark.dataset.idx), on } });
        data.bingo = data.bingo.map((x) => (x.id === r.id ? r : x));
        const head = mark.closest(".ix-arow")?.querySelector(".ix-arow-head .ix-meta");
        if (head) head.textContent = `${r.marked.length}/${r.items.length} отмечено · награда ${r.reward}`;
      } catch (err) {
        mark.setAttribute("aria-pressed", String(!on));
        toast(err.message, "error");
      }
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.confirm && !confirm(act.dataset.confirm)) return;
      act.disabled = true;
      try {
        const r = await apiCall(act.dataset.act, { method: "POST", body: { id: act.dataset.id, action: act.dataset.action } });
        if (act.dataset.action === "draw" && r?.winner) toast(`Победитель: ${r.winner.nick} 🎉`);
        else toast("Готово");
        await reload();
      } catch (err) {
        toast(err.message, "error");
        act.disabled = false;
      }
    }
  }

  async function onSubmit(e) {
    const form = e.target.closest("form[data-create]");
    if (!form) return;
    e.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    let route, body;
    try {
      [route, body] = collect(form);
    } catch (err) {
      return toast(err.message, "error");
    }
    submit.disabled = true;
    try {
      await apiCall(route, { method: "POST", body });
      toast(form.dataset.create === "quiz" ? "Черновик сохранён — открой его кнопкой «Открыть»" : "Создано ✔");
      renderForm();
      await reload();
    } catch (err) {
      toast(err.message, "error");
      submit.disabled = false;
    }
  }

  function onInput(e) {
    const ta = e.target.closest("textarea[name='items']");
    const c = ta?.form?.querySelector("[data-count]");
    if (!c) return;
    const n = lines(ta.value).length;
    const bingo = ta.form.dataset.create === "bingo";
    c.textContent = bingo ? `${n} / 24` : `${n} / 4–30`;
    c.classList.toggle("ok", bingo ? n >= 24 && n <= 75 : n >= 4 && n <= 30);
  }

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);
  shell();
  reload();
  // ключ оверлеев (общий для всех виджетов пульта) — наши оверлеи без него тоже работают
  api.stream?.().then((s) => {
    if (s?.overlayKey && s.overlayKey !== overlayKey) {
      overlayKey = s.overlayKey;
      if (root.querySelector("[data-ov]")) renderOverlays();
    }
  }).catch(() => {});
  return {
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("input", onInput);
      root.classList.remove("ix", "ix-admin");
    },
  };
}
