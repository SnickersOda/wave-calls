const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './wave.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
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
    read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id);
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, read);
`);

// ── Online users map: userId -> socketId ──────────────────────────────────────
const onlineUsers = new Map();

// ── PeerJS server ─────────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, { debug: false });
app.use('/peerjs', peerServer);

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── REST: register / login ────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { name, avatar } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Имя слишком короткое' });

  // Check if user with this exact name exists — just return their ID (simple auth)
  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());
  if (!user) {
    user = { id: uuidv4().slice(0, 8).toUpperCase(), name: name.trim(), avatar: avatar || '👤' };
    db.prepare('INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)').run(user.id, user.name, user.avatar);
  }
  res.json(user);
});

app.get('/api/user/:id', (req, res) => {
  const user = db.prepare('SELECT id, name, avatar FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ ...user, online: onlineUsers.has(user.id) });
});

// ── REST: contacts ────────────────────────────────────────────────────────────
app.get('/api/contacts/:userId', (req, res) => {
  const contacts = db.prepare(`
    SELECT u.id, u.name, u.avatar, c.nickname, c.added_at
    FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = ?
    ORDER BY u.name
  `).all(req.params.userId);

  const result = contacts.map(c => ({
    ...c,
    online: onlineUsers.has(c.id),
    unread: db.prepare('SELECT COUNT(*) as n FROM messages WHERE from_id=? AND to_id=? AND read=0').get(c.id, req.params.userId)?.n || 0
  }));
  res.json(result);
});

app.post('/api/contacts', (req, res) => {
  const { ownerId, contactId, nickname } = req.body;
  const contact = db.prepare('SELECT * FROM users WHERE id = ?').get(contactId);
  if (!contact) return res.status(404).json({ error: 'Пользователь не найден' });
  if (ownerId === contactId) return res.status(400).json({ error: 'Нельзя добавить себя' });

  db.prepare('INSERT OR REPLACE INTO contacts (owner_id, contact_id, nickname) VALUES (?, ?, ?)').run(ownerId, contactId, nickname || null);
  res.json({ ...contact, online: onlineUsers.has(contact.id) });
});

app.delete('/api/contacts/:ownerId/:contactId', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE owner_id=? AND contact_id=?').run(req.params.ownerId, req.params.contactId);
  res.json({ ok: true });
});

// ── REST: messages ────────────────────────────────────────────────────────────
app.get('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before || Date.now();

  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))
      AND created_at < ?
    ORDER BY created_at DESC LIMIT ?
  `).all(a, b, b, a, Math.floor(before / 1000), limit);

  // Mark as read
  db.prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=? AND read=0').run(b, a);

  res.json(msgs.reverse());
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);

    // Notify contacts that user came online
    const contacts = db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(userId);
    contacts.forEach(({ contact_id }) => {
      io.to(contact_id).emit('presence', { userId, online: true });
    });

    // Also notify users who have this user in contacts
    const reverseContacts = db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(userId);
    reverseContacts.forEach(({ owner_id }) => {
      io.to(owner_id).emit('presence', { userId, online: true });
    });
  });

  socket.on('message', ({ toId, text, type = 'text' }) => {
    if (!socket.userId || !toId || !text) return;

    const msg = {
      id: uuidv4(),
      from_id: socket.userId,
      to_id: toId,
      text,
      type,
      read: 0,
      created_at: Math.floor(Date.now() / 1000)
    };

    db.prepare('INSERT INTO messages (id, from_id, to_id, text, type, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      msg.id, msg.from_id, msg.to_id, msg.text, msg.type, msg.read, msg.created_at
    );

    // Send to recipient if online
    io.to(toId).emit('message', msg);
    // Echo back to sender (other tabs)
    socket.emit('message', msg);
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

  socket.on('call-accept', ({ toId, peerId }) => {
    io.to(toId).emit('call-accept', { peerId, fromId: socket.userId });
  });

  socket.on('call-decline', ({ toId }) => {
    io.to(toId).emit('call-decline', { fromId: socket.userId });
  });

  socket.on('call-end', ({ toId }) => {
    io.to(toId).emit('call-end', { fromId: socket.userId });
  });

  socket.on('disconnect', () => {
    if (!socket.userId) return;
    onlineUsers.delete(socket.userId);

    const contacts = db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(socket.userId);
    contacts.forEach(({ contact_id }) => io.to(contact_id).emit('presence', { userId: socket.userId, online: false }));
    const reverseContacts = db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(socket.userId);
    reverseContacts.forEach(({ owner_id }) => io.to(owner_id).emit('presence', { userId: socket.userId, online: false }));
  });
});

server.listen(PORT, () => console.log('WAVE running on port ' + PORT));
