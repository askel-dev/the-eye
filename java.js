// =============================================
// FAVICON
// =============================================
(function() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = function() {
        ctx.filter = 'brightness(0) invert(1)';
        ctx.drawImage(img, 0, 0, 32, 32);
        const link = document.querySelector("link[rel='icon']") || document.createElement('link');
        link.rel = 'icon';
        link.href = canvas.toDataURL();
        document.head.appendChild(link);
    };
    img.src = 'assets/logo.svg';
})();

// =============================================
// 1. CONFIG
// =============================================
const SUPABASE_URL  = 'https://afuwppfrljzmnbndizxz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmdXdwcGZybGp6bW5ibmRpenh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDA4MzgsImV4cCI6MjA4OTQxNjgzOH0.-EK1da5r3n38YVs6pPPKMWiyWyzsVdGlUwX5iygY5LA';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// Curated identity color palette — terminal-safe, readable on dark backgrounds
const IDENTITY_COLORS = [
    { id: 1, name: 'Sage',           hex: '#5A7A4A' },
    { id: 2, name: 'Warm Amber',     hex: '#9A7040' },
    { id: 3, name: 'Seafoam',        hex: '#3A8A7A' },
    { id: 4, name: 'Phosphor Green', hex: '#39FF14' },
    { id: 5, name: 'Mauve',          hex: '#8A4A60' },
    { id: 6, name: 'Dusty Rose',     hex: '#A05568' },
    { id: 7, name: 'Steel',          hex: '#5A7498' },
    { id: 8, name: 'Sand',           hex: '#9A8A6A' },
    { id: 9, name: 'Terracotta',     hex: '#946048' },
];

function getColorHex(colorId) {
    const entry = IDENTITY_COLORS.find(c => c.id === colorId);
    return entry ? entry.hex : '#8A9A7A'; // fallback = Sage (id 1)
}

function formatLastSeen(ts) {
    if (!ts) return 'a while ago';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

// UI color themes
const THEMES = [
    { id: 'default',  name: 'Default',  desc: 'Light terminal' },
    { id: 'dark',     name: 'Dark',     desc: 'Standard dark terminal' },
    { id: 'midnight', name: 'Midnight', desc: 'Blue-tinted dark' },
    { id: 'phosphor', name: 'Phosphor', desc: 'Classic green CRT' },
    { id: 'amber',    name: 'Amber',    desc: 'Warm amber CRT' },
];

function applyTheme(themeId) {
    if (themeId === 'default') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', themeId);
    }
    localStorage.setItem('eye_theme', themeId);
}

function getStoredTheme() {
    return localStorage.getItem('eye_theme') || 'default';
}

applyTheme(getStoredTheme());

// =============================================
// 2. STATE
// =============================================
let currentUser     = null;      // { id, username }
let activeContact   = null;      // { id, username }
let allUsers        = [];        // [{ id, username }, ...]
let onlineIds       = new Set(); // user IDs currently online
let realtimeChannel = null;
let presenceChannel = null;
let profilesChannel = null;
let renderedMsgIds  = new Set(); // dedup for self-echo
let conversationCache = new Map(); // userId|channelName → messages[]
let audioUnlocked   = false;
let isMuted         = false;
let notifAudio      = new Audio('assets/notif.mp3');
let viewMode        = 'dm';       // 'dm' or 'channel'
let activeChannel   = null;       // e.g. 'GLOBAL'
let channelRealtimeChannel = null;
let inputHistory        = [];       // sent messages (oldest → newest)
let inputHistoryIdx     = -1;       // -1 = not browsing history
let inputHistoryDraft   = '';       // stash of unsent text when entering history
let isUserAtBottom      = true;     // auto-scroll tracking
let newMsgCount         = 0;        // unread count while scrolled up
let lockedMessages      = new Set(JSON.parse(localStorage.getItem('locked_msgs') || '[]'));
function persistLockedMessages() { localStorage.setItem('locked_msgs', JSON.stringify(Array.from(lockedMessages))); }
let lockChannel         = null;     // realtime channel for lock sync (postgres UPDATE)
let lastMessageTime     = new Map(); // userId → timestamp (ms) for sorting contacts
let unreadCounts        = new Map(); // userId → unread message count
let favoriteIds         = new Set(JSON.parse(localStorage.getItem('eye_favorites') || '[]'));
function persistFavorites() { localStorage.setItem('eye_favorites', JSON.stringify(Array.from(favoriteIds))); }
let lastSeenInterval    = null;

function toggleFavorite(userId) {
    if (favoriteIds.has(userId)) {
        favoriteIds.delete(userId);
    } else {
        favoriteIds.add(userId);
    }
    persistFavorites();
    renderContacts();
}
let typingChannel       = null;     // broadcast channel for typing indicators
let typingTimeout       = null;     // timeout to hide remote typing
let lastTypingSent      = 0;        // throttle outgoing typing events

function unlockAudio() {
    if (audioUnlocked) return;
    notifAudio.play().then(() => {
        notifAudio.pause();
        notifAudio.currentTime = 0;
        audioUnlocked = true;
    }).catch(() => {});
}

function playNotif() {
    if (!audioUnlocked || isMuted) return;
    notifAudio.currentTime = 0;
    notifAudio.play().catch(() => {});
}

// =============================================
// 3. UTILS
// =============================================
function nowTime() {
    return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function scrollToBottom(force = false) {
    const feed = document.getElementById('message-feed');
    if (force || isUserAtBottom) {
        feed.scrollTop = feed.scrollHeight;
        resetNewMsgIndicator();
    }
}

function checkIfAtBottom() {
    const feed = document.getElementById('message-feed');
    // Within 40px of the bottom counts as "at bottom"
    isUserAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    if (isUserAtBottom) resetNewMsgIndicator();
}

function showNewMsgIndicator() {
    newMsgCount++;
    const indicator = document.getElementById('new-msg-indicator');
    document.getElementById('new-msg-count').textContent = newMsgCount;
    indicator.classList.remove('hidden');
}

function resetNewMsgIndicator() {
    newMsgCount = 0;
    const indicator = document.getElementById('new-msg-indicator');
    if (indicator) indicator.classList.add('hidden');
}

// =============================================
// 3c. TYPING INDICATORS
// =============================================
function subscribeToTyping() {
    typingChannel = sb
        .channel('typing-indicators')
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (!currentUser || payload.user_id === currentUser.id) return;

            // DM mode: only show if the typer is the active contact
            if (viewMode === 'dm') {
                if (!activeContact || payload.user_id !== activeContact.id) return;
                if (payload.context_type !== 'dm') return;
            }
            // Channel mode: only show if same channel
            if (viewMode === 'channel') {
                if (payload.context_type !== 'channel' || payload.context_id !== activeChannel) return;
            }

            showTypingIndicator(payload.username);
        })
        .subscribe();
}

function broadcastTyping() {
    if (!typingChannel || !currentUser) return;

    const now = Date.now();
    if (now - lastTypingSent < 2000) return; // throttle to once per 2s
    lastTypingSent = now;

    const payload = {
        user_id: currentUser.id,
        username: currentUser.username,
    };

    if (viewMode === 'channel' && activeChannel) {
        payload.context_type = 'channel';
        payload.context_id = activeChannel;
    } else if (viewMode === 'dm' && activeContact) {
        payload.context_type = 'dm';
        payload.context_id = activeContact.id;
    } else {
        return;
    }

    typingChannel.send({ type: 'broadcast', event: 'typing', payload });
}

function showTypingIndicator(username) {
    const el = document.getElementById('typing-indicator');
    el.innerHTML = `${escapeHtml(username)} is typing<span class="blink-cursor">_</span>`;
    el.classList.remove('hidden');

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(hideTypingIndicator, 3000);
}

function hideTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    el.classList.add('hidden');
    clearTimeout(typingTimeout);
}

// =============================================
// 3b. SLASH COMMANDS
// =============================================
function appendSystemMsg(text, swatchColor = null) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    el.className = 'system-msg';
    if (swatchColor) {
        // Render the ██ swatch in the actual color, rest in normal system-msg color
        const colored = text.replace('██', `<span style="color:${swatchColor};font-style:normal">██</span>`);
        el.innerHTML = colored;
    } else {
        el.textContent = text;
    }
    feed.appendChild(el);
    scrollToBottom();
}

function appendSystemMsgHtml(html) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.innerHTML = html;
    feed.appendChild(el);
    scrollToBottom();
}

const COMMANDS = {
    help:   { usage: '/help',           description: 'Show available commands',       handler: cmdHelp },
    clear:  { usage: '/clear',          description: 'Clear the message feed',        handler: cmdClear },
    lock:   { usage: '/lock [n]',       description: 'Lock/unlock message (survives /clear)', handler: cmdLock },
    who:    { usage: '/who',            description: 'Show online users',             handler: cmdWho },
    top:    { usage: '/top',            description: 'Show message leaderboard',      handler: cmdTop },
    color:  { usage: '/color list',     description: 'List or set your identity color', handler: cmdColor },
    theme:  { usage: '/theme list',     description: 'List or set UI color theme',     handler: cmdTheme },
    mute:   { usage: '/mute',           description: 'Toggle all sound effects',      handler: cmdMute },
};

function cmdYase() {
    const desktop = document.getElementById('wm-desktop');
    const alreadyVisible = desktop && desktop.querySelector('.wm-icon[data-app-id="app-soundboard"]');
    if (!alreadyVisible) {
        createDesktopIcon('app-soundboard', 16, 196);
    }
}

