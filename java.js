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
    img.src = 'assets/logo.png';
})();

// =============================================
// 1. CONFIG
// =============================================
const SUPABASE_URL  = 'https://afuwppfrljzmnbndizxz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmdXdwcGZybGp6bW5ibmRpenh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDA4MzgsImV4cCI6MjA4OTQxNjgzOH0.-EK1da5r3n38YVs6pPPKMWiyWyzsVdGlUwX5iygY5LA';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

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
let notifAudio      = new Audio('assets/notif.mp3');
let viewMode        = 'dm';       // 'dm' or 'channel'
let activeChannel   = null;       // e.g. 'GLOBAL'
let channelRealtimeChannel = null;
let inputHistory        = [];       // sent messages (oldest → newest)
let inputHistoryIdx     = -1;       // -1 = not browsing history
let inputHistoryDraft   = '';       // stash of unsent text when entering history
let isUserAtBottom      = true;     // auto-scroll tracking
let newMsgCount         = 0;        // unread count while scrolled up
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
    if (!audioUnlocked) return;
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
function appendSystemMsg(text) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = '// ' + text;
    feed.appendChild(el);
    scrollToBottom();
}

const COMMANDS = {
    clear:  { description: 'Clear the message feed',  handler: cmdClear },
    who:    { description: 'Show online users',        handler: cmdWho },
    status: { description: 'Set your status text',     handler: cmdStatus },
    help:   { description: 'Show available commands',  handler: cmdHelp },
};

async function handleSlashCommand(body) {
    if (!body.startsWith('/')) return false;
    const spaceIdx = body.indexOf(' ');
    const name = (spaceIdx === -1 ? body.slice(1) : body.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
    const cmd = COMMANDS[name];
    if (!cmd) {
        appendSystemMsg('UNKNOWN COMMAND: /' + name + ' — type /help');
        return true;
    }
    await cmd.handler(args);
    return true;
}

function cmdClear() {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    renderedMsgIds.clear();
    appendSystemMsg('FEED CLEARED');
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

async function cmdStatus(args) {
    if (!args) {
        appendSystemMsg('USAGE: /status <text>  — set status');
        appendSystemMsg('       /status remove  — clear status');
        return;
    }
    const isRemove = args.trim().toLowerCase() === 'remove';
    const text = isRemove ? null : args.slice(0, 100);
    const { error } = await sb.from('profiles').update({ status_text: text }).eq('id', currentUser.id);
    if (error) {
        appendSystemMsg('ERROR SETTING STATUS');
        console.error('cmdStatus error:', error);
    } else {
        updateSelfStatus(text);
        appendSystemMsg(isRemove ? 'STATUS CLEARED' : 'STATUS SET: ' + text);
    }
}

function updateSelfStatus(statusText) {
    const el = document.getElementById('self-status-text');
    if (!el) return;
    el.textContent = statusText || '';
    el.style.display = statusText ? 'block' : 'none';
}

function cmdHelp() {
    appendSystemMsg('AVAILABLE COMMANDS:');
    for (const [name, cmd] of Object.entries(COMMANDS)) {
        appendSystemMsg('  /' + name + ' — ' + cmd.description);
    }
}

// =============================================
// 4. UI / RENDER
// =============================================
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

    for (const user of others) {
        const isOnline = onlineIds.has(user.id);
        const el = document.createElement('div');
        el.className = 'contact' + (viewMode === 'dm' && activeContact && activeContact.id === user.id ? ' active' : '');
        el.dataset.userId = user.id;
        el.innerHTML =
            `<span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>` +
            `<span class="contact-name">${escapeHtml(user.username)}</span>` +
            `<span class="contact-badge">${isOnline ? '[ON]' : '[OFF]'}</span>` +
            (user.status_text ? `<span class="contact-status">${escapeHtml(user.status_text)}</span>` : '');
        list.appendChild(el);
    }
}

function appendMessage(msg, animate = true) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    const isSelf = msg.sender_id === currentUser.id;
    el.className = 'message' + (isSelf ? ' self' : '');
    if (!animate) el.style.animation = 'none';

    const senderName = isSelf ? currentUser.username : (msg.sender ? msg.sender.username : '???');
    const senderUser = allUsers.find(u => u.id === msg.sender_id);
    const isAdmin = senderUser && senderUser.is_admin;
    const time = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : nowTime();

    el.innerHTML =
        `<span class="msg-time">[${time}]</span>` +
        ` <span class="msg-sender">${escapeHtml(senderName)}</span>` +
        (isAdmin ? `<span class="msg-admin-tag">[ADMIN]</span>` : '') +
        `<span class="msg-sep">></span>` +
        `<span class="msg-text">${escapeHtml(msg.body)}</span>`;

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
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return months[date.getMonth()] + ' ' + date.getDate();
}

function insertDateSeparator(feed, date) {
    const el = document.createElement('div');
    el.className = 'date-separator';
    el.innerHTML = `<span class="date-separator-line"></span><span class="date-separator-label">[ ${formatDateLabel(date)} ]</span><span class="date-separator-line"></span>`;
    feed.appendChild(el);
}

