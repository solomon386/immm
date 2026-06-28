const state = {
  mode: 'login',
  token: localStorage.getItem('token'),
  me: null,
  friends: [],
  requests: [],
  selectedFriend: null,
  messages: [],
  socket: null,
  call: null,
  contextFriendId: null
};

const $ = selector => document.querySelector(selector);
const authView = $('#authView');
const chatView = $('#chatView');
const loginTab = $('#loginTab');
const registerTab = $('#registerTab');
const authForm = $('#authForm');
const authSubmit = $('#authSubmit');
const authTip = $('#authTip');
const displayNameWrap = $('#displayNameWrap');
const friendList = $('#friendList');
const requestList = $('#requestList');
const searchResults = $('#searchResults');
const messagesEl = $('#messages');
const messageInput = $('#messageInput');
const fileInput = $('#fileInput');
const sendBtn = $('#sendBtn');
const voiceCallBtn = $('#voiceCallBtn');
const videoCallBtn = $('#videoCallBtn');
const callCard = $('#callCard');
const callOverlay = $('#callOverlay');
const callTitle = $('#callTitle');
const callStatus = $('#callStatus');
const localVideo = $('#localVideo');
const remoteVideo = $('#remoteVideo');
const localAudioAvatar = $('#localAudioAvatar');
const remoteAudioAvatar = $('#remoteAudioAvatar');
const localMediaLabel = $('#localMediaLabel');
const remoteMediaLabel = $('#remoteMediaLabel');
const incomingActions = $('#incomingActions');
const friendContextMenu = $('#friendContextMenu');
const contextDeleteFriendBtn = $('#contextDeleteFriendBtn');
const contextClearMessagesBtn = $('#contextClearMessagesBtn');
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function toast(message, error = false) {
  authTip.textContent = message;
  authTip.style.color = error ? '#dc2626' : '#16a34a';
  if (!authView.classList.contains('hidden')) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    top: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '10px 16px',
    borderRadius: '999px',
    color: 'white',
    background: error ? '#dc2626' : '#16a34a',
    zIndex: 100
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || '请求失败');
  return data;
}

function setMode(mode) {
  state.mode = mode;
  loginTab.classList.toggle('active', mode === 'login');
  registerTab.classList.toggle('active', mode === 'register');
  displayNameWrap.classList.toggle('hidden', mode === 'login');
  authSubmit.textContent = mode === 'login' ? '登录' : '注册';
  authTip.textContent = '';
}

function initials(user) {
  return (user?.displayName || user?.username || '?').slice(0, 2).toUpperCase();
}

function setAvatar(el, user) {
  el.textContent = initials(user);
  el.style.background = user?.avatarColor || '#4f46e5';
}

function showChat() {
  authView.classList.add('hidden');
  chatView.classList.remove('hidden');
}

function showAuth() {
  chatView.classList.add('hidden');
  authView.classList.remove('hidden');
}

