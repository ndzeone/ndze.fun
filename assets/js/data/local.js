// Демо-бэкенд: всё хранится в IndexedDB этого браузера.
// Нужен для локального просмотра (start.bat не умеет PHP).
// Права проверяются так же, как в api/ на сервере, но это не защита —
// любой может открыть DevTools. Для настоящих пользователей — php.js + MySQL.
import { ApiError } from "./errors.js";
import { LIMITS } from "./constants.js";
import {
  assertValid, checkSignUp, checkSignIn, checkSubmission, checkVersion,
  checkComment, checkReview, checkTask, checkTaskUpdate,
  checkNick, checkPasswordChange, checkAvatar,
} from "./validate.js";

const DB_NAME = "ndze-site";
const SESSION_KEY = "ndze:session";

/* ---------- Мини-обёртка над IndexedDB (key → value) ---------- */
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function read(key, fallback) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ?? fallback);
    req.onerror = () => reject(req.error);
  });
}
async function write(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Помощники ---------- */
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clean = (s) => String(s ?? "").trim();
const copy = (v) => structuredClone(v);

const session = {
  get() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },
  set(id) { try { id ? localStorage.setItem(SESSION_KEY, id) : localStorage.removeItem(SESSION_KEY); } catch { /* приватный режим */ } },
};

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Уменьшает картинку до LIMITS.imageMaxSide и возвращает data: URL (GIF сохраняем как есть). */
async function fileToDataUrl(file) {
  if (file.type === "image/gif") {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS.imageMaxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.86);
}

/** Аватарка как на сервере: квадрат 256×256, обрезка по центру → data: URL. */
async function avatarDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  bmp.close?.();
  return canvas.toDataURL("image/webp", 0.88);
}

const publicUser = (u) => (u ? { id: u.id, nick: u.nick, email: u.email, role: u.role, avatarUrl: u.avatarUrl ?? null, createdAt: u.createdAt } : null);
const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

/** Актуальные ник и аватарка автора (в демо они хранятся снимком на момент создания). */
async function withAuthors(items) {
  const users = new Map((await read("users", [])).map((u) => [u.id, u]));
  const fix = (x) => {
    const u = users.get(x.userId);
    if (u) { x.authorNick = u.nick; x.authorAvatar = u.avatarUrl ?? null; }
    else x.authorAvatar ??= null;
    x.comments?.forEach(fix);
    return x;
  };
  return items.map(fix);
}

