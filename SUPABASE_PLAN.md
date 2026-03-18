# Supabase Integration Plan — "The Eye" Chat App

## Goal
Turn the frontend-only prototype into a real multi-user chat app with:
- Real accounts (signup/login)
- Persistent messages in a database
- Live message sync via Realtime
- Online/offline presence

---

## Design Decisions

- **Auth**: Username field stays as-is visually. Internally: `username` → `username@theeye.local` for Supabase Auth. If login fails, auto-retry as signup. No email confirmation.
- **Contacts**: All registered users appear in everyone's sidebar. No friend requests.
- **Presence**: Supabase Realtime Presence — ephemeral, auto-offline on tab close.

---

## Files to Modify

| File | What changes |
|---|---|
| `index.html` | CDN tag, remove hardcoded contacts, add `#login-error`, add IDs to header spans |
| `java.js` | Full rewrite (keep utils, replace everything else) |
| `style.css` | Add `#login-error` rule + optional `.contact-unread` |

---

## Step 1 — Supabase Project Setup

- [ ] Create project at supabase.com, copy **Project URL** and **anon public key**
- [ ] In Auth > Settings: **disable email confirmation**
- [ ] Run schema SQL (Step 2)
- [ ] Run RLS SQL (Step 3)

---

## Step 2 — Database Schema

Run in SQL Editor:

```sql
-- Profiles: one row per user, stores display username
create table public.profiles (
    id         uuid primary key references auth.users(id) on delete cascade,
    username   text not null unique,
    created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Trigger: auto-insert profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
    insert into public.profiles (id, username)
    values (new.id, new.raw_user_meta_data ->> 'username');
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
    body         text not null,
    created_at   timestamptz not null default now()
);
alter table public.messages enable row level security;

-- Index for fast conversation lookup
create index messages_conversation_idx
    on public.messages (
        least(sender_id::text, recipient_id::text),
        greatest(sender_id::text, recipient_id::text),
        created_at
    );
```

---

## Step 3 — Row Level Security Policies

Run in SQL Editor:

```sql
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
```

---

## Step 4 — index.html Changes

- [ ] Add CDN script tag before `java.js`:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  ```

- [ ] Replace hardcoded `.contact` divs with empty container:
  ```html
  <div class="contact-list"></div>
  ```

- [ ] Add login error element (above login button):
  ```html
  <div id="login-error"></div>
  ```

- [ ] Add IDs to chat header spans:
  ```html
  <span id="chat-with-label">// ...</span>
  <span id="chat-status-label" class="online-label">[ONLINE]</span>
  ```

---

## Step 5 — java.js Rewrite

### Section order to implement:

**1. CONFIG**
```js
const SUPABASE_URL  = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
```

**2. STATE** — replace `users` object with:
```js
let currentUser     = null;      // { id, username }
let activeContact   = null;      // { id, username }
let allUsers        = [];        // [{ id, username }, ...]
let onlineIds       = new Set(); // user IDs currently online
let realtimeChannel = null;
let presenceChannel = null;
let renderedMsgIds  = new Set(); // dedup for self-echo
```

**3. UTILS** — keep `nowTime()`, `escapeHtml()`, `scrollToBottom()` unchanged

**4. UI / RENDER**
- `renderContacts()` — build contact list from `allUsers`, skip self, apply online class from `onlineIds`, use `data-user-id`, event delegation on `.contact-list`
- `appendMessage(msg)` — change `sender === 'you'` to `msg.sender_id === currentUser.id`, use `msg.sender.username`
- `updateContactStatus(userId, isOnline)` — update one contact's dot + badge
- `updateHeader(contact, isOnline)` — set `#chat-with-label` and `#chat-status-label`
- `renderMessages(messages)` — clear feed, system line, call `appendMessage` for each

**5. AUTH**

`handleLogin()`:
1. Read username, trim
2. `email = username.toLowerCase() + '@theeye.local'`
3. Try `signInWithPassword({ email, password })`
4. If "Invalid login credentials" → try `signUp({ email, password, options: { data: { username } } })`
5. On success: set `currentUser`, fetch `allUsers`, show chat, `renderContacts()`, `loadMessages()`, `joinPresence()`
6. On failure: show error in `#login-error`

`handleLogout()`:
1. `leavePresence()`
2. `unsubscribeAll()`
3. `sb.auth.signOut()`
4. Reset state, switch to login-view

