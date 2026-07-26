const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

const ENTRIES_SHEET = process.env.GOOGLE_SHEET_NAME || 'Entries';
const USERS_SHEET = process.env.GOOGLE_USERS_SHEET_NAME || 'Users';

// Credentials can come from a full service-account JSON key file (recommended —
// point GOOGLE_APPLICATION_CREDENTIALS at a Render "Secret File" containing it,
// so there's no manual copy-pasting of the private key to get wrong), or from
// GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY env vars directly.
function loadServiceAccountCredentials() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      return { email: parsed.client_email, key: parsed.private_key };
    } catch (err) {
      console.error(`Could not read service account key file at ${keyFile}:`, err.message);
      return null;
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) return { email, key: key.replace(/\\n/g, '\n') };
  return null;
}

// When configured, Google Sheets is the durable source of truth for both
// entries and users (survives Render redeploys/restarts, which wipe local
// files). Falls back to local JSON files when unconfigured, or if the sheet
// can't be reached at startup.
function getSheetsClient() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const creds = loadServiceAccountCredentials();
  if (!sheetId || !creds) return null;
  const auth = new google.auth.JWT({
    email: creds.email,
    key: creds.key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return { sheets: google.sheets({ version: 'v4', auth }), sheetId };
}

const sheetsConfigured = !!getSheetsClient();
let sheetsReady = false; // flips true once ensureSheetsReady() succeeds
const tabIds = {}; // sheet tab name -> numeric sheetId, needed for row deletes

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

function readLocalUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readLocalEntries() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Creates the Entries/Users tabs if missing, adds header rows, and — on a
// brand new sheet — migrates in whatever is currently in the local JSON
// files so existing data isn't lost the first time Sheets sync is enabled.
async function ensureSheetsReady() {
  const client = getSheetsClient();
  const meta = await client.sheets.spreadsheets.get({ spreadsheetId: client.sheetId });
  const existingTabs = new Map(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  const toAdd = [ENTRIES_SHEET, USERS_SHEET].filter(name => !existingTabs.has(name));
  if (toAdd.length) {
    const res = await client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: client.sheetId,
      requestBody: { requests: toAdd.map(title => ({ addSheet: { properties: { title } } })) }
    });
    res.data.replies.forEach(r => existingTabs.set(r.addSheet.properties.title, r.addSheet.properties.sheetId));
  }
  tabIds[ENTRIES_SHEET] = existingTabs.get(ENTRIES_SHEET);
  tabIds[USERS_SHEET] = existingTabs.get(USERS_SHEET);

  const [entriesVals, usersVals] = await Promise.all([
    client.sheets.spreadsheets.values.get({ spreadsheetId: client.sheetId, range: `${ENTRIES_SHEET}!A1:G1` }),
    client.sheets.spreadsheets.values.get({ spreadsheetId: client.sheetId, range: `${USERS_SHEET}!A1:C1` })
  ]);

  if (!entriesVals.data.values || !entriesVals.data.values.length) {
    await client.sheets.spreadsheets.values.update({
      spreadsheetId: client.sheetId,
      range: `${ENTRIES_SHEET}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['id', 'date', 'type', 'desc', 'amount', 'enteredBy', 'createdAt']] }
    });
    const localEntries = readLocalEntries();
    if (localEntries && localEntries.length) {
      await client.sheets.spreadsheets.values.append({
        spreadsheetId: client.sheetId,
        range: `${ENTRIES_SHEET}!A:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: localEntries.map(e => [e.id, e.date, e.type, e.desc, e.amount, e.enteredBy, new Date(e.id).toISOString()])
        }
      });
      console.log(`Migrated ${localEntries.length} entries from local data.json into the "${ENTRIES_SHEET}" sheet.`);
    }
  }

  if (!usersVals.data.values || !usersVals.data.values.length) {
    await client.sheets.spreadsheets.values.update({
      spreadsheetId: client.sheetId,
      range: `${USERS_SHEET}!A1:C1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['name', 'pin', 'role']] }
    });
    const localUsers = readLocalUsers() || seedUsers();
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: `${USERS_SHEET}!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: localUsers.map(u => [u.name, u.pin, u.role]) }
    });
    console.log(`Seeded the "${USERS_SHEET}" sheet with ${localUsers.length} user(s)${readLocalUsers() ? ' from local users.json' : ''}.`);
  }
}

async function findRowIndex(sheetName, name) {
  const client = getSheetsClient();
  const res = await client.sheets.spreadsheets.values.get({
    spreadsheetId: client.sheetId,
    range: `${sheetName}!A2:A`
  });
  const rows = res.data.values || [];
  return rows.findIndex(r => String(r[0]) === String(name));
}

