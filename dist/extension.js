"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var http2 = __toESM(require("http"));
var vscode5 = __toESM(require("vscode"));

// src/proxy-server.ts
var http = __toESM(require("http"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var vscode2 = __toESM(require("vscode"));

// src/copilot-auth.ts
var vscode = __toESM(require("vscode"));
var _cached = null;
var REFRESH_BUFFER_SECS = 60;
function resolveBaseUrl(token) {
  if (token.includes("proxy-ep=proxy.enterprise.")) {
    return "https://api.enterprise.githubcopilot.com";
  }
  if (token.includes("proxy-ep=proxy.business.")) {
    return "https://api.business.githubcopilot.com";
  }
  return "https://api.githubcopilot.com";
}
function isExpiringSoon(expiresAt) {
  return Date.now() / 1e3 > expiresAt - REFRESH_BUFFER_SECS;
}
async function getCopilotToken() {
  if (_cached && !isExpiringSoon(_cached.expiresAt)) {
    return { token: _cached.token, baseUrl: _cached.baseUrl };
  }
  const githubToken = await getGitHubToken();
  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${githubToken}`,
      "Editor-Version": "vscode/1.99.0",
      "Editor-Plugin-Version": "copilot/1.0.0",
      "User-Agent": "GithubCopilot/1.0.0"
    }
  });
  if (!resp.ok) {
    throw new Error(`Failed to get Copilot token: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  const expiresAt = data.expires_at ?? Math.floor(Date.now() / 1e3) + 1800;
  _cached = {
    token: data.token,
    expiresAt,
    baseUrl: resolveBaseUrl(data.token)
  };
  return { token: _cached.token, baseUrl: _cached.baseUrl };
}
async function getGitHubToken() {
  let session = await vscode.authentication.getSession("github", ["read:user"], { silent: true });
  if (!session) {
    session = await vscode.authentication.getSession("github", ["read:user"], { createIfNone: true });
  }
  if (!session) {
    throw new Error("Not signed in to GitHub. Please sign in via VS Code (Accounts menu).");
  }
  return session.accessToken;
}
function invalidateCache() {
  _cached = null;
}
function getCachedTokenString() {
  return _cached?.token ?? null;
}
function getCachedExpiresAt() {
  return _cached?.expiresAt ?? null;
}

// src/translate.ts
function anthropicToOpenAI(body) {
  const messages = [];
  const system = body.system;
  if (system) {
    let text;
    if (Array.isArray(system)) {
      text = system.filter((b) => typeof b === "object").map((b) => b.text ?? "").join(" ");
    } else {
      text = String(system);
    }
    if (text.trim()) {
      messages.push({ role: "system", content: text });
    }
  }
  for (const msg of body.messages ?? []) {
    const role = msg.role ?? "user";
    let content;
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null) {
          if (block.type === "text") {
            parts.push(block.text ?? "");
          } else if (block.type === "tool_result") {
            parts.push(String(block.content ?? ""));
          }
        } else {
          parts.push(String(block));
        }
      }
      content = parts.join("\n");
    } else {
      content = String(msg.content ?? "");
    }
    messages.push({ role, content });
  }
  const result = {
    model: body.model ?? "gpt-4o",
    messages
  };
  if (body.max_tokens !== void 0)
    result.max_tokens = body.max_tokens;
  if (body.temperature !== void 0)
    result.temperature = body.temperature;
  if (body.top_p !== void 0)
    result.top_p = body.top_p;
  if (body.stream !== void 0)
    result.stream = body.stream;
  if (body.stop_sequences !== void 0)
    result.stop = body.stop_sequences;
  if (body.tools !== void 0)
    result.tools = body.tools;
  return result;
}
function openAIToAnthropicResponse(body, model) {
  const choices = body.choices ?? [];
  let text = "";
  let stopReason = "end_turn";
  if (choices.length > 0) {
    const msg = choices[0].message ?? {};
    text = String(msg.content ?? "");
    const finish = String(choices[0].finish_reason ?? "stop");
    stopReason = finish === "stop" ? "end_turn" : finish;
  }
  const usage = body.usage ?? {};
  return {
    id: body.id ?? "",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0
    }
  };
}
function stripStreamOptionsForClaude(body, model) {
  if (model.toLowerCase().includes("claude")) {
    const { stream_options: _so, ...rest } = body;
    return rest;
  }
  return body;
}

