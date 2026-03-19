# The Eye

A realtime, Supabase-backed web chat built with plain HTML/CSS/JS. Includes:
- 1-to-1 DMs (stored in `public.messages`)
- A public `#GLOBAL` channel (stored in `public.channel_messages`)

## Features
- Supabase Auth login (username/password)
- Realtime DM updates (new messages appear instantly)
- Realtime public channel (`#GLOBAL`)
- Presence dots (online/offline)
- Typing indicator (broadcast)
- Slash commands: `/help`, `/who`, `/clear`, `/lock [n]`, `/top`, `/color list`, `/color set <number>`, `/theme list`, `/theme set <name>`, `/mute`
- UI themes and curated identity colors

## Tech
- Frontend: `index.html`, `java.js`, `style.css` (static site)
- Backend: Supabase (Postgres + RLS + Realtime + Presence)

## Supabase Setup

### 1) Create a Supabase project
Create a project at [supabase.com](https://supabase.com).

### 2) Auth settings
In Supabase dashboard: disable email confirmation (the app treats the username as the email local-part).

### 3) Run the SQL schema

This repo includes `sql.md` which contains:
- `public.profiles`
- `public.messages`
- RLS policies and realtime publication settings
- migrations for locking (`locked` column) and supporting realtime lock sync

Important: the app also uses `public.channel_messages` for `#GLOBAL`. If your Supabase project does not already have that table, create it first (see next section), then run `sql.md`.

#### Create `public.channel_messages` (if missing)
Run this in the Supabase SQL editor:

```sql
create table if not exists public.channel_messages (
    id           bigserial primary key,
    sender_id    uuid not null references auth.users(id) on delete cascade,
    channel      text not null,
    body         text not null,
    locked       boolean not null default false,
    created_at   timestamptz not null default now(),
    constraint body_length check (char_length(trim(body)) between 1 and 10000)
);

alter table public.channel_messages enable row level security;

-- Select: allow authenticated users to read public channels
create policy "channel_messages: authenticated users can read"
    on public.channel_messages for select to authenticated using (true);

-- Insert: users can only insert as themselves
create policy "channel_messages: sender can insert"
    on public.channel_messages for insert to authenticated
    with check (auth.uid() = sender_id);

-- Update: allow toggling the `locked` field (message lock sync)
create policy "channel_messages: allow locking updates"
    on public.channel_messages for update to authenticated
    using (true);

-- Realtime needs full replica identity so `payload.old` works for lock updates
alter table public.channel_messages replica identity full;

-- Add the table to Supabase Realtime publication
alter publication supabase_realtime add table channel_messages;
```

### 4) Add missing realtime/publication pieces (if needed)
`sql.md` adds `messages` and `profiles` to `supabase_realtime`. Ensure `channel_messages` is also included (the snippet above does this).

## Client Configuration

`java.js` contains:
- `SUPABASE_URL`
- `SUPABASE_ANON`

Replace those values with your own Supabase project settings.

## Run Locally

Serve the folder over HTTP (do not open via `file://`).

From this folder:

```powershell
py -m http.server 5173
```

Then open: `http://localhost:5173`

## Usage

1. Open the app in your browser.
2. Sign up / log in.
3. Choose a contact to chat via DM, or select `# GLOBAL` at the top for the public channel.
4. Use `/help` to see commands.

## Notes
- The app uses username-as-email by appending `@theeye.local` for Supabase Auth.
- Audio notifications require a user interaction (browser autoplay policies). The app unlocks audio after the first play attempt.

