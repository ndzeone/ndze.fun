// Безопасный Markdown для форума: marked (GFM) → DOMPurify. Библиотеки с cdnjs, точные версии + SRI
// (те же, что на странице репозитория). Если CDN недоступен — показываем текст как есть.
const LIBS = {
  marked: {
    global: "marked",
    src: "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
    integrity: "sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi",
  },
  purify: {
    global: "DOMPurify",
    src: "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js",
    integrity: "sha384-+VfUPEb0PdtChMwmBcBmykRMDd+v6D/oFmB3rZM/puCMDYcIvF968OimRh4KQY9a",
  },
};
const loading = new Map();

function loadLib(key) {
  if (!loading.has(key)) {
    const lib = LIBS[key];
    const p = new Promise((resolve, reject) => {
      if (window[lib.global]) return resolve(window[lib.global]);
      const s = document.createElement("script");
      s.src = lib.src;
      s.integrity = lib.integrity;
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.async = true;
      s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error(`${key} не загрузился`)));
      s.onerror = () => { s.remove(); reject(new Error(`${key} не загрузился`)); };
      document.head.append(s);
    });
    p.catch(() => loading.delete(key));
    loading.set(key, p);
  }
  return loading.get(key);
}

/** Заранее подгрузить библиотеки (например, при открытии формы с предпросмотром). */
export const preloadMarkdown = () => Promise.all([loadLib("marked"), loadLib("purify")]).catch(() => null);

/**
 * Отрисовать Markdown в элемент. images: false — картинки превращаются в ссылки
 * (у зрителей: чужие картинки светили бы IP читателей стороннему серверу).
 */
export async function renderMarkdown(target, text, { images = false } = {}) {
  let marked;
  let purify;
  try {
    [marked, purify] = await Promise.all([loadLib("marked"), loadLib("purify")]);
  } catch {
    target.classList.add("md-plain");
    target.textContent = text;
    return;
  }
  const html = marked.parse(String(text ?? ""), { gfm: true, breaks: true, async: false });
  const frag = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "input", "iframe", "object", "embed", "video", "audio", "source", "svg", "math"],
    FORBID_ATTR: ["style", "class", "id"],
  });
  for (const a of frag.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (!/^(https?:|mailto:|#|\/)/i.test(href)) { a.removeAttribute("href"); continue; }
    if (/^https?:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener nofollow ugc";
    }
  }
  for (const img of frag.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (!images || !/^https:\/\//i.test(src)) {
      const a = document.createElement("a");
      a.textContent = `🖼 ${img.getAttribute("alt") || "картинка"}`;
      if (/^https:\/\//i.test(src)) { a.href = src; a.target = "_blank"; a.rel = "noopener nofollow ugc"; }
      img.replaceWith(a);
    } else {
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
    }
  }
  target.classList.remove("md-plain");
  target.replaceChildren(frag);
}
