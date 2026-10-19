// Справочники, общие для всех страниц и обоих бэкендов (демо и PHP/MySQL).
// Значения id сохраняются в базе — не переименовывай их без миграции.

export const ROLES = { admin: "admin", user: "user" };

/** Категории работ на оценку. */
export const CATEGORIES = [
  { id: "art", label: "Арт" },
  { id: "design", label: "Дизайн" },
  { id: "photo", label: "Фото" },
  { id: "code", label: "Код" },
  { id: "other", label: "Другое" },
];

/** Статусы работы на оценку. tone — класс .badge из base.css. */
export const SUB_STATUSES = [
  { id: "pending", label: "Ждёт оценки", tone: "info" },
  { id: "revision", label: "На доработке", tone: "warn" },
  { id: "ideal", label: "Идеал", tone: "lime" },
  { id: "rejected", label: "Отклонено", tone: "danger" },
];

/** Игры для заданий на стрим. */
export const GAMES = [
  { id: "minecraft", label: "Minecraft", short: "MC", color: "#5dd62c" },
  { id: "cs2", label: "CS2", short: "CS2", color: "#ffb02e" },
  { id: "gta5rp", label: "GTA 5 RP · NovaRP", short: "GTA", color: "#4aa8ff", url: "https://novarp.ru/" },
];

/** Статусы заданий. */
export const TASK_STATUSES = [
  { id: "new", label: "Новое", tone: "info" },
  { id: "accepted", label: "Принято", tone: "lime" },
  { id: "live", label: "На стриме", tone: "live" },
  { id: "done", label: "Выполнено", tone: "plain" },
  { id: "rejected", label: "Отклонено", tone: "danger" },
];

export const DIFFICULTIES = [
  { id: 1, label: "Легко" },
  { id: 2, label: "Средне" },
  { id: 3, label: "Хардкор" },
];

/** Ограничения — одинаковые для клиента и сервера (см. api/ и API.md). */
export const LIMITS = {
  nick: { min: 3, max: 20, re: /^[\p{L}\d_]{3,20}$/u },
  password: { min: 8 },
  title: { min: 3, max: 80 },
  description: { max: 1500 },
  comment: { min: 1, max: 1000 },
  note: { max: 500 },
  files: { max: 5, maxBytes: 10 * 1024 * 1024, types: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
  imageMaxSide: 1600,
};

export const byId = (list, id) => list.find((x) => x.id === id);
