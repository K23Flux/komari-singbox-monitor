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

let config = { timezoneOffset: 8, offlineSeconds: 60, historyDays: 30 };
let state = freshState();

function freshState() {
  return {
    schema: 1,
    nodes: {},
    registrations: {},
    daily: {},
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

function ensureStorage() {
  fs.mkdirSync(__storageDir__, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function loadState() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = Object.assign(freshState(), parsed || {});
    state.nodes = state.nodes || {};
    state.registrations = state.registrations || {};
    state.daily = state.daily || {};
    state.events = Array.isArray(state.events) ? state.events : [];
  } catch (error) {
    if (error && error.code !== "ENOENT") console.warn("读取状态失败:", error.message);
    state = freshState();
  }
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

async function loadConfig() {
  const saved = await server.getConfig();
  config = {
    timezoneOffset: numberConfig(saved.timezone_offset, 8, -12, 14),
    offlineSeconds: numberConfig(saved.offline_seconds, 60, 15, 3600),
    historyDays: numberConfig(saved.history_days, 30, 1, 365),
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
    return JSON.parse(req.body || "{}");
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
  const port = Number(item && item.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const safeNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
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
  const node = state.nodes[nodeId];
  if (!node || sha256(bearerToken(req)) !== node.agentTokenHash) return fail(res, 401, "Agent 身份验证失败");

  const now = new Date().toISOString();
  const timestamp = Number.isFinite(Number(body.timestamp)) ? new Date(Number(body.timestamp) * 1000).toISOString() : now;
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
    if (!key) continue;
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

  sendJSON(res, { ok: true, server_time: now });
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
        uploadRate: current.uploadRate || 0,
        downloadRate: current.downloadRate || 0,
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
    version: "0.1.0",
    config,
    nodes,
    events: state.events.slice(-100).reverse().map(({ hash, ...event }) => event),
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
  persistState();
  sendJSON(res, { ok: true });
}

function appendHistory() {
  const now = new Date().toISOString();
  const day = dateKey(now);
  for (const node of Object.values(state.nodes)) {
    if (!node.lastSeen) continue;
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
    if (!error || error.code !== "ENOENT") return fail(res, 500, "读取历史记录失败");
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
  server.route("POST", `${API}/admin/registration`, createRegistration);
  server.route("POST", `${API}/admin/node/rename`, renameNode);
  server.route("POST", `${API}/admin/node/alias`, setPortAlias);
  server.route("POST", `${API}/admin/node/delete`, deleteNode);
  server.route("GET", `${API}/admin/history`, history);
  server.cron("@every 1m", appendHistory);
  server.cron("0 17 3 * * *", cleanupHistory);
  console.log("Sing-box Monitor 0.1.0 已启动");
};

globalThis.unload = function unload() {
  persistState();
};