async function handleSlashCommand(body) {
    if (!body.startsWith('/')) return false;
    const spaceIdx = body.indexOf(' ');
    const name = (spaceIdx === -1 ? body.slice(1) : body.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
    // Secret commands — not listed in /help
    if (name === 'yase') { cmdYase(); return true; }
    const cmd = COMMANDS[name];
    if (!cmd) {
        appendSystemMsg('UNKNOWN COMMAND: /' + name + ' — type /help');
        return true;
    }
    await cmd.handler(args);
    return true;
}

function applyLockVisual(el, locked) {
    const tag = el.querySelector('.msg-lock-tag');
    const btn = el.querySelector('.msg-lock-btn');
    if (locked) {
        el.classList.add('locked');
        tag.classList.remove('hidden');
        btn.textContent = '[UNLOCK]';
    } else {
        el.classList.remove('locked');
        tag.classList.add('hidden');
        btn.textContent = '[LOCK]';
    }
}

async function toggleLock(elId) {
    const el = document.getElementById(elId);
    if (!el || !el.dataset.msgId) return;

    const lockKey = el.dataset.lockType + ':' + el.dataset.msgId;
    const nowLocked = !lockedMessages.has(lockKey);
    const table = el.dataset.lockType === 'ch' ? 'channel_messages' : 'messages';

    // Update in database — realtime subscription will handle the visual update
    const { error } = await sb.from(table).update({ locked: nowLocked }).eq('id', el.dataset.msgId);
    if (error) {
        console.error('toggleLock DB error:', error);
        appendSystemMsg('ERROR: COULD NOT TOGGLE LOCK');
        return undefined;
    }

    // Optimistic local update (realtime will confirm)
    if (nowLocked) lockedMessages.add(lockKey); else lockedMessages.delete(lockKey);
    persistLockedMessages();
    applyLockVisual(el, nowLocked);
    return nowLocked;
}

function handleLockUpdate(table, row) {
    const lockType = table === 'channel_messages' ? 'ch' : 'dm';
    const lockKey = lockType + ':' + row.id;
    const el = document.querySelector(`.message[data-lock-type="${lockType}"][data-msg-id="${row.id}"]`);

    if (row.locked) {
        lockedMessages.add(lockKey);
    } else {
        lockedMessages.delete(lockKey);
    }
    persistLockedMessages();

    if (el) applyLockVisual(el, row.locked);
}

function subscribeToLocks() {
    lockChannel = sb
        .channel('lock-sync')
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'messages' },
            (payload) => {
                if (payload.old.locked !== payload.new.locked) {
                    handleLockUpdate('messages', payload.new);
                }
            })
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'channel_messages' },
            (payload) => {
                if (payload.old.locked !== payload.new.locked) {
                    handleLockUpdate('channel_messages', payload.new);
                }
            })
        .subscribe();
}

async function cmdLock(args) {
    const feed = document.getElementById('message-feed');
    const messages = Array.from(feed.querySelectorAll('.message:not(.skeleton)'));

    if (!args) {
        if (messages.length === 0) {
            appendSystemMsg('NO MESSAGES TO LOCK');
            return;
        }
        const last = messages[messages.length - 1];
        const isLocked = await toggleLock(last.id);
        if (isLocked !== undefined) appendSystemMsg(isLocked ? 'MESSAGE LOCKED' : 'MESSAGE UNLOCKED');
        return;
    }

    const num = parseInt(args, 10);
    if (isNaN(num) || num < 1 || num > messages.length) {
        appendSystemMsg(`USAGE: /lock [1-${messages.length}] — message number from top`);
        return;
    }

    const target = messages[num - 1];
    const isLocked = await toggleLock(target.id);
    if (isLocked !== undefined) appendSystemMsg(isLocked ? `MESSAGE #${num} LOCKED` : `MESSAGE #${num} UNLOCKED`);
}

function cmdClear() {
    const feed = document.getElementById('message-feed');

    // Collect locked message elements
    const locked = Array.from(feed.querySelectorAll('.message.locked'));

    // Detach locked messages before wiping
    locked.forEach(el => el.remove());

    feed.innerHTML = '';
    renderedMsgIds.clear();

    // Re-insert locked messages stacked at the top
    locked.forEach(el => {
        feed.appendChild(el);
        // Re-add their IDs to renderedMsgIds so they don't get duped
        const dbId = el.dataset.msgId;
        if (dbId) {
            const dedupKey = el.dataset.lockType === 'ch' ? 'ch-' + dbId : dbId;
            renderedMsgIds.add(dedupKey);
        }
    });

    let latestMsgTime = 0;
    const cacheKey = viewMode === 'channel' ? 'ch:' + activeChannel : (activeContact ? activeContact.id : null);
    if (cacheKey) {
        const cached = conversationCache.get(cacheKey);
        if (cached && cached.length > 0) {
            for (let i = cached.length - 1; i >= 0; i--) {
                if (cached[i].created_at) {
                    latestMsgTime = new Date(cached[i].created_at).getTime();
                    break;
                }
            }
        }
        
        if (cached) {
            const lockType = viewMode === 'channel' ? 'ch' : 'dm';
            const filteredCached = cached.filter(msg => msg.locked || lockedMessages.has(lockType + ':' + msg.id));
            conversationCache.set(cacheKey, filteredCached);
        }
    }
    
    const clearTime = latestMsgTime > 0 ? latestMsgTime + 1 : Date.now();
    const clearKeyStr = viewMode === 'channel' ? `clear-${currentUser.id}-ch-${activeChannel}` : `clear-${currentUser.id}-dm-${activeContact.id}`;
    localStorage.setItem(clearKeyStr, clearTime.toString());

    appendSystemMsg(locked.length > 0
        ? `FEED CLEARED — ${locked.length} LOCKED MESSAGE${locked.length > 1 ? 'S' : ''} PRESERVED`
        : 'FEED CLEARED');
}

function cmdWho() {
    const online = allUsers.filter(u => onlineIds.has(u.id));
    if (online.length === 0) {
        appendSystemMsg('NO USERS ONLINE');
    } else {
        const names = online.map(u => u.username).sort().join(', ');
        appendSystemMsg('ONLINE (' + online.length + '): ' + names);
    }
}

async function cmdTop() {
    appendSystemMsg('GLOBAL COMM METRICS: MESSAGES SENT');
    const { data, error } = await sb.rpc('get_message_counts');
    if (error || !data || data.length === 0) {
        appendSystemMsg('NO DATA AVAILABLE');
        return;
    }
    const top = data.slice(0, 10);
    const maxCount = top[0].total_count;
    const BAR_WIDTH = 20;
    const maxName = Math.max(...top.map(r => {
        const u = allUsers.find(u => u.id === r.sender_id);
        return (u ? u.username : 'unknown').length;
    }));
    const maxDigits = maxCount.toLocaleString().length;
    top.forEach((row, i) => {
        const user = allUsers.find(u => u.id === row.sender_id);
        const name = user ? user.username : 'unknown';
        const color = getColorHex(user ? user.color_id : 1);
        const filled = Math.max(1, Math.round((row.total_count / maxCount) * BAR_WIDTH));
        const empty = BAR_WIDTH - filled;
        const bar = '▓'.repeat(filled) + '░'.repeat(empty);
        const rank = `[${i + 1}]`.padEnd(4);
        const paddedName = name.padEnd(maxName);
        const count = row.total_count.toLocaleString().padStart(maxDigits);
        const nameHtml = `<span style="color:${color};font-style:normal">${paddedName}</span>`;
        appendSystemMsgHtml(`${rank} ${nameHtml} ${bar} ${count}`);
    });
}

function cmdHelp() {
    appendSystemMsg('AVAILABLE COMMANDS:');
    for (const [name, cmd] of Object.entries(COMMANDS)) {
        appendSystemMsg('  /' + name + ' — ' + cmd.description);
    }
}

function cmdColorList() {
    appendSystemMsg('AVAILABLE IDENTITY COLORS:');
    for (const c of IDENTITY_COLORS) {
        const num = String(c.id).padStart(1, ' ');
        appendSystemMsg(`  [ ${num} ] \u2588\u2588 ${c.name}`, c.hex);
    }
    appendSystemMsg('  > Type /color set [number] to apply');
}

async function cmdColor(args) {
    const parts = args.trim().toLowerCase().split(/\s+/);
    const sub = parts[0];

    if (!sub || sub === 'list') {
        cmdColorList();
        return;
    }

    if (sub === 'set') {
        const num = parseInt(parts[1], 10);
        if (isNaN(num) || num < 1 || num > IDENTITY_COLORS.length) {
            appendSystemMsg(`USAGE: /color set [1-${IDENTITY_COLORS.length}]`);
            return;
        }
        const chosen = IDENTITY_COLORS.find(c => c.id === num);
        const { error } = await sb.from('profiles').update({ color_id: num }).eq('id', currentUser.id);
        if (error) {
            appendSystemMsg('ERROR: COULD NOT SET COLOR');
            console.error('cmdColor error:', error);
            return;
        }
        currentUser.color_id = num;
        // Update self-username color in sidebar
        const selfEl = document.getElementById('self-username');
        if (selfEl) selfEl.style.color = chosen.hex;
        // Recolor any already-rendered messages by self
        recolorRenderedMessages(currentUser.id);
        appendSystemMsg(`COLOR SET: ${chosen.name}`);
        return;
    }

    appendSystemMsg(`USAGE: /color list  OR  /color set [1-${IDENTITY_COLORS.length}]`);
}

function cmdThemeList() {
    const current = getStoredTheme();
    appendSystemMsg('AVAILABLE THEMES:');
    for (const t of THEMES) {
        const marker = t.id === current ? ' ←' : '';
        appendSystemMsg(`  [ ${t.id} ] ${t.name} — ${t.desc}${marker}`);
    }
    appendSystemMsg('  > Type /theme set <name> to apply');
}

async function cmdTheme(args) {
    const parts = args.trim().toLowerCase().split(/\s+/);
    const sub = parts[0];

    if (!sub || sub === 'list') {
        cmdThemeList();
        return;
    }

    if (sub === 'set') {
        const id = parts[1];
        const theme = THEMES.find(t => t.id === id);
        if (!theme) {
            appendSystemMsg(`UNKNOWN THEME: ${id || '(none)'}`);
            cmdThemeList();
            return;
        }
        applyTheme(theme.id);
        appendSystemMsg(`THEME SET: ${theme.name}`);
        return;
    }

    appendSystemMsg('USAGE: /theme list  OR  /theme set <name>');
}

function cmdMute() {
    toggleMute();
    appendSystemMsg(isMuted ? 'AUDIO MUTED' : 'AUDIO UNMUTED');
}

function toggleMute() {
    isMuted = !isMuted;
    const btn = document.getElementById('audio-toggle');
    const textSpan = document.getElementById('audio-toggle-text');
    if (!btn || !textSpan) return;
    if (isMuted) {
        textSpan.textContent = '✗';
        btn.classList.add('muted');
    } else {
        textSpan.textContent = '♪';
        btn.classList.remove('muted');
    }
}

// =============================================
// 3d. COMMAND HINTS
// =============================================
let cmdHintIdx = -1; // active hint index (-1 = none)

