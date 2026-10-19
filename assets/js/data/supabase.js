// Боевой бэкенд: Supabase (аккаунты, Postgres с RLS, приватное хранилище картинок).
// Семантика, ошибки и формы ответов — как у local.js (контракт — в api.js).
// Права проверяет база (supabase/schema.sql); проверки здесь — только для понятных ошибок.
import { ApiError } from "./errors.js";
import { LIMITS } from "./constants.js";
import {
  assertValid, checkSignUp, checkSignIn, checkSubmission, checkVersion,
  checkComment, checkReview, checkTask, checkTaskUpdate,
} from "./validate.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
const BUCKET = "submissions";
const SIGNED_URL_TTL = 60 * 60; // секунд
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUB_SELECT = [
  "id, user_id, title, description, category, status, rating, created_at, updated_at",
  "author:profiles!submissions_user_id_fkey(nick)",
  "submission_versions(id, n, image_paths, note, created_at)",
  "submission_comments(id, user_id, text, created_at, author:profiles!submission_comments_user_id_fkey(nick, role))",
].join(", ");
const TASK_COLS = "id, user_id, author_nick, game, title, description, difficulty, status, admin_note, created_at, updated_at, votes, my_vote";

/* ---------- Помощники ---------- */
const clean = (s) => String(s ?? "").trim();
const iso = (t) => (t ? new Date(t).toISOString() : t);
const byTime = (a, b) => Date.parse(a) - Date.parse(b);
const fieldErr = (code, fields) => new ApiError(code, undefined, fields);
const emailTaken = () => fieldErr("email_taken", { email: "Этот email уже зарегистрирован" });
const nickTaken = () => fieldErr("nick_taken", { nick: "Этот ник уже занят" });

/** Ошибки supabase-js / PostgREST / Storage / сети → ApiError. */
function mapError(e) {
  if (e instanceof ApiError) return e;
  if (!e) return new ApiError("unknown");
  const msg = String(e.message ?? e.error_description ?? e.error ?? e);
  const details = String(e.details ?? "");
  const code = String(e.code ?? e.error_code ?? "");
  const status = Number(e.status ?? e.statusCode ?? 0);

  if (e.name === "TypeError" || e.name === "AuthRetryableFetchError" ||
      /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(msg)) {
    return new ApiError("network");
  }
  if (status === 429 || /^over_.*_rate_limit$/.test(code) || /rate limit|too many requests/i.test(msg)) {
    return new ApiError("rate_limited");
  }
  // Аккаунт
  if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return new ApiError("invalid_credentials");
  if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) {
    return new ApiError("auth_required", "Сначала подтверди email — ссылка в письме");
  }
  if (code === "user_already_exists" || code === "email_exists" || /already (been )?registered/i.test(msg)) return emailTaken();
  // Триггер профиля упал на уникальном нике (гонка после проверки nick_available).
  if (/database error saving new user/i.test(msg)) return nickTaken();
  if (code === "23505" && /nick/i.test(msg + details)) return nickTaken();
  if (code === "weak_password" || /password should be/i.test(msg)) {
    return new ApiError("validation", "Пароль слишком простой", { password: "Пароль слишком простой" });
  }
  if (code === "email_address_invalid" || /email address .* is invalid|unable to validate email/i.test(msg)) {
    return new ApiError("validation", "Похоже, email с ошибкой", { email: "Похоже, email с ошибкой" });
  }
  if (code === "signup_disabled" || /signups not allowed/i.test(msg)) return new ApiError("forbidden", "Регистрация сейчас закрыта");
  // Сессия / права
  if (code === "28000" || code === "PGRST301" || code === "PGRST302" || code === "session_not_found" ||
      /jwt expired|invalid jwt|auth session missing/i.test(msg)) {
    return new ApiError("auth_required");
  }
  if (code === "42501" || /row-level security|permission denied|unauthorized/i.test(msg) || status === 403) {
    return new ApiError("forbidden");
  }
  if (code === "P0002" || code === "PGRST116" || code === "22P02" || status === 404 || /not found/i.test(msg)) {
    return new ApiError("not_found");
  }
  if (status === 413 || /payload too large|maximum allowed size/i.test(msg)) {
    return new ApiError("validation", "Файл больше 10 МБ", { files: "Файл больше 10 МБ" });
  }
  if (/mime type .* not supported|invalid_mime_type/i.test(msg)) {
    return new ApiError("validation", "Нужен JPG, PNG, WEBP или GIF", { files: "Нужен JPG, PNG, WEBP или GIF" });
  }
  if (["23514", "23502", "22001", "22023", "23503"].includes(code)) return new ApiError("validation");
  return new ApiError("unknown");
}

