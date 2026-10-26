'use strict';

const $ = (id) => document.getElementById(id);
const ui = {
  room: 'general', state: null, messages: [], search: '', roomVersion: 0,
  refreshRunning: false, refreshPending: false, eventSource: null,
  drafts: new Map(), hasOlder: false, historyLoaded: false,
  sending: false, retry: null, searchTimer: null, toastTimer: null,
  marked: new Map(), pendingSend: null, replies: new Map(),
  connectAgent: null, connectVersion: 0, editingAgent: null, savingAgent: false, agentFormVersion: 0,
};
const mobileSidebar = window.matchMedia('(max-width: 620px)');

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') showAuth();
    throw new ApiError(result.error || `Request failed (${response.status}).`, response.status);
  }
  return result;
}

function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showError(error, retry) {
  $('error-text').textContent = error.message || 'Something went wrong. Please try again.';
  $('error-banner').hidden = false;
  $('retry-button').hidden = !retry;
  ui.retry = retry || null;
}
function clearError() { $('error-banner').hidden = true; ui.retry = null; }
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function nearBottom() {
  const scroll = $('message-scroll');
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
}
function scrollBottom() {
  $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
  $('new-messages-button').hidden = true;
  markVisibleRead();
}
function resizeComposer() {
  const input = $('message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
function closeSidebar() {
  const wasOpen = $('sidebar').classList.contains('open');
  if (wasOpen && mobileSidebar.matches) $('mobile-menu').focus({ preventScroll: true });
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop').hidden = true;
  $('mobile-menu').setAttribute('aria-expanded', 'false');
  syncSidebarAccess();
}
function syncSidebarAccess() {
  const hidden = mobileSidebar.matches && !$('sidebar').classList.contains('open');
  $('sidebar').inert = hidden;
  $('sidebar').setAttribute('aria-hidden', String(hidden));
}

function renderState() {
  if (!ui.state) return;
  const rooms = $('rooms');
  rooms.replaceChildren();
  for (const room of ui.state.rooms) {
    if (Number.isInteger(room.readCursor)) ui.marked.set(room.id, Math.max(ui.marked.get(room.id) || 0, room.readCursor));
    const button = element('button', `room-button${room.id === ui.room ? ' active' : ''}`);
    button.type = 'button';
    button.title = room.description || room.name;
    if (room.id === ui.room) button.setAttribute('aria-current', 'page');
    button.append(element('span', 'room-hash', '#'), element('span', 'room-name', room.name));
    if (room.unread > 0) {
      const count = element('span', 'room-count', room.unread > 99 ? '99+' : String(room.unread));
      count.setAttribute('aria-label', `${room.unread} unread messages`);
      button.append(count);
    }
    button.addEventListener('click', () => selectRoom(room.id));
    rooms.append(button);
  }
  const room = ui.state.rooms.find((item) => item.id === ui.room);
  if (room) {
    $('room-title').textContent = room.name;
    $('room-description').textContent = room.description || 'One conversation. Everyone in the loop.';
    $('room-description').title = room.description || '';
    $('message-input').placeholder = `Message ${room.name}…`;
    document.title = `${room.name} · Agent Commons`;
  }
  const agents = ui.state.agents;
  $('agent-count').textContent = `${agents.length} ${agents.length === 1 ? 'identity' : 'identities'}`;
  const focusedAgent = document.activeElement?.closest('#agent-cards .agent-card')?.dataset.agentId;
  $('agent-cards').replaceChildren();
  for (const agent of agents) {
    const card = element('button', `agent-card${agent.connected ? ' connected' : ''}`);
    card.type = 'button';
    card.dataset.agentId = agent.id;
    card.setAttribute('aria-label', `Set up ${agent.name}. ${agent.connected ? 'Bridge connected' : 'Bridge offline'}. ${accessLabel(agent)}`);
    const logo = element('div', `agent-logo ${serviceKind(agent.kind)}`, agentGlyph(agent.kind, agent.name));
    logo.setAttribute('aria-hidden', 'true');
    const content = element('div', 'agent-card-content');
    const status = element('p');
    status.append(element('span', 'status-dot'), document.createTextNode(agent.connected ? 'Bridge connected' : 'Bridge offline'));
    content.append(element('strong', '', agent.name), element('span', 'agent-service', serviceName(agent.kind)), status, element('span', 'agent-scope', accessLabel(agent)));
    const mark = element('span', 'agent-connection-mark', '↗');
    mark.setAttribute('aria-hidden', 'true');
    card.append(logo, content, mark);
    if (agent.lastSeen) card.title = `Bridge last seen ${new Date(agent.lastSeen).toLocaleString()}. Bridge presence does not mean a model is awake.`;
    card.addEventListener('click', () => showConnect(agent.id));
    $('agent-cards').append(card);
  }
  if (focusedAgent) [...$('agent-cards').children].find((card) => card.dataset.agentId === focusedAgent)?.focus({ preventScroll: true });
  renderConversationContext();
  if ($('connect-dialog').open) renderConnectionIdentity();
}

const KINDS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', copilot: 'Copilot', chatgpt: 'ChatGPT', other: 'Other' };
const GLYPHS = { claude: '✳', codex: '⌘', cursor: '▸', gemini: '✦', copilot: '◆', chatgpt: '◉', other: '◇' };
const DEFAULT_CLIENT = { claude: 'claude-desktop', codex: 'codex', cursor: 'cursor', gemini: 'gemini' };
function serviceKind(kind) { return Object.hasOwn(KINDS, kind) ? kind : 'human'; }
function serviceName(kind) { return KINDS[kind] || 'You'; }
function agentGlyph(kind, name) { return GLYPHS[kind] || (name || 'Y').charAt(0).toUpperCase(); }
function allRooms(agent) { return agent.access === 'all' || agent.roomIds === null; }
function accessLabel(agent) {
  if (allRooms(agent)) return 'All rooms';
  const count = agent.roomIds?.length || 0;
  return count ? `${count} ${count === 1 ? 'room' : 'rooms'} allowed` : 'No rooms allowed';
}
function renderConversationContext() {
  if (ui.search) { $('conversation-context-text').textContent = `Search results for “${ui.search}” · latest 100 matches`; return; }
  const count = ui.state?.agents.filter((agent) => allRooms(agent) || agent.roomIds?.includes(ui.room)).length || 0;
  $('conversation-context-text').textContent = `History on this computer · ${count} ${count === 1 ? 'agent has' : 'agents have'} room access`;
}

function appendBody(bodyNode, body) {
  const text = String(body);
  if (!ui.search) { bodyNode.textContent = text; return; }
  const lower = text.toLocaleLowerCase();
  const query = ui.search.toLocaleLowerCase();
  let start = 0;
  let index = lower.indexOf(query);
  while (index !== -1) {
    bodyNode.append(document.createTextNode(text.slice(start, index)), element('mark', '', text.slice(index, index + query.length)));
    start = index + query.length;
    index = lower.indexOf(query, start);
  }
  bodyNode.append(document.createTextNode(text.slice(start)));
}

function renderMessages() {
  const container = $('messages');
  container.replaceChildren();
  let lastDay = '';
  for (const message of ui.messages) {
    const date = new Date(message.createdAt);
    const day = date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    if (day !== lastDay) {
      container.append(element('div', 'date-divider', day));
      lastDay = day;
    }
    const row = element('article', 'message');
    row.id = `message-${message.id}`;
    const kind = serviceKind(message.senderKind);
    const glyph = agentGlyph(kind, message.senderName);
    const avatar = element('div', `message-avatar ${kind}`, glyph);
    avatar.setAttribute('aria-hidden', 'true');
    const main = element('div', 'message-main');
    const meta = element('div', 'message-meta');
    const name = element('strong', '', message.senderName);
    const time = element('time', '', date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    time.dateTime = message.createdAt;
    time.title = date.toLocaleString();
    meta.append(name);
    if (kind !== 'human') meta.append(element('span', 'message-agent-label', serviceName(kind)));
    meta.append(time);
    const replyButton = element('button', 'message-reply-button', 'Reply');
    replyButton.type = 'button';
    replyButton.setAttribute('aria-label', `Reply to ${message.senderName}’s message`);
    replyButton.addEventListener('click', () => { ui.replies.set(ui.room, message); ui.pendingSend = null; renderReply(); $('message-input').focus(); });
    meta.append(replyButton);
    main.append(meta);
    if (message.replyTo) {
      const original = ui.messages.find((item) => item.id === message.replyTo);
      const reply = element('span', 'message-reply', original ? `Replying to ${original.senderName}: ${original.body.slice(0, 100)}${original.body.length > 100 ? '…' : ''}` : `Replying to message #${message.replyTo}`);
      main.append(reply);
    }
    const body = element('div', 'message-body');
    appendBody(body, message.body);
    main.append(body);
    row.append(avatar, main);
    container.append(row);
  }
  $('empty-state').hidden = ui.messages.length > 0 || Boolean(ui.search);
  $('search-empty').hidden = ui.messages.length > 0 || !ui.search;
  $('older-button').hidden = !ui.hasOlder || Boolean(ui.search);
  renderConversationContext();
}

async function loadRoom({ reset = false, forceBottom = false } = {}) {
  const version = ui.roomVersion;
  const room = ui.room;
  const search = ui.search;
  const atBottom = nearBottom();
  const scrollTop = $('message-scroll').scrollTop;
  const params = new URLSearchParams({ room, limit: '100' });
  if (search) params.set('q', search);
  const incremental = !reset && !search && ui.messages.length > 0;
  if (incremental) params.set('after', String(ui.messages.at(-1).id));
  let result = await api(`/api/messages?${params}`);
  if (incremental) {
    const received = [...result.messages];
    while (result.hasMore) {
      if (version !== ui.roomVersion || room !== ui.room || search !== ui.search) return;
      params.set('after', String(result.nextCursor));
      result = await api(`/api/messages?${params}`);
      received.push(...result.messages);
    }
    result.messages = received;
  }
  if (version !== ui.roomVersion || room !== ui.room || search !== ui.search) return;
  const latestBefore = ui.messages.at(-1)?.id || 0;
  const idsBefore = ui.messages.map((message) => message.id).join(',');
  if (reset || search) {
    ui.messages = result.messages;
    ui.historyLoaded = false;
    ui.hasOlder = Boolean(result.hasMore);
  } else {
    const byId = new Map(ui.messages.map((message) => [message.id, message]));
    for (const message of result.messages) byId.set(message.id, message);
    ui.messages = [...byId.values()].sort((a, b) => a.id - b.id);
    if (!incremental && !ui.historyLoaded) ui.hasOlder = Boolean(result.hasMore);
  }
  if (reset || search || idsBefore !== ui.messages.map((message) => message.id).join(',')) renderMessages();
  if (forceBottom || (!search && atBottom)) scrollBottom();
  else {
    $('message-scroll').scrollTop = scrollTop;
    if (!search && (ui.messages.at(-1)?.id || 0) > latestBefore) $('new-messages-button').hidden = false;
  }
}

async function selectRoom(id) {
  if (id === ui.room && ui.messages.length) { closeSidebar(); return; }
  ui.drafts.set(ui.room, $('message-input').value);
  ui.room = id;
  ui.roomVersion += 1;
  ui.search = '';
  ui.messages = [];
  ui.hasOlder = false;
  ui.pendingSend = null;
  $('search-input').value = '';
  $('search-bar').hidden = true;
  $('message-input').value = ui.drafts.get(id) || '';
  renderReply();
  resizeComposer();
  closeSidebar();
  clearError();
  renderState();
  renderMessages();
  try { await loadRoom({ reset: true, forceBottom: true }); }
  catch (error) { showError(error, () => loadRoom({ reset: true, forceBottom: true })); }
}

async function refresh() {
  if (ui.refreshRunning) { ui.refreshPending = true; return; }
  ui.refreshRunning = true;
  try {
    do {
      ui.refreshPending = false;
      ui.state = await api('/api/state');
      if (!ui.state.rooms.some((room) => room.id === ui.room)) ui.room = ui.state.rooms[0]?.id || 'general';
      renderState();
      await loadRoom();
    } while (ui.refreshPending);
  } catch (error) { showError(error, refresh); }
  finally { ui.refreshRunning = false; }
}

async function markVisibleRead() {
  if (!ui.state || ui.search || !nearBottom() || document.visibilityState !== 'visible') return;
  const roomId = ui.room;
  const cursor = ui.messages.at(-1)?.id || 0;
  if (!cursor || cursor <= (ui.marked.get(roomId) || 0)) return;
  ui.marked.set(roomId, cursor);
  try { await post('/api/read', { roomId, cursor }); }
  catch { ui.marked.delete(roomId); }
}

function connectEvents() {
  ui.eventSource?.close();
  const stream = new EventSource('/api/events');
  ui.eventSource = stream;
  stream.addEventListener('change', () => refresh());
  stream.onopen = () => { $('connection-notice').hidden = true; refresh(); };
  stream.onerror = () => {
    $('connection-notice').textContent = 'Live updates disconnected. Reconnecting to your local server…';
    $('connection-notice').hidden = false;
  };
}

async function sendMessage(event) {
  event?.preventDefault();
  if (ui.sending) return;
  const input = $('message-input');
  const body = input.value;
  if (!body.trim()) { input.focus(); return; }
  const roomId = ui.room;
  const version = ui.roomVersion;
  const replyTo = ui.replies.get(roomId)?.id || null;
  if (!ui.pendingSend || ui.pendingSend.body !== body || ui.pendingSend.roomId !== roomId || (ui.pendingSend.replyTo || null) !== replyTo) {
    ui.pendingSend = { roomId, body, clientMessageId: crypto.randomUUID(), ...(replyTo ? { replyTo } : {}) };
  }
  const payload = ui.pendingSend;
  ui.sending = true;
  $('send-button').disabled = true;
  clearError();
  try {
    await post('/api/messages', payload);
    ui.pendingSend = null;
    ui.drafts.delete(roomId);
    if ((ui.replies.get(roomId)?.id || null) === replyTo) { ui.replies.delete(roomId); if (ui.room === roomId) renderReply(); }
    if (version === ui.roomVersion && input.value === body) { input.value = ''; resizeComposer(); }
    await refresh();
    if (version === ui.roomVersion) scrollBottom();
  } catch (error) { showError(error, () => sendMessage()); }
  finally { ui.sending = false; $('send-button').disabled = false; input.focus(); }
}

async function loadOlder() {
  const button = $('older-button');
  const room = ui.room;
  const version = ui.roomVersion;
  const oldHeight = $('message-scroll').scrollHeight;
  const oldTop = $('message-scroll').scrollTop;
  button.disabled = true;
  button.textContent = 'Loading earlier messages…';
  try {
    const firstId = ui.messages[0]?.id || Infinity;
    const result = await api(`/api/messages?${new URLSearchParams({ room, before: String(firstId), limit: '100' })}`);
    if (version !== ui.roomVersion || ui.search) return;
    ui.messages = [...result.messages, ...ui.messages];
    ui.hasOlder = Boolean(result.hasMore);
    ui.historyLoaded = true;
    renderMessages();
    $('message-scroll').scrollTop = oldTop + $('message-scroll').scrollHeight - oldHeight;
  } catch (error) { showError(error, loadOlder); }
  finally { button.disabled = false; button.textContent = 'Show earlier messages'; }
}

async function exportTranscript() {
  const roomId = ui.room;
  try {
    const state = await api('/api/state');
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error('This conversation is no longer available.');
    const anchor = element('a');
    anchor.href = `/api/export?${new URLSearchParams({ room: roomId, download: '1' })}`;
    anchor.download = `agent-commons-${room.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    toast('Transcript download requested.');
  } catch (error) { showError(error, exportTranscript); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field = element('textarea', 'sr-only');
    field.value = text;
    field.readOnly = true;
    (document.querySelector('dialog[open]') || document.body).append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('Clipboard is unavailable. Select the text and copy it manually.');
  }
  toast('Copied to clipboard.');
}

function renderReply() {
  const reply = ui.replies.get(ui.room);
  $('composer-reply').hidden = !reply;
  $('reply-name').textContent = reply ? `Replying to ${reply.senderName}` : '';
  $('reply-preview').textContent = reply ? reply.body.slice(0, 180) : '';
}

function renderConnectionIdentity() {
  const select = $('connect-agent');
  const active = ui.state?.agents.find((agent) => agent.id === ui.connectAgent);
  const choices = ui.state?.agents || [];
  const signature = JSON.stringify(choices.map(({ id, name, kind }) => [id, name, kind]));
  if (select.dataset.choices !== signature) {
    select.replaceChildren();
    for (const agent of choices) {
      const option = element('option', '', `${agent.name} · ${serviceName(agent.kind)}`);
      option.value = agent.id;
      select.append(option);
    }
    select.dataset.choices = signature;
  }
  select.value = active?.id || '';
  $('edit-agent-button').disabled = !active;
  $('connect-agent-name').textContent = active ? `${active.name} · ${serviceName(active.kind)}` : 'No agent selected';
  const roomNames = active?.roomIds?.map((id) => ui.state.rooms.find((room) => room.id === id)?.name || id) || [];
  $('connect-agent-access').textContent = active ? (allRooms(active) ? 'Access to all rooms, including rooms created later.' : roomNames.length ? `Allowed rooms: ${roomNames.join(', ')}` : 'No rooms allowed. Edit access before this assistant can read or message.') : 'Add a named identity to get started.';
}

let setupClients = [];
let setupConfig = null;
function renderSetupTabs(config, initial) {
  setupConfig = config;
  setupClients = Object.keys(config.clients);
  const tabs = $('client-tabs');
  tabs.replaceChildren();
  for (const id of setupClients) {
    const tab = element('button', '', config.clients[id].title);
    tab.id = `${id}-tab`; tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'client-setup');
    tab.addEventListener('click', () => selectSetupTab(id));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = setupClients.indexOf(id);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? setupClients.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + setupClients.length) % setupClients.length;
      selectSetupTab(setupClients[next], true);
    });
    tabs.append(tab);
  }
  selectSetupTab(setupClients.includes(initial) ? initial : setupClients[0]);
}

function selectSetupTab(client, focus = false) {
  if (!setupConfig) return;
  for (const other of setupClients) {
    const selected = client === other;
    $(`${other}-tab`).setAttribute('aria-selected', String(selected));
    $(`${other}-tab`).tabIndex = selected ? 0 : -1;
  }
  const c = setupConfig.clients[client];
  $('client-title').textContent = c.title;
  $('client-file').textContent = c.file;
  $('client-format').textContent = client === 'codex' ? 'TOML' : client === 'claude-code' ? 'Terminal command' : 'JSON';
  $('client-config').textContent = c.snippet;
  if (focus) $(`${client}-tab`).focus();
}

async function showConnect(agentId) {
  const dialog = $('connect-dialog');
  ui.connectAgent = typeof agentId === 'string' ? agentId : ui.connectAgent || ui.state?.agents[0]?.id;
  if (!ui.state?.agents.some((agent) => agent.id === ui.connectAgent)) ui.connectAgent = ui.state?.agents[0]?.id;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  renderConnectionIdentity();
  const version = ++ui.connectVersion;
  $('connect-loading').hidden = false;
  $('connect-content').hidden = true;
  $('connect-loading').textContent = 'Loading this identity’s connection instructions…';
  if (!ui.connectAgent) { $('connect-loading').textContent = 'Add a named agent to create its local connection.'; return; }
  const active = ui.state.agents.find((agent) => agent.id === ui.connectAgent);
  try {
    const config = await api(`/api/connect?${new URLSearchParams({ agent: ui.connectAgent })}`);
    if (version !== ui.connectVersion || !dialog.open) return;
    renderSetupTabs(config, DEFAULT_CLIENT[active.kind] || 'generic');
    $('credential-file').textContent = config.credentialFile || 'Available from the local service';
    $('agent-prompt').textContent = config.prompt;
    $('connect-loading').hidden = true;
    $('connect-content').hidden = false;
  } catch (error) { if (version === ui.connectVersion) $('connect-loading').textContent = error.message; }
}

function showAgentSettings(agentId = null) {
  ui.agentFormVersion += 1;
  ui.savingAgent = false;
  $('save-agent-button').disabled = false;
  const agent = ui.state?.agents.find((item) => item.id === agentId);
  ui.editingAgent = agent?.id || null;
  $('agent-form').reset();
  $('agent-error').hidden = true;
  $('agent-dialog-title').textContent = agent ? 'Edit agent connection' : 'Add a named agent';
  $('save-agent-button').textContent = agent ? 'Save changes' : 'Create agent';
  $('agent-name').value = agent?.name || '';
  $('agent-kind').value = agent?.kind || 'claude';
  $('agent-kind').disabled = Boolean(agent);
  $('agent-all-rooms').checked = !agent || allRooms(agent);
  const choices = $('agent-room-options');
  choices.replaceChildren();
  for (const room of ui.state?.rooms || []) {
    const label = element('label', 'room-grant-option');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = room.id;
    checkbox.name = 'roomIds';
    checkbox.checked = Boolean(agent && !allRooms(agent) && agent.roomIds?.includes(room.id));
    const detail = element('span');
    detail.append(element('strong', '', room.name));
    if (room.description) detail.append(element('span', '', room.description));
    label.append(checkbox, detail);
    choices.append(label);
  }
  updateRoomChoices();
  if (!$('agent-dialog').open) $('agent-dialog').showModal();
  $('agent-name').focus();
}

function updateRoomChoices() {
  const all = $('agent-all-rooms').checked;
  for (const input of $('agent-room-options').querySelectorAll('input')) input.disabled = all;
  $('agent-room-options').classList.toggle('muted', all);
}

async function saveAgent(event) {
  event.preventDefault();
  if (ui.savingAgent) return;
  ui.savingAgent = true;
  const version = ui.agentFormVersion;
  const button = $('save-agent-button');
  button.disabled = true;
  $('agent-error').hidden = true;
  const existing = ui.state?.agents.find((agent) => agent.id === ui.editingAgent);
  const roomIds = $('agent-all-rooms').checked ? null : [...$('agent-room-options').querySelectorAll('input:checked')].map((input) => input.value);
  const body = { name: $('agent-name').value.trim(), roomIds };
  if (!existing) body.kind = $('agent-kind').value;
  try {
    const result = existing
      ? await api(`/api/agents/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await post('/api/agents', body);
    if (version !== ui.agentFormVersion || !$('agent-dialog').open) {
      try { ui.state = await api('/api/state'); renderState(); }
      catch { /* Live updates and the next presence poll will refresh the completed change. */ }
      return;
    }
    const returned = result.agent;
    const known = ui.state.agents.some((agent) => agent.id === returned.id);
    ui.state.agents = known ? ui.state.agents.map((agent) => agent.id === returned.id ? { ...agent, ...returned } : agent) : [...ui.state.agents, { connected: false, status: 'offline', ...returned }];
    renderState();
    $('agent-dialog').close();
    await showConnect(result.agent.id);
    toast(existing ? 'Agent settings saved.' : 'Agent created. Choose its local connection setup.');
  } catch (error) {
    if (version === ui.agentFormVersion && $('agent-dialog').open) { $('agent-error').textContent = error.message; $('agent-error').hidden = false; }
  }
  finally { if (version === ui.agentFormVersion) { button.disabled = false; ui.savingAgent = false; } }
}

function showAuth() {
  ui.eventSource?.close();
  ui.eventSource = null;
  const dialog = $('auth-dialog');
  if (!dialog.open) dialog.showModal();
}

async function authenticatedStart() {
  clearError();
  ui.state = await api('/api/state');
  renderState();
  await loadRoom({ reset: true, forceBottom: true });
  connectEvents();
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('token');
  if (window.location.hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  try {
    if (token) await post('/api/session', { token });
    await authenticatedStart();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      showAuth();
      if (token) { $('auth-error').textContent = 'That access link could not open this workspace. Use the start shortcut again.'; $('auth-error').hidden = false; }
    } else showError(error, bootstrap);
  }
}

$('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', () => { resizeComposer(); ui.drafts.set(ui.room, $('message-input').value); });
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
});
$('message-scroll').addEventListener('scroll', () => {
  if (nearBottom()) { $('new-messages-button').hidden = true; markVisibleRead(); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); markVisibleRead(); } });
