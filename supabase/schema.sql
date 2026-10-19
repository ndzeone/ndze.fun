-- ═══════════════════════════════════════════════════════════════════════════
--  Сайт ndze — схема базы Supabase.
--  Как запустить: Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run.
--  Скрипт можно запускать повторно: таблицы не пересоздаются, функции, триггеры
--  и политики обновляются. (CHECK-ограничения у уже созданных таблиц не меняются.)
--
--  Права проверяет база (Row Level Security), а не браузер: anon-ключ публичный,
--  поэтому каждое правило из контракта assets/js/data/api.js продублировано здесь.
--  Ограничения совпадают с LIMITS / справочниками в assets/js/data/constants.js.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────── 1. Таблицы ─────────────────────────────

-- Email-ы, которые получают роль admin (после подтверждения email).
create table if not exists public.admin_emails (
  email      text primary key,
  created_at timestamptz not null default now()
);

-- Профиль = публичная часть аккаунта. Email живёт только в auth.users.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nick       text not null,
  role       text not null default 'user',
  created_at timestamptz not null default now(),
  -- 3–20 символов без пробелов и знаков препинания (кроме _). Точная проверка
  -- «буквы, цифры и _» делается на клиенте (validate.js); здесь — мягкая,
  -- чтобы не зависеть от локали базы и не отклонять кириллицу.
  constraint profiles_nick_check check (
    char_length(nick) between 3 and 20
    and nick ~ '^([^[:space:][:punct:][:cntrl:]]|_)+$'
  ),
  constraint profiles_role_check check (role in ('admin', 'user'))
);
-- Ник уникален без учёта регистра.
create unique index if not exists profiles_nick_lower_idx on public.profiles (lower(nick));

-- Работы на оценку.
create table if not exists public.submissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  title       text not null,
  description text not null default '',
  category    text not null,
  status      text not null default 'pending',
  rating      smallint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint submissions_user_id_fkey foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint submissions_title_check check (char_length(btrim(title)) between 3 and 80),
  constraint submissions_description_check check (char_length(description) <= 1500),
  constraint submissions_category_check check (category in ('art', 'design', 'photo', 'code', 'other')),
  constraint submissions_status_check check (status in ('pending', 'revision', 'ideal', 'rejected')),
  constraint submissions_rating_check check (rating is null or rating between 1 and 10)
);
create index if not exists submissions_user_idx on public.submissions (user_id);
create index if not exists submissions_status_idx on public.submissions (status, updated_at desc);

-- Версии работы (1, 2, 3 …). image_paths — пути в приватном бакете submissions.
create table if not exists public.submission_versions (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null,
  n             integer not null default 1,
  image_paths   text[] not null,
  note          text not null default '',
  created_at    timestamptz not null default now(),
  constraint submission_versions_submission_id_fkey foreign key (submission_id) references public.submissions (id) on delete cascade,
  constraint submission_versions_n_key unique (submission_id, n),
  constraint submission_versions_n_check check (n >= 1),
  constraint submission_versions_images_check check (cardinality(image_paths) between 1 and 5),
  constraint submission_versions_note_check check (char_length(note) <= 500)
);

-- Комментарии к работе (автор работы и админ).
create table if not exists public.submission_comments (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null,
  user_id       uuid not null default auth.uid(),
  text          text not null,
  created_at    timestamptz not null default now(),
  constraint submission_comments_submission_id_fkey foreign key (submission_id) references public.submissions (id) on delete cascade,
  constraint submission_comments_user_id_fkey foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint submission_comments_text_check check (char_length(btrim(text)) between 1 and 1000)
);
create index if not exists submission_comments_submission_idx on public.submission_comments (submission_id, created_at);