/** { data, error } → data или бросает ошибку. */
function must({ data, error }) {
  if (error) throw error;
  return data;
}

/** Уменьшает картинку до LIMITS.imageMaxSide (GIF — как есть). Перекодирование заодно убирает EXIF/GPS. */
async function prepareImage(file) {
  if (file.type === "image/gif") return { blob: file, type: "image/gif", ext: "gif" };
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    const m = `«${file.name}»: не получилось открыть картинку`;
    throw new ApiError("validation", m, { files: m });
  }
  const scale = Math.min(1, LIMITS.imageMaxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type, 0.86));
  return { blob, type, ext: type === "image/png" ? "png" : "jpg" };
}

const publicUser = (u) => (u ? { id: u.id, nick: u.nick, email: u.email, role: u.role, createdAt: u.createdAt } : null);

export function createSupabaseBackend({ url, anonKey }) {
  const listeners = new Set();
  let known; // id пользователя, о котором уже знают подписчики (undefined — ещё не инициализировано)
  let profileCache = null; // { id, promise }
  const signed = new Map(); // path → { url, exp }

  /* ---------- Клиент (supabase-js грузится лениво с CDN) ---------- */
  let clientPromise = null;
  function client() {
    clientPromise ??= import(SUPABASE_JS)
      .then(({ createClient }) => {
        const sb = createClient(String(url).replace(/\/+$/, ""), anonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce", storageKey: "ndze-auth" },
        });
        watchAuth(sb);
        return sb;
      })
      .catch((e) => {
        clientPromise = null;
        throw e instanceof ApiError ? e : new ApiError("network", "Не удалось подключиться к базе — проверь интернет");
      });
    return clientPromise;
  }

  function watchAuth(sb) {
    // Точка отсчёта — сессия после инициализации (в т.ч. из ссылки подтверждения email).
    sb.auth.getSession()
      .then(({ data }) => { known ??= data.session?.user?.id ?? null; })
      .catch(() => { known ??= null; });

    sb.auth.onAuthStateChange((_event, session) => {
      if (known === undefined) return; // идёт инициализация — её итог учтёт getSession выше
      const id = session?.user?.id ?? null;
      if (id === known) return; // обновление токена и т.п. — не смена пользователя
      known = id;
      if (!id) profileCache = null;
      // Вызывать supabase внутри колбэка нельзя (дедлок) — откладываем.
      setTimeout(async () => {
        let user = null;
        if (id) {
          try { user = await loadUser(session.user); } catch { return; }
        }
        if (known !== id) return; // пока грузили профиль, пользователь сменился
        listeners.forEach((cb) => { try { cb(publicUser(user)); } catch (err) { console.error(err); } });
      }, 0);
    });
  }

  /** auth.User → наш User (ник и роль — из profiles). Кэшируется на пользователя. */
  function loadUser(authUser, { force = false } = {}) {
    if (!force && profileCache?.id === authUser.id) return profileCache.promise;
    const promise = (async () => {
      const sb = await client();
      const p = must(await sb.from("profiles").select("nick, role, created_at").eq("id", authUser.id).maybeSingle());
      return {
        id: authUser.id,
        nick: p?.nick ?? authUser.user_metadata?.nick ?? String(authUser.email ?? "").split("@")[0],
        email: authUser.email ?? "",
        role: p?.role === "admin" ? "admin" : "user",
        createdAt: iso(p?.created_at ?? authUser.created_at),
      };
    })();
    profileCache = { id: authUser.id, promise };
    promise.catch(() => { if (profileCache?.promise === promise) profileCache = null; });
    return promise;
  }

  async function currentUser() {
    const sb = await client();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data.session ? loadUser(data.session.user) : null;
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

  /* ---------- Картинки ---------- */
  async function uploadImages(sb, userId, submissionId, files) {
    const prepared = await Promise.all([...files].map(prepareImage));
    const results = await Promise.allSettled(prepared.map(async ({ blob, type, ext }) => {
      const path = `${userId}/${submissionId}/${crypto.randomUUID()}.${ext}`;
      must(await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false, cacheControl: "3600" }));
      return path;
    }));
    const paths = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      await removeImages(sb, paths);
      throw failed.reason;
    }
    return paths;
  }

  async function removeImages(sb, paths) {
    if (!paths.length) return;
    try { await sb.storage.from(BUCKET).remove(paths); } catch { /* не критично: останется мусорный файл */ }
    paths.forEach((p) => signed.delete(p));
  }

  /** path → подписанная ссылка (кэш, пока до истечения больше 10 минут). */
  async function signPaths(sb, paths) {
    const nowSec = Date.now() / 1000;
    const need = [...new Set(paths)].filter((p) => !(signed.get(p)?.exp - nowSec > 600));
    if (need.length) {
      const data = must(await sb.storage.from(BUCKET).createSignedUrls(need, SIGNED_URL_TTL));
      for (const d of data || []) {
        if (d.signedUrl && !d.error) signed.set(d.path, { url: d.signedUrl, exp: nowSec + SIGNED_URL_TTL });
      }
    }
    return (p) => signed.get(p)?.url;
  }

  /* ---------- Работы ---------- */
  function mapSubmission(row, urlOf) {
    return {
      id: row.id,
      userId: row.user_id,
      authorNick: row.author?.nick ?? "",
      title: row.title,
      description: row.description ?? "",
      category: row.category,
      status: row.status,
      rating: row.rating ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      versions: [...(row.submission_versions || [])]
        .sort((a, b) => a.n - b.n)
        .map((v) => ({
          id: v.id,
          n: v.n,
          imageUrls: (v.image_paths || []).map(urlOf).filter(Boolean),
          note: v.note ?? "",
          createdAt: iso(v.created_at),
        })),
      comments: [...(row.submission_comments || [])]
        .sort((a, b) => byTime(a.created_at, b.created_at))
        .map((c) => ({
          id: c.id,
          userId: c.user_id,
          authorNick: c.author?.nick ?? "",
          isAdmin: c.author?.role === "admin",
          text: c.text,
          createdAt: iso(c.created_at),
        })),
    };
  }

  async function mapSubmissions(sb, rows) {
    const paths = rows.flatMap((r) => (r.submission_versions || []).flatMap((v) => v.image_paths || []));
    const urlOf = await signPaths(sb, paths);
    return rows.map((r) => mapSubmission(r, urlOf));
  }

  /** Строка работы или ApiError: not_found / нет прав (как в local.js). */
  async function findSub(sb, id, cols, me, forbiddenMsg) {
    if (!UUID_RE.test(String(id))) throw new ApiError("not_found", "Работа не найдена");
    const row = must(await sb.from("submissions").select(cols).eq("id", id).maybeSingle());
    if (row) return row;
    const exists = must(await sb.rpc("submission_exists", { p_id: id }));
    if (!exists) throw new ApiError("not_found", "Работа не найдена");
    throw me ? new ApiError("forbidden", forbiddenMsg) : new ApiError("auth_required");
  }

  async function fetchSubmission(sb, id) {
    const row = must(await sb.from("submissions").select(SUB_SELECT).eq("id", id).single());
    return (await mapSubmissions(sb, [row]))[0];
  }

  /* ---------- Задания ---------- */
  const mapTask = (t) => ({
    id: t.id,
    userId: t.user_id,
    authorNick: t.author_nick ?? "",
    game: t.game,
    title: t.title,
    description: t.description ?? "",
    difficulty: Number(t.difficulty),
    status: t.status,
    adminNote: t.admin_note ?? null,
    votes: Number(t.votes) || 0,
    myVote: Boolean(t.my_vote),
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
  });

  const findTaskRow = async (sb, id, cols) => {
    if (!UUID_RE.test(String(id))) throw new ApiError("not_found", "Задание не найдено");
    const row = must(await sb.from("tasks").select(cols).eq("id", id).maybeSingle());
    if (!row) throw new ApiError("not_found", "Задание не найдено");
    return row;
  };

  /* ---------- Методы контракта ---------- */
  const methods = {
    /* ---------- Аккаунт ---------- */
    async getUser() {
      return publicUser(await currentUser());
    },

    async signUp({ nick, email, password }) {
      assertValid(checkSignUp({ nick, email, password }));
      nick = clean(nick);
      email = clean(email).toLowerCase();
      const sb = await client();
      if (must(await sb.rpc("nick_available", { p_nick: nick })) === false) throw nickTaken();
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { nick }, emailRedirectTo: location.href.split("#")[0] },
      });
      if (error) throw error;
      // При включённом подтверждении email Supabase не говорит «занят», а отдаёт пустого пользователя.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw emailTaken();
      if (!data.session) throw new ApiError("auth_required", "Мы отправили письмо на email — подтверди его и войди");
      return publicUser(await loadUser(data.session.user, { force: true }));
    },

    async signIn({ email, password }) {
      assertValid(checkSignIn({ email, password }));
      const sb = await client();
      const { data, error } = await sb.auth.signInWithPassword({ email: clean(email).toLowerCase(), password });
      if (error) throw error;
      if (!data.session) throw new ApiError("invalid_credentials");
      return publicUser(await loadUser(data.session.user, { force: true }));
    },

    async signInWithOAuth(provider) {
      if (provider !== "discord") throw new ApiError("validation", "Этот способ входа не поддерживается");
      const sb = await client();
      // Уходим на discord.com; после входа Supabase вернёт на эту же страницу с ?code=…
      const url = new URL(location.href);
      url.hash = "";
      for (const p of ["code", "error", "error_code", "error_description"]) url.searchParams.delete(p);
      // Скоупы не передаём: Supabase и так запрашивает у Discord "identify email"
      // (свои scopes он добавляет к стандартным, получились бы дубли).
      const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: url.toString() } });
      if (error) throw error;
    },

    async signOut() {
      const sb = await client();
      const { error } = await sb.auth.signOut({ scope: "local" });
      profileCache = null;
      if (error && !/session/i.test(String(error.message))) throw error;
    },

    /* ---------- Работы на оценку ---------- */
    async listSubmissions({ scope = "mine" } = {}) {
      const sb = await client();
      let q = sb.from("submissions").select(SUB_SELECT);
      if (scope === "gallery") q = q.eq("status", "ideal");
      else if (scope === "all") await requireAdmin();
      else q = q.eq("user_id", (await requireUser()).id);
      const rows = must(await q.order("updated_at", { ascending: false }));
      return mapSubmissions(sb, rows || []);
    },

    async getSubmission(id) {
      const sb = await client();
      const me = await currentUser();
      const row = await findSub(sb, id, SUB_SELECT, me);
      return (await mapSubmissions(sb, [row]))[0];
    },

    async createSubmission({ title, description = "", category, files, note = "" }) {
      const me = await requireUser();
      assertValid(checkSubmission({ title, description, category, files, note }));
      const sb = await client();
      const id = crypto.randomUUID();
      const paths = await uploadImages(sb, me.id, id, files);
      try {
        must(await sb.rpc("create_submission", {
          p_id: id,
          p_title: clean(title),
          p_description: clean(description),
          p_category: category,
          p_image_paths: paths,
          p_note: clean(note),
        }));
      } catch (e) {
        await removeImages(sb, paths);
        throw e;
      }
      return fetchSubmission(sb, id);
    },

    async addVersion(id, { files, note = "" }) {
      const me = await requireUser();
      assertValid(checkVersion({ files, note }));
      const sb = await client();
      const forbidden = "Новую версию может загрузить только автор";
      const s = await findSub(sb, id, "id, user_id", me, forbidden);
      if (s.user_id !== me.id) throw new ApiError("forbidden", forbidden);
      const paths = await uploadImages(sb, me.id, id, files);
      try {
        // Номер версии, статус "pending" и updated_at выставляют триггеры в базе.
        must(await sb.from("submission_versions").insert({ submission_id: id, image_paths: paths, note: clean(note) }));
      } catch (e) {
        await removeImages(sb, paths);
        throw e;
      }
      return fetchSubmission(sb, id);
    },

    async addComment(id, text) {
      const me = await requireUser();
      assertValid(checkComment(text));
      const sb = await client();
      const s = await findSub(sb, id, "id, user_id", me);
      if (me.role !== "admin" && s.user_id !== me.id) throw new ApiError("forbidden");
      const row = must(await sb.from("submission_comments")
        .insert({ submission_id: id, user_id: me.id, text: clean(text) })
        .select("id, user_id, text, created_at")
        .single());
      return {
        id: row.id, userId: row.user_id, authorNick: me.nick, isAdmin: me.role === "admin",
        text: row.text, createdAt: iso(row.created_at),
      };
    },

    async reviewSubmission(id, { rating, status } = {}) {
      await requireAdmin();
      assertValid(checkReview({ rating, status }));
      const sb = await client();
      if (!UUID_RE.test(String(id))) throw new ApiError("not_found", "Работа не найдена");
      const patch = {};
      if (rating !== undefined) patch.rating = rating;
      if (status !== undefined) patch.status = status;
      if (!Object.keys(patch).length) patch.updated_at = new Date().toISOString(); // триггер поставит now()
      const rows = must(await sb.from("submissions").update(patch).eq("id", id).select("id"));
      if (!rows?.length) throw new ApiError("not_found", "Работа не найдена");
      return fetchSubmission(sb, id);
    },

    async deleteSubmission(id) {
      const me = await requireUser();
      const sb = await client();
      const s = await findSub(sb, id, "id, user_id, submission_versions(image_paths)", me);
      if (me.role !== "admin" && s.user_id !== me.id) throw new ApiError("forbidden");
      const rows = must(await sb.from("submissions").delete().eq("id", id).select("id"));
      if (!rows?.length) throw new ApiError("forbidden");
      await removeImages(sb, (s.submission_versions || []).flatMap((v) => v.image_paths || []));
    },

    /* ---------- Задания на стрим ---------- */
    async listTasks({ game, status } = {}) {
      const sb = await client();
      let q = sb.from("tasks_feed").select(TASK_COLS);
      if (game) q = q.eq("game", game);
      if (status) q = q.eq("status", status);
      const rows = must(await q.order("votes", { ascending: false }).order("created_at", { ascending: false }));
      return (rows || []).map(mapTask);
    },

    async createTask({ game, title, description = "", difficulty }) {
      const me = await requireUser();
      assertValid(checkTask({ game, title, description, difficulty }));
      const sb = await client();
      const row = must(await sb.from("tasks")
        .insert({ user_id: me.id, game, title: clean(title), description: clean(description), difficulty: Number(difficulty) })
        .select("id, user_id, game, title, description, difficulty, status, admin_note, created_at, updated_at")
        .single());
      return mapTask({ ...row, author_nick: me.nick, votes: 0, my_vote: false });
    },

    async toggleVote(id) {
      await requireUser();
      if (!UUID_RE.test(String(id))) throw new ApiError("not_found", "Задание не найдено");
      const sb = await client();
      let res;
      try {
        res = must(await sb.rpc("toggle_vote", { p_task_id: id }));
      } catch (e) {
        const err = mapError(e);
        throw err.code === "not_found" ? new ApiError("not_found", "Задание не найдено") : err;
      }
      return { votes: Number(res?.votes) || 0, myVote: Boolean(res?.myVote) };
    },

    async updateTask(id, { status, adminNote } = {}) {
      await requireAdmin();
      assertValid(checkTaskUpdate({ status, adminNote }));
      const sb = await client();
      if (!UUID_RE.test(String(id))) throw new ApiError("not_found", "Задание не найдено");
      const patch = {};
      if (status !== undefined) patch.status = status;
      if (adminNote !== undefined) patch.admin_note = adminNote === null ? null : clean(adminNote) || null;
      if (!Object.keys(patch).length) patch.updated_at = new Date().toISOString(); // триггер поставит now()
      const rows = must(await sb.from("tasks").update(patch).eq("id", id).select("id"));
      if (!rows?.length) throw new ApiError("not_found", "Задание не найдено");
      return mapTask(must(await sb.from("tasks_feed").select(TASK_COLS).eq("id", id).single()));
    },

    async deleteTask(id) {
      const me = await requireUser();
      const sb = await client();
      const t = await findTaskRow(sb, id, "id, user_id, status");
      const forbidden = "Удалить можно только своё новое задание";
      const allowed = me.role === "admin" || (t.user_id === me.id && t.status === "new");
      if (!allowed) throw new ApiError("forbidden", forbidden);
      const rows = must(await sb.from("tasks").delete().eq("id", id).select("id"));
      if (!rows?.length) throw new ApiError("forbidden", forbidden);
    },

    /* ---------- Админ ---------- */
    async stats() {
      await requireAdmin();
      const sb = await client();
      const s = must(await sb.rpc("admin_stats"));
      const n = (v) => Number(v) || 0;
      return {
        users: n(s?.users),
        submissions: {
          total: n(s?.submissions?.total), pending: n(s?.submissions?.pending), revision: n(s?.submissions?.revision),
          ideal: n(s?.submissions?.ideal), rejected: n(s?.submissions?.rejected),
        },
        tasks: {
          total: n(s?.tasks?.total), new: n(s?.tasks?.new), accepted: n(s?.tasks?.accepted),
          live: n(s?.tasks?.live), done: n(s?.tasks?.done), rejected: n(s?.tasks?.rejected),
        },
      };
    },
  };

  // Каждый метод бросает только ApiError.
  const backend = { mode: "supabase" };
  for (const [name, fn] of Object.entries(methods)) {
    backend[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        throw mapError(e);
      }
    };
  }

  backend.onAuthChange = (cb) => {
    listeners.add(cb);
    client().catch(() => { /* офлайн: событий не будет, методы вернут ApiError("network") */ });
    return () => listeners.delete(cb);
  };

  // Сразу начинаем грузить клиент и восстанавливать сессию.
  client().catch(() => {});

  return backend;
}