async function boot() {
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    await loadMe();
    connectSocket();
    showChat();
  } catch {
    localStorage.removeItem('token');
    state.token = null;
    showAuth();
  }
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user;
  state.friends = data.friends;
  state.requests = data.requests;
  $('#myName').textContent = state.me.displayName;
  $('#myUsername').textContent = `@${state.me.username}`;
  setAvatar($('#myAvatar'), state.me);
  renderFriends();
  renderRequests();
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('message:new', message => {
    if (!state.selectedFriend) return;
    const belongs = [message.from, message.to].includes(state.selectedFriend.id);
    if (!belongs) return;
    if (!state.messages.some(item => item.id === message.id)) state.messages.push(message);
    renderMessages();
    if (message.from === state.selectedFriend.id && message.to === state.me.id) {
      markSelectedConversationRead();
    }
  });

  state.socket.on('message:read', handleReadReceipt);
  state.socket.on('message:deleted', handleMessageDeleted);
  state.socket.on('message:error', payload => toast(payload.message, true));
  state.socket.on('friend:request', async () => {
    await loadMe();
    toast('收到新的好友请求');
  });
  state.socket.on('friend:updated', async () => {
    await loadMe();
    toast('好友状态已更新');
  });
  state.socket.on('friend:removed', handleFriendRemoved);
  state.socket.on('conversation:cleared', handleConversationCleared);
  state.socket.on('presence:update', ({ userId, online }) => {
    const friend = state.friends.find(item => item.id === userId);
    if (friend) friend.online = online;
    if (state.selectedFriend?.id === userId) state.selectedFriend.online = online;
    renderFriends();
    updateChatHeader();
  });

  state.socket.on('call:incoming', handleIncomingCall);
  state.socket.on('call:accepted', handleCallAccepted);
  state.socket.on('call:rejected', payload => {
    cleanupCall();
    toast(payload.reason || '对方已拒绝通话', true);
  });
  state.socket.on('call:canceled', () => {
    cleanupCall();
    toast('对方已取消通话');
  });
  state.socket.on('call:ended', () => {
    cleanupCall();
    toast('通话已结束');
  });
  state.socket.on('call:offer', handleCallOffer);
  state.socket.on('call:answer', handleCallAnswer);
  state.socket.on('call:ice', handleRemoteIce);
  state.socket.on('call:error', payload => {
    cleanupCall();
    toast(payload.message, true);
  });
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#password').value;
  const displayName = $('#displayName').value.trim();

  try {
    const endpoint = state.mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const data = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ username, password, displayName })
    });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    await loadMe();
    connectSocket();
    showChat();
    authForm.reset();
  } catch (error) {
    toast(error.message, true);
  }
});

loginTab.addEventListener('click', () => setMode('login'));
registerTab.addEventListener('click', () => setMode('register'));

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('token');
  state.token = null;
  state.me = null;
  state.selectedFriend = null;
  state.messages = [];
  endCall(false);
  if (state.socket) state.socket.disconnect();
  showAuth();
});

$('#searchBtn').addEventListener('click', searchUsers);
$('#searchInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') searchUsers();
});

async function searchUsers() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  try {
    const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    searchResults.innerHTML = '';
    if (!users.length) {
      searchResults.textContent = '没有找到用户';
      searchResults.classList.add('empty');
      return;
    }
    searchResults.classList.remove('empty');
    users.forEach(user => {
      const item = userItem(user);
      const btn = document.createElement('button');
      btn.textContent = '添加';
      btn.addEventListener('click', () => sendFriendRequest(user.id));
      item.querySelector('.actions').appendChild(btn);
      searchResults.appendChild(item);
    });
  } catch (error) {
    toast(error.message, true);
  }
}

async function sendFriendRequest(toUserId) {
  try {
    const data = await api('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ toUserId })
    });
    toast(data.message);
  } catch (error) {
    toast(error.message, true);
  }
}

function userItem(user) {
  const tpl = $('#userItemTpl').content.cloneNode(true);
  const item = tpl.querySelector('.user-item');
  const avatar = tpl.querySelector('.avatar');
  const strong = tpl.querySelector('strong');
  const span = tpl.querySelector('span');
  setAvatar(avatar, user);
  strong.textContent = user.displayName;
  span.innerHTML = `<span class="status-dot ${user.online ? 'online' : ''}"></span>@${user.username}`;
  return item;
}

function renderRequests() {
  requestList.innerHTML = '';
  if (!state.requests.length) {
    requestList.textContent = '暂无好友请求';
    requestList.classList.add('empty');
    return;
  }
  requestList.classList.remove('empty');
  state.requests.forEach(request => {
    const item = userItem(request.fromUser);
    const actions = item.querySelector('.actions');
    const accept = document.createElement('button');
    const reject = document.createElement('button');
    accept.textContent = '同意';
    reject.textContent = '拒绝';
    reject.className = 'reject';
    accept.addEventListener('click', () => respondRequest(request.id, true));
    reject.addEventListener('click', () => respondRequest(request.id, false));
    actions.append(accept, reject);
    requestList.appendChild(item);
  });
}

