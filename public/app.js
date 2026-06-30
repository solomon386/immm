const state = {
  mode: 'login',
  token: localStorage.getItem('token'),
  me: null,
  friends: [],
  groupsx: [],
  requests: [],
  selectedFriend: null,
  messages: [],
  unreadFriendIds: new Set(),
  friendResponses: [],
  socket: null,
  call: null,
  callsEnabled: false,
  notificationPermissionRequested: false,
  audioContext: null,
  contextFriendId: null,
  contextGroupId: null,
  contextMessageId: null,
  editingMessageId: null,
  currentTab: 'chat',
  deletedConversations: new Set()
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
const notificationBtn = $('#notificationBtn');
const editProfileBtn = $('#editProfileBtn');
const profileForm = $('#profileForm');
const profileDisplayName = $('#profileDisplayName');
const profileAvatarInput = $('#profileAvatarInput');
const profileAvatarButton = $('#profileAvatarButton');
const profileAvatarFilename = $('#profileAvatarFilename');
const cancelProfileBtn = $('#cancelProfileBtn');
const friendList = $('#friendList');
const groupNameInput = $('#groupNameInput');
const createGroupBtn = $('#createGroupBtn');
const groupMemberList = $('#groupMemberList');
const groupList = $('#groupList');
const requestList = $('#requestList');
const searchResults = $('#searchResults');
const friendResponseList = $('#friendResponseList');
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
const chatContextMenu = $('#chatContextMenu');
const contextChatClearMessagesBtn = $('#contextChatClearMessagesBtn');
const contextDeleteConversationBtn = $('#contextDeleteConversationBtn');
const messageContextMenu = $('#messageContextMenu');
const contextDeleteMessageBtn = $('#contextDeleteMessageBtn');
const contextEditMessageBtn = $('#contextEditMessageBtn');
const groupMembersBtn = $('#groupMembersBtn');
const groupMemberModal = $('#groupMemberModal');
const closeGroupMemberModalBtn = $('#closeGroupMemberModalBtn');
const groupMemberTitle = $('#groupMemberTitle');
const groupMemberSummary = $('#groupMemberSummary');
const groupMemberListView = $('#groupMemberListView');
const groupAddMemberPanel = $('#groupAddMemberPanel');
const groupAddMemberList = $('#groupAddMemberList');
const addGroupMembersBtn = $('#addGroupMembersBtn');
const tabChat = $('#tabChat');
const tabFriend = $('#tabFriend');
const tabMe = $('#tabMe');
const tabSettings = $('#tabSettings');
const chatListView = $('#chatListView');
const createGroupView = $('#createGroupView');
const chatConversationView = $('#chatConversationView');
const chatConversationList = $('#chatConversationList');
const chatAddBtn = $('#chatAddBtn');
const chatAddMenu = $('#chatAddMenu');
const openCreateGroupBtn = $('#openCreateGroupBtn');
const backToChatFromCreateGroup = $('#backToChatFromCreateGroup');
const backToChatList = $('#backToChatList');
const bottomNav = $('.bottom-nav');
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};
let titleFlashTimer = null;
const originalTitle = document.title;

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

function isPageInactive() {
  return document.hidden || !document.hasFocus();
}

function messagePreview(message) {
  if (message.type === 'image') return '[图片]';
  if (message.type === 'audio') return '[音频]';
  if (message.type === 'video') return '[视频]';
  const text = message.text || '收到一条新消息';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

async function ensureAudioContext() {
  if (!window.AudioContext && !window.webkitAudioContext) return null;
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
  }
  if (state.audioContext.state === 'suspended') {
    await state.audioContext.resume().catch(() => {});
  }
  return state.audioContext;
}

async function playMessageSound() {
  const audioContext = await ensureAudioContext();
  if (!audioContext || audioContext.state !== 'running') return;

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
  oscillator.frequency.setValueAtTime(660, audioContext.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.3);
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  if (state.notificationPermissionRequested) return Notification.permission;
  state.notificationPermissionRequested = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'default') state.notificationPermissionRequested = false;
    updateNotificationButton();
    return permission;
  } catch {
    // 浏览器可能要求在用户手势内申请权限，失败时等待下一次用户交互。
    state.notificationPermissionRequested = false;
    updateNotificationButton();
    return Notification.permission;
  }
}

async function prepareMessageNotifications(showResult = false) {
  await ensureAudioContext();
  const permission = await requestNotificationPermission();
  updateNotificationButton();
  if (!showResult) return permission;
  if (permission === 'granted') {
    await playMessageSound();
    toast('新消息提醒已开启');
  } else if (permission === 'denied') {
    toast('浏览器通知已被拒绝，请在浏览器网站权限中重新允许通知', true);
  } else if (permission === 'unsupported') {
    toast('当前浏览器不支持系统通知，将仅保留页面未读提醒', true);
  } else {
    toast('请在浏览器弹出的权限窗口中允许通知');
  }
  return permission;
}

function updateNotificationButton() {
  if (!notificationBtn) return;
  notificationBtn.classList.remove('enabled', 'blocked');
  if (!('Notification' in window)) {
    notificationBtn.textContent = '不支持提醒';
    notificationBtn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    notificationBtn.textContent = '提醒已开';
    notificationBtn.classList.add('enabled');
    notificationBtn.disabled = false;
    return;
  }
  if (Notification.permission === 'denied') {
    notificationBtn.textContent = '提醒被拒';
    notificationBtn.classList.add('blocked');
    notificationBtn.disabled = false;
    return;
  }
  notificationBtn.textContent = '开启提醒';
  notificationBtn.disabled = false;
}

