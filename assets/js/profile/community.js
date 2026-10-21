// Кабинет → «Настройки»: ссылка на свой публичный профиль и прогресс квеста «Найди 5 пауков».
import { esc, toast } from "../core/util.js";
import { ensureCss } from "../modules.js";
import { QUEST_EGGS, QUEST_HINTS, questFound } from "../core/quest.js";

ensureCss("community.css");

const SPIDER = "🕷";

export function mount(container, ctx = {}) {
  const user = ctx.profile?.user || ctx.user;
  if (!user) return { destroy() {} };
  let alive = true;
  const link = new URL(`user.html?u=${encodeURIComponent(user.nick)}`, location.href).href;

  container.innerHTML = `<div class="pf-card glass cm-pf-card">
      <h3><span aria-hidden="true">🌐</span> Публичный профиль</h3>
      <p class="muted">Страница, которую видят все: уровень, значки, галерея «идеальных» работ и темы на форуме. Email и Discord там не показываются.</p>
      <div class="cm-share">
        <input class="cm-share-input" type="text" readonly value="${esc(link)}" aria-label="Ссылка на публичный профиль">
        <button class="btn btn-ghost btn-sm" type="button" data-copy-link>Копировать</button>
      </div>
      <a class="btn btn-primary btn-sm" href="${esc(link)}">Открыть мой профиль →</a>
    </div>
    <div class="pf-card glass cm-pf-card" id="cmQuestCard">
      <h3><span aria-hidden="true">${SPIDER}</span> Найди 5 пауков</h3>
      <p class="muted">На сайте прячутся пять крошечных пауков. Поймай всех — получишь <b>300 баллов</b> и значок «Паучье чутьё».</p>
      <div class="cm-quest" aria-live="polite"><div class="skeleton cm-quest-skel"></div></div>
    </div>`;

  const box = container.querySelector(".cm-quest");

  function render(found) {
    if (!found) {
      box.innerHTML = `<p class="faint">Прогресс квеста работает на сайте ndze.fun.</p>`;
      return;
    }
    const n = QUEST_EGGS.filter((e) => found.includes(e)).length;
    const done = n >= QUEST_EGGS.length;
    box.innerHTML = `<div class="cm-quest-top">
        <b class="cm-quest-n">${n}<small>/${QUEST_EGGS.length}</small></b>
        <ol class="cm-quest-slots" aria-label="Пойманные пауки">
          ${QUEST_EGGS.map((e) => `<li class="${found.includes(e) ? "is-found" : ""}" title="${found.includes(e) ? "Пойман" : "Ещё прячется"}"><span aria-hidden="true">${found.includes(e) ? SPIDER : "?"}</span><span class="sr-only">${found.includes(e) ? "пойман" : "не найден"}</span></li>`).join("")}
        </ol>
      </div>
      ${done ? `<p class="cm-quest-done">Все пауки пойманы — паучье чутьё не подвело! ${SPIDER}</p>`
        : `<ul class="cm-quest-hints">${QUEST_EGGS.filter((e) => !found.includes(e)).map((e) => `<li>${esc(QUEST_HINTS[e])}</li>`).join("")}</ul>`}`;
  }

  const onClick = async (e) => {
    if (!e.target.closest("[data-copy-link]")) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Ссылка на профиль скопирована");
    } catch {
      container.querySelector(".cm-share-input")?.select();
    }
  };
  container.addEventListener("click", onClick);

  questFound(user.id).then((f) => { if (alive) render(f); });

  return {
    destroy() {
      alive = false;
      container.removeEventListener("click", onClick);
    },
  };
}