function showCmdHints(filter) {
    const hintsEl = document.getElementById('cmd-hints');
    const entries = Object.entries(COMMANDS)
        .filter(([name]) => name.startsWith(filter));

    if (entries.length === 0) {
        hideCmdHints();
        return;
    }

    cmdHintIdx = -1;
    hintsEl.innerHTML = entries.map(([name, c]) =>
        `<div class="cmd-hint" data-cmd="${name}">` +
        `<span class="cmd-hint-name">/${name}</span>` +
        `<span class="cmd-hint-desc">${c.description}</span>` +
        `</div>`
    ).join('');

    hintsEl.classList.remove('hidden');
}

function hideCmdHints() {
    const hintsEl = document.getElementById('cmd-hints');
    hintsEl.classList.add('hidden');
    hintsEl.innerHTML = '';
    cmdHintIdx = -1;
}

function selectCmdHint(name) {
    const input = document.getElementById('message-input');
    const needsArgs = name === 'status';
    input.value = '/' + name + (needsArgs ? ' ' : '');
    hideCmdHints();
    input.focus();
}

function navigateCmdHints(direction) {
    const items = document.querySelectorAll('#cmd-hints .cmd-hint');
    if (items.length === 0) return false;

    items.forEach(el => el.classList.remove('active'));

    if (direction === 'down') {
        cmdHintIdx = cmdHintIdx < items.length - 1 ? cmdHintIdx + 1 : 0;
    } else {
        cmdHintIdx = cmdHintIdx > 0 ? cmdHintIdx - 1 : items.length - 1;
    }

    items[cmdHintIdx].classList.add('active');
    items[cmdHintIdx].scrollIntoView({ block: 'nearest' });
    return true;
}

function confirmCmdHint() {
    const items = document.querySelectorAll('#cmd-hints .cmd-hint');
    if (cmdHintIdx >= 0 && cmdHintIdx < items.length) {
        selectCmdHint(items[cmdHintIdx].dataset.cmd);
        return true;
    }
    return false;
}

// =============================================
// 4. UI / RENDER
// =============================================
async function fetchLastMessageTimes() {
    const { data: sent } = await sb
        .from('messages')
        .select('recipient_id, created_at')
        .eq('sender_id', currentUser.id)
        .order('created_at', { ascending: false });

    const { data: received } = await sb
        .from('messages')
        .select('sender_id, created_at')
        .eq('recipient_id', currentUser.id)
        .order('created_at', { ascending: false });

    const map = new Map();
    for (const m of (sent || [])) {
        const t = new Date(m.created_at).getTime();
        if (!map.has(m.recipient_id) || t > map.get(m.recipient_id)) {
            map.set(m.recipient_id, t);
        }
    }
    for (const m of (received || [])) {
        const t = new Date(m.created_at).getTime();
        if (!map.has(m.sender_id) || t > map.get(m.sender_id)) {
            map.set(m.sender_id, t);
        }
    }
    lastMessageTime = map;
}

function sortByLastMessage(users) {
    return users.slice().sort((a, b) => {
        const tA = lastMessageTime.get(a.id) || 0;
        const tB = lastMessageTime.get(b.id) || 0;
        if (tA !== tB) return tB - tA;
        return a.username.localeCompare(b.username);
    });
}

function renderContacts() {
    const list = document.querySelector('.contact-list');
    list.innerHTML = '';

    // Global channel entry
    const globalEl = document.createElement('div');
    globalEl.className = 'contact channel-entry' +
        (viewMode === 'channel' && activeChannel === 'GLOBAL' ? ' active' : '');
    globalEl.dataset.channel = 'GLOBAL';
    globalEl.innerHTML =
        `<span class="status-dot online"></span>` +
        `<span class="contact-name"># GLOBAL</span>` +
        `<span class="contact-badge">[CH]</span>`;
    list.appendChild(globalEl);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'channel-separator';
    list.appendChild(sep);

    const others = allUsers.filter(u => u.id !== currentUser.id);

    if (others.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'system-msg';
        empty.textContent = '// NO CONTACTS';
        list.appendChild(empty);
        return;
    }

    const favoriteUsers = sortByLastMessage(others.filter(u => favoriteIds.has(u.id)));
    const onlineUsers = sortByLastMessage(others.filter(u => onlineIds.has(u.id) && !favoriteIds.has(u.id)));
    const offlineUsers = sortByLastMessage(others.filter(u => !onlineIds.has(u.id) && !favoriteIds.has(u.id)));

    function unreadBadge(userId) {
        const count = unreadCounts.get(userId);
        return count ? `<span class="contact-unread" data-count="${count}">[${count}]</span>` : '';
    }

    function nameGroup(user, isOnline) {
        const color = getColorHex(user.color_id);
        const lastSeen = isOnline ? '' : `<span class="contact-last-seen">seen ${formatLastSeen(user.last_seen_at)}</span>`;
        return `<span class="contact-name-group"><span class="contact-name" data-username="${escapeHtml(user.username)}" style="color:${color}">${escapeHtml(user.username)}</span>${lastSeen}</span>`;
    }

    // Pinned section (only shown when there are pinned contacts)
    if (favoriteUsers.length > 0) {
        const pinnedHeader = document.createElement('div');
        pinnedHeader.className = 'contact-section-header';
        pinnedHeader.textContent = `Pinned \u2014 ${favoriteUsers.length}`;
        list.appendChild(pinnedHeader);

        for (const user of favoriteUsers) {
            const isOnline = onlineIds.has(user.id);
            const el = document.createElement('div');
            el.className = 'contact ' + (isOnline ? 'contact-online' : 'contact-offline') +
                (viewMode === 'dm' && activeContact && activeContact.id === user.id ? ' active' : '');
            el.dataset.userId = user.id;
            el.innerHTML =
                `<span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>` +
                nameGroup(user, isOnline) +
                unreadBadge(user.id) +
                `<span class="contact-fav is-fav" data-fav-id="${user.id}" title="Remove from favorites">\u2605</span>`;
            list.appendChild(el);
        }
    }

    // Online section (only shown when there are online contacts)
    if (onlineUsers.length > 0) {
        const onlineHeader = document.createElement('div');
        onlineHeader.className = 'contact-section-header';
        onlineHeader.textContent = `Online \u2014 ${onlineUsers.length}`;
        list.appendChild(onlineHeader);

        for (const user of onlineUsers) {
            const el = document.createElement('div');
            el.className = 'contact contact-online' + (viewMode === 'dm' && activeContact && activeContact.id === user.id ? ' active' : '');
            el.dataset.userId = user.id;
            el.innerHTML =
                `<span class="status-dot online"></span>` +
                nameGroup(user, true) +
                unreadBadge(user.id) +
                `<span class="contact-fav" data-fav-id="${user.id}" title="Add to favorites">\u2606</span>`;
            list.appendChild(el);
        }
    }

    // Offline section header (collapsible, collapsed by default)
    const offlineCollapsed = window._offlineCollapsed !== false; // default collapsed
    const offlineHeader = document.createElement('div');
    offlineHeader.className = 'contact-section-header contact-section-collapsible';
    offlineHeader.dataset.section = 'offline';
    offlineHeader.innerHTML = `Offline \u2014 ${offlineUsers.length} <span class="section-toggle">${offlineCollapsed ? '[+]' : '[\u2212]'}</span>`;
    list.appendChild(offlineHeader);

    for (const user of offlineUsers) {
        const el = document.createElement('div');
        el.className = 'contact contact-offline' + (viewMode === 'dm' && activeContact && activeContact.id === user.id ? ' active' : '');
        el.dataset.userId = user.id;
        el.dataset.offlineItem = '1';
        if (offlineCollapsed) el.style.display = 'none';
        el.innerHTML =
            `<span class="status-dot offline"></span>` +
            nameGroup(user, false) +
            unreadBadge(user.id) +
            `<span class="contact-fav" data-fav-id="${user.id}" title="Add to favorites">\u2606</span>`;
        list.appendChild(el);
    }

    // Empty state hint when no pinned/online and offline is collapsed
    const offlineCollapsedFinal = window._offlineCollapsed !== false;
    if (favoriteUsers.length === 0 && onlineUsers.length === 0 && (offlineCollapsedFinal || offlineUsers.length === 0)) {
        const hint = document.createElement('div');
        hint.className = 'contact-list-empty-hint';
        hint.textContent = 'no active conversations';
        list.appendChild(hint);
    }

    // Re-apply filter if active
    const filterVal = document.getElementById('contact-filter')?.value;
    if (filterVal) applyContactFilter(filterVal);
}

function appendMessage(msg, animate = true) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    const isSelf = msg.sender_id === currentUser.id;
    el.className = 'message' + (isSelf ? ' self' : '');
    const lastMsg = feed.lastElementChild;
    if (lastMsg && lastMsg.dataset.senderId !== String(msg.sender_id)) {
        el.classList.add('new-sender');
    }
    if (!animate) el.style.animation = 'none';

    const senderName = isSelf ? currentUser.username : (msg.sender ? msg.sender.username : '???');
    const senderUser = isSelf ? currentUser : allUsers.find(u => u.id === msg.sender_id);
    const isAdmin = senderUser && senderUser.is_admin;
    const senderColor = getColorHex(senderUser?.color_id);
    const time = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : nowTime();

    // Lock tracking: store DB id and table type on the element
    const msgDbId = msg.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const lockType = msg.channel ? 'ch' : 'dm';
    const elId = 'msg-' + lockType + '-' + msgDbId;
    el.id = elId;
    el.dataset.msgId = msgDbId;
    el.dataset.lockType = lockType;
    el.dataset.senderId = msg.sender_id; // for recolorRenderedMessages

    const lockKey = lockType + ':' + msgDbId;
    // Check both DB field and local set (local set covers optimistic updates)
    const isLocked = msg.locked || lockedMessages.has(lockKey);
    
    if (isLocked && !lockedMessages.has(lockKey)) {
        lockedMessages.add(lockKey);
        persistLockedMessages();
    } else if (isLocked) {
        lockedMessages.add(lockKey);
    }

    const audioMatch = msg.body ? msg.body.match(/^\[AUDIO:(\d+)\]$/) : null;
    const bodyContent = audioMatch
        ? `<button class="msg-audio-btn" data-audio-id="${audioMatch[1]}">[♪] AUDIO ${String(audioMatch[1]).padStart(2, '0')}</button>`
        : `<span class="msg-text">${escapeHtml(msg.body)}</span>`;

    el.innerHTML =
        `<span class="msg-time">${time}</span>` +
        ` <span class="msg-sender" style="color:${senderColor}">${escapeHtml(senderName)}</span>` +
        (isAdmin ? `<span class="msg-admin-tag">[ADMIN]</span>` : '') +
        `<span class="msg-lock-tag${isLocked ? '' : ' hidden'}">[LOCKED]</span>` +
        `<span class="msg-sep">></span>` +
        bodyContent +
        `<button class="msg-lock-btn" title="Lock message">${isLocked ? '[UNLOCK]' : '[LOCK]'}</button>`;

    if (isLocked) el.classList.add('locked');

    // Audio message play button
    const audioBtn = el.querySelector('.msg-audio-btn');
    if (audioBtn) {
        audioBtn.addEventListener('click', () => {
            const audio = new Audio(`Audios/audio${audioBtn.dataset.audioId}.mp3`);
            audio.play();
        });
    }

    // Lock button click
    el.querySelector('.msg-lock-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLock(elId);
    });

    feed.appendChild(el);
    if (isUserAtBottom) {
        scrollToBottom();
    } else if (animate) {
        showNewMsgIndicator();
    }
}

