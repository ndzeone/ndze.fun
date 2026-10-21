-- Схема базы сайта ndze (MySQL 5.7+/8, MariaDB 10.4+).
-- Применяется автоматически при первом запросе к api (api/lib/db.php → migrate), идемпотентно.
-- Правила для этого файла: каждый запрос заканчивается «;» в конце строки, комментарии — только строками «--».
-- id — UUID v4 строкой (CHAR(36) ascii), время — DATETIME(3) в UTC.

CREATE TABLE IF NOT EXISTS schema_version (
  version INT UNSIGNED NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Пользователи: email+пароль и/или Discord. nick_key — ник в нижнем регистре (mb_strtolower),
-- уникален побайтно (utf8mb4_bin), так что «Ник» и «НИК» — один ник, а «е» и «ё» — разные.
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nick VARCHAR(20) NOT NULL,
  nick_key VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  email VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  discord_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  last_login_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_nick_key (nick_key),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS submissions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  rating TINYINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_sub_user (user_id, updated_at),
  KEY ix_sub_status (status, updated_at),
  KEY ix_sub_updated (updated_at),
  CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS submission_versions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  submission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  n INT UNSIGNED NOT NULL,
  note TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_version_n (submission_id, n),
  CONSTRAINT fk_version_sub FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- Картинки версий. Файл: <storage>/uploads/<file_name>, file_name = <id>.<jpg|png|webp|gif>.
CREATE TABLE IF NOT EXISTS submission_images (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  submission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  file_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  width INT UNSIGNED NOT NULL DEFAULT 0,
  height INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_img_version (version_id, position),
  KEY ix_img_sub (submission_id),
  CONSTRAINT fk_img_version FOREIGN KEY (version_id) REFERENCES submission_versions (id) ON DELETE CASCADE,
  CONSTRAINT fk_img_sub FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS submission_comments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  submission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_comment_sub (submission_id, created_at),
  KEY ix_comment_user (user_id),
  CONSTRAINT fk_comment_sub FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE,
  CONSTRAINT fk_comment_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS tasks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  game VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  difficulty TINYINT UNSIGNED NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'new',
  admin_note TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_task_game (game, status),
  KEY ix_task_status (status),
  KEY ix_task_user (user_id),
  CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS task_votes (
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (task_id, user_id),
  KEY ix_vote_user (user_id),
  CONSTRAINT fk_vote_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_vote_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- Лимиты: счётчик попыток в фиксированном окне. subject — sha256 от IP (с секретом) или id пользователя.
CREATE TABLE IF NOT EXISTS rate_limits (
  action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start INT UNSIGNED NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (action, subject, window_start),
  KEY ix_rl_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_version (version, applied_at) VALUES (1, UTC_TIMESTAMP(3));

-- v2: профиль (личный кабинет). Аватарка: <storage>/avatars/<avatar_file>, квадрат 256×256.
-- avatar_source: 'upload' — загрузил сам, 'discord' — взята из Discord при входе, 'mc' — голова скина Minecraft,
-- 'removed' — удалил (из Discord больше не берём).
-- discord_avatar — хеш аватарки Discord, чтобы не скачивать её заново при каждом входе.
-- discord_unlinked — Discord id, который пользователь отвязал: вход им больше не привязывается к аккаунту по email.
-- auth_epoch — растёт при смене пароля / отвязке Discord; сессии со старым значением считаются вышедшими.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  avatar_file VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  avatar_source VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL,
  discord_avatar VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  discord_unlinked VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  auth_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  KEY ix_profile_unlinked (discord_unlinked),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

INSERT IGNORE INTO schema_version (version, applied_at) VALUES (2, UTC_TIMESTAMP(3));

-- v3: «движ» — настройки, битва работ, ставки, пиксельный холст, Minecraft, вайтлист, игра на 404.
-- Настройки сайта ключ → значение (JSON): ключ оверлеев, текущее задание, последний спин колеса, кэш «в эфире».
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  v MEDIUMTEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Битва работ: рейтинг Эло работ из галереи (ideal) и голоса (один голос пользователя на пару работ).
CREATE TABLE IF NOT EXISTS battle_ratings (
  submission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rating INT NOT NULL DEFAULT 1000,
  wins INT UNSIGNED NOT NULL DEFAULT 0,
  losses INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (submission_id),
  KEY ix_battle_rating (rating),
  CONSTRAINT fk_battle_sub FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS battle_votes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  winner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  loser_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pair_key CHAR(73) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_battle_pair (user_id, pair_key),
  KEY ix_battle_winner (winner_id, created_at),
  KEY ix_battle_created (created_at),
  CONSTRAINT fk_bv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bv_winner FOREIGN KEY (winner_id) REFERENCES submissions (id) ON DELETE CASCADE,
  CONSTRAINT fk_bv_loser FOREIGN KEY (loser_id) REFERENCES submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ставки на стрим (только сайтовые баллы). options — JSON-массив строк, status: open | locked | resolved | cancelled.
CREATE TABLE IF NOT EXISTS predictions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question VARCHAR(160) NOT NULL,
  options TEXT NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  result TINYINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_pred_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- payout: NULL — ставка не рассчитана; при отмене возвращается amount.
CREATE TABLE IF NOT EXISTS prediction_bets (
  prediction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  option_idx TINYINT UNSIGNED NOT NULL,
  amount INT UNSIGNED NOT NULL,
  payout INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (prediction_id, user_id),
  KEY ix_bet_user (user_id),
  CONSTRAINT fk_bet_pred FOREIGN KEY (prediction_id) REFERENCES predictions (id) ON DELETE CASCADE,
  CONSTRAINT fk_bet_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Пиксельный холст 64×64: текущее состояние + журнал (кулдаун, таймлапс, значок «Художник»).
-- epoch растёт при очистке холста (settings.canvas_epoch): таймлапс показывает только текущую эпоху.
CREATE TABLE IF NOT EXISTS canvas_pixels (
  x TINYINT UNSIGNED NOT NULL,
  y TINYINT UNSIGNED NOT NULL,
  color TINYINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (x, y)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS canvas_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  x TINYINT UNSIGNED NOT NULL,
  y TINYINT UNSIGNED NOT NULL,
  color TINYINT UNSIGNED NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  epoch INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_canvas_user (user_id, created_at),
  KEY ix_canvas_epoch (epoch, id),
  CONSTRAINT fk_canvas_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ник Minecraft (уникален без учёта регистра) и заявки в вайтлист.
CREATE TABLE IF NOT EXISTS user_minecraft (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nick VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nick_key VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_mc_nick (nick_key),
  CONSTRAINT fk_mc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whitelist_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nick VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  admin_note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_wl_user (user_id, server),
  KEY ix_wl_status (status, created_at),
  CONSTRAINT fk_wl_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Рекорды мини-игры на странице 404.
CREATE TABLE IF NOT EXISTS game_scores (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  score INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_game_score (score),
  KEY ix_game_user (user_id, score),
  KEY ix_game_created (created_at),
  CONSTRAINT fk_game_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_version (version, applied_at) VALUES (3, UTC_TIMESTAMP(3));

-- v4: форум. Разделы — константа FORUM_SECTIONS в api/lib/forum.php (news и rules пишет только админ).
-- project — id проекта из SITE.projects (config.js) или 'future' / NULL. Тело — Markdown (на клиенте marked + DOMPurify).
CREATE TABLE IF NOT EXISTS forum_threads (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  section VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  pinned TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked TINYINT UNSIGNED NOT NULL DEFAULT 0,
  replies INT UNSIGNED NOT NULL DEFAULT 0,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  last_post_at DATETIME(3) NOT NULL,
  last_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_ft_section (section, pinned, last_post_at),
  KEY ix_ft_last (last_post_at),
  KEY ix_ft_user (user_id),
  CONSTRAINT fk_ft_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ft_last_user FOREIGN KEY (last_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE IF NOT EXISTS forum_posts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thread_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_fp_thread (thread_id, created_at),
  KEY ix_fp_user (user_id),
  CONSTRAINT fk_fp_thread FOREIGN KEY (thread_id) REFERENCES forum_threads (id) ON DELETE CASCADE,
  CONSTRAINT fk_fp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- Лайки тем и сообщений: kind 't' — тема, 'p' — сообщение.
CREATE TABLE IF NOT EXISTS forum_likes (
  kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (kind, target_id, user_id),
  KEY ix_fl_user (user_id),
  CONSTRAINT fk_fl_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_version (version, applied_at) VALUES (4, UTC_TIMESTAMP(3));

-- ===================== v5: 20 фич для стримера и зрителей =====================
-- Общее: журнал баллов (бонусы, магазин, награды), уведомления, косметика (рамки аватарок).
CREATE TABLE IF NOT EXISTS points_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delta INT NOT NULL,
  reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_pl_user (user_id, created_at),
  KEY ix_pl_reason (reason, ref),
  CONSTRAINT fk_pl_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  text VARCHAR(300) NOT NULL,
  link VARCHAR(300) NULL,
  is_read TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_nt_user (user_id, is_read, id),
  CONSTRAINT fk_nt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Подписки на браузерные push-уведомления (Web Push, VAPID). endpoint_hash — sha256(endpoint).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  p256dh VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  topics VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'live',
  created_at DATETIME(3) NOT NULL,
  last_ok_at DATETIME(3) NULL,
  fails INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint (endpoint_hash),
  KEY ix_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  frame VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_cos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Стрим-инструменты: расписание, архив эфиров с таймкодами, цели канала.
CREATE TABLE IF NOT EXISTS stream_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  game VARCHAR(60) NULL,
  starts_at DATETIME(3) NOT NULL,
  duration_min SMALLINT UNSIGNED NOT NULL DEFAULT 180,
  note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_se_start (starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stream_archive (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  game VARCHAR(60) NULL,
  started_at DATETIME(3) NOT NULL,
  vod_url VARCHAR(300) NULL,
  summary TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_sa_start (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stream_marks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  at_seconds INT UNSIGNED NOT NULL,
  label VARCHAR(160) NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'moment',
  ref_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  KEY ix_sm_stream (stream_id, at_seconds),
  CONSTRAINT fk_sm_stream FOREIGN KEY (stream_id) REFERENCES stream_archive (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_goals (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  current_value INT NOT NULL DEFAULT 0,
  target_value INT NOT NULL,
  unit VARCHAR(24) NULL,
  sort INT NOT NULL DEFAULT 0,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Баллы: магазин наград, ежедневный бонус, сезонные команды и награды.
CREATE TABLE IF NOT EXISTS shop_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(80) NOT NULL,
  description VARCHAR(300) NULL,
  icon VARCHAR(16) NULL,
  cost INT UNSIGNED NOT NULL,
  stock INT NULL,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shop_orders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cost INT UNSIGNED NOT NULL,
  note VARCHAR(300) NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  admin_note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_so_status (status, created_at),
  KEY ix_so_user (user_id),
  CONSTRAINT fk_so_item FOREIGN KEY (item_id) REFERENCES shop_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_so_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_claims (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  day DATE NOT NULL,
  streak INT UNSIGNED NOT NULL,
  amount INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, day),
  CONSTRAINT fk_dc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- season — 'YYYY-MM' (сезон = календарный месяц по Москве), team — 'lime' | 'red'.
CREATE TABLE IF NOT EXISTS user_teams (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  season CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  team VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  joined_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, season),
  KEY ix_ut_season (season, team),
  CONSTRAINT fk_ut_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS season_awards (
  season CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  place TINYINT UNSIGNED NOT NULL,
  xp INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (season, user_id),
  CONSTRAINT fk_sa_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Интерактив: опросы, розыгрыши (seed_hash публикуется заранее — розыгрыш проверяем), бинго, квизы, тир-листы.
CREATE TABLE IF NOT EXISTS polls (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question VARCHAR(160) NOT NULL,
  options TEXT NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_poll_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  option_idx TINYINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (poll_id, user_id),
  KEY ix_pv_user (user_id),
  CONSTRAINT fk_pv_poll FOREIGN KEY (poll_id) REFERENCES polls (id) ON DELETE CASCADE,
  CONSTRAINT fk_pv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS giveaways (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  prize VARCHAR(160) NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  seed_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seed CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  winner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  drawn_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_gw_status (status, created_at),
  CONSTRAINT fk_gw_winner FOREIGN KEY (winner_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (giveaway_id, user_id),
  KEY ix_ge_user (user_id),
  CONSTRAINT fk_ge_gw FOREIGN KEY (giveaway_id) REFERENCES giveaways (id) ON DELETE CASCADE,
  CONSTRAINT fk_ge_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bingo_rounds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  items MEDIUMTEXT NOT NULL,
  marked TEXT NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  reward INT UNSIGNED NOT NULL DEFAULT 100,
  created_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_bingo_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bingo_claims (
  round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  place INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (round_id, user_id),
  KEY ix_bc_user (user_id),
  CONSTRAINT fk_bc_round FOREIGN KEY (round_id) REFERENCES bingo_rounds (id) ON DELETE CASCADE,
  CONSTRAINT fk_bc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quizzes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  questions MEDIUMTEXT NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  reward INT UNSIGNED NOT NULL DEFAULT 10,
  created_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_quiz_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_answers (
  quiz_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  answers TEXT NOT NULL,
  score INT UNSIGNED NOT NULL,
  ms INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (quiz_id, user_id),
  KEY ix_qa_user (user_id),
  CONSTRAINT fk_qa_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes (id) ON DELETE CASCADE,
  CONSTRAINT fk_qa_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tierlists (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  items MEDIUMTEXT NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_tl_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tierlist_votes (
  list_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  placement TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (list_id, user_id),
  KEY ix_tv_user (user_id),
  CONSTRAINT fk_tv_list FOREIGN KEY (list_id) REFERENCES tierlists (id) ON DELETE CASCADE,
  CONSTRAINT fk_tv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Сообщество: клипы недели, пасхалки-пауки, постройки Penta.
CREATE TABLE IF NOT EXISTS clips (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(120) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_clip_slug (slug),
  KEY ix_clip_created (created_at),
  CONSTRAINT fk_clip_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clip_votes (
  clip_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (clip_id, user_id),
  KEY ix_cv_user (user_id),
  CONSTRAINT fk_cv_clip FOREIGN KEY (clip_id) REFERENCES clips (id) ON DELETE CASCADE,
  CONSTRAINT fk_cv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quest_finds (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  egg VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, egg),
  CONSTRAINT fk_qf_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Постройки: картинка в <storage>/uploads/<file_name> (тот же конвейер, что у работ).
CREATE TABLE IF NOT EXISTS builds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(80) NOT NULL,
  coords VARCHAR(40) NULL,
  description VARCHAR(500) NULL,
  file_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  width INT UNSIGNED NOT NULL DEFAULT 0,
  height INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'visible',
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_build_created (status, created_at),
  KEY ix_build_user (user_id),
  CONSTRAINT fk_build_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS build_votes (
  build_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (build_id, user_id),
  KEY ix_bv2_user (user_id),
  CONSTRAINT fk_bv2_build FOREIGN KEY (build_id) REFERENCES builds (id) ON DELETE CASCADE,
  CONSTRAINT fk_bv2_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_version (version, applied_at) VALUES (5, UTC_TIMESTAMP(3));
