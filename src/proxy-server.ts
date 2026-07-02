/**
 * proxy-server.ts
 *
 * Embedded Node.js HTTP server that proxies all Copilot API traffic.
 * Ports: Copilot-Proxy routes/*, middleware/*
 *
 * Routes:
 *   POST /v1/chat/completions   — OpenAI-compatible (streaming + JSON)
 *   POST /v1/messages           — Anthropic-compatible (translation)
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models             — model list from upstream
 *   POST /v1/embeddings         — passthrough
 *   GET  /usage                 — GitHub Copilot quota
 *   GET  /quota                 — parsed JWT claims
 *   GET  /token                 — JWT debug (showToken only)
 *   POST /token/refresh         — invalidate cache
 *   GET  /health
 *   GET  /metrics
 *   GET  /metrics/cumulative
 *   GET  /dashboard             — inline HTML UI
 *   GET  /compilation           — inline HTML inspector
 *   GET  /compilation/data      — JSON exchange list
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getCopilotToken,
  getGitHubToken,
  invalidateCache,
  getCachedTokenString,
  getCachedExpiresAt,
} from './copilot-auth';
import { anthropicToOpenAI, openAIToAnthropicResponse, stripStreamOptionsForClaude } from './translate';
import type { SessionMetrics, ModelMetrics, CumulativeMetrics, ExchangeEntry, ProxyConfig } from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

const COPILOT_API_URLS: Record<string, string> = {
  individual: 'https://api.githubcopilot.com',
  business:   'https://api.business.githubcopilot.com',
  enterprise: 'https://api.enterprise.githubcopilot.com',
};

const COPILOT_HEADERS = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'vscode/1.99.0',
  'x-github-api-version': '2025-04-01',
};

const FALLBACK_MODELS = [
  'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-opus-4.6', 'claude-opus-4.5',
  'claude-haiku-4.5', 'claude-opus-4.6-fast',
  'gpt-4o', 'gpt-4o-mini-2024-07-18', 'gpt-4o-2024-11-20', 'gpt-4o-2024-08-06',
  'gemini-3.5-flash', 'gemini-3-flash-preview',
];

// ── Rate limiter state (in-process) ──────────────────────────────────────────

let _lastRequestTime = 0;

function checkRateLimit(cfg: ProxyConfig): { allowed: boolean; waitSecs: number } {
  if (cfg.rateLimitSeconds <= 0) return { allowed: true, waitSecs: 0 };
  const now = Date.now() / 1000;
  const elapsed = now - _lastRequestTime;
  const waitNeeded = cfg.rateLimitSeconds - elapsed;
  if (waitNeeded > 0) {
    return { allowed: false, waitSecs: waitNeeded };
  }
  _lastRequestTime = now;
  return { allowed: true, waitSecs: 0 };
}

function markRequestTime(): void {
  _lastRequestTime = Date.now() / 1000;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

const _startTime = Date.now();
const _sessionMetrics: Omit<SessionMetrics, 'uptime_seconds'> & { per_model: Record<string, ModelMetrics> } = {
  total_requests: 0,
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
  total_tokens: 0,
  per_model: {},
};
let _cumulativeMetrics: CumulativeMetrics = {
  total_requests: 0,
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
  total_tokens: 0,
  per_model: {},
};
let _metricsFilePath: string | undefined;

function _initModelMetrics(): ModelMetrics {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, avg_latency_ms: 0, first_seen: null, last_seen: null, _latency_sum: 0 };
}

function recordRequest(model: string, promptTokens: number, completionTokens: number, latencyMs: number): void {
  const now = Math.floor(Date.now() / 1000);
  const total = promptTokens + completionTokens;

  // Session
  _sessionMetrics.total_requests++;
  _sessionMetrics.total_prompt_tokens += promptTokens;
  _sessionMetrics.total_completion_tokens += completionTokens;
  _sessionMetrics.total_tokens += total;
  if (!_sessionMetrics.per_model[model]) _sessionMetrics.per_model[model] = _initModelMetrics();
  const sm = _sessionMetrics.per_model[model];
  sm.requests++;
  sm.prompt_tokens += promptTokens;
  sm.completion_tokens += completionTokens;
  sm.total_tokens += total;
  sm._latency_sum += latencyMs;
  sm.avg_latency_ms = sm._latency_sum / sm.requests;
  if (!sm.first_seen) sm.first_seen = now;
  sm.last_seen = now;

  // Cumulative
  _cumulativeMetrics.total_requests++;
  _cumulativeMetrics.total_prompt_tokens += promptTokens;
  _cumulativeMetrics.total_completion_tokens += completionTokens;
  _cumulativeMetrics.total_tokens += total;
  if (!_cumulativeMetrics.per_model[model]) _cumulativeMetrics.per_model[model] = _initModelMetrics();
  const cm = _cumulativeMetrics.per_model[model];
  cm.requests++;
  cm.prompt_tokens += promptTokens;
  cm.completion_tokens += completionTokens;
  cm.total_tokens += total;
  cm._latency_sum += latencyMs;
  cm.avg_latency_ms = cm._latency_sum / cm.requests;
  if (!cm.first_seen) cm.first_seen = now;
  cm.last_seen = now;

  // Persist cumulative
  if (_metricsFilePath) {
    try { fs.writeFileSync(_metricsFilePath, JSON.stringify(_cumulativeMetrics, null, 2), 'utf8'); } catch { /* ignore */ }
  }
}

