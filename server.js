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
const io = new Server(server, { maxHttpBufferSize: 20e6 });
const PORT = process.env.PORT || 3000;

const db = new Database(process.env.DB_PATH || './wave.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '👤',
    avatar_img TEXT,
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
    file_data TEXT,
    reply_to TEXT,
    reactions TEXT DEFAULT '{}',
    deleted INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, read);
`);

const hashPw = pw => crypto.createHash('sha256').update(pw + 'wave_salt_v2').digest('hex');
const onlineUsers = new Map();

app.use('/peerjs', ExpressPeerServer(server, { debug: false }));
app.use(express.json({ limit: '20mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name, password, avatar_img } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.prepare('SELECT id FROM users WHERE name=?').get(name.trim()))
    return res.status(409).json({ error: 'Имя уже занято' });
  const id = uuidv4().slice(0, 8).toUpperCase();
  db.prepare('INSERT INTO users (id,name,password_hash,avatar,avatar_img) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), hashPw(password), '👤', avatar_img || null);
  res.json({ id, name: name.trim(), avatar: '👤', avatar_img: avatar_img || null });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE name=?').get(name?.trim());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.password_hash !== hashPw(password)) return res.status(401).json({ error: 'Неверный пароль' });
  res.json({ id: user.id, name: user.name, avatar: user.avatar, avatar_img: user.avatar_img });
});

app.get('/api/user/:id', (req, res) => {
  const u = db.prepare('SELECT id,name,avatar,avatar_img FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  res.json({ ...u, online: onlineUsers.has(u.id) });
});

app.patch('/api/user/:id', (req, res) => {
  const { name, avatar_img } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (name && name.trim() !== user.name) {
    if (db.prepare('SELECT id FROM users WHERE name=? AND id!=?').get(name.trim(), req.params.id))
      return res.status(409).json({ error: 'Имя уже занято' });
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name.trim(), req.params.id);
  }
  if (avatar_img !== undefined) {
    db.prepare('UPDATE users SET avatar_img=? WHERE id=?').run(avatar_img, req.params.id);
  }
  const updated = db.prepare('SELECT id,name,avatar,avatar_img FROM users WHERE id=?').get(req.params.id);
  // Notify contacts about name/avatar change
  const contacts = db.prepare('SELECT contact_id FROM contacts WHERE owner_id=?').all(req.params.id);
  const reverse  = db.prepare('SELECT owner_id FROM contacts WHERE contact_id=?').all(req.params.id);
  [...contacts.map(c=>c.contact_id), ...reverse.map(c=>c.owner_id)].forEach(uid => {
    io.to(uid).emit('user-updated', updated);
  });
  res.json(updated);
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/api/contacts/:userId', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id,u.name,u.avatar,u.avatar_img,c.nickname,c.added_at
    FROM contacts c JOIN users u ON u.id=c.contact_id
    WHERE c.owner_id=? ORDER BY u.name
  `).all(req.params.userId);
  res.json(rows.map(c => ({
    ...c,
    online: onlineUsers.has(c.id),
    unread: db.prepare('SELECT COUNT(*) n FROM messages WHERE from_id=? AND to_id=? AND read=0 AND deleted=0')
      .get(c.id, req.params.userId)?.n || 0
  })));
});

