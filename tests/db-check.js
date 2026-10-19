// Живая проверка онлайн-базы (Supabase): права RLS, триггеры, хранилище картинок.
// Открывать: http://localhost:8000/tests/db-check.html  (папка tests/ на хостинг не выкладывается).
//
// Работает только с ПУБЛИЧНЫМ anon-ключом из assets/js/config.js — так же, как сайт.
// Ключ service_role не нужен, не запрашивается и не принимается (страница откажется работать).
//
// Что делает: регистрирует тестовых пользователей A и B (dbcheck+…), от имени A через настоящий
// api (assets/js/data/api.js) создаёт работу с картинкой и задание, а потом напрямую через
// supabase-js пытается обойти права: A — повысить себе роль/оценку, B — прочитать и испортить
// чужое. В конце удаляет созданные работы и задания. Сами тестовые аккаунты без service_role
// удалить нельзя — их список выводится в итоге (удалить в Authentication → Users).
import { SITE } from "../assets/js/config.js";
import { LIMITS } from "../assets/js/data/constants.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
const BUCKET = "submissions";
const $ = (s) => document.querySelector(s);

const url = String(SITE.supabase?.url ?? "").trim().replace(/\/+$/, "");
const key = String(SITE.supabase?.anonKey ?? "").trim();

/* ───────────────────────── Ключи: можно ли вообще запускать ───────────────────────── */
function keyProblem() {
  if (!url || !key) {
    return "В assets/js/config.js не заполнены supabase.url и supabase.anonKey — сайт в демо-режиме, проверять нечего. " +
      "Сначала подключи базу по SUPABASE.md (шаги 1–4), потом открой эту страницу снова.";
  }
  if (!/^https:\/\/[^/]+$/i.test(url)) return `supabase.url выглядит странно: «${url}». Нужен адрес вида https://abcdefghijk.supabase.co`;
  if (/^sb_secret_/i.test(key)) return "В config.js вставлен СЕКРЕТНЫЙ ключ (sb_secret_…). Немедленно замени его на anon public — секретный ключ нельзя держать на сайте.";
  const parts = key.split(".");
  if (parts.length === 3) {
    let role = "";
    try { role = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role; } catch { return "anonKey не похож на ключ Supabase (не читается)."; }
    if (role === "service_role") return "В config.js вставлен ключ service_role! Немедленно замени его на anon public и смени ключи в Supabase (Project Settings → API Keys).";
    if (role && role !== "anon") return `anonKey имеет роль «${role}», а нужен ключ anon public.`;
  } else if (!/^sb_publishable_/i.test(key)) {
    return "anonKey не похож на ключ Supabase. Нужен ключ anon public (eyJ…) или sb_publishable_…";
  }
  return "";
}

/* ───────────────────────── Таблица результатов ───────────────────────── */
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
class Stop extends Error {}

function section(title) {
  const tr = document.createElement("tr");
  tr.className = "sec";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = title;
  tr.append(td);
  $("#rows").append(tr);
}

function addRow(name) {
  const tr = document.createElement("tr");
  const n = document.createElement("td");
  const nm = document.createElement("td");
  const st = document.createElement("td");
  const det = document.createElement("td");
  n.textContent = String($("#rows").querySelectorAll("tr:not(.sec)").length + 1);
  nm.textContent = name;
  st.innerHTML = `<span class="pill run">…</span>`;
  tr.append(n, nm, st, det);
  $("#rows").append(tr);
  tr.scrollIntoView({ block: "nearest" });
  return (status, detail = "") => {
    counts[status]++;
    st.firstChild.className = `pill ${status.toLowerCase()}`;
    st.firstChild.textContent = status;
    det.textContent = detail;
    tr.className = status.toLowerCase();
    updateSummary();
  };
}

const SKIP = (why) => ({ skip: why });

/** Одна проверка. fn возвращает строку-подробность, SKIP(...) или бросает ошибку (FAIL). */
async function t(name, fn) {
  const done = addRow(name);
  try {
    const out = await fn();
    if (out && out.skip) { done("SKIP", out.skip); return false; }
    done("PASS", typeof out === "string" ? out : "");
    return true;
  } catch (e) {
    done("FAIL", e?.message || String(e));
    return false;
  }
}
/** Проверка, без которой дальше идти бессмысленно. */
async function gate(name, fn) {
  if (!(await t(name, fn))) throw new Stop(name);
}
function skipRow(name, why) { addRow(name)("SKIP", why); }