function flashDocumentTitle(friend, message) {
  const unreadCount = state.unreadFriendIds.size;
  const sender = friend?.name || friend?.displayName || friend?.username || '好友';
  document.title = `(${unreadCount}) ${sender}: ${messagePreview(message)}`;
  if (titleFlashTimer) clearTimeout(titleFlashTimer);
  titleFlashTimer = setTimeout(() => {
    document.title = unreadCount ? `(${unreadCount}) ${originalTitle}` : originalTitle;
  }, 3000);
}

function showBrowserMessageNotification(friend, message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = friend?.isGroup
    ? `群聊「${friend.name}」有新消息`
    : `来自 ${friend?.displayName || friend?.username || '好友'} 的新消息`;
  const notification = new Notification(title, {
    body: messagePreview(message),
    tag: `message:${message.id}`,
    renotify: false
  });
  notification.onclick = () => {
    window.focus();
    if (friend?.isGroup) selectGroup(friend);
    else if (friend) selectFriend(friend);
    notification.close();
  };
}

function notifyIncomingMessage(conversationId, message) {
  const friend = conversationId.startsWith('group:')
    ? { ...state.groupsx.find(item => item.id === conversationId.slice(6)), isGroup: true }
    : state.friends.find(item => item.id === conversationId);
  playMessageSound();
  showBrowserMessageNotification(friend, message);
  flashDocumentTitle(friend, message);
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
  el.innerHTML = '';
  if (user?.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.alt = `${user.displayName || user.username || '用户'}的头像`;
    img.loading = 'lazy';
    el.appendChild(img);
    el.style.background = '#f8fafc';
    el.classList.add('image-avatar');
    return;
  }
  el.textContent = initials(user);
  el.style.background = user?.avatarColor || '#4f46e5';
  el.classList.remove('image-avatar');
}

function switchTab(tab) {
  state.currentTab = tab;
  [tabChat, tabFriend, tabMe, tabSettings].forEach(el => el.classList.add('hidden'));
  if (tab === 'chat') {
    tabChat.classList.remove('hidden');
    if (state.selectedFriend) {
      chatListView.classList.add('hidden');
      createGroupView.classList.add('hidden');
      chatConversationView.classList.remove('hidden');
    } else {
      chatListView.classList.remove('hidden');
      createGroupView.classList.add('hidden');
      chatConversationView.classList.add('hidden');
      renderChatList();
    }
  }
  if (tab === 'friend') tabFriend.classList.remove('hidden');
  if (tab === 'me') tabMe.classList.remove('hidden');
  if (tab === 'settings') tabSettings.classList.remove('hidden');
  bottomNav.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

function showChat() {
  authView.classList.add('hidden');
  chatView.classList.remove('hidden');
  switchTab(state.currentTab);
  updateNotificationButton();
}

function showAuth() {
  chatView.classList.add('hidden');
  authView.classList.remove('hidden');
}

function clearLocalUserData() {
  localStorage.removeItem('token');
  state.token = null;
  state.me = null;
  state.friends = [];
  state.groupsx = [];
  state.requests = [];
  state.selectedFriend = null;
  state.messages = [];
  state.unreadFriendIds.clear();
  state.friendResponses = [];
  state.contextFriendId = null;
  state.contextGroupId = null;
  state.contextMessageId = null;
  state.editingMessageId = null;
  state.notificationPermissionRequested = false;
  state.currentTab = 'chat';
  state.deletedConversations.clear();
  document.title = originalTitle;

  authForm.reset();
  authTip.textContent = '';
  $('#myName').textContent = '未登录';
  $('#myUsername').textContent = '';
  setAvatar($('#myAvatar'), null);
  profileForm.classList.add('hidden');
  profileDisplayName.value = '';
  profileAvatarInput.value = '';
  profileAvatarFilename.textContent = '未选择文件';
  searchResults.innerHTML = '';
  searchResults.className = 'list compact';
  $('#searchInput').value = '';
  groupNameInput.value = '';
  createGroupView.classList.add('hidden');
  chatConversationView.classList.add('hidden');
  chatListView.classList.remove('hidden');
  renderChatList();
  renderFriends();
  renderGroupMembers();
  renderGroups();
  renderRequests();
  renderFriendResponses();
  hideFriendContextMenu();
  hideChatAddMenu();
  hideMessageContextMenu();
  resetConversation();
}

async function loadConfig() {
  const data = await api('/api/config');
  state.callsEnabled = Boolean(data.features?.callsEnabled);
  document.body.classList.toggle('calls-disabled', !state.callsEnabled);
}

async function boot() {
  await loadConfig();
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    await loadMe();
    connectSocket();
    showChat();
  } catch {
    clearLocalUserData();
    showAuth();
  }
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user;
  state.friends = data.friends;
  state.groupsx = data.groupsx || [];
  state.requests = data.requests;
  $('#myName').textContent = state.me.displayName;
  $('#myUsername').textContent = `@${state.me.username}`;
  setAvatar($('#myAvatar'), state.me);
  profileDisplayName.value = state.me.displayName;
  renderChatList();
  renderFriends();
  renderGroupMembers();
  renderGroups();
  renderRequests();
  renderFriendResponses();
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('message:new', message => {
    const isGroupMessage = Boolean(message.groupId);
    const conversationId = isGroupMessage ? `group:${message.groupId}` : (message.from === state.me.id ? message.to : message.from);
    const isCurrentConversation = selectedConversationKey() === conversationId;
    const isIncoming = message.from !== state.me.id;
    const shouldNotify = isIncoming && isPageInactive();

    if (isCurrentConversation) {
      if (!state.messages.some(item => item.id === message.id)) state.messages.push(message);
      renderMessages();
      if (shouldNotify) {
        state.unreadFriendIds.add(conversationId);
        renderChatList();
        notifyIncomingMessage(conversationId, message);
      } else if (isIncoming) {
        state.unreadFriendIds.delete(conversationId);
        renderChatList();
        if (!isGroupMessage) markSelectedConversationRead();
      }
      return;
    }

    if (isIncoming) {
      state.unreadFriendIds.add(conversationId);
      renderChatList();
      if (shouldNotify) {
        notifyIncomingMessage(conversationId, message);
      } else {
        toast(isGroupMessage ? '收到新的群聊消息' : '收到新的好友消息');
      }
    }
  });

  state.socket.on('message:read', handleReadReceipt);
  state.socket.on('message:deleted', handleMessageDeleted);
  state.socket.on('message:edited', handleMessageEdited);
  state.socket.on('message:error', payload => toast(payload.message, true));
  state.socket.on('friend:request', async () => {
    await loadMe();
    toast('收到新的好友请求');
  });
  state.socket.on('friend:updated', async payload => {
    await loadMe();
    handleFriendResponse(payload);
  });
  state.socket.on('friend:removed', handleFriendRemoved);
  state.socket.on('conversation:cleared', handleConversationCleared);
  state.socket.on('group:updated', handleGroupUpdated);
  state.socket.on('group:dissolved', handleGroupDissolved);
  state.socket.on('group:messages-cleared', handleGroupMessagesCleared);
  state.socket.on('group:member-removed', handleGroupMemberRemoved);
  state.socket.on('profile:updated', payload => {
    state.me = payload.user;
    $('#myName').textContent = state.me.displayName;
    setAvatar($('#myAvatar'), state.me);
    profileDisplayName.value = state.me.displayName;
    syncUserProfile(payload.user);
  });
  state.socket.on('friend:profile-updated', payload => {
    syncUserProfile(payload.user);
  });
  state.socket.on('presence:update', ({ userId, online }) => {
    const friend = state.friends.find(item => item.id === userId);
    if (friend) friend.online = online;
    if (!state.selectedFriend?.isGroup && state.selectedFriend?.id === userId) state.selectedFriend.online = online;
    renderChatList();
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
    await loadConfig();
    await loadMe();
    connectSocket();
    showChat();
    authForm.reset();
  } catch (error) {
    toast(error.message, true);
  }
});