async function respondRequest(requestId, accept) {
  try {
    const data = await api('/api/friends/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId, accept })
    });
    toast(data.message);
    await loadMe();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderFriends() {
  friendList.innerHTML = '';
  hideFriendContextMenu();
  if (!state.friends.length) {
    friendList.textContent = '暂无好友';
    friendList.classList.add('empty');
    return;
  }
  friendList.classList.remove('empty');
  state.friends.forEach(friend => {
    const item = userItem(friend);
    item.title = '左键聊天，右键打开更多操作';
    item.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showFriendContextMenu(event, friend);
    });
    item.classList.toggle('active', state.selectedFriend?.id === friend.id);
    item.addEventListener('click', () => selectFriend(friend));
    friendList.appendChild(item);
  });
}

function showFriendContextMenu(event, friend) {
  state.contextFriendId = friend.id;
  friendContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  friendContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 110)}px`;
  friendContextMenu.classList.remove('hidden');
}

function hideFriendContextMenu() {
  state.contextFriendId = null;
  friendContextMenu?.classList.add('hidden');
}

contextDeleteFriendBtn.addEventListener('click', () => {
  const friendId = state.contextFriendId;
  hideFriendContextMenu();
  if (friendId) deleteFriend(friendId);
});

contextClearMessagesBtn.addEventListener('click', () => {
  const friendId = state.contextFriendId;
  hideFriendContextMenu();
  if (friendId) clearFriendMessages(friendId);
});

document.addEventListener('click', event => {
  if (!friendContextMenu.contains(event.target)) hideFriendContextMenu();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideFriendContextMenu();
});

window.addEventListener('scroll', hideFriendContextMenu, true);

function resetConversation(message = '请选择好友开始聊天', status = '好友上线后可实时收发消息') {
  state.selectedFriend = null;
  state.messages = [];
  messageInput.value = '';
  messageInput.disabled = true;
  fileInput.disabled = true;
  sendBtn.disabled = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  $('#chatTitle').textContent = message;
  $('#chatStatus').textContent = status;
  messagesEl.innerHTML = '<div class="welcome"><h3>请选择好友</h3><p>从左侧好友列表选择一个好友开始聊天。</p></div>';
}

async function deleteFriend(friendId) {
  const friend = state.friends.find(item => item.id === friendId);
  if (!friend) return;
  if (!confirm(`确定删除好友「${friend.displayName}」吗？双方会话消息也会被清理。`)) return;

  try {
    const data = await api(`/api/friends/${friendId}`, { method: 'DELETE' });
    toast(data.message);
    await loadMe();
    if (state.selectedFriend?.id === friendId) {
      resetConversation('好友已删除', '请选择其他好友继续聊天');
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function clearFriendMessages(friendId) {
  const friend = state.friends.find(item => item.id === friendId);
  if (!friend) return;
  if (!confirm(`确定清空与「${friend.displayName}」的全部聊天记录吗？此操作只会清理你们双方之间的消息。`)) return;

  try {
    const data = await api(`/api/messages/${friendId}`, { method: 'DELETE' });
    toast(data.message);
    if (state.selectedFriend?.id === friendId) {
      state.messages = [];
      renderMessages();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function handleFriendRemoved(payload) {
  await loadMe();
  if ([payload.userId, payload.friendId].includes(state.selectedFriend?.id)) {
    resetConversation('好友关系已解除', '该会话已不可用');
  }
  toast('好友列表已更新');
}

function handleConversationCleared(payload) {
  if ([payload.userId, payload.friendId].includes(state.selectedFriend?.id)) {
    state.messages = [];
    renderMessages();
    toast('聊天记录已清空');
  }
}

async function selectFriend(friend) {
  state.selectedFriend = friend;
  state.messages = await api(`/api/messages/${friend.id}`);
  messageInput.disabled = false;
  fileInput.disabled = false;
  sendBtn.disabled = false;
  voiceCallBtn.disabled = !friend.online;
  videoCallBtn.disabled = !friend.online;
  updateChatHeader();
  renderFriends();
  renderMessages();
  markSelectedConversationRead();
}

function updateChatHeader() {
  if (!state.selectedFriend) return;
  $('#chatTitle').textContent = state.selectedFriend.displayName;
  $('#chatStatus').textContent = state.selectedFriend.online ? '在线，可发起语音或视频通话' : '离线，消息会保存在聊天记录中';
  voiceCallBtn.disabled = !state.selectedFriend.online || Boolean(state.call);
  videoCallBtn.disabled = !state.selectedFriend.online || Boolean(state.call);
}

function renderMessages() {
  messagesEl.innerHTML = '';
  if (!state.messages.length) {
    messagesEl.innerHTML = '<div class="welcome"><h3>还没有消息</h3><p>发送一条文本或媒体消息开始聊天。</p></div>';
    return;
  }
  state.messages.forEach(message => {
    const wrap = document.createElement('div');
    const mine = message.from === state.me.id;
    wrap.className = `message ${mine ? 'mine' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.appendChild(renderMessageBody(message));
    const time = document.createElement('small');
    time.textContent = messageMetaText(message, mine);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.appendChild(time);
    if (mine) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '删除';
      deleteBtn.className = 'delete-message-btn';
      deleteBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        deleteMessage(message.id, deleteBtn);
      });
      meta.appendChild(deleteBtn);
    }
    wrap.append(bubble, meta);
    messagesEl.appendChild(wrap);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function messageMetaText(message, mine) {
  const sentAt = new Date(message.createdAt).toLocaleString();
  if (!mine) return sentAt;
  if (!message.readAt) return `${sentAt} · 未读`;
  return `${sentAt} · 已读 ${new Date(message.readAt).toLocaleTimeString()}`;
}

