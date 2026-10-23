// Takes the last picture of The Eye before its Supabase project is deleted.
//
//   node tools/snapshot.mjs
//
// It asks for the project's secret key (Supabase dashboard → Project Settings → API Keys:
// the `service_role` key, or a `sb_secret_...` one). The key is only used here, never written down.
//
// Writes two things:
//   archive/global.json                     the public archive the site serves: #GLOBAL, the names and colours
//                                           of who spoke there, and a few numbers. No DMs.
//   ../the-eye-backup-<date>/*.json         everything (profiles, DMs, channels, auth users), outside the repo,
//                                           so it never gets committed or deployed. Keep it somewhere safe.

import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_BASE = 'https://afuwppfrljzmnbndizxz.supabase.co';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const today = new Date().toISOString().slice(0, 10);

let key = process.env.SUPABASE_SECRET;
if (!key) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    key = (await rl.question('secret key: ')).trim();
    rl.close();
}
const headers = { apikey: key };
if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;

async function table(name, order = 'id') {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const res = await fetch(`${URL_BASE}/rest/v1/${name}?select=*&order=${order}`, {
            headers: { ...headers, Range: `${from}-${from + 999}` },
        });
        if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
        const page = await res.json();
        rows.push(...page);
        if (page.length < 1000) return rows;
    }
}

async function authUsers() {
    const users = [];
    for (let page = 1; ; page++) {
        const res = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
        if (!res.ok) { console.warn(`auth users: ${res.status}, skipped`); return users; }
        const got = (await res.json()).users || [];
        users.push(...got.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at })));
        if (got.length < 1000) return users;
    }
}

const profiles = await table('profiles', 'username');
const messages = await table('messages');
const channelMessages = await table('channel_messages');
const users = await authUsers();

// The full backup, outside the repo.
const backup = path.resolve(root, '..', `the-eye-backup-${today}`);
await mkdir(backup, { recursive: true });
for (const [name, rows] of Object.entries({ profiles, messages, channel_messages: channelMessages, auth_users: users }))
    await writeFile(path.join(backup, name + '.json'), JSON.stringify(rows, null, 1));

// The public archive: #GLOBAL only.
const global = channelMessages
    .filter(m => m.channel === 'GLOBAL')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
const speakers = new Set(global.map(m => m.sender_id));
const allTimes = [...messages, ...channelMessages].map(m => m.created_at).sort();
const archive = {
    taken: new Date().toISOString(),
    closed: '2026-10-23',
    stats: {
        members: profiles.length,
        messages: messages.length + channelMessages.length,
        global: global.length,
        first: allTimes[0] || null,
        last: allTimes[allTimes.length - 1] || null,
    },
    people: profiles
        .filter(p => speakers.has(p.id))
        .map(p => ({ id: p.id, username: p.username, color_id: p.color_id ?? null, is_admin: !!p.is_admin })),
    messages: global.map(m => ({ id: m.id, sender_id: m.sender_id, body: m.body, locked: !!m.locked, created_at: m.created_at })),
};
await mkdir(path.join(root, 'archive'), { recursive: true });
await writeFile(path.join(root, 'archive', 'global.json'), JSON.stringify(archive));

console.log(`profiles ${profiles.length}, DMs ${messages.length}, channel messages ${channelMessages.length}, auth users ${users.length}`);
console.log(`backup:  ${backup}`);
console.log(`archive: archive/global.json (${global.length} messages in #GLOBAL, ${archive.people.length} people)`);