function updateSummary() {
  $("#summary").innerHTML = "";
  for (const [k, v] of Object.entries(counts)) {
    const s = document.createElement("span");
    s.className = `pill ${k.toLowerCase()}`;
    s.textContent = `${k}: ${v}`;
    $("#summary").append(s);
  }
}
function note(html, tone = "info") {
  const div = document.createElement("div");
  div.className = `note ${tone}`;
  div.innerHTML = html;
  $("#notes").append(div);
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ───────────────────────── Помощники проверок ───────────────────────── */
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const errText = (e) => (e ? [e.code || e.statusCode || e.status, e.message || e.error_description || e.error].filter(Boolean).join(" ") : "");

/** { data, error } → data, иначе FAIL. */
async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(errText(error) || "ошибка");
  return data;
}

/** Ожидаем запрет: ошибка или 0 строк. Если операция прошла — FAIL (и onLeak для уборки). */
async function denied(p, onLeak) {
  const { data, error } = await p;
  if (error) return `отказ: ${errText(error)}`;
  if (data == null || (Array.isArray(data) && data.length === 0)) return "0 строк — отфильтровано RLS";
  if (onLeak) { try { await onLeak(data); } catch { /* уборка — по возможности */ } }
  throw new Error(`ОПЕРАЦИЯ ПРОШЛА: ${JSON.stringify(data).slice(0, 200)}`);
}

/** Ожидаем ApiError с кодом code от настоящего api. */
async function apiFails(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (e?.code === code) return `ApiError «${code}»: ${e.message}`;
    throw new Error(`ждали ApiError «${code}», получили «${e?.code || ""}» ${e?.message || e}`);
  }
  throw new Error(`ждали ApiError «${code}», а вызов прошёл`);
}

async function makePng(label) {
  const c = document.createElement("canvas");
  c.width = 120; c.height = 80;
  const g = c.getContext("2d");
  g.fillStyle = "#b6ff3b"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#0f0f0f"; g.font = "bold 18px sans-serif"; g.fillText(label, 10, 46);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("canvas.toBlob"))), "image/png"));
  return new File([blob], `dbcheck-${label}.png`, { type: "image/png" });
}