function renderSkeleton() {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    renderedMsgIds.clear();
    for (let i = 0; i < 6; i++) {
        const el = document.createElement('div');
        el.className = 'message skeleton';
        el.innerHTML =
            `<span class="skel-line skel-short"></span>` +
            `<span class="skel-line skel-long"></span>`;
        feed.appendChild(el);
    }
}

function formatDateLabel(date) {
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
}

function insertDateSeparator(feed, date) {
    const el = document.createElement('div');
    el.className = 'date-separator';
    el.innerHTML = `<span class="date-separator-line"></span><span class="date-separator-label">${formatDateLabel(date)}</span><span class="date-separator-line"></span>`;
    feed.appendChild(el);
}

function renderMessages(messages) {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    renderedMsgIds.clear();

    const sys = document.createElement('div');
    sys.className = 'system-msg';
    sys.textContent = viewMode === 'channel'
        ? `PUBLIC CHANNEL — #${activeChannel}`
        : `CONNECTION ESTABLISHED — ${activeContact ? activeContact.username : '...'}`;
    feed.appendChild(sys);

    let lastDate = null;
    for (const msg of messages) {
        const dedupKey = viewMode === 'channel' ? 'ch-' + msg.id : msg.id;
        renderedMsgIds.add(dedupKey);

        if (msg.created_at) {
            const msgDate = new Date(msg.created_at);
            const dayStr = msgDate.toDateString();
            if (lastDate === null || lastDate !== dayStr) {
                insertDateSeparator(feed, msgDate);
            }
            lastDate = dayStr;
        }

        appendMessage(msg, false);
    }

    isUserAtBottom = true;
    scrollToBottom(true);
}

function updateContactStatus(userId, isOnline) {
    renderContacts();

    if (activeContact && activeContact.id === userId) {
        updateHeader(activeContact, isOnline);
    }
}

function updateHeader(contact, isOnline) {
    const contactColor = getColorHex(contact.color_id);
    const headerLabel = document.getElementById('chat-with-label');
    headerLabel.innerHTML = `// <span style="color:${contactColor}">${escapeHtml(contact.username)}</span>`;
    const statusLabel = document.getElementById('chat-status-label');
    const msgInput = document.getElementById('message-input');
    if (isOnline) {
        statusLabel.textContent = '[ONLINE]';
        statusLabel.className = 'online-label';
        msgInput.placeholder = 'type a message...';
        msgInput.classList.remove('input-offline');
    } else {
        statusLabel.textContent = `[last seen ${formatLastSeen(contact.last_seen_at)}]`;
        statusLabel.className = 'offline-label';
        msgInput.placeholder = 'type a message... [offline — will be delivered]';
        msgInput.classList.add('input-offline');
    }
    const dot = document.getElementById('chat-status-dot');
    dot.className = isOnline ? 'status-dot online-dot' : 'status-dot offline-dot';
}

function setLoginError(msg) {
    document.getElementById('login-error').textContent = msg;
}

// =============================================
// 5. AUTH
// =============================================
async function handleLogin() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
        setLoginError('// ENTER USERNAME AND PASSWORD');
        return;
    }

    setLoginError('');
    const email = username.toLowerCase() + '@theeye.local';

    let userId;

    // Try login first
    const { data: signInData, error: signInError } = await sb.auth.signInWithPassword({ email, password });

    if (signInError) {
        if (signInError.message.includes('Invalid login credentials') || signInError.message.includes('invalid_credentials')) {
            // Try signup
            const { data: signUpData, error: signUpError } = await sb.auth.signUp({
                email,
                password,
                options: { data: { username } }
            });

            if (signUpError) {
                if (signUpError.message.includes('already registered')) {
                    setLoginError('// WRONG PASSWORD');
                } else if (signUpError.message.toLowerCase().includes('unique') || signUpError.message.includes('duplicate')) {
                    setLoginError('// USERNAME TAKEN');
                } else {
                    setLoginError('// ' + signUpError.message.toUpperCase());
                }
                return;
            }

            userId = signUpData.user.id;
        } else {
            setLoginError('// ' + signInError.message.toUpperCase());
            return;
        }
    } else {
        userId = signInData.user.id;
    }

    await enterChat(userId, username);
}

function recolorRenderedMessages(userId) {
    const user = userId === currentUser.id ? currentUser : allUsers.find(u => u.id === userId);
    const hex = getColorHex(user?.color_id);
    document.querySelectorAll(`.message[data-sender-id="${userId}"] .msg-sender`).forEach(el => {
        el.style.color = hex;
    });
}

async function enterChat(userId, username) {
    currentUser = { id: userId, username };

    // Fetch all profiles (including color_id)
    const { data: profiles } = await sb.from('profiles').select('id, username, is_admin, status_text, color_id, last_seen_at').order('username');
    allUsers = profiles || [];

    // Set own color_id on currentUser
    const myProfile = allUsers.find(u => u.id === userId);
    if (myProfile) currentUser.color_id = myProfile.color_id;

    // Show chat view
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.body.classList.add('chat-mode');

    // Populate self-info panel
    const selfUsernameEl = document.getElementById('self-username');
    selfUsernameEl.textContent = username;
    selfUsernameEl.style.color = getColorHex(currentUser.color_id);
    await fetchLastMessageTimes();
    renderContacts();
    subscribeToMessages();
    subscribeToProfiles();
    subscribeToChannelMessages();
    subscribeToTyping();
    subscribeToLocks();
    joinPresence();

    // Update last_seen_at on login and every 2 minutes while active
    async function heartbeatLastSeen() {
        await sb.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', currentUser.id);
    }
    heartbeatLastSeen();
    lastSeenInterval = setInterval(heartbeatLastSeen, 2 * 60 * 1000);

    // Show placeholder until user picks a contact
    showPlaceholder();

}

async function handleLogout() {
    clearInterval(lastSeenInterval);
    lastSeenInterval = null;
    if (currentUser) {
        await sb.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', currentUser.id);
    }
    await leavePresence();
    unsubscribeAll();
    await sb.auth.signOut();

    currentUser = null;
    activeContact = null;
    allUsers = [];
    onlineIds.clear();
    renderedMsgIds.clear();
    lockedMessages.clear();
    viewMode = 'dm';
    activeChannel = null;

    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('login-view').classList.remove('hidden');
    document.body.classList.remove('chat-mode');

    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    setLoginError('');
    document.getElementById('username').focus();
}

async function restoreSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    const username = session.user.user_metadata?.username || session.user.email.split('@')[0];
    await enterChat(session.user.id, username);
}