function handleReadReceipt(receipt) {
  if (!receipt?.messageIds?.length) return;
  const ids = new Set(receipt.messageIds);
  let changed = false;
  state.messages.forEach(message => {
    if (ids.has(message.id)) {
      message.readAt = receipt.readAt;
      changed = true;
    }
  });
  if (changed) renderMessages();
}

function handleMessageDeleted(payload) {
  const before = state.messages.length;
  state.messages = state.messages.filter(message => message.id !== payload.messageId);
  if (state.messages.length !== before) renderMessages();
}

function deleteMessage(messageId, button) {
  if (!state.socket?.connected) {
    toast('当前未连接服务器，无法删除消息', true);
    return;
  }
  const confirmed = typeof window.confirm === 'function' ? window.confirm('确定删除这条消息吗？') : true;
  if (!confirmed) return;

  if (button) {
    button.disabled = true;
    button.textContent = '删除中...';
  }

  state.socket.timeout(5000).emit('message:delete', { messageId }, (error, response) => {
    if (error) {
      toast('删除消息超时，请检查连接后重试', true);
      if (button) {
        button.disabled = false;
        button.textContent = '删除';
      }
      return;
    }

    if (!response?.ok) {
      toast(response?.message || '删除消息失败', true);
      if (button) {
        button.disabled = false;
        button.textContent = '删除';
      }
      return;
    }

    handleMessageDeleted(response);
    toast('消息已删除');
  });
}

function markSelectedConversationRead() {
  if (!state.socket?.connected || !state.selectedFriend) return;
  const hasUnreadIncoming = state.messages.some(message =>
    message.from === state.selectedFriend.id &&
    message.to === state.me.id &&
    !message.readAt
  );
  if (!hasUnreadIncoming) return;
  state.socket.emit('message:read', { friendId: state.selectedFriend.id });
}

function renderMessageBody(message) {
  if (message.type === 'text') {
    const span = document.createElement('span');
    span.textContent = message.text;
    return span;
  }

  const url = message.file?.url || '';
  if (message.type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = message.file?.name || '图片消息';
    return img;
  }
  if (message.type === 'audio') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    return audio;
  }
  if (message.type === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    return video;
  }

  const link = document.createElement('a');
  link.href = url;
  link.textContent = message.file?.name || '文件';
  link.target = '_blank';
  return link;
}

$('#messageForm').addEventListener('submit', event => {
  event.preventDefault();
  sendText();
});

function sendText() {
  const text = messageInput.value.trim();
  if (!text || !state.selectedFriend) return;
  state.socket.emit('message:send', {
    to: state.selectedFriend.id,
    type: 'text',
    text
  });
  messageInput.value = '';
}

