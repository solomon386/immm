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
import { createDataStore } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_SESSION_EXPIRES_IN = '1h';
const JWT_REFRESH_BUFFER_MS = 10 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOG_DIR = path.join(__dirname, 'logs');
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_TEST = NODE_ENV === 'test';
const CALLS_ENABLED = process.env.ENABLE_CALLS === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEFAULT_MESSAGE_RETENTION_SECONDS = IS_PRODUCTION ? 24 * 60 * 60 : 60;
const MESSAGE_RETENTION_MS = Number(process.env.MESSAGE_RETENTION_SECONDS || DEFAULT_MESSAGE_RETENTION_SECONDS) * 1000;
const EPHEMERAL_MESSAGE_TTL_MS = 30 * 1000;
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
  },
  file: {
    maxSize: 50 * 1024 * 1024,
    extensions: new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.md']),
    mimes: new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/rtf',
      'text/rtf'
    ])
  }
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (IS_PRODUCTION && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const dataStore = await createDataStore(NODE_ENV);
console.log(`[startup] 数据存储后端: ${dataStore.type}${dataStore.file ? ` (${dataStore.file})` : ''}`);
let db = await dataStore.load();
pruneExpiredMessages();
await dataStore.save(db);
let saveQueue = Promise.resolve();
const ephemeralConversations = new Set((await dataStore.ephemeralStore?.list()) || []);

function isEphemeralConversation(conversationId) {
  return ephemeralConversations.has(conversationId);
}

setInterval(() => {
  if (!ephemeralConversations.size) return;
  pruneExpiredMessages();
  pruneEphemeralMessages();
}, 5000);

function pruneEphemeralMessages() {
  const now = Date.now();
  let pruned = false;
  db.messages = db.messages.filter(message => {
    const ephemeralKey = message.groupId ? `group:${message.groupId}` : message.to;
    if (!isEphemeralConversation(ephemeralKey)) return true;
    const createdAtMs = Date.parse(message.createdAt);
    if (Number.isFinite(createdAtMs) && createdAtMs + EPHEMERAL_MESSAGE_TTL_MS <= now) {
      removeMessageFile(message);
      pruned = true;
      return false;
    }
    return true;
  });
  if (pruned) saveData('ephemeral:prune');
}

function dbSummary(snapshot = db) {
  return {
    users: snapshot.users?.length || 0,
    friendRequests: snapshot.friendRequests?.length || 0,
    friendships: snapshot.friendships?.length || 0,
    messages: snapshot.messages?.length || 0
  };
}

function logOperation(level, action, detail = {}) {
  if (!shouldWriteLog(level)) return;
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  logger(`[app] ${action}`, {
    environment: NODE_ENV,
    store: dataStore.type,
    ...detail
  });
}

logOperation('info', '启动数据加载完成', dbSummary());

function saveData(reason = 'unspecified', context = {}) {
  pruneExpiredMessages();
  const snapshot = structuredClone(db);
  logOperation('info', '准备保存数据', {
    reason,
    context,
    summary: dbSummary(snapshot)
  });
  const startedAt = Date.now();
  const task = saveQueue.then(async () => {
    await dataStore.save(snapshot);
    logOperation('info', '保存数据成功', {
      reason,
      context,
      durationMs: Date.now() - startedAt,
      summary: dbSummary(snapshot)
    });
  });
  saveQueue = task.catch(error => {
    logOperation('error', '保存数据失败', {
      reason,
      context,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    return Promise.resolve();
  });
  task.catch(() => {});
  return task;
}

function setDbForTest(nextDb) {
  if (!IS_TEST) {
    throw new Error('setDbForTest 只能在测试环境使用');
  }
  db = nextDb;
  saveData('test:set-db');
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
    avatarUrl: user.avatarUrl || '',
    online: Boolean(onlineUsers.get(user.id))
  };
}

function sign(user, expiresIn) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: expiresIn || JWT_SESSION_EXPIRES_IN });
}

function authWithRefresh(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: '请先登录' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(item => item.id === payload.id);
    if (!user) return res.status(401).json({ message: '用户不存在' });
    req.user = user;
    const remainingMs = payload.exp * 1000 - Date.now();
    if (remainingMs < JWT_REFRESH_BUFFER_MS) {
      res.setHeader('X-New-Token', sign(user));
    }
    next();
  } catch {
    return res.status(401).json({ message: '登录已过期，请重新登录' });
  }
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

function groupConversationOf(groupId) {
  return `group:${groupId}`;
}

function isGroupMember(group, userId) {
  return Boolean(group?.memberIds?.includes(userId));
}

function publicGroup(group) {
  const members = (group.memberIds || [])
    .map(userId => db.users.find(user => user.id === userId))
    .filter(Boolean)
    .map(publicUser);
  return {
    id: group.id,
    name: group.name,
    ownerId: group.ownerId,
    members,
    memberCount: members.length,
    createdAt: group.createdAt
  };
}

