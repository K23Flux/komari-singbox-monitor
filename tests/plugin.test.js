"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "sbmonitor-test-"));
global.__storageDir__ = storage;

const routes = new Map();
const crons = [];
const mockServer = {
  route(method, routePath, handler) { routes.set(`${method} ${routePath}`, handler); },
  static() {},
  cron(expression, handler) { crons.push({ expression, handler }); },
  async getConfig() {
    return {
      timezone_offset: 8,
      offline_seconds: 60,
      history_days: 30,
      watch_rules: "ss2022=demo-user-a,ss2022_wty=wty",
      session_idle_seconds: 300,
      tg_bot_token: "",
      tg_chat_id: "",
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "server") return mockServer;
  return originalLoad.call(this, request, parent, isMain);
};

require(path.resolve(__dirname, "../plugin/script.js"));

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body += value || ""; return this; },
  };
}

async function call(method, routePath, body, admin = false, headers = {}) {
  const handler = routes.get(`${method} ${routePath}`);
  assert(handler, `missing route ${method} ${routePath}`);
  const res = response();
  const req = {
    body: body === undefined ? "" : JSON.stringify(body),
    headers,
    query: {},
    context: admin ? { role: "admin", principal: { type: "user", roles: ["admin"] } } : { principal: { type: "anonymous" } },
  };
  await handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

(async () => {
  await global.load();
  assert(routes.size >= 10, "expected plugin routes");
  assert(crons.length >= 2, "expected maintenance jobs");

  const denied = await call("GET", "/api/sbmonitor/v1/admin/state", undefined, false);
  assert.strictEqual(denied.status, 403);

  const registration = await call("POST", "/api/sbmonitor/v1/admin/registration", { name: "demo-node-01" }, true);
  assert.strictEqual(registration.status, 200);
  assert(registration.data.token);

  const agent = await call("POST", "/api/sbmonitor/v1/agent/register", {
    registration_token: registration.data.token,
    name: "demo-node-01",
    hostname: "demo-host",
    arch: "amd64",
    agent_version: "0.1.0",
  });
  assert(agent.data.node_id && agent.data.agent_token);

  const duplicate = await call("POST", "/api/sbmonitor/v1/agent/register", {
    registration_token: registration.data.token,
    name: "Duplicate",
  });
  assert.strictEqual(duplicate.status, 401);

  const firstReport = await call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id,
    timestamp: Math.floor(Date.now() / 1000),
    hostname: "demo-host",
    arch: "amd64",
    agent_version: "0.1.0",
    singbox: { running: true, version: "sing-box version 1.13.12" },
    inbounds: [{ port: 30001, type: "shadowsocks", tag: "ss2022", users: ["demo-user-a"] }],
    counters: [{ port: 30001, upload_total: 1000, download_total: 2000, upload_rate: 100, download_rate: 200 }],
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });
  assert.strictEqual(firstReport.status, 200);

  await call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id,
    timestamp: Math.floor(Date.now() / 1000),
    singbox: { running: true, version: "sing-box version 1.13.12" },
    inbounds: [{ port: 30001, type: "shadowsocks", tag: "ss2022", users: ["demo-user-a"] }],
    counters: [{ port: 30001, upload_total: 1600, download_total: 3000, upload_rate: 120, download_rate: 220 }],
    events: ["WARN test timeout"],
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });

  const dashboard = await call("GET", "/api/sbmonitor/v1/admin/state", undefined, true);
  assert.strictEqual(dashboard.data.nodes.length, 1);
  assert.strictEqual(dashboard.data.nodes[0].name, "demo-node-01");
  assert.strictEqual(dashboard.data.nodes[0].ports[0].displayName, "demo-user-a");
  assert.strictEqual(dashboard.data.nodes[0].ports[0].today.total, 1600);
  assert.strictEqual(dashboard.data.events.length, 1);

  for (const invalid of [null, [], "text", 123]) {
    const result = await call("POST", "/api/sbmonitor/v1/admin/registration", invalid, true);
    assert.strictEqual(result.status, 400, "non-object JSON must be rejected");
  }
  const crossSite = await call("POST", "/api/sbmonitor/v1/admin/registration", {name:"bad"}, true, {"sec-fetch-site":["cross-site"]});
  assert.strictEqual(crossSite.status, 403);
  const forged = await call("POST", "/api/sbmonitor/v1/agent/report", {node_id:agent.data.node_id}, false, {authorization:"Bearer invalid"});
  assert.strictEqual(forged.status, 401);
  const unusual = await call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id, timestamp: 1e100,
    inbounds: [null], counters: [null],
  }, false, {authorization:`Bearer ${agent.data.agent_token}`});
  assert.strictEqual(unusual.status, 200, "invalid clock and null entries must not crash");

  // --- watched-user activity / online detection ---
  const watchReport = await call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id,
    timestamp: Math.floor(Date.now() / 1000),
    singbox: { running: true, version: "sing-box version 1.14.1" },
    inbounds: [{ port: 30001, type: "shadowsocks", tag: "ss2022", users: ["demo-user-a"] }],
    counters: [{ port: 30001, upload_total: 1800, download_total: 3400, upload_rate: 90, download_rate: 180 }],
    activity: [{ tag: "ss2022", conn_count: 5, last_active_unix: Math.floor(Date.now() / 1000), last_source: "203.0.113.7:51000", domains: ["www.example.org", "img.example.net"], probes: 3 }],
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });
  assert.strictEqual(watchReport.status, 200);

  const watch = await call("GET", "/api/sbmonitor/v1/admin/watch", undefined, true);
  assert.strictEqual(watch.status, 200);
  const watchedRow = watch.data.watched.find((row) => row.tag === "ss2022");
  assert(watchedRow, "watched row for ss2022 expected");
  assert.strictEqual(watchedRow.label, "demo-user-a");
  assert.strictEqual(watchedRow.online, true, "user should be online after activity");
  assert(watchedRow.domains.includes("www.example.org"), "real domain captured");
  const onlineEvent = watch.data.events.find((event) => event.kind === "online" && event.label === "demo-user-a");
  assert(onlineEvent, "online event expected");
  assert(Array.isArray(onlineEvent.domains) && onlineEvent.domains.includes("img.example.net"), "event carries domains");
  const watchDenied = await call("GET", "/api/sbmonitor/v1/admin/watch", undefined, false);
  assert.strictEqual(watchDenied.status, 403, "watch endpoint must require admin");

  // --- live-connection tracking: real online / real offline ---
  const RealDate = Date;
  let clock = 0;
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + clock); }
    static now() { return RealDate.now() + clock; }
  };
  const unixNow = () => Math.floor(Date.now() / 1000);
  const liveReport = (activity) => call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id,
    timestamp: unixNow(),
    singbox: { running: true, version: "sing-box version 1.14.1" },
    inbounds: [
      { port: 30001, type: "shadowsocks", tag: "ss2022", users: ["demo-user-a"] },
      { port: 36980, type: "shadowsocks", tag: "ss2022_wty", users: ["WTY"] },
    ],
    counters: [],
    activity,
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });
  const wty = (fields) => [{ tag: "ss2022_wty", conn_count: 0, live: 0, live_tracked: true, ...fields }];
  const watchData = async () => (await call("GET", "/api/sbmonitor/v1/admin/watch", undefined, true)).data;
  const wtyRow = async () => (await watchData()).watched.find((row) => row.tag === "ss2022_wty");
  const wtyEvents = async () => (await watchData()).events.filter((event) => event.label === "wty");
  const checkOffline = crons.find((job) => job.handler.name === "checkOffline").handler;

  // A lone short request (one connection, already closed) is never announced.
  await liveReport(wty({ conn_count: 1, visits: [{ t: unixNow(), host: "ocsp.example.net" }] }));
  assert.strictEqual((await wtyRow()).online, false, "a single short request is not online yet");
  clock += 90000;
  await liveReport([]);
  checkOffline();
  assert.strictEqual((await wtyEvents()).length, 0, "an unconfirmed blip produces no online/offline event");

  // One connection that stays open is confirmed after online_confirm_seconds.
  const sessionStartUnix = unixNow();
  await liveReport(wty({ conn_count: 1, live: 1, visits: [{ t: sessionStartUnix, host: "video.example.org" }] }));
  assert.strictEqual((await wtyRow()).online, false, "held connection is pending until confirmed");
  clock += 20000;
  await liveReport(wty({ live: 1 }));
  assert.strictEqual((await wtyRow()).online, true, "a connection held past the confirm window is online");
  let events = await wtyEvents();
  assert.strictEqual(events.filter((event) => event.kind === "online").length, 1);
  assert.strictEqual(RealDate.parse(events[0].time), sessionStartUnix * 1000, "online time is when the first connection was logged");

  // A long stream over one open connection must not go offline, however long
  // it runs without any new connection (this was the false 5-minute offline).
  for (let i = 0; i < 6; i++) {
    clock += 300000;
    await liveReport(wty({ live: 1 }));
    checkOffline();
  }
  assert.strictEqual((await wtyRow()).online, true, "open connection keeps the session online");

  const lastVisitUnix = unixNow();
  await liveReport(wty({ conn_count: 2, live: 2, visits: [
    { t: lastVisitUnix, host: "video.example.org" },
    { t: lastVisitUnix, host: "cdn.example.org" },
  ] }));
  const lastActiveMs = Date.now();

  // Everything closes: still online inside the grace, offline after it.
  clock += 30000;
  await liveReport([]);
  checkOffline();
  assert.strictEqual((await wtyRow()).online, true, "inside the offline grace");
  clock += 40000;
  await liveReport([]);
  checkOffline();
  assert.strictEqual((await wtyRow()).online, false, "offline once nothing is open past the grace");
  events = await wtyEvents();
  const offlineEvent = events.find((event) => event.kind === "offline");
  assert(offlineEvent, "offline event expected");
  assert(Math.abs(RealDate.parse(offlineEvent.time) - lastActiveMs) < 2000, "offline time is the last active moment, not when the check ran");
  assert.strictEqual(RealDate.parse(offlineEvent.sessionStart), sessionStartUnix * 1000);
  assert.strictEqual(offlineEvent.sessionConn, 3);
  assert.deepStrictEqual(offlineEvent.visits.map((visit) => [visit.host, visit.count]), [["video.example.org", 2], ["cdn.example.org", 1]]);
  assert(!offlineEvent.visits.some((visit) => visit.host === "ocsp.example.net"), "the earlier blip is not part of this session");

  const queued = JSON.parse(fs.readFileSync(path.join(storage, "state.json"), "utf8")).pending.map((item) => item.text);
  const offlineText = queued.find((text) => text.includes("wty 下线"));
  assert(offlineText, "offline Telegram message queued");
  assert(/上线  \d\d:\d\d:\d\d/.test(offlineText) && /下线  \d\d:\d\d:\d\d/.test(offlineText), "offline message carries start and end time");
  assert(offlineText.includes("时长  30m"), `duration excludes the grace: ${offlineText}`);
  assert(/\d\d:\d\d:\d\d  video\.example\.org ×2（至 \d\d:\d\d:\d\d）/.test(offlineText), "visited domain with first/last time");
  assert(/\d\d:\d\d:\d\d  cdn\.example\.org/.test(offlineText), "every visited domain is listed");

  // The agent goes silent mid-session: do not guess offline while it is unknown.
  await liveReport(wty({ conn_count: 2, live: 1, visits: [{ t: unixNow(), host: "video.example.org" }] }));
  assert.strictEqual((await wtyRow()).online, true);
  clock += 120000;
  checkOffline();
  assert.strictEqual((await wtyRow()).online, true, "silent agent: session is held, not closed");
  clock += 600000;
  checkOffline();
  assert.strictEqual((await wtyRow()).online, false, "agent lost for good: session closed");
  assert((await wtyEvents()).find((event) => event.kind === "offline" && event.note), "closed with a note");
  global.Date = RealDate;

  await global.unload();
  assert(fs.existsSync(path.join(storage, "state.json")));
  const saved = JSON.parse(fs.readFileSync(path.join(storage, "state.json"), "utf8"));
  const node = saved.nodes[agent.data.node_id];
  node.lastSeen = new Date(Date.now() - 120000).toISOString();
  node.inbounds = [{port:30001, type:"shadowsocks", tag:"test", users:[]}];
  node.current = {30001:{port:30001, uploadRate:500, downloadRate:800}};
  fs.writeFileSync(path.join(storage, "state.json"), JSON.stringify(saved));
  await global.load();
  const offline = await call("GET", "/api/sbmonitor/v1/admin/state", undefined, true);
  assert.strictEqual(offline.data.nodes[0].online, false);
  assert.strictEqual(offline.data.nodes[0].ports[0].downloadRate, 0);
  assert(!JSON.stringify(offline.data).includes(agent.data.agent_token));
  assert(!JSON.stringify(offline.data).includes(node.agentTokenHash));
  await global.unload();
  fs.writeFileSync(path.join(storage, "state.json"), "{broken");
  await assert.rejects(global.load(), "corrupt state must not be silently reset");
  assert.strictEqual(fs.readFileSync(path.join(storage, "state.json"), "utf8"), "{broken");
  fs.rmSync(storage, { recursive: true, force: true });
  console.log("plugin integration test: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
