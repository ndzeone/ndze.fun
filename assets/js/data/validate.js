// Проверка входных данных — общая для обоих бэкендов и для форм на страницах.
// Каждая функция возвращает объект ошибок по полям ({} — всё хорошо).
import { CATEGORIES, GAMES, SUB_STATUSES, TASK_STATUSES, DIFFICULTIES, LIMITS } from "./constants.js";
import { ApiError } from "./errors.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const has = (list, id) => list.some((x) => x.id === id);
const len = (s) => [...String(s ?? "").trim()].length;

export function checkSignUp({ nick, email, password }) {
  const e = {};
  if (!LIMITS.nick.re.test(String(nick ?? "").trim())) e.nick = "3–20 символов: буквы, цифры и _";
  if (!EMAIL_RE.test(String(email ?? "").trim())) e.email = "Похоже, email с ошибкой";
  if (String(password ?? "").length < LIMITS.password.min) e.password = `Минимум ${LIMITS.password.min} символов`;
  return e;
}

export function checkSignIn({ email, password }) {
  const e = {};
  if (!EMAIL_RE.test(String(email ?? "").trim())) e.email = "Похоже, email с ошибкой";
  if (!password) e.password = "Введи пароль";
  return e;
}

export function checkFiles(files, { required = true } = {}) {
  const list = [...(files || [])];
  if (required && !list.length) return "Добавь хотя бы одно изображение";
  if (list.length > LIMITS.files.max) return `Не больше ${LIMITS.files.max} файлов`;
  for (const f of list) {
    if (!LIMITS.files.types.includes(f.type)) return `«${f.name}»: нужен JPG, PNG, WEBP или GIF`;
    if (f.size > LIMITS.files.maxBytes) return `«${f.name}»: файл больше 10 МБ`;
  }
  return "";
}

export function checkSubmission({ title, description, category, files, note }) {
  const e = {};
  if (len(title) < LIMITS.title.min || len(title) > LIMITS.title.max) e.title = `От ${LIMITS.title.min} до ${LIMITS.title.max} символов`;
  if (len(description) > LIMITS.description.max) e.description = `Не больше ${LIMITS.description.max} символов`;
  if (!has(CATEGORIES, category)) e.category = "Выбери категорию";
  if (len(note) > LIMITS.note.max) e.note = `Не больше ${LIMITS.note.max} символов`;
  const f = checkFiles(files);
  if (f) e.files = f;
  return e;
}

export function checkVersion({ files, note }) {
  const e = {};
  const f = checkFiles(files);
  if (f) e.files = f;
  if (len(note) > LIMITS.note.max) e.note = `Не больше ${LIMITS.note.max} символов`;
  return e;
}

export function checkComment(text) {
  const n = len(text);
  return n < LIMITS.comment.min || n > LIMITS.comment.max ? { text: `От 1 до ${LIMITS.comment.max} символов` } : {};
}

export function checkReview({ rating, status }) {
  const e = {};
  if (rating !== undefined && rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) e.rating = "Оценка от 1 до 10";
  if (status !== undefined && !has(SUB_STATUSES, status)) e.status = "Неизвестный статус";
  return e;
}

export function checkTask({ game, title, description, difficulty }) {
  const e = {};
  if (!has(GAMES, game)) e.game = "Выбери игру";
  if (len(title) < LIMITS.title.min || len(title) > LIMITS.title.max) e.title = `От ${LIMITS.title.min} до ${LIMITS.title.max} символов`;
  if (len(description) > LIMITS.description.max) e.description = `Не больше ${LIMITS.description.max} символов`;
  if (!DIFFICULTIES.some((d) => d.id === Number(difficulty))) e.difficulty = "Выбери сложность";
  return e;
}

export function checkTaskUpdate({ status, adminNote }) {
  const e = {};
  if (status !== undefined && !has(TASK_STATUSES, status)) e.status = "Неизвестный статус";
  if (adminNote !== undefined && adminNote !== null && len(adminNote) > LIMITS.note.max) e.adminNote = `Не больше ${LIMITS.note.max} символов`;
  return e;
}

/** Бросает ApiError("validation") с ошибками по полям, если они есть. */
export function assertValid(errors) {
  const keys = Object.keys(errors);
  if (keys.length) throw new ApiError("validation", errors[keys[0]], errors);
}
