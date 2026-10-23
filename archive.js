// =============================================
// THE EYE, CLOSED 23.10.2026
// =============================================
// The live chat (java.js) talked to a Supabase project that is gone. This page shows a memorial and #GLOBAL
// as it was on the last day, from archive/global.json (made by tools/snapshot.mjs).

const IDENTITY_COLORS = {
    1: '#5A7A4A', 2: '#9A7040', 3: '#3A8A7A', 4: '#39FF14', 5: '#8A4A60',
    6: '#A05568', 7: '#5A7498', 8: '#9A8A6A', 9: '#946048',
};
const colorOf = id => IDENTITY_COLORS[id] || '#8A9A7A';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function dotted(iso) {
    const d = new Date(iso);
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
}

let archive = null;
let rendered = false;

const loaded = fetch('archive/global.json')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(data => {
        archive = data;
        if (!data) return;
        const s = data.stats;
        if (s.first) document.getElementById('rip-first').textContent = dotted(s.first);
        const days = s.first ? Math.round((new Date(data.closed) - new Date(s.first)) / 86400000) : null;
        document.getElementById('rip-stats').textContent =
            `${s.messages.toLocaleString('en-US')} messages · ${s.members} watchers` + (days ? ` · ${days} days open` : '');
    });

function renderArchive() {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'system-msg';
    top.textContent = 'PUBLIC CHANNEL — #GLOBAL';
    feed.appendChild(top);

    if (!archive) {
        const none = document.createElement('div');
        none.className = 'system-msg';
        none.textContent = 'the archive could not be read';
        feed.appendChild(none);
        return;
    }

    const people = new Map(archive.people.map(p => [p.id, p]));
    const html = [];
    let lastDay = null, lastSender = null;
    for (const msg of archive.messages) {
        const date = new Date(msg.created_at);
        const day = date.toDateString();
        if (day !== lastDay) {
            html.push(`<div class="date-separator"><span class="date-separator-line"></span><span class="date-separator-label">${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}</span><span class="date-separator-line"></span></div>`);
            lastDay = day;
        }
        const who = people.get(msg.sender_id);
        const name = who ? who.username : '???';
        const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const audio = msg.body.match(/^\[AUDIO:(\d+)\]$/);
        const body = audio
            ? `<button class="msg-audio-btn" data-audio-id="${audio[1]}">[♪] AUDIO ${audio[1].padStart(2, '0')}</button>`
            : `<span class="msg-text">${escapeHtml(msg.body)}</span>`;
        const cls = 'message' + (msg.sender_id !== lastSender ? ' new-sender' : '') + (msg.locked ? ' locked' : '');
        html.push(`<div class="${cls}" style="animation:none">` +
            `<span class="msg-time">${time}</span>` +
            ` <span class="msg-sender" style="color:${colorOf(who && who.color_id)}">${escapeHtml(name)}</span>` +
            (who && who.is_admin ? `<span class="msg-admin-tag">[ADMIN]</span>` : '') +
            (msg.locked ? `<span class="msg-lock-tag">[LOCKED]</span>` : '') +
            `<span class="msg-sep">></span>` + body + `</div>`);
        lastSender = msg.sender_id;
    }
    html.push(`<div class="system-msg archive-end">CONNECTION TERMINATED — 23.10.2026</div>`);
    feed.insertAdjacentHTML('beforeend', html.join(''));
}

document.getElementById('message-feed').addEventListener('click', e => {
    const btn = e.target.closest('.msg-audio-btn');
    if (btn) new Audio(`Audios/audio${btn.dataset.audioId}.mp3`).play();
});

async function openArchive() {
    await loaded;
    if (!rendered) { renderArchive(); rendered = true; }
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.body.classList.add('chat-mode');
    const feed = document.getElementById('message-feed');
    feed.scrollTop = feed.scrollHeight;
    if (location.hash !== '#archive') history.pushState(null, '', '#archive');
}

function closeArchive() {
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('login-view').classList.remove('hidden');
    document.body.classList.remove('chat-mode');
}

document.getElementById('enter-archive').addEventListener('click', openArchive);
document.getElementById('close-chat-btn').addEventListener('click', () => {
    if (location.hash === '#archive') history.back(); else closeArchive();
});
window.addEventListener('popstate', () => location.hash === '#archive' ? openArchive() : closeArchive());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && location.hash === '#archive') history.back(); });
if (location.hash === '#archive') openArchive();