// =============================================
// 6. DATA
// =============================================
async function loadMessages(contactId) {
    const me = currentUser.id;
    const them = contactId;
    const cacheKey = contactId;

    // Render cached messages instantly if available
    const cached = conversationCache.get(cacheKey);
    if (cached) {
        renderMessages(cached);
    } else {
        renderSkeleton();
    }

    // Fetch fresh data in background
    const { data, error } = await sb
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${me},recipient_id.eq.${them}),and(sender_id.eq.${them},recipient_id.eq.${me})`)
        .order('created_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error('loadMessages error:', error);
        return;
    }

    const rawMessages = (data || []).reverse();
    const clearKey = `clear-${currentUser.id}-dm-${contactId}`;
    const clearTime = parseInt(localStorage.getItem(clearKey) || '0', 10);
    
    const messages = rawMessages.filter(msg => {
        const isLocked = msg.locked || lockedMessages.has('dm:' + msg.id);
        if (isLocked) return true;
        if (!msg.created_at) return true;
        return new Date(msg.created_at).getTime() >= clearTime;
    });

    for (const msg of messages) {
        const sender = allUsers.find(u => u.id === msg.sender_id);
        msg.sender = sender ? { username: sender.username } : { username: '???' };
    }

    // Only re-render if this contact is still active
    if (viewMode === 'dm' && activeContact && activeContact.id === contactId) {
        conversationCache.set(cacheKey, messages);
        renderMessages(messages);
    }
}

async function loadChannelMessages(channelName) {
    const cacheKey = 'ch:' + channelName;

    const cached = conversationCache.get(cacheKey);
    if (cached) {
        renderMessages(cached);
    } else {
        renderSkeleton();
    }

    const { data, error } = await sb
        .from('channel_messages')
        .select('*')
        .eq('channel', channelName)
        .order('created_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error('loadChannelMessages error:', error);
        return;
    }

    const rawMessages = (data || []).reverse();
    const clearKey = `clear-${currentUser.id}-ch-${channelName}`;
    const clearTime = parseInt(localStorage.getItem(clearKey) || '0', 10);

    const messages = rawMessages.filter(msg => {
        const isLocked = msg.locked || lockedMessages.has('ch:' + msg.id);
        if (isLocked) return true;
        if (!msg.created_at) return true;
        return new Date(msg.created_at).getTime() >= clearTime;
    });

    for (const msg of messages) {
        const sender = allUsers.find(u => u.id === msg.sender_id);
        msg.sender = sender ? { username: sender.username } : { username: '???' };
    }

    if (viewMode === 'channel' && activeChannel === channelName) {
        conversationCache.set(cacheKey, messages);
        renderMessages(messages);
    }
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const body = input.value.trim();
    if (!body) return;

    // Push to input history (cap at 50)
    inputHistory.push(body);
    if (inputHistory.length > 50) inputHistory.shift();
    inputHistoryIdx = -1;
    inputHistoryDraft = '';

    hideCmdHints();
    if (await handleSlashCommand(body)) { input.value = ''; return; }

    if (viewMode === 'channel' && activeChannel) {
        input.value = '';
        const { error } = await sb.from('channel_messages').insert({
            sender_id: currentUser.id,
            channel: activeChannel,
            body
        });
        if (error) {
            console.error('sendChannelMessage error:', error);
            input.value = body;
        }
    } else if (viewMode === 'dm' && activeContact) {
        input.value = '';
        const { error } = await sb.from('messages').insert({
            sender_id: currentUser.id,
            recipient_id: activeContact.id,
            body
        });
        if (error) {
            console.error('sendMessage error:', error);
            input.value = body;
        } else {
            lastMessageTime.set(activeContact.id, Date.now());
            renderContacts();
        }
    }
}

async function sendAudioMessage(audioId, { userId, channel } = {}) {
    const body = `[AUDIO:${audioId}]`;
    if (channel) {
        const { error } = await sb.from('channel_messages').insert({
            sender_id: currentUser.id,
            channel,
            body
        });
        if (error) console.error('sendAudioMessage error:', error);
    } else if (userId) {
        const { error } = await sb.from('messages').insert({
            sender_id: currentUser.id,
            recipient_id: userId,
            body
        });
        if (error) console.error('sendAudioMessage error:', error);
        else { lastMessageTime.set(userId, Date.now()); renderContacts(); }
    }
}

// =============================================
// 7. REALTIME
// =============================================
function subscribeToMessages() {
    realtimeChannel = sb
        .channel('messages-for-' + currentUser.id)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${currentUser.id}` },
            handleIncomingMessage)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${currentUser.id}` },
            handleIncomingMessage)
        .subscribe();
}

async function handleIncomingMessage(payload) {
    const msg = payload.new;

    // Deduplicate self-echo
    if (renderedMsgIds.has(msg.id)) return;
    renderedMsgIds.add(msg.id);

    // Fetch sender username if not embedded
    const sender = allUsers.find(u => u.id === msg.sender_id);
    msg.sender = sender ? { username: sender.username } : { username: '???' };

    const isActiveConversation =
        activeContact &&
        ((msg.sender_id === activeContact.id && msg.recipient_id === currentUser.id) ||
         (msg.sender_id === currentUser.id && msg.recipient_id === activeContact.id));

    // Update cache for this conversation
    const dmCacheKey = msg.sender_id === currentUser.id ? msg.recipient_id : msg.sender_id;
    const cached = conversationCache.get(dmCacheKey);
    if (cached) cached.push(msg);

    // Update last message time
    lastMessageTime.set(dmCacheKey, new Date(msg.created_at).getTime());

    if (isActiveConversation) {
        renderContacts();
        hideTypingIndicator();
        appendMessage(msg);
    } else {
        // Play notification sound for incoming messages from non-active contacts
        if (msg.sender_id !== currentUser.id) {
            playNotif();
        }

        // Track unread count in state and re-render
        const contactId = msg.sender_id === currentUser.id ? msg.recipient_id : msg.sender_id;
        unreadCounts.set(contactId, (unreadCounts.get(contactId) || 0) + 1);
        renderContacts();
        updateTitle();
    }
}

function updateTitle() {
    const total = Array.from(document.querySelectorAll('.contact-unread'))
        .reduce((sum, b) => sum + (parseInt(b.dataset.count) || 0), 0);
    document.title = total > 0 ? `(${total}) The Eye` : 'The Eye';
}

function subscribeToProfiles() {
    profilesChannel = sb
        .channel('profiles-changes')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'profiles' },
            (payload) => {
                const newUser = { id: payload.new.id, username: payload.new.username };
                if (!allUsers.find(u => u.id === newUser.id)) {
                    allUsers.push(newUser);
                    allUsers.sort((a, b) => a.username.localeCompare(b.username));
                    renderContacts();
                }
            })
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'profiles' },
            (payload) => {
                const updated = payload.new;
                const idx = allUsers.findIndex(u => u.id === updated.id);
                if (idx !== -1) {
                    const colorChanged = allUsers[idx].color_id !== updated.color_id;
                    allUsers[idx] = { ...allUsers[idx], ...updated };
                    renderContacts();
                    if (colorChanged) {
                        recolorRenderedMessages(updated.id);
                    }
                }
            })
        .subscribe();
}

function subscribeToChannelMessages() {
    channelRealtimeChannel = sb
        .channel('channel-msgs')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'channel_messages' },
            handleIncomingChannelMessage)
        .subscribe();
}

function handleIncomingChannelMessage(payload) {
    const msg = payload.new;

    if (renderedMsgIds.has('ch-' + msg.id)) return;
    renderedMsgIds.add('ch-' + msg.id);

    const sender = allUsers.find(u => u.id === msg.sender_id);
    msg.sender = sender ? { username: sender.username } : { username: '???' };

    // Update channel cache
    const chCacheKey = 'ch:' + msg.channel;
    const chCached = conversationCache.get(chCacheKey);
    if (chCached) chCached.push(msg);

    if (viewMode === 'channel' && activeChannel === msg.channel) {
        hideTypingIndicator();
        appendMessage(msg);
    } else {
        // Play notification for messages from others
        if (msg.sender_id !== currentUser.id) {
            playNotif();
        }

        // Show unread badge on channel entry
        const el = document.querySelector(`.contact[data-channel="${msg.channel}"]`);
        if (el) {
            let badge = el.querySelector('.contact-unread');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'contact-unread';
                el.appendChild(badge);
            }
            const count = (parseInt(badge.dataset.count || '0')) + 1;
            badge.dataset.count = count;
            badge.textContent = `[${count}]`;
        }
        updateTitle();
    }
}

function unsubscribeAll() {
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
    if (profilesChannel) { sb.removeChannel(profilesChannel); profilesChannel = null; }
    if (channelRealtimeChannel) { sb.removeChannel(channelRealtimeChannel); channelRealtimeChannel = null; }
    if (typingChannel) { sb.removeChannel(typingChannel); typingChannel = null; }
    if (lockChannel) { sb.removeChannel(lockChannel); lockChannel = null; }
}

// =============================================
// 8. PRESENCE
// =============================================
function joinPresence() {
    presenceChannel = sb.channel('online-users', {
        config: { presence: { key: currentUser.id } }
    });

    presenceChannel
        .on('presence', { event: 'sync' }, () => {
            onlineIds = new Set(Object.keys(presenceChannel.presenceState()));
            renderContacts();
        })
        .on('presence', { event: 'join' }, ({ key }) => {
            onlineIds.add(key);
            updateContactStatus(key, true);
        })
        .on('presence', { event: 'leave' }, ({ key }) => {
            onlineIds.delete(key);
            updateContactStatus(key, false);
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await presenceChannel.track({ online_at: new Date().toISOString() });
            }
        });
}

async function leavePresence() {
    if (presenceChannel) {
        await presenceChannel.untrack();
        sb.removeChannel(presenceChannel);
        presenceChannel = null;
    }
}

// =============================================
// 9. CONTACT SWITCHING
// =============================================
function showPlaceholder() {
    document.getElementById('chat-placeholder').classList.remove('hidden');
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('message-feed').classList.add('hidden');
    document.getElementById('input-area').classList.add('hidden');
    document.getElementById('typing-indicator').classList.add('hidden');
    document.getElementById('new-msg-indicator').classList.add('hidden');
    document.getElementById('cmd-hints').classList.add('hidden');
    launchApp('wm-welcome');
}

function hidePlaceholder() {
    document.getElementById('chat-placeholder').classList.add('hidden');
    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('message-feed').classList.remove('hidden');
    document.getElementById('input-area').classList.remove('hidden');
    wmCloseAll();
}

function closeChat() {
    activeContact = null;
    activeChannel = null;
    viewMode = 'dm';
    document.querySelectorAll('.contact').forEach(c => c.classList.remove('active'));
    showPlaceholder();
}

async function switchContact(userId) {
    if (viewMode === 'dm' && activeContact && activeContact.id === userId) { closeChat(); return; }

    const contact = allUsers.find(u => u.id === userId);
    if (!contact) return;

    hidePlaceholder();
    viewMode = 'dm';
    activeChannel = null;
    activeContact = contact;
    hideTypingIndicator();

    // Clear unread badge
    unreadCounts.delete(userId);
    const el = document.querySelector(`.contact[data-user-id="${userId}"]`);
    if (el) {
        const badge = el.querySelector('.contact-unread');
        if (badge) badge.remove();
        updateTitle();
    }

    // Update active class
    document.querySelectorAll('.contact').forEach(c => {
        c.classList.toggle('active', c.dataset.userId === userId);
    });

    updateHeader(contact, onlineIds.has(userId));
    closeSidebar();
    await loadMessages(userId);
}

async function switchToChannel(channelName) {
    if (viewMode === 'channel' && activeChannel === channelName) { closeChat(); return; }

    hidePlaceholder();
    viewMode = 'channel';
    activeChannel = channelName;
    activeContact = null;
    hideTypingIndicator();

    // Clear unread badge on channel entry
    const el = document.querySelector(`.contact[data-channel="${channelName}"]`);
    if (el) {
        const badge = el.querySelector('.contact-unread');
        if (badge) badge.remove();
        updateTitle();
    }

    // Update active class
    document.querySelectorAll('.contact').forEach(c => {
        c.classList.toggle('active', c.dataset.channel === channelName);
    });

    // Update header
    document.getElementById('chat-with-label').textContent = `// #${channelName}`;
    const statusLabel = document.getElementById('chat-status-label');
    statusLabel.textContent = '[PUBLIC]';
    statusLabel.className = 'online-label';
    const dot = document.getElementById('chat-status-dot');
    dot.className = 'status-dot online-dot';
    const msgInput = document.getElementById('message-input');
    msgInput.placeholder = 'type a message...';
    msgInput.classList.remove('input-offline');

    closeSidebar();
    await loadChannelMessages(channelName);
}

// =============================================
// 10. EVENT LISTENERS
// =============================================
// Unlock audio on first user interaction (required for mobile browsers)
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

// Audio toggle
const audioToggleBtn = document.getElementById('audio-toggle');
if (audioToggleBtn) {
    audioToggleBtn.addEventListener('click', toggleMute);
}

// Themes button
const themesBtnEl = document.getElementById('themes-btn');
if (themesBtnEl) {
    themesBtnEl.addEventListener('click', cmdThemeList);
}