-- Задания на стрим.
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  game        text not null,
  title       text not null,
  description text not null default '',
  difficulty  smallint not null,
  status      text not null default 'new',
  admin_note  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tasks_user_id_fkey foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint tasks_game_check check (game in ('minecraft', 'cs2', 'gta5rp')),
  constraint tasks_title_check check (char_length(btrim(title)) between 3 and 80),
  constraint tasks_description_check check (char_length(description) <= 1500),
  constraint tasks_difficulty_check check (difficulty between 1 and 3),
  constraint tasks_status_check check (status in ('new', 'accepted', 'live', 'done', 'rejected')),
  constraint tasks_admin_note_check check (admin_note is null or char_length(admin_note) <= 500)
);
create index if not exists tasks_game_idx on public.tasks (game);
create index if not exists tasks_status_idx on public.tasks (status);

-- Голоса за задания: один голос на пользователя.
create table if not exists public.task_votes (
  task_id    uuid not null,
  user_id    uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint task_votes_pkey primary key (task_id, user_id),
  constraint task_votes_task_id_fkey foreign key (task_id) references public.tasks (id) on delete cascade,
  constraint task_votes_user_id_fkey foreign key (user_id) references public.profiles (id) on delete cascade
);
create index if not exists task_votes_user_idx on public.task_votes (user_id);


-- ───────────────────────── 2. Вспомогательные функции ─────────────────────────

-- Текущий пользователь — админ? (SECURITY DEFINER: читает profiles в обход RLS.)
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- Роль по email: admin, только если email есть в admin_emails И подтверждён.
-- (Иначе кто-нибудь мог бы зарегистрироваться на чужой email и стать админом.)
create or replace function public.role_for(p_email text, p_confirmed_at timestamptz)
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_confirmed_at is not null and exists (
      select 1 from public.admin_emails a
      where lower(btrim(a.email)) = lower(btrim(p_email))
    ) then 'admin'
    else 'user'
  end;
$$;


-- ─────────────────────────── 3. Аккаунты (auth.users) ───────────────────────────

-- Новый пользователь → профиль.
--  • Регистрация по email: ник из signUp({ options: { data: { nick } } }). Если он занят,
--    вставка падает и Supabase вернёт «Database error saving new user»
--    (клиент заранее проверяет ник через nick_available и показывает «Этот ник уже занят»).
--  • Вход через Discord: ника в метаданных нет — берём имя из Discord, чистим до [буквы, цифры, _]
--    и, если такое уже есть, добавляем цифры. Вход через Discord никогда не падает из-за ника.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_nick text := btrim(coalesce(v_meta ->> 'nick', ''));
  v_base text;
  v_try  int := 0;
  v_auto boolean := v_nick = '';
  -- Запасной ник: 'user_' + 15 hex-символов id = 20 символов, практически уникален.
  v_spare text := 'user_' || left(replace(new.id::text, '-', ''), 15);
begin
  if v_auto then
    -- Discord: global_name → full_name → name → user_name
    v_base := coalesce(
      nullif(v_meta -> 'custom_claims' ->> 'global_name', ''),
      nullif(v_meta ->> 'full_name', ''),
      nullif(v_meta ->> 'name', ''),
      nullif(v_meta ->> 'user_name', ''),
      ''
    );
    v_base := left(regexp_replace(v_base, '[^[:alnum:]_]+', '_', 'g'), 16);
    v_base := btrim(v_base, '_');
    if char_length(v_base) < 3 then
      v_base := 'user_' || left(replace(new.id::text, '-', ''), 6);
    end if;
    v_nick := v_base;
    while exists (select 1 from public.profiles p where lower(p.nick) = lower(v_nick)) loop
      v_try := v_try + 1;
      if v_try > 20 then
        v_nick := v_spare;
        exit;
      end if;
      v_nick := left(v_base, 16) || (floor(random() * 9000) + 1000)::int::text;
    end loop;
  end if;
  if char_length(v_nick) < 3 then
    v_nick := 'user_' || left(replace(new.id::text, '-', ''), 8);
  end if;
  begin
    insert into public.profiles (id, nick, role)
    values (new.id, v_nick, public.role_for(new.email, new.email_confirmed_at))
    on conflict (id) do nothing;
  exception when unique_violation then
    -- Ник заняли одновременно с нами. Ник из формы регистрации → ошибка «ник занят»;
    -- сгенерированный (Discord) → запасной, чтобы вход не упал.
    if not v_auto then
      raise;
    end if;
    insert into public.profiles (id, nick, role)
    values (new.id, v_spare, public.role_for(new.email, new.email_confirmed_at))
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Email подтвердили или сменили → пересчитать роль.
create or replace function public.handle_user_updated()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role text := public.role_for(new.email, new.email_confirmed_at);
begin
  update public.profiles set role = v_role
  where id = new.id and role is distinct from v_role;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_user_updated();

