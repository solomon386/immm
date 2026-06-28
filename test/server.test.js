import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UPLOAD_DIR,
  conversationOf,
  detectFileSignature,
  getDbForTest,
  hasAllowedExtensionForType,
  isAllowedUploadMeta,
  markConversationRead,
  removeMessageFile,
  setDbForTest,
  uploadTypeFromMime,
  validateUploadedFile
} from '../server.js';

function makeTempFile(bytes, filename = 'file.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'immm-test-'));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return { dir, filePath };
}

test('conversationOf 始终生成稳定的会话 ID', () => {
  assert.equal(conversationOf('user-b', 'user-a'), 'user-a:user-b');
  assert.equal(conversationOf('user-a', 'user-b'), 'user-a:user-b');
});

test('上传元信息校验允许合法图片并拒绝伪装扩展名', () => {
  assert.equal(uploadTypeFromMime('image/png'), 'image');
  assert.equal(hasAllowedExtensionForType('avatar.png', 'image'), true);
  assert.equal(isAllowedUploadMeta({ mimetype: 'image/png', originalname: 'avatar.png' }), true);
  assert.equal(isAllowedUploadMeta({ mimetype: 'image/png', originalname: 'avatar.exe' }), false);
  assert.equal(isAllowedUploadMeta({ mimetype: 'application/javascript', originalname: 'x.js' }), false);
});

test('文件头识别能区分 PNG、JPG、GIF 和伪装文件', () => {
  assert.equal(detectFileSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(detectFileSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(detectFileSignature(Buffer.from('GIF89a', 'ascii')), 'gif');
  assert.equal(detectFileSignature(Buffer.from('<script>alert(1)</script>')), null);
});

test('validateUploadedFile 接受真实 PNG 文件头', () => {
  const { dir, filePath } = makeTempFile(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00],
    'avatar.png'
  );

  try {
    const type = validateUploadedFile({
      path: filePath,
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: fs.statSync(filePath).size
    });
    assert.equal(type, 'image');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateUploadedFile 拒绝内容与声明类型不匹配的文件', () => {
  const { dir, filePath } = makeTempFile(Buffer.from('<script>alert(1)</script>'), 'avatar.png');

  try {
    assert.throws(() => validateUploadedFile({
      path: filePath,
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: fs.statSync(filePath).size
    }), /文件内容与声明类型不匹配/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markConversationRead 只标记当前会话里对方发来的未读消息', () => {
  setDbForTest({
    users: [],
    friendRequests: [],
    friendships: [['alice', 'bob']],
    messages: [
      { id: 'm1', conversationId: conversationOf('alice', 'bob'), from: 'alice', to: 'bob', readAt: null },
      { id: 'm2', conversationId: conversationOf('alice', 'bob'), from: 'bob', to: 'alice', readAt: null },
      { id: 'm3', conversationId: conversationOf('alice', 'carol'), from: 'carol', to: 'alice', readAt: null }
    ]
  });

  const receipt = markConversationRead('bob', 'alice');
  const db = getDbForTest();

  assert.deepEqual(receipt.messageIds, ['m1']);
  assert.ok(db.messages.find(message => message.id === 'm1').readAt);
  assert.equal(db.messages.find(message => message.id === 'm2').readAt, null);
  assert.equal(db.messages.find(message => message.id === 'm3').readAt, null);
});

test('removeMessageFile 会删除媒体消息关联的上传文件', () => {
  const filename = `unit-test-${Date.now()}.png`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  removeMessageFile({ file: { url: `/uploads/${filename}` } });

  assert.equal(fs.existsSync(filePath), false);
});
