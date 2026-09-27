"use strict";

const server = require("server");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "/api/sbmonitor/v1";
const STATE_FILE = path.join(__storageDir__, "state.json");
const HISTORY_DIR = path.join(__storageDir__, "history");
const INSTALLER_FILE = path.join(__dirname, "installer", "install-agent.sh");
const UNINSTALLER_FILE = path.join(__dirname, "installer", "uninstall-agent.sh");
const MAX_EVENTS = 500;
const MAX_USER_EVENTS = 300;
const MAX_PENDING = 100;
const PLUGIN_VERSION = "0.2.0";

let config = {
  timezoneOffset: 8,
  offlineSeconds: 60,
  historyDays: 30,
  sessionIdleSeconds: 300,
  watchRules: [],
  tgBotToken: "",
  tgChatId: "",
  notifyOnline: true,
  notifyOffline: true,
};
let state = freshState();
let storageLoaded = false;
let flushingTelegram = false;

function freshState() {
  return {
    schema: 2,
    nodes: {},
    registrations: {},
    daily: {},
    events: [],
    watch: {},
    userEvents: [],
    pending: [],
    updatedAt: new Date().toISOString(),
  };
}

function ensureStorage() {
  fs.mkdirSync(__storageDir__, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function isNotFound(error) {
  if (!error) return false;
  if (error.code === "ENOENT") return true;
  const message = String(error.message || error).toLowerCase();
  return message.includes("no such file or directory") || message.includes("not found");
}

function loadState() {
  storageLoaded = false;
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid persisted state: expected an object");
    }
    state = Object.assign(freshState(), parsed);
    state.nodes = state.nodes || {};
    state.registrations = state.registrations || {};
    state.daily = state.daily || {};
    state.events = Array.isArray(state.events) ? state.events : [];
    state.watch = state.watch && typeof state.watch === "object" ? state.watch : {};
    state.userEvents = Array.isArray(state.userEvents) ? state.userEvents : [];
    state.pending = Array.isArray(state.pending) ? state.pending : [];
  } catch (error) {
    // Komari's Go-backed fs throws GoError without Node's error.code.
    // Missing state is expected on first install; all other errors remain fatal.
    if (!isNotFound(error)) throw error;
    state = freshState();
  }
  storageLoaded = true;
}

function persistState() {
  ensureStorage();
  state.updatedAt = new Date().toISOString();
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), "utf8");
  fs.renameSync(temp, STATE_FILE);
}