export function resetMetrics(): void {
  _sessionMetrics.total_requests = 0;
  _sessionMetrics.total_prompt_tokens = 0;
  _sessionMetrics.total_completion_tokens = 0;
  _sessionMetrics.total_tokens = 0;
  _sessionMetrics.per_model = {};
  _cumulativeMetrics = { total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, per_model: {} };
  if (_metricsFilePath) {
    try { fs.writeFileSync(_metricsFilePath, JSON.stringify(_cumulativeMetrics, null, 2), 'utf8'); } catch { /* ignore */ }
  }
}

export function getSessionMetrics(): SessionMetrics {
  return { ..._sessionMetrics, uptime_seconds: (Date.now() - _startTime) / 1000 };
}

export function getCumulativeMetrics(): CumulativeMetrics {
  return _cumulativeMetrics;
}

// ── Exchange storage ──────────────────────────────────────────────────────────

const _exchanges: ExchangeEntry[] = [];
const MAX_EXCHANGES = 200;
let _exchangesFilePath: string | undefined;

function _bodyToText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  let system = body.system as string | undefined;
  if (!system) {
    for (const m of (body.messages as Array<Record<string, unknown>>) ?? []) {
      if (m.role === 'system') { system = String(m.content ?? ''); break; }
    }
  }
  if (system) {
    if (Array.isArray(system)) {
      system = (system as Array<Record<string, unknown>>).map(b => String(b.text ?? '')).join(' ');
    }
    parts.push(`[SYSTEM]\n${system}`);
  }
  for (const m of (body.messages as Array<Record<string, unknown>>) ?? []) {
    if (m.role === 'system') continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = (content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? ''))
        .join('\n');
    }
    parts.push(`[${String(m.role ?? '').toUpperCase()}]\n${String(content ?? '')}`);
  }
  return parts.join('\n\n');
}