// Sidebar toggle (mobile)
function closeSidebar() {
    document.body.classList.remove('sidebar-open');
}

document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
});

document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

// Auto-scroll tracking
document.getElementById('message-feed').addEventListener('scroll', checkIfAtBottom);

// New message indicator click — snap to bottom
document.getElementById('new-msg-indicator').addEventListener('click', () => {
    isUserAtBottom = true;
    scrollToBottom(true);
});

document.getElementById('login-btn').addEventListener('click', handleLogin);

document.getElementById('logout-btn').addEventListener('click', handleLogout);

document.getElementById('close-chat-btn').addEventListener('click', closeChat);

document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('message-input').addEventListener('input', () => {
    const val = document.getElementById('message-input').value;
    if (val.trim()) broadcastTyping();

    // Command hints: show when input starts with "/" and has no space yet
    if (val.startsWith('/') && !val.includes(' ')) {
        const filter = val.slice(1).toLowerCase();
        showCmdHints(filter);
    } else {
        hideCmdHints();
    }
});

document.getElementById('message-input').addEventListener('keydown', e => {
    const hintsVisible = !document.getElementById('cmd-hints').classList.contains('hidden');

    // When hints are visible, intercept navigation keys
    if (hintsVisible) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            navigateCmdHints(e.key === 'ArrowDown' ? 'down' : 'up');
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (cmdHintIdx === -1) navigateCmdHints('down');
            confirmCmdHint();
            return;
        }
        if (e.key === 'Enter') {
            if (confirmCmdHint()) { e.preventDefault(); return; }
            // If no hint selected, fall through to send
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            hideCmdHints();
            return;
        }
    }

    if (e.key === 'Enter') { sendMessage(); return; }

    const input = e.target;

    // Up arrow — browse history backwards (only when input is empty or already browsing)
    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey) {
        if (inputHistory.length === 0) return;
        if (input.value && inputHistoryIdx === -1) return; // has unsaved typed text, don't hijack

        e.preventDefault();
        if (inputHistoryIdx === -1) {
            // entering history mode — stash current text
            inputHistoryDraft = input.value;
            inputHistoryIdx = inputHistory.length - 1;
        } else if (inputHistoryIdx > 0) {
            inputHistoryIdx--;
        }
        input.value = inputHistory[inputHistoryIdx];
        return;
    }

    // Down arrow — browse history forwards
    if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey) {
        if (inputHistoryIdx === -1) return; // not in history mode

        e.preventDefault();
        if (inputHistoryIdx < inputHistory.length - 1) {
            inputHistoryIdx++;
            input.value = inputHistory[inputHistoryIdx];
        } else {
            // exit history mode — restore draft
            inputHistoryIdx = -1;
            input.value = inputHistoryDraft;
        }
        return;
    }
});

document.getElementById('password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
});

document.getElementById('username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('password').focus();
});

// Command hint clicks
document.getElementById('cmd-hints').addEventListener('click', e => {
    const el = e.target.closest('.cmd-hint');
    if (el) selectCmdHint(el.dataset.cmd);
});

// Contact clicks (event delegation — contacts are dynamic)
document.querySelector('.contact-list').addEventListener('click', e => {
    // Collapsible section header toggle
    const headerEl = e.target.closest('.contact-section-collapsible');
    if (headerEl) {
        const collapsed = window._offlineCollapsed !== false;
        window._offlineCollapsed = !collapsed;
        const toggleSpan = headerEl.querySelector('.section-toggle');
        if (toggleSpan) toggleSpan.textContent = window._offlineCollapsed ? '[+]' : '[\u2212]';
        let sibling = headerEl.nextElementSibling;
        while (sibling && !sibling.classList.contains('contact-section-header')) {
            if (sibling.dataset.offlineItem) sibling.style.display = window._offlineCollapsed ? 'none' : '';
            sibling = sibling.nextElementSibling;
        }
        return;
    }

    // Favorite star toggle
    const favEl = e.target.closest('.contact-fav');
    if (favEl && favEl.dataset.favId) {
        e.stopPropagation();
        toggleFavorite(favEl.dataset.favId);
        return;
    }

    const el = e.target.closest('.contact');
    if (!el) return;
    if (el.dataset.channel) {
        switchToChannel(el.dataset.channel);
    } else if (el.dataset.userId) {
        switchContact(el.dataset.userId);
    }
});

// =============================================
// CONTACT FILTER
// =============================================
function applyContactFilter(query) {
    const q = query.trim().toLowerCase();
    const contacts = document.querySelectorAll('.contact-list .contact');
    let channelVisible = false;

    contacts.forEach(el => {
        const nameEl = el.querySelector('.contact-name');
        const rawName = nameEl ? (nameEl.dataset.username || nameEl.textContent) : '';
        const name = rawName.toLowerCase();
        const visible = !q || name.includes(q);
        el.style.display = visible ? '' : 'none';
        if (el.dataset.channel) channelVisible = visible;

        // Highlight matching substring in non-channel contacts
        if (nameEl && !el.dataset.channel) {
            if (q && visible) {
                const idx = name.indexOf(q);
                if (idx !== -1) {
                    const before = escapeHtml(rawName.slice(0, idx));
                    const match  = escapeHtml(rawName.slice(idx, idx + q.length));
                    const after  = escapeHtml(rawName.slice(idx + q.length));
                    nameEl.innerHTML = `${before}<mark class="contact-filter-match">${match}</mark>${after}`;
                }
            } else {
                nameEl.textContent = rawName;
            }
        }
    });

    // Show/hide the separator that sits right after the channel entry
    const sep = document.querySelector('.contact-list .channel-separator');
    if (sep) sep.style.display = channelVisible ? '' : 'none';

    // Show/hide section headers based on whether any contacts in their group are visible
    document.querySelectorAll('.contact-list .contact-section-header').forEach(header => {
        if (!q) { header.style.display = ''; return; }
        let hasVisible = false;
        let sibling = header.nextElementSibling;
        while (sibling && !sibling.classList.contains('contact-section-header')) {
            if (sibling.classList.contains('contact') && sibling.style.display !== 'none') {
                hasVisible = true;
                break;
            }
            sibling = sibling.nextElementSibling;
        }
        header.style.display = hasVisible ? '' : 'none';
    });
}

const contactFilterInput = document.getElementById('contact-filter');
if (contactFilterInput) {
    contactFilterInput.addEventListener('input', () => {
        applyContactFilter(contactFilterInput.value);
    });

    contactFilterInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            contactFilterInput.value = '';
            applyContactFilter('');
            contactFilterInput.blur();
        }
        // Enter — focus message input (quick switch after filtering)
        if (e.key === 'Enter') {
            document.getElementById('message-input').focus();
        }
    });
}


// '/' to focus contact search (terminal convention)
document.addEventListener('keydown', e => {
    if (e.key !== '/') return;
    const active = document.activeElement;
    const filterInput = document.getElementById('contact-filter');
    const msgInput = document.getElementById('message-input');
    if (!filterInput) return;
    if (active === filterInput || active === msgInput) return;
    // Don't intercept if typing in any other input/textarea
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    filterInput.focus();
    filterInput.select();
});

// =============================================
// KEYBOARD SHORTCUTS — Alt+Up/Down to switch contacts
// =============================================
function getContactOrder() {
    return Array.from(document.querySelectorAll('.contact-list .contact'))
        .filter(c => c.style.display !== 'none');
}

function switchByOffset(offset) {
    const contacts = getContactOrder();
    if (contacts.length === 0) return;

    let activeIdx = contacts.findIndex(c => c.classList.contains('active'));
    if (activeIdx === -1) activeIdx = 0;

    let next = activeIdx + offset;
    if (next < 0) next = contacts.length - 1;
    if (next >= contacts.length) next = 0;

    const el = contacts[next];
    if (el.dataset.channel) {
        switchToChannel(el.dataset.channel);
    } else if (el.dataset.userId) {
        switchContact(el.dataset.userId);
    }
}

document.addEventListener('keydown', e => {
    if (!currentUser) return;

    // Alt+Up / Alt+Down to switch contacts
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        switchByOffset(e.key === 'ArrowUp' ? -1 : 1);
        return;
    }

    // Ctrl+J / Ctrl+K to switch contacts
    if (e.ctrlKey && (e.key === 'j' || e.key === 'k')) {
        e.preventDefault();
        switchByOffset(e.key === 'k' ? -1 : 1);
        return;
    }

    // Escape to close help modal
    if (e.key === 'Escape') {
        closeHelpModal();
        return;
    }

    // Global typing capture — any printable key refocuses the message input
    const input = document.getElementById('message-input');
    if (document.activeElement === input) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key.length !== 1) return; // ignore non-printable keys (Shift, Tab, etc.)

    // Don't capture if user is in the login form
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Don't capture if help modal is open
    if (!document.getElementById('help-modal').classList.contains('hidden')) return;

    input.focus();
    // The keystroke will now naturally land in the focused input
});

// =============================================
// HELP MODAL
// =============================================
function openHelpModal() {
    const section = document.getElementById('help-commands-section');
    section.innerHTML = '';
    for (const [name, cmd] of Object.entries(COMMANDS)) {
        const row = document.createElement('div');
        row.className = 'help-row';
        row.innerHTML = `<span class="help-key">${cmd.usage || '/' + name}</span><span class="help-desc">${cmd.description}</span>`;
        section.appendChild(row);
    }
    document.getElementById('help-modal').classList.remove('hidden');
}

function closeHelpModal() {
    document.getElementById('help-modal').classList.add('hidden');
}

document.getElementById('help-btn').addEventListener('click', openHelpModal);
document.getElementById('help-modal-backdrop').addEventListener('click', closeHelpModal);
document.getElementById('help-close-btn').addEventListener('click', closeHelpModal);

// =============================================
// WINDOW MANAGER
// =============================================
const WM = {
    windows: new Map(),
    nextId: 1,
    topZ: 10,
    dragState: null,
    resizeState: null,
    apps: new Map(),
    selectedIcon: null,
    iconDragState: null,
};

