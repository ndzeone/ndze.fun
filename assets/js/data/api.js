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
//                  stats: { submissions, ideal, avgRating: number|null, tasks, tasksDone, votesReceived },
//                  progress: { xp, level, title, levelXp, nextLevelXp, badges: [{id,title,description,icon,earned,have,need}] },
//                  points, minecraft: { nick, headUrl } | null, whitelist: [{ id, server, serverName, nick, status, adminNote, createdAt }] }
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
// Движ (в демо-режиме чтение возвращает пустые данные, запись — ApiError validation):
//   api.live()                → { live, channel, title, game, uptime, checkedAt }   // идёт ли стрим (кэш 60 с)
//   api.leaderboard()         → [{ user:{id,nick,avatarUrl}, xp, level, title, badges }]   // топ-10 по XP
//   api.battlePair()          → { pair: [Lean, Lean] | null, total, allVoted? }   Lean = { id, title, category,
//                                authorNick, authorAvatar, imageUrl, rating, wins, losses }
//   api.battleVote(winnerId, loserId) → { winner: Lean, loser: Lean, delta }   (вход; один голос на пару)
//   api.battleTop()           → { week: Lean & { weekWins } | null, top: Lean[] }
//   api.predictions()         → { items: Prediction[], balance: number|null, start }
//                                Prediction = { id, question, options:[{text,pool,bettors}], status: open|locked|resolved|cancelled,
//                                result, totalPool, createdAt, updatedAt, myBet: {option,amount,payout}|null }
//   api.placeBet(id, option, amount)          → { item: Prediction, balance }
//   api.createPrediction({question, options}) / api.updatePrediction(id, "lock"|"open"|"resolve"|"cancel", option?)  (админ)
//   api.canvas()              → { w, h, palette: string[16], data: строка w·h символов 0-f по строкам, version, epoch, wait: сек|null, cooldown }
//   api.canvasChanges(after, epoch) → { version, changes: [[x,y,c]] } | { reset: true }
//   api.canvasLog(after, limit)     → { items: [[id,x,y,c]], more }      // таймлапс текущей эпохи
//   api.placePixel(x, y, c)   → { version, wait }   (вход; 429 rate_limited, fields.wait — сколько секунд ждать)
//   api.clearCanvas()         (админ)
//   api.setMinecraft(nick|null) → { nick, headUrl } | null;  api.avatarFromMinecraft() → User
//   api.whitelistRequest("penta") → { whitelist };  api.whitelist() / api.updateWhitelist(id, status, note)  (админ)
//   api.gameStart()           → { startedAt }   (вход; перед каждым забегом)
//   api.gameScore(score)      → { score, best, rank }   (не больше 80 очков на секунду забега)
//   api.gameTop()             → { all: [{user, score}], week: [{user, score}] }
//   api.forum()               → { sections: [{id,label,adminOnly,canPost,threads,posts,lastPostAt}], news: ThreadLean[], latest: ThreadLean[] }
//                                ThreadLean = { id, section, project, title, excerpt, pinned, locked, replies, views, likes,
//                                author: {id,nick,avatarUrl,isAdmin}, lastPostAt, lastNick, createdAt }
//   api.forumThreads({ section?, project?, q?, page? }) → { items: ThreadLean[], total, page, pages }
//   api.forumThread(id, page|"last") → { thread: { …ThreadLean, body (Markdown), myLike, edited, canEdit, canReply, canModerate },
//                                       posts: { items: [{ id, body, author, likes, myLike, createdAt, edited, canEdit }], page, pages } }
//   api.forumCreateThread({ section, project?, title, body }) → { id }   (news и rules — только админ)
//   api.forumReply(threadId, body) → { id, page };  api.forumEdit("thread"|"post", id, { title?, body })
//   api.forumDelete("thread"|"post", id);  api.forumLike("thread"|"post", id) → { likes, myLike }
//   api.forumModerate(id, { pinned?, locked? })   (админ)
//   api.stream() / api.updateStream({ regenerateKey?, currentTaskId? }) / api.spinWheel()   (админ, пульт)
//   api.overlay(key)          → { currentTask, topTasks, lastWork, wheel, live }   (оверлеи OBS по ключу)
//
// Админ:
//   api.stats()                                  → Stats        (только админ)
// ─────────────────────────────────────────────────────────────────────

import { SITE } from "../config.js";

const php = SITE.backend === "php" ? await import("./php.js") : null;
export const api = php ? php.createPhpBackend() : (await import("./local.js")).createLocalBackend();

/**
 * Прямой вызов маршрута API для модулей фич (assets/js/{play,admin,home,header,profile,overlay}/…):
 *   await apiCall("polls")                                   // GET api/index.php?r=polls
 *   await apiCall("poll/vote", { method: "POST", body: {…} }) // POST JSON (заголовок CSRF ставится сам)
 *   await apiCall("build", { method: "POST", form })          // multipart (FormData)
 * В локальном демо-режиме бросает ApiError("validation") — модули показывают «работает на ndze.fun».
 */
export const apiCall = php
  ? php.call
  : async () => { throw new ApiError("validation", "Это работает на сайте ndze.fun (в локальном демо-режиме нет)"); };

import { ApiError } from "./errors.js";
export { ApiError, toApiError } from "./errors.js";