document.addEventListener('pointerdown', () => {
  if (state.token) ensureAudioContext();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    document.title = state.unreadFriendIds.size ? `(${state.unreadFriendIds.size}) ${originalTitle}` : originalTitle;
    if (state.selectedFriend && state.unreadFriendIds.has(selectedConversationKey())) {
      state.unreadFriendIds.delete(selectedConversationKey());
      renderChatList();
      if (!state.selectedFriend.isGroup) markSelectedConversationRead();
    }
  }
});

notificationBtn?.addEventListener('click', () => {
  prepareMessageNotifications(true);
});

loginTab.addEventListener('click', () => setMode('login'));
registerTab.addEventListener('click', () => setMode('register'));

bottomNav?.addEventListener('click', event => {
  const btn = event.target.closest('.nav-item');
  if (!btn) return;
  hideChatAddMenu();
  switchTab(btn.dataset.tab);
});

backToChatList?.addEventListener('click', () => {
  chatConversationView.classList.add('hidden');
  createGroupView.classList.add('hidden');
  chatListView.classList.remove('hidden');
  state.selectedFriend = null;
  renderChatList();
});

chatAddBtn?.addEventListener('click', event => {
  event.stopPropagation();
  chatAddMenu.classList.toggle('hidden');
});

openCreateGroupBtn?.addEventListener('click', () => {
  hideChatAddMenu();
  openCreateGroupPage();
});

backToChatFromCreateGroup?.addEventListener('click', () => {
  closeCreateGroupPage();
});

editProfileBtn.addEventListener('click', () => {
  profileDisplayName.value = state.me?.displayName || '';
  profileForm.classList.remove('hidden');
});

cancelProfileBtn.addEventListener('click', () => {
  profileForm.classList.add('hidden');
  profileAvatarInput.value = '';
  profileAvatarFilename.textContent = '未选择文件';
});

profileAvatarButton.addEventListener('click', () => {
  profileAvatarInput.click();
});

profileAvatarInput.addEventListener('change', () => {
  profileAvatarFilename.textContent = profileAvatarInput.files[0]?.name || '未选择文件';
});

profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  const displayName = profileDisplayName.value.trim();
  if (!displayName) {
    toast('昵称不能为空', true);
    return;
  }

  try {
    let avatarUrl = state.me.avatarUrl || '';
    const avatarFile = profileAvatarInput.files[0];
    if (avatarFile) {
      const fd = new FormData();
      fd.append('file', avatarFile);
      const uploaded = await api('/api/upload', { method: 'POST', body: fd });
      if (uploaded.type !== 'image') throw new Error('头像只能使用图片文件');
      avatarUrl = uploaded.url;
    }

    const data = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName, avatarUrl })
    });
    state.me = data.user;
    $('#myName').textContent = state.me.displayName;
    setAvatar($('#myAvatar'), state.me);
    syncUserProfile(data.user);
    profileForm.classList.add('hidden');
    profileAvatarInput.value = '';
    profileAvatarFilename.textContent = '未选择文件';
    toast(data.message);
  } catch (error) {
    toast(error.message, true);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  const socket = state.socket;
  if (socket?.connected) {
    try {
      await socket.timeout(1000).emitWithAck('auth:logout');
    } catch {
      // 即使退出通知超时，也继续清理本地登录态。
    }
  }
  endCall(false);
  if (socket) socket.disconnect();
  state.socket = null;
  clearLocalUserData();
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

function conversationKey(conversation) {
  if (!conversation) return '';
  return conversation.isGroup ? `group:${conversation.id}` : conversation.id;
}

function hideChatAddMenu() {
  chatAddMenu?.classList.add('hidden');
}

function openCreateGroupPage() {
  state.selectedFriend = null;
  resetMessageEditor();
  messageInput.disabled = true;
  fileInput.disabled = true;
  sendBtn.disabled = true;
  chatConversationView.classList.add('hidden');
  chatListView.classList.add('hidden');
  createGroupView.classList.remove('hidden');
  groupNameInput.focus();
  renderGroupMembers();
}

function closeCreateGroupPage() {
  createGroupView.classList.add('hidden');
  chatConversationView.classList.add('hidden');
  chatListView.classList.remove('hidden');
  renderChatList();
}

async function openConversationFromFriendTab(conversation) {
  hideFriendContextMenu();
  hideChatAddMenu();
  const key = conversationKey(conversation);
  state.deletedConversations.delete(key);
  switchTab('chat');
  if (conversation.isGroup) await selectGroup(conversation);
  else await selectFriend(conversation);
}

function selectedConversationKey() {
  return conversationKey(state.selectedFriend);
}

function syncUserProfile(user) {
  if (!user?.id) return;
  const friend = state.friends.find(item => item.id === user.id);
  if (friend) Object.assign(friend, user);

  state.groupsx.forEach(group => {
    const member = group.members?.find(item => item.id === user.id);
    if (member) Object.assign(member, user);
  });

  if (!state.selectedFriend?.isGroup && state.selectedFriend?.id === user.id) {
    state.selectedFriend = { ...state.selectedFriend, ...user };
    updateChatHeader();
  }

  if (state.selectedFriend?.isGroup) {
    const member = state.selectedFriend.members?.find(item => item.id === user.id);
    if (member) Object.assign(member, user);
    updateChatHeader();
  }

  renderChatList();
  renderFriends();
  renderGroupMembers();
  renderGroups();
  renderMessages();
}

function groupItem(group) {
  const item = document.createElement('div');
  item.className = 'user-item group-item';
  const avatar = document.createElement('div');
  avatar.className = 'avatar small';
  avatar.textContent = '群';
  const meta = document.createElement('div');
  meta.className = 'user-meta';
  const strong = document.createElement('strong');
  strong.textContent = group.name;
  const span = document.createElement('span');
  span.textContent = `${group.memberCount || group.members?.length || 0} 人 · ${group.ownerId === state.me?.id ? '我是群主' : '群聊'}`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  meta.append(strong, span);
  item.append(avatar, meta, actions);
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

function renderFriendResponses() {
  friendResponseList.innerHTML = '';
  if (!state.friendResponses.length) {
    friendResponseList.textContent = '暂无处理结果';
    friendResponseList.classList.add('empty');
    return;
  }
  friendResponseList.classList.remove('empty');
  state.friendResponses.forEach(response => {
    const item = document.createElement('div');
    item.className = `response-item ${response.accepted ? 'accepted' : 'rejected'}`;
    item.textContent = `${response.message} · ${new Date(response.createdAt).toLocaleTimeString()}`;
    friendResponseList.appendChild(item);
  });
}

function handleFriendResponse(payload) {
  const message = payload?.message || (payload?.accepted ? '好友请求已通过' : '好友请求已被拒绝');
  const response = {
    requestId: payload?.requestId || `${Date.now()}`,
    accepted: Boolean(payload?.accepted),
    role: payload?.role,
    message,
    createdAt: new Date().toISOString()
  };
  state.friendResponses = [response, ...state.friendResponses.filter(item => item.requestId !== response.requestId)].slice(0, 5);
  renderFriendResponses();
  renderChatList();
  renderFriends();
  toast(message, !response.accepted && response.role === 'requester');
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
    item.classList.toggle('has-unread', state.unreadFriendIds.has(friend.id));
    item.title = '左键聊天，右键打开更多操作';
    item.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showFriendContextMenu(event, friend);
    });
    item.classList.toggle('active', !state.selectedFriend?.isGroup && state.selectedFriend?.id === friend.id);
    item.addEventListener('click', () => openConversationFromFriendTab(friend));
    friendList.appendChild(item);
  });
}

function renderGroupMembers() {
  groupMemberList.innerHTML = '';
  if (!state.friends.length) {
    groupMemberList.textContent = '暂无可选好友';
    groupMemberList.classList.add('empty');
    return;
  }
  groupMemberList.classList.remove('empty');
  state.friends.forEach(friend => {
    const label = document.createElement('label');
    label.className = 'group-member-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.id;
    const span = document.createElement('span');
    span.textContent = `${friend.displayName}（@${friend.username}）`;
    label.append(checkbox, span);
    groupMemberList.appendChild(label);
  });
}

function renderGroups() {
  groupList.innerHTML = '';
  hideFriendContextMenu();
  if (!state.groupsx.length) {
    groupList.textContent = '暂无群聊';
    groupList.classList.add('empty');
    return;
  }
  groupList.classList.remove('empty');
  state.groupsx.forEach(group => {
    const conversation = { ...group, isGroup: true };
    const item = groupItem(group);
    item.classList.toggle('has-unread', state.unreadFriendIds.has(conversationKey(conversation)));
    item.classList.toggle('active', selectedConversationKey() === conversationKey(conversation));
    item.title = '左键聊天，右键打开更多操作';
    item.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showFriendContextMenu(event, conversation);
    });
    item.addEventListener('click', () => openConversationFromFriendTab({ ...group, isGroup: true }));
    groupList.appendChild(item);
  });
}