function storeExchange(requestId: string, model: string, requestBody: Record<string, unknown>, responseText: string): void {
  let promptTokens = 0;
  for (const m of (requestBody.messages as Array<Record<string, unknown>>) ?? []) {
    promptTokens += Math.floor(String(m.content ?? '').length / 4);
  }
  const entry: ExchangeEntry = {
    request_id: requestId,
    model,
    input: _bodyToText(requestBody),
    output: responseText,
    prompt_tokens: promptTokens,
    timestamp: new Date().toISOString(),
  };
  _exchanges.unshift(entry);
  if (_exchanges.length > MAX_EXCHANGES) _exchanges.pop();

  if (_exchangesFilePath) {
    try {
      fs.appendFileSync(_exchangesFilePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* ignore */ }
  }
}

// ── Helper: read body ─────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function getProxyConfig(): ProxyConfig {
  const cfg = vscode.workspace.getConfiguration('copilotProxy');
  return {
    enabled:          cfg.get<boolean>('enabled', true),
    proxyPort:        cfg.get<number>('proxyPort', 4242),
    accountType:      cfg.get<'individual'|'business'|'enterprise'>('accountType', 'individual'),
    rateLimitSeconds: cfg.get<number>('rateLimitSeconds', 0),
    rateLimitWait:    cfg.get<boolean>('rateLimitWait', false),
    logRequests:      cfg.get<boolean>('logRequests', false),
    showToken:        cfg.get<boolean>('showToken', false),
  };
}

// ── ProxyServer ───────────────────────────────────────────────────────────────