async function deleteSheetRow(sheetName, rowIndex) {
  const client = getSheetsClient();
  await client.sheets.spreadsheets.batchUpdate({
    spreadsheetId: client.sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: tabIds[sheetName], dimension: 'ROWS', startIndex: rowIndex + 1, endIndex: rowIndex + 2 }
        }
      }]
    }
  });
}

async function loadEntries() {
  if (sheetsReady) {
    const client = getSheetsClient();
    const res = await client.sheets.spreadsheets.values.get({
      spreadsheetId: client.sheetId,
      range: `${ENTRIES_SHEET}!A2:G`
    });
    const rows = res.data.values || [];
    return rows.filter(r => r[0]).map(r => ({
      id: Number(r[0]),
      date: r[1] || '',
      type: r[2] || '',
      desc: r[3] || '',
      amount: Number(r[4]) || 0,
      enteredBy: r[5] || ''
    }));
  }
  return readLocalEntries() || [];
}

async function addEntry(entry) {
  if (sheetsReady) {
    const client = getSheetsClient();
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: `${ENTRIES_SHEET}!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[entry.id, entry.date, entry.type, entry.desc, entry.amount, entry.enteredBy, new Date(entry.id).toISOString()]] }
    });
    return;
  }
  const entries = readLocalEntries() || [];
  entries.push(entry);
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

async function removeEntry(id) {
  if (sheetsReady) {
    const idx = await findRowIndex(ENTRIES_SHEET, id);
    if (idx === -1) return;
    await deleteSheetRow(ENTRIES_SHEET, idx);
    return;
  }
  const entries = (readLocalEntries() || []).filter(e => e.id !== id);
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

async function loadUsers() {
  if (sheetsReady) {
    const client = getSheetsClient();
    const res = await client.sheets.spreadsheets.values.get({
      spreadsheetId: client.sheetId,
      range: `${USERS_SHEET}!A2:C`
    });
    const rows = res.data.values || [];
    return rows.filter(r => r[0]).map(r => ({ name: r[0], pin: r[1] || '', role: r[2] === 'admin' ? 'admin' : 'user' }));
  }
  let users = readLocalUsers();
  if (!users) {
    users = seedUsers();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    return users;
  }
  if (!users.some(u => u.role === 'admin')) {
    users.forEach((u, i) => { if (!u.role) u.role = i === 0 ? 'admin' : 'user'; });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  }
  return users;
}

async function addUserRecord(user) {
  if (sheetsReady) {
    const client = getSheetsClient();
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: `${USERS_SHEET}!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[user.name, user.pin, user.role]] }
    });
    return;
  }
  const users = await loadUsers();
  users.push(user);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function updateUserRecord(targetName, updatedUser) {
  if (sheetsReady) {
    const idx = await findRowIndex(USERS_SHEET, targetName);
    if (idx === -1) return false;
    const client = getSheetsClient();
    const rowNum = idx + 2;
    await client.sheets.spreadsheets.values.update({
      spreadsheetId: client.sheetId,
      range: `${USERS_SHEET}!A${rowNum}:C${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[updatedUser.name, updatedUser.pin, updatedUser.role]] }
    });
    return true;
  }
  const users = await loadUsers();
  const user = users.find(u => u.name === targetName);
  if (!user) return false;
  Object.assign(user, updatedUser);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  return true;
}

async function deleteUserRecord(name) {
  if (sheetsReady) {
    const idx = await findRowIndex(USERS_SHEET, name);
    if (idx === -1) return;
    await deleteSheetRow(USERS_SHEET, idx);
    return;
  }
  const users = (await loadUsers()).filter(u => u.name !== name);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

if (!sheetsConfigured) {
  console.warn('Google Sheets sync not configured (set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID to enable). Data will only be saved to local files, which Render wipes on every redeploy/restart.');
}
if (!process.env.APP_USERS && !process.env.APP_PIN && !sheetsConfigured && !fs.existsSync(USERS_FILE)) {
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'admin access required' });
}

// Wraps async route handlers so a Sheets API failure returns a 500 instead
// of crashing the process or silently dropping the write.
function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(`${req.method} ${req.path} failed:`, err.message);
    res.status(500).json({ error: 'storage error, please try again' });
  });
}

app.post('/api/login', asyncRoute(async (req, res) => {
  const { pin } = req.body || {};
  const users = await loadUsers();
  const match = typeof pin === 'string' ? users.find(u => u.pin === pin) : undefined;
  if (match) {
    req.session.authenticated = true;
    req.session.userName = match.name;
    req.session.role = match.role;
    return res.json({ ok: true, userName: match.name, role: match.role });
  }
  return res.status(401).json({ error: 'invalid pin' });
}));

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

app.get('/api/entries', requireAuth, asyncRoute(async (req, res) => {
  res.json(await loadEntries());
}));

app.post('/api/entries', requireAuth, asyncRoute(async (req, res) => {
  const { date, type, desc, amount } = req.body || {};
  const amt = Number(amount);
  if (!date || (type !== 'income' && type !== 'expense') || !desc || !(amt > 0)) {
    return res.status(400).json({ error: 'invalid entry' });
  }
  const entry = {
    id: Date.now(),
    date: String(date),
    type,
    desc: String(desc).slice(0, 200),
    amount: amt,
    enteredBy: req.session.userName || 'You'
  };
  await addEntry(entry);
  res.status(201).json(entry);
}));

app.delete('/api/entries/:id', requireAdmin, asyncRoute(async (req, res) => {
  await removeEntry(Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/users', requireAdmin, asyncRoute(async (req, res) => {
  res.json((await loadUsers()).map(u => ({ name: u.name, role: u.role })));
}));

app.post('/api/users', requireAdmin, asyncRoute(async (req, res) => {
  const { name, pin, role } = req.body || {};
  const userRole = role === 'admin' ? 'admin' : 'user';
  if (typeof name !== 'string' || !name.trim() || typeof pin !== 'string' || !pin.trim()) {
    return res.status(400).json({ error: 'name and pin are required' });
  }
  const trimmedName = name.trim().slice(0, 60);
  const users = await loadUsers();
  if (users.some(u => u.name.toLowerCase() === trimmedName.toLowerCase())) {
    return res.status(409).json({ error: 'a user with that name already exists' });
  }
  if (users.some(u => u.pin === pin)) {
    return res.status(409).json({ error: 'that pin is already in use' });
  }
  await addUserRecord({ name: trimmedName, pin, role: userRole });
  res.status(201).json({ name: trimmedName, role: userRole });
}));

app.put('/api/users/:name', requireAdmin, asyncRoute(async (req, res) => {
  const targetName = req.params.name;
  const { newName, newPin, newRole } = req.body || {};
  const users = await loadUsers();
  const user = users.find(u => u.name === targetName);
  if (!user) return res.status(404).json({ error: 'user not found' });

  const updated = { name: user.name, pin: user.pin, role: user.role };

  if (typeof newName === 'string' && newName.trim()) {
    const trimmedName = newName.trim().slice(0, 60);
    if (users.some(u => u.name !== targetName && u.name.toLowerCase() === trimmedName.toLowerCase())) {
      return res.status(409).json({ error: 'a user with that name already exists' });
    }
    updated.name = trimmedName;
  }
  if (typeof newPin === 'string' && newPin.trim()) {
    if (users.some(u => u !== user && u.pin === newPin)) {
      return res.status(409).json({ error: 'that pin is already in use' });
    }
    updated.pin = newPin;
  }
  if (newRole === 'admin' || newRole === 'user') {
    const otherAdmins = users.filter(u => u !== user && u.role === 'admin');
    if (newRole === 'user' && user.role === 'admin' && otherAdmins.length === 0) {
      return res.status(400).json({ error: 'cannot demote the last remaining admin' });
    }
    updated.role = newRole;
  }

  await updateUserRecord(targetName, updated);
  if (req.session.userName === targetName) {
    req.session.userName = updated.name;
    req.session.role = updated.role;
  }
  res.json({ name: updated.name, role: updated.role });
}));

app.delete('/api/users/:name', requireAdmin, asyncRoute(async (req, res) => {
  const users = await loadUsers();
  const target = users.find(u => u.name === req.params.name);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (users.length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last remaining user' });
  }
  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last remaining admin' });
  }
  await deleteUserRecord(req.params.name);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

async function start() {
  if (sheetsConfigured) {
    try {
      await ensureSheetsReady();
      sheetsReady = true;
      console.log(`Google Sheets sync ready — "${ENTRIES_SHEET}" and "${USERS_SHEET}" tabs are the source of truth.`);
    } catch (err) {
      console.error('Google Sheets sync failed to initialize, falling back to local files:', err.message);
    }
  }
  app.listen(PORT, () => {
    console.log(`Money CRM running on port ${PORT}`);
  });
}

start();
