// Боевой бэкенд: PHP + MySQL на хостинге (папка api/, протокол — API.md).
// Реализует тот же контракт, что local.js (см. api.js). Перед запросом поля проверяются
// теми же правилами (validate.js), чтобы ошибки показывались сразу, — но окончательную
// проверку и права всегда делает сервер.
import { ApiError } from "./errors.js";
import {
  assertValid, checkSignUp, checkSignIn, checkSubmission, checkVersion,
  checkComment, checkReview, checkTask, checkTaskUpdate,
} from "./validate.js";

const ROOT = new URL("../../../", import.meta.url); // корень сайта (файл лежит в assets/js/data/)
const API = new URL("api/index.php", ROOT);

/** Запрос к API. Возвращает data или бросает ApiError. */
async function call(route, { method = "GET", query, body, form } = {}) {
  const url = new URL(API);
  url.searchParams.set("r", route);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET") init.headers["X-Requested-With"] = "ndze"; // защита от CSRF (см. API.md)
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("network");
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("unknown", res.status >= 500 ? "Сервер временно недоступен, попробуй позже" : `Сервер ответил ${res.status}`);
  }
  if (!json || json.ok !== true) {
    const e = json?.error || {};
    throw new ApiError(e.code || "unknown", e.message, e.fields || undefined);
  }
  return json.data;
}

const post = (route, body) => call(route, { method: "POST", body: body ?? {} });

function filesForm(fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, String(v));
  for (const f of files || []) form.append("files[]", f, f.name);
  return form;
}

export function createPhpBackend() {
  const listeners = new Set();
  let current; // undefined — ещё не спрашивали сервер

  const setUser = (u) => {
    const changed = (u?.id ?? null) !== (current?.id ?? null) || u?.role !== current?.role;
    current = u ?? null;
    if (changed) listeners.forEach((cb) => { try { cb(current); } catch (err) { console.error(err); } });
    return current;
  };

  return {
    mode: "php",

    /* ---------- Аккаунт ---------- */
    async getUser() {
      if (current !== undefined) return current;
      current = (await call("me")) ?? null;
      return current;
    },

    async signUp({ nick, email, password }) {
      assertValid(checkSignUp({ nick, email, password }));
      return setUser(await post("auth/register", { nick: nick.trim(), email: email.trim(), password }));
    },

    async signIn({ email, password }) {
      assertValid(checkSignIn({ email, password }));
      return setUser(await post("auth/login", { email: email.trim(), password }));
    },

    async signInWithOAuth(provider) {
      if (provider !== "discord") throw new ApiError("validation", "Этот способ входа не поддерживается");
      const back = location.pathname + location.search;
      location.href = `${new URL("api/discord-login.php", ROOT)}?return=${encodeURIComponent(back)}`;
      return new Promise(() => {}); // страница уходит на Discord
    },

    async signOut() {
      await post("auth/logout");
      setUser(null);
    },

    onAuthChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /* ---------- Работы на оценку ---------- */
    listSubmissions({ scope = "mine" } = {}) {
      return call("submissions", { query: { scope } });
    },

    getSubmission(id) {
      return call("submission", { query: { id } });
    },

    async createSubmission({ title, description = "", category, files, note = "" }) {
      assertValid(checkSubmission({ title, description, category, files, note }));
      return call("submissions", { method: "POST", form: filesForm({ title, description, category, note }, files) });
    },

    async addVersion(id, { files, note = "" }) {
      assertValid(checkVersion({ files, note }));
      return call("submission/version", { method: "POST", form: filesForm({ id, note }, files) });
    },

    async addComment(id, text) {
      assertValid(checkComment(text));
      return post("submission/comment", { id, text });
    },

    async reviewSubmission(id, { rating, status } = {}) {
      assertValid(checkReview({ rating, status }));
      const body = { id };
      if (rating !== undefined) body.rating = rating;
      if (status !== undefined) body.status = status;
      return post("submission/review", body);
    },

    async deleteSubmission(id) {
      await post("submission/delete", { id });
    },

    /* ---------- Задания на стрим ---------- */
    listTasks({ game, status } = {}) {
      return call("tasks", { query: { game, status } });
    },

    async createTask({ game, title, description = "", difficulty }) {
      assertValid(checkTask({ game, title, description, difficulty }));
      return post("tasks", { game, title, description, difficulty: Number(difficulty) });
    },

    toggleVote(id) {
      return post("task/vote", { id });
    },

    async updateTask(id, { status, adminNote } = {}) {
      assertValid(checkTaskUpdate({ status, adminNote }));
      const body = { id };
      if (status !== undefined) body.status = status;
      if (adminNote !== undefined) body.adminNote = adminNote;
      return post("task/update", body);
    },

    async deleteTask(id) {
      await post("task/delete", { id });
    },

    /* ---------- Админ ---------- */
    stats() {
      return call("stats");
    },
  };
}