function isMessageAlive(message, now = Date.now()) {
  const createdAtMs = Date.parse(message.createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs + MESSAGE_RETENTION_MS > now;
}

function pruneExpiredMessages() {
  const now = Date.now();
  const expiredMessages = db.messages.filter(message => !isMessageAlive(message, now));
  if (!expiredMessages.length) return 0;
  expiredMessages.forEach(removeMessageFile);
  db.messages = db.messages.filter(message => isMessageAlive(message, now));
  return expiredMessages.length;
}

function markConversationRead(readerId, friendId) {
  const removedCount = pruneExpiredMessages();
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

  if (readMessages.length || removedCount) {
    saveData('message:mark-read', { readerId, friendId, readCount: readMessages.length, removedCount });
  }

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

function emitToGroup(group, event, payload) {
  group.memberIds.forEach(userId => emitToUser(userId, event, payload));
}

function broadcastEphemeralToggle(conversationId, enable, triggeredBy) {
  if (conversationId.startsWith('group:')) {
    const groupId = conversationId.slice(6);
    const group = db.groupsx.find(item => item.id === groupId);
    if (group) emitToGroup(group, 'ephemeral:toggled', { conversationId, enable, triggeredBy });
  } else if (conversationId.includes(':')) {
    const parts = conversationId.split(':');
    emitToUser(parts[0], 'ephemeral:toggled', { conversationId, enable, triggeredBy });
    emitToUser(parts[1], 'ephemeral:toggled', { conversationId, enable, triggeredBy });
  } else {
    emitToUser(conversationId, 'ephemeral:toggled', { conversationId, enable, triggeredBy });
    emitToUser(triggeredBy, 'ephemeral:toggled', { conversationId, enable, triggeredBy });
  }
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

function removeOnlineSocket(socket) {
  const current = onlineUsers.get(socket.user.id);
  if (!current) return false;
  current.delete(socket.id);
  if (current.size === 0) {
    onlineUsers.delete(socket.user.id);
    io.emit('presence:update', { userId: socket.user.id, online: false });
    return true;
  }
  return false;
}

function uploadTypeFromMime(mime) {
  if (UPLOAD_RULES.image.mimes.has(mime)) return 'image';
  if (UPLOAD_RULES.audio.mimes.has(mime)) return 'audio';
  if (UPLOAD_RULES.video.mimes.has(mime)) return 'video';
  if (UPLOAD_RULES.file.mimes.has(mime)) return 'file';
  return null;
}

function getSafeExtension(filename) {
  return path.extname(filename || '').toLowerCase();
}

function hasAllowedExtensionForType(filename, type) {
  return Boolean(type && UPLOAD_RULES[type]?.extensions.has(getSafeExtension(filename)));
}

function isAllowedUploadMeta(file) {
  const type = uploadTypeFromMime(file.mimetype) || uploadTypeFromExtension(file.originalname);
  return Boolean(type && hasAllowedExtensionForType(file.originalname, type));
}

function uploadTypeFromExtension(filename) {
  const extension = getSafeExtension(filename);
  return Object.keys(UPLOAD_RULES).find(type => UPLOAD_RULES[type].extensions.has(extension)) || null;
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
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  return null;
}

function signatureAllowedForUpload(type, signature) {
  const allowed = {
    image: new Set(['jpg', 'png', 'gif', 'webp']),
    audio: new Set(['mp3', 'mpeg-audio', 'wav', 'ogg', 'webm', 'mp4-family']),
    video: new Set(['ogg', 'webm', 'mp4-family']),
    file: new Set(['pdf', 'zip', 'ole'])
  };
  return allowed[type]?.has(signature);
}

function isTextDocumentExtension(extension) {
  return new Set(['.txt', '.csv', '.rtf', '.md']).has(extension);
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
  pruneExpiredMessages();
  const conversationId = conversationOf(userId, friendId);
  const removedMessages = db.messages.filter(message => message.conversationId === conversationId);
  removedMessages.forEach(removeMessageFile);
  db.messages = db.messages.filter(message => message.conversationId !== conversationId);
  return {
    conversationId,
    removedMessageCount: removedMessages.length
  };
}

function clearGroupMessages(groupId) {
  pruneExpiredMessages();
  const conversationId = groupConversationOf(groupId);
  const removedMessages = db.messages.filter(message => message.conversationId === conversationId);
  removedMessages.forEach(removeMessageFile);
  db.messages = db.messages.filter(message => message.conversationId !== conversationId);
  return {
    conversationId,
    groupId,
    removedMessageCount: removedMessages.length
  };
}

function validateUploadedFile(file) {
  const type = uploadTypeFromMime(file.mimetype) || uploadTypeFromExtension(file.originalname);
  if (!type || !hasAllowedExtensionForType(file.originalname, type)) {
    throw new Error('只允许上传受支持的图片、语音、视频或常规文档文件');
  }
  if (file.size <= 0) {
    throw new Error('不能上传空文件');
  }
  if (file.size > UPLOAD_RULES[type].maxSize) {
    throw new Error(`${type === 'image' ? '图片' : type === 'audio' ? '语音' : type === 'video' ? '视频' : '文档'}文件过大`);
  }

  const fd = fs.openSync(file.path, 'r');
  try {
    const header = Buffer.alloc(32);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    const signature = detectFileSignature(header.subarray(0, bytesRead));
    const extension = getSafeExtension(file.originalname);
    if (type === 'file' && isTextDocumentExtension(extension)) return type;
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

function logLevelValue(level = 'info') {
  const values = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
  };
  return values[level] || values.info;
}

function shouldWriteLog(level = 'info') {
  return logLevelValue(level) >= logLevelValue(LOG_LEVEL);
}

function writeProductionConsoleLog(entry) {
  if (!shouldWriteLog(entry.level)) return;
  const logEntry = buildLogEntry(entry);
  const output = serializeLogEntry(logEntry);
  if (entry.level === 'error') {
    console.error(output);
    return;
  }
  if (entry.level === 'warn') {
    console.warn(output);
    return;
  }
  console.log(output);
}

function writeProductionLog(entry) {
  if (IS_TEST) return;
  if (!shouldWriteLog(entry.level)) return;
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
  if (!shouldWriteLog(entry.level)) return;
  const reset = '\x1b[0m';
  const color = statusColor(entry.statusCode);
  const logEntry = buildLogEntry(entry);
  console.log(`${color}[${logEntry.level.toUpperCase()}] ${logEntry.method} ${logEntry.path} ${logEntry.statusCode}${reset} ${logEntry.durationMs}ms`);
  console.log(JSON.stringify(logEntry, null, 2));
}

function logWebRequest(entry) {
  if (IS_PRODUCTION) {
    writeProductionConsoleLog(entry);
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

const SILENT_ROUTES = ['/api/config'];

function isSilentRoute(path) {
  return SILENT_ROUTES.some(route => path.startsWith(route));
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || uuid();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const silent = isSilentRoute(req.originalUrl);
  if (!silent) {
    logOperation('info', 'HTTP 请求开始', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      routeType: req.originalUrl.startsWith('/api') ? 'api' : 'static',
      ip: req.ip,
      userAgent: req.get('user-agent') || ''
    });
  }

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const entry = {
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
    };
    if (!silent) {
      logOperation(entry.level, 'HTTP 请求完成', entry);
    }
    logWebRequest({
      ...entry
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
      cb(new Error('只允许上传受支持的图片、语音、视频、PDF、Office、文本等常规文件'));
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
app.use(express.static(path.join(__dirname, '.well-known/pki-validation')));

app.get('/api/config', (req, res) => {
  res.json({
    features: {
      callsEnabled: CALLS_ENABLED
    }
  });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedDisplayName = String(displayName || '').trim();
  if (!normalizedUsername || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ message: '密码至少 6 位' });
  if (db.users.some(user => user.username.toLowerCase() === normalizedUsername)) return res.status(409).json({ message: '用户名已存在' });

  const user = {
    id: uuid(),
    username: normalizedUsername,
    displayName: normalizedDisplayName || normalizedUsername,
    passwordHash: await bcrypt.hash(password, 10),
    avatarColor: `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  logOperation('info', '用户注册准备保存', {
    requestId: req.requestId,
    userId: user.id,
    username: user.username
  });
  try {
    await saveData('auth:register', {
      requestId: req.requestId,
      userId: user.id,
      username: user.username
    });
  } catch (error) {
    logOperation('error', '用户注册保存失败', {
      requestId: req.requestId,
      userId: user.id,
      error: error.message
    });
    return res.status(500).json({ message: '注册数据保存失败，请稍后重试' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const user = db.users.find(item => item.username.toLowerCase() === normalizedUsername);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', authWithRefresh, (req, res) => {
  res.json({
    user: publicUser(req.user),
    friends: db.friendships
      .filter(pair => pair.includes(req.user.id))
      .map(pair => publicUser(db.users.find(user => user.id === pair.find(id => id !== req.user.id))))
      .filter(Boolean),
    requests: db.friendRequests
      .filter(request => request.to === req.user.id && request.status === 'pending')
      .map(request => ({ ...request, fromUser: publicUser(db.users.find(user => user.id === request.from)) })),
    groupsx: db.groupsx
      .filter(group => isGroupMember(group, req.user.id))
      .map(publicGroup)
  });
});

app.patch('/api/me', auth, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const avatarUrl = String(req.body.avatarUrl || '').trim();

  if (!displayName) return res.status(400).json({ message: '昵称不能为空' });
  if (displayName.length > 20) return res.status(400).json({ message: '昵称最多 20 个字符' });
  if (avatarUrl && (!avatarUrl.startsWith('/uploads/') || !hasAllowedExtensionForType(avatarUrl, 'image'))) {
    return res.status(400).json({ message: '头像地址不合法' });
  }

  req.user.displayName = displayName;
  req.user.avatarUrl = avatarUrl;
  logOperation('info', '个人资料准备保存', {
    requestId: req.requestId,
    userId: req.user.id,
    hasAvatarUrl: Boolean(avatarUrl)
  });
  try {
    await saveData('profile:update', {
      requestId: req.requestId,
      userId: req.user.id,
      hasAvatarUrl: Boolean(avatarUrl)
    });
  } catch (error) {
    logOperation('error', '个人资料保存失败', {
      requestId: req.requestId,
      userId: req.user.id,
      error: error.message
    });
    return res.status(500).json({ message: '保存个人资料失败，请稍后重试' });
  }

  const user = publicUser(req.user);
  emitToUser(req.user.id, 'profile:updated', { user });
  const notifyUserIds = new Set();
  db.friendships
    .filter(pair => pair.includes(req.user.id))
    .flat()
    .filter(userId => userId !== req.user.id)
    .forEach(friendId => notifyUserIds.add(friendId));
  db.groupsx
    .filter(group => isGroupMember(group, req.user.id))
    .flatMap(group => group.memberIds)
    .filter(userId => userId !== req.user.id)
    .forEach(userId => notifyUserIds.add(userId));
  notifyUserIds.forEach(userId => emitToUser(userId, 'friend:profile-updated', { user }));

  res.json({ message: '个人资料已更新', user });
});

app.patch('/api/me/password', auth, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  if (!currentPassword || !newPassword) return res.status(400).json({ message: '当前密码和新密码不能为空' });
  if (newPassword.length < 6) return res.status(400).json({ message: '新密码至少 6 位' });
  if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) {
    return res.status(401).json({ message: '当前密码错误' });
  }
  if (await bcrypt.compare(newPassword, req.user.passwordHash)) {
    return res.status(400).json({ message: '新密码不能与当前密码相同' });
  }

  req.user.passwordHash = await bcrypt.hash(newPassword, 10);
  try {
    await saveData('password:update', {
      requestId: req.requestId,
      userId: req.user.id
    });
  } catch (error) {
    logOperation('error', '密码修改保存失败', {
      requestId: req.requestId,
      userId: req.user.id,
      error: error.message
    });
    return res.status(500).json({ message: '修改密码失败，请稍后重试' });
  }

  res.json({ message: '密码已修改' });
});

app.get('/api/users/search', authWithRefresh, (req, res) => {
  const keyword = String(req.query.q || '').trim().toLowerCase();
  if (!keyword) return res.json([]);
  const users = db.users
    .filter(user => user.id !== req.user.id)
    .filter(user => user.username.toLowerCase().includes(keyword) || user.displayName.toLowerCase().includes(keyword))
    .slice(0, 10)
    .map(publicUser);
  res.json(users);
});

app.post('/api/friends/request', authWithRefresh, async (req, res) => {
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
  logOperation('info', '好友请求准备保存', {
    requestId: req.requestId,
    friendRequestId: request.id,
    fromUserId: request.from,
    toUserId: request.to
  });
  try {
    await saveData('friend:request', {
      requestId: req.requestId,
      friendRequestId: request.id,
      fromUserId: request.from,
      toUserId: request.to
    });
  } catch (error) {
    logOperation('error', '好友请求保存失败', {
      requestId: req.requestId,
      friendRequestId: request.id,
      error: error.message
    });
    return res.status(500).json({ message: '保存好友请求失败，请稍后重试' });
  }
  logOperation('info', '好友请求保存成功', {
    requestId: req.requestId,
    friendRequestId: request.id,
    fromUserId: request.from,
    toUserId: request.to
  });
  emitToUser(target.id, 'friend:request', { ...request, fromUser: publicUser(req.user) });
  res.json({ message: '好友请求已发送', request });
});

app.post('/api/friends/respond', authWithRefresh, async (req, res) => {
  const { requestId, accept } = req.body;
  const request = db.friendRequests.find(item => item.id === requestId && item.to === req.user.id);
  if (!request) return res.status(404).json({ message: '好友请求不存在' });
  if (request.status !== 'pending') return res.status(400).json({ message: '好友请求已处理' });

  request.status = accept ? 'accepted' : 'rejected';
  request.updatedAt = new Date().toISOString();
  if (accept && !areFriends(request.from, request.to)) {
    db.friendships.push([request.from, request.to]);
  }
  logOperation('info', '好友请求响应准备保存', {
    requestId: req.requestId,
    friendRequestId: request.id,
    accept: Boolean(accept),
    fromUserId: request.from,
    toUserId: request.to
  });
  try {
    await saveData('friend:respond', {
      requestId: req.requestId,
      friendRequestId: request.id,
      accept: Boolean(accept),
      fromUserId: request.from,
      toUserId: request.to
    });
  } catch (error) {
    logOperation('error', '好友请求响应保存失败', {
      requestId: req.requestId,
      friendRequestId: request.id,
      error: error.message
    });
    return res.status(500).json({ message: '保存好友数据失败，请稍后重试' });
  }
  logOperation('info', '好友请求响应保存成功', {
    requestId: req.requestId,
    friendRequestId: request.id,
    accept: Boolean(accept),
    friendshipCount: db.friendships.length
  });
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

app.delete('/api/friends/:friendId', authWithRefresh, async (req, res) => {
  const friend = db.users.find(user => user.id === req.params.friendId);
  if (!friend) return res.status(404).json({ message: '好友不存在' });

  const friendshipIndex = db.friendships.findIndex(pair => pair.includes(req.user.id) && pair.includes(friend.id));
  if (friendshipIndex === -1) return res.status(400).json({ message: '你们当前不是好友' });

  db.friendships.splice(friendshipIndex, 1);
  db.friendRequests = db.friendRequests.filter(request =>
    !((request.from === req.user.id && request.to === friend.id) || (request.from === friend.id && request.to === req.user.id))
  );
  const cleanup = clearConversationMessages(req.user.id, friend.id);
  logOperation('info', '删除好友准备保存', {
    requestId: req.requestId,
    userId: req.user.id,
    friendId: friend.id,
    removedMessageCount: cleanup.removedMessageCount
  });
  try {
    await saveData('friend:delete', {
      requestId: req.requestId,
      userId: req.user.id,
      friendId: friend.id,
      removedMessageCount: cleanup.removedMessageCount
    });
  } catch (error) {
    logOperation('error', '删除好友保存失败', {
      requestId: req.requestId,
      userId: req.user.id,
      friendId: friend.id,
      error: error.message
    });
    return res.status(500).json({ message: '删除好友数据失败，请稍后重试' });
  }

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

app.post('/api/groupsx', authWithRefresh, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  const uniqueFriendIds = [...new Set(memberIds)]
    .filter(userId => userId && userId !== req.user.id && areFriends(req.user.id, userId));

  if (!name) return res.status(400).json({ message: '群聊名称不能为空' });
  if (name.length > 30) return res.status(400).json({ message: '群聊名称最多 30 个字符' });
  if (!uniqueFriendIds.length) return res.status(400).json({ message: '请至少选择 1 位好友创建群聊' });

  const group = {
    id: uuid(),
    name,
    ownerId: req.user.id,
    memberIds: [req.user.id, ...uniqueFriendIds],
    createdAt: new Date().toISOString()
  };
  db.groupsx.push(group);

  try {
    await saveData('group:create', {
      requestId: req.requestId,
      groupId: group.id,
      ownerId: group.ownerId,
      memberCount: group.memberIds.length
    });
  } catch (error) {
    logOperation('error', '群聊创建保存失败', {
      requestId: req.requestId,
      groupId: group.id,
      error: error.message
    });
    return res.status(500).json({ message: '创建群聊失败，请稍后重试' });
  }

  const payload = { group: publicGroup(group) };
  group.memberIds.forEach(userId => emitToUser(userId, 'group:updated', payload));
  res.json({ message: '群聊已创建', group: payload.group });
});

app.get('/api/groupsx/:groupId/members', authWithRefresh, (req, res) => {
  const group = db.groupsx.find(item => item.id === req.params.groupId);
  if (!group || !isGroupMember(group, req.user.id)) {
    return res.status(403).json({ message: '只能查看自己加入的群聊成员' });
  }
  res.json({ group: publicGroup(group) });
});

app.post('/api/groupsx/:groupId/members', authWithRefresh, async (req, res) => {
  const group = db.groupsx.find(item => item.id === req.params.groupId);
  if (!group || !isGroupMember(group, req.user.id)) return res.status(404).json({ message: '群聊不存在' });
  if (group.ownerId !== req.user.id) return res.status(403).json({ message: '只有群主可以添加群成员' });

  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  const nextMemberIds = [...new Set(memberIds)]
    .filter(userId => userId && userId !== req.user.id)
    .filter(userId => !group.memberIds.includes(userId))
    .filter(userId => areFriends(req.user.id, userId));

  if (!nextMemberIds.length) return res.status(400).json({ message: '请选择未加入群聊的好友' });

  group.memberIds.push(...nextMemberIds);
  try {
    await saveData('group:add-members', {
      requestId: req.requestId,
      userId: req.user.id,
      groupId: group.id,
      addedMemberCount: nextMemberIds.length,
      memberCount: group.memberIds.length
    });
  } catch (error) {
    logOperation('error', '添加群成员保存失败', {
      requestId: req.requestId,
      groupId: group.id,
      error: error.message
    });
    return res.status(500).json({ message: '添加群成员失败，请稍后重试' });
  }

  const payload = { group: publicGroup(group) };
  group.memberIds.forEach(userId => emitToUser(userId, 'group:updated', payload));
  res.json({ message: '群成员已添加', group: payload.group });
});

app.delete('/api/groupsx/:groupId/members/:memberId', authWithRefresh, async (req, res) => {
  const group = db.groupsx.find(item => item.id === req.params.groupId);
  if (!group || !isGroupMember(group, req.user.id)) return res.status(404).json({ message: '群聊不存在' });
  if (group.ownerId !== req.user.id) return res.status(403).json({ message: '只有群主可以移除群成员' });
  if (req.params.memberId === group.ownerId) return res.status(400).json({ message: '不能移除群主' });
  if (!group.memberIds.includes(req.params.memberId)) return res.status(404).json({ message: '该用户不在群聊中' });

  group.memberIds = group.memberIds.filter(userId => userId !== req.params.memberId);
  try {
    await saveData('group:remove-member', {
      requestId: req.requestId,
      userId: req.user.id,
      groupId: group.id,
      removedMemberId: req.params.memberId,
      memberCount: group.memberIds.length
    });
  } catch (error) {
    logOperation('error', '移除群成员保存失败', {
      requestId: req.requestId,
      groupId: group.id,
      removedMemberId: req.params.memberId,
      error: error.message
    });
    return res.status(500).json({ message: '移除群成员失败，请稍后重试' });
  }

  const payload = { group: publicGroup(group) };
  group.memberIds.forEach(userId => emitToUser(userId, 'group:updated', payload));
  emitToUser(req.params.memberId, 'group:member-removed', {
    groupId: group.id,
    groupName: group.name
  });
  res.json({ message: '群成员已移除', group: payload.group, removedMemberId: req.params.memberId });
});

app.get('/api/groupsx/:groupId/messages', authWithRefresh, (req, res) => {
  const group = db.groupsx.find(item => item.id === req.params.groupId);
  if (!group || !isGroupMember(group, req.user.id)) {
    return res.status(403).json({ message: '只能查看自己加入的群聊消息' });
  }
  const removedCount = pruneExpiredMessages();
  if (removedCount) {
    saveData('group:prune-on-list', {
      requestId: req.requestId,
      userId: req.user.id,
      groupId: group.id,
      removedCount
    });
  }
  const conversationId = groupConversationOf(group.id);
  res.json(db.messages.filter(message => message.conversationId === conversationId));
});

app.delete('/api/groupsx/:groupId/messages', authWithRefresh, async (req, res) => {
  const group = db.groupsx.find(item => item.id === req.params.groupId);
  if (!group || !isGroupMember(group, req.user.id)) {
    return res.status(403).json({ message: '只能清空自己加入的群聊消息' });
  }

  const cleanup = clearGroupMessages(group.id);
  try {
    await saveData('group:clear-messages', {
      requestId: req.requestId,
      userId: req.user.id,
      groupId: group.id,
      removedMessageCount: cleanup.removedMessageCount
    });
  } catch (error) {
    logOperation('error', '清空群聊记录保存失败', {
      requestId: req.requestId,
      groupId: group.id,
      error: error.message
    });
    return res.status(500).json({ message: '清空群聊记录失败，请稍后重试' });
  }

  const payload = {
    groupId: group.id,
    conversationId: cleanup.conversationId,
    removedMessageCount: cleanup.removedMessageCount
  };
  group.memberIds.forEach(userId => emitToUser(userId, 'group:messages-cleared', payload));
  res.json({ message: '群聊记录已清空', ...payload });
});

app.delete('/api/groupsx/:groupId', authWithRefresh, async (req, res) => {
  const groupIndex = db.groupsx.findIndex(item => item.id === req.params.groupId);
  const group = db.groupsx[groupIndex];
  if (!group || !isGroupMember(group, req.user.id)) return res.status(404).json({ message: '群聊不存在' });
  if (group.ownerId !== req.user.id) return res.status(403).json({ message: '只有群主可以解散群聊' });

  const memberIds = [...group.memberIds];
  const cleanup = clearGroupMessages(group.id);
  db.groupsx.splice(groupIndex, 1);

  try {
    await saveData('group:dissolve', {
      requestId: req.requestId,
      userId: req.user.id,
      groupId: group.id,
      removedMessageCount: cleanup.removedMessageCount
    });
  } catch (error) {
    logOperation('error', '解散群聊保存失败', {
      requestId: req.requestId,
      groupId: group.id,
      error: error.message
    });
    return res.status(500).json({ message: '解散群聊失败，请稍后重试' });
  }

  const payload = {
    groupId: group.id,
    groupName: group.name,
    conversationId: cleanup.conversationId,
    removedMessageCount: cleanup.removedMessageCount
  };
  memberIds.forEach(userId => emitToUser(userId, 'group:dissolved', payload));
  res.json({ message: '群聊已解散，聊天记录已清空', ...payload });
});

app.get('/api/messages/:friendId', authWithRefresh, (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能查看好友消息' });
  const removedCount = pruneExpiredMessages();
  if (removedCount) {
    saveData('message:prune-on-list', {
      requestId: req.requestId,
      userId: req.user.id,
      friendId: req.params.friendId,
      removedCount
    });
  }
  const conversationId = conversationOf(req.user.id, req.params.friendId);
  res.json(db.messages.filter(message => message.conversationId === conversationId));
});

app.delete('/api/messages/:friendId', authWithRefresh, async (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能清空好友会话' });
  const friend = db.users.find(user => user.id === req.params.friendId);
  if (!friend) return res.status(404).json({ message: '好友不存在' });

  const cleanup = clearConversationMessages(req.user.id, friend.id);
  logOperation('info', '清空聊天记录准备保存', {
    requestId: req.requestId,
    userId: req.user.id,
    friendId: friend.id,
    removedMessageCount: cleanup.removedMessageCount
  });
  try {
    await saveData('message:clear-conversation', {
      requestId: req.requestId,
      userId: req.user.id,
      friendId: friend.id,
      removedMessageCount: cleanup.removedMessageCount
    });
  } catch (error) {
    logOperation('error', '清空聊天记录保存失败', {
      requestId: req.requestId,
      userId: req.user.id,
      friendId: friend.id,
      error: error.message
    });
    return res.status(500).json({ message: '清空聊天记录失败，请稍后重试' });
  }

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

app.post('/api/messages/:friendId/read', authWithRefresh, (req, res) => {
  if (!areFriends(req.user.id, req.params.friendId)) return res.status(403).json({ message: '只能标记好友消息' });
  const receipt = markConversationRead(req.user.id, req.params.friendId);
  if (receipt.messageIds.length) {
    emitToUser(req.user.id, 'message:read', receipt);
    emitToUser(req.params.friendId, 'message:read', receipt);
  }
  res.json(receipt);
});

app.post('/api/ephemeral/toggle', authWithRefresh, async (req, res) => {
  const { conversationId, enable } = req.body;
  if (!conversationId || typeof enable !== 'boolean') {
    return res.status(400).json({ message: '参数无效' });
  }
  if (enable) {
    ephemeralConversations.add(conversationId);
    await dataStore.ephemeralStore?.add(conversationId);
    const cleanup = conversationId.startsWith('group:')
      ? clearGroupMessages(conversationId.slice(6))
      : clearConversationMessages(req.user.id, conversationId);
    if (cleanup.removedMessageCount) {
      saveData('ephemeral:clear-on-enable', { conversationId, removedCount: cleanup.removedMessageCount });
    }
  } else {
    ephemeralConversations.delete(conversationId);
    await dataStore.ephemeralStore?.delete(conversationId);
  }
  broadcastEphemeralToggle(conversationId, enable, req.user.id);
  res.json({ conversationId, enabled: enable });
});

app.get('/api/ephemeral/status', authWithRefresh, (req, res) => {
  res.json({ ephemeralConversations: [...ephemeralConversations] });
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

  socket.on('auth:logout', ack => {
    const offline = removeOnlineSocket(socket);
    if (typeof ack === 'function') ack({ ok: true, offline });
  });

  socket.on('typing', payload => {
    const { to } = payload || {};
    if (!to || !areFriends(socket.user.id, to)) return;
    emitToUser(to, 'typing', { from: socket.user.id });
  });

  socket.on('stop-typing', payload => {
    const { to } = payload || {};
    if (!to || !areFriends(socket.user.id, to)) return;
    emitToUser(to, 'stop-typing', { from: socket.user.id });
  });

  socket.on('ephemeral:toggle', payload => {
    const { conversationId, enable } = payload || {};
    if (!conversationId || typeof enable !== 'boolean') return;
    if (enable) {
      ephemeralConversations.add(conversationId);
      dataStore.ephemeralStore?.add(conversationId).catch(() => {});
    } else {
      ephemeralConversations.delete(conversationId);
      dataStore.ephemeralStore?.delete(conversationId).catch(() => {});
    }
    broadcastEphemeralToggle(conversationId, enable, socket.user.id);
  });

  socket.on('message:send', payload => {
    const { to, groupId, type, text, file } = payload || {};
    const group = groupId ? db.groupsx.find(item => item.id === groupId) : null;
    if (groupId && (!group || !isGroupMember(group, socket.user.id))) {
      socket.emit('message:error', { message: '只能在自己加入的群聊中发送消息' });
      return;
    }
    if (!groupId && (!to || !areFriends(socket.user.id, to))) {
      socket.emit('message:error', { message: '只能给好友发送消息' });
      return;
    }
    if (!['text', 'image', 'audio', 'video', 'file'].includes(type)) {
      socket.emit('message:error', { message: '不支持的消息类型' });
      return;
    }
    if (type === 'text' && !String(text || '').trim()) return;

    const convId = group ? groupConversationOf(group.id) : conversationOf(socket.user.id, to);
    const ephemeralKey = group ? `group:${group.id}` : to;
    const ephemeral = isEphemeralConversation(ephemeralKey);
    const message = {
      id: uuid(),
      conversationId: convId,
      from: socket.user.id,
      to: group ? null : to,
      groupId: group?.id || null,
      type,
      text: type === 'text' ? String(text).trim() : '',
      file: type === 'text' ? null : file,
      createdAt: new Date().toISOString(),
      readAt: null,
      ephemeral
    };
    db.messages.push(message);
    saveData('message:send', {
      socketId: socket.id,
      messageId: message.id,
      conversationId: message.conversationId,
      fromUserId: message.from,
      toUserId: message.to,
      groupId: message.groupId,
      type: message.type
    });
    if (group) {
      emitToGroup(group, 'message:new', message);
      return;
    }
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
      const group = message.groupId ? db.groupsx.find(item => item.id === message.groupId) : null;
      if (message.groupId && !isGroupMember(group, socket.user.id)) {
        const error = { ok: false, message: '只能删除自己所在群聊的消息' };
        socket.emit('message:error', { message: error.message });
        reply(error);
        return;
      }
      db.messages.splice(messageIndex, 1);
      removeMessageFile(message);
      saveData('message:delete', {
        socketId: socket.id,
        messageId: message.id,
        conversationId: message.conversationId,
        fromUserId: message.from,
        toUserId: message.to,
        groupId: message.groupId
      });

      const payloadToEmit = {
        messageId: message.id,
        conversationId: message.conversationId,
        from: message.from,
        to: message.to,
        groupId: message.groupId
      };
      if (group) {
        emitToGroup(group, 'message:deleted', payloadToEmit);
        reply({ ok: true, ...payloadToEmit });
        return;
      }
      emitToUser(message.from, 'message:deleted', payloadToEmit);
      emitToUser(message.to, 'message:deleted', payloadToEmit);
      reply({ ok: true, ...payloadToEmit });
    } catch (deleteError) {
      const error = { ok: false, message: deleteError.message || '删除消息失败' };
      socket.emit('message:error', { message: error.message });
      reply(error);
    }
  });

  socket.on('message:edit', (payload, ack) => {
    const reply = response => {
      if (typeof ack === 'function') ack(response);
    };
    const { messageId, text } = payload || {};
    const message = db.messages.find(item => item.id === messageId);
    if (!message) {
      const error = { ok: false, message: '消息不存在或已被删除' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }
    if (message.from !== socket.user.id) {
      const error = { ok: false, message: '只能编辑自己发送的消息' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }
    if (message.type !== 'text') {
      const error = { ok: false, message: '只能编辑文本消息' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }
    const nextText = String(text || '').trim();
    if (!nextText) {
      const error = { ok: false, message: '消息内容不能为空' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }

    const group = message.groupId ? db.groupsx.find(item => item.id === message.groupId) : null;
    if (message.groupId && !isGroupMember(group, socket.user.id)) {
      const error = { ok: false, message: '只能编辑自己所在群聊的消息' };
      socket.emit('message:error', { message: error.message });
      reply(error);
      return;
    }
    message.text = nextText;
    message.editedAt = new Date().toISOString();
    saveData('message:edit', {
      socketId: socket.id,
      messageId: message.id,
      conversationId: message.conversationId,
      fromUserId: message.from,
      toUserId: message.to,
      groupId: message.groupId
    });

    const payloadToEmit = {
      ok: true,
      message,
      messageId: message.id,
      conversationId: message.conversationId,
      from: message.from,
      to: message.to,
      groupId: message.groupId
    };
    if (group) {
      emitToGroup(group, 'message:edited', payloadToEmit);
      reply(payloadToEmit);
      return;
    }
    emitToUser(message.from, 'message:edited', payloadToEmit);
    emitToUser(message.to, 'message:edited', payloadToEmit);
    reply(payloadToEmit);
  });

  socket.on('call:invite', payload => {
    if (!CALLS_ENABLED) {
      socket.emit('call:error', { message: '语音和视频聊天功能已关闭' });
      return;
    }
    const { to } = payload || {};
    if (!onlineUsers.get(to)) {
      socket.emit('call:error', { message: '对方当前不在线，无法发起视频通话' });
      return;
    }
    forwardCallEvent(socket, 'call:incoming', payload);
  });

  socket.on('call:accept', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:accepted', payload);
  });

  socket.on('call:reject', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:rejected', payload);
  });

  socket.on('call:cancel', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:canceled', payload);
  });

  socket.on('call:end', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:ended', payload);
  });

  socket.on('call:offer', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:offer', payload);
  });

  socket.on('call:answer', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:answer', payload);
  });

  socket.on('call:ice', payload => {
    if (!CALLS_ENABLED) return;
    forwardCallEvent(socket, 'call:ice', payload);
  });

  socket.on('disconnect', () => {
    removeOnlineSocket(socket);
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