export class ProxyServer {
  private server: http.Server | null = null;
  private _port = 4242;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel, storageUri?: vscode.Uri) {
    this.outputChannel = outputChannel;

    if (storageUri) {
      const dir = storageUri.fsPath;
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      _exchangesFilePath = path.join(dir, 'exchanges.jsonl');
      _metricsFilePath   = path.join(dir, 'metrics.json');

      // Load cumulative metrics from disk
      if (fs.existsSync(_metricsFilePath)) {
        try {
          _cumulativeMetrics = JSON.parse(fs.readFileSync(_metricsFilePath, 'utf8'));
        } catch { /* ignore */ }
      }
      // Load recent exchanges from disk
      if (fs.existsSync(_exchangesFilePath)) {
        try {
          const lines = fs.readFileSync(_exchangesFilePath, 'utf8').split('\n').filter(Boolean);
          for (const line of lines.slice(-MAX_EXCHANGES).reverse()) {
            try { _exchanges.push(JSON.parse(line) as ExchangeEntry); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  }

  get port(): number { return this._port; }
  get isRunning(): boolean { return this.server !== null; }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this._port = port;
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          this.outputChannel.appendLine(`[proxy] Unhandled error: ${err}`);
          json(res, { error: { message: String(err), type: 'proxy_error' } }, 500);
        });
      });
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.outputChannel.appendLine(`[proxy] Listening on port ${port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.outputChannel.appendLine('[proxy] Server stopped.');
  }

  // ── Request router ──────────────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const cfg = getProxyConfig();

    this.outputChannel.appendLine(`[proxy] ${method} ${url}`);

    // ── GET routes ────────────────────────────────────────────────────────────
    if (method === 'GET') {
      if (url === '/' || url === '') {
        res.writeHead(307, { Location: '/dashboard' }); res.end(); return;
      }
      if (url === '/health') return this.handleHealth(res);
      if (url === '/metrics') return json(res, getSessionMetrics());
      if (url === '/metrics/cumulative') return json(res, getCumulativeMetrics());
      if (url === '/dashboard') return html(res, DASHBOARD_HTML);
      if (url === '/compilation') return html(res, COMPILATION_HTML);
      if (url === '/compilation/data') return json(res, _exchanges);
      if (url === '/usage') return this.handleUsage(res);
      if (url === '/quota') return this.handleQuota(res);
      if (url === '/token') return this.handleToken(res, cfg);
      if (url.startsWith('/v1/models')) return this.handleModels(res, cfg);
      if (url === '/login/check') return json(res, { authenticated: true });
    }

    // ── POST routes ───────────────────────────────────────────────────────────
    if (method === 'POST') {
      if (url === '/token/refresh') return this.handleTokenRefresh(res);
      if (url === '/v1/chat/completions') return this.handleChat(req, res, cfg);
      if (url === '/v1/messages') return this.handleMessages(req, res, cfg);
      if (url === '/v1/messages/count_tokens') return this.handleCountTokens(req, res);
      if (url === '/v1/embeddings') return this.handleEmbeddings(req, res, cfg);
    }

    json(res, { error: { message: `Not found: ${method} ${url}`, type: 'not_found' } }, 404);
  }

  // ── Health ────────────────────────────────────────────────────────────────

  private handleHealth(res: http.ServerResponse): void {
    const tokenStr = getCachedTokenString();
    const expiresAt = getCachedExpiresAt();
    json(res, {
      status: 'ok',
      version: '0.1.0',
      auth: {
        github_token: 'managed-by-vscode',
        copilot_token: tokenStr ? 'present' : 'missing',
        copilot_token_expires_at: expiresAt,
      },
    });
  }

  // ── Usage ────────────────────────────────────────────────────────────────

  private async handleUsage(res: http.ServerResponse): Promise<void> {
    try {
      const githubToken = await getGitHubToken();
      const resp = await fetch('https://api.github.com/copilot_internal/user', {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'copilot-proxy/0.1.0',
        },
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

  private async handleQuota(res: http.ServerResponse): Promise<void> {
    try {
      const { token } = await getCopilotToken();
      const expiresAt = getCachedExpiresAt();
      const claims: Record<string, string> = {};
      for (const part of token.split(';')) {
        const eq = part.indexOf('=');
        if (eq >= 0) {
          claims[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
      }
      const BOOL_FLAGS: Record<string, string> = {
        chat: 'chat', ssc: 'suggestions', sn: 'snippy', malfil: 'malicious_filter',
        editor_preview_features: 'editor_preview_features', agent_mode: 'agent_mode',
        agent_mode_auto_approval: 'agent_mode_auto_approval', mcp: 'mcp',
        ccr: 'code_review', client_byok: 'bring_your_own_key',
        blackbird_external_indexing: 'external_indexing',
      };
      const features: Record<string, boolean> = {};
      for (const [key, label] of Object.entries(BOOL_FLAGS)) {
        if (key in claims) {
          features[label] = !['0', 'false', ''].includes(claims[key]);
        }
      }
      const cfg = getProxyConfig();
      json(res, {
        auth_ok: true,
        sku: claims.sku ?? 'unknown',
        account_type: cfg.accountType,
        proxy_endpoint: claims['proxy-ep'],
        token_expires_at: expiresAt,
        st: claims.st,
        features,
      });
    } catch (err) {
      json(res, { error: String(err), auth_ok: false }, 500);
    }
  }

  // ── Token debug ───────────────────────────────────────────────────────────

  private handleToken(res: http.ServerResponse, cfg: ProxyConfig): void {
    if (!cfg.showToken) {
      json(res, { error: 'Set copilotProxy.showToken=true to enable this endpoint.' }, 403);
      return;
    }
    const t = getCachedTokenString();
    json(res, { token: t ?? null, expires_at: getCachedExpiresAt() });
  }

  // ── Token refresh ─────────────────────────────────────────────────────────

  private handleTokenRefresh(res: http.ServerResponse): void {
    invalidateCache();
    this.outputChannel.appendLine('[proxy] Token cache invalidated.');
    json(res, { status: 'ok', message: 'Token cache cleared. Next request will fetch a fresh token.' });
  }

  // ── Models ────────────────────────────────────────────────────────────────

  private async handleModels(res: http.ServerResponse, cfg: ProxyConfig): Promise<void> {
    try {
      const { token, baseUrl } = await getCopilotToken();
      const modelsUrl = (baseUrl.includes('enterprise') || baseUrl.includes('business'))
        ? `${baseUrl}/models`
        : `${baseUrl}/models`;

      const resp = await fetch(modelsUrl, {
        headers: {
          ...COPILOT_HEADERS,
          Authorization: `Bearer ${token}`,
        },
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

  private async handleEmbeddings(req: http.IncomingMessage, res: http.ServerResponse, cfg: ProxyConfig): Promise<void> {
    try {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr) as Record<string, unknown>;
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/embeddings`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      json(res, data, resp.status);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  }

  // ── count_tokens ──────────────────────────────────────────────────────────

  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
    const system = String(body.system ?? '');
    let totalChars = system.length;
    for (const m of messages) totalChars += String(m.content ?? '').length;
    json(res, { input_tokens: Math.floor(totalChars / 4) });
  }

  // ── Chat completions ──────────────────────────────────────────────────────

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse, cfg: ProxyConfig): Promise<void> {
    // Rate limit check
    const { allowed, waitSecs } = checkRateLimit(cfg);
    if (!allowed) {
      if (cfg.rateLimitWait) {
        await new Promise(r => setTimeout(r, waitSecs * 1000));
      } else {
        json(res, { error: { message: `Rate limit: wait ${waitSecs.toFixed(1)}s before next request.`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 429);
        return;
      }
    }
    markRequestTime();

    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    const model = String(body.model ?? 'gpt-4o');
    const isStream = Boolean(body.stream);
    const requestId = crypto.randomUUID();
    const start = Date.now();

    if (cfg.logRequests) {
      this.outputChannel.appendLine(`[proxy] chat request model=${model} stream=${isStream}`);
    }

    try {
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/chat/completions`;
      const headers = { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const cleanBody = stripStreamOptionsForClaude(body, model);

      if (isStream) {
        await this._streamChat(res, url, headers, cleanBody, model, requestId, start, cfg);
      } else {
        await this._jsonChat(res, url, headers, cleanBody, model, requestId, start, cfg);
      }
    } catch (err) {
      this.outputChannel.appendLine(`[proxy] chat error: ${err}`);
      json(res, { error: { message: String(err), type: 'proxy_error' } }, 500);
    }
  }

  private async _jsonChat(
    res: http.ServerResponse,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    model: string,
    requestId: string,
    start: number,
    cfg: ProxyConfig,
  ): Promise<void> {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - start;
    const data = await resp.json() as Record<string, unknown>;

    if (!resp.ok) {
      const err = (data.error as Record<string, unknown>) ?? data;
      const errMsg = String((err as Record<string, unknown>).message ?? resp.statusText);
      json(res, { error: { message: errMsg, type: 'upstream_error', code: String(resp.status) } }, resp.status);
      return;
    }

    const choices = (data.choices as Array<Record<string, unknown>>) ?? [];
    const responseText = choices.length > 0 ? String(((choices[0].message as Record<string, unknown>)?.content) ?? '') : '';
    storeExchange(requestId, model, body, responseText);

    const usage = (data.usage as Record<string, number>) ?? {};
    recordRequest(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, latencyMs);

    if (cfg.logRequests) {
      this.outputChannel.appendLine(`[proxy] chat response model=${model} latency=${latencyMs}ms`);
    }

    json(res, data);
  }

  private async _streamChat(
    res: http.ServerResponse,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    model: string,
    requestId: string,
    start: number,
    cfg: ProxyConfig,
  ): Promise<void> {
    const isClause = model.toLowerCase().includes('claude');
    const streamBody = isClause
      ? body
      : { ...body, stream_options: { include_usage: true } };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(streamBody),
      });

      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        let errMsg = errText;
        try {
          const errData = JSON.parse(errText);
          errMsg = String(errData?.error?.message ?? errText);
        } catch { /* ignore */ }
        res.write(`data: ${JSON.stringify({ error: { message: errMsg, type: 'upstream_error', code: String(resp.status) } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      let promptTokens = 0;
      let completionTokens = 0;
      const responseParts: string[] = [];

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        // Parse SSE lines to extract usage and content
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const data = JSON.parse(payload) as Record<string, unknown>;
            const usage = data.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.prompt_tokens ?? promptTokens;
              completionTokens = usage.completion_tokens ?? completionTokens;
            }
            for (const choice of (data.choices as Array<Record<string, unknown>>) ?? []) {
              const delta = (choice.delta as Record<string, unknown>) ?? {};
              if (delta.content) responseParts.push(String(delta.content));
            }
          } catch { /* ignore */ }
        }
      }

      const latencyMs = Date.now() - start;
      storeExchange(requestId, model, body, responseParts.join(''));
      recordRequest(model, promptTokens, completionTokens, latencyMs);

      res.end();
    } catch (err) {
      this.outputChannel.appendLine(`[proxy] stream error: ${err}`);
      res.write(`data: ${JSON.stringify({ error: { message: String(err), type: 'proxy_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  // ── Anthropic /v1/messages ────────────────────────────────────────────────

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse, cfg: ProxyConfig): Promise<void> {
    // Rate limit
    const { allowed, waitSecs } = checkRateLimit(cfg);
    if (!allowed) {
      if (cfg.rateLimitWait) {
        await new Promise(r => setTimeout(r, waitSecs * 1000));
      } else {
        json(res, { error: { message: `Rate limit: wait ${waitSecs.toFixed(1)}s`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 429);
        return;
      }
    }
    markRequestTime();

    const bodyStr = await readBody(req);
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    const model = String(body.model ?? 'claude-sonnet-4.6');
    const isStream = Boolean(body.stream);
    const start = Date.now();

    try {
      const { token, baseUrl } = await getCopilotToken();
      const url = `${baseUrl}/chat/completions`;
      const headers = { ...COPILOT_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const oaiBody = anthropicToOpenAI(body as Parameters<typeof anthropicToOpenAI>[0]);

      if (isStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(oaiBody) });
        if (!resp.ok || !resp.body) {
          res.write(`data: ${JSON.stringify({ error: { message: await resp.text(), code: resp.status } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        recordRequest(model, 0, 0, Date.now() - start);
        res.end();
      } else {
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(oaiBody) });
        const oaiData = await resp.json() as Record<string, unknown>;
        if (!resp.ok) {
          json(res, { error: { message: String((oaiData.error as Record<string, unknown>)?.message ?? resp.statusText) } }, resp.status);
          return;
        }
        const anthropicResp = openAIToAnthropicResponse(oaiData, model);
        const usage = (oaiData.usage as Record<string, number>) ?? {};
        recordRequest(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, Date.now() - start);
        json(res, anthropicResp);
      }
    } catch (err) {
      json(res, { error: { message: String(err) } }, 500);
    }
  }
}

// ── Fallback models ───────────────────────────────────────────────────────────

function _fallbackModels(): unknown {
  return {
    object: 'list',
    data: FALLBACK_MODELS.map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'github-copilot',
    })),
  };
}