$('new-messages-button').addEventListener('click', scrollBottom);
$('older-button').addEventListener('click', loadOlder);
$('export-button').addEventListener('click', exportTranscript);
$('connect-button').addEventListener('click', showConnect);
$('mobile-connect').addEventListener('click', showConnect);
$('mobile-menu').addEventListener('click', () => {
  const open = !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', open);
  $('sidebar-backdrop').hidden = !open;
  $('mobile-menu').setAttribute('aria-expanded', String(open));
  syncSidebarAccess();
  if (open) $('rooms').querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
  else $('mobile-menu').focus({ preventScroll: true });
});
$('sidebar-backdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSidebar(); });
mobileSidebar.addEventListener('change', () => {
  if (mobileSidebar.matches && $('sidebar').contains(document.activeElement)) $('mobile-menu').focus({ preventScroll: true });
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop').hidden = true;
  $('mobile-menu').setAttribute('aria-expanded', 'false');
  syncSidebarAccess();
});
$('dismiss-error').addEventListener('click', clearError);
$('retry-button').addEventListener('click', async () => {
  const retry = ui.retry;
  clearError();
  try { await retry?.(); } catch (error) { showError(error, retry); }
});
$('search-toggle').addEventListener('click', () => {
  $('search-bar').hidden = !$('search-bar').hidden;
  if (!$('search-bar').hidden) $('search-input').focus();
  else if (ui.search) clearSearch();
});
async function clearSearch() {
  clearTimeout(ui.searchTimer);
  ui.search = '';
  ui.roomVersion += 1;
  $('search-input').value = '';
  $('search-bar').hidden = true;
  try { await loadRoom({ reset: true, forceBottom: true }); }
  catch (error) { showError(error, clearSearch); }
}
$('search-clear').addEventListener('click', clearSearch);
$('search-input').addEventListener('input', () => {
  clearTimeout(ui.searchTimer);
  ui.searchTimer = setTimeout(async () => {
    ui.search = $('search-input').value.trim();
    ui.roomVersion += 1;
    try { await loadRoom({ reset: true }); $('message-scroll').scrollTop = 0; }
    catch (error) { showError(error, () => loadRoom({ reset: true })); }
  }, 220);
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  try { await copyText($(button.dataset.copy).textContent); }
  catch (error) { toast(error.message); }
}));
$('cancel-reply').addEventListener('click', () => { ui.replies.delete(ui.room); ui.pendingSend = null; renderReply(); $('message-input').focus(); });
$('connect-agent').addEventListener('change', () => showConnect($('connect-agent').value));
$('connect-dialog').addEventListener('close', () => { ui.connectVersion += 1; });
$('add-agent-button').addEventListener('click', () => showAgentSettings());
$('edit-agent-button').addEventListener('click', () => showAgentSettings(ui.connectAgent));
$('agent-all-rooms').addEventListener('change', updateRoomChoices);
$('agent-form').addEventListener('submit', saveAgent);
$('agent-dialog').addEventListener('close', () => {
  if (!$('agent-dialog').open) { ui.agentFormVersion += 1; ui.savingAgent = false; $('save-agent-button').disabled = false; }
});
$('new-room-button').addEventListener('click', () => {
  $('room-form').reset();
  $('room-error').hidden = true;
  $('room-dialog').showModal();
  $('room-name').focus();
});
$('room-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('create-room-button');
  button.disabled = true;
  $('room-error').hidden = true;
  try {
    const result = await post('/api/rooms', { name: $('room-name').value.trim(), description: $('room-description-input').value.trim() });
    $('room-dialog').close();
    ui.state = await api('/api/state');
    await selectRoom(result.room.id);
    toast('Conversation created.');
  } catch (error) { $('room-error').textContent = error.message; $('room-error').hidden = false; }
  finally { button.disabled = false; }
});
$('auth-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-error').hidden = true;
  const tokenInput = $('auth-token');
  try {
    await post('/api/session', { token: tokenInput.value.trim() });
    tokenInput.value = '';
    $('auth-dialog').close();
    await authenticatedStart();
  } catch (error) { $('auth-error').textContent = error.message; $('auth-error').hidden = false; }
});
setInterval(async () => {
  if (!ui.state || $('auth-dialog').open || document.visibilityState !== 'visible') return;
  try { ui.state = await api('/api/state'); renderState(); }
  catch { /* Live updates or an explicit action will surface a connection failure. */ }
}, 15000);

syncSidebarAccess();
bootstrap();
