// Единая точка доступа к данным. Страницы импортируют только `api` отсюда
// и не знают, какой бэкенд под капотом (SITE.backend в config.js):
//   • PhpBackend   — PHP + MySQL на хостинге (api/, протокол — API.md);
//   • LocalBackend — демо-режим: IndexedDB этого браузера.
//
// Все методы асинхронные и при ошибке бросают ApiError (см. errors.js).
//
// ───────────────────────────── Контракт ─────────────────────────────
// Типы:
//   User       = { id, nick, email: string|null, role: "admin"|"user", avatarUrl: string|null, createdAt }
//                  // email null — вход через Discord без email; avatarUrl null — показываем первую букву ника
//   Version    = { id, n, imageUrls: string[], note, createdAt }          // n — номер версии с 1
//   Comment    = { id, userId, authorNick, authorAvatar: string|null, isAdmin, text, createdAt }
//   Submission = { id, userId, authorNick, authorAvatar, title, description, category, status, rating: number|null,
//                  createdAt, updatedAt, versions: Version[], comments: Comment[] }
//                  // versions по возрастанию n, comments по возрастанию createdAt
//   Task       = { id, userId, authorNick, authorAvatar, game, title, description, difficulty: 1|2|3, status,
//                  adminNote: string|null, votes: number, myVote: boolean, createdAt, updatedAt }
//   Profile    = { user: User, hasPassword: boolean, discordLinked: boolean,
//                  stats: { submissions, ideal, avgRating: number|null, tasks, tasksDone, votesReceived } }
//   Stats      = { users, submissions: { total, pending, revision, ideal, rejected },
//                  tasks: { total, new, accepted, live, done, rejected } }
//   Справочники id: CATEGORIES / SUB_STATUSES / GAMES / TASK_STATUSES в constants.js
//
// Аккаунт:
//   api.mode                                     → "local" | "php"
//   api.getUser()                                → User | null
//   api.signUp({ nick, email, password })        → User      (email_taken | nick_taken | validation)
//   api.signIn({ email, password })              → User      (invalid_credentials)
//   api.signInWithOAuth("discord")               → void      (уводит на Discord и обратно; в демо-режиме — validation)
//   api.signOut()                                → void
//   api.onAuthChange(cb)                         → unsubscribe()   // cb(User|null) при входе/выходе и смене ника/аватарки
//
// Личный кабинет (нужен вход):
//   api.getProfile()                             → Profile
//   api.updateProfile({ nick })                  → User      (nick_taken | validation | rate_limited)
//   api.changePassword({ currentPassword, newPassword, hasPassword }) → void  (validation: currentPassword — неверный)
//   api.uploadAvatar(file)                       → User      (квадрат 256×256, обрезка по центру)
//   api.removeAvatar()                           → User
//   api.linkDiscord()                            → void      (уводит на Discord; вернёт ?auth=discord_linked)
//   api.unlinkDiscord()                          → Profile   (validation, если нет email+пароля)
//
// Работы на оценку (видит: автор, админ; со статусом "ideal" — все, это публичная галерея):
//   api.listSubmissions({ scope })               scope: "mine" (свои) | "all" (только админ) | "gallery" (ideal, публично)
//                                                → Submission[] (новые сверху по updatedAt; versions/comments включены)
//   api.getSubmission(id)                        → Submission
//   api.createSubmission({ title, description, category, files: File[], note })
//                                                → Submission   (статус "pending", версия 1)
//   api.addVersion(id, { files, note })          → Submission   (только автор; статус → "pending")
//   api.addComment(id, text)                     → Comment      (автор или админ)
//   api.reviewSubmission(id, { rating?, status? })→ Submission  (только админ; rating 1..10 или null)
//   api.deleteSubmission(id)                     → void         (автор или админ)
//
// Задания на стрим (читать могут все, даже без входа):
//   api.listTasks({ game?, status? })            → Task[] (по голосам ↓, затем новые сверху)
//   api.createTask({ game, title, description, difficulty }) → Task   (нужен вход; статус "new")
//   api.toggleVote(id)                           → { votes, myVote }   (нужен вход)
//   api.updateTask(id, { status?, adminNote? })  → Task         (только админ)
//   api.deleteTask(id)                           → void         (автор, пока статус "new", или админ)
//
// Админ:
//   api.stats()                                  → Stats        (только админ)
// ─────────────────────────────────────────────────────────────────────

import { SITE } from "../config.js";

export const api = SITE.backend === "php"
  ? (await import("./php.js")).createPhpBackend()
  : (await import("./local.js")).createLocalBackend();

export { ApiError, toApiError } from "./errors.js";
