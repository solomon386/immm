import express from 'express';
import http from 'http';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOG_DIR = path.join(__dirname, 'logs');
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_TEST = NODE_ENV === 'test';
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const UPLOAD_RULES = {
  image: {
    maxSize: 10 * 1024 * 1024,
    extensions: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']),
    mimes: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
  },
  audio: {
    maxSize: 30 * 1024 * 1024,
    extensions: new Set(['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac']),
    mimes: new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'])
  },
  video: {
    maxSize: 100 * 1024 * 1024,
    extensions: new Set(['.mp4', '.webm', '.ogg', '.mov']),
    mimes: new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'])
  }
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (IS_PRODUCTION && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const defaultData = {
  users: [],
  friendRequests: [],
  friendships: [],
  messages: []
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return structuredClone(defaultData);
  try {
    return { ...structuredClone(defaultData), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch {
    return structuredClone(defaultData);
  }
}

let db = loadData();

function saveData() {
  if (IS_TEST) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function setDbForTest(nextDb) {
  if (!IS_TEST) {
    throw new Error('setDbForTest 只能在测试环境使用');
  }
  db = nextDb;
}

function getDbForTest() {
  if (!IS_TEST) {
    throw new Error('getDbForTest 只能在测试环境使用');
  }
  return db;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    online: Boolean(onlineUsers.get(user.id))
  };
}

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: '请先登录' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(item => item.id === payload.id);
    if (!user) return res.status(401).json({ message: '用户不存在' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: '登录已过期，请重新登录' });
  }
}

function areFriends(a, b) {
  return db.friendships.some(item => item.includes(a) && item.includes(b));
}

function conversationOf(a, b) {
  return [a, b].sort().join(':');
}

function markConversationRead(readerId, friendId) {
  const now = new Date().toISOString();
  const conversationId = conversationOf(readerId, friendId);
  const readMessages = db.messages.filter(message =>
    message.conversationId === conversationId &&
    message.from === friendId &&
    message.to === readerId &&
    !message.readAt
  );

  readMessages.forEach(message => {
    message.readAt = now;
  });

  if (readMessages.length) saveData();

  return {
    conversationId,
    readerId,
    friendId,
    readAt: now,
    messageIds: readMessages.map(message => message.id)
  };
}

function emitToUser(userId, event, payload) {
  const sockets = onlineUsers.get(userId) || new Set();
  sockets.forEach(socketId => io.to(socketId).emit(event, payload));
}

function forwardCallEvent(socket, event, payload = {}) {
  const { to } = payload;
  if (!to || !areFriends(socket.user.id, to)) {
    socket.emit('call:error', { message: '只能和好友进行视频通话' });
    return false;
  }
  emitToUser(to, event, {
    ...payload,
    from: socket.user.id,
    fromUser: publicUser(socket.user)
  });
  return true;
}

function uploadTypeFromMime(mime) {
  if (UPLOAD_RULES.image.mimes.has(mime)) return 'image';
  if (UPLOAD_RULES.audio.mimes.has(mime)) return 'audio';
  if (UPLOAD_RULES.video.mimes.has(mime)) return 'video';
  return null;
}

function getSafeExtension(filename) {
  return path.extname(filename || '').toLowerCase();
}

function hasAllowedExtensionForType(filename, type) {
  return Boolean(type && UPLOAD_RULES[type]?.extensions.has(getSafeExtension(filename)));
}

function isAllowedUploadMeta(file) {
  const type = uploadTypeFromMime(file.mimetype);
  return Boolean(type && hasAllowedExtensionForType(file.originalname, type));
}

function isRiff(buffer, signature) {
  return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === signature;
}

function isFtyp(buffer) {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

function detectFileSignature(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (isRiff(buffer, 'WEBP')) return 'webp';
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mpeg-audio';
  if (isRiff(buffer, 'WAVE')) return 'wav';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (isFtyp(buffer)) return 'mp4-family';
  return null;
}

function signatureAllowedForUpload(type, signature) {
  const allowed = {
    image: new Set(['jpg', 'png', 'gif', 'webp']),
    audio: new Set(['mp3', 'mpeg-audio', 'wav', 'ogg', 'webm', 'mp4-family']),
    video: new Set(['ogg', 'webm', 'mp4-family'])
  };
  return allowed[type]?.has(signature);
}

function removeUploadedFile(file) {
  if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
}

function removeMessageFile(message) {
  if (!message?.file?.url?.startsWith('/uploads/')) return;
  const filename = path.basename(message.file.url);
  const filePath = path.join(UPLOAD_DIR, filename);
  if (filePath.startsWith(UPLOAD_DIR) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function clearConversationMessages(userId, friendId) {
  const conversationId = conversationOf(userId, friendId);
  const removedMessages = db.messages.filter(message => message.conversationId === conversationId);
  removedMessages.forEach(removeMessageFile);
  db.messages = db.messages.filter(message => message.conversationId !== conversationId);
  return {
    conversationId,
    removedMessageCount: removedMessages.length
  };
}

function validateUploadedFile(file) {
  const type = uploadTypeFromMime(file.mimetype);
  if (!type || !hasAllowedExtensionForType(file.originalname, type)) {
    throw new Error('只允许上传受支持的图片、语音或视频文件');
  }
  if (file.size <= 0) {
    throw new Error('不能上传空文件');
  }
  if (file.size > UPLOAD_RULES[type].maxSize) {
    throw new Error(`${type === 'image' ? '图片' : type === 'audio' ? '语音' : '视频'}文件过大`);
  }

  const fd = fs.openSync(file.path, 'r');
  try {
    const header = Buffer.alloc(32);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    const signature = detectFileSignature(header.subarray(0, bytesRead));
    if (!signatureAllowedForUpload(type, signature)) {
      throw new Error('文件内容与声明类型不匹配，已拒绝上传');
    }
  } finally {
    fs.closeSync(fd);
  }

  return type;
}

function logFilePath(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(LOG_DIR, `access-${day}.log`);
}

function serializeLogEntry(entry) {
  return JSON.stringify(entry);
}

const SENSITIVE_LOG_KEYS = new Set(['password', 'passwordHash', 'token', 'authorization', 'cookie', 'jwt', 'secret', 'JWT_SECRET']);
const LARGE_FIELD_KEYS = new Set(['file', 'files', 'image', 'audio', 'video', 'blob', 'buffer', 'base64', 'data', 'content']);

function buildLogEntry(entry) {
  return {
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    ...entry
  };
}

function writeProductionLog(entry) {
  if (IS_TEST) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFile(logFilePath(), `${serializeLogEntry(buildLogEntry(entry))}\n`, error => {
    if (error) console.error('[logger] 写入日志失败', error.message);
  });
}

function statusColor(statusCode) {
  if (statusCode >= 500) return '\x1b[31m';
  if (statusCode >= 400) return '\x1b[33m';
  if (statusCode >= 300) return '\x1b[36m';
  return '\x1b[32m';
}

function writeDevelopmentLog(entry) {
  if (IS_TEST) return;
  const reset = '\x1b[0m';
  const color = statusColor(entry.statusCode);
  const logEntry = buildLogEntry(entry);
  console.log(`${color}[${logEntry.level.toUpperCase()}] ${logEntry.method} ${logEntry.path} ${logEntry.statusCode}${reset} ${logEntry.durationMs}ms`);
  console.log(JSON.stringify(logEntry, null, 2));
}

function logWebRequest(entry) {
  if (IS_PRODUCTION) {
    writeProductionLog(entry);
    return;
  }
  writeDevelopmentLog(entry);
}

function sanitizeLogValue(value, key = '') {
  const normalizedKey = key.toLowerCase();
  if (SENSITIVE_LOG_KEYS.has(normalizedKey)) return '[REDACTED]';
  if (value == null) return value;

  if (typeof value === 'string') {
    if (LARGE_FIELD_KEYS.has(normalizedKey) && value.length > 200) {
      return `[OMITTED_LARGE_FIELD length=${value.length}]`;
    }
    return value.length > 1000 ? `${value.slice(0, 1000)}...[TRUNCATED length=${value.length}]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeLogValue(item, key));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeLogValue(childValue, childKey)])
    );
  }

  return value;
}

function uploadedFileLog(file) {
  if (!file) return null;
  return {
    originalName: file.originalname,
    storedName: file.filename,
    mime: file.mimetype,
    size: file.size,
    storagePath: file.filename ? `/uploads/${file.filename}` : null,
    persisted: file.path ? fs.existsSync(file.path) : false
  };
}

function buildRequestData(req) {
  const data = {};
  if (req.query && Object.keys(req.query).length) {
    data.query = sanitizeLogValue(req.query);
  }
  if (req.body && Object.keys(req.body).length) {
    data.body = sanitizeLogValue(req.body);
  }
  if (req.file) {
    data.file = uploadedFileLog(req.file);
  }
  if (Array.isArray(req.files) && req.files.length) {
    data.files = req.files.map(uploadedFileLog);
  } else if (req.files && typeof req.files === 'object') {
    data.files = Object.fromEntries(
      Object.entries(req.files).map(([field, files]) => [field, files.map(uploadedFileLog)])
    );
  }
  return Object.keys(data).length ? data : null;
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || uuid();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logWebRequest({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId,
      method: req.method,
      path: req.originalUrl,
      routeType: req.originalUrl.startsWith('/api') ? 'api' : 'static',
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      userId: req.user?.id || null,
      requestData: buildRequestData(req)
    });
  });

  next();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});
const onlineUsers = new Map();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    cb(null, `${Date.now()}-${uuid()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedUploadMeta(file)) {
      cb(new Error('只允许上传 jpg、png、gif、webp、mp3、wav、ogg、webm、m4a、aac、mp4、mov 文件'));
      return;
    }
    cb(null, true);
  }
});

app.use(requestLogger);
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: res => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
  if (db.users.some(user => user.username === username)) return res.status(409).json({ message: '用户名已存在' });

  const user = {
    id: uuid(),
    username,
    displayName: displayName || username,
    passwordHash: await bcrypt.hash(password, 10),
    avatarColor: `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveData();
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(item => item.username === username);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    friends: db.friendships
      .filter(pair => pair.includes(req.user.id))
      .map(pair => publicUser(db.users.find(user => user.id === pair.find(id => id !== req.user.id))))
      .filter(Boolean),
    requests: db.friendRequests
      .filter(request => request.to === req.user.id && request.status === 'pending')
      .map(request => ({ ...request, fromUser: publicUser(db.users.find(user => user.id === request.from)) }))
  });
});

app.get('/api/users/search', auth, (req, res) => {
  const keyword = String(req.query.q || '').trim().toLowerCase();
  if (!keyword) return res.json([]);
  const users = db.users
    .filter(user => user.id !== req.user.id)
    .filter(user => user.username.toLowerCase().includes(keyword) || user.displayName.toLowerCase().includes(keyword))
    .slice(0, 10)
    .map(publicUser);
  res.json(users);
});

app.post('/api/friends/request', auth, (req, res) => {
  const { toUserId } = req.body;
  const target = db.users.find(user => user.id === toUserId);
  if (!target) return res.status(404).json({ message: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ message: '不能添加自己' });
  if (areFriends(req.user.id, target.id)) return res.status(400).json({ message: '已经是好友' });

  const existing = db.friendRequests.find(request =>
    request.status === 'pending' &&
    ((request.from === req.user.id && request.to === target.id) || (request.from === target.id && request.to === req.user.id))
  );
  if (existing) return res.status(400).json({ message: '已有待处理的好友请求' });

  const request = {
    id: uuid(),
    from: req.user.id,
    to: target.id,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.friendRequests.push(request);
  saveData();
  emitToUser(target.id, 'friend:request', { ...request, fromUser: publicUser(req.user) });
  res.json({ message: '好友请求已发送', request });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const { requestId, accept } = req.body;
  const request = db.friendRequests.find(item => item.id === requestId && item.to === req.user.id);
  if (!request) return res.status(404).json({ message: '好友请求不存在' });
  if (request.status !== 'pending') return res.status(400).json({ message: '好友请求已处理' });

  request.status = accept ? 'accepted' : 'rejected';
  request.updatedAt = new Date().toISOString();
  if (accept && !areFriends(request.from, request.to)) {
    db.friendships.push([request.from, request.to]);
  }
  saveData();
  const requester = db.users.find(user => user.id === request.from);
  const responder = req.user;
  emitToUser(request.from, 'friend:updated', {
    requestId: request.id,
    accepted: accept,
    role: 'requester',
    requester: publicUser(requester),
    responder: publicUser(responder),
    user: publicUser(responder),
    message: accept
      ? `${responder.displayName} 已同意你的好友请求`
      : `${responder.displayName} 已拒绝你的好友请求`
  });
  emitToUser(request.to, 'friend:updated', {
    requestId: request.id,
    accepted: accept,
    role: 'responder',
    requester: publicUser(requester),
    responder: publicUser(responder),
    user: publicUser(requester),
    message: accept
      ? `已同意 ${requester.displayName} 的好友请求`
      : `已拒绝 ${requester.displayName} 的好友请求`
  });
  res.json({ message: accept ? '已添加好友' : '已拒绝请求' });
});

app.delete('/api/friends/:friendId', auth, (req, res) => {
  const friend = db.users.find(user => user.id === req.params.friendId);
  if (!friend) return res.status(404).json({ message: '好友不存在' });

  const friendshipIndex = db.friendships.findIndex(pair => pair.includes(req.user.id) && pair.includes(friend.id));
  if (friendshipIndex === -1) return res.status(400).json({ message: '你们当前不是好友' });

  db.friendships.splice(friendshipIndex, 1);
  db.friendRequests = db.friendRequests.filter(request =>
    !((request.from === req.user.id && request.to === friend.id) || (request.from === friend.id && request.to === req.user.id))
  );
  const cleanup = clearConversationMessages(req.user.id, friend.id);
  saveData();

  const payload = {
    userId: req.user.id,
    friendId: friend.id,
    conversationId: cleanup.conversationId,
    removedMessageCount: cleanup.removedMessageCount
  };
  emitToUser(req.user.id, 'friend:removed', payload);
  emitToUser(friend.id, 'friend:removed', payload);
  res.json({ message: '好友已删除', ...payload });
});

app.get('/api/messages/:friendId', auth, (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能查看好友消息' });
  const conversationId = conversationOf(req.user.id, req.params.friendId);
  res.json(db.messages.filter(message => message.conversationId === conversationId));
});

app.delete('/api/messages/:friendId', auth, (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能清空好友会话' });
  const friend = db.users.find(user => user.id === req.params.friendId);
  if (!friend) return res.status(404).json({ message: '好友不存在' });

  const cleanup = clearConversationMessages(req.user.id, friend.id);
  saveData();

  const payload = {
    userId: req.user.id,
    friendId: friend.id,
    conversationId: cleanup.conversationId,
    removedMessageCount: cleanup.removedMessageCount
  };
  emitToUser(req.user.id, 'conversation:cleared', payload);
  emitToUser(friend.id, 'conversation:cleared', payload);
  res.json({ message: '聊天记录已清空', ...payload });
});

app.post('/api/messages/:friendId/read', auth, (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能标记好友消息' });
  const receipt = markConversationRead(req.user.id, req.params.friendId);
  if (receipt.messageIds.length) {
    emitToUser(req.user.id, 'message:read', receipt);
    emitToUser(req.params.friendId, 'message:read', receipt);
  }
  res.json(receipt);
});

app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, error => {
    if (error) {
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? '文件过大，最大支持 100MB'
        : error.message || '文件上传失败';
      return res.status(400).json({ message });
    }

    if (!req.file) return res.status(400).json({ message: '没有收到文件' });

    try {
      const type = validateUploadedFile(req.file);
      res.json({
        type,
        url: `/uploads/${req.file.filename}`,
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size
      });
    } catch (validationError) {
      removeUploadedFile(req.file);
      res.status(400).json({ message: validationError.message });
    }
  });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(item => item.id === payload.id);
    if (!user) return next(new Error('未登录'));
    socket.user = user;
    next();
  } catch {
    next(new Error('未登录'));
  }
});

io.on('connection', socket => {
  const sockets = onlineUsers.get(socket.user.id) || new Set();
  sockets.add(socket.id);
  onlineUsers.set(socket.user.id, sockets);
  io.emit('presence:update', { userId: socket.user.id, online: true });

  socket.on('message:send', payload => {
    const { to, type, text, file } = payload || {};
    if (!to || !areFriends(socket.user.id, to)) {
      socket.emit('message:error', { message: '只能给好友发送消息' });
      return;
    }
    if (!['text', 'image', 'audio', 'video'].includes(type)) {
      socket.emit('message:error', { message: '不支持的消息类型' });
      return;
    }
    if (type === 'text' && !String(text || '').trim()) return;

    const message = {
      id: uuid(),
      conversationId: conversationOf(socket.user.id, to),
      from: socket.user.id,
      to,
      type,
      text: type === 'text' ? String(text).trim() : '',
      file: type === 'text' ? null : file,
      createdAt: new Date().toISOString(),
      readAt: null
    };
    db.messages.push(message);
    saveData();
    emitToUser(to, 'message:new', message);
    emitToUser(socket.user.id, 'message:new', message);
  });

  socket.on('message:read', payload => {
    const { friendId } = payload || {};
    if (!friendId || !areFriends(socket.user.id, friendId)) {
      socket.emit('message:error', { message: '只能标记好友消息为已读' });
      return;
    }
    const receipt = markConversationRead(socket.user.id, friendId);
    if (!receipt.messageIds.length) return;
    emitToUser(socket.user.id, 'message:read', receipt);
    emitToUser(friendId, 'message:read', receipt);
  });

  socket.on('message:delete', (payload, ack) => {
    const reply = response => {
      if (typeof ack === 'function') ack(response);
    };
    const { messageId } = payload || {};
    const messageIndex = db.messages.findIndex(message => message.id === messageId);
    if (messageIndex === -1) {
      const error = { ok: false, message: '消息不存在或已被删除' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }

    const message = db.messages[messageIndex];
    if (message.from !== socket.user.id) {
      const error = { ok: false, message: '只能删除自己发送的消息' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }

    try {
      db.messages.splice(messageIndex, 1);
      removeMessageFile(message);
      saveData();

      const payloadToEmit = {
        messageId: message.id,
        conversationId: message.conversationId,
        from: message.from,
        to: message.to
      };
      emitToUser(message.from, 'message:deleted', payloadToEmit);
      emitToUser(message.to, 'message:deleted', payloadToEmit);
      reply({ ok: true, ...payloadToEmit });
    } catch (deleteError) {
      const error = { ok: false, message: deleteError.message || '删除消息失败' };
      socket.emit('message:error', { message: error.message });
      reply(error);
    }
  });

  socket.on('call:invite', payload => {
    const { to } = payload || {};
    if (!onlineUsers.get(to)) {
      socket.emit('call:error', { message: '对方当前不在线，无法发起视频通话' });
      return;
    }
    forwardCallEvent(socket, 'call:incoming', payload);
  });

  socket.on('call:accept', payload => {
    forwardCallEvent(socket, 'call:accepted', payload);
  });

  socket.on('call:reject', payload => {
    forwardCallEvent(socket, 'call:rejected', payload);
  });

  socket.on('call:cancel', payload => {
    forwardCallEvent(socket, 'call:canceled', payload);
  });

  socket.on('call:end', payload => {
    forwardCallEvent(socket, 'call:ended', payload);
  });

  socket.on('call:offer', payload => {
    forwardCallEvent(socket, 'call:offer', payload);
  });

  socket.on('call:answer', payload => {
    forwardCallEvent(socket, 'call:answer', payload);
  });

  socket.on('call:ice', payload => {
    forwardCallEvent(socket, 'call:ice', payload);
  });

  socket.on('disconnect', () => {
    const current = onlineUsers.get(socket.user.id);
    if (!current) return;
    current.delete(socket.id);
    if (current.size === 0) {
      onlineUsers.delete(socket.user.id);
      io.emit('presence:update', { userId: socket.user.id, online: false });
    }
  });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`即时聊天系统已启动：http://localhost:${PORT}`);
    console.log(`日志系统已启用：${IS_PRODUCTION ? `生产环境 JSON 日志 -> ${logFilePath()}` : '开发环境控制台日志'}`);
  });
}

export {
  app,
  server,
  UPLOAD_DIR,
  UPLOAD_RULES,
  conversationOf,
  detectFileSignature,
  getDbForTest,
  hasAllowedExtensionForType,
  isAllowedUploadMeta,
  markConversationRead,
  removeMessageFile,
  removeUploadedFile,
  setDbForTest,
  signatureAllowedForUpload,
  uploadTypeFromMime,
  validateUploadedFile
};