function renderMessages(messages) {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    renderedMsgIds.clear();

    const sys = document.createElement('div');
    sys.className = 'system-msg';
    sys.textContent = viewMode === 'channel'
        ? `// PUBLIC CHANNEL — #${activeChannel}`
        : `// CONNECTION ESTABLISHED — ${activeContact ? activeContact.username : '...'}`;
    feed.appendChild(sys);

    let lastDate = null;
    for (const msg of messages) {
        const dedupKey = viewMode === 'channel' ? 'ch-' + msg.id : msg.id;
        renderedMsgIds.add(dedupKey);

        if (msg.created_at) {
            const msgDate = new Date(msg.created_at);
            const dayStr = msgDate.toDateString();
            if (lastDate && lastDate !== dayStr) {
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
    const el = document.querySelector(`.contact[data-user-id="${userId}"]`);
    if (!el) return;
    const dot = el.querySelector('.status-dot');
    const badge = el.querySelector('.contact-badge');
    dot.className = 'status-dot ' + (isOnline ? 'online' : 'offline');
    badge.textContent = isOnline ? '[ON]' : '[OFF]';

    if (activeContact && activeContact.id === userId) {
        updateHeader(activeContact, isOnline);
    }
}

function updateHeader(contact, isOnline) {
    document.getElementById('chat-with-label').textContent = `// ${contact.username}`;
    const statusLabel = document.getElementById('chat-status-label');
    statusLabel.textContent = isOnline ? '[ONLINE]' : '[OFFLINE]';
    statusLabel.className = isOnline ? 'online-label' : 'offline-label';
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

async function enterChat(userId, username) {
    currentUser = { id: userId, username };

    // Fetch all profiles
    const { data: profiles } = await sb.from('profiles').select('id, username, is_admin, status_text').order('username');
    allUsers = profiles || [];

    // Show chat view
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.body.classList.add('chat-mode');

    // Populate self-info panel
    document.getElementById('self-username').textContent = username;
    const myProfile = allUsers.find(u => u.id === userId);
    updateSelfStatus(myProfile ? myProfile.status_text : null);

    renderContacts();
    subscribeToMessages();
    subscribeToProfiles();
    subscribeToChannelMessages();
    subscribeToTyping();
    joinPresence();

    // Auto-select first contact
    const first = allUsers.find(u => u.id !== currentUser.id);
    if (first) {
        switchContact(first.id);
    }

    document.getElementById('message-input').focus();
}

async function handleLogout() {
    await leavePresence();
    unsubscribeAll();
    await sb.auth.signOut();

    currentUser = null;
    activeContact = null;
    allUsers = [];
    onlineIds.clear();
    renderedMsgIds.clear();
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
        .order('created_at', { ascending: true })
        .limit(200);

    if (error) {
        console.error('loadMessages error:', error);
        return;
    }

    const messages = data || [];
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
        .order('created_at', { ascending: true })
        .limit(200);

    if (error) {
        console.error('loadChannelMessages error:', error);
        return;
    }

    const messages = data || [];
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
        }
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

    if (isActiveConversation) {
        hideTypingIndicator();
        appendMessage(msg);
    } else {
        // Play notification sound for incoming messages from non-active contacts
        if (msg.sender_id !== currentUser.id) {
            playNotif();
        }

        // Unread badge on sidebar contact
        const contactId = msg.sender_id === currentUser.id ? msg.recipient_id : msg.sender_id;
        const el = document.querySelector(`.contact[data-user-id="${contactId}"]`);
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
                    allUsers[idx] = { ...allUsers[idx], ...updated };
                    renderContacts();
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
async function switchContact(userId) {
    if (viewMode === 'dm' && activeContact && activeContact.id === userId) return;

    const contact = allUsers.find(u => u.id === userId);
    if (!contact) return;

    viewMode = 'dm';
    activeChannel = null;
    activeContact = contact;
    hideTypingIndicator();

    // Clear unread badge
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
    if (viewMode === 'channel' && activeChannel === channelName) return;

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

document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('message-input').addEventListener('input', () => {
    if (document.getElementById('message-input').value.trim()) broadcastTyping();
});

document.getElementById('message-input').addEventListener('keydown', e => {
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

// Contact clicks (event delegation — contacts are dynamic)
document.querySelector('.contact-list').addEventListener('click', e => {
    const el = e.target.closest('.contact');
    if (!el) return;
    if (el.dataset.channel) {
        switchToChannel(el.dataset.channel);
    } else if (el.dataset.userId) {
        switchContact(el.dataset.userId);
    }
});

// =============================================
// KEYBOARD SHORTCUTS — Alt+Up/Down to switch contacts
// =============================================
function getContactOrder() {
    return Array.from(document.querySelectorAll('.contact-list .contact'));
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
    document.getElementById('help-modal').classList.remove('hidden');
}

function closeHelpModal() {
    document.getElementById('help-modal').classList.add('hidden');
}

document.getElementById('help-btn').addEventListener('click', openHelpModal);
document.getElementById('help-modal-backdrop').addEventListener('click', closeHelpModal);
document.getElementById('help-close-btn').addEventListener('click', closeHelpModal);

//=============================================
// BOOT
// =============================================
restoreSession();