/* ───────────────────────── Сам прогон ───────────────────────── */
async function run({ emailTpl, adminEmail, adminPassword, discordNicks }) {
  const { createClient } = await import(SUPABASE_JS);
  // Отдельные клиенты без сохранения сессии — не трогают вход на сайте и друг друга.
  const mk = (tag) => createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `dbcheck-${tag}` },
  });
  const anon = mk("anon");
  const cA = mk("a");
  const cB = mk("b");
  const cAdm = adminEmail ? mk("admin") : null;

  const ts = Date.now().toString(36);
  const password = `Db-${crypto.randomUUID()}`;
  const email = (id) => emailTpl.replace("{id}", `${ts}${id}`).toLowerCase();
  const A = { email: email("a"), nick: `dbA_${ts}` };
  const B = { email: email("b"), nick: `dbB_${ts}` };
  const created = { subs: new Set(), tasks: new Set(), users: [] };
  let api = null;
  let sub = null; // Submission (из api)
  let imgPath = "";
  let task = null; // Task (из api)
  let adminOk = false;

  try {
    /* ---------- 0. Подключение ---------- */
    section("0. Подключение");
    await gate("Ключ публичный (anon / publishable), не service_role", async () => `${url} · ключ ${key.slice(0, 12)}…`);
    await gate("Настоящий api сайта подключён к Supabase", async () => {
      ({ api } = await import("../assets/js/data/api.js"));
      ok(api.mode === "supabase", `api.mode = «${api.mode}», ждали «supabase»`);
      await api.signOut().catch(() => {});
      return "api.mode = supabase; вход на сайте (localhost) сброшен";
    });
    await gate("Схема на месте: таблица tasks и view tasks_feed отвечают", async () => {
      const { error } = await anon.from("tasks_feed").select("id").limit(1);
      if (error && /fetch|network/i.test(errText(error))) {
        throw new Error(`${errText(error)} — нет связи с проектом: проверь supabase.url, интернет и что проект не на паузе`);
      }
      if (error) throw new Error(`${errText(error)} — похоже, schema.sql не запускался (SUPABASE.md, шаг 2)`);
      return "ok";
    });

    /* ---------- 1. Гость (без входа) ---------- */
    section("1. Гость (без входа)");
    await t("Гость читает ленту заданий (tasks_feed)", async () => {
      const rows = await must(anon.from("tasks_feed").select("id, votes, my_vote").limit(20));
      ok(rows.every((r) => r.my_vote === false), "у гостя my_vote = true?!");
      return `строк: ${rows.length}`;
    });
    await t("Гость не видит неопубликованные работы (только ideal)", async () => {
      const rows = await must(anon.from("submissions").select("id, status").neq("status", "ideal").limit(5));
      ok(rows.length === 0, `видно ${rows.length} чужих работ не из галереи`);
      return "0 строк";
    });
    await t("Гость не читает admin_emails", () => denied(anon.from("admin_emails").select("email").limit(1)));
    await t("Гость не создаёт задание", () => denied(
      anon.from("tasks").insert({ game: "minecraft", title: "anon task", difficulty: 1 }).select("id"),
      (rows) => rows.forEach((r) => created.tasks.add(r.id))));
    await t("Гостю запрещён admin_stats", () => denied(anon.rpc("admin_stats")));
    await t("Гостю закрыта служебная role_for", () => denied(anon.rpc("role_for", { p_email: "x@example.com", p_confirmed_at: new Date().toISOString() })));
    await t("nick_available работает без входа", async () => {
      const v = await must(anon.rpc("nick_available", { p_nick: A.nick }));
      ok(v === true, `ждали true, получили ${JSON.stringify(v)}`);
      return "true";
    });

    /* ---------- 2. Аккаунты ---------- */
    section("2. Регистрация тестовых пользователей");
    await gate(`A регистрируется через api.signUp (${A.email})`, async () => {
      let u;
      try {
        u = await api.signUp({ nick: A.nick, email: A.email, password });
      } catch (e) {
        if (e?.code === "auth_required") {
          created.users.push(`${A.email} (не подтверждён)`);
          note(`<b>Включено подтверждение email</b> — тестовые пользователи не могут войти без письма, проверка остановлена.<br>
            На время проверки выключи <b>Authentication → Sign In / Providers → Email → Confirm email</b>, запусти проверку снова,
            потом включи обратно. Неподтверждённого пользователя <code>${escHtml(A.email)}</code> удали в <b>Authentication → Users</b>.`, "warn");
        } else if (e?.fields?.email) {
          note(`Supabase не принял адрес <code>${escHtml(A.email)}</code>. Поменяй шаблон email вверху на настоящий домен,
            например <code>твой.адрес+dbcheck-{id}@gmail.com</code> (письма при выключенном Confirm email не отправляются).`, "warn");
        }
        throw e;
      }
      created.users.push(A.email);
      ok(u.nick === A.nick, `ник ${u.nick}`);
      ok(u.role === "user", `роль ${u.role}`);
      A.id = u.id;
      return `id ${u.id.slice(0, 8)}…, роль user`;
    });
    await gate("api.getUser() возвращает A (сессия сохранилась)", async () => {
      const u = await api.getUser();
      ok(u?.id === A.id, `getUser → ${JSON.stringify(u)}`);
      return u.nick;
    });
    await t("Ник уникален без учёта регистра: api.signUp с тем же ником → nick_taken", () =>
      apiFails(() => api.signUp({ nick: A.nick.toUpperCase(), email: email("x"), password }), "nick_taken"));
    await t("То же в базе: signUp в обход проверки сайта падает на уникальном индексе", async () => {
      const dupEmail = email("dup");
      const { data, error } = await mk("dup").auth.signUp({ email: dupEmail, password, options: { data: { nick: A.nick.toUpperCase() } } });
      if (error) return `отказ: ${errText(error)}`;
      if (data?.user) created.users.push(`${dupEmail} (создан по ошибке!)`);
      throw new Error("пользователь с занятым ником создан!");
    });
    await gate(`B регистрируется напрямую через supabase-js (${B.email})`, async () => {
      const d = await must(cB.auth.signUp({ email: B.email, password, options: { data: { nick: B.nick } } }));
      if (d.user) created.users.push(B.email);
      ok(d.session, "нет сессии — включено подтверждение email?");
      B.id = d.user.id;
      return `id ${B.id.slice(0, 8)}…`;
    });
    await t("Триггер создал профиль B: ник из формы, роль user", async () => {
      const p = await must(anon.from("profiles").select("nick, role").eq("id", B.id).single());
      ok(p.nick === B.nick && p.role === "user", JSON.stringify(p));
      return `${p.nick} / ${p.role}`;
    });
    await gate("A входит по паролю (signInWithPassword) в отдельном клиенте", async () => {
      const d = await must(cA.auth.signInWithPassword({ email: A.email, password }));
      ok(d.session?.user?.id === A.id, "чужая сессия?");
      return "ok";
    });

    if (discordNicks) {
      section("2b. Ник как у входа через Discord (без nick в метаданных)");
      const tail = ts.slice(-4);
      const name = `DbПаук ${tail}!!`;
      const cyr = `DbПаук_${tail}`;
      const lat = `Db_${tail}`;
      let first = "";
      for (const [i, id] of [["первый", "c"], ["второй, то же имя", "d"]]) {
        await t(`Ник из Discord-имени «${name}» — ${i} пользователь`, async () => {
          const em = email(id);
          const d = await must(mk(id).auth.signUp({
            email: em, password,
            options: { data: { custom_claims: { global_name: name }, full_name: "ignored_full", name: "ignored#0" } },
          }));
          if (d.user) created.users.push(em);
          ok(d.user?.id, "пользователь не создан");
          const p = await must(anon.from("profiles").select("nick, role").eq("id", d.user.id).single());
          ok(p.nick.length >= 3 && p.nick.length <= 20, `длина ника ${p.nick.length}`);
          ok(LIMITS.nick.re.test(p.nick), `ник «${p.nick}» не проходит проверку сайта (LIMITS.nick.re)`);
          if (!first) {
            first = p.nick;
            if (p.nick === cyr) return `«${p.nick}» — кириллица сохранена`;
            if (p.nick === lat) return `«${p.nick}» — кириллица заменена на _ (так классифицирует локаль базы; не ошибка)`;
            throw new Error(`ждали «${cyr}», получили «${p.nick}»`);
          }
          ok(p.nick.toLowerCase() !== first.toLowerCase(), "дубль ника!");
          ok(new RegExp(`^${first}\\d{4}$`, "i").test(p.nick), `ждали «${first}» + 4 цифры, получили «${p.nick}»`);
          return `«${p.nick}» — занятый ник дополнен цифрами`;
        });
      }
    }

    /* ---------- 3. A создаёт данные через настоящий api ---------- */
    section("3. A создаёт работу и задание (настоящий api сайта)");
    await gate("api.createSubmission с PNG → статус pending, версия 1", async () => {
      sub = await api.createSubmission({
        title: `DB check ${ts}`, description: "автотест tests/db-check", category: "other",
        files: [await makePng(`A ${ts}`)], note: "v1",
      });
      created.subs.add(sub.id);
      ok(sub.status === "pending" && sub.rating === null, `status ${sub.status}, rating ${sub.rating}`);
      ok(sub.versions.length === 1 && sub.versions[0].n === 1, `версий ${sub.versions.length}`);
      ok(sub.versions[0].imageUrls.length === 1, "нет ссылки на картинку");
      ok(sub.userId === A.id && sub.authorNick === A.nick, "автор не A");
      return `id ${sub.id.slice(0, 8)}…`;
    });
    await t("Картинка открывается по подписанной ссылке", async () => {
      const r = await fetch(sub.versions[0].imageUrls[0]);
      ok(r.ok, `HTTP ${r.status}`);
      const b = await r.blob();
      ok(b.size > 0, "пустой файл");
      return `${b.type || "?"}, ${b.size} байт`;
    });
    await gate("Путь картинки в базе: <id автора>/<id работы>/…", async () => {
      const rows = await must(cA.from("submission_versions").select("image_paths").eq("submission_id", sub.id));
      imgPath = rows[0]?.image_paths?.[0] || "";
      ok(imgPath.startsWith(`${A.id}/${sub.id}/`), imgPath || "пусто");
      return imgPath;
    });
    await gate("api.createTask → статус new, 0 голосов", async () => {
      task = await api.createTask({ game: "minecraft", title: `DB check task ${ts}`, description: "автотест", difficulty: 1 });
      created.tasks.add(task.id);
      ok(task.status === "new" && task.votes === 0 && task.myVote === false && task.adminNote === null, JSON.stringify(task));
      return `id ${task.id.slice(0, 8)}…`;
    });
    await t("api.toggleVote → 1 голос, myVote", async () => {
      const r = await api.toggleVote(task.id);
      ok(r.votes === 1 && r.myVote === true, JSON.stringify(r));
      return JSON.stringify(r);
    });
    await t("api.listTasks показывает задание с голосом A", async () => {
      const x = (await api.listTasks()).find((y) => y.id === task.id);
      ok(x && x.votes === 1 && x.myVote === true && x.authorNick === A.nick, JSON.stringify(x));
      return "ok";
    });
    await t("api.listSubmissions({ scope: 'mine' }) содержит работу", async () => {
      const list = await api.listSubmissions({ scope: "mine" });
      ok(list.some((s) => s.id === sub.id), "нет в списке");
      return `работ: ${list.length}`;
    });
    await t("api.listSubmissions({ scope: 'all' }) для не-админа → forbidden", () => apiFails(() => api.listSubmissions({ scope: "all" }), "forbidden"));
    await t("api.addComment автора → ok, isAdmin = false", async () => {
      const c = await api.addComment(sub.id, "комментарий автотеста");
      ok(c.userId === A.id && c.isAdmin === false, JSON.stringify(c));
      return "ok";
    });

    /* ---------- 4. A пытается повысить себе права ---------- */
    section("4. A пытается обойти правила (напрямую через supabase-js)");
    const subState = async () => must(cA.from("submissions").select("status, rating, user_id").eq("id", sub.id).single());
    const myProfile = async () => must(anon.from("profiles").select("nick, role").eq("id", A.id).single());
    await t("A не может поставить себе оценку (rating = 10)", async () => {
      const how = await denied(cA.from("submissions").update({ rating: 10 }).eq("id", sub.id).select("id"));
      const s = await subState();
      ok(s.rating === null, `rating стал ${s.rating}`);
      return how;
    });
    await t("A не может сам поставить статус ideal", async () => {
      const how = await denied(cA.from("submissions").update({ status: "ideal" }).eq("id", sub.id).select("id"));
      const s = await subState();
      ok(s.status === "pending", `status стал ${s.status}`);
      return how;
    });
    await t("A не может сделать себя админом (profiles.role)", async () => {
      const how = await denied(cA.from("profiles").update({ role: "admin" }).eq("id", A.id).select("id"));
      const p = await myProfile();
      ok(p.role === "user", `роль стала ${p.role}`);
      return how;
    });
    await t("A не может сменить ник напрямую (профиль только для чтения)", async () => {
      const how = await denied(cA.from("profiles").update({ nick: `${A.nick}x` }).eq("id", A.id).select("id"));
      ok((await myProfile()).nick === A.nick, "ник изменился");
      return how;
    });
    await t("A не может создать работу сразу со статусом ideal и оценкой", () => denied(
      cA.from("submissions").insert({ title: "fake ideal", category: "other", status: "ideal", rating: 10 }).select("id"),
      (rows) => rows.forEach((r) => created.subs.add(r.id))));
    await t("A не может создать работу от имени B", () => denied(
      cA.from("submissions").insert({ user_id: B.id, title: "as B", category: "other" }).select("id"),
      (rows) => rows.forEach((r) => created.subs.add(r.id))));
    await t("A не может создать задание со статусом accepted / заметкой админа", () => denied(
      cA.from("tasks").insert({ game: "cs2", title: "fake accepted", difficulty: 2, status: "accepted", admin_note: "ok" }).select("id"),
      (rows) => rows.forEach((r) => created.tasks.add(r.id))));
    await t("A не может сменить статус своего задания", async () => {
      const how = await denied(cA.from("tasks").update({ status: "accepted" }).eq("id", task.id).select("id"));
      const x = await must(anon.from("tasks").select("status").eq("id", task.id).single());
      ok(x.status === "new", `статус стал ${x.status}`);
      return how;
    });
    await t("Двойной голос невозможен (повторная вставка в task_votes)", async () => {
      const how = await denied(cA.from("task_votes").insert({ task_id: task.id, user_id: A.id }).select("task_id"));
      const f = await must(anon.from("tasks_feed").select("votes").eq("id", task.id).single());
      ok(f.votes === 1, `голосов стало ${f.votes}`);
      return how;
    });
    await t("A не может проголосовать от имени B", () => denied(
      cA.from("task_votes").insert({ task_id: task.id, user_id: B.id }).select("task_id")));
    await t("api.stats() для не-админа → forbidden", () => apiFails(() => api.stats(), "forbidden"));
    await t("rpc admin_stats для не-админа → отказ", () => denied(cA.rpc("admin_stats")));
    await t("A не читает admin_emails", () => denied(cA.from("admin_emails").select("email").limit(1)));
    await t("A не может добавить свой email в admin_emails", async () => {
      const how = await denied(cA.from("admin_emails").insert({ email: A.email }).select("email"));
      ok((await myProfile()).role === "user", "роль стала admin!");
      return how;
    });
    await t("A не может вызвать служебные функции (role_for, sync_admin_roles)", async () => {
      const a = await denied(cA.rpc("role_for", { p_email: A.email, p_confirmed_at: new Date().toISOString() }));
      const b = await denied(cA.rpc("sync_admin_roles"));
      return `${a}; ${b}`;
    });
    await t("Версия работы не может ссылаться на картинки из чужой папки", () => denied(
      cA.from("submission_versions").insert({ submission_id: sub.id, image_paths: [`${B.id}/${sub.id}/x.png`] }).select("id")));

    /* ---------- 5. B пытается добраться до данных A ---------- */
    section("5. B против данных A");
    await t("B не видит работу A (но она существует)", async () => {
      const rows = await must(cB.from("submissions").select("id").eq("id", sub.id));
      ok(rows.length === 0, "работа видна!");
      ok((await must(cB.rpc("submission_exists", { p_id: sub.id }))) === true, "submission_exists = false");
      return "0 строк, submission_exists = true";
    });
    await t("B не видит версии и комментарии работы A", async () => {
      const v = await must(cB.from("submission_versions").select("id").eq("submission_id", sub.id));
      const c = await must(cB.from("submission_comments").select("id").eq("submission_id", sub.id));
      ok(v.length === 0 && c.length === 0, `версий ${v.length}, комментариев ${c.length}`);
      return "0 / 0";
    });
    await t("B не получает подписанную ссылку на картинку A", () => denied(cB.storage.from(BUCKET).createSignedUrl(imgPath, 60)));
    await t("B не скачивает картинку A", () => denied(cB.storage.from(BUCKET).download(imgPath)));
    await t("B не видит файлы в папке A", () => denied(cB.storage.from(BUCKET).list(`${A.id}/${sub.id}`)));
    await t("B не загружает файл в папку A", async () => denied(
      cB.storage.from(BUCKET).upload(`${A.id}/${sub.id}/evil-${ts}.png`, await makePng("B"), { contentType: "image/png" })));
    await t("B не удаляет картинку A", async () => {
      await cB.storage.from(BUCKET).remove([imgPath]);
      await must(cA.storage.from(BUCKET).createSignedUrl(imgPath, 60));
      return "файл на месте (A по-прежнему подписывает ссылку)";
    });
    await t("B не комментирует работу A", () => denied(
      cB.from("submission_comments").insert({ submission_id: sub.id, user_id: B.id, text: "spam" }).select("id")));
    await t("B не добавляет версию к работе A", () => denied(
      cB.from("submission_versions").insert({ submission_id: sub.id, image_paths: [`${A.id}/${sub.id}/x.png`] }).select("id")));
    await t("B не меняет оценку работы A", async () => {
      const how = await denied(cB.from("submissions").update({ rating: 1, status: "rejected" }).eq("id", sub.id).select("id"));
      const s = await subState();
      ok(s.rating === null && s.status === "pending", JSON.stringify(s));
      return how;
    });
    await t("B не удаляет работу A", async () => {
      const how = await denied(cB.from("submissions").delete().eq("id", sub.id).select("id"));
      await subState();
      return `${how}; работа на месте`;
    });
    await t("B не меняет задание A (статус, название)", async () => {
      const how = await denied(cB.from("tasks").update({ status: "rejected", title: "hacked" }).eq("id", task.id).select("id"));
      const x = await must(anon.from("tasks").select("status, title").eq("id", task.id).single());
      ok(x.status === "new" && x.title === task.title, JSON.stringify(x));
      return how;
    });
    await t("B не удаляет задание A", async () => {
      const how = await denied(cB.from("tasks").delete().eq("id", task.id).select("id"));
      ok((await must(anon.from("tasks").select("id").eq("id", task.id))).length === 1, "задание пропало!");
      return `${how}; задание на месте`;
    });
    await t("B голосует за задание A (rpc toggle_vote) → 2 голоса", async () => {
      const r = await must(cB.rpc("toggle_vote", { p_task_id: task.id }));
      ok(r.votes === 2 && r.myVote === true, JSON.stringify(r));
      return JSON.stringify(r);
    });
    await t("B не может проголосовать второй раз", () => denied(
      cB.from("task_votes").insert({ task_id: task.id, user_id: B.id }).select("task_id")));
    await t("B не видит, кто ещё голосовал (только свой голос)", async () => {
      const rows = await must(cB.from("task_votes").select("user_id").eq("task_id", task.id));
      ok(rows.length === 1 && rows[0].user_id === B.id, JSON.stringify(rows));
      return "1 строка — своя";
    });
    await t("Гость видит в ленте 2 голоса, my_vote = false", async () => {
      const f = await must(anon.from("tasks_feed").select("votes, my_vote, author_nick").eq("id", task.id).single());
      ok(f.votes === 2 && f.my_vote === false && f.author_nick === A.nick, JSON.stringify(f));
      return JSON.stringify(f);
    });
    await t("Гость не видит работу A и её картинку", async () => {
      ok((await must(anon.from("submissions").select("id").eq("id", sub.id))).length === 0, "работа видна гостю!");
      return denied(anon.storage.from(BUCKET).createSignedUrl(imgPath, 60));
    });

    /* ---------- 6. Админ (по желанию) ---------- */
    section("6. Админ (если введены данные админа)");
    if (!cAdm) {
      for (const n of ["Админ входит, роль admin", "admin_stats для админа", "Админ ставит оценку → A загружает версию → статус pending, оценка сохранилась",
        "Статус ideal → работа и картинка видны гостю (галерея)", "Автор не может удалить задание не в статусе «Новое»"]) {
        skipRow(n, "данные админа не введены");
      }
    } else {
      adminOk = await t("Админ входит, роль admin", async () => {
        const d = await must(cAdm.auth.signInWithPassword({ email: adminEmail, password: adminPassword }));
        const p = await must(anon.from("profiles").select("nick, role").eq("id", d.user.id).single());
        ok(p.role === "admin", `роль ${p.role} — email не в admin_emails или не подтверждён`);
        return p.nick;
      });
      if (!adminOk) {
        skipRow("Остальные проверки админа", "админ не вошёл");
      } else {
        await t("admin_stats для админа", async () => {
          const s = await must(cAdm.rpc("admin_stats"));
          ok(s.users >= 2 && s.tasks.total >= 1 && s.submissions.total >= 1, JSON.stringify(s));
          return `users ${s.users}, works ${s.submissions.total}, tasks ${s.tasks.total}`;
        });
        await t("Админ видит работу A", async () => {
          ok((await must(cAdm.from("submissions").select("id").eq("id", sub.id))).length === 1, "не видна");
          return "ok";
        });
        await t("Админ ставит оценку → A загружает версию → статус pending, оценка сохранилась", async () => {
          ok((await must(cAdm.from("submissions").update({ rating: 7, status: "revision" }).eq("id", sub.id).select("id"))).length === 1, "update не прошёл");
          const s2 = await api.addVersion(sub.id, { files: [await makePng(`A v2 ${ts}`)], note: "v2" });
          ok(s2.status === "pending" && s2.rating === 7 && s2.versions.length === 2 && s2.versions[1].n === 2, JSON.stringify({ status: s2.status, rating: s2.rating, v: s2.versions.length }));
          return "v2, pending, rating 7";
        });
        await t("Статус ideal → работа и картинка видны гостю (галерея)", async () => {
          await must(cAdm.from("submissions").update({ status: "ideal" }).eq("id", sub.id).select("id"));
          ok((await must(anon.from("submissions").select("id").eq("id", sub.id))).length === 1, "гость не видит");
          await must(anon.storage.from(BUCKET).createSignedUrl(imgPath, 60));
          return "ok";
        });
        await t("B видит работу в галерее, но комментировать не может", async () => {
          ok((await must(cB.from("submissions").select("id").eq("id", sub.id))).length === 1, "не видна");
          return denied(cB.from("submission_comments").insert({ submission_id: sub.id, user_id: B.id, text: "spam" }).select("id"));
        });
        await t("Автор не может удалить задание не в статусе «Новое»", async () => {
          await must(cAdm.from("tasks").update({ status: "accepted", admin_note: "автотест" }).eq("id", task.id).select("id"));
          const how = await apiFails(() => api.deleteTask(task.id), "forbidden");
          const db = await denied(cA.from("tasks").delete().eq("id", task.id).select("id")); // в обход проверки сайта
          ok((await must(anon.from("tasks").select("id").eq("id", task.id))).length === 1, "задание удалилось!");
          return `${how}; напрямую: ${db}`;
        });
        await t("Админ удаляет чужое задание", async () => {
          const rows = await must(cAdm.from("tasks").delete().eq("id", task.id).select("id"));
          ok(rows.length === 1, "не удалилось");
          created.tasks.delete(task.id);
          return "ok";
        });
      }
    }

    /* ---------- 7. Правила удаления ---------- */
    section("7. Правила удаления");
    await t("Автор удаляет своё новое задание (api.deleteTask)", async () => {
      const t2 = await api.createTask({ game: "cs2", title: `DB check delete ${ts}`, description: "", difficulty: 2 });
      created.tasks.add(t2.id);
      await api.deleteTask(t2.id);
      ok((await must(anon.from("tasks").select("id").eq("id", t2.id))).length === 0, "задание осталось");
      created.tasks.delete(t2.id);
      return "ok";
    });
    await t("Автор удаляет свою работу (api.deleteSubmission) — картинки тоже удаляются", async () => {
      await api.deleteSubmission(sub.id);
      ok((await must(cA.from("submissions").select("id").eq("id", sub.id))).length === 0, "работа осталась");
      created.subs.delete(sub.id);
      const files = await must(cA.storage.from(BUCKET).list(`${A.id}/${sub.id}`));
      ok(files.length === 0, `в хранилище осталось файлов: ${files.length}`);
      return "работа, версии, комментарии и файлы удалены";
    });
    await t("Удалённая работа: getSubmission → not_found", () => apiFails(() => api.getSubmission(sub.id), "not_found"));
  } catch (e) {
    if (!(e instanceof Stop)) addRow("Непредвиденная ошибка прогона")("FAIL", e?.stack || String(e));
    else note(`Проверка остановлена на шаге «${escHtml(e.message)}» — дальше без него нет смысла.`, "warn");
  } finally {
    /* ---------- Уборка ---------- */
    section("Уборка");
    await t("Удалить созданные тестом работы и задания", async () => {
      const left = [];
      for (const id of created.subs) {
        try {
          await api.deleteSubmission(id); // заодно удаляет картинки
        } catch {
          const { data } = await cA.from("submissions").delete().eq("id", id).select("id");
          if (!data?.length) left.push(`работа ${id}`);
        }
      }
      if (A.id) {
        // Файлы, оставшиеся без работы (если тест упал между загрузкой и записью).
        try {
          for (const folder of await must(cA.storage.from(BUCKET).list(A.id))) {
            const files = await must(cA.storage.from(BUCKET).list(`${A.id}/${folder.name}`));
            if (files.length) await cA.storage.from(BUCKET).remove(files.map((f) => `${A.id}/${folder.name}/${f.name}`));
          }
        } catch { /* не критично */ }
      }
      for (const id of created.tasks) {
        let gone = false;
        for (const c of [cA, cAdm && adminOk ? cAdm : null].filter(Boolean)) {
          const { data } = await c.from("tasks").delete().eq("id", id).select("id");
          if (data?.length) { gone = true; break; }
        }
        if (!gone && (await anon.from("tasks").select("id").eq("id", id)).data?.length) left.push(`задание ${id}`);
      }
      if (left.length) throw new Error(`не удалось удалить: ${left.join(", ")} — удали в Table Editor`);
      return "ok";
    });
    try { await api?.signOut(); } catch { /* ignore */ }
    for (const c of [cA, cB, cAdm].filter(Boolean)) { try { await c.auth.signOut({ scope: "local" }); } catch { /* ignore */ } }

    const failed = counts.FAIL;
    note(failed
      ? `<b>Есть ошибки: ${failed}.</b> Причина — в колонке «Подробности» строк FAIL. «ОПЕРАЦИЯ ПРОШЛА» означает дыру в правах:
         проверь, что <code>supabase/schema.sql</code> запущен целиком, последней версией и без ошибок.`
      : `<b>Все проверки пройдены.</b> Правила доступа базы работают как задумано.`, failed ? "bad" : "good");
    if (created.users.length) {
      note(`Тестовые аккаунты остаются в базе (удалить их может только владелец проекта):<br><code>${created.users.map(escHtml).join("<br>")}</code><br>
        Удали их: <b>Authentication → Users</b> → поиск <code>dbcheck</code> → ⋯ → <b>Delete user</b>. Профили и всё остальное удалятся вместе с ними.`, "info");
    }
  }
}