voiceCallBtn.addEventListener('click', startVoiceCall);
videoCallBtn.addEventListener('click', startVideoCall);
$('#closeCallBtn').addEventListener('click', () => endCall(true));
$('#acceptCallBtn').addEventListener('click', acceptIncomingCall);
$('#rejectCallBtn').addEventListener('click', rejectIncomingCall);

function startVoiceCall() {
  startMediaCall('audio');
}

function startVideoCall() {
  startMediaCall('video');
}

async function startMediaCall(type) {
  if (!state.selectedFriend || state.call) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前浏览器不支持麦克风或摄像头采集', true);
    return;
  }
  if (!state.selectedFriend.online) {
    toast(`对方不在线，无法发起${callName(type)}`, true);
    return;
  }

  try {
    const localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints(type));
    const callId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const peer = createPeer(state.selectedFriend.id, localStream);
    state.call = {
      callId,
      type,
      target: state.selectedFriend,
      peer,
      localStream,
      remoteStream: new MediaStream(),
      isCaller: true,
      incoming: false
    };
    showCallPanel(`正在呼叫 ${state.selectedFriend.displayName}`, `等待对方接听${callName(type)}...`, false);
    state.socket.emit('call:invite', { to: state.selectedFriend.id, callId, type });
    updateChatHeader();
  } catch (error) {
    cleanupCall();
    toast(`无法打开${type === 'audio' ? '麦克风' : '摄像头或麦克风'}：${error.message}`, true);
  }
}

function handleIncomingCall(payload) {
  if (state.call) {
    state.socket.emit('call:reject', { to: payload.from, callId: payload.callId, reason: '对方正在通话中' });
    return;
  }

  state.call = {
    callId: payload.callId,
    type: payload.type || 'video',
    target: payload.fromUser,
    peer: null,
    localStream: null,
    remoteStream: new MediaStream(),
    isCaller: false,
    incoming: true
  };
  showCallPanel(`${payload.fromUser.displayName} 发来${callName(state.call.type)}`, '等待你接听...', true);
  updateChatHeader();
}

async function acceptIncomingCall() {
  if (!state.call?.incoming) return;
  try {
    const localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints(state.call.type));
    const peer = createPeer(state.call.target.id, localStream);
    state.call = {
      ...state.call,
      peer,
      localStream,
      incoming: false
    };
    showCallPanel(`正在与 ${state.call.target.displayName} ${callName(state.call.type)}`, '正在建立实时连接...', false);
    state.socket.emit('call:accept', { to: state.call.target.id, callId: state.call.callId, type: state.call.type });
  } catch (error) {
    const callType = state.call?.type;
    rejectIncomingCall();
    toast(`无法打开${callType === 'audio' ? '麦克风' : '摄像头或麦克风'}：${error.message}`, true);
  }
}

function rejectIncomingCall() {
  if (!state.call) return;
  state.socket.emit('call:reject', {
    to: state.call.target.id,
    callId: state.call.callId,
    reason: `对方已拒绝${callName(state.call.type)}`
  });
  cleanupCall();
}

async function handleCallAccepted(payload) {
  if (!state.call || payload.callId !== state.call.callId || !state.call.isCaller) return;
  try {
    callStatus.textContent = '正在建立实时连接...';
    const offer = await state.call.peer.createOffer();
    await state.call.peer.setLocalDescription(offer);
    state.socket.emit('call:offer', {
      to: state.call.target.id,
      callId: state.call.callId,
      description: state.call.peer.localDescription
    });
  } catch (error) {
    const callType = state.call?.type;
    endCall(true);
    toast(`创建${callName(callType)}失败：${error.message}`, true);
  }
}

