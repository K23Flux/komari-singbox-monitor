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
  async getConfig() { return { timezone_offset: 8, offline_seconds: 60, history_days: 30 }; },
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

  const registration = await call("POST", "/api/sbmonitor/v1/admin/registration", { name: "Tokyo-02" }, true);
  assert.strictEqual(registration.status, 200);
  assert(registration.data.token);

  const agent = await call("POST", "/api/sbmonitor/v1/agent/register", {
    registration_token: registration.data.token,
    name: "Tokyo-02",
    hostname: "jp-test",
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
    hostname: "jp-test",
    arch: "amd64",
    agent_version: "0.1.0",
    singbox: { running: true, version: "sing-box version 1.13.12" },
    inbounds: [{ port: 55101, type: "shadowsocks", tag: "ss2022", users: ["LF"] }],
    counters: [{ port: 55101, upload_total: 1000, download_total: 2000, upload_rate: 100, download_rate: 200 }],
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });
  assert.strictEqual(firstReport.status, 200);

  await call("POST", "/api/sbmonitor/v1/agent/report", {
    node_id: agent.data.node_id,
    timestamp: Math.floor(Date.now() / 1000),
    singbox: { running: true, version: "sing-box version 1.13.12" },
    inbounds: [{ port: 55101, type: "shadowsocks", tag: "ss2022", users: ["LF"] }],
    counters: [{ port: 55101, upload_total: 1600, download_total: 3000, upload_rate: 120, download_rate: 220 }],
    events: ["WARN test timeout"],
  }, false, { authorization: `Bearer ${agent.data.agent_token}` });

  const dashboard = await call("GET", "/api/sbmonitor/v1/admin/state", undefined, true);
  assert.strictEqual(dashboard.data.nodes.length, 1);
  assert.strictEqual(dashboard.data.nodes[0].name, "Tokyo-02");
  assert.strictEqual(dashboard.data.nodes[0].ports[0].displayName, "LF");
  assert.strictEqual(dashboard.data.nodes[0].ports[0].today.total, 1600);
  assert.strictEqual(dashboard.data.events.length, 1);

  await global.unload();
  assert(fs.existsSync(path.join(storage, "state.json")));
  fs.rmSync(storage, { recursive: true, force: true });
  console.log("plugin integration test: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