app.post('/api/contacts', (req, res) => {
  const { ownerId, contactId } = req.body;
  const c = db.prepare('SELECT * FROM users WHERE id=?').get(contactId);
  if (!c) return res.status(404).json({ error: 'Пользователь не найден' });
  if (ownerId === contactId) return res.status(400).json({ error: 'Нельзя добавить себя' });
  db.prepare('INSERT OR REPLACE INTO contacts (owner_id,contact_id) VALUES (?,?)').run(ownerId, contactId);
  res.json({ id:c.id, name:c.name, avatar:c.avatar, avatar_img:c.avatar_img, online: onlineUsers.has(c.id) });
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const msgs = db.prepare(`
    SELECT id,from_id,to_id,text,type,file_name,file_size,file_data,reply_to,reactions,deleted,read,created_at
    FROM messages
    WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
    ORDER BY created_at ASC
  `).all(a, b, b, a);
  db.prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=? AND read=0').run(b, a);
  res.json(msgs.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '{}') })));
});

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('join', ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);
    const notify = [
      ...db.prepare('SELECT contact_id id FROM contacts WHERE owner_id=?').all(userId),
      ...db.prepare('SELECT owner_id id FROM contacts WHERE contact_id=?').all(userId)
    ];
    notify.forEach(({ id }) => io.to(id).emit('presence', { userId, online: true }));
  });

  socket.on('message', ({ toId, text, type='text', fileName, fileSize, fileData, replyTo }) => {
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
      file_data: fileData || null,
      reply_to: replyTo || null,
      reactions: '{}',
      deleted: 0,
      read: 0,
      created_at: Math.floor(Date.now() / 1000)
    };
    db.prepare(`INSERT INTO messages
      (id,from_id,to_id,text,type,file_name,file_size,file_data,reply_to,reactions,deleted,read,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(msg.id,msg.from_id,msg.to_id,msg.text,msg.type,msg.file_name,msg.file_size,
           msg.file_data,msg.reply_to,msg.reactions,msg.deleted,msg.read,msg.created_at);
    const out = { ...msg, reactions: {} };
    io.to(toId).emit('message', out);
    socket.emit('message', out);
  });

  socket.on('reaction', ({ msgId, emoji, toId }) => {
    if (!socket.userId) return;
    const row = db.prepare('SELECT reactions FROM messages WHERE id=?').get(msgId);
    if (!row) return;
    const r = JSON.parse(row.reactions || '{}');
    if (!r[emoji]) r[emoji] = [];
    const idx = r[emoji].indexOf(socket.userId);
    if (idx >= 0) r[emoji].splice(idx, 1); else r[emoji].push(socket.userId);
    if (!r[emoji].length) delete r[emoji];
    db.prepare('UPDATE messages SET reactions=? WHERE id=?').run(JSON.stringify(r), msgId);
    const upd = { msgId, reactions: r };
    io.to(toId).emit('reaction-update', upd);
    socket.emit('reaction-update', upd);
  });

  socket.on('delete-message', ({ msgId, toId }) => {
    if (!socket.userId) return;
    const msg = db.prepare('SELECT from_id FROM messages WHERE id=?').get(msgId);
    if (!msg || msg.from_id !== socket.userId) return;
    db.prepare('UPDATE messages SET deleted=1,text=NULL,file_data=NULL,file_name=NULL WHERE id=?').run(msgId);
    io.to(toId).emit('message-deleted', { msgId });
    socket.emit('message-deleted', { msgId });
  });

  socket.on('typing', ({ toId, typing }) => {
    if (socket.userId) io.to(toId).emit('typing', { fromId: socket.userId, typing });
  });

  socket.on('read', ({ fromId }) => {
    if (!socket.userId) return;
    db.prepare('UPDATE messages SET read=1 WHERE from_id=? AND to_id=? AND read=0').run(fromId, socket.userId);
    io.to(fromId).emit('read', { byId: socket.userId });
  });

  socket.on('call-invite', ({ toId, callType, peerId }) => {
    if (!socket.userId) return;
    const caller = db.prepare('SELECT id,name,avatar,avatar_img FROM users WHERE id=?').get(socket.userId);
    io.to(toId).emit('call-invite', { from: caller, callType, peerId });
  });
  socket.on('call-accept', ({ toId, peerId }) => io.to(toId).emit('call-accept', { peerId }));
  socket.on('call-decline', ({ toId }) => io.to(toId).emit('call-decline', {}));
  socket.on('call-end', ({ toId }) => io.to(toId).emit('call-end', {}));

  socket.on('disconnect', () => {
    if (!socket.userId) return;
    onlineUsers.delete(socket.userId);
    const notify = [
      ...db.prepare('SELECT contact_id id FROM contacts WHERE owner_id=?').all(socket.userId),
      ...db.prepare('SELECT owner_id id FROM contacts WHERE contact_id=?').all(socket.userId)
    ];
    notify.forEach(({ id }) => io.to(id).emit('presence', { userId: socket.userId, online: false }));
  });
});

server.listen(PORT, () => console.log(`WAVE running on :${PORT}`));