function renderChatList() {
  chatConversationList.innerHTML = '';
  hideChatContextMenu();
  const allConversations = [
    ...state.friends.map(f => ({ ...f, isGroup: false, sortKey: f.displayName })),
    ...state.groupsx.map(g => ({ ...g, isGroup: true, sortKey: g.name }))
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  if (!allConversations.length) {
    chatConversationList.textContent = '暂无聊天';
    chatConversationList.classList.add('empty');
    return;
  }
  chatConversationList.classList.remove('empty');
  const visibleConversations = allConversations.filter(conv => !state.deletedConversations.has(conversationKey(conv)));
  if (!visibleConversations.length) {
    chatConversationList.textContent = '暂无聊天';
    chatConversationList.classList.add('empty');
    return;
  }
  visibleConversations
    .forEach(conv => {
      const item = conv.isGroup ? groupItem(conv) : userItem(conv);
      const key = conversationKey(conv);
      item.classList.toggle('has-unread', state.unreadFriendIds.has(key));
      item.classList.toggle('active', selectedConversationKey() === key);
      item.title = '左键聊天，右键打开更多操作';
      item.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        showChatContextMenu(event, conv);
      });
      item.addEventListener('click', () => {
        if (conv.isGroup) selectGroup(conv);
        else selectFriend(conv);
      });
      chatConversationList.appendChild(item);
    });
}

createGroupBtn?.addEventListener('click', createGroup);
groupMembersBtn?.addEventListener('click', openGroupMemberModal);
closeGroupMemberModalBtn?.addEventListener('click', closeGroupMemberModal);
groupMemberModal?.addEventListener('click', event => {
  if (event.target === groupMemberModal) closeGroupMemberModal();
});
addGroupMembersBtn?.addEventListener('click', addSelectedGroupMembers);

async function createGroup() {
  const name = groupNameInput.value.trim();
  const memberIds = [...groupMemberList.querySelectorAll('input[type="checkbox"]:checked')].map(item => item.value);
  if (!name) {
    toast('请输入群聊名称', true);
    return;
  }
  if (!memberIds.length) {
    toast('请至少选择 1 位好友', true);
    return;
  }
  try {
    const data = await api('/api/groupsx', {
      method: 'POST',
      body: JSON.stringify({ name, memberIds })
    });
    toast(data.message);
    groupNameInput.value = '';
    groupMemberList.querySelectorAll('input[type="checkbox"]').forEach(item => {
      item.checked = false;
    });
    await loadMe();
    closeCreateGroupPage();
  } catch (error) {
    toast(error.message, true);
  }
}

function upsertGroup(group) {
  if (!group?.id) return;
  const index = state.groupsx.findIndex(item => item.id === group.id);
  if (index === -1) state.groupsx.push(group);
  else state.groupsx[index] = group;
  if (state.selectedFriend?.isGroup && state.selectedFriend.id === group.id) {
    state.selectedFriend = { ...group, isGroup: true };
    updateChatHeader();
  }
}

async function openGroupMemberModal() {
  if (!state.selectedFriend?.isGroup) return;
  try {
    const data = await api(`/api/groupsx/${state.selectedFriend.id}/members`);
    upsertGroup(data.group);
    renderGroupMemberModal(data.group);
    groupMemberModal.classList.remove('hidden');
  } catch (error) {
    toast(error.message, true);
  }
}

function closeGroupMemberModal() {
  groupMemberModal?.classList.add('hidden');
}

function renderGroupMemberModal(group) {
  const isOwner = group.ownerId === state.me?.id;
  const memberIds = new Set(group.members.map(member => member.id));
  groupMemberTitle.textContent = group.name;
  groupMemberSummary.textContent = `${group.members.length} 位成员${isOwner ? ' · 你是群主，可添加或移除成员' : ''}`;

  groupMemberListView.innerHTML = '';
  groupMemberListView.classList.toggle('empty', !group.members.length);
  if (!group.members.length) {
    groupMemberListView.textContent = '暂无成员';
  } else {
    group.members.forEach(member => {
      const item = userItem(member);
      item.classList.add('group-member-row');
      const actions = item.querySelector('.actions');
      const role = document.createElement('button');
      role.type = 'button';
      role.disabled = true;
      role.textContent = member.id === group.ownerId ? '群主' : '成员';
      actions.appendChild(role);
      if (isOwner && member.id !== group.ownerId) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'reject';
        removeBtn.textContent = '移除';
        removeBtn.addEventListener('click', () => removeGroupMember(group.id, member.id, member.displayName));
        actions.appendChild(removeBtn);
      }
      groupMemberListView.appendChild(item);
    });
  }

  groupAddMemberPanel.classList.toggle('hidden', !isOwner);
  groupAddMemberList.innerHTML = '';
  const candidates = state.friends.filter(friend => !memberIds.has(friend.id));
  groupAddMemberList.classList.toggle('empty', !candidates.length);
  addGroupMembersBtn.disabled = !candidates.length;
  if (!candidates.length) {
    groupAddMemberList.textContent = '暂无可添加好友';
    return;
  }
  candidates.forEach(friend => {
    const label = document.createElement('label');
    label.className = 'group-member-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.id;
    const span = document.createElement('span');
    span.textContent = `${friend.displayName}（@${friend.username}）`;
    label.append(checkbox, span);
    groupAddMemberList.appendChild(label);
  });
}