-- Изменили список admin_emails → пересчитать роли всех пользователей.
-- Источник правды для админов — именно эта таблица.
create or replace function public.sync_admin_roles()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.profiles p
  set role = public.role_for(u.email, u.email_confirmed_at)
  from auth.users u
  where u.id = p.id
    and p.role is distinct from public.role_for(u.email, u.email_confirmed_at);
  return null;
end;
$$;

drop trigger if exists admin_emails_sync on public.admin_emails;
create trigger admin_emails_sync
  after insert or update or delete on public.admin_emails
  for each statement execute function public.sync_admin_roles();

-- Владелец сайта. (Запуск этого insert также пересчитывает роли через триггер выше.)
insert into public.admin_emails (email) values ('dz2ell.official@gmail.com')
on conflict (email) do nothing;

-- Профили для пользователей, зарегистрированных до запуска схемы (если такие есть).
insert into public.profiles (id, nick, role)
select
  u.id,
  case
    when char_length(btrim(coalesce(u.raw_user_meta_data ->> 'nick', ''))) between 3 and 20
     and btrim(u.raw_user_meta_data ->> 'nick') ~ '^([^[:space:][:punct:][:cntrl:]]|_)+$'
     and not exists (
       select 1 from public.profiles p2
       where lower(p2.nick) = lower(btrim(u.raw_user_meta_data ->> 'nick'))
     )
    then btrim(u.raw_user_meta_data ->> 'nick')
    else 'user_' || left(replace(u.id::text, '-', ''), 8)
  end,
  public.role_for(u.email, u.email_confirmed_at)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict do nothing;


-- ─────────────────────── 4. Триггеры: даты и защита полей ───────────────────────

-- submissions / tasks: created_at ставит сервер, updated_at обновляется при каждом
-- изменении; id, user_id и created_at изменить нельзя.
create or replace function public.touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists submissions_touch on public.submissions;
create trigger submissions_touch
  before insert or update on public.submissions
  for each row execute function public.touch_row();

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before insert or update on public.tasks
  for each row execute function public.touch_row();

-- Оценку и статус работы меняет только админ. (UPDATE и так разрешён только
-- админу политикой ниже — это второй замок.) Серверные SECURITY DEFINER-функции
-- (например, «новая версия → статус pending») выполняются не от anon/authenticated
-- и проходят свободно.
create or replace function public.guard_submission_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not public.is_admin()
     and (new.status is distinct from old.status or new.rating is distinct from old.rating) then
    raise exception 'only admin can change rating or status' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_guard_review on public.submissions;
create trigger submissions_guard_review
  before update on public.submissions
  for each row execute function public.guard_submission_review();

-- created_at для комментариев и голосов — всегда серверное время.
create or replace function public.set_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists submission_comments_created on public.submission_comments;
create trigger submission_comments_created
  before insert on public.submission_comments
  for each row execute function public.set_created_at();

drop trigger if exists task_votes_created on public.task_votes;
create trigger task_votes_created
  before insert on public.task_votes
  for each row execute function public.set_created_at();

