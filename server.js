const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });
const PORT = process.env.PORT || 3000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT '👤',
      avatar_img TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE TABLE IF NOT EXISTS contacts (
      owner_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      nickname TEXT,
      added_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
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
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, read);
  `);
  console.log('DB ready');
}

const hashPw = pw => crypto.createHash('sha256').update(pw + 'wave_salt_v2').digest('hex');
const onlineUsers = new Map();

app.use('/peerjs', ExpressPeerServer(server, { debug: false }));
app.use(express.json({ limit: '20mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, password, avatar_img } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Имя минимум 2 символа' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    const exists = await db.query('SELECT id FROM users WHERE name=$1', [name.trim()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Имя уже занято' });
    const id = uuidv4().slice(0, 8).toUpperCase();
    await db.query(
      'INSERT INTO users (id,name,password_hash,avatar,avatar_img) VALUES ($1,$2,$3,$4,$5)',
      [id, name.trim(), hashPw(password), '👤', avatar_img || null]
    );
    res.json({ id, name: name.trim(), avatar: '👤', avatar_img: avatar_img || null });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    const r = await db.query('SELECT * FROM users WHERE name=$1', [name?.trim()]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.password_hash !== hashPw(password)) return res.status(401).json({ error: 'Неверный пароль' });
    res.json({ id: user.id, name: user.name, avatar: user.avatar, avatar_img: user.avatar_img });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT id,name,avatar,avatar_img FROM users WHERE id=$1', [req.params.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'Не найден' });
    res.json({ ...u, online: onlineUsers.has(u.id) });
  } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.patch('/api/user/:id', async (req, res) => {
  try {
    const { name, avatar_img } = req.body;
    const cur = await db.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Не найден' });
    if (name && name.trim() !== cur.rows[0].name) {
      const taken = await db.query('SELECT id FROM users WHERE name=$1 AND id!=$2', [name.trim(), req.params.id]);
      if (taken.rows.length) return res.status(409).json({ error: 'Имя уже занято' });
      await db.query('UPDATE users SET name=$1 WHERE id=$2', [name.trim(), req.params.id]);
    }
    if (avatar_img !== undefined) {
      await db.query('UPDATE users SET avatar_img=$1 WHERE id=$2', [avatar_img, req.params.id]);
    }
    const updated = await db.query('SELECT id,name,avatar,avatar_img FROM users WHERE id=$1', [req.params.id]);
    const u = updated.rows[0];
    const contacts = await db.query('SELECT contact_id FROM contacts WHERE owner_id=$1', [req.params.id]);
    const reverse  = await db.query('SELECT owner_id FROM contacts WHERE contact_id=$1', [req.params.id]);
    [...contacts.rows.map(c=>c.contact_id), ...reverse.rows.map(c=>c.owner_id)]
      .forEach(uid => io.to(uid).emit('user-updated', u));
    res.json(u);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/api/contacts/:userId', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id,u.name,u.avatar,u.avatar_img,c.nickname,c.added_at
      FROM contacts c JOIN users u ON u.id=c.contact_id
      WHERE c.owner_id=$1 ORDER BY u.name
    `, [req.params.userId]);
    const result = await Promise.all(r.rows.map(async c => {
      const unread = await db.query(
        'SELECT COUNT(*) n FROM messages WHERE from_id=$1 AND to_id=$2 AND read=0 AND deleted=0',
        [c.id, req.params.userId]
      );
      return { ...c, online: onlineUsers.has(c.id), unread: parseInt(unread.rows[0].n) || 0 };
    }));
    res.json(result);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const { ownerId, contactId } = req.body;
    const r = await db.query('SELECT * FROM users WHERE id=$1', [contactId]);
    const c = r.rows[0];
    if (!c) return res.status(404).json({ error: 'Пользователь не найден' });
    if (ownerId === contactId) return res.status(400).json({ error: 'Нельзя добавить себя' });
    await db.query(
      'INSERT INTO contacts (owner_id,contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [ownerId, contactId]
    );
    res.json({ id:c.id, name:c.name, avatar:c.avatar, avatar_img:c.avatar_img, online: onlineUsers.has(c.id) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:a/:b', async (req, res) => {
  try {
    const { a, b } = req.params;
    const r = await db.query(`
      SELECT id,from_id,to_id,text,type,file_name,file_size,file_data,reply_to,reactions,deleted,read,created_at
      FROM messages
      WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)
      ORDER BY created_at ASC
    `, [a, b]);
    await db.query('UPDATE messages SET read=1 WHERE from_id=$1 AND to_id=$2 AND read=0', [b, a]);
    res.json(r.rows.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '{}') })));
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('join', async ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);
    try {
      const contacts = await db.query('SELECT contact_id id FROM contacts WHERE owner_id=$1', [userId]);
      const reverse  = await db.query('SELECT owner_id id FROM contacts WHERE contact_id=$1', [userId]);
      [...contacts.rows, ...reverse.rows].forEach(({ id }) => io.to(id).emit('presence', { userId, online: true }));
    } catch(e) {}
  });

  socket.on('message', async ({ toId, text, type='text', fileName, fileSize, fileData, replyTo }) => {
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
    try {
      await db.query(
        `INSERT INTO messages (id,from_id,to_id,text,type,file_name,file_size,file_data,reply_to,reactions,deleted,read,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [msg.id,msg.from_id,msg.to_id,msg.text,msg.type,msg.file_name,msg.file_size,
         msg.file_data,msg.reply_to,msg.reactions,msg.deleted,msg.read,msg.created_at]
      );
    } catch(e) { console.error('msg insert', e); return; }
    const out = { ...msg, reactions: {} };
    io.to(toId).emit('message', out);
    socket.emit('message', out);
  });

  socket.on('reaction', async ({ msgId, emoji, toId }) => {
    if (!socket.userId) return;
    try {
      const r = await db.query('SELECT reactions FROM messages WHERE id=$1', [msgId]);
      if (!r.rows.length) return;
      const reactions = JSON.parse(r.rows[0].reactions || '{}');
      if (!reactions[emoji]) reactions[emoji] = [];
      const idx = reactions[emoji].indexOf(socket.userId);
      if (idx >= 0) reactions[emoji].splice(idx, 1); else reactions[emoji].push(socket.userId);
      if (!reactions[emoji].length) delete reactions[emoji];
      await db.query('UPDATE messages SET reactions=$1 WHERE id=$2', [JSON.stringify(reactions), msgId]);
      const upd = { msgId, reactions };
      io.to(toId).emit('reaction-update', upd);
      socket.emit('reaction-update', upd);
    } catch(e) { console.error(e); }
  });

  socket.on('delete-message', async ({ msgId, toId }) => {
    if (!socket.userId) return;
    try {
      const r = await db.query('SELECT from_id FROM messages WHERE id=$1', [msgId]);
      if (!r.rows.length || r.rows[0].from_id !== socket.userId) return;
      await db.query('UPDATE messages SET deleted=1,text=NULL,file_data=NULL,file_name=NULL WHERE id=$1', [msgId]);
      io.to(toId).emit('message-deleted', { msgId });
      socket.emit('message-deleted', { msgId });
    } catch(e) { console.error(e); }
  });

  socket.on('typing', ({ toId, typing }) => {
    if (socket.userId) io.to(toId).emit('typing', { fromId: socket.userId, typing });
  });

  socket.on('read', async ({ fromId }) => {
    if (!socket.userId) return;
    try {
      await db.query('UPDATE messages SET read=1 WHERE from_id=$1 AND to_id=$2 AND read=0', [fromId, socket.userId]);
      io.to(fromId).emit('read', { byId: socket.userId });
    } catch(e) {}
  });

  socket.on('call-invite', async ({ toId, callType, peerId }) => {
    if (!socket.userId) return;
    try {
      const r = await db.query('SELECT id,name,avatar,avatar_img FROM users WHERE id=$1', [socket.userId]);
      io.to(toId).emit('call-invite', { from: r.rows[0], callType, peerId });
    } catch(e) {}
  });

  socket.on('call-accept', ({ toId, peerId }) => io.to(toId).emit('call-accept', { peerId }));
  socket.on('call-decline', ({ toId }) => io.to(toId).emit('call-decline', {}));
  socket.on('call-end', ({ toId }) => io.to(toId).emit('call-end', {}));

  socket.on('disconnect', async () => {
    if (!socket.userId) return;
    onlineUsers.delete(socket.userId);
    try {
      const contacts = await db.query('SELECT contact_id id FROM contacts WHERE owner_id=$1', [socket.userId]);
      const reverse  = await db.query('SELECT owner_id id FROM contacts WHERE contact_id=$1', [socket.userId]);
      [...contacts.rows, ...reverse.rows].forEach(({ id }) => io.to(id).emit('presence', { userId: socket.userId, online: false }));
    } catch(e) {}
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`WAVE running on :${PORT}`));
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