function createWindow({ title = 'UNTITLED', content = '', width = 400, height = 300, x, y, id } = {}) {
    const winId = id || `wm-win-${WM.nextId++}`;
    const desktop = document.getElementById('wm-desktop');
    if (!desktop) return null;

    const bounds = desktop.getBoundingClientRect();

    if (x === undefined) x = Math.max(10, (bounds.width - width) / 2 + (WM.nextId * 20) % 60);
    if (y === undefined) y = Math.max(10, (bounds.height - height) / 2 + (WM.nextId * 20) % 40);

    x = Math.min(x, bounds.width - 100);
    y = Math.min(y, bounds.height - 40);

    const win = document.createElement('div');
    win.className = 'wm-window';
    win.dataset.wmId = winId;
    win.style.left = x + 'px';
    win.style.top = y + 'px';
    win.style.width = width + 'px';
    win.style.height = height + 'px';
    win.style.zIndex = ++WM.topZ;

    win.innerHTML = `
        <div class="wm-titlebar">
            <span class="wm-title">// ${title.toUpperCase()}</span>
            <div class="wm-controls">
                <button class="wm-btn wm-btn-min" title="Minimize">
                    <span class="bracket left">[</span>_<span class="bracket right">]</span>
                </button>
                <button class="wm-btn wm-btn-max" title="Maximize">
                    <span class="bracket left">[</span>&#9633;<span class="bracket right">]</span>
                </button>
                <button class="wm-btn wm-btn-close" title="Close">
                    <span class="bracket left">[</span>&times;<span class="bracket right">]</span>
                </button>
            </div>
        </div>
        <div class="wm-body"></div>
        <div class="wm-resize-handle"></div>
    `;

    const body = win.querySelector('.wm-body');
    if (typeof content === 'string') {
        body.innerHTML = content;
    } else if (content instanceof HTMLElement) {
        body.appendChild(content);
    }

    win.addEventListener('mousedown', () => wmFocus(winId));

    const titlebar = win.querySelector('.wm-titlebar');
    titlebar.addEventListener('mousedown', (e) => {
        if (e.target.closest('.wm-btn')) return;
        wmStartDrag(e, winId);
    });
    titlebar.addEventListener('touchstart', (e) => {
        if (e.target.closest('.wm-btn')) return;
        wmStartDrag(e, winId);
    }, { passive: false });

    const handle = win.querySelector('.wm-resize-handle');
    handle.addEventListener('mousedown', (e) => wmStartResize(e, winId));
    handle.addEventListener('touchstart', (e) => wmStartResize(e, winId), { passive: false });

    win.querySelector('.wm-btn-min').addEventListener('click', () => wmMinimize(winId));
    win.querySelector('.wm-btn-max').addEventListener('click', () => wmToggleMaximize(winId));
    win.querySelector('.wm-btn-close').addEventListener('click', () => wmClose(winId));

    titlebar.addEventListener('dblclick', () => wmToggleMaximize(winId));

    desktop.appendChild(win);

    WM.windows.set(winId, {
        el: win,
        options: { title, width, height },
        minimized: false,
        maximized: false,
        prevBounds: null,
    });

    wmFocus(winId);
    return winId;
}

function wmFocus(winId) {
    const entry = WM.windows.get(winId);
    if (!entry || entry.minimized) return;
    WM.windows.forEach(w => w.el.classList.remove('wm-focused'));
    entry.el.classList.add('wm-focused');
    entry.el.style.zIndex = ++WM.topZ;
}

function wmStartDrag(e, winId) {
    const entry = WM.windows.get(winId);
    if (!entry || entry.maximized) return;
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    WM.dragState = {
        winId,
        startX: pt.clientX,
        startY: pt.clientY,
        startLeft: parseInt(entry.el.style.left),
        startTop: parseInt(entry.el.style.top),
    };
    document.body.classList.add('wm-dragging');
}

function wmStartResize(e, winId) {
    const entry = WM.windows.get(winId);
    if (!entry || entry.maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = e.touches ? e.touches[0] : e;
    WM.resizeState = {
        winId,
        startX: pt.clientX,
        startY: pt.clientY,
        startW: entry.el.offsetWidth,
        startH: entry.el.offsetHeight,
    };
    document.body.classList.add('wm-dragging');
}

function wmOnPointerMove(e) {
    if (WM.dragState) {
        const pt = e.touches ? e.touches[0] : e;
        const entry = WM.windows.get(WM.dragState.winId);
        if (!entry) return;
        const desktop = document.getElementById('wm-desktop');
        const bounds = desktop.getBoundingClientRect();
        const dx = pt.clientX - WM.dragState.startX;
        const dy = pt.clientY - WM.dragState.startY;
        let newLeft = WM.dragState.startLeft + dx;
        let newTop = WM.dragState.startTop + dy;
        newLeft = Math.max(-entry.el.offsetWidth + 60, Math.min(newLeft, bounds.width - 60));
        newTop = Math.max(0, Math.min(newTop, bounds.height - 30));
        entry.el.style.left = newLeft + 'px';
        entry.el.style.top = newTop + 'px';
    }
    if (WM.resizeState) {
        const pt = e.touches ? e.touches[0] : e;
        const entry = WM.windows.get(WM.resizeState.winId);
        if (!entry) return;
        const dx = pt.clientX - WM.resizeState.startX;
        const dy = pt.clientY - WM.resizeState.startY;
        entry.el.style.width = Math.max(220, WM.resizeState.startW + dx) + 'px';
        entry.el.style.height = Math.max(120, WM.resizeState.startH + dy) + 'px';
    }
    if (WM.iconDragState) {
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - WM.iconDragState.startX;
        const dy = pt.clientY - WM.iconDragState.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            WM.iconDragState.moved = true;
        }
        if (WM.iconDragState.moved) {
            const el = WM.iconDragState.el;
            const desktop = document.getElementById('wm-desktop');
            const bounds = desktop.getBoundingClientRect();
            let newLeft = WM.iconDragState.startLeft + dx;
            let newTop = WM.iconDragState.startTop + dy;
            newLeft = Math.max(0, Math.min(newLeft, bounds.width - el.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, bounds.height - el.offsetHeight));
            el.style.left = newLeft + 'px';
            el.style.top = newTop + 'px';
        }
    }
}

function wmOnPointerUp() {
    if (WM.iconDragState && !WM.iconDragState.moved) {
        // Treat as click — select the icon
        wmSelectIcon(WM.iconDragState.el);
    }
    WM.dragState = null;
    WM.resizeState = null;
    WM.iconDragState = null;
    document.body.classList.remove('wm-dragging');
}

document.addEventListener('mousemove', wmOnPointerMove);
document.addEventListener('mouseup', wmOnPointerUp);
document.addEventListener('touchmove', wmOnPointerMove, { passive: false });
document.addEventListener('touchend', wmOnPointerUp);

// App registry
function registerApp({ id, name, symbol, launch }) {
    WM.apps.set(id, { id, name, symbol, launch });
    const idx = WM.apps.size - 1;
    createDesktopIcon(id, 16, 16 + idx * 90);
}

function launchApp(id) {
    const app = WM.apps.get(id);
    if (!app) return;
    const winEntry = WM.windows.get(id);
    if (winEntry) {
        if (winEntry.minimized) wmRestore(id);
        else wmFocus(id);
        return;
    }
    app.launch();
}

function createDesktopIcon(appId, x, y) {
    const desktop = document.getElementById('wm-desktop');
    if (!desktop) return;
    const app = WM.apps.get(appId);
    if (!app) return;

    // Remove existing icon for this app if present
    const existing = desktop.querySelector(`.wm-icon[data-app-id="${appId}"]`);
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'wm-icon';
    el.dataset.appId = appId;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.innerHTML = `
        <div class="wm-icon-symbol">${app.symbol}</div>
        <div class="wm-icon-label">${app.name}</div>
    `;

    el.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const pt = e.touches ? e.touches[0] : e;
        WM.iconDragState = {
            el,
            startX: pt.clientX,
            startY: pt.clientY,
            startLeft: parseInt(el.style.left),
            startTop: parseInt(el.style.top),
            moved: false,
        };
        document.body.classList.add('wm-dragging');
    });

    el.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        const pt = e.touches[0];
        WM.iconDragState = {
            el,
            startX: pt.clientX,
            startY: pt.clientY,
            startLeft: parseInt(el.style.left),
            startTop: parseInt(el.style.top),
            moved: false,
        };
        document.body.classList.add('wm-dragging');
    }, { passive: false });

    el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        launchApp(appId);
    });

    desktop.appendChild(el);
}

function wmSelectIcon(el) {
    if (WM.selectedIcon) WM.selectedIcon.classList.remove('wm-icon-selected');
    WM.selectedIcon = el;
    if (el) el.classList.add('wm-icon-selected');
}

function wmDeselectAllIcons() {
    if (WM.selectedIcon) {
        WM.selectedIcon.classList.remove('wm-icon-selected');
        WM.selectedIcon = null;
    }
}

document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.wm-icon') && !e.target.closest('.wm-window')) {
        wmDeselectAllIcons();
    }
});

function wmMinimize(winId) {
    const entry = WM.windows.get(winId);
    if (!entry) return;
    entry.minimized = true;
    entry.el.style.display = 'none';

    const taskbar = document.getElementById('wm-taskbar');
    const btn = document.createElement('button');
    btn.className = 'wm-taskbar-entry';
    btn.dataset.wmId = winId;
    btn.textContent = entry.options.title;
    btn.addEventListener('click', () => wmRestore(winId));
    taskbar.appendChild(btn);
}

function wmRestore(winId) {
    const entry = WM.windows.get(winId);
    if (!entry) return;
    entry.minimized = false;
    entry.el.style.display = 'flex';
    wmFocus(winId);

    const taskbar = document.getElementById('wm-taskbar');
    const btn = taskbar.querySelector(`[data-wm-id="${winId}"]`);
    if (btn) btn.remove();
}

function wmToggleMaximize(winId) {
    const entry = WM.windows.get(winId);
    if (!entry) return;
    if (entry.maximized) {
        const b = entry.prevBounds;
        entry.el.style.left = b.left;
        entry.el.style.top = b.top;
        entry.el.style.width = b.width;
        entry.el.style.height = b.height;
        entry.el.classList.remove('wm-maximized');
        entry.maximized = false;
    } else {
        entry.prevBounds = {
            left: entry.el.style.left,
            top: entry.el.style.top,
            width: entry.el.style.width,
            height: entry.el.style.height,
        };
        entry.el.classList.add('wm-maximized');
        entry.maximized = true;
    }
}

function wmClose(winId) {
    const entry = WM.windows.get(winId);
    if (!entry) return;
    entry.el.remove();
    WM.windows.delete(winId);

    const taskbar = document.getElementById('wm-taskbar');
    const btn = taskbar?.querySelector(`[data-wm-id="${winId}"]`);
    if (btn) btn.remove();
}

