// Главная → «Сейчас на канале»: «Клип недели» — лучший клип зрителей за 7 дней (плеер грузится по клику).
import { apiCall } from "../data/api.js";
import { esc, avatarHTML } from "../core/util.js";
import { ensureCss } from "../modules.js";
import { posterHTML, playClip, userUrl, votesLabel } from "../play/clips.js";

ensureCss("community.css");

export function mount(container) {
  let alive = true;
  container.innerHTML = '<article class="card glass cm-home"><div class="skeleton cm-home-skel"></div></article>';

  function render({ clip, fallback }) {
    if (!clip) {
      container.innerHTML = `<article class="card glass cm-home">
        <p class="cm-kicker">🎬 Клип недели</p>
        <h3 class="cm-home-title">Нарежь лучший момент</h3>
        <p class="muted">Сделай клип на стриме и пришли ссылку — зрители проголосуют, а лучший клип недели окажется здесь.</p>
        <a class="cc-go" href="play.html#clips">Предложить клип →</a>
      </article>`;
      return;
    }
    container.innerHTML = `<article class="card glass cm-home">
      <p class="cm-kicker">${fallback ? "🎬 Лучший клип" : "👑 Клип недели"}</p>
      ${posterHTML(clip)}
      <h3 class="cm-home-title">${esc(clip.title)}</h3>
      <p class="cm-clip-meta"><a class="cm-user" href="${esc(userUrl(clip.author.nick))}">${avatarHTML(clip.author.nick, clip.author.avatarUrl, { size: "xs" })}${esc(clip.author.nick)}</a>
        <span class="faint">· ${clip.votes} ${votesLabel(clip.votes)}</span></p>
      <a class="cc-go" href="play.html#clips">Все клипы и голосование →</a>
    </article>`;
  }

  const onClick = (e) => {
    const play = e.target.closest("[data-play]");
    if (play) playClip(play, container);
  };
  container.addEventListener("click", onClick);

  apiCall("clips/week")
    .then((d) => { if (alive) render(d); })
    .catch(() => { if (alive) container.innerHTML = ""; }); // нет API (демо) — блок просто не показываем

  return {
    destroy() {
      alive = false;
      container.removeEventListener("click", onClick);
    },
  };
}
