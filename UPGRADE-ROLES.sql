-- HELD v7 | ONE-TIME MIGRATION. Run in the EXISTING Supabase project's SQL Editor.
-- Preserves rooms, signals, storage, existing work, recording consent and WebRTC.
-- Only expands role state and the permissions required for genuine swapping.

alter table public.rooms
  add column if not exists holder_role text not null default 'A'
    check (holder_role in ('A','B'));
alter table public.rooms
  add column if not exists swap_requested_by text
    check (swap_requested_by in ('A','B'));
grant select on public.rooms to authenticated;
grant update (holder_role, swap_requested_by) on public.rooms to authenticated;

create or replace function public.guard_room_update()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  sculptor_role text;
  old_length integer;
  new_length integer;
  last_item jsonb;
  i integer;
begin
  if actor is null then raise exception 'Login required'; end if;
  if new.id <> old.id or new.player_a <> old.player_a or new.created_at <> old.created_at then
    raise exception 'Immutable room identity';
  end if;
  -- Preserve the original atomic join_room RPC behaviour.
  if old.player_b is null and new.player_b = actor
     and (to_jsonb(new)-'player_b') = (to_jsonb(old)-'player_b') then
    return new;
  end if;
  if new.player_b is distinct from old.player_b then
    raise exception 'Room participants cannot be changed';
  end if;
  if actor = old.player_a then actor_role := 'A';
  elsif actor = old.player_b then actor_role := 'B';
  else raise exception 'You are not a member of this room';
  end if;
  sculptor_role := case when old.holder_role='A' then 'B' else 'A' end;

  -- Never let either participant modify the other's word, camera consent or ready state.
  if actor_role='A' then
    if new.ready_b is distinct from old.ready_b or new.word_b is distinct from old.word_b
       or new.filming_ok_b is distinct from old.filming_ok_b then
      raise exception 'Player A cannot change Player B settings';
    end if;
    if new.phase is distinct from old.phase and not (
      (old.phase='making' and new.phase='finish_requested') or
      (old.phase='finish_requested' and new.phase='making')
    ) then raise exception 'Invalid Player A phase transition'; end if;
  else
    if new.ready_a is distinct from old.ready_a or new.word_a is distinct from old.word_a
       or new.filming_ok_a is distinct from old.filming_ok_a or new.width is distinct from old.width
       or new.letter is distinct from old.letter then
      raise exception 'Player B cannot change Player A settings';
    end if;
    if new.phase is distinct from old.phase and not (
      old.phase='finish_requested' and new.phase='review'
    ) then raise exception 'Invalid Player B phase transition'; end if;
  end if;

  -- Only current Holder may publish the shared camera/orbit state.
  if new.steer is distinct from old.steer and actor_role <> old.holder_role then
    raise exception 'Only the current Holder can turn the 3D object';
  end if;

  -- Accept either a single appended stage marker (Player A navigates),
  -- or 1-2 appended deformation operations (current Sculptor only).
  -- This blocks overwriting history and prevents the v6 stage-reset bug.
  if new.path is distinct from old.path then
    if old.phase <> 'making' or jsonb_typeof(new.path) <> 'array' then
      raise exception 'Cannot edit the finished sculpture';
    end if;
    old_length := jsonb_array_length(old.path);
    new_length := jsonb_array_length(new.path);
    if new_length <= old_length or new_length > old_length+2 then
      raise exception 'Sculpting edits must be appended, never overwritten';
    end if;
    -- A JSONB array with its trailing items removed must match the old path.
    if new.path - (new_length-1) <> old.path and
       not (new_length=old_length+2 and
         (new.path - (new_length-1) - (new_length-2))=old.path) then
      raise exception 'Sculpting edits cannot alter earlier movements';
    end if;
    for i in old_length..new_length-1 loop
      last_item := new.path->i;
      if last_item->>'kind'='stage' then
        if actor_role <> 'A' or new_length <> old_length+1 or
           last_item->>'stroke' not in ('vertical','horizontal','curve') then
          raise exception 'Only Player A may switch strokes';
        end if;
      elsif last_item->>'kind'='clay' then
        if actor_role <> sculptor_role or
           jsonb_typeof(last_item->'at') <> 'array' or
           jsonb_typeof(last_item->'delta') <> 'array' or
           last_item->>'stroke' not in ('vertical','horizontal','curve') then
          raise exception 'Only the current Sculptor may deform the clay';
        end if;
      else
        raise exception 'Unexpected sculpting event';
      end if;
    end loop;
  end if;

  -- Both people must agree before tool ownership switches.
  if new.holder_role is distinct from old.holder_role then
    if old.swap_requested_by is null or old.swap_requested_by = actor_role or
       new.holder_role <> sculptor_role or new.swap_requested_by is not null or
       old.phase <> 'making' then
      raise exception 'A role swap requires the other participant to accept';
    end if;
  elsif new.swap_requested_by is distinct from old.swap_requested_by then
    if old.phase <> 'making' or not (
      (old.swap_requested_by is null and new.swap_requested_by=actor_role) or
      (old.swap_requested_by=actor_role and new.swap_requested_by is null)
    ) then raise exception 'Invalid role-swap request'; end if;
  end if;

  return new;
end;
$$;

-- Atomic append: appends one or two dab ops without rewriting earlier stages.
-- Uses the existing row-lock, and the trigger enforces Sculptor authorization.
create or replace function public.append_clay_ops(p_room uuid, p_ops jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  r public.rooms%rowtype;
  n integer;
  current_stroke text := 'vertical';
  item jsonb;
  n_on_stroke integer := 0;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if jsonb_typeof(p_ops)<>'array' then raise exception 'Expected array of operations'; end if;
  n := jsonb_array_length(p_ops);
  if n<1 or n>2 then raise exception '1 or 2 operations per frame'; end if;
  select * into r from public.rooms where id=p_room for update;
  if not found or auth.uid() not in (r.player_a,r.player_b) then raise exception 'Not a room member'; end if;
  if r.phase<>'making' then raise exception 'Not in sculpting phase'; end if;
  if (r.holder_role='A' and auth.uid()<>r.player_b) or
     (r.holder_role='B' and auth.uid()<>r.player_a) then
    raise exception 'Only the current Sculptor may deform';
  end if;
  for item in select value from jsonb_array_elements(r.path) loop
    if item->>'kind'='stage' then current_stroke:=item->>'stroke'; end if;
  end loop;
  for item in select value from jsonb_array_elements(r.path) loop
    if item->>'kind'='clay' and coalesce(item->>'stroke','vertical')=current_stroke then
      n_on_stroke:=n_on_stroke+1;
    end if;
  end loop;
  if n_on_stroke+n>240 then raise exception 'This stroke reached its 240-move prototype limit'; end if;
  for item in select value from jsonb_array_elements(p_ops) loop
    if item->>'kind'<>'clay' or item->>'stroke'<>current_stroke or
       jsonb_typeof(item->'at')<>'array' or jsonb_array_length(item->'at')<>3 or
       jsonb_typeof(item->'delta')<>'array' or jsonb_array_length(item->'delta')<>3 then
      raise exception 'Invalid clay operation for the active stroke';
    end if;
  end loop;
  update public.rooms set path=r.path||p_ops where id=p_room returning path into r.path;
  return r.path;
end;
$$;
grant execute on function public.append_clay_ops(uuid,jsonb) to authenticated;