function numberConfig(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// parseWatchRules turns a "tag=label, tag2=label2" (comma or newline separated)
// string into [{tag, label}]. A bare "tag" uses the tag as its own label.
function parseWatchRules(raw) {
  const rules = [];
  const seen = new Set();
  for (const piece of String(raw || "").split(/[,\n]/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    const tag = cleanText(index >= 0 ? trimmed.slice(0, index) : trimmed, 100).trim();
    if (!tag || seen.has(tag)) continue;
    const label = cleanName(index >= 0 ? trimmed.slice(index + 1) : tag) || tag;
    seen.add(tag);
    rules.push({ tag, label });
  }
  return rules;
}

async function loadConfig() {
  const saved = await server.getConfig();
  config = {
    timezoneOffset: numberConfig(saved.timezone_offset, 8, -12, 14),
    offlineSeconds: numberConfig(saved.offline_seconds, 60, 15, 3600),
    historyDays: numberConfig(saved.history_days, 30, 1, 365),
    sessionIdleSeconds: numberConfig(saved.session_idle_seconds, 300, 30, 86400),
    watchRules: parseWatchRules(saved.watch_rules),
    tgBotToken: cleanText(saved.tg_bot_token, 100).trim(),
    tgChatId: cleanText(saved.tg_chat_id, 60).trim(),
    notifyOnline: saved.notify_online !== false,
    notifyOffline: saved.notify_offline !== false,
  };
}

function sendJSON(res, value, statusCode) {
  res.statusCode = statusCode || 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function sendText(res, value, contentType) {
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType || "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(value);
}

function fail(res, statusCode, message) {
  sendJSON(res, { ok: false, error: message }, statusCode);
}

function parseBody(req, res) {
  try {
    const body = JSON.parse(req.body || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("expected object");
    return body;
  } catch (_error) {
    fail(res, 400, "请求内容不是有效 JSON");
    return null;
  }
}

function normalizeRole(value) {
  return String(value || "").toLowerCase().replace(/^role/, "");
}

function isAdmin(req) {
  const context = req.context || {};
  const principal = context.principal || {};
  const roles = Array.isArray(principal.roles) ? principal.roles.map(normalizeRole) : [];
  const role = normalizeRole(context.role);
  return principal.type === "user" && (role === "admin" || roles.includes("admin"));
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    fail(res, 403, "需要 Komari 管理员登录");
    return false;
  }
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    fail(res, 403, "拒绝跨站请求");
    return false;
  }
  return true;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanName(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maxLength);
}

function dateKey(dateValue) {
  const time = new Date(dateValue || Date.now()).getTime();
  const shifted = new Date(time + config.timezoneOffset * 3600000);
  return shifted.toISOString().slice(0, 10);
}

function monthKey(dateValue) {
  return dateKey(dateValue).slice(0, 7);
}

function portKey(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : "";
}

function cleanInbound(item) {
  if (!item || typeof item !== "object") return null;
  const port = Number(item && item.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const users = Array.isArray(item.users)
    ? item.users.map((value) => cleanName(value)).filter(Boolean).slice(0, 100)
    : [];
  return {
    port,
    type: cleanText(item.type, 40),
    tag: cleanText(item.tag, 100),
    users,
  };
}

function cleanCounter(item) {
  if (!item || typeof item !== "object") return null;
  const port = Number(item && item.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const safeNumber = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  return {
    port,
    uploadTotal: safeNumber(item.upload_total),
    downloadTotal: safeNumber(item.download_total),
    uploadRate: safeNumber(item.upload_rate),
    downloadRate: safeNumber(item.download_rate),
  };
}

function cleanupRegistrations() {
  const now = Date.now();
  for (const [hash, registration] of Object.entries(state.registrations)) {
    if (!registration || new Date(registration.expiresAt).getTime() <= now) {
      delete state.registrations[hash];
    }
  }
}

function addDailyTraffic(nodeId, port, upload, download, timestamp) {
  const day = dateKey(timestamp);
  if (!state.daily[day]) state.daily[day] = {};
  if (!state.daily[day][nodeId]) state.daily[day][nodeId] = {};
  if (!state.daily[day][nodeId][port]) state.daily[day][nodeId][port] = { upload: 0, download: 0 };
  state.daily[day][nodeId][port].upload += upload;
  state.daily[day][nodeId][port].download += download;
}

function calculateDelta(current, previous) {
  if (!Number.isFinite(previous) || previous < 0) return 0;
  if (current >= previous) return current - previous;
  return current;
}

// ---- Watched-user connection tracking (per inbound tag) --------------------

function watchRuleFor(tag) {
  return config.watchRules.find((rule) => rule.tag === tag) || null;
}

function watchKey(nodeId, tag) {
  return `${nodeId}:${tag}`;
}

function pushUserEvent(kind, watch, nodeName, nowISO) {
  state.userEvents.push({
    id: randomToken(8),
    kind,
    label: watch.label,
    tag: watch.tag,
    nodeId: watch.nodeId,
    nodeName: nodeName || "",
    source: watch.lastSource || "",
    time: nowISO,
  });
  if (state.userEvents.length > MAX_USER_EVENTS) {
    state.userEvents = state.userEvents.slice(-MAX_USER_EVENTS);
  }
}

// handleActivity advances the session state machine for one watched inbound tag.
// Only real connections (conn > 0) count; the offline transition is time-based
// and handled by checkOffline so a quiet session eventually closes.
function handleActivity(node, tag, conn, source, nowISO) {
  const rule = watchRuleFor(tag);
  if (!rule || conn <= 0) return;
  const key = watchKey(node.id, tag);
  let watch = state.watch[key];
  if (!watch) {
    watch = state.watch[key] = {
      nodeId: node.id,
      tag,
      online: false,
      sessionStart: null,
      sessionConn: 0,
      lastActive: null,
      lastSource: "",
      connCount: 0,
    };
  }
  watch.label = rule.label;
  if (source) watch.lastSource = source;
  watch.lastActive = nowISO;
  watch.connCount += conn;
  if (!watch.online) {
    watch.online = true;
    watch.sessionStart = nowISO;
    watch.sessionConn = 0;
    pushUserEvent("online", watch, node.name, nowISO);
    if (config.notifyOnline) enqueueTelegram(formatOnline(watch, node.name, nowISO));
  }
  watch.sessionConn += conn;
}

// checkOffline closes sessions with no activity for sessionIdleSeconds.
function checkOffline() {
  const nowMs = Date.now();
  let changed = false;
  for (const watch of Object.values(state.watch)) {
    if (!watch.online || !watch.lastActive) continue;
    if (nowMs - new Date(watch.lastActive).getTime() <= config.sessionIdleSeconds * 1000) continue;
    watch.online = false;
    const nowISO = new Date().toISOString();
    const node = state.nodes[watch.nodeId];
    pushUserEvent("offline", watch, node && node.name, nowISO);
    if (config.notifyOffline) enqueueTelegram(formatOffline(watch, node && node.name, nowISO));
    changed = true;
  }
  if (changed) persistState();
  runTelegramFlush();
}

function localTimeLabel(nowISO) {
  const shifted = new Date(new Date(nowISO).getTime() + config.timezoneOffset * 3600000);
  return shifted.toISOString().slice(11, 19);
}

function humanDuration(fromISO, toISO) {
  const seconds = Math.max(0, Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

function formatOnline(watch, nodeName, nowISO) {
  const lines = [
    `\u{1F7E2} <b>${escapeHTML(watch.label)} 上线</b>`,
    `节点  ${escapeHTML(nodeName || watch.nodeId)}`,
    `时间  ${localTimeLabel(nowISO)}`,
  ];
  if (watch.lastSource) lines.push(`来源  ${escapeHTML(watch.lastSource)}`);
  return lines.join("\n");
}

function formatOffline(watch, nodeName, nowISO) {
  const duration = watch.sessionStart ? humanDuration(watch.sessionStart, nowISO) : "?";
  return [
    `\u{26AA} <b>${escapeHTML(watch.label)} 下线</b>`,
    `节点  ${escapeHTML(nodeName || watch.nodeId)}`,
    `时间  ${localTimeLabel(nowISO)}`,
    `本次会话  ${duration}`,
  ].join("\n");
}

// ---- Telegram delivery -----------------------------------------------------
// Events enqueue to a persisted queue; flushing is best-effort and retried by a
// cron, so an outage or a request-handler that cannot await never drops alerts.

function enqueueTelegram(text) {
  state.pending.push({ text, at: new Date().toISOString() });
  if (state.pending.length > MAX_PENDING) state.pending = state.pending.slice(-MAX_PENDING);
}

async function sendTelegramOnce(text) {
  const url = `https://api.telegram.org/bot${config.tgBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.tgChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return true;
}

async function flushTelegram() {
  if (flushingTelegram) return;
  if (!config.tgBotToken || !config.tgChatId) return;
  if (!state.pending.length) return;
  flushingTelegram = true;
  try {
    while (state.pending.length) {
      const item = state.pending[0];
      try {
        await sendTelegramOnce(item.text);
      } catch (error) {
        console.warn("Telegram 推送失败，稍后重试:", error.message);
        break;
      }
      state.pending.shift();
      persistState();
    }
  } finally {
    flushingTelegram = false;
  }
}

function runTelegramFlush() {
  Promise.resolve()
    .then(flushTelegram)
    .catch((error) => console.warn("Telegram flush 异常:", error && error.message));
}

function registerAgent(req, res) {
  const body = parseBody(req, res);
  if (!body) return;
  cleanupRegistrations();
  const registrationHash = sha256(body.registration_token || "");
  const registration = state.registrations[registrationHash];
  if (!registration || registration.used) return fail(res, 401, "注册密钥无效或已使用");
  if (new Date(registration.expiresAt).getTime() <= Date.now()) return fail(res, 401, "注册密钥已过期");

  const requestedName = cleanName(body.name);
  const name = requestedName || registration.name;
  if (!name) return fail(res, 400, "节点名称不能为空");

  const nodeId = randomToken(16);
  const agentToken = randomToken(32);
  const now = new Date().toISOString();
  state.nodes[nodeId] = {
    id: nodeId,
    name,
    hostname: cleanText(body.hostname, 120),
    arch: cleanText(body.arch, 30),
    agentVersion: cleanText(body.agent_version, 30),
    agentTokenHash: sha256(agentToken),
    createdAt: now,
    lastSeen: null,
    singbox: { running: false, version: "" },
    inbounds: [],
    aliases: {},
    current: {},
    lastTotals: {},
  };
  registration.used = true;
  registration.nodeId = nodeId;
  persistState();
  sendJSON(res, { ok: true, node_id: nodeId, agent_token: agentToken, name });
}

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function reportAgent(req, res) {
  const body = parseBody(req, res);
  if (!body) return;
  const nodeId = cleanText(body.node_id, 100);
  if (!/^[a-f0-9]{32}$/.test(nodeId)) return fail(res, 401, "Agent 身份验证失败");
  const node = state.nodes[nodeId];
  if (!node || sha256(bearerToken(req)) !== node.agentTokenHash) return fail(res, 401, "Agent 身份验证失败");

  const now = new Date().toISOString();
  // Receipt time is authoritative; an Agent clock must not create arbitrary daily buckets.
  const timestamp = now;
  const inbounds = Array.isArray(body.inbounds) ? body.inbounds.map(cleanInbound).filter(Boolean) : [];
  const counters = Array.isArray(body.counters) ? body.counters.map(cleanCounter).filter(Boolean) : [];

  node.hostname = cleanText(body.hostname || node.hostname, 120);
  node.arch = cleanText(body.arch || node.arch, 30);
  node.agentVersion = cleanText(body.agent_version || node.agentVersion, 30);
  node.lastSeen = now;
  node.singbox = {
    running: Boolean(body.singbox && body.singbox.running),
    version: cleanText(body.singbox && body.singbox.version, 120),
  };
  node.inbounds = inbounds;

  const nextCurrent = {};
  for (const counter of counters) {
    const key = portKey(counter.port);
    if (!key || nextCurrent[key]) continue;
    const previous = node.lastTotals[key];
    if (previous) {
      addDailyTraffic(
        nodeId,
        key,
        calculateDelta(counter.uploadTotal, previous.upload),
        calculateDelta(counter.downloadTotal, previous.download),
        timestamp,
      );
    }
    node.lastTotals[key] = { upload: counter.uploadTotal, download: counter.downloadTotal };
    nextCurrent[key] = counter;
  }
  node.current = nextCurrent;

  if (Array.isArray(body.events)) {
    const known = new Set(state.events.slice(-100).map((event) => event.hash));
    for (const raw of body.events.slice(0, 50)) {
      const message = cleanText(raw, 2000).trim();
      if (!message) continue;
      const hash = sha256(`${nodeId}:${message}`);
      if (known.has(hash)) continue;
      known.add(hash);
      state.events.push({ id: randomToken(8), hash, nodeId, time: now, level: "WARN", message });
    }
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  }

  if (Array.isArray(body.activity)) {
    const seen = [];
    for (const raw of body.activity.slice(0, 50)) {
      if (!raw || typeof raw !== "object") continue;
      const tag = cleanText(raw.tag, 100);
      const conn = Number(raw.conn_count);
      if (!tag || !Number.isFinite(conn)) continue;
      const source = cleanText(raw.last_source, 120);
      seen.push({ tag, conn, source });
      handleActivity(node, tag, conn, source, now);
    }
    // Diagnostic: last raw activity the agent reported, independent of watch_rules.
    node.lastActivity = { at: now, items: seen };
  }

  persistState();
  sendJSON(res, { ok: true, server_time: now });
  runTelegramFlush();
}

function portTraffic(nodeId, port, mode) {
  let upload = 0;
  let download = 0;
  const prefix = mode === "month" ? monthKey() : dateKey();
  for (const [day, byNode] of Object.entries(state.daily)) {
    if ((mode === "month" && !day.startsWith(prefix)) || (mode !== "month" && day !== prefix)) continue;
    const value = byNode && byNode[nodeId] && byNode[nodeId][String(port)];
    if (!value) continue;
    upload += Number(value.upload) || 0;
    download += Number(value.download) || 0;
  }
  return { upload, download, total: upload + download };
}

function publicNode(node) {
  const now = Date.now();
  const seen = node.lastSeen ? new Date(node.lastSeen).getTime() : 0;
  const online = seen > 0 && now - seen <= config.offlineSeconds * 1000;
  const inboundMap = {};
  for (const inbound of node.inbounds || []) inboundMap[String(inbound.port)] = inbound;
  const ports = Object.keys(Object.assign({}, inboundMap, node.current || {}))
    .map(Number)
    .filter((port) => Number.isInteger(port))
    .sort((a, b) => a - b)
    .map((port) => {
      const inbound = inboundMap[String(port)] || { port, type: "", tag: "", users: [] };
      const current = node.current[String(port)] || { uploadRate: 0, downloadRate: 0 };
      const today = portTraffic(node.id, port, "day");
      const month = portTraffic(node.id, port, "month");
      return {
        port,
        type: inbound.type,
        tag: inbound.tag,
        users: inbound.users,
        displayName: node.aliases && node.aliases[String(port)] || (inbound.users && inbound.users[0]) || inbound.tag || String(port),
        uploadRate: online ? current.uploadRate || 0 : 0,
        downloadRate: online ? current.downloadRate || 0 : 0,
        today,
        month,
      };
    });
  return {
    id: node.id,
    name: node.name,
    hostname: node.hostname,
    arch: node.arch,
    agentVersion: node.agentVersion,
    createdAt: node.createdAt,
    lastSeen: node.lastSeen,
    online,
    singbox: node.singbox,
    ports,
  };
}

function adminState(req, res) {
  if (!requireAdmin(req, res)) return;
  cleanupRegistrations();
  const nodes = Object.values(state.nodes).map(publicNode).sort((a, b) => a.name.localeCompare(b.name));
  sendJSON(res, {
    ok: true,
    version: PLUGIN_VERSION,
    config,
    nodes,
    events: state.events.slice(-100).reverse().map(({ hash, ...event }) => event),
  });
}

// adminWatch powers the connection panel: one row per watched inbound tag per
// node, seeded from reported inbounds so a watched user shows as offline even
// before their first connection.
function adminWatch(req, res) {
  if (!requireAdmin(req, res)) return;
  const nowMs = Date.now();
  const rows = {};
  for (const node of Object.values(state.nodes)) {
    const nodeOnline = node.lastSeen && nowMs - new Date(node.lastSeen).getTime() <= config.offlineSeconds * 1000;
    for (const inbound of node.inbounds || []) {
      const rule = watchRuleFor(inbound.tag);
      if (!rule) continue;
      rows[watchKey(node.id, inbound.tag)] = {
        label: rule.label,
        tag: inbound.tag,
        port: inbound.port,
        nodeId: node.id,
        nodeName: node.name,
        nodeOnline: Boolean(nodeOnline),
        online: false,
        sessionStart: null,
        sessionConn: 0,
        lastActive: null,
        lastSource: "",
        connTotal: 0,
      };
    }
  }
  for (const [key, watch] of Object.entries(state.watch)) {
    const node = state.nodes[watch.nodeId];
    const base = rows[key] || {
      label: watch.label,
      tag: watch.tag,
      port: null,
      nodeId: watch.nodeId,
      nodeName: (node && node.name) || "",
      nodeOnline: false,
    };
    const idle = watch.lastActive ? nowMs - new Date(watch.lastActive).getTime() : Infinity;
    base.online = Boolean(watch.online && idle <= config.sessionIdleSeconds * 1000);
    base.sessionStart = base.online ? watch.sessionStart : null;
    base.sessionConn = base.online ? watch.sessionConn || 0 : 0;
    base.lastActive = watch.lastActive;
    base.lastSource = watch.lastSource || "";
    base.connTotal = watch.connCount || 0;
    rows[key] = base;
  }
  const watched = Object.values(rows).sort(
    (a, b) => (a.label || "").localeCompare(b.label || "") || (a.nodeName || "").localeCompare(b.nodeName || ""),
  );
  sendJSON(res, {
    ok: true,
    version: PLUGIN_VERSION,
    server_time: new Date().toISOString(),
    timezone_offset: config.timezoneOffset,
    session_idle_seconds: config.sessionIdleSeconds,
    telegram_configured: Boolean(config.tgBotToken && config.tgChatId),
    rules: config.watchRules,
    watched,
    events: state.userEvents.slice(-120).reverse(),
  });
}

function createRegistration(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = parseBody(req, res);
  if (!body) return;
  const name = cleanName(body.name);
  if (!name) return fail(res, 400, "请输入节点名称");
  cleanupRegistrations();
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  state.registrations[sha256(token)] = { name, expiresAt, used: false, createdAt: new Date().toISOString() };
  persistState();
  sendJSON(res, { ok: true, token, name, expires_at: expiresAt });
}

function renameNode(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = parseBody(req, res);
  if (!body) return;
  const node = state.nodes[String(body.node_id || "")];
  const name = cleanName(body.name);
  if (!node) return fail(res, 404, "节点不存在");
  if (!name) return fail(res, 400, "节点名称不能为空");
  node.name = name;
  persistState();
  sendJSON(res, { ok: true });
}

function setPortAlias(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = parseBody(req, res);
  if (!body) return;
  const node = state.nodes[String(body.node_id || "")];
  const key = portKey(body.port);
  if (!node) return fail(res, 404, "节点不存在");
  if (!key) return fail(res, 400, "端口无效");
  if (!node.aliases) node.aliases = {};
  const alias = cleanName(body.alias);
  if (alias) node.aliases[key] = alias;
  else delete node.aliases[key];
  persistState();
  sendJSON(res, { ok: true });
}

function deleteNode(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = parseBody(req, res);
  if (!body) return;
  const nodeId = String(body.node_id || "");
  if (!state.nodes[nodeId]) return fail(res, 404, "节点不存在");
  delete state.nodes[nodeId];
  for (const day of Object.keys(state.daily)) {
    if (state.daily[day]) delete state.daily[day][nodeId];
  }
  state.events = state.events.filter((event) => event.nodeId !== nodeId);
  state.userEvents = state.userEvents.filter((event) => event.nodeId !== nodeId);
  for (const key of Object.keys(state.watch)) {
    if (state.watch[key].nodeId === nodeId) delete state.watch[key];
  }
  persistState();
  sendJSON(res, { ok: true });
}

function appendHistory() {
  const now = new Date().toISOString();
  const day = dateKey(now);
  for (const node of Object.values(state.nodes)) {
    if (!node.lastSeen || Date.now() - new Date(node.lastSeen).getTime() > config.offlineSeconds * 1000) continue;
    const directory = path.join(HISTORY_DIR, node.id);
    fs.mkdirSync(directory, { recursive: true });
    const points = Object.values(node.current || {}).map((item) => ({
      port: item.port,
      upload_rate: item.uploadRate || 0,
      download_rate: item.downloadRate || 0,
    }));
    fs.appendFileSync(path.join(directory, `${day}.jsonl`), `${JSON.stringify({ time: now, points })}\n`, "utf8");
  }
  persistState();
}

function history(req, res) {
  if (!requireAdmin(req, res)) return;
  const nodeId = String(req.query.node_id || "");
  const day = String(req.query.date || dateKey());
  if (!state.nodes[nodeId]) return fail(res, 404, "节点不存在");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(res, 400, "日期格式错误");
  const filename = path.join(HISTORY_DIR, nodeId, `${day}.jsonl`);
  let points = [];
  try {
    points = fs.readFileSync(filename, "utf8").split("\n").filter(Boolean).slice(-2000).map((line) => JSON.parse(line));
  } catch (error) {
    if (!isNotFound(error)) return fail(res, 500, "读取历史记录失败");
  }
  sendJSON(res, { ok: true, node_id: nodeId, date: day, points });
}

function cleanupHistory() {
  const cutoff = Date.now() - config.historyDays * 86400000;
  try {
    for (const nodeId of fs.readdirSync(HISTORY_DIR)) {
      const directory = path.join(HISTORY_DIR, nodeId);
      for (const filename of fs.readdirSync(directory)) {
        const match = filename.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match) continue;
        if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) fs.unlinkSync(path.join(directory, filename));
      }
    }
  } catch (error) {
    console.warn("清理历史记录失败:", error.message);
  }
}

function serveInstaller(_req, res) {
  try {
    sendText(res, fs.readFileSync(INSTALLER_FILE, "utf8"), "text/x-shellscript; charset=utf-8");
  } catch (_error) {
    fail(res, 500, "安装脚本不可用");
  }
}

function serveUninstaller(_req, res) {
  try {
    sendText(res, fs.readFileSync(UNINSTALLER_FILE, "utf8"), "text/x-shellscript; charset=utf-8");
  } catch (_error) {
    fail(res, 500, "卸载脚本不可用");
  }
}

globalThis.load = async function load() {
  loadState();
  await loadConfig();
  server.static(`${API}/bin`, "bin");
  server.route("GET", `${API}/install.sh`, serveInstaller);
  server.route("GET", `${API}/uninstall.sh`, serveUninstaller);
  server.route("POST", `${API}/agent/register`, registerAgent);
  server.route("POST", `${API}/agent/report`, reportAgent);
  server.route("GET", `${API}/admin/state`, adminState);
  server.route("GET", `${API}/admin/watch`, adminWatch);
  server.route("POST", `${API}/admin/registration`, createRegistration);
  server.route("POST", `${API}/admin/node/rename`, renameNode);
  server.route("POST", `${API}/admin/node/alias`, setPortAlias);
  server.route("POST", `${API}/admin/node/delete`, deleteNode);
  server.route("GET", `${API}/admin/history`, history);
  server.cron("@every 1m", appendHistory);
  server.cron("@every 30s", checkOffline);
  server.cron("@every 20s", () => runTelegramFlush());
  server.cron("0 17 3 * * *", cleanupHistory);
  console.log(`Sing-box Monitor ${PLUGIN_VERSION} 已启动`);
};

globalThis.unload = function unload() {
  if (storageLoaded) persistState();
};