async function addSelectedGroupMembers() {
  if (!state.selectedFriend?.isGroup) return;
  const memberIds = [...groupAddMemberList.querySelectorAll('input[type="checkbox"]:checked')].map(item => item.value);
  if (!memberIds.length) {
    toast('请选择要添加的好友', true);
    return;
  }
  try {
    const data = await api(`/api/groupsx/${state.selectedFriend.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds })
    });
    upsertGroup(data.group);
    renderChatList();
    renderGroups();
    renderGroupMemberModal(data.group);
    toast(data.message);
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeGroupMember(groupId, memberId, displayName) {
  if (!confirm(`确定将「${displayName}」移出群聊吗？`)) return;
  try {
    const data = await api(`/api/groupsx/${groupId}/members/${memberId}`, { method: 'DELETE' });
    upsertGroup(data.group);
    renderChatList();
    renderGroups();
    renderGroupMemberModal(data.group);
    toast(data.message);
  } catch (error) {
    toast(error.message, true);
  }
}

function showFriendContextMenu(event, friend) {
  hideMessageContextMenu();
  hideChatContextMenu();
  state.contextFriendId = friend.isGroup ? null : friend.id;
  state.contextGroupId = friend.isGroup ? friend.id : null;
  contextDeleteFriendBtn.textContent = friend.isGroup ? '解散群聊' : '删除好友';
  contextDeleteFriendBtn.disabled = friend.isGroup && friend.ownerId !== state.me?.id;
  contextDeleteFriendBtn.title = contextDeleteFriendBtn.disabled ? '只有群主可以解散群聊' : '';
  friendContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  friendContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 110)}px`;
  friendContextMenu.classList.remove('hidden');
}

function hideFriendContextMenu() {
  state.contextFriendId = null;
  state.contextGroupId = null;
  contextDeleteFriendBtn.textContent = '删除好友';
  contextDeleteFriendBtn.disabled = false;
  contextDeleteFriendBtn.title = '';
  friendContextMenu?.classList.add('hidden');
}

function showChatContextMenu(event, conv) {
  hideFriendContextMenu();
  hideMessageContextMenu();
  state.contextFriendId = conv.isGroup ? null : conv.id;
  state.contextGroupId = conv.isGroup ? conv.id : null;
  contextChatClearMessagesBtn.textContent = conv.isGroup ? '清空群聊记录' : '清空聊天记录';
  chatContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  chatContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 110)}px`;
  chatContextMenu.classList.remove('hidden');
}

function hideChatContextMenu() {
  state.contextFriendId = null;
  state.contextGroupId = null;
  contextChatClearMessagesBtn.textContent = '清空聊天记录';
  chatContextMenu?.classList.add('hidden');
}

function showMessageContextMenu(event, message) {
  hideFriendContextMenu();
  hideChatContextMenu();
  state.contextMessageId = message.id;
  contextEditMessageBtn.disabled = message.type !== 'text';
  contextEditMessageBtn.title = message.type === 'text' ? '' : '只能编辑文本消息';
  messageContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 170)}px`;
  messageContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 110)}px`;
  messageContextMenu.classList.remove('hidden');
}

function hideMessageContextMenu() {
  state.contextMessageId = null;
  messageContextMenu?.classList.add('hidden');
}

contextDeleteFriendBtn.addEventListener('click', () => {
  const friendId = state.contextFriendId;
  const groupId = state.contextGroupId;
  hideFriendContextMenu();
  if (groupId) dissolveGroup(groupId);
  if (friendId) deleteFriend(friendId);
});

contextChatClearMessagesBtn.addEventListener('click', () => {
  const friendId = state.contextFriendId;
  const groupId = state.contextGroupId;
  hideChatContextMenu();
  if (groupId) clearGroupMessages(groupId);
  if (friendId) clearFriendMessages(friendId);
});

contextDeleteConversationBtn.addEventListener('click', () => {
  const friendId = state.contextFriendId;
  const groupId = state.contextGroupId;
  const convId = groupId ? `group:${groupId}` : friendId;
  hideChatContextMenu();
  state.deletedConversations.add(convId);
  state.unreadFriendIds.delete(convId);
  if (state.selectedFriend && selectedConversationKey() === convId) {
    resetConversation();
  }
  renderChatList();
});

contextDeleteMessageBtn.addEventListener('click', () => {
  const messageId = state.contextMessageId;
  hideMessageContextMenu();
  if (messageId) deleteMessage(messageId);
});

contextEditMessageBtn.addEventListener('click', () => {
  const messageId = state.contextMessageId;
  hideMessageContextMenu();
  if (messageId) startEditMessage(messageId);
});

document.addEventListener('click', event => {
  if (!chatAddMenu?.contains(event.target) && event.target !== chatAddBtn) hideChatAddMenu();
  if (!friendContextMenu.contains(event.target)) hideFriendContextMenu();
  if (!chatContextMenu.contains(event.target)) hideChatContextMenu();
  if (!messageContextMenu.contains(event.target)) hideMessageContextMenu();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideChatAddMenu();
    hideFriendContextMenu();
    hideChatContextMenu();
    hideMessageContextMenu();
    closeGroupMemberModal();
    if (state.editingMessageId) {
      messageInput.value = '';
      resetMessageEditor();
      toast('已取消编辑');
    }
  }
});

window.addEventListener('scroll', () => {
  hideChatAddMenu();
  hideFriendContextMenu();
  hideChatContextMenu();
  hideMessageContextMenu();
}, true);

function resetConversation(message = '请选择好友开始聊天', status = '好友上线后可实时收发消息') {
  state.selectedFriend = null;
  state.messages = [];
  resetMessageEditor();
  messageInput.value = '';
  messageInput.disabled = true;
  fileInput.disabled = true;
  sendBtn.disabled = true;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  groupMembersBtn.classList.add('hidden');
  closeGroupMemberModal();
  chatConversationView.classList.add('hidden');
  createGroupView.classList.add('hidden');
  chatListView.classList.remove('hidden');
  renderChatList();
  $('#chatTitle').textContent = message;
  $('#chatStatus').textContent = status;
  messagesEl.innerHTML = '<div class="welcome"><h3>请选择好友</h3><p>从聊天列表选择一个好友或群聊开始聊天。</p></div>';
}

async function deleteFriend(friendId) {
  const friend = state.friends.find(item => item.id === friendId);
  if (!friend) return;
  if (!confirm(`确定删除好友「${friend.displayName}」吗？双方会话消息也会被清理。`)) return;

  try {
    const data = await api(`/api/friends/${friendId}`, { method: 'DELETE' });
    toast(data.message);
    await loadMe();
    if (!state.selectedFriend?.isGroup && state.selectedFriend?.id === friendId) {
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
    if (!state.selectedFriend?.isGroup && state.selectedFriend?.id === friendId) {
      state.messages = [];
      renderMessages();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function clearGroupMessages(groupId) {
  const group = state.groupsx.find(item => item.id === groupId);
  if (!group) return;
  if (!confirm(`确定一键清空群聊「${group.name}」的全部聊天记录吗？所有群成员都会看到记录被清空。`)) return;

  try {
    const data = await api(`/api/groupsx/${groupId}/messages`, { method: 'DELETE' });
    toast(data.message);
    if (state.selectedFriend?.isGroup && state.selectedFriend.id === groupId) {
      state.messages = [];
      renderMessages();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function dissolveGroup(groupId) {
  const group = state.groupsx.find(item => item.id === groupId);
  if (!group) return;
  if (group.ownerId !== state.me?.id) {
    toast('只有群主可以解散群聊', true);
    return;
  }
  if (!confirm(`确定解散群聊「${group.name}」吗？群聊消息会全部清空且不可恢复。`)) return;

  try {
    const data = await api(`/api/groupsx/${groupId}`, { method: 'DELETE' });
    toast(data.message);
    await loadMe();
    if (state.selectedFriend?.isGroup && state.selectedFriend.id === groupId) {
      resetConversation('群聊已解散', '该群聊消息已全部清空');
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function handleFriendRemoved(payload) {
  await loadMe();
  if (!state.selectedFriend?.isGroup && [payload.userId, payload.friendId].includes(state.selectedFriend?.id)) {
    resetConversation('好友关系已解除', '该会话已不可用');
  }
  toast('好友列表已更新');
}

function handleConversationCleared(payload) {
  if (!state.selectedFriend?.isGroup && [payload.userId, payload.friendId].includes(state.selectedFriend?.id)) {
    state.messages = [];
    resetMessageEditor();
    renderMessages();
    toast('聊天记录已清空');
  }
}

async function handleGroupUpdated(payload) {
  await loadMe();
  const group = payload?.group;
  if (group) {
    upsertGroup(group);
    renderChatList();
    renderGroups();
    if (!groupMemberModal.classList.contains('hidden') && state.selectedFriend?.isGroup && state.selectedFriend.id === group.id) {
      renderGroupMemberModal(group);
    }
  }
  toast('群聊列表已更新');
}

async function handleGroupDissolved(payload) {
  await loadMe();
  state.unreadFriendIds.delete(`group:${payload.groupId}`);
  if (state.selectedFriend?.isGroup && state.selectedFriend.id === payload.groupId) {
    closeGroupMemberModal();
    resetConversation('群聊已解散', '该群聊消息已全部清空');
  }
  toast(`群聊「${payload.groupName || ''}」已解散`);
}

async function handleGroupMemberRemoved(payload) {
  await loadMe();
  state.unreadFriendIds.delete(`group:${payload.groupId}`);
  if (state.selectedFriend?.isGroup && state.selectedFriend.id === payload.groupId) {
    closeGroupMemberModal();
    resetConversation('你已被移出群聊', '该群聊已不可用');
  }
  toast(`你已被移出群聊「${payload.groupName || ''}」`, true);
}

function handleGroupMessagesCleared(payload) {
  if (state.selectedFriend?.isGroup && state.selectedFriend.id === payload.groupId) {
    state.messages = [];
    resetMessageEditor();
    renderMessages();
    toast('群聊记录已清空');
  }
}

async function selectFriend(friend) {
  resetMessageEditor();
  closeGroupMemberModal();
  state.selectedFriend = { ...friend, isGroup: false };
  state.unreadFriendIds.delete(conversationKey(state.selectedFriend));
  state.messages = await api(`/api/messages/${friend.id}`);
  messageInput.disabled = false;
  fileInput.disabled = false;
  sendBtn.disabled = false;
  voiceCallBtn.disabled = !state.callsEnabled || !friend.online;
  videoCallBtn.disabled = !state.callsEnabled || !friend.online;
  updateChatHeader();
  chatListView.classList.add('hidden');
  createGroupView.classList.add('hidden');
  chatConversationView.classList.remove('hidden');
  renderChatList();
  renderMessages();
  markSelectedConversationRead();
}

async function selectGroup(group) {
  resetMessageEditor();
  state.selectedFriend = { ...group, isGroup: true };
  state.unreadFriendIds.delete(conversationKey(state.selectedFriend));
  state.messages = await api(`/api/groupsx/${group.id}/messages`);
  messageInput.disabled = false;
  fileInput.disabled = false;
  sendBtn.disabled = false;
  voiceCallBtn.disabled = true;
  videoCallBtn.disabled = true;
  updateChatHeader();
  chatListView.classList.add('hidden');
  createGroupView.classList.add('hidden');
  chatConversationView.classList.remove('hidden');
  renderChatList();
  renderMessages();
}

function updateChatHeader() {
  if (!state.selectedFriend) return;
  if (state.selectedFriend.isGroup) {
    $('#chatTitle').textContent = state.selectedFriend.name;
    $('#chatStatus').textContent = `${state.selectedFriend.memberCount || state.selectedFriend.members?.length || 0} 人群聊`;
    groupMembersBtn.classList.remove('hidden');
    voiceCallBtn.classList.add('hidden');
    videoCallBtn.classList.add('hidden');
    voiceCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    return;
  }
  groupMembersBtn.classList.add('hidden');
  voiceCallBtn.classList.remove('hidden');
  videoCallBtn.classList.remove('hidden');
  $('#chatTitle').textContent = state.selectedFriend.displayName;
  $('#chatStatus').textContent = state.selectedFriend.online
    ? (state.callsEnabled ? '在线，可发起语音或视频通话' : '在线')
    : '离线，消息会保存在聊天记录中';
  voiceCallBtn.disabled = !state.callsEnabled || !state.selectedFriend.online || Boolean(state.call);
  videoCallBtn.disabled = !state.callsEnabled || !state.selectedFriend.online || Boolean(state.call);
}

function renderMessages() {
  messagesEl.innerHTML = '';
  hideMessageContextMenu();
  if (!state.messages.length) {
    messagesEl.innerHTML = '<div class="welcome"><h3>还没有消息</h3><p>发送一条文本或媒体消息开始聊天。</p></div>';
    return;
  }
  state.messages.forEach(message => {
    const wrap = document.createElement('div');
    const mine = message.from === state.me.id;
    wrap.className = `message ${mine ? 'mine' : ''}`;
    if (mine) {
      wrap.title = '右键打开更多操作';
      wrap.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        showMessageContextMenu(event, message);
      });
    }
    const avatar = document.createElement('div');
    avatar.className = 'avatar message-avatar';
    const sender = mine
      ? state.me
      : (state.selectedFriend?.isGroup
        ? state.selectedFriend.members?.find(member => member.id === message.from)
        : state.selectedFriend);
    setAvatar(avatar, sender);
    const content = document.createElement('div');
    content.className = 'message-content';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.appendChild(renderMessageBody(message));
    const time = document.createElement('small');
    time.textContent = messageMetaText(message, mine);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.appendChild(time);
    content.append(bubble, meta);
    wrap.append(avatar, content);
    messagesEl.appendChild(wrap);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function messageMetaText(message, mine) {
  const sentAt = new Date(message.createdAt).toLocaleString();
  const edited = message.editedAt ? ' · 已编辑' : '';
  if (state.selectedFriend?.isGroup) {
    const sender = mine ? '我' : (state.selectedFriend.members?.find(member => member.id === message.from)?.displayName || '群成员');
    return `${sender} · ${sentAt}${edited}`;
  }
  if (!mine) return `${sentAt}${edited}`;
  if (!message.readAt) return `${sentAt}${edited} · 未读`;
  return `${sentAt}${edited} · 已读`;
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
  if (state.editingMessageId === payload.messageId) resetMessageEditor();
}

async function handleMessageEdited(payload) {
  const editedMessage = payload?.message;
  if (!editedMessage) return;
  const isGroupMessage = Boolean(editedMessage.groupId);
  const conversationId = isGroupMessage ? `group:${editedMessage.groupId}` : (editedMessage.from === state.me.id ? editedMessage.to : editedMessage.from);
  const isCurrentConversation = selectedConversationKey() === conversationId;

  if (!isCurrentConversation) {
    if (editedMessage.from !== state.me.id) {
      state.unreadFriendIds.add(conversationId);
      renderChatList();
      toast(isGroupMessage ? '群成员更新了一条消息' : '好友更新了一条消息');
    }
    return;
  }

  const index = state.messages.findIndex(message => message.id === editedMessage.id);
  if (index !== -1) {
    state.messages[index] = editedMessage;
    renderMessages();
    return;
  }

  try {
    state.messages = isGroupMessage
      ? await api(`/api/groupsx/${editedMessage.groupId}/messages`)
      : await api(`/api/messages/${conversationId}`);
    renderMessages();
  } catch (error) {
    toast(error.message, true);
  }
}

function startEditMessage(messageId) {
  const message = state.messages.find(item => item.id === messageId);
  if (!message) {
    toast('消息不存在或已被删除', true);
    return;
  }
  if (message.from !== state.me.id || message.type !== 'text') {
    toast('只能编辑自己发送的文本消息', true);
    return;
  }
  state.editingMessageId = message.id;
  messageInput.value = message.text;
  messageInput.focus();
  sendBtn.textContent = '保存编辑';
  fileInput.disabled = true;
  toast('正在编辑消息，修改后点击保存编辑');
}

function resetMessageEditor() {
  state.editingMessageId = null;
  sendBtn.textContent = '发送';
  fileInput.disabled = !state.selectedFriend;
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
  if (!state.socket?.connected || !state.selectedFriend || state.selectedFriend.isGroup) return;
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
  if (state.editingMessageId) {
    editMessage(state.editingMessageId, text);
    return;
  }
  state.socket.emit('message:send', {
    ...(state.selectedFriend.isGroup ? { groupId: state.selectedFriend.id } : { to: state.selectedFriend.id }),
    type: 'text',
    text
  });
  messageInput.value = '';
}

function editMessage(messageId, text) {
  if (!state.socket?.connected) {
    toast('当前未连接服务器，无法编辑消息', true);
    return;
  }
  state.socket.timeout(5000).emit('message:edit', { messageId, text }, (error, response) => {
    if (error) {
      toast('编辑消息超时，请检查连接后重试', true);
      return;
    }
    if (!response?.ok) {
      toast(response?.message || '编辑消息失败', true);
      return;
    }
    handleMessageEdited(response);
    messageInput.value = '';
    resetMessageEditor();
    toast('消息已更新');
  });
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
  if (state.selectedFriend.isGroup) return;
  if (!state.callsEnabled) {
    toast('语音和视频聊天功能已关闭', true);
    return;
  }
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
      ...(state.selectedFriend.isGroup ? { groupId: state.selectedFriend.id } : { to: state.selectedFriend.id }),
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