/* ───────────────────────── Запуск со страницы ───────────────────────── */
const problem = keyProblem();
const btn = $("#run");
if (problem) {
  $("#status").className = "note bad";
  $("#status").textContent = `Проверка не запущена. ${problem}`;
  btn.disabled = true;
  document.body.classList.add("refused");
} else {
  $("#status").className = "note info";
  $("#status").textContent = `База: ${url}. Нажми «Запустить проверку».`;
  btn.disabled = false;
  btn.addEventListener("click", async () => {
    const emailTpl = $("#emailTpl").value.trim();
    if (!emailTpl.includes("{id}") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTpl.replace("{id}", "x"))) {
      $("#status").className = "note warn";
      $("#status").textContent = "Шаблон email должен быть адресом и содержать {id}, например dbcheck+{id}@example.com";
      return;
    }
    btn.disabled = true;
    $("#rows").innerHTML = "";
    $("#notes").innerHTML = "";
    Object.keys(counts).forEach((k) => { counts[k] = 0; });
    $("#status").className = "note info";
    $("#status").textContent = "Идёт проверка… (обычно 20–60 секунд)";
    const adminEmail = $("#adminEmail").value.trim();
    const adminPassword = $("#adminPassword").value;
    $("#adminPassword").value = ""; // пароль не храним
    try {
      await run({ emailTpl, adminEmail: adminEmail && adminPassword ? adminEmail : "", adminPassword, discordNicks: $("#discordNicks").checked });
      $("#status").textContent = `Готово: PASS ${counts.PASS}, FAIL ${counts.FAIL}, SKIP ${counts.SKIP}.`;
      $("#status").className = `note ${counts.FAIL ? "bad" : "good"}`;
    } finally {
      btn.disabled = false;
    }
  });
}
window.__dbcheck = { ready: true, refused: Boolean(problem) };
