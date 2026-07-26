const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// Optional: auto-append each transaction to a Google Sheet as a live backup.
// Configure GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID
// (and optionally GOOGLE_SHEET_NAME) to enable. Silently does nothing if unset.
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!email || !key || !sheetId) return null;
  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    sheetId,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Sheet1'
  };
}

const sheetsEnabled = !!getSheetsClient();
if (!sheetsEnabled) {
  console.warn('Google Sheets sync not configured (set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID to enable).');
}

async function appendEntryToSheet(entry) {
  const client = getSheetsClient();
  if (!client) return;
  try {
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: `${client.sheetName}!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          entry.date,
          entry.type === 'income' ? 'Received' : 'Expense',
          entry.desc,
          entry.amount,
          entry.enteredBy,
          new Date(entry.id).toISOString()
        ]]
      }
    });
  } catch (err) {
    console.error('Google Sheets sync failed:', err.message);
  }
}

// Seeds users.json on first run from APP_USERS ("Name1:pin1,Name2:pin2") or APP_PIN, for migration.
// The first user in the list becomes admin; the rest are regular users.
function seedUsers() {
  if (process.env.APP_USERS) {
    const users = [];
    for (const pair of process.env.APP_USERS.split(',')) {
      const [name, pin] = pair.split(':').map(s => s && s.trim());
      if (name && pin) users.push({ name, pin, role: users.length === 0 ? 'admin' : 'user' });
    }
    if (users.length) return users;
  }
  return [{ name: 'You', pin: process.env.APP_PIN || '1234', role: 'admin' }];
}

function loadUsers() {
  let users;
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    users = seedUsers();
    saveUsers(users);
    return users;
  }
  // Migrate any users missing a role (from an older version of this app).
  let migrated = false;
  if (!users.some(u => u.role === 'admin')) {
    users.forEach((u, i) => { if (!u.role) u.role = i === 0 ? 'admin' : 'user'; });
    migrated = true;
  }
  if (migrated) saveUsers(users);
  return users;
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

if (!process.env.APP_USERS && !process.env.APP_PIN && !fs.existsSync(USERS_FILE)) {
  console.warn('WARNING: APP_USERS/APP_PIN env var not set — using default PIN "1234". Change it from the Users tab after logging in.');
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

function requireAdmin(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'admin access required' });
}

app.post('/api/login', (req, res) => {
  const { pin } = req.body || {};
  const users = loadUsers();
  const match = typeof pin === 'string' ? users.find(u => u.pin === pin) : undefined;
  if (match) {
    req.session.authenticated = true;
    req.session.userName = match.name;
    req.session.role = match.role;
    return res.json({ ok: true, userName: match.name, role: match.role });
  }
  return res.status(401).json({ error: 'invalid pin' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const authenticated = !!(req.session && req.session.authenticated);
  res.json({
    authenticated,
    userName: authenticated ? req.session.userName : null,
    role: authenticated ? req.session.role : null
  });
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
  appendEntryToSheet(entry);
});

app.delete('/api/entries/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const entries = loadEntries().filter(e => e.id !== id);
  saveEntries(entries);
  res.json({ ok: true });
});

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(loadUsers().map(u => ({ name: u.name, role: u.role })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, pin, role } = req.body || {};
  const userRole = role === 'admin' ? 'admin' : 'user';
  if (typeof name !== 'string' || !name.trim() || typeof pin !== 'string' || !pin.trim()) {
    return res.status(400).json({ error: 'name and pin are required' });
  }
  const trimmedName = name.trim().slice(0, 60);
  const users = loadUsers();
  if (users.some(u => u.name.toLowerCase() === trimmedName.toLowerCase())) {
    return res.status(409).json({ error: 'a user with that name already exists' });
  }
  if (users.some(u => u.pin === pin)) {
    return res.status(409).json({ error: 'that pin is already in use' });
  }
  users.push({ name: trimmedName, pin, role: userRole });
  saveUsers(users);
  res.status(201).json({ name: trimmedName, role: userRole });
});

app.put('/api/users/:name', requireAdmin, (req, res) => {
  const targetName = req.params.name;
  const { newName, newPin, newRole } = req.body || {};
  const users = loadUsers();
  const user = users.find(u => u.name === targetName);
  if (!user) return res.status(404).json({ error: 'user not found' });

  if (typeof newName === 'string' && newName.trim()) {
    const trimmedName = newName.trim().slice(0, 60);
    if (users.some(u => u.name !== targetName && u.name.toLowerCase() === trimmedName.toLowerCase())) {
      return res.status(409).json({ error: 'a user with that name already exists' });
    }
    user.name = trimmedName;
  }
  if (typeof newPin === 'string' && newPin.trim()) {
    if (users.some(u => u !== user && u.pin === newPin)) {
      return res.status(409).json({ error: 'that pin is already in use' });
    }
    user.pin = newPin;
  }
  if (newRole === 'admin' || newRole === 'user') {
    const otherAdmins = users.filter(u => u !== user && u.role === 'admin');
    if (newRole === 'user' && user.role === 'admin' && otherAdmins.length === 0) {
      return res.status(400).json({ error: 'cannot demote the last remaining admin' });
    }
    user.role = newRole;
  }

  saveUsers(users);
  if (req.session.userName === targetName) {
    req.session.userName = user.name;
    req.session.role = user.role;
  }
  res.json({ name: user.name, role: user.role });
});

app.delete('/api/users/:name', requireAdmin, (req, res) => {
  const users = loadUsers();
  const target = users.find(u => u.name === req.params.name);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (users.length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last remaining user' });
  }
  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last remaining admin' });
  }
  const remaining = users.filter(u => u.name !== req.params.name);
  saveUsers(remaining);
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
