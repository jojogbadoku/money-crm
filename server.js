const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// APP_USERS format: "Name1:pin1,Name2:pin2". Falls back to APP_PIN (single user "You") for compatibility.
function loadUsers() {
  if (process.env.APP_USERS) {
    const users = new Map();
    for (const pair of process.env.APP_USERS.split(',')) {
      const [name, pin] = pair.split(':').map(s => s && s.trim());
      if (name && pin) users.set(pin, name);
    }
    if (users.size) return users;
  }
  return new Map([[process.env.APP_PIN || '1234', 'You']]);
}

const USERS = loadUsers();

if (!process.env.APP_USERS && !process.env.APP_PIN) {
  console.warn('WARNING: APP_USERS/APP_PIN env var not set — using default PIN "1234". Set these before deploying publicly.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

function loadEntries() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { pin } = req.body || {};
  const name = typeof pin === 'string' ? USERS.get(pin) : undefined;
  if (name) {
    req.session.authenticated = true;
    req.session.userName = name;
    return res.json({ ok: true, userName: name });
  }
  return res.status(401).json({ error: 'invalid pin' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const authenticated = !!(req.session && req.session.authenticated);
  res.json({ authenticated, userName: authenticated ? req.session.userName : null });
});

app.get('/api/entries', requireAuth, (req, res) => {
  res.json(loadEntries());
});

app.post('/api/entries', requireAuth, (req, res) => {
  const { date, type, desc, amount } = req.body || {};
  const amt = Number(amount);
  if (!date || (type !== 'income' && type !== 'expense') || !desc || !(amt > 0)) {
    return res.status(400).json({ error: 'invalid entry' });
  }
  const entries = loadEntries();
  const entry = {
    id: Date.now(),
    date: String(date),
    type,
    desc: String(desc).slice(0, 200),
    amount: amt,
    enteredBy: req.session.userName || 'You'
  };
  entries.push(entry);
  saveEntries(entries);
  res.status(201).json(entry);
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const entries = loadEntries().filter(e => e.id !== id);
  saveEntries(entries);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Money CRM running on port ${PORT}`);
});