// src/proxy-server.ts
var COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.99.0",
  "x-github-api-version": "2025-04-01"
};
var FALLBACK_MODELS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.6-fast",
  "gpt-4o",
  "gpt-4o-mini-2024-07-18",
  "gpt-4o-2024-11-20",
  "gpt-4o-2024-08-06",
  "gemini-3.5-flash",
  "gemini-3-flash-preview"
];
var _lastRequestTime = 0;
function checkRateLimit(cfg) {
  if (cfg.rateLimitSeconds <= 0)
    return { allowed: true, waitSecs: 0 };
  const now = Date.now() / 1e3;
  const elapsed = now - _lastRequestTime;
  const waitNeeded = cfg.rateLimitSeconds - elapsed;
  if (waitNeeded > 0) {
    return { allowed: false, waitSecs: waitNeeded };
  }
  _lastRequestTime = now;
  return { allowed: true, waitSecs: 0 };
}
function markRequestTime() {
  _lastRequestTime = Date.now() / 1e3;
}
var _startTime = Date.now();
var _sessionMetrics = {
  total_requests: 0,
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
  total_tokens: 0,
  per_model: {}
};
var _cumulativeMetrics = {
  total_requests: 0,
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
  total_tokens: 0,
  per_model: {}
};
var _metricsFilePath;
function _initModelMetrics() {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, avg_latency_ms: 0, first_seen: null, last_seen: null, _latency_sum: 0 };
}
function recordRequest(model, promptTokens, completionTokens, latencyMs) {
  const now = Math.floor(Date.now() / 1e3);
  const total = promptTokens + completionTokens;
  _sessionMetrics.total_requests++;
  _sessionMetrics.total_prompt_tokens += promptTokens;
  _sessionMetrics.total_completion_tokens += completionTokens;
  _sessionMetrics.total_tokens += total;
  if (!_sessionMetrics.per_model[model])
    _sessionMetrics.per_model[model] = _initModelMetrics();
  const sm = _sessionMetrics.per_model[model];
  sm.requests++;
  sm.prompt_tokens += promptTokens;
  sm.completion_tokens += completionTokens;
  sm.total_tokens += total;
  sm._latency_sum += latencyMs;
  sm.avg_latency_ms = sm._latency_sum / sm.requests;
  if (!sm.first_seen)
    sm.first_seen = now;
  sm.last_seen = now;
  _cumulativeMetrics.total_requests++;
  _cumulativeMetrics.total_prompt_tokens += promptTokens;
  _cumulativeMetrics.total_completion_tokens += completionTokens;
  _cumulativeMetrics.total_tokens += total;
  if (!_cumulativeMetrics.per_model[model])
    _cumulativeMetrics.per_model[model] = _initModelMetrics();
  const cm = _cumulativeMetrics.per_model[model];
  cm.requests++;
  cm.prompt_tokens += promptTokens;
  cm.completion_tokens += completionTokens;
  cm.total_tokens += total;
  cm._latency_sum += latencyMs;
  cm.avg_latency_ms = cm._latency_sum / cm.requests;
  if (!cm.first_seen)
    cm.first_seen = now;
  cm.last_seen = now;
  if (_metricsFilePath) {
    try {
      fs.writeFileSync(_metricsFilePath, JSON.stringify(_cumulativeMetrics, null, 2), "utf8");
    } catch {
    }
  }
}
function resetMetrics() {
  _sessionMetrics.total_requests = 0;
  _sessionMetrics.total_prompt_tokens = 0;
  _sessionMetrics.total_completion_tokens = 0;
  _sessionMetrics.total_tokens = 0;
  _sessionMetrics.per_model = {};
  _cumulativeMetrics = { total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, per_model: {} };
  if (_metricsFilePath) {
    try {
      fs.writeFileSync(_metricsFilePath, JSON.stringify(_cumulativeMetrics, null, 2), "utf8");
    } catch {
    }
  }
}
function getSessionMetrics() {
  return { ..._sessionMetrics, uptime_seconds: (Date.now() - _startTime) / 1e3 };
}
function getCumulativeMetrics() {
  return _cumulativeMetrics;
}
var _exchanges = [];
var MAX_EXCHANGES = 200;
var _exchangesFilePath;
function _bodyToText(body) {
  const parts = [];
  let system = body.system;
  if (!system) {
    for (const m of body.messages ?? []) {
      if (m.role === "system") {
        system = String(m.content ?? "");
        break;
      }
    }
  }
  if (system) {
    if (Array.isArray(system)) {
      system = system.map((b) => String(b.text ?? "")).join(" ");
    }
    parts.push(`[SYSTEM]
${system}`);
  }
  for (const m of body.messages ?? []) {
    if (m.role === "system")
      continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
    }
    parts.push(`[${String(m.role ?? "").toUpperCase()}]
${String(content ?? "")}`);
  }
  return parts.join("\n\n");
}
function storeExchange(requestId, model, requestBody, responseText) {
  let promptTokens = 0;
  for (const m of requestBody.messages ?? []) {
    promptTokens += Math.floor(String(m.content ?? "").length / 4);
  }
  const entry = {
    request_id: requestId,
    model,
    input: _bodyToText(requestBody),
    output: responseText,
    prompt_tokens: promptTokens,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  _exchanges.unshift(entry);
  if (_exchanges.length > MAX_EXCHANGES)
    _exchanges.pop();
  if (_exchangesFilePath) {
    try {
      fs.appendFileSync(_exchangesFilePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
    }
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
function html(res, content) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}
function getProxyConfig() {
  const cfg = vscode2.workspace.getConfiguration("copilotProxy");
  return {
    enabled: cfg.get("enabled", true),
    proxyPort: cfg.get("proxyPort", 4242),
    accountType: cfg.get("accountType", "individual"),
    rateLimitSeconds: cfg.get("rateLimitSeconds", 0),
    rateLimitWait: cfg.get("rateLimitWait", false),
    logRequests: cfg.get("logRequests", false),
    showToken: cfg.get("showToken", false)
  };
}
var ProxyServer = class {
  constructor(outputChannel2, storageUri) {
    this.server = null;
    this._port = 4242;
    this.outputChannel = outputChannel2;
    if (storageUri) {
      const dir = storageUri.fsPath;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
      }
      _exchangesFilePath = path.join(dir, "exchanges.jsonl");
      _metricsFilePath = path.join(dir, "metrics.json");
      if (fs.existsSync(_metricsFilePath)) {
        try {
          _cumulativeMetrics = JSON.parse(fs.readFileSync(_metricsFilePath, "utf8"));
        } catch {
        }
      }
      if (fs.existsSync(_exchangesFilePath)) {
        try {
          const lines = fs.readFileSync(_exchangesFilePath, "utf8").split("\n").filter(Boolean);
          for (const line of lines.slice(-MAX_EXCHANGES).reverse()) {
            try {
              _exchanges.push(JSON.parse(line));
            } catch {
            }
          }
        } catch {
        }
      }
    }
  }
  get port() {
    return this._port;
  }
  get isRunning() {
    return this.server !== null;
  }
  start(port) {
    return new Promise((resolve, reject) => {
      this._port = port;
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.outputChannel.appendLine(`[proxy] Unhandled error: ${err}`);
          json(res, { error: { message: String(err), type: "proxy_error" } }, 500);
        });
      });
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.outputChannel.appendLine(`[proxy] Listening on port ${port}`);
        resolve();
      });
    });
  }
  stop() {
    this.server?.close();
    this.server = null;
    this.outputChannel.appendLine("[proxy] Server stopped.");
  }
  // ── Request router ──────────────────────────────────────────────────────────
  async handleRequest(req, res) {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const cfg = getProxyConfig();
    this.outputChannel.appendLine(`[proxy] ${method} ${url}`);
    if (method === "GET") {
      if (url === "/" || url === "") {
        res.writeHead(307, { Location: "/dashboard" });
        res.end();
        return;
      }
      if (url === "/health")
        return this.handleHealth(res);
      if (url === "/metrics")
        return json(res, getSessionMetrics());
      if (url === "/metrics/cumulative")
        return json(res, getCumulativeMetrics());
      if (url === "/dashboard")
        return html(res, DASHBOARD_HTML);
      if (url === "/compilation")
        return html(res, COMPILATION_HTML);
      if (url === "/compilation/data")
        return json(res, _exchanges);
      if (url === "/usage")
        return this.handleUsage(res);
      if (url === "/quota")
        return this.handleQuota(res);
      if (url === "/token")
        return this.handleToken(res, cfg);
      if (url.startsWith("/v1/models"))
        return this.handleModels(res, cfg);
      if (url === "/login/check")
        return json(res, { authenticated: true });
    }
    if (method === "POST") {
      if (url === "/token/refresh")
        return this.handleTokenRefresh(res);
      if (url === "/v1/chat/completions")
        return this.handleChat(req, res, cfg);
      if (url === "/v1/messages")
        return this.handleMessages(req, res, cfg);
      if (url === "/v1/messages/count_tokens")
        return this.handleCountTokens(req, res);
      if (url === "/v1/embeddings")
        return this.handleEmbeddings(req, res, cfg);
    }
    json(res, { error: { message: `Not found: ${method} ${url}`, type: "not_found" } }, 404);
  }
  // ── Health ────────────────────────────────────────────────────────────────
  handleHealth(res) {
    const tokenStr = getCachedTokenString();
    const expiresAt = getCachedExpiresAt();
    json(res, {
      status: "ok",
      version: "0.1.0",
      auth: {
        github_token: "managed-by-vscode",
        copilot_token: tokenStr ? "present" : "missing",
        copilot_token_expires_at: expiresAt
      }
    });
  }
  // ── Usage ────────────────────────────────────────────────────────────────
  async handleUsage(res) {
    try {
      const githubToken = await getGitHubToken();
      const resp = await fetch("https://api.github.com/copilot_internal/user", {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: "application/json",
          "User-Agent": "copilot-proxy/0.1.0"
        }
      });
      if (resp.ok) {
        json(res, await resp.json());
      } else {
        json(res, { error: `GitHub API returned ${resp.status}` }, resp.status);
      }
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }
  // ── Quota ─────────────────────────────────────────────────────────────────
  async handleQuota(res) {
    try {
      const { token } = await getCopilotToken();
      const expiresAt = getCachedExpiresAt();
      const claims = {};
      for (const part of token.split(";")) {
        const eq = part.indexOf("=");
        if (eq >= 0) {
          claims[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
      }
      const BOOL_FLAGS = {
        chat: "chat",
        ssc: "suggestions",
        sn: "snippy",
        malfil: "malicious_filter",
        editor_preview_features: "editor_preview_features",
        agent_mode: "agent_mode",
        agent_mode_auto_approval: "agent_mode_auto_approval",
        mcp: "mcp",
        ccr: "code_review",
        client_byok: "bring_your_own_key",
        blackbird_external_indexing: "external_indexing"
      };
      const features = {};
      for (const [key, label] of Object.entries(BOOL_FLAGS)) {
        if (key in claims) {
          features[label] = !["0", "false", ""].includes(claims[key]);
        }
      }
      const cfg = getProxyConfig();
      json(res, {
        auth_ok: true,
        sku: claims.sku ?? "unknown",
        account_type: cfg.accountType,
        proxy_endpoint: claims["proxy-ep"],
        token_expires_at: expiresAt,
        st: claims.st,
        features
      });
    } catch (err) {
      json(res, { error: String(err), auth_ok: false }, 500);
    }
  }
  // ── Token debug ───────────────────────────────────────────────────────────
  handleToken(res, cfg) {
    if (!cfg.showToken) {
      json(res, { error: "Set copilotProxy.showToken=true to enable this endpoint." }, 403);
      return;
    }
    const t = getCachedTokenString();
    json(res, { token: t ?? null, expires_at: getCachedExpiresAt() });
  }
  // ── Token refresh ─────────────────────────────────────────────────────────
  handleTokenRefresh(res) {
    invalidateCache();
    this.outputChannel.appendLine("[proxy] Token cache invalidated.");
    json(res, { status: "ok", message: "Token cache cleared. Next request will fetch a fresh token." });
  }
  // ── Models ────────────────────────────────────────────────────────────────
  async handleModels(res, cfg) {
    try {
      const { token, baseUrl } = await getCopilotToken();
      const modelsUrl = baseUrl.includes("enterprise") || baseUrl.includes("business") ? `${baseUrl}/models` : `${baseUrl}/models`;
      const resp = await fetch(modelsUrl, {
        headers: {
          ...COPILOT_HEADERS,
          Authorization: `Bearer ${token}`
        }
      });
      if (resp.ok) {
        json(res, await resp.json());
      } else {
        json(res, _fallbackModels());
      }
    } catch {
      json(res, _fallbackModels());
    }
  }
  // ── Embeddings passthrough ────────────────────────────────────────────────
  async handleEmbeddings(req, res, cfg) {
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr);
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/embeddings`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      json(res, data, resp.status);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }
  // ── count_tokens ──────────────────────────────────────────────────────────
  async handleCountTokens(req, res) {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr);
    const messages = body.messages ?? [];
    const system = String(body.system ?? "");
    let totalChars = system.length;
    for (const m of messages)
      totalChars += String(m.content ?? "").length;
    json(res, { input_tokens: Math.floor(totalChars / 4) });
  }
  // ── Chat completions ──────────────────────────────────────────────────────
  async handleChat(req, res, cfg) {
    const { allowed, waitSecs } = checkRateLimit(cfg);
    if (!allowed) {
      if (cfg.rateLimitWait) {
        await new Promise((r) => setTimeout(r, waitSecs * 1e3));
      } else {
        json(res, { error: { message: `Rate limit: wait ${waitSecs.toFixed(1)}s before next request.`, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429);
        return;
      }
    }
    markRequestTime();
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr);
    const model = String(body.model ?? "gpt-4o");
    const isStream = Boolean(body.stream);
    const requestId = crypto.randomUUID();
    const start = Date.now();
    if (cfg.logRequests) {
      this.outputChannel.appendLine(`[proxy] chat request model=${model} stream=${isStream}`);
    }
    try {
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/chat/completions`;
      const headers = { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const cleanBody = stripStreamOptionsForClaude(body, model);
      if (isStream) {
        await this._streamChat(res, url, headers, cleanBody, model, requestId, start, cfg);
      } else {
        await this._jsonChat(res, url, headers, cleanBody, model, requestId, start, cfg);
      }
    } catch (err) {
      this.outputChannel.appendLine(`[proxy] chat error: ${err}`);
      json(res, { error: { message: String(err), type: "proxy_error" } }, 500);
    }
  }
  async _jsonChat(res, url, headers, body, model, requestId, start, cfg) {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const latencyMs = Date.now() - start;
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error ?? data;
      const errMsg = String(err.message ?? resp.statusText);
      json(res, { error: { message: errMsg, type: "upstream_error", code: String(resp.status) } }, resp.status);
      return;
    }
    const choices = data.choices ?? [];
    const responseText = choices.length > 0 ? String(choices[0].message?.content ?? "") : "";
    storeExchange(requestId, model, body, responseText);
    const usage = data.usage ?? {};
    recordRequest(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, latencyMs);
    if (cfg.logRequests) {
      this.outputChannel.appendLine(`[proxy] chat response model=${model} latency=${latencyMs}ms`);
    }
    json(res, data);
  }
  async _streamChat(res, url, headers, body, model, requestId, start, cfg) {
    const isClause = model.toLowerCase().includes("claude");
    const streamBody = isClause ? body : { ...body, stream_options: { include_usage: true } };
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(streamBody)
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        let errMsg = errText;
        try {
          const errData = JSON.parse(errText);
          errMsg = String(errData?.error?.message ?? errText);
        } catch {
        }
        res.write(`data: ${JSON.stringify({ error: { message: errMsg, type: "upstream_error", code: String(resp.status) } })}

`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      let promptTokens = 0;
      let completionTokens = 0;
      const responseParts = [];
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:"))
            continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]")
            continue;
          try {
            const data = JSON.parse(payload);
            const usage = data.usage;
            if (usage) {
              promptTokens = usage.prompt_tokens ?? promptTokens;
              completionTokens = usage.completion_tokens ?? completionTokens;
            }
            for (const choice of data.choices ?? []) {
              const delta = choice.delta ?? {};
              if (delta.content)
                responseParts.push(String(delta.content));
            }
          } catch {
          }
        }
      }
      const latencyMs = Date.now() - start;
      storeExchange(requestId, model, body, responseParts.join(""));
      recordRequest(model, promptTokens, completionTokens, latencyMs);
      res.end();
    } catch (err) {
      this.outputChannel.appendLine(`[proxy] stream error: ${err}`);
      res.write(`data: ${JSON.stringify({ error: { message: String(err), type: "proxy_error" } })}

`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
  // ── Anthropic /v1/messages ────────────────────────────────────────────────
  async handleMessages(req, res, cfg) {
    const { allowed, waitSecs } = checkRateLimit(cfg);
    if (!allowed) {
      if (cfg.rateLimitWait) {
        await new Promise((r) => setTimeout(r, waitSecs * 1e3));
      } else {
        json(res, { error: { message: `Rate limit: wait ${waitSecs.toFixed(1)}s`, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429);
        return;
      }
    }
    markRequestTime();
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr);
    const model = String(body.model ?? "claude-sonnet-4.6");
    const isStream = Boolean(body.stream);
    const start = Date.now();
    try {
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/chat/completions`;
      const headers = { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const oaiBody = anthropicToOpenAI(body);
      if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(oaiBody) });
        if (!resp.ok || !resp.body) {
          res.write(`data: ${JSON.stringify({ error: { message: await resp.text(), code: resp.status } })}

`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          res.write(decoder.decode(value, { stream: true }));
        }
        recordRequest(model, 0, 0, Date.now() - start);
        res.end();
      } else {
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(oaiBody) });
        const oaiData = await resp.json();
        if (!resp.ok) {
          json(res, { error: { message: String(oaiData.error?.message ?? resp.statusText) } }, resp.status);
          return;
        }
        const anthropicResp = openAIToAnthropicResponse(oaiData, model);
        const usage = oaiData.usage ?? {};
        recordRequest(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, Date.now() - start);
        json(res, anthropicResp);
      }
    } catch (err) {
      json(res, { error: { message: String(err) } }, 500);
    }
  }
};
function _fallbackModels() {
  return {
    object: "list",
    data: FALLBACK_MODELS.map((id) => ({
      id,
      object: "model",
      created: 17e8,
      owned_by: "github-copilot"
    }))
  };
}
var DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Proxy - Usage</title>
<style>
  :root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--green:#3fb950;--blue:#58a6ff;--purple:#bc8cff;--yellow:#d29922;--red:#f85149;--muted:#8b949e;--text:#e6edf3}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
  h1{font-size:1.35rem;font-weight:700;margin-bottom:3px}
  .sub{color:var(--muted);font-size:.82rem;margin-bottom:22px}
  .hrow{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px}
  .btn{background:#21262d;border:1px solid var(--bd);color:var(--text);padding:5px 13px;border-radius:6px;font-size:.78rem;cursor:pointer}
  .btn:hover{background:#30363d}
  .ts{font-size:.73rem;color:var(--muted)}
  .sec{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:16px 18px;margin-bottom:18px}
  .sec-title{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
  .kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:12px;margin-bottom:18px}
  .kcard{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:14px 16px}
  .klabel{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
  .kval{font-size:1.7rem;font-weight:800;line-height:1.1}
  .ksub{font-size:.7rem;color:var(--muted);margin-top:3px}
  .qgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
  @media(max-width:700px){.qgrid,.two{grid-template-columns:1fr}}
  .qcard{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:16px}
  .qhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px}
  .qname{font-size:.95rem;font-weight:600}
  .qtrack{height:6px;background:var(--bd);border-radius:3px;overflow:hidden;margin-bottom:7px}
  .qfill{height:100%;border-radius:3px}
  .qfoot{display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;font-size:.81rem}
  th{text-align:left;padding:6px 11px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--bd)}
  td{padding:7px 11px;border-bottom:1px solid var(--bd);font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(255,255,255,.025)}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:600}
  .bg{background:#0f2a18;color:var(--green)}.bb{background:#0d1f33;color:var(--blue)}
  .bp{background:#1a1030;color:var(--purple)}.by{background:#261d07;color:var(--yellow)}
  .br{background:#2d0f0e;color:var(--red)}.bm{background:#21262d;color:var(--muted)}
  .green{color:var(--green)}.blue{color:var(--blue)}.purple{color:var(--purple)}
  .yellow{color:var(--yellow)}.red{color:var(--red)}.muted{color:var(--muted)}
  .brow{display:flex;align-items:center;gap:9px;margin-bottom:8px}
  .blabel{width:140px;font-size:.76rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .btrack{flex:1;height:7px;background:var(--bd);border-radius:4px;overflow:hidden}
  .bfill{height:100%;border-radius:4px;background:var(--blue)}
  .bval{width:54px;font-size:.74rem;text-align:right}
  .irow{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bd);font-size:.8rem}
  .irow:last-child{border-bottom:none}
  .ikey{color:var(--muted)}.ival{font-weight:500;text-align:right}
  .fgrid{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
  .tabs{display:flex;gap:2px;margin-bottom:0}
  .tab{padding:5px 14px;border-radius:6px;font-size:.78rem;cursor:pointer;border:1px solid transparent;color:var(--muted)}
  .tab.active{background:#21262d;border-color:var(--bd);color:var(--text)}
  .tab-pane{display:none}.tab-pane.active{display:block}
</style>
</head>
<body>
<div class="hrow">
  <div><h1>&#128737; Copilot Proxy</h1><p class="sub" id="sub">Loading...</p></div>
  <div style="display:flex;gap:9px;align-items:center">
    <span class="ts" id="ts"></span>
    <a href="/compilation" class="btn" style="text-decoration:none">&#128269; Message Inspector</a>
    <button class="btn" onclick="load()">&#8635; Refresh</button>
  </div>
</div>
<div style="font-size:.7rem;color:var(--muted);margin-bottom:24px">Author: <span style="color:var(--blue)">Ritesh Agarwal</span> &nbsp;&middot;&nbsp; <a href="https://buymeacoffee.com/riteshagarwal" style="color:#FFDD00;background:#000;padding:2px 16px;border-radius:4px;text-decoration:none;font-weight:600" target="_blank">&#9749; Buy me a coffee</a></div>

<div class="sec-title">GitHub Copilot Quotas</div>
<div class="qgrid" id="qgrid"><div class="qcard"><span class="muted">Loading...</span></div></div>

<div class="sec">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <span class="sec-title" style="margin-bottom:0">Model Usage (via proxy)</span>
    <div class="tabs">
      <div class="tab active" id="tab-all" onclick="sw('all')">All-time</div>
      <div class="tab" id="tab-s" onclick="sw('s')">This session</div>
    </div>
  </div>
  <div class="tab-pane active" id="pane-all">
    <div class="kgrid" id="kpi-all"></div>
    <div class="two">
      <div><div class="sec-title">Tokens by model</div><div id="bars-tok"></div></div>
      <div><div class="sec-title">Requests by model</div><div id="bars-req"></div></div>
    </div>
    <table><thead><tr><th>Model</th><th>Requests</th><th>Prompt</th><th>Completion</th><th>Total Tokens</th><th>Avg Latency</th><th>First Seen</th><th>Last Seen</th></tr></thead>
    <tbody id="tbl-all"></tbody></table>
  </div>
  <div class="tab-pane" id="pane-s">
    <div class="kgrid" id="kpi-s"></div>
    <div id="bars-s" style="margin-bottom:14px"></div>
    <table><thead><tr><th>Model</th><th>Requests</th><th>Prompt</th><th>Completion</th><th>Total Tokens</th><th>Avg Latency</th></tr></thead>
    <tbody id="tbl-s"></tbody></table>
  </div>
</div>

<div class="sec">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span class="sec-title" style="margin-bottom:0">Available Models</span>
    <span class="ts" id="models-ts"></span>
  </div>
  <div id="models-filters" class="brow" style="flex-wrap:wrap;gap:4px;margin-bottom:10px"></div>
  <table>
    <thead id="models-thead"><tr>
      <th onclick="sortBy(0)" style="cursor:pointer">Model ID &#8597;</th>
      <th onclick="sortBy(1)" style="cursor:pointer">Tier &#8597;</th>
      <th onclick="sortBy(2)" style="cursor:pointer">Family &#8597;</th>
      <th onclick="sortBy(3)" style="cursor:pointer">Context &#8597;</th>
      <th onclick="sortBy(4)" style="cursor:pointer">Max Output &#8597;</th>
      <th onclick="sortBy(5)" style="cursor:pointer">Vision &#8597;</th>
      <th onclick="sortBy(6)" style="cursor:pointer">Tools &#8597;</th>
      <th onclick="sortBy(7)" style="cursor:pointer">Thinking &#8597;</th>
      <th onclick="sortBy(8)" style="cursor:pointer">Used &#8597;</th>
    </tr></thead>
    <tbody id="models-body"><tr><td colspan="9" class="muted" style="text-align:center;padding:16px">Loading...</td></tr></tbody>
  </table>
</div>

<div class="two">
  <div class="sec"><div class="sec-title">Account &amp; Plan</div><div id="acct"></div></div>
  <div class="sec"><div class="sec-title">Features &amp; Flags</div><div id="feats"></div></div>
</div>

<script>
function sw(t){['all','s'].forEach(x=>{document.getElementById('tab-'+x).className='tab'+(t===x?' active':'');document.getElementById('pane-'+x).className='tab-pane'+(t===x?' active':'');});}
const f=n=>n==null?'&mdash;':Number(n).toLocaleString();
const ms=n=>n==null?'&mdash;':Math.round(n)+'ms';
const secs=s=>s<60?Math.round(s)+'s':s<3600?Math.floor(s/60)+'m '+Math.round(s%60)+'s':Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
function fdt(ts){if(!ts)return'&mdash;';const d=new Date(ts*1000);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function fdate(s){return s?new Date(s).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'&mdash;';}
function qc(p){return p===null?'#58a6ff':p>40?'#3fb950':p>15?'#d29922':'#f85149';}

async function load(){
  const [cum,sess,usage,mdls]=await Promise.all([
    fetch('/metrics/cumulative').then(r=>r.json()).catch(()=>({})),
    fetch('/metrics').then(r=>r.json()).catch(()=>({})),
    fetch('/usage').then(r=>r.json()).catch(()=>({})),
    fetch('/v1/models').then(r=>r.json()).catch(()=>({})),
  ]);
  renderQ(usage);renderAll(cum);renderSess(sess);renderAcct(usage);renderModels(mdls,cum);
  document.getElementById('sub').textContent='v0.1.0 uptime '+secs(sess.uptime_seconds||0)+(usage.login?' \xB7 '+usage.login:'')+(usage.copilot_plan?' \xB7 '+usage.copilot_plan+' plan':'');
  document.getElementById('ts').textContent='Updated '+new Date().toLocaleTimeString();
}

function renderQ(u){
  const snaps=(u&&u.quota_snapshots)||{};
  const order=['chat','completions','premium_interactions'];
  const labels={chat:'Chat',completions:'Completions',premium_interactions:'Premium Interactions'};
  const reset=u&&u.quota_reset_date_utc?new Date(u.quota_reset_date_utc).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'?';
  const cards=order.map(key=>{
    const q=snaps[key];if(!q)return'';
    const unl=q.unlimited,pctU=unl?0:+(100-(q.percent_remaining||0)).toFixed(1);
    const pctR=unl?null:+(q.percent_remaining||0).toFixed(1);
    const color=unl?'#58a6ff':qc(pctR);
    const ent=q.entitlement||0,rem=q.remaining??0;
    return '<div class="qcard"><div class="qhead"><span class="qname">'+labels[key]+'</span>'+(unl?'<span class="badge bb">Unlimited</span>':'<span style="color:'+color+';font-weight:700">'+pctU+'% used</span>')+'</div><div class="qtrack"><div class="qfill" style="width:'+(unl?100:pctU)+'%;background:'+color+'"></div></div><div class="qfoot"><span>'+(unl?'N/A / &infin;':f(ent-rem)+' / '+f(ent))+'</span><span>'+(unl?'&infin; remaining':f(rem)+' remaining')+'</span></div><div style="font-size:.7rem;color:var(--muted);margin-top:6px">Resets '+reset+' &nbsp;|&nbsp; Overage '+(q.overage_permitted?'<span class="green">allowed</span>':'<span class="muted">not allowed</span>')+'</div></div>';
  }).filter(Boolean);
  document.getElementById('qgrid').innerHTML=cards.join('')||'<div class="qcard"><span class="muted">No quota data available</span></div>';
}

function bars(id,models,key,color,vfmt){
  const max=Math.max(...models.map(([,v])=>v[key]||0),1);
  document.getElementById(id).innerHTML=models.length?models.map(([n,v])=>'<div class="brow"><div class="blabel" title="'+n+'">'+n+'</div><div class="btrack"><div class="bfill" style="width:'+Math.round((v[key]||0)/max*100)+'%;background:'+color+'"></div></div><div class="bval" style="color:'+color+'">'+vfmt(v[key])+'</div></div>').join(''):'<p class="muted" style="font-size:.8rem">No data.</p>';
}
function kpis(id,rows){document.getElementById(id).innerHTML=rows.map(k=>'<div class="kcard"><div class="klabel">'+k.l+'</div><div class="kval '+k.c+'">'+k.v+'</div><div class="ksub">'+k.s+'</div></div>').join('');}
function renderAll(c){
  const models=Object.entries(c.per_model||{}).sort((a,b)=>(b[1].total_tokens||0)-(a[1].total_tokens||0));
  kpis('kpi-all',[{l:'Total Requests',v:f(c.total_requests),c:'blue',s:'all models, all time'},{l:'Prompt Tokens',v:f(c.total_prompt_tokens),c:'purple',s:'sent'},{l:'Completion Tokens',v:f(c.total_completion_tokens),c:'green',s:'received'},{l:'Total Tokens',v:f(c.total_tokens),c:'yellow',s:'combined'}]);
  bars('bars-tok',models,'total_tokens','var(--blue)',f);
  bars('bars-req',models,'requests','var(--purple)',f);
  document.getElementById('tbl-all').innerHTML=models.length?models.map(([n,v])=>'<tr><td><span class="badge bb">'+n+'</span></td><td>'+f(v.requests)+'</td><td>'+f(v.prompt_tokens)+'</td><td>'+f(v.completion_tokens)+'</td><td class="yellow">'+f(v.total_tokens)+'</td><td>'+ms(v.avg_latency_ms)+'</td><td class="muted">'+fdt(v.first_seen)+'</td><td class="muted">'+fdt(v.last_seen)+'</td></tr>').join(''):'<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No requests recorded yet.</td></tr>';
}
function renderSess(s){
  const models=Object.entries(s.per_model||{}).sort((a,b)=>(b[1].total_tokens||0)-(a[1].total_tokens||0));
  kpis('kpi-s',[{l:'Session Requests',v:f(s.total_requests),c:'blue',s:'since restart'},{l:'Prompt Tokens',v:f(s.total_prompt_tokens),c:'purple',s:''},{l:'Completion Tokens',v:f(s.total_completion_tokens),c:'green',s:''},{l:'Uptime',v:secs(s.uptime_seconds||0),c:'yellow',s:''}]);
  bars('bars-s',models,'total_tokens','var(--blue)',f);
  document.getElementById('tbl-s').innerHTML=models.length?models.map(([n,v])=>'<tr><td><span class="badge bb">'+n+'</span></td><td>'+f(v.requests)+'</td><td>'+f(v.prompt_tokens)+'</td><td>'+f(v.completion_tokens)+'</td><td class="yellow">'+f(v.total_tokens)+'</td><td>'+ms(v.avg_latency_ms)+'</td></tr>').join(''):'<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">No requests this session.</td></tr>';
}
function renderAcct(u){
  if(!u||u.error){document.getElementById('acct').innerHTML='<p class="muted" style="font-size:.8rem">Could not load account info.</p>';document.getElementById('feats').innerHTML='';return;}
  document.getElementById('acct').innerHTML=[['Login','<span class="green">'+(u.login||'&mdash;')+'</span>'],['Plan',u.copilot_plan?'<span class="badge bp">'+u.copilot_plan+'</span>':'&mdash;'],['SKU','<code style="font-size:.72rem">'+(u.access_type_sku||'&mdash;')+'</code>'],['Organisation',(u.organization_login_list||[]).join(', ')||'&mdash;'],['Assigned',fdate(u.assigned_date)],['Quota Resets',fdate(u.quota_reset_date_utc||u.quota_reset_date)],['Token Billing',u.token_based_billing?'<span class="badge bg">enabled</span>':'<span class="badge bm">disabled</span>'],['Overage (premium)',(u.quota_snapshots&&u.quota_snapshots.premium_interactions&&u.quota_snapshots.premium_interactions.overage_permitted)?'<span class="badge bg">allowed</span>':'<span class="badge bm">not allowed</span>']].map(([k,v])=>'<div class="irow"><span class="ikey">'+k+'</span><span class="ival">'+v+'</span></div>').join('');
  const FLAGS=[['chat_enabled','Chat'],['cli_enabled','CLI'],['editor_preview_features_enabled','Editor Preview'],['is_mcp_enabled','MCP'],['code_review_enabled','Code Review'],['copilotignore_enabled','Copilot Ignore'],['restricted_telemetry','Restricted Telemetry'],['cli_remote_control_enabled','CLI Remote Control'],['cloud_session_storage_enabled','Cloud Session Storage'],['can_upgrade_plan','Can Upgrade']];
  const b=FLAGS.map(([k,l])=>k in u?'<span class="badge '+(u[k]===true?'bg':'bm')+'">'+l+'</span>':'').filter(Boolean).join('');
  document.getElementById('feats').innerHTML=b?'<div class="fgrid">'+b+'</div>':'<p class="muted" style="font-size:.8rem">No data.</p>';
}
let _activeFilter='all';
let _sortCol=0,_sortDir=1;
let _currentModels=[],_currentUsedMap={};
function provOf(id){return id.startsWith('claude')?'Claude':id.startsWith('gpt')||id.startsWith('text-emb')||id.startsWith('o1')?'OpenAI':id.startsWith('gemini')?'Gemini':'Other';}
function filterModels(family){
  _activeFilter=family;
  document.querySelectorAll('.mf-btn').forEach(b=>b.classList.toggle('active',b.dataset.f===family));
  document.querySelectorAll('#models-body tr').forEach(r=>{r.style.display=(family==='all'||r.dataset.family===family)?'':'none';});
}
const TIER_ORDER={'Free':0,'Versatile':1,'Lightweight':2,'Premium':3,'Standard':4,'Legacy':5};
// FREE models confirmed by empirical quota testing (0 credits consumed)
const FREE_MODELS=new Set(['gpt-4o','gpt-4o-mini','gpt-4','gpt-4-0613','gpt-4-0125-preview','gpt-4-o-preview','gpt-3.5-turbo','gpt-3.5-turbo-0613','gpt-4o-2024-11-20','gpt-4o-2024-08-06','gpt-4.1','gpt-4.1-2025-04-14','gpt-41-copilot']);
const HIDDEN_MODELS=new Set(['gpt-41-copilot']);
const LIGHTWEIGHT_MODELS=new Set(['claude-haiku-4.5','gemini-3-flash-preview','gemini-3.5-flash','gpt-5-mini','gpt-5.4-mini']);
const VERSATILE_MODELS=new Set(['claude-sonnet-4.5','claude-sonnet-4.6','gemini-2.5-pro','gemini-3.1-pro-preview','gpt-5.3-codex','gpt-5.4']);
function tierLabel(m){
  if(FREE_MODELS.has(m.id))return'Free';
  if(!m.model_picker_enabled)return'Legacy';
  if(LIGHTWEIGHT_MODELS.has(m.id))return'Lightweight';
  if(VERSATILE_MODELS.has(m.id))return'Versatile';
  const cat=m.model_picker_category||'';
  if(cat==='powerful')return'Premium';if(cat==='versatile')return'Versatile';if(cat==='lightweight')return'Lightweight';
  return'Standard';
}
function tierBadge(m){
  if(FREE_MODELS.has(m.id))return'<span class="badge" style="background:#1f6feb;color:#cae8ff">Free</span>';
  if(!m.model_picker_enabled)return'<span class="badge bm">Legacy</span>';
  if(LIGHTWEIGHT_MODELS.has(m.id))return'<span class="badge" style="background:#b08800;color:#fff8c5">Lightweight</span>';
  if(VERSATILE_MODELS.has(m.id))return'<span class="badge" style="background:#1a7f37;color:#aff5b4">Versatile</span>';
  const cat=m.model_picker_category||'';
  if(cat==='powerful')return'<span class="badge" style="background:#6e40c9;color:#e2c5fc">Premium</span>';
  if(cat==='versatile')return'<span class="badge" style="background:#1a7f37;color:#aff5b4">Versatile</span>';
  if(cat==='lightweight')return'<span class="badge" style="background:#b08800;color:#fff8c5">Lightweight</span>';
  return'<span class="badge bm">Standard</span>';
}
const SNAPSHOT_PAT=/(-\\d{4}-\\d{2}-\\d{2}|-\\d{4}(-preview)?|-o-preview)$/;
function isSnapshot(id){return SNAPSHOT_PAT.test(id);}
function sortBy(col){
  if(_sortCol===col)_sortDir*=-1;else{_sortCol=col;_sortDir=1;}
  document.querySelectorAll('#models-thead th').forEach((th,i)=>{th.innerHTML=th.innerHTML.replace(/s*[\u2191\u2193\u2195]$/,'')+(i===_sortCol?(_sortDir===1?' \u2191':' \u2193'):' \u2195');});
  renderModelsBody();
}
function renderModelsBody(){
  const models=_currentModels,usedMap=_currentUsedMap;
  const sorted=[...models].sort((a,b)=>{
    const la=a.capabilities||{},lim_a=(la.limits)||{},su_a=(la.supports)||{};
    const lb=b.capabilities||{},lim_b=(lb.limits)||{},su_b=(lb.supports)||{};
    let va,vb;
    switch(_sortCol){
      case 0:va=a.id;vb=b.id;break;
      case 1:va=TIER_ORDER[tierLabel(a)]??99;vb=TIER_ORDER[tierLabel(b)]??99;break;
      case 2:va=la.family||'';vb=lb.family||'';break;
      case 3:va=lim_a.max_context_window_tokens||0;vb=lim_b.max_context_window_tokens||0;break;
      case 4:va=lim_a.max_output_tokens||0;vb=lim_b.max_output_tokens||0;break;
      case 5:va=lim_a.vision?1:0;vb=lim_b.vision?1:0;break;
      case 6:va=su_a.tool_calls?1:0;vb=su_b.tool_calls?1:0;break;
      case 7:va=(su_a.adaptive_thinking||su_a.reasoning_effort)?1:0;vb=(su_b.adaptive_thinking||su_b.reasoning_effort)?1:0;break;
      case 8:va=(usedMap[a.id]&&usedMap[a.id].requests)||0;vb=(usedMap[b.id]&&usedMap[b.id].requests)||0;break;
      default:va=a.id;vb=b.id;
    }
    if(va<vb)return -1*_sortDir;if(va>vb)return 1*_sortDir;return a.id.localeCompare(b.id);
  });
  document.getElementById('models-body').innerHTML=sorted.map(m=>{
    const caps=m.capabilities||{},lim=caps.limits||{},sup=caps.supports||{};
    const prov=provOf(m.id);
    const used=usedMap[m.id];
    const usedCell=used?'<span class="badge bg">'+f(used.requests)+' req &middot; '+f(used.total_tokens)+' tok</span>':'<span class="muted" style="font-size:.75rem">not used</span>';
    const thinking=sup.adaptive_thinking||sup.reasoning_effort;
    const rowStyle=used?'background:rgba(63,185,80,.04)':'';
    return '<tr data-family="'+prov+'" style="'+rowStyle+'">'
      +'<td style="font-family:monospace;font-size:.77rem">'+m.id+'</td>'
      +'<td>'+tierBadge(m)+'</td>'
      +'<td><span class="badge bm" style="font-size:.68rem">'+caps.family+'</span></td>'
      +'<td>'+fctx(lim.max_context_window_tokens)+'</td>'
      +'<td>'+fctx(lim.max_output_tokens)+'</td>'
      +'<td>'+tick(lim.vision)+'</td>'
      +'<td>'+tick(sup.tool_calls)+'</td>'
      +'<td>'+tick(thinking)+'</td>'
      +'<td>'+usedCell+'</td>'
      +'</tr>';
  }).join('');
  filterModels(_activeFilter);
}
function fctx(n){if(!n)return'&#8212;';if(n>=1000000)return(n/1000000).toFixed(0)+'M';if(n>=1000)return(n/1000).toFixed(0)+'k';return n;}
function tick(v){return v?'<span class="badge bg">&#10003;</span>':'<span class="badge bm">&#8212;</span>';}
function renderModels(mdls,cum){
  const allModels=(mdls&&mdls.data)||[];
  const models=allModels.filter(m=>!isSnapshot(m.id)&&!HIDDEN_MODELS.has(m.id)&&tierLabel(m)!=='Legacy');
  const usedMap=cum&&cum.per_model||{};
  if(!allModels.length){document.getElementById('models-body').innerHTML='<tr><td colspan="9" class="red" style="text-align:center;padding:16px">Failed to load models.</td></tr>';return;}
  const families={};
  models.forEach(m=>{const prov=provOf(m.id);if(!families[prov])families[prov]=0;families[prov]++;});
  const provs=['all',...Object.keys(families).sort()];
  document.getElementById('models-filters').innerHTML=provs.map(p=>'<button class="btn mf-btn'+(p===_activeFilter?' active':'')+'" data-f="'+p+'" onclick="filterModels(this.dataset.f)" style="font-size:.72rem;padding:3px 11px">'+(p==='all'?'All ('+models.length+')':p+' ('+families[p]+')')+'</button>').join('');
  _currentModels=models;_currentUsedMap=usedMap;
  renderModelsBody();
  document.getElementById('models-ts').textContent=models.length+' models ('+(allModels.length-models.length)+' snapshots hidden)';
}
load();
setInterval(load,15000);
</script>
</body>
</html>`;
var COMPILATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Proxy \u2014 Message Inspector</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--blue:#3b82f6;--yellow:#eab308;--text:#e2e8f0;--muted:#64748b;--left-bg:#1a1d27;--left-border:#2a2d3e;--right-bg:#0d1f17;--right-border:#14532d}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;padding:20px}
  h1{font-size:1.3rem;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:.82rem;margin-bottom:20px}
  .toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .btn{background:var(--blue);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:.8rem;cursor:pointer}
  .btn:hover{opacity:.85}
  .search-box{background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 12px;font-size:.8rem;width:220px}
  .search-box:focus{outline:none;border-color:var(--blue)}
  .count-badge{color:var(--muted);font-size:.8rem;margin-left:auto}
  .req-list{display:flex;flex-direction:column;gap:12px}
  .req-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .req-header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  .req-header:hover{background:#202336}
  .req-id{font-family:monospace;font-size:.78rem;color:var(--muted)}
  .req-time{font-size:.78rem;color:var(--muted);margin-left:auto}
  .model-tag{font-size:.72rem;color:var(--yellow);background:#1c1008;padding:2px 8px;border-radius:6px}
  .chevron{color:var(--muted);font-size:.9rem;transition:transform .2s}
  .chevron.open{transform:rotate(90deg)}
  .token-count{font-size:.7rem;padding:2px 8px;border-radius:999px;font-weight:600;background:#1e293b;color:#94a3b8}
  .chat-panes{display:none;grid-template-columns:1fr 1fr}
  .chat-panes.open{display:grid}
  .pane{padding:16px}
  .pane-left{background:var(--left-bg);border-right:1px solid var(--border)}
  .pane-right{background:var(--right-bg)}
  .pane-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .pane-left .pane-label{color:#94a3b8}
  .pane-right .pane-label{color:var(--green)}
  .messages{display:flex;flex-direction:column;gap:10px}
  .bubble-wrap{display:flex;flex-direction:column}
  .bubble-wrap.user{align-items:flex-end}
  .bubble-wrap.assistant{align-items:flex-start}
  .bubble-wrap.system{align-items:center}
  .bubble-role{font-size:.65rem;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;padding:0 6px}
  .bubble{max-width:90%;padding:10px 14px;border-radius:14px;font-size:.82rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .pane-left .bubble.user{background:#1e3a5f;border-bottom-right-radius:4px}
  .pane-left .bubble.assistant{background:#1a1d27;border:1px solid var(--border);border-bottom-left-radius:4px}
  .pane-left .bubble.system{background:#1c1008;border:1px dashed #78350f;color:#fde68a;border-radius:8px;font-size:.78rem}
  .pane-right .bubble.assistant{background:#0d1f17;border:1px solid #14532d;border-bottom-left-radius:4px;color:#bbf7d0}
  .empty-state{color:var(--muted);text-align:center;padding:60px 20px;font-size:.9rem}
</style>
</head>
<body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
  <h1>\u{1F50D} Message Inspector</h1>
  <a href="/dashboard" class="btn" style="text-decoration:none;font-size:.78rem">&#128737; Dashboard</a>
</div>
<p class="subtitle">Left: input sent to LLM &nbsp;&middot;&nbsp; Right: response received &nbsp;&middot;&nbsp; <span style="color:#64748b">by Ritesh Agarwal</span></p>
<div class="toolbar">
  <button class="btn" onclick="load()">\u21BB Refresh</button>
  <input class="search-box" id="search" placeholder="Filter by model or text\u2026" oninput="renderList()">
  <span class="count-badge" id="count-badge"></span>
</div>
<div id="req-list" class="req-list"></div>
<script>
let _data=[];const _open=new Set();
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function parseBlocks(text){
  const blocks=text.split(/\\n\\n(?=\\[(?:USER|ASSISTANT|SYSTEM)\\])/);
  return blocks.map(b=>{const m=b.match(/^\\[([A-Z]+)\\]\\n([\\s\\S]*)$/);if(m)return{role:m[1].toLowerCase(),text:m[2].trim()};return{role:'unknown',text:b.trim()};}).filter(b=>b.text);
}
function renderBubbles(text){
  if(!text||!text.trim())return'<div style="color:var(--muted);font-size:.8rem;padding:8px">\u2014</div>';
  const msgs=parseBlocks(text);
  if(!msgs.length)return\`<div class="bubble-wrap assistant"><div class="bubble-role">assistant</div><div class="bubble assistant">\${esc(text)}</div></div>\`;
  return'<div class="messages">'+msgs.map(m=>\`<div class="bubble-wrap \${m.role}"><div class="bubble-role">\${m.role}</div><div class="bubble \${m.role}">\${esc(m.text)}</div></div>\`).join('')+'</div>';
}
function renderResponse(text){
  if(!text||!text.trim())return'<div style="color:var(--muted);font-size:.8rem;padding:8px">No response captured</div>';
  return\`<div class="messages"><div class="bubble-wrap assistant"><div class="bubble-role">assistant</div><div class="bubble assistant">\${esc(text)}</div></div></div>\`;
}
async function load(){
  try{const r=await fetch('/compilation/data');_data=await r.json();renderList();}
  catch(e){document.getElementById('req-list').innerHTML='<div class="empty-state">Error loading data</div>';}
}
function renderList(){
  const q=document.getElementById('search').value.toLowerCase();
  const filtered=q?_data.filter(d=>d.model.toLowerCase().includes(q)||d.input.toLowerCase().includes(q)||d.output.toLowerCase().includes(q)):_data;
  document.getElementById('count-badge').textContent=filtered.length+' / '+_data.length+' requests';
  if(!filtered.length){document.getElementById('req-list').innerHTML='<div class="empty-state">No requests yet \u2014 send a message through Copilot to see it here.</div>';return;}
  document.getElementById('req-list').innerHTML=filtered.map(d=>{
    const ts=new Date(d.timestamp).toLocaleString();
    const cardId='card-'+d.request_id;const isOpen=_open.has(cardId);
    return\`<div class="req-card"><div class="req-header" onclick="toggle('\${cardId}')"><span class="chevron \${isOpen?'open':''}" id="chev-\${cardId}">\u25B6</span><span class="req-id">\${esc(d.request_id)}</span><span class="model-tag">\${esc(d.model)}</span>\${d.prompt_tokens?\`<span class="token-count">~\${d.prompt_tokens} tokens</span>\`:''}<span class="req-time">\${ts}</span></div><div class="chat-panes \${isOpen?'open':''}" id="\${cardId}"><div class="pane pane-left"><div class="pane-label">Input to LLM</div>\${renderBubbles(d.input)}</div><div class="pane pane-right"><div class="pane-label" style="color:var(--green)">Response Received</div>\${renderResponse(d.output)}</div></div></div>\`;
  }).join('');
}
function toggle(id){_open.has(id)?_open.delete(id):_open.add(id);document.getElementById(id).classList.toggle('open',_open.has(id));document.getElementById('chev-'+id).classList.toggle('open',_open.has(id));}
load();setInterval(load,5000);
</script>
</body>
</html>`;

// src/sidebar.ts
var vscode3 = __toESM(require("vscode"));
var StatusItem = class extends vscode3.TreeItem {
  constructor(label, description, iconId, cmd) {
    super(label, vscode3.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode3.ThemeIcon(iconId);
    if (cmd)
      this.command = cmd;
  }
};
var StatusViewProvider = class {
  constructor() {
    this._onDidChangeTreeData = new vscode3.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.running = false;
    this.attached = false;
    this.port = 4242;
    this.accountType = "individual";
  }
  update(running, port, accountType, attached) {
    this.running = running;
    this.attached = attached ?? false;
    this.port = port;
    if (accountType)
      this.accountType = accountType;
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(e) {
    return e;
  }
  getChildren() {
    const active = this.running || this.attached;
    const statusLabel = this.running ? `running on :${this.port}` : this.attached ? `attached to :${this.port} (external)` : "stopped";
    const statusIcon = this.running ? "circle-filled" : this.attached ? "link" : "circle-outline";
    const openDashboard = {
      command: "simpleBrowser.show",
      title: "Open Dashboard",
      arguments: [`http://localhost:${this.port}/dashboard`]
    };
    const openCompilation = {
      command: "simpleBrowser.show",
      title: "Open Compilation Viewer",
      arguments: [`http://localhost:${this.port}/compilation`]
    };
    const changePort = {
      command: "copilotProxy.changePort",
      title: "Change Port"
    };
    return [
      new StatusItem("Proxy", statusLabel, statusIcon),
      new StatusItem("Port", String(this.port), "plug", changePort),
      new StatusItem("Account", this.accountType, "account", void 0),
      new StatusItem("Mode", active ? "Active" : "Disabled", active ? "check" : "x"),
      new StatusItem("Open Dashboard", `localhost:${this.port}/dashboard`, "browser", openDashboard),
      new StatusItem("Open Compilation Viewer", `localhost:${this.port}/compilation`, "list-tree", openCompilation),
      new StatusItem("Author", "Ritesh Agarwal", "person")
    ];
  }
};
var MetricsItem = class extends vscode3.TreeItem {
  constructor(label, value, iconId) {
    super(label, vscode3.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode3.ThemeIcon(iconId);
  }
};
var MetricsViewProvider = class {
  constructor() {
    this._onDidChangeTreeData = new vscode3.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(e) {
    return e;
  }
  getChildren() {
    const m = getSessionMetrics();
    const uptime = m.uptime_seconds < 60 ? `${Math.round(m.uptime_seconds)}s` : `${Math.floor(m.uptime_seconds / 60)}m`;
    return [
      new MetricsItem("Requests", String(m.total_requests), "symbol-event"),
      new MetricsItem("Prompt", m.total_prompt_tokens.toLocaleString() + " tok", "arrow-up"),
      new MetricsItem("Completion", m.total_completion_tokens.toLocaleString() + " tok", "arrow-down"),
      new MetricsItem("Total", m.total_tokens.toLocaleString() + " tok", "symbol-numeric"),
      new MetricsItem("Uptime", uptime, "clock")
    ];
  }
};

// src/chat-language-models.ts
var fs2 = __toESM(require("fs"));
var os = __toESM(require("os"));
var path2 = __toESM(require("path"));
var vscode4 = __toESM(require("vscode"));
var ENTRY_NAME = "CopilotProxy";
var FREE_MODEL_IDS = /* @__PURE__ */ new Set(["gpt-3.5-turbo", "gpt-4", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]);
function getChatLMPath() {
  const p = process.platform;
  if (p === "darwin")
    return path2.join(os.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  if (p === "win32")
    return path2.join(process.env.APPDATA ?? os.homedir(), "Code", "User", "chatLanguageModels.json");
  return path2.join(os.homedir(), ".config", "Code", "User", "chatLanguageModels.json");
}
function modelName(id, displayName) {
  return FREE_MODEL_IDS.has(id) ? `${displayName} (Free)` : displayName;
}
function buildFreeModels(proxyUrl) {
  return [
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo (Free)", url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 16385, maxOutputTokens: 4096 },
    { id: "gpt-4", name: "GPT-4 (Free)", url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 8192, maxOutputTokens: 4096 },
    { id: "gpt-4.1", name: "GPT-4.1 (Free)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 128e3, maxOutputTokens: 8096 },
    { id: "gpt-4o", name: "GPT-4o (Free)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 128e3, maxOutputTokens: 8096 },
    { id: "gpt-4o-mini", name: "GPT-4o mini (Free)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 128e3, maxOutputTokens: 8096 }
  ];
}
function buildFallbackModels(proxyUrl) {
  return [
    ...buildFreeModels(proxyUrl),
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (via Copilot Proxy)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 2e5, maxOutputTokens: 64e3, reasoningEffort: "low" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (via Copilot Proxy)", url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 136e3, maxOutputTokens: 64e3, reasoningEffort: "low" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6 (via Copilot Proxy)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 2e5, maxOutputTokens: 64e3, reasoningEffort: "low" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash (via Copilot Proxy)", url: proxyUrl, toolCalling: true, vision: true, maxInputTokens: 1e6, maxOutputTokens: 8096 }
  ];
}
async function fetchModels(outputChannel2, proxyUrl) {
  try {
    const { token, baseUrl } = await getCopilotToken();
    const modelsUrl = baseUrl.includes("enterprise") || baseUrl.includes("business") ? `${baseUrl}/models` : `${baseUrl}/models`;
    const resp = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Editor-Version": "vscode/1.99.0",
        "Editor-Plugin-Version": "copilot/1.0.0",
        "User-Agent": "GithubCopilot/1.0.0",
        "Copilot-Integration-Id": "vscode-chat"
      }
    });
    if (!resp.ok) {
      outputChannel2.appendLine(`[cp:lm] Models API returned ${resp.status} \u2014 using fallback`);
      return buildFallbackModels(proxyUrl);
    }
    const json2 = await resp.json();
    const data = json2.data ?? [];
    const apiModels = data.filter((m) => m.model_picker_enabled !== false && !m.id.includes("embedding")).map((m) => {
      const lim = m.capabilities?.limits ?? {};
      const sup = m.capabilities?.supports ?? {};
      const isReasoning = /o1|o3|thinking|claude|gemini/i.test(m.id);
      const entry = {
        id: m.id,
        name: modelName(m.id, `${m.name ?? m.id} (via Copilot Proxy)`),
        url: proxyUrl,
        toolCalling: sup.tool_calls ?? true,
        vision: sup.vision ?? false,
        maxInputTokens: lim.max_prompt_tokens ?? 128e3,
        maxOutputTokens: lim.max_output_tokens ?? 8096
      };
      if (isReasoning)
        entry.reasoningEffort = "low";
      return entry;
    });
    const returnedIds = new Set(apiModels.map((m) => m.id));
    const missingFree = buildFreeModels(proxyUrl).filter((m) => !returnedIds.has(m.id));
    return [...apiModels, ...missingFree];
  } catch (err) {
    outputChannel2.appendLine(`[cp:lm] Could not fetch models: ${err}`);
    return buildFallbackModels(proxyUrl);
  }
}
async function syncChatLanguageModels(outputChannel2) {
  try {
    const port = vscode4.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
    const proxyUrl = `http://localhost:${port}/v1`;
    const filePath = getChatLMPath();
    outputChannel2.appendLine(`[cp:lm] Syncing ${filePath}`);
    let entries = [];
    if (fs2.existsSync(filePath)) {
      try {
        entries = JSON.parse(fs2.readFileSync(filePath, "utf8"));
      } catch {
      }
    }
    const models = await fetchModels(outputChannel2, proxyUrl);
    if (models.length === 0) {
      outputChannel2.appendLine("[cp:lm] No models \u2014 skipping");
      return;
    }
    const newEntry = {
      name: ENTRY_NAME,
      vendor: "customendpoint",
      apiKey: "dummy-key-for-local",
      apiType: "chat-completions",
      models
    };
    const idx = entries.findIndex((e) => e.name === ENTRY_NAME);
    if (idx >= 0)
      entries[idx] = newEntry;
    else
      entries.push(newEntry);
    fs2.writeFileSync(filePath, JSON.stringify(entries, null, "	"), "utf8");
    outputChannel2.appendLine(`[cp:lm] Wrote ${models.length} models to chatLanguageModels.json`);
  } catch (err) {
    outputChannel2.appendLine(`[cp:lm] Failed: ${err}`);
  }
}

// src/extension.ts
var COPILOT_PROXY_SETTING = "github.copilot.advanced";
var PROXY_URL_KEY = "debug.overrideProxyUrl";
var proxyServer = null;
var _isAttached = false;
var outputChannel;
async function activate(context) {
  outputChannel = vscode5.window.createOutputChannel("Copilot Proxy");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("[cp] Activating Copilot Proxy extension...");
  const cfg = vscode5.workspace.getConfiguration("copilotProxy");
  const enabled = cfg.get("enabled", true);
  const port = cfg.get("proxyPort", 4242);
  const accountType = cfg.get("accountType", "individual");
  const statusViewProvider = new StatusViewProvider();
  const metricsViewProvider = new MetricsViewProvider();
  context.subscriptions.push(
    vscode5.window.registerTreeDataProvider("copilotProxy.statusView", statusViewProvider),
    vscode5.window.registerTreeDataProvider("copilotProxy.metricsView", metricsViewProvider)
  );
  if (enabled) {
    try {
      await startProxy(context, port);
    } catch (err) {
      outputChannel.appendLine(`[cp] startProxy failed: ${err}`);
      vscode5.window.showErrorMessage(`Copilot Proxy: failed to start \u2014 ${err}`);
    }
  }
  statusViewProvider.update(!!proxyServer?.isRunning, port, accountType, _isAttached);
  context.subscriptions.push(
    vscode5.commands.registerCommand("copilotProxy.toggle", async () => {
      const nowEnabled = vscode5.workspace.getConfiguration("copilotProxy").get("enabled", true);
      await vscode5.workspace.getConfiguration("copilotProxy").update("enabled", !nowEnabled, vscode5.ConfigurationTarget.Global);
      if (!nowEnabled) {
        const p = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
        await startProxy(context, p);
        vscode5.window.showInformationMessage("Copilot Proxy: enabled \u2713");
      } else {
        await stopProxy();
        vscode5.window.showInformationMessage("Copilot Proxy: disabled");
      }
      statusViewProvider.update(!!proxyServer?.isRunning, vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242), void 0, _isAttached);
    }),
    vscode5.commands.registerCommand("copilotProxy.showStatus", () => {
      const p = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
      const state = proxyServer?.isRunning ? `running on port ${p}` : _isAttached ? `attached to port ${p}` : "stopped";
      vscode5.window.showInformationMessage(`Copilot Proxy: ${state}`);
    }),
    vscode5.commands.registerCommand("copilotProxy.openDashboard", () => {
      const p = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
      vscode5.commands.executeCommand("simpleBrowser.show", `http://localhost:${p}/dashboard`);
    }),
    vscode5.commands.registerCommand("copilotProxy.openCompilation", () => {
      const p = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
      vscode5.commands.executeCommand("simpleBrowser.show", `http://localhost:${p}/compilation`);
    }),
    vscode5.commands.registerCommand("copilotProxy.refreshToken", async () => {
      invalidateCache();
      await syncChatLanguageModels(outputChannel);
      vscode5.window.showInformationMessage("Copilot Proxy: token cache cleared, models re-synced.");
    }),
    vscode5.commands.registerCommand("copilotProxy.changePort", async () => {
      const current = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
      const input = await vscode5.window.showInputBox({
        prompt: "Enter new proxy port",
        value: String(current),
        validateInput: (v) => /^\d+$/.test(v) && +v > 1024 && +v < 65536 ? null : "Enter a port between 1025\u201365535"
      });
      if (!input)
        return;
      await vscode5.workspace.getConfiguration("copilotProxy").update("proxyPort", Number(input), vscode5.ConfigurationTarget.Global);
    }),
    vscode5.commands.registerCommand("copilotProxy.changeAccountType", async () => {
      const types = [
        { label: "individual", description: "https://api.githubcopilot.com" },
        { label: "business", description: "https://api.business.githubcopilot.com" },
        { label: "enterprise", description: "https://api.enterprise.githubcopilot.com" }
      ];
      const current = vscode5.workspace.getConfiguration("copilotProxy").get("accountType", "individual");
      const picked = await vscode5.window.showQuickPick(types, { title: "Select Account Type", placeHolder: `Current: ${current}` });
      if (!picked)
        return;
      await vscode5.workspace.getConfiguration("copilotProxy").update("accountType", picked.label, vscode5.ConfigurationTarget.Global);
      statusViewProvider.update(!!proxyServer?.isRunning, vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242), picked.label, _isAttached);
      vscode5.window.showInformationMessage(`Copilot Proxy: account type set to ${picked.label}`);
    }),
    vscode5.commands.registerCommand("copilotProxy.resetMetrics", async () => {
      const confirm = await vscode5.window.showWarningMessage(
        "Reset all Copilot Proxy metrics? This cannot be undone.",
        { modal: true },
        "Reset"
      );
      if (confirm !== "Reset")
        return;
      resetMetrics();
      metricsViewProvider.refresh();
      vscode5.window.showInformationMessage("Copilot Proxy: metrics reset.");
    }),
    vscode5.commands.registerCommand("copilotProxy.restartProxy", async () => {
      const p = vscode5.workspace.getConfiguration("copilotProxy").get("proxyPort", 4242);
      await stopProxy();
      await startProxy(context, p);
      const at = vscode5.workspace.getConfiguration("copilotProxy").get("accountType", "individual");
      statusViewProvider.update(!!proxyServer?.isRunning, p, at, _isAttached);
      vscode5.window.showInformationMessage(`Copilot Proxy: restarted on port ${p}`);
    })
  );
  context.subscriptions.push(
    vscode5.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("copilotProxy"))
        return;
      const newCfg = vscode5.workspace.getConfiguration("copilotProxy");
      const nowEnabled = newCfg.get("enabled", true);
      const nowPort = newCfg.get("proxyPort", 4242);
      const nowAccount = newCfg.get("accountType", "individual");
      if (nowEnabled && !proxyServer?.isRunning && !_isAttached) {
        await startProxy(context, nowPort);
      } else if (!nowEnabled && (proxyServer?.isRunning || _isAttached)) {
        await stopProxy();
      } else if (nowEnabled && proxyServer?.isRunning && nowPort !== proxyServer.port) {
        await stopProxy();
        await startProxy(context, nowPort);
      }
      statusViewProvider.update(!!proxyServer?.isRunning, nowPort, nowAccount, _isAttached);
    })
  );
  const timer = setInterval(() => metricsViewProvider.refresh(), 1e4);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  outputChannel.appendLine("[cp] Extension activated.");
}
async function deactivate() {
  if (!_isAttached) {
    await stopProxy();
  } else {
    await clearCopilotProxyUrl();
    _isAttached = false;
  }
  outputChannel?.appendLine("[cp] Extension deactivated.");
}
async function startProxy(context, port) {
  proxyServer = new ProxyServer(outputChannel, context.storageUri);
  try {
    await proxyServer.start(port);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EADDRINUSE")) {
      const isProxy = await probeExistingProxy(port);
      if (isProxy) {
        outputChannel.appendLine(`[cp] Port ${port} in use by another Copilot Proxy instance \u2014 attaching.`);
        proxyServer = null;
        _isAttached = true;
        await setCopilotProxyUrl(`http://127.0.0.1:${port}`);
        vscode5.window.showInformationMessage(`Copilot Proxy: attached to existing proxy on port ${port}.`);
        return;
      }
      proxyServer = null;
      throw new Error(`Port ${port} is in use by another application. Change the port in settings.`);
    }
    proxyServer = null;
    throw err;
  }
  await setCopilotProxyUrl(`http://127.0.0.1:${port}`);
  vscode5.window.showInformationMessage(`Copilot Proxy: active on port ${port} \u2014 all Copilot traffic is proxied.`);
  syncChatLanguageModels(outputChannel);
}
async function probeExistingProxy(port) {
  return new Promise((resolve) => {
    const req = http2.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => resolve(res.statusCode === 200 && data.includes("ok")));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2e3, () => {
      req.destroy();
      resolve(false);
    });
  });
}
async function stopProxy() {
  if (!_isAttached) {
    proxyServer?.stop();
  }
  proxyServer = null;
  _isAttached = false;
  await clearCopilotProxyUrl();
}
async function setCopilotProxyUrl(url) {
  try {
    await vscode5.workspace.getConfiguration(COPILOT_PROXY_SETTING).update(
      PROXY_URL_KEY,
      url,
      vscode5.ConfigurationTarget.Global
    );
    outputChannel.appendLine(`[cp] Set ${COPILOT_PROXY_SETTING}.${PROXY_URL_KEY} = ${url}`);
  } catch (err) {
    outputChannel.appendLine(`[cp] Warning: could not set Copilot proxy URL: ${err}`);
  }
}
async function clearCopilotProxyUrl() {
  try {
    await vscode5.workspace.getConfiguration(COPILOT_PROXY_SETTING).update(
      PROXY_URL_KEY,
      void 0,
      vscode5.ConfigurationTarget.Global
    );
    outputChannel.appendLine("[cp] Cleared Copilot proxy URL.");
  } catch (err) {
    outputChannel.appendLine(`[cp] Warning: could not clear Copilot proxy URL: ${err}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
