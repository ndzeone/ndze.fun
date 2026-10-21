// Service worker сайта ndze.fun: только браузерные push-уведомления (без офлайн-кэша).
// Push приходит ПУСТЫМ (без шифрованного содержимого) — текст берём с сервера: api/index.php?r=push/latest.
// Лежит в корне сайта, чтобы область действия (scope) была весь сайт.
const SCOPE = self.registration.scope; // https://ndze.fun/
const LATEST = new URL("api/index.php?r=push/latest", SCOPE).href;
const ICON = new URL("assets/img/favicon.svg", SCOPE).href;
const FALLBACK = { title: "ndze", body: "Загляни на сайт 🕷", url: SCOPE, tag: "ndze" };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/** Только http(s)-ссылки; относительные — от корня сайта. */
function safeUrl(u) {
  try {
    const url = new URL(String(u || ""), SCOPE);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : SCOPE;
  } catch {
    return SCOPE;
  }
}

async function latest(e) {
  // если когда-нибудь придёт push с JSON — используем его, иначе спрашиваем сервер
  try {
    const d = e.data?.json();
    if (d?.title) return d;
  } catch { /* пустой push */ }
  try {
    const res = await fetch(LATEST, { credentials: "omit", cache: "no-store", headers: { Accept: "application/json" } });
    const j = await res.json();
    if (j?.ok && j.data?.title) return j.data;
  } catch { /* сеть пропала — покажем запасной текст */ }
  return FALLBACK;
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    const d = await latest(e);
    await self.registration.showNotification(String(d.title).slice(0, 120), {
      body: String(d.body || "").slice(0, 240),
      icon: ICON,
      badge: ICON,
      tag: String(d.tag || "ndze"),
      renotify: true,
      data: { url: safeUrl(d.url) },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = safeUrl(e.notification.data?.url);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = wins.find((w) => w.url === url);
    if (same) return same.focus();
    return self.clients.openWindow(url);
  })());
});
