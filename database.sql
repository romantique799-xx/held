-- TOGETHER / TYPE — Supabase SQL setup. Run in SQL Editor once.
-- Prerequisite: Auth > Providers > Anonymous sign-ins ENABLED.
-- This is an invitation-link proof of concept, not a public user-account system.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references auth.users(id),
  player_b uuid references auth.users(id),
  created_at timestamptz not null default now(),
  path jsonb not null default '[]'::jsonb,
  steer jsonb not null default '{"yaw":0,"pitch":0,"active":false}'::jsonb,
  width numeric not null default 0.085,
  letter text not null default 'L',
  phase text not null default 'making' check (phase in ('making','finish_requested','review')),
  word_a text,
  word_b text,
  filming_ok_a boolean not null default false,
  filming_ok_b boolean not null default false,
  ready_a boolean not null default false,
  ready_b boolean not null default false,
  constraint rooms_two_distinct_people check (player_b is null or player_a <> player_b)
);

create table if not exists public.signals (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender uuid not null references auth.users(id),
  message jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists signals_room_idx on public.signals (room_id, id);

alter table public.rooms enable row level security;
alter table public.signals enable row level security;

create or replace function public.in_room(room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.rooms r
    where r.id = room_id and auth.uid() in (r.player_a,r.player_b));
$$;
revoke all on function public.in_room(uuid) from public;
grant execute on function public.in_room(uuid) to authenticated;

-- Membership is assigned by atomic RPC, not by arbitrary client updates.
create or replace function public.create_room()
returns uuid language plpgsql security definer set search_path = public as $$
declare result uuid;
begin
  if auth.uid() is null then raise exception 'Sign in before creating room'; end if;
  insert into public.rooms(player_a) values(auth.uid()) returning id into result;
  return result;
end;
$$;

create or replace function public.join_room(p_room uuid)
returns text language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in before joining room'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found then raise exception 'Room does not exist'; end if;
  if r.player_a = auth.uid() then return 'A'; end if;
  if r.player_b = auth.uid() then return 'B'; end if;
  if r.player_b is not null then raise exception 'Room is full (2 participants maximum)'; end if;
  update public.rooms set player_b=auth.uid() where id=p_room;
  return 'B';
end;
$$;
revoke all on function public.create_room() from public;
revoke all on function public.join_room(uuid) from public;
grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room(uuid) to authenticated;

grant select on public.rooms to authenticated;
-- Not even a malicious client may directly claim a different participant slot.
revoke update on public.rooms from authenticated;
grant update (path, steer, width, letter, phase, word_a, word_b, filming_ok_a, filming_ok_b, ready_a, ready_b)
  on public.rooms to authenticated;
grant select, insert on public.signals to authenticated;
grant usage, select on sequence public.signals_id_seq to authenticated;
-- Read only your own room; only A may write stroke points and settings,
-- only B may steer. State changes to finished are allowed only from B.
drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select to authenticated
using (auth.uid() in (player_a,player_b));

drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
using (auth.uid() in (player_a,player_b))
with check (auth.uid() in (player_a,player_b));
-- Fine-grained constraints are additionally checked by guard_room_update below.

drop policy if exists signals_read on public.signals;
create policy signals_read on public.signals for select to authenticated
using (public.in_room(room_id));
drop policy if exists signals_write on public.signals;
create policy signals_write on public.signals for insert to authenticated
with check (sender=auth.uid() and public.in_room(room_id)
            and jsonb_typeof(message) = 'object');

-- Stop one member from forging the other person's camera-recording consent,
-- private word, ready status, or role-specific input. Validate against OLD row.
create or replace function public.guard_room_update()
returns trigger language plpgsql security definer set search_path=public as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Login required'; end if;
  if new.id <> old.id or new.player_a <> old.player_a or new.created_at <> old.created_at then
    raise exception 'Immutable room identity';
  end if;
  -- The server-side join_room RPC is the sole normal way to fill slot B.
  if old.player_b is null and new.player_b = actor
     and (to_jsonb(new) - 'player_b') = (to_jsonb(old) - 'player_b') then
    return new;
  end if;
  if new.player_b is distinct from old.player_b then
    raise exception 'Room participants cannot be changed';
  end if;
  if actor = old.player_a then
    if new.steer is distinct from old.steer
      or new.ready_b is distinct from old.ready_b
      or new.word_b is distinct from old.word_b
      or new.filming_ok_b is distinct from old.filming_ok_b then
      raise exception 'Player A cannot change Player B settings';
    end if;
    if new.phase is distinct from old.phase and not (
      (old.phase='making' and new.phase='finish_requested') or
      (old.phase='finish_requested' and new.phase='making')
    ) then raise exception 'Player A cannot make this phase transition'; end if;
  elsif actor = old.player_b then
    if new.path is distinct from old.path
      or new.width is distinct from old.width
      or new.letter is distinct from old.letter
      or new.ready_a is distinct from old.ready_a
      or new.word_a is distinct from old.word_a
      or new.filming_ok_a is distinct from old.filming_ok_a then
      raise exception 'Player B cannot change Player A settings';
    end if;
    if new.phase is distinct from old.phase and not (
      old.phase='finish_requested' and new.phase='review'
    ) then raise exception 'Player B cannot make this phase transition'; end if;
  else
    raise exception 'You are not a member of this room';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_room_updates on public.rooms;
create trigger guard_room_updates before update on public.rooms
for each row execute function public.guard_room_update();

-- Realtime for the two tables (the block is safe to rerun).
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='signals') then
    alter publication supabase_realtime add table public.signals;
  end if;
end $$;

-- Files are private, stored at ROOM_UUID/USER_UUID/filename.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('submissions','submissions',false,10485760,
       array['image/png','image/svg+xml','application/json'])
on conflict(id) do nothing;

drop policy if exists submit_write on storage.objects;
create policy submit_write on storage.objects for insert to authenticated
with check (
  bucket_id='submissions'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and (storage.foldername(name))[2]=auth.uid()::text
  and public.in_room(((storage.foldername(name))[1])::uuid)
);

drop policy if exists submit_read on storage.objects;
create policy submit_read on storage.objects for select to authenticated
using (
  bucket_id='submissions'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.in_room(((storage.foldername(name))[1])::uuid)
);

-- The project owner can view/download all private submissions from Supabase Dashboard
-- Storage > submissions (with their project admin account).
