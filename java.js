// Set white favicon using canvas + filter
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

const SoundBtn = document.getElementById('SoundBtn');
SoundBtn.addEventListener('click', () => {
    const audio = new Audio('assets/notif.mp3');
    audio.play();
});

const users = {
    Calle: {
        status: 'online',
        messages: [],
        replies: [
            'yase',
            'bro... take care of me tho',
            'nigga',
            'mer snälla!',
            'hej',
            'käften hora',
            'tack pappa',
            'im new bro',
        ]
    },
    Axel: {
        status: 'online',
        messages: [],
        replies: [
            'va?',
            'hallå',
            'ok',
            'nej',
            'lol',
            'vad vill du',
            'snacka senare',
            'haha sure',
        ]
    }
};

let currentUser = 'anon';
let activeContact = 'Calle';
let autoReplyTimer = null;

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

function renderMessages() {
    const feed = document.getElementById('message-feed');
    feed.innerHTML = '';

    const sys = document.createElement('div');
    sys.className = 'system-msg';
    sys.textContent = `// CONNECTION ESTABLISHED — ${activeContact}`;
    feed.appendChild(sys);

    for (const msg of users[activeContact].messages) {
        appendMessage(msg, false);
    }

    scrollToBottom();
}

function appendMessage(msg, animate = true) {
    const feed = document.getElementById('message-feed');
    const el = document.createElement('div');
    el.className = 'message' + (msg.sender === 'you' ? ' self' : '');
    if (!animate) el.style.animation = 'none';

    el.innerHTML =
        `<span class="msg-time">[${msg.time}]</span>` +
        ` <span class="msg-sender">${escapeHtml(msg.sender)}</span>` +
        `<span class="msg-sep">></span>` +
        `<span class="msg-text">${escapeHtml(msg.text)}</span>`;

    feed.appendChild(el);
    scrollToBottom();
}

function setTyping(show) {
    const indicator = document.getElementById('typing-indicator');
    indicator.classList.toggle('hidden', !show);
    if (show) indicator.innerHTML = `${activeContact} is typing<span class="blink-cursor">_</span>`;
}

function switchContact(name) {
    if (name === activeContact) return;
    clearTimeout(autoReplyTimer);
    setTyping(false);
    activeContact = name;

    document.querySelectorAll('.contact').forEach(el => {
        el.classList.toggle('active', el.dataset.user === name);
    });

    document.getElementById('chat-header').innerHTML =
        `<span>// ${name}</span><span class="online-label">[ONLINE]</span>`;

    renderMessages();
}

// === Contact switching ===
document.querySelectorAll('.contact').forEach(el => {
    el.addEventListener('click', () => switchContact(el.dataset.user));
});

// === Login ===
document.getElementById('login-btn').addEventListener('click', handleLogin);

document.getElementById('password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
});

document.getElementById('username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('password').focus();
});

function handleLogin() {
    const val = document.getElementById('username').value.trim();
    currentUser = val || 'anon';

    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
    document.body.classList.add('chat-mode');

    renderMessages();
    document.getElementById('message-input').focus();
}

// === Logout ===
document.getElementById('logout-btn').addEventListener('click', () => {
    clearTimeout(autoReplyTimer);
    currentUser = 'anon';

    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('login-view').classList.remove('hidden');
    document.body.classList.remove('chat-mode');

    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    setTyping(false);

    document.getElementById('username').focus();
});

// === Send Message ===
document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    const contact = users[activeContact];
    const msg = { sender: 'you', text, time: nowTime() };
    contact.messages.push(msg);
    appendMessage(msg);
    input.value = '';

    clearTimeout(autoReplyTimer);
    const repliedBy = activeContact;
    const thinkDelay = 1200 + Math.random() * 1600;
    autoReplyTimer = setTimeout(() => {
        if (activeContact !== repliedBy) return;
        setTyping(true);
        const typeDelay = 700 + Math.random() * 1100;
        autoReplyTimer = setTimeout(() => {
            if (activeContact !== repliedBy) return;
            setTyping(false);
            const replies = users[repliedBy].replies;
            const reply = replies[Math.floor(Math.random() * replies.length)];
            const replyMsg = { sender: repliedBy, text: reply, time: nowTime() };
            users[repliedBy].messages.push(replyMsg);
            appendMessage(replyMsg);
        }, typeDelay);
    }, thinkDelay);
}