`restoreSession()` — called on page load, recovers existing Supabase session

**6. DATA**

`loadMessages(contactId)`:
```js
sb.from('messages')
  .select('*, sender:profiles!sender_id(username)')
  .or(`and(sender_id.eq.${me},recipient_id.eq.${them}),and(sender_id.eq.${them},recipient_id.eq.${me})`)
  .order('created_at', { ascending: true })
  .limit(200)
```

`sendMessage()`:
1. Read + trim input, guard empty
2. Insert `{ sender_id, recipient_id, body }` to messages table
3. Clear input immediately
4. Realtime subscription will render it back

**7. REALTIME**

`subscribeToMessages()` — single channel, two filters:
```js
realtimeChannel = sb.channel('messages-for-' + currentUser.id)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',
      filter: `recipient_id=eq.${currentUser.id}` }, handleIncomingMessage)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',
      filter: `sender_id=eq.${currentUser.id}` }, handleIncomingMessage)
  .subscribe();
```

`handleIncomingMessage(payload)`:
1. Extract `payload.new`
2. Deduplicate via `renderedMsgIds`
3. If message belongs to open conversation → `appendMessage`
4. Else → unread badge on that contact's sidebar entry

`unsubscribeAll()` — removes both channels

**8. PRESENCE**

`joinPresence()`:
```js
presenceChannel = sb.channel('online-users', { config: { presence: { key: currentUser.id } } })
  .on('presence', { event: 'sync' }, () => {
      onlineIds = new Set(Object.keys(presenceChannel.presenceState()));
      renderContacts();
  })
  .on('presence', { event: 'join' }, ({ key }) => { onlineIds.add(key); updateContactStatus(key, true); })
  .on('presence', { event: 'leave' }, ({ key }) => { onlineIds.delete(key); updateContactStatus(key, false); })
  .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await presenceChannel.track({ online_at: new Date().toISOString() });
  });
```

`leavePresence()` — `presenceChannel.untrack()` then remove channel

**9. EVENT LISTENERS / BOOT**
- Same buttons wired as current
- Contact clicks: event delegation on `.contact-list`
- Call `restoreSession()` at the bottom

---

## Step 6 — style.css Additions

```css
#login-error {
    font-size: 11px;
    color: #7a3a3a;
    text-align: center;
    letter-spacing: 0.08em;
    min-height: 16px;
    margin-top: -10px;
    margin-bottom: 8px;
}

.contact-unread {
    font-size: 10px;
    color: #4a7a6a;
    margin-left: auto;
}
```

---

## What Gets Removed

- `users` object with hardcoded contacts and bot replies
- `autoReplyTimer` and all bot auto-reply logic
- The two hardcoded `.contact` divs in HTML

---

## Edge Cases to Handle

- Username taken on signup → show `// USERNAME TAKEN` in `#login-error`
- Empty contact list (only user registered) → show `// NO CONTACTS` in sidebar
- Self-echo deduplication → `renderedMsgIds` Set
- Active contact goes offline → `updateHeader()` from presence `leave` event

---

## Implementation Checklist

- [ ] 1. Create Supabase project, run schema + RLS SQL
- [ ] 2. Add CDN tag to HTML, verify `supabase` global in console
- [ ] 3. Write CONFIG + STATE + UTILS sections in java.js
- [ ] 4. Write AUTH — test login/signup in browser before continuing
- [ ] 5. Write `renderContacts()` — test contact list appears
- [ ] 6. Write `loadMessages()` — test messages load in console
- [ ] 7. Write `subscribeToMessages()` + `handleIncomingMessage()` — two-tab test
- [ ] 8. Write `joinPresence()` / `leavePresence()` — two-tab dot test
- [ ] 9. Remove hardcoded contacts from HTML
- [ ] 10. Add `#login-error` div + CSS
- [ ] 11. Test `restoreSession()` — page refresh stays logged in
- [ ] 12. Test full logout — presence updates in other open tabs

---

## Verification Test

1. Open two browser tabs
2. Log in as different usernames in each tab
3. Tab 1 sends a message to Tab 2's user → appears in Tab 2 instantly
4. Tab 2 logs out → Tab 1's sidebar dot goes grey within ~2 seconds
5. Refresh Tab 1 → still logged in, messages still there
