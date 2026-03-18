Window 1 (SQL Editor — Tables, triggers, indexes)
---------------------------------------------------

-- Profiles: one row per user, stores display username
create table public.profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    username    text not null unique
                     constraint username_format check (username ~ '^[a-zA-Z0-9_]{2,24}$'),
    status_text text default null
                     constraint status_text_length check (char_length(trim(status_text)) <= 100),
    created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Trigger: auto-insert profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
    insert into public.profiles (id, username)
    values (
        new.id,
        coalesce(
            new.raw_user_meta_data ->> 'username',
            'user_' || left(new.id::text, 8)
        )
    );
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- Messages: 1-to-1 messages between users
create table public.messages (
    id           bigserial primary key,
    sender_id    uuid not null references auth.users(id) on delete cascade,
    recipient_id uuid not null references auth.users(id) on delete cascade,
    body         text not null
                      constraint body_length check (char_length(trim(body)) between 1 and 10000),
    created_at   timestamptz not null default now()
);
alter table public.messages enable row level security;

-- Indexes for fast conversation lookup (covers both query directions)
create index messages_sender_recipient_idx
    on public.messages (sender_id, recipient_id, created_at);
create index messages_recipient_sender_idx
    on public.messages (recipient_id, sender_id, created_at);


Window 2 (SQL Editor — RLS Policies)
--------------------------------------

-- Profiles: anyone logged in can read all profiles (needed for contacts list)
create policy "profiles: authenticated users can read all"
    on public.profiles for select to authenticated using (true);

create policy "profiles: owner can update"
    on public.profiles for update to authenticated using (auth.uid() = id);

-- Messages: only participants can read their own messages
create policy "messages: participants can read"
    on public.messages for select to authenticated
    using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- Messages: can only insert as yourself
create policy "messages: sender can insert"
    on public.messages for insert to authenticated
    with check (auth.uid() = sender_id);

-- Messages: block updates and deletes entirely
create policy "messages: no updates"
    on public.messages for update to authenticated
    using (false);

create policy "messages: no deletes"
    on public.messages for delete to authenticated
    using (false);


Window 3 (SQL Editor — Realtime)
---------------------------------

alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table profiles;


================================================================================
MIGRATION — paste this into a SINGLE Supabase SQL Editor window and hit "Run"
================================================================================
-- This upgrades your existing tables. Run it ONCE. If you run it again it will
-- throw errors about things already existing, which is harmless but noisy.
--
-- Order matters: constraints before indexes, indexes before policies.
--------------------------------------------------------------------------------


-- ============================================
-- 1. FIX THE SIGNUP TRIGGER (safe to re-run)
-- ============================================
-- If someone signs up without a username in metadata, the old trigger crashes
-- and the signup fails entirely. This version falls back to "user_<8 chars>".

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
    insert into public.profiles (id, username)
    values (
        new.id,
        coalesce(
            new.raw_user_meta_data ->> 'username',
            'user_' || left(new.id::text, 8)
        )
    );
    return new;
end;
$$;


-- ============================================
-- 2. ADD CONSTRAINTS
-- ============================================
-- Username: only letters, numbers, underscore, 2-24 chars long
alter table public.profiles
    add constraint username_format
    check (username ~ '^[a-zA-Z0-9_]{2,24}$');

-- Message body: must be 1-10,000 characters (after trimming whitespace)
alter table public.messages
    add constraint body_length
    check (char_length(trim(body)) between 1 and 10000);


-- ============================================
-- 3. REPLACE THE INDEX
-- ============================================
-- The old index casts UUIDs to text which is slow. These two cover both
-- directions of a conversation query without casting.

drop index if exists public.messages_conversation_idx;

create index if not exists messages_sender_recipient_idx
    on public.messages (sender_id, recipient_id, created_at);

create index if not exists messages_recipient_sender_idx
    on public.messages (recipient_id, sender_id, created_at);


-- ============================================
-- 4. ADD MISSING RLS POLICIES
-- ============================================
-- Without these, UPDATE and DELETE are denied by default in Supabase,
-- but explicit policies make the intent clear and protect against
-- config changes.

do $$
begin
    -- only create if it doesn't already exist
    if not exists (
        select 1 from pg_policies
        where tablename = 'messages' and policyname = 'messages: no updates'
    ) then
        execute $pol$
            create policy "messages: no updates"
                on public.messages for update to authenticated
                using (false)
        $pol$;
    end if;

    if not exists (
        select 1 from pg_policies
        where tablename = 'messages' and policyname = 'messages: no deletes'
    ) then
        execute $pol$
            create policy "messages: no deletes"
                on public.messages for delete to authenticated
                using (false)
        $pol$;
    end if;
end
$$;


-- ============================================
-- 5. ADD STATUS TEXT TO PROFILES
-- ============================================
-- Allows users to set a status message via /status command.

alter table public.profiles
    add column if not exists status_text text default null
    constraint status_text_length check (char_length(trim(status_text)) <= 100);

-- ============================================
-- 6. ADD LOCKED MESSAGE FUNCTIONALITY
-- ============================================
-- Adds the `locked` column to messages and channel_messages tables.
-- Updates RLS policies to allow updating the locked state.
-- Sets replica identity to FULL so realtime gets the payload.old state.

alter table public.messages 
    add column if not exists locked boolean not null default false;

alter table public.channel_messages 
    add column if not exists locked boolean not null default false;

-- Required for realtime subscriptions to receive payload.old
alter table public.messages replica identity full;
alter table public.channel_messages replica identity full;

-- Drop strict 'no updates' policies to allow locking
drop policy if exists "messages: no updates" on public.messages;
drop policy if exists "channel_messages: no updates" on public.channel_messages;

-- Create policies to allow updates (specifically for toggling locked state)
create policy "messages: allow updates for locking"
    on public.messages for update to authenticated
    using (true);

create policy "channel_messages: allow updates for locking"
    on public.channel_messages for update to authenticated
    using (true);


-- ============================================
-- 7. ADD COLOR_ID TO PROFILES
-- ============================================
-- Stores the user's chosen identity color as a curated palette index (1-9).
-- Defaults to 1 (Standard Gray) for all existing users.

alter table public.profiles
    add column if not exists color_id smallint not null default 1
    constraint color_id_range check (color_id between 1 and 9);

