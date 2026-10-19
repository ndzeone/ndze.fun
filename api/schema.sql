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
-- avatar_source: 'upload' — загрузил сам, 'discord' — взята из Discord при входе, 'removed' — удалил (из Discord больше не берём).
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
