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

function scrollToBottom() {
    const feed = document.getElementById('message-feed');
    feed.scrollTop = feed.scrollHeight;
}

// =============================================
// 4. UI / RENDER
// =============================================
function renderContacts() {
    const list = document.querySelector('.contact-list');
    list.innerHTML = '';

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
        el.className = 'contact' + (activeContact && activeContact.id === user.id ? ' active' : '');
        el.dataset.userId = user.id;
        el.innerHTML =
            `<span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>` +
            `<span class="contact-name">${escapeHtml(user.username)}</span>` +
            `<span class="contact-badge">${isOnline ? '[ON]' : '[OFF]'}</span>`;
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
    const time = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : nowTime();

    el.innerHTML =
        `<span class="msg-time">[${time}]</span>` +
        ` <span class="msg-sender">${escapeHtml(senderName)}</span>` +
        `<span class="msg-sep">></span>` +
        `<span class="msg-text">${escapeHtml(msg.body)}</span>`;

    feed.appendChild(el);
    scrollToBottom();
}

function renderMessages(messages) {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';
    renderedMsgIds.clear();

    const sys = document.createElement('div');
    sys.className = 'system-msg';
    sys.textContent = `// CONNECTION ESTABLISHED — ${activeContact ? activeContact.username : '...'}`;
    feed.appendChild(sys);

    for (const msg of messages) {
        renderedMsgIds.add(msg.id);
        appendMessage(msg, false);
    }

    scrollToBottom();
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
    const { data: profiles } = await sb.from('profiles').select('id, username').order('username');
    allUsers = profiles || [];

    // Show chat view
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.body.classList.add('chat-mode');

    renderContacts();
    subscribeToMessages();
    subscribeToProfiles();
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

    const { data, error } = await sb
        .from('messages')
        .select('*, sender:profiles!sender_id(username)')
        .or(`and(sender_id.eq.${me},recipient_id.eq.${them}),and(sender_id.eq.${them},recipient_id.eq.${me})`)
        .order('created_at', { ascending: true })
        .limit(200);

    if (error) {
        console.error('loadMessages error:', error);
        return;
    }

    renderMessages(data || []);
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const body = input.value.trim();
    if (!body || !activeContact) return;

    input.value = '';

    const { error } = await sb.from('messages').insert({
        sender_id: currentUser.id,
        recipient_id: activeContact.id,
        body
    });

    if (error) {
        console.error('sendMessage error:', error);
        input.value = body; // restore on failure
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

    if (isActiveConversation) {
        appendMessage(msg);
    } else {
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
    }
}

function subscribeToProfiles() {
    profilesChannel = sb
        .channel('profiles-inserts')
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
        .subscribe();
}

function unsubscribeAll() {
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
    if (profilesChannel) { sb.removeChannel(profilesChannel); profilesChannel = null; }
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
    if (activeContact && activeContact.id === userId) return;

    const contact = allUsers.find(u => u.id === userId);
    if (!contact) return;

    activeContact = contact;

    // Clear unread badge
    const el = document.querySelector(`.contact[data-user-id="${userId}"]`);
    if (el) {
        const badge = el.querySelector('.contact-unread');
        if (badge) badge.remove();
    }

    // Update active class
    document.querySelectorAll('.contact').forEach(c => {
        c.classList.toggle('active', c.dataset.userId === userId);
    });

    updateHeader(contact, onlineIds.has(userId));
    await loadMessages(userId);
}

// =============================================
// 10. EVENT LISTENERS
// =============================================
document.getElementById('login-btn').addEventListener('click', handleLogin);

document.getElementById('logout-btn').addEventListener('click', handleLogout);

document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
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
    if (el && el.dataset.userId) switchContact(el.dataset.userId);
});

// Sound button
document.getElementById('SoundBtn').addEventListener('click', () => {
    new Audio('assets/notif.mp3').play();
});

// =============================================
// BOOT
// =============================================
restoreSession();