// ── Dashboard HTML (ported from Copilot-Proxy/routes/health.py) ──────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
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
    <button class="btn" onclick="load()">&#8635; Refresh</button>
  </div>
</div>

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
  document.getElementById('sub').textContent='v0.1.0 uptime '+secs(sess.uptime_seconds||0)+(usage.login?' \u00b7 '+usage.login:'')+(usage.copilot_plan?' \u00b7 '+usage.copilot_plan+' plan':'');
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
const SNAPSHOT_PAT=/(-\d{4}-\d{2}-\d{2}|-\d{4}(-preview)?|-o-preview)$/;
function isSnapshot(id){return SNAPSHOT_PAT.test(id);}
function sortBy(col){
  if(_sortCol===col)_sortDir*=-1;else{_sortCol=col;_sortDir=1;}
  document.querySelectorAll('#models-thead th').forEach((th,i)=>{th.innerHTML=th.innerHTML.replace(/\s*[\u2191\u2193\u2195]$/,'')+(i===_sortCol?(_sortDir===1?' \u2191':' \u2193'):' \u2195');});
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

// ── Compilation HTML (ported from Copilot-Proxy/routes/compilation.py) ────────

const COMPILATION_HTML = `<!DOCTYPE html>
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
<h1>\uD83D\uDD0D Message Inspector</h1>
<p class="subtitle">Left: input sent to LLM &nbsp;&middot;&nbsp; Right: response received</p>
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