-- Новая версия: номер n = последний + 1; картинки только из папки
-- «<автор>/<работа>/»; дата — серверная.
create or replace function public.prepare_submission_version()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner  uuid;
  v_prefix text;
begin
  -- FOR UPDATE: две версии одновременно получат разные номера.
  select s.user_id into v_owner
  from public.submissions s
  where s.id = new.submission_id
  for update;

  if v_owner is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  v_prefix := v_owner::text || '/' || new.submission_id::text || '/';
  if exists (
    select 1 from unnest(new.image_paths) as p(path)
    where p.path is null
       or left(p.path, char_length(v_prefix)) <> v_prefix
       or position('..' in p.path) > 0
  ) then
    raise exception 'image paths must be inside folder %', v_prefix using errcode = '22023';
  end if;

  new.n := coalesce((
    select max(v.n) from public.submission_versions v where v.submission_id = new.submission_id
  ), 0) + 1;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists submission_versions_prepare on public.submission_versions;
create trigger submission_versions_prepare
  before insert on public.submission_versions
  for each row execute function public.prepare_submission_version();

-- После новой версии работа снова «Ждёт оценки» (и поднимается наверх по updated_at).
create or replace function public.after_submission_version()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.submissions set status = 'pending' where id = new.submission_id;
  return null;
end;
$$;

drop trigger if exists submission_versions_after on public.submission_versions;
create trigger submission_versions_after
  after insert on public.submission_versions
  for each row execute function public.after_submission_version();

-- Новый комментарий поднимает работу наверх (updated_at).
create or replace function public.after_submission_comment()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.submissions set updated_at = now() where id = new.submission_id;
  return null;
end;
$$;

drop trigger if exists submission_comments_after on public.submission_comments;
create trigger submission_comments_after
  after insert on public.submission_comments
  for each row execute function public.after_submission_comment();


-- ─────────────────────────── 5. Row Level Security ───────────────────────────

alter table public.admin_emails        enable row level security;
alter table public.profiles            enable row level security;
alter table public.submissions         enable row level security;
alter table public.submission_versions enable row level security;
alter table public.submission_comments enable row level security;
alter table public.tasks               enable row level security;
alter table public.task_votes          enable row level security;

-- Права на таблицы явно (не полагаемся на гранты Supabase по умолчанию; строки всё равно
-- фильтрует RLS ниже). anon нужен select на task_votes: view tasks_feed (security_invoker)
-- читает его для «мой голос» — без политики для anon просто вернёт пусто.
grant select on public.profiles, public.submissions, public.submission_versions,
  public.submission_comments, public.tasks, public.task_votes to anon, authenticated;
grant insert, update, delete on public.submissions, public.submission_versions,
  public.submission_comments, public.tasks, public.task_votes to authenticated;

-- admin_emails: ни одной политики → через API недоступна вообще.
revoke all on public.admin_emails from anon, authenticated;

-- profiles: ник и роль видны всем (нужны для «автор: ник»). Менять через API нельзя —
-- профиль создаёт триггер, роль задаёт admin_emails.
revoke insert, update, delete on public.profiles from anon, authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated
  using (true);

-- submissions: видит автор, админ; со статусом ideal — все (публичная галерея).
drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions
  for select to anon, authenticated
  using (
    status = 'ideal'
    or user_id = (select auth.uid())
    or (select public.is_admin())
  );

-- Создать — только от своего имени, только «Ждёт оценки» и без оценки.
drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and rating is null
  );

-- Изменять (оценка, статус) — только админ.
drop policy if exists submissions_update on public.submissions;
create policy submissions_update on public.submissions
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Удалить — автор или админ.
drop policy if exists submissions_delete on public.submissions;
create policy submissions_delete on public.submissions
  for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- submission_versions: видны вместе с работой; добавляет только автор работы.
drop policy if exists submission_versions_select on public.submission_versions;
create policy submission_versions_select on public.submission_versions
  for select to anon, authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_versions.submission_id
  ));