function wmCloseAll() {
    WM.windows.forEach((_, id) => wmClose(id));
}

function wmSpawnWelcome() {
    const username = currentUser?.username || 'operator';
    const theme = getStoredTheme();
    const content = `
        <div class="wm-welcome">
            <div class="wm-welcome-greeting">&gt; welcome back, <span class="wm-welcome-user">${username}</span></div>

            <div class="wm-section-title">// QUICK START</div>
            <div class="wm-tip-list">
                <div class="wm-tip"><span class="wm-tip-key">Alt+Up/Down</span><span class="wm-tip-desc">switch contacts</span></div>
                <div class="wm-tip"><span class="wm-tip-key">Ctrl+K / J</span><span class="wm-tip-desc">prev / next contact</span></div>
                <div class="wm-tip"><span class="wm-tip-key">/help</span><span class="wm-tip-desc">list all commands</span></div>
                <div class="wm-tip"><span class="wm-tip-key">/lock</span><span class="wm-tip-desc">send a locked message</span></div>
                <div class="wm-tip"><span class="wm-tip-key">/color</span><span class="wm-tip-desc">change your name color</span></div>
            </div>

            <div class="wm-section-title">// STATUS</div>
            <div class="wm-tip-list">
                <div class="wm-status-row">session <span class="wm-status-val">active</span></div>
                <div class="wm-status-row">theme <span class="wm-status-val">${theme}</span></div>
                <div class="wm-status-row">version <span class="wm-status-val">1.0.0</span></div>
            </div>

            <div class="wm-welcome-footer"><span class="wm-blink">_</span> select a contact to begin</div>
        </div>
    `;

    createWindow({
        title: 'WELCOME',
        content,
        width: 360,
        height: 340,
        id: 'wm-welcome',
    });
}

// =============================================
// BUILT-IN APPS
// =============================================
registerApp({
    id: 'wm-welcome',
    name: 'WELCOME',
    symbol: '[&gt;]',
    launch() {
        if (WM.windows.has('wm-welcome')) {
            const e = WM.windows.get('wm-welcome');
            if (e.minimized) wmRestore('wm-welcome'); else wmFocus('wm-welcome');
            return;
        }
        wmSpawnWelcome();
    },
});

registerApp({
    id: 'app-settings',
    name: 'SETTINGS',
    symbol: '[#]',
    launch() {
        if (WM.windows.has('app-settings')) {
            const e = WM.windows.get('app-settings');
            if (e.minimized) wmRestore('app-settings'); else wmFocus('app-settings');
            return;
        }
        const current = getStoredTheme();
        const themeButtons = THEMES.map(t => `
            <button class="wm-settings-theme-btn${t.id === current ? ' active' : ''}" data-theme="${t.id}">
                <span class="bracket left">[</span>${t.id}<span class="bracket right">]</span>
                <span class="wm-settings-theme-name">${t.name} — ${t.desc}</span>
            </button>
        `).join('');
        const content = `
            <div class="wm-section-title">// APPEARANCE</div>
            <div class="wm-settings-themes">${themeButtons}</div>

            <div class="wm-section-title">// IDENTITY</div>
            <div class="wm-settings-username-row">
                <span class="wm-settings-label">username</span>
                <div class="wm-settings-username-input-wrap">
                    <input id="wm-settings-username-input" class="wm-settings-username-input"
                           type="text" spellcheck="false" autocomplete="off"
                           value="${escapeHtml(currentUser?.username || '')}" maxlength="32" />
                    <button id="wm-settings-username-save" class="wm-settings-save-btn">
                        <span class="bracket left">[</span>save<span class="bracket right">]</span>
                    </button>
                </div>
                <div id="wm-settings-username-msg" class="wm-settings-msg"></div>
            </div>
        `;
        createWindow({ id: 'app-settings', title: 'SETTINGS', content, width: 300, height: 360 });
        const settingsWin = document.querySelector('.wm-window[data-wm-id="app-settings"]');
        if (settingsWin) {
            settingsWin.querySelectorAll('.wm-settings-theme-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    applyTheme(btn.dataset.theme);
                    settingsWin.querySelectorAll('.wm-settings-theme-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });

            const usernameInput = settingsWin.querySelector('#wm-settings-username-input');
            const saveBtn = settingsWin.querySelector('#wm-settings-username-save');
            const msgEl = settingsWin.querySelector('#wm-settings-username-msg');

            async function saveUsername() {
                const newName = usernameInput.value.trim();
                if (!newName) { msgEl.textContent = 'name cannot be empty'; msgEl.className = 'wm-settings-msg error'; return; }
                if (newName === currentUser?.username) { msgEl.textContent = 'no change'; msgEl.className = 'wm-settings-msg'; return; }
                saveBtn.disabled = true;
                msgEl.textContent = 'saving...';
                msgEl.className = 'wm-settings-msg';

                // Update profile row first (catches duplicate name conflicts)
                const { error: profileError } = await sb.from('profiles').update({ username: newName }).eq('id', currentUser.id);
                if (profileError) {
                    saveBtn.disabled = false;
                    msgEl.textContent = profileError.message.includes('unique') ? 'name already taken' : 'error saving';
                    msgEl.className = 'wm-settings-msg error';
                    return;
                }

                // Update auth user_metadata so restoreSession picks up the new name on next load
                await sb.auth.updateUser({ data: { username: newName } });

                saveBtn.disabled = false;
                currentUser.username = newName;
                const selfEl = document.getElementById('self-username');
                if (selfEl) selfEl.textContent = newName;
                msgEl.textContent = 'saved';
                msgEl.className = 'wm-settings-msg success';
                setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 2000);
            }

            saveBtn.addEventListener('click', saveUsername);
            usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUsername(); });
        }
    },
});

//=============================================
// SOUNDBOARD APP
// =============================================
function wmSpawnSoundboard() {
    const sounds = [
        { id: 1,  label: 'AUDIO 01' },
        { id: 2,  label: 'AUDIO 02' },
        { id: 3,  label: 'AUDIO 03' },
        { id: 4,  label: 'AUDIO 04' },
        { id: 5,  label: 'AUDIO 05' },
        { id: 6,  label: 'AUDIO 06' },
        { id: 7,  label: 'AUDIO 07' },
        { id: 8,  label: 'AUDIO 08' },
        { id: 9,  label: 'AUDIO 09' },
        { id: 10, label: 'AUDIO 10' },
        { id: 11, label: 'AUDIO 11' },
        { id: 12, label: 'AUDIO 12' },
    ];

    const buttons = sounds.map(s =>
        `<div class="sb-item">` +
        `<button class="sb-btn" data-src="Audios/audio${s.id}.mp3" data-id="${s.id}">${s.label}</button>` +
        `<button class="sb-send-btn" data-id="${s.id}" title="Send to chat">[↑]</button>` +
        `</div>`
    ).join('');

    const content = `
        <div class="sb-grid">${buttons}</div>
        <button class="sb-stop">[■] stop all</button>`;

    createWindow({
        id: 'app-soundboard',
        title: 'SOUNDBOARD',
        content,
        width: 340,
        height: 340,
    });

    const activeAudios = new Map(); // src → Audio
    const win = document.querySelector('.wm-window[data-wm-id="app-soundboard"]');
    if (!win) return;

    function showSendPicker(sendBtn, audioId) {
        const existing = win.querySelector('.sb-picker');
        if (existing) { existing.remove(); return; }

        const picker = document.createElement('div');
        picker.className = 'sb-picker';

        const targets = [];
        if (currentUser.is_admin) targets.push({ label: '#GLOBAL', type: 'channel', id: 'GLOBAL' });
        allUsers.forEach(u => {
            if (u.id !== currentUser.id && onlineIds.has(u.id)) {
                targets.push({ label: u.username, type: 'dm', id: u.id });
            }
        });

        picker.innerHTML = targets.map(t =>
            `<button class="sb-picker-item" data-type="${t.type}" data-id="${t.id}">${escapeHtml(t.label)}</button>`
        ).join('');

        const btnRect = sendBtn.getBoundingClientRect();
        const bodyRect = win.querySelector('.wm-body').getBoundingClientRect();
        picker.style.top = (btnRect.bottom - bodyRect.top) + 'px';
        picker.style.left = (btnRect.left - bodyRect.left) + 'px';

        win.querySelector('.wm-body').appendChild(picker);

        picker.querySelectorAll('.sb-picker-item').forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.type === 'channel') {
                    sendAudioMessage(audioId, { channel: item.dataset.id });
                } else {
                    sendAudioMessage(audioId, { userId: item.dataset.id });
                }
                picker.remove();
            });
        });

        setTimeout(() => {
            document.addEventListener('click', () => picker.remove(), { once: true });
        }, 0);
    }

    function stopAll() {
        activeAudios.forEach(audio => { audio.pause(); audio.currentTime = 0; });
        activeAudios.clear();
        win.querySelectorAll('.sb-btn.sb-btn-active').forEach(b => b.classList.remove('sb-btn-active'));
    }

    win.querySelectorAll('.sb-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const src = btn.dataset.src;
            if (activeAudios.has(src)) {
                // toggle off
                const a = activeAudios.get(src);
                a.pause();
                a.currentTime = 0;
                activeAudios.delete(src);
                btn.classList.remove('sb-btn-active');
            } else {
                const audio = new Audio(src);
                audio.play();
                audio.addEventListener('ended', () => {
                    activeAudios.delete(src);
                    btn.classList.remove('sb-btn-active');
                });
                activeAudios.set(src, audio);
                btn.classList.add('sb-btn-active');
            }
        });
    });

    win.querySelectorAll('.sb-send-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); showSendPicker(btn, btn.dataset.id); });
    });

    win.querySelector('.sb-stop').addEventListener('click', stopAll);
}

// Soundboard is a secret app — registered silently without a desktop icon.
// Unlock it by typing /yase in the chat.
WM.apps.set('app-soundboard', {
    id: 'app-soundboard',
    name: 'SOUNDBOARD',
    symbol: '[♪]',
    launch() {
        if (WM.windows.has('app-soundboard')) {
            const e = WM.windows.get('app-soundboard');
            if (e.minimized) wmRestore('app-soundboard');
            else wmFocus('app-soundboard');
            return;
        }
        wmSpawnSoundboard();
    },
});

//=============================================
// BOOT
// =============================================
restoreSession();
