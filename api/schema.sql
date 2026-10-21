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
