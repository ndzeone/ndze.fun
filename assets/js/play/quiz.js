// Вкладка «Квиз» (play.html#quiz): еженедельный квиз — по одному вопросу, пиксельный таймер 20 с,
// одна попытка. Правильные ответы и таблица лидеров — после закрытия квиза.
import { apiCall } from "../data/api.js";
import { ensureCss } from "../modules.js";
import { esc, toast, plural, avatarHTML } from "../core/util.js";

ensureCss("interactive.css");

const Q_SEC = 20;
const KEYS = ["A", "B", "C", "D"];
const fmtMs = (ms) => `${(ms / 1000).toFixed(1)} с`;

export function mount(root, ctx) {
  const user = ctx.user || null;
  let data = null;   // { open, results }
  let play = null;   // { quiz, i, answers, ms, qStart, tick, locked }
  let done = null;   // ответ quiz/answer
  let alive = true;
  root.classList.add("ix", "ix-quiz");

  /* ---------- Экраны ---------- */
  function heroHTML() {
    return `<header class="ix-hero glass">
      <span class="ix-hero-icon ix-px" aria-hidden="true">🧠</span>
      <div class="ix-hero-text"><h2>Квиз недели</h2>
        <p>Вопросы по стримам, играм и паучьей вселенной. ${Q_SEC} секунд на вопрос, одна попытка, баллы — за каждый верный ответ. При равных очках выше тот, кто быстрее.</p></div>
    </header>`;
  }

  function openHTML(q) {
    if (!q) return `<div class="empty"><span class="empty-icon">🧠</span><p>Новый квиз ещё готовится — обычно он выходит раз в неделю.</p></div>`;
    let action;
    if (!user) {
      action = `<div class="ix-login"><p>Войди, чтобы пройти квиз и получить баллы.</p>
        <button class="ix-pbtn ix-px is-sm" type="button" data-open-auth="login" data-reason="Войди, чтобы пройти квиз">Войти</button></div>`;
    } else if (q.mine) {
      action = `<div class="ix-score"><small>Твой результат</small><b>${q.mine.score}/${q.mine.total}</b>
        <small>за ${fmtMs(q.mine.ms)} · правильные ответы покажем после закрытия квиза</small></div>`;
    } else {
      action = `<button class="ix-pbtn ix-px" type="button" data-start style="justify-self:start;font-size:1.2rem;padding:14px 26px">▶ Начать</button>
        <p class="ix-note">Начнёшь — таймер пойдёт сразу. Переключаться можно клавишами 1–4.</p>`;
    }
    return `<div class="ix-quiz-stage glass">
      <div class="ix-meta"><span class="badge lime">Идёт</span><span>${q.questions.length} ${plural(q.questions.length, ["вопрос", "вопроса", "вопросов"])}</span>
        <span>· ${q.reward} ${plural(q.reward, ["балл", "балла", "баллов"])} за верный ответ</span><span>· ${q.players} ${plural(q.players, ["участник", "участника", "участников"])}</span></div>
      <h3 class="ix-question">${esc(q.title)}</h3>
      ${action}
    </div>`;
  }

  function resultsHTML(r) {
    if (!r) return "";
    const me = user?.id;
    const lb = r.leaderboard.length
      ? `<ol class="ix-lb">${r.leaderboard.map((x) => `<li class="${x.user.id === me ? "is-me" : ""}">
          <span class="ix-place">${x.place <= 3 ? ["🥇", "🥈", "🥉"][x.place - 1] : x.place}</span>
          ${avatarHTML(x.user.nick, x.user.avatarUrl, { size: "xs" })}<b>${esc(x.user.nick)}</b>
          <small><em>${x.score}</em>${fmtMs(x.ms)}</small></li>`).join("")}</ol>`
      : `<p class="ix-note">Никто не успел поучаствовать.</p>`;
    const mine = r.mine?.answers || null;
    const review = `<ol class="ix-review">${r.questions.map((q, i) => {
      const my = mine ? mine[i] : null;
      const cls = mine ? (my === q.correct ? "ok" : "bad") : "";
      return `<li class="${cls}"><b>${esc(q.q)}</b><div class="ix-ans">${q.options.map((o, k) =>
        `<span class="${k === q.correct ? "is-correct" : k === my ? "is-wrong" : ""}">${esc(o)}</span>`).join("")}
        ${mine && my === -1 ? '<span class="is-wrong">⏰ время вышло</span>' : ""}</div></li>`;
    }).join("")}</ol>`;
    return `<div class="ix-cols">
      <div class="ix-card glass"><h3>Ответы: «${esc(r.title)}»</h3>
        ${r.mine ? `<p class="muted">Твой результат: <b style="color:var(--lime)">${r.mine.score}/${r.mine.total}</b> за ${fmtMs(r.mine.ms)}</p>` : ""}
        ${review}</div>
      <div class="ix-card glass"><h3>🏆 Лидеры</h3><p class="ix-note">${r.players} ${plural(r.players, ["участник", "участника", "участников"])}</p>${lb}</div>
    </div>`;
  }

  function renderHome() {
    root.innerHTML = `${heroHTML()}${openHTML(data.open)}${data.results ? `<h3 class="ix-sub">Итоги прошлого квиза</h3>${resultsHTML(data.results)}` : ""}`;
  }

  function timerHTML(left) {
    const on = Math.ceil((left / (Q_SEC * 1000)) * 20);
    return Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? "" : "off"}"></i>`).join("");
  }

  function renderQuestion() {
    const { quiz, i } = play;
    const q = quiz.questions[i];
    root.innerHTML = `<div class="ix-quiz-stage glass" aria-live="polite">
      <div class="ix-quiz-top"><span>Вопрос ${i + 1}/${quiz.questions.length}</span><span data-sec>${Q_SEC} с</span></div>
      <div class="ix-timer" data-timer aria-hidden="true">${timerHTML(Q_SEC * 1000)}</div>
      <h3 class="ix-question" tabindex="-1">${esc(q.q)}</h3>
      <div class="ix-qopts">${q.options.map((o, k) => `<button class="ix-qopt ix-px" type="button" data-answer="${k}">
        <span class="ix-qkey" aria-hidden="true">${KEYS[k]}</span><span>${esc(o)}</span></button>`).join("")}</div>
    </div>`;
    root.querySelector(".ix-question").focus({ preventScroll: true });
    play.qStart = performance.now();
    play.locked = false;
    clearInterval(play.tick);
    play.tick = setInterval(onTick, 200);
  }

  function onTick() {
    if (!play || play.locked) return;
    const left = Math.max(0, Q_SEC * 1000 - (performance.now() - play.qStart));
    const t = root.querySelector("[data-timer]");
    if (t) {
      t.innerHTML = timerHTML(left);
      t.classList.toggle("is-low", left < 5000);
    }
    const s = root.querySelector("[data-sec]");
    if (s) s.textContent = `${Math.ceil(left / 1000)} с`;
    if (left <= 0) answer(-1);
  }

  async function answer(k) {
    if (!play || play.locked) return;
    play.locked = true;
    clearInterval(play.tick);
    play.ms += Math.min(Q_SEC * 1000, Math.round(performance.now() - play.qStart));
    play.answers.push(k);
    root.querySelectorAll("[data-answer]").forEach((b) => {
      b.disabled = true;
      if (Number(b.dataset.answer) === k) b.classList.add("is-picked");
    });
    await new Promise((r) => setTimeout(r, k === -1 ? 700 : 380));
    if (!alive || !play) return;
    if (play.answers.length < play.quiz.questions.length) {
      play.i++;
      renderQuestion();
    } else {
      submit();
    }
  }

  async function submit() {
    const { quiz, answers, ms } = play;
    root.innerHTML = `<div class="ix-quiz-stage glass"><div class="ix-score"><small>Считаем ответы…</small><span class="spinner light"></span></div></div>`;
    try {
      done = await apiCall("quiz/answer", { method: "POST", body: { quizId: quiz.id, answers, ms } });
      play = null;
      root.innerHTML = `${heroHTML()}<div class="ix-quiz-stage glass">
        <div class="ix-score"><small>Верных ответов</small><b>${done.score}/${done.total}</b>
          <small>${done.points ? `+${done.points} баллов на счёт 🎉` : "В этот раз без баллов — в следующий повезёт!"} · время ${fmtMs(done.ms)}</small></div>
        <p class="ix-note" style="text-align:center">Правильные ответы и таблица лидеров появятся, когда квиз закроется.</p>
        <button class="ix-pbtn ix-px is-ghost is-sm" type="button" data-home style="justify-self:center">К квизу</button>
      </div>`;
    } catch (err) {
      play = null;
      toast(err.message, "error");
      await load();
    }
  }

  async function load() {
    try {
      data = await apiCall("quiz");
      if (alive && !play) renderHome();
    } catch (err) {
      root.innerHTML = `<div class="empty"><span class="empty-icon">🕸</span><p>${esc(err.message)}</p></div>`;
    }
  }

  function onClick(e) {
    if (e.target.closest("[data-start]") && data?.open) {
      play = { quiz: data.open, i: 0, answers: [], ms: 0, qStart: 0, tick: 0, locked: false };
      renderQuestion();
      return;
    }
    if (e.target.closest("[data-home]")) return load();
    const a = e.target.closest("[data-answer]");
    if (a && play) answer(Number(a.dataset.answer));
  }

  function onKey(e) {
    if (!play || play.locked || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = Number(e.key) - 1;
    if (k >= 0 && k < play.quiz.questions[play.i].options.length) {
      e.preventDefault();
      answer(k);
    }
  }

  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  root.innerHTML = '<div class="skeleton" style="min-height:360px"></div>';
  load();
  return {
    destroy() {
      alive = false;
      if (play) clearInterval(play.tick);
      play = null;
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    },
  };
}