drop policy if exists submission_versions_insert on public.submission_versions;
create policy submission_versions_insert on public.submission_versions
  for insert to authenticated
  with check (exists (
    select 1 from public.submissions s
    where s.id = submission_versions.submission_id
      and s.user_id = (select auth.uid())
  ));

-- submission_comments: видны вместе с работой; пишут автор работы или админ.
drop policy if exists submission_comments_select on public.submission_comments;
create policy submission_comments_select on public.submission_comments
  for select to anon, authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_comments.submission_id
  ));

drop policy if exists submission_comments_insert on public.submission_comments;
create policy submission_comments_insert on public.submission_comments
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.submissions s
      where s.id = submission_comments.submission_id
        and (s.user_id = (select auth.uid()) or (select public.is_admin()))
    )
  );

-- tasks: читают все, даже без входа.
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to anon, authenticated
  using (true);

-- Создать — после входа, от своего имени, статус «Новое», без заметки админа.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'new'
    and admin_note is null
  );

-- Изменять (статус, заметка) — только админ.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Удалить — автор, пока статус «Новое», или админ.
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete to authenticated
  using (
    (user_id = (select auth.uid()) and status = 'new')
    or (select public.is_admin())
  );

-- task_votes: каждый видит, ставит и снимает только свой голос.
-- (Количество голосов считает task_votes_count — без раскрытия, кто голосовал.)
drop policy if exists task_votes_select on public.task_votes;
create policy task_votes_select on public.task_votes
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists task_votes_insert on public.task_votes;
create policy task_votes_insert on public.task_votes
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists task_votes_delete on public.task_votes;
create policy task_votes_delete on public.task_votes
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ─────────────────────── 6. Лента заданий и RPC-функции ───────────────────────

create or replace function public.task_votes_count(p_task_id uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.task_votes v where v.task_id = p_task_id;
$$;

-- Задания с ником автора, числом голосов и «мой голос». security_invoker —
-- view работает с правами того, кто читает (RLS таблиц продолжает действовать).
drop view if exists public.tasks_feed;
create view public.tasks_feed
with (security_invoker = true)
as
select
  t.id,
  t.user_id,
  p.nick as author_nick,
  t.game,
  t.title,
  t.description,
  t.difficulty,
  t.status,
  t.admin_note,
  t.created_at,
  t.updated_at,
  public.task_votes_count(t.id) as votes,
  exists (
    select 1 from public.task_votes v
    where v.task_id = t.id and v.user_id = auth.uid()
  ) as my_vote
from public.tasks t
join public.profiles p on p.id = t.user_id;

grant select on public.tasks_feed to anon, authenticated;

-- Свободен ли ник (до регистрации, поэтому доступна и без входа).
create or replace function public.nick_available(p_nick text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.profiles p where lower(p.nick) = lower(btrim(p_nick))
  );
$$;

-- Существует ли работа (чтобы отличать «не найдено» от «нет прав»).
create or replace function public.submission_exists(p_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.submissions s where s.id = p_id);
$$;

-- Создать работу и версию 1 одной транзакцией. SECURITY INVOKER: действуют все
-- политики RLS выше (своё имя, статус pending, картинки из своей папки).
create or replace function public.create_submission(
  p_id          uuid,
  p_title       text,
  p_description text,
  p_category    text,
  p_image_paths text[],
  p_note        text
)
returns uuid
language plpgsql security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  insert into public.submissions (id, user_id, title, description, category)
  values (p_id, auth.uid(), btrim(p_title), coalesce(btrim(p_description), ''), p_category);

  insert into public.submission_versions (submission_id, image_paths, note)
  values (p_id, p_image_paths, coalesce(btrim(p_note), ''));

  return p_id;
end;
$$;

-- Поставить / снять голос. Возвращает { votes, myVote }.
create or replace function public.toggle_vote(p_task_id uuid)
returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_mine boolean;
begin
  if v_uid is null then
    raise exception 'auth required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.tasks t where t.id = p_task_id) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  delete from public.task_votes where task_id = p_task_id and user_id = v_uid;
  if found then
    v_mine := false;
  else
    insert into public.task_votes (task_id, user_id) values (p_task_id, v_uid)
    on conflict do nothing;
    v_mine := true;
  end if;

  return jsonb_build_object('votes', public.task_votes_count(p_task_id), 'myVote', v_mine);
end;
$$;

-- Статистика для панели админа (форма Stats из контракта).
create or replace function public.admin_stats()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'submissions', (
      select jsonb_build_object(
        'total',    count(*),
        'pending',  count(*) filter (where status = 'pending'),
        'revision', count(*) filter (where status = 'revision'),
        'ideal',    count(*) filter (where status = 'ideal'),
        'rejected', count(*) filter (where status = 'rejected')
      ) from public.submissions
    ),
    'tasks', (
      select jsonb_build_object(
        'total',    count(*),
        'new',      count(*) filter (where status = 'new'),
        'accepted', count(*) filter (where status = 'accepted'),
        'live',     count(*) filter (where status = 'live'),
        'done',     count(*) filter (where status = 'done'),
        'rejected', count(*) filter (where status = 'rejected')
      ) from public.tasks
    )
  );