async function handleCallOffer(payload) {
  if (!state.call || payload.callId !== state.call.callId || state.call.isCaller) return;
  try {
    await state.call.peer.setRemoteDescription(new RTCSessionDescription(payload.description));
    const answer = await state.call.peer.createAnswer();
    await state.call.peer.setLocalDescription(answer);
    state.socket.emit('call:answer', {
      to: state.call.target.id,
      callId: state.call.callId,
      description: state.call.peer.localDescription
    });
    callStatus.textContent = `${callName(state.call.type)}已连接`;
  } catch (error) {
    const callType = state.call?.type;
    endCall(true);
    toast(`接听${callName(callType)}失败：${error.message}`, true);
  }
}

async function handleCallAnswer(payload) {
  if (!state.call || payload.callId !== state.call.callId || !state.call.isCaller) return;
  try {
    await state.call.peer.setRemoteDescription(new RTCSessionDescription(payload.description));
    callStatus.textContent = `${callName(state.call.type)}已连接`;
  } catch (error) {
    const callType = state.call?.type;
    endCall(true);
    toast(`连接${callName(callType)}失败：${error.message}`, true);
  }
}

async function handleRemoteIce(payload) {
  if (!state.call || payload.callId !== state.call.callId || !payload.candidate) return;
  try {
    await state.call.peer?.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch {
    // 忽略已关闭连接上的候选地址。
  }
}

function createPeer(to, localStream) {
  const peer = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  peer.onicecandidate = event => {
    if (event.candidate && state.call) {
      state.socket.emit('call:ice', {
        to,
        callId: state.call.callId,
        candidate: event.candidate
      });
    }
  };

  peer.ontrack = event => {
    const [remoteStream] = event.streams;
    if (remoteStream) {
      remoteVideo.srcObject = remoteStream;
      if (state.call) state.call.remoteStream = remoteStream;
    }
    callStatus.textContent = `${callName(state.call?.type)}已连接`;
  };

  peer.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
      cleanupCall();
    }
  };

  return peer;
}

function showCallPanel(title, status, incoming) {
  const audioOnly = state.call?.type === 'audio';
  callTitle.textContent = title;
  callStatus.textContent = status;
  callCard.classList.toggle('audio-mode', audioOnly);
  localAudioAvatar.classList.toggle('hidden', !audioOnly);
  remoteAudioAvatar.classList.toggle('hidden', !audioOnly);
  localMediaLabel.textContent = audioOnly ? '我的麦克风' : '我的画面';
  remoteMediaLabel.textContent = audioOnly ? '对方语音' : '对方画面';
  incomingActions.classList.toggle('hidden', !incoming);
  callOverlay.classList.remove('hidden');
  localVideo.srcObject = state.call?.localStream || null;
  remoteVideo.srcObject = state.call?.remoteStream || null;
}

function callName(type = 'video') {
  return type === 'audio' ? '语音通话' : '视频通话';
}

function mediaConstraints(type = 'video') {
  return type === 'audio' ? { audio: true, video: false } : { audio: true, video: true };
}

function endCall(notifyPeer) {
  if (!state.call) return;
  if (notifyPeer && state.socket?.connected) {
    state.socket.emit(state.call.incoming ? 'call:reject' : 'call:end', {
      to: state.call.target.id,
      callId: state.call.callId,
      reason: state.call.incoming ? `对方已拒绝${callName(state.call.type)}` : undefined
    });
  }
  cleanupCall();
}

function cleanupCall() {
  if (!state.call) return;
  const currentCall = state.call;
  state.call = null;
  currentCall.localStream?.getTracks().forEach(track => track.stop());
  currentCall.peer?.close();
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  callCard.classList.remove('audio-mode');
  localAudioAvatar.classList.add('hidden');
  remoteAudioAvatar.classList.add('hidden');
  incomingActions.classList.add('hidden');
  callOverlay.classList.add('hidden');
  updateChatHeader();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file || !state.selectedFriend) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const uploaded = await api('/api/upload', { method: 'POST', body: fd });
    if (!['image', 'audio', 'video'].includes(uploaded.type)) {
      toast('只支持图片、语音和视频文件', true);
      return;
    }
    state.socket.emit('message:send', {
      to: state.selectedFriend.id,
      type: uploaded.type,
      file: uploaded
    });
  } catch (error) {
    toast(error.message, true);
  } finally {
    fileInput.value = '';
  }
});

setMode('login');
boot();