export function createLocalBackend() {
  const listeners = new Set();
  const emit = (user) => listeners.forEach((cb) => cb(user));

  async function currentUser() {
    const id = session.get();
    if (!id) return null;
    const users = await read("users", []);
    return users.find((u) => u.id === id) || null;
  }
  async function requireUser() {
    const u = await currentUser();
    if (!u) throw new ApiError("auth_required");
    return u;
  }
  async function requireAdmin() {
    const u = await requireUser();
    if (u.role !== "admin") throw new ApiError("forbidden");
    return u;
  }
  const canSee = (u, s) => s.status === "ideal" || (u && (u.role === "admin" || u.id === s.userId));

  async function getSubs() { return read("submissions", []); }
  async function findSub(subs, id) {
    const s = subs.find((x) => x.id === id);
    if (!s) throw new ApiError("not_found", "Работа не найдена");
    return s;
  }

  async function taskView(tasks, votes, me) {
    return withAuthors(tasks.map((t) => {
      const tv = votes.filter((v) => v.taskId === t.id);
      return { ...copy(t), votes: tv.length, myVote: !!me && tv.some((v) => v.userId === me.id) };
    }));
  }

  return {
    mode: "local",

    /* ---------- Аккаунт ---------- */
    async getUser() {
      return publicUser(await currentUser());
    },

    async signUp({ nick, email, password }) {
      assertValid(checkSignUp({ nick, email, password }));
      nick = clean(nick);
      email = clean(email).toLowerCase();
      const users = await read("users", []);
      if (users.some((u) => u.email === email)) throw new ApiError("email_taken", undefined, { email: "Этот email уже зарегистрирован" });
      if (users.some((u) => u.nick.toLowerCase() === nick.toLowerCase())) throw new ApiError("nick_taken", undefined, { nick: "Этот ник уже занят" });
      const salt = uid();
      const user = {
        id: uid(), nick, email, salt,
        hash: await hashPassword(password, salt),
        role: users.length === 0 ? "admin" : "user", // демо: первый аккаунт — владелец сайта
        createdAt: now(),
      };
      users.push(user);
      await write("users", users);
      session.set(user.id);
      emit(publicUser(user));
      return publicUser(user);
    },

    async signIn({ email, password }) {
      assertValid(checkSignIn({ email, password }));
      const users = await read("users", []);
      const user = users.find((u) => u.email === clean(email).toLowerCase());
      if (!user || user.hash !== (await hashPassword(password, user.salt))) throw new ApiError("invalid_credentials");
      session.set(user.id);
      emit(publicUser(user));
      return publicUser(user);
    },

    async signInWithOAuth() {
      throw new ApiError("validation", "Вход через Discord работает на сайте ndze.fun (в локальном демо-режиме его нет)");
    },

    async signOut() {
      session.set(null);
      emit(null);
    },

    onAuthChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /* ---------- Личный кабинет ---------- */
    async getProfile() {
      const me = await requireUser();
      const [subs, tasks, votes] = await Promise.all([getSubs(), read("tasks", []), read("votes", [])]);
      const mine = subs.filter((s) => s.userId === me.id);
      const rated = mine.filter((s) => s.rating !== null);
      const myTasks = tasks.filter((t) => t.userId === me.id);
      const myTaskIds = new Set(myTasks.map((t) => t.id));
      return {
        user: publicUser(me),
        hasPassword: true,
        discordLinked: false,
        stats: {
          submissions: mine.length,
          ideal: mine.filter((s) => s.status === "ideal").length,
          avgRating: rated.length ? Math.round((rated.reduce((a, s) => a + s.rating, 0) / rated.length) * 10) / 10 : null,
          tasks: myTasks.length,
          tasksDone: myTasks.filter((t) => t.status === "done").length,
          votesReceived: votes.filter((v) => myTaskIds.has(v.taskId)).length,
        },
      };
    },

    async updateProfile({ nick }) {
      const me = await requireUser();
      assertValid(checkNick(nick));
      nick = clean(nick);
      const users = await read("users", []);
      if (users.some((u) => u.id !== me.id && u.nick.toLowerCase() === nick.toLowerCase())) throw new ApiError("nick_taken", undefined, { nick: "Этот ник уже занят" });
      const u = users.find((x) => x.id === me.id);
      u.nick = nick;
      await write("users", users);
      emit(publicUser(u));
      return publicUser(u);
    },

    async changePassword({ currentPassword = "", newPassword }) {
      const me = await requireUser();
      assertValid(checkPasswordChange({ currentPassword, newPassword, hasPassword: true }));
      if (me.hash !== (await hashPassword(currentPassword, me.salt))) throw new ApiError("validation", "Неверный текущий пароль", { currentPassword: "Неверный текущий пароль" });
      const users = await read("users", []);
      const u = users.find((x) => x.id === me.id);
      u.salt = uid();
      u.hash = await hashPassword(newPassword, u.salt);
      await write("users", users);
    },

    async uploadAvatar(file) {
      const me = await requireUser();
      assertValid(checkAvatar(file));
      const users = await read("users", []);
      const u = users.find((x) => x.id === me.id);
      u.avatarUrl = await avatarDataUrl(file);
      await write("users", users);
      emit(publicUser(u));
      return publicUser(u);
    },

    async removeAvatar() {
      const me = await requireUser();
      const users = await read("users", []);
      const u = users.find((x) => x.id === me.id);
      u.avatarUrl = null;
      await write("users", users);
      emit(publicUser(u));
      return publicUser(u);
    },

    async linkDiscord() {
      throw new ApiError("validation", "Привязка Discord работает на сайте ndze.fun (в локальном демо-режиме её нет)");
    },

    async unlinkDiscord() {
      return this.getProfile();
    },

    /* ---------- Работы на оценку ---------- */
    async listSubmissions({ scope = "mine" } = {}) {
      const subs = await getSubs();
      let list;
      if (scope === "gallery") list = subs.filter((s) => s.status === "ideal");
      else if (scope === "all") { await requireAdmin(); list = subs; }
      else { const me = await requireUser(); list = subs.filter((s) => s.userId === me.id); }
      return (await withAuthors(copy(list))).sort(byUpdatedDesc);
    },

    async getSubmission(id) {
      const me = await currentUser();
      const s = await findSub(await getSubs(), id);
      if (!canSee(me, s)) throw new ApiError(me ? "forbidden" : "auth_required");
      return (await withAuthors([copy(s)]))[0];
    },

    async createSubmission({ title, description = "", category, files, note = "" }) {
      const me = await requireUser();
      assertValid(checkSubmission({ title, description, category, files, note }));
      const imageUrls = await Promise.all([...files].map(fileToDataUrl));
      const t = now();
      const sub = {
        id: uid(), userId: me.id, authorNick: me.nick, authorAvatar: me.avatarUrl ?? null,
        title: clean(title), description: clean(description), category,
        status: "pending", rating: null, createdAt: t, updatedAt: t,
        versions: [{ id: uid(), n: 1, imageUrls, note: clean(note), createdAt: t }],
        comments: [],
      };
      const subs = await getSubs();
      subs.push(sub);
      await write("submissions", subs);
      return copy(sub);
    },

    async addVersion(id, { files, note = "" }) {
      const me = await requireUser();
      assertValid(checkVersion({ files, note }));
      const subs = await getSubs();
      const s = await findSub(subs, id);
      if (s.userId !== me.id) throw new ApiError("forbidden", "Новую версию может загрузить только автор");
      const imageUrls = await Promise.all([...files].map(fileToDataUrl));
      const t = now();
      s.versions.push({ id: uid(), n: s.versions.length + 1, imageUrls, note: clean(note), createdAt: t });
      s.status = "pending";
      s.updatedAt = t;
      await write("submissions", subs);
      return copy(s);
    },

    async addComment(id, text) {
      const me = await requireUser();
      assertValid(checkComment(text));
      const subs = await getSubs();
      const s = await findSub(subs, id);
      if (me.role !== "admin" && s.userId !== me.id) throw new ApiError("forbidden");
      const t = now();
      const comment = { id: uid(), userId: me.id, authorNick: me.nick, authorAvatar: me.avatarUrl ?? null, isAdmin: me.role === "admin", text: clean(text), createdAt: t };
      s.comments.push(comment);
      s.updatedAt = t;
      await write("submissions", subs);
      return copy(comment);
    },

    async reviewSubmission(id, { rating, status } = {}) {
      await requireAdmin();
      assertValid(checkReview({ rating, status }));
      const subs = await getSubs();
      const s = await findSub(subs, id);
      if (rating !== undefined) s.rating = rating;
      if (status !== undefined) s.status = status;
      s.updatedAt = now();
      await write("submissions", subs);
      return copy(s);
    },

    async deleteSubmission(id) {
      const me = await requireUser();
      const subs = await getSubs();
      const s = await findSub(subs, id);
      if (me.role !== "admin" && s.userId !== me.id) throw new ApiError("forbidden");
      await write("submissions", subs.filter((x) => x.id !== id));
    },

    /* ---------- Задания на стрим ---------- */
    async listTasks({ game, status } = {}) {
      const me = await currentUser();
      let tasks = await read("tasks", []);
      if (game) tasks = tasks.filter((t) => t.game === game);
      if (status) tasks = tasks.filter((t) => t.status === status);
      const view = await taskView(tasks, await read("votes", []), me);
      return view.sort((a, b) => b.votes - a.votes || b.createdAt.localeCompare(a.createdAt));
    },

    async createTask({ game, title, description = "", difficulty }) {
      const me = await requireUser();
      assertValid(checkTask({ game, title, description, difficulty }));
      const t = now();
      const task = {
        id: uid(), userId: me.id, authorNick: me.nick, game,
        title: clean(title), description: clean(description), difficulty: Number(difficulty),
        status: "new", adminNote: null, createdAt: t, updatedAt: t,
      };
      const tasks = await read("tasks", []);
      tasks.push(task);
      await write("tasks", tasks);
      return { ...copy(task), authorAvatar: me.avatarUrl ?? null, votes: 0, myVote: false };
    },

    async toggleVote(id) {
      const me = await requireUser();
      const tasks = await read("tasks", []);
      if (!tasks.some((t) => t.id === id)) throw new ApiError("not_found", "Задание не найдено");
      let votes = await read("votes", []);
      const mine = votes.some((v) => v.taskId === id && v.userId === me.id);
      votes = mine ? votes.filter((v) => !(v.taskId === id && v.userId === me.id)) : [...votes, { taskId: id, userId: me.id }];
      await write("votes", votes);
      return { votes: votes.filter((v) => v.taskId === id).length, myVote: !mine };
    },

    async updateTask(id, { status, adminNote } = {}) {
      const me = await requireAdmin();
      assertValid(checkTaskUpdate({ status, adminNote }));
      const tasks = await read("tasks", []);
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new ApiError("not_found", "Задание не найдено");
      if (status !== undefined) t.status = status;
      if (adminNote !== undefined) t.adminNote = adminNote === null ? null : clean(adminNote) || null;
      t.updatedAt = now();
      await write("tasks", tasks);
      const [view] = await taskView([t], await read("votes", []), me);
      return view;
    },

    async deleteTask(id) {
      const me = await requireUser();
      const tasks = await read("tasks", []);
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new ApiError("not_found", "Задание не найдено");
      const allowed = me.role === "admin" || (t.userId === me.id && t.status === "new");
      if (!allowed) throw new ApiError("forbidden", "Удалить можно только своё новое задание");
      await write("tasks", tasks.filter((x) => x.id !== id));
      await write("votes", (await read("votes", [])).filter((v) => v.taskId !== id));
    },

    /* ---------- Админ ---------- */
    async stats() {
      await requireAdmin();
      const [users, subs, tasks] = await Promise.all([read("users", []), getSubs(), read("tasks", [])]);
      const count = (list, status) => list.filter((x) => x.status === status).length;
      return {
        users: users.length,
        submissions: {
          total: subs.length, pending: count(subs, "pending"), revision: count(subs, "revision"),
          ideal: count(subs, "ideal"), rejected: count(subs, "rejected"),
        },
        tasks: {
          total: tasks.length, new: count(tasks, "new"), accepted: count(tasks, "accepted"),
          live: count(tasks, "live"), done: count(tasks, "done"), rejected: count(tasks, "rejected"),
        },
      };
    },
  };
}
