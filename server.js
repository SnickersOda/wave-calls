const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 }); // 10MB for file transfers
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './wave.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '👤',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    owner_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    nickname TEXT,
    added_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (owner_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT,
    type TEXT DEFAULT 'text',
    file_name TEXT,
    file_size INTEGER,
    reply_to TEXT,
    reactions TEXT DEFAULT '{}',
    deleted INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id);
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, read);
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const hashPassword = (pw) => crypto.createHash('sha256').update(pw + 'wave_salt_2024').digest('hex');

const onlineUsers = new Map();

// ── PeerJS ────────────────────────────────────────────────────────────────────
app.use('/peerjs', ExpressPeerServer(server, { debug: false }));

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name, password, avatar } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Имя слишком короткое' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(name.trim());
  if (existing) return res.status(409).json({ error: 'Имя уже занято' });

  const user = {
    id: uuidv4().slice(0, 8).toUpperCase(),
    name: name.trim(),
    password_hash: hashPassword(password),
    avatar: avatar || '👤'
  };
  db.prepare('INSERT INTO users (id, name, password_hash, avatar) VALUES (?, ?, ?, ?)').run(user.id, user.name, user.password_hash, user.avatar);
  res.json({ id: user.id, name: user.name, avatar: user.avatar });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Заполни все поля' });

  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'Неверный пароль' });

  res.json({ id: user.id, name: user.name, avatar: user.avatar });
});

app.get('/api/user/:id', (req, res) => {
  const user = db.prepare('SELECT id, name, avatar FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ ...user, online: onlineUsers.has(user.id) });
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/api/contacts/:userId', (req, res) => {
  const contacts = db.prepare(`
    SELECT u.id, u.name, u.avatar, c.nickname, c.added_at
    FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = ? ORDER BY u.name
  `).all(req.params.userId);

  res.json(contacts.map(c => ({
    ...c,
    online: onlineUsers.has(c.id),
    unread: db.prepare('SELECT COUNT(*) as n FROM messages WHERE from_id=? AND to_id=? AND read=0 AND deleted=0').get(c.id, req.params.userId)?.n || 0
  })));
});

app.post('/api/contacts', (req, res) => {
  const { ownerId, contactId } = req.body;
  const contact = db.prepare('SELECT * FROM users WHERE id = ?').get(contactId);
  if (!contact) return res.status(404).json({ error: 'Пользователь не найден' });
  if (ownerId === contactId) return res.status(400).json({ error: 'Нельзя добавить себя' });
  db.prepare('INSERT OR REPLACE INTO contacts (owner_id, contact_id) VALUES (?, ?)').run(ownerId, contactId);
  res.json({ ...contact, online: onlineUsers.has(contact.id) });
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))
    ORDER BY created_at ASC
  `).all(a, b, b, a);

  db.prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=? AND read=0').run(b, a);
  res.json(msgs.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '{}') })));
});

app.delete('/api/messages/:id', (req, res) => {
  const { userId } = req.body;
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Не найдено' });
  if (msg.from_id !== userId) return res.status(403).json({ error: 'Нет прав' });
  db.prepare('UPDATE messages SET deleted=1, text=NULL, file_name=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);
    const notifyAll = (table, field) =>
      db.prepare(`SELECT ${field} FROM ${table} WHERE ${field === 'contact_id' ? 'owner_id' : 'owner_id'}=?`).all(userId);

    const contacts = db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(userId);
    const reverse  = db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(userId);
    [...contacts.map(c => c.contact_id), ...reverse.map(c => c.owner_id)].forEach(id => {
      io.to(id).emit('presence', { userId, online: true });
    });
  });

  socket.on('message', ({ toId, text, type = 'text', fileName, fileSize, fileData, replyTo }) => {
    if (!socket.userId || !toId) return;
    if (!text && !fileData) return;

    const msg = {
      id: uuidv4(),
      from_id: socket.userId,
      to_id: toId,
      text: text || null,
      type,
      file_name: fileName || null,
      file_size: fileSize || null,
      reply_to: replyTo || null,
      reactions: '{}',
      deleted: 0,
      read: 0,
      created_at: Math.floor(Date.now() / 1000),
      fileData // only in memory, not stored in DB
    };

    db.prepare(`INSERT INTO messages (id, from_id, to_id, text, type, file_name, file_size, reply_to, reactions, deleted, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      msg.id, msg.from_id, msg.to_id, msg.text, msg.type,
      msg.file_name, msg.file_size, msg.reply_to, msg.reactions,
      msg.deleted, msg.read, msg.created_at
    );

    const out = { ...msg, reactions: {}, fileData: msg.fileData };
    io.to(toId).emit('message', out);
    socket.emit('message', out);
  });

  socket.on('reaction', ({ msgId, emoji, toId }) => {
    if (!socket.userId) return;
    const msg = db.prepare('SELECT reactions FROM messages WHERE id=?').get(msgId);
    if (!msg) return;
    const reactions = JSON.parse(msg.reactions || '{}');
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(socket.userId);
    if (idx >= 0) reactions[emoji].splice(idx, 1);
    else reactions[emoji].push(socket.userId);
    if (reactions[emoji].length === 0) delete reactions[emoji];
    db.prepare('UPDATE messages SET reactions=? WHERE id=?').run(JSON.stringify(reactions), msgId);
    const update = { msgId, reactions };
    io.to(toId).emit('reaction-update', update);
    socket.emit('reaction-update', update);
  });

  socket.on('delete-message', ({ msgId, toId }) => {
    if (!socket.userId) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(msgId);
    if (!msg || msg.from_id !== socket.userId) return;
    db.prepare('UPDATE messages SET deleted=1, text=NULL, file_name=NULL WHERE id=?').run(msgId);
    io.to(toId).emit('message-deleted', { msgId });
    socket.emit('message-deleted', { msgId });
  });

  socket.on('typing', ({ toId, typing }) => {
    if (!socket.userId) return;
    io.to(toId).emit('typing', { fromId: socket.userId, typing });
  });

  socket.on('read', ({ fromId }) => {
    if (!socket.userId) return;
    db.prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=? AND read=0').run(fromId, socket.userId);
    io.to(fromId).emit('read', { byId: socket.userId });
  });

  socket.on('call-invite', ({ toId, callType, peerId }) => {
    if (!socket.userId) return;
    const caller = db.prepare('SELECT id, name, avatar FROM users WHERE id=?').get(socket.userId);
    io.to(toId).emit('call-invite', { from: caller, callType, peerId });
  });

  socket.on('call-accept', ({ toId, peerId }) => { io.to(toId).emit('call-accept', { peerId }); });
  socket.on('call-decline', ({ toId }) => { io.to(toId).emit('call-decline', {}); });
  socket.on('call-end', ({ toId }) => { io.to(toId).emit('call-end', {}); });

  socket.on('disconnect', () => {
    if (!socket.userId) return;
    onlineUsers.delete(socket.userId);
    const contacts = db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(socket.userId);
    const reverse  = db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(socket.userId);
    [...contacts.map(c => c.contact_id), ...reverse.map(c => c.owner_id)].forEach(id => {
      io.to(id).emit('presence', { userId: socket.userId, online: false });
    });
  });
});

server.listen(PORT, () => console.log('WAVE v2 running on port ' + PORT));