end;
$$;

-- Права на функции: служебные (триггерные и role_for) извне вызывать нельзя.
revoke execute on function public.role_for(text, timestamptz)        from public, anon, authenticated;
revoke execute on function public.handle_new_user()                  from public, anon, authenticated;
revoke execute on function public.handle_user_updated()              from public, anon, authenticated;
revoke execute on function public.sync_admin_roles()                 from public, anon, authenticated;
revoke execute on function public.prepare_submission_version()       from public, anon, authenticated;
revoke execute on function public.after_submission_version()         from public, anon, authenticated;
revoke execute on function public.after_submission_comment()         from public, anon, authenticated;

grant execute on function public.is_admin()                          to anon, authenticated;
grant execute on function public.task_votes_count(uuid)              to anon, authenticated;
grant execute on function public.nick_available(text)                to anon, authenticated;
grant execute on function public.submission_exists(uuid)             to anon, authenticated;
revoke execute on function public.create_submission(uuid, text, text, text, text[], text) from public, anon;
grant execute on function public.create_submission(uuid, text, text, text, text[], text) to authenticated;
revoke execute on function public.toggle_vote(uuid)                  from public, anon;
grant execute on function public.toggle_vote(uuid)                   to authenticated;
revoke execute on function public.admin_stats()                      from public, anon;
grant execute on function public.admin_stats()                       to authenticated;


-- ───────────────────────── 7. Хранилище картинок ─────────────────────────

-- Приватный бакет: картинки отдаются только по временным подписанным ссылкам.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'submissions', 'submissions', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Путь файла: <user_id>/<submission_id>/<uuid>.<ext>
--   foldername(name)[1] — id автора, foldername(name)[2] — id работы.

-- Загружать — только в свою папку.
drop policy if exists "submissions_files_insert" on storage.objects;
create policy "submissions_files_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'submissions'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Смотреть — автор, админ, а картинки работ со статусом ideal — все.
drop policy if exists "submissions_files_select" on storage.objects;
create policy "submissions_files_select" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'submissions'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select public.is_admin())
      or exists (
        select 1 from public.submissions s
        where s.id::text = (storage.foldername(name))[2]
          and s.status = 'ideal'
      )
    )
  );

-- Удалять — автор (своя папка) или админ.
drop policy if exists "submissions_files_delete" on storage.objects;
create policy "submissions_files_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'submissions'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select public.is_admin())
    )
  );


-- Обновить кэш схемы API (обычно Supabase делает это сам).
notify pgrst, 'reload schema';
