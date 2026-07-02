# Plan: Port Copilot-Proxy Python → TypeScript VS Code Extension

## TL;DR
Create a new VS Code extension (`vscode-CopilotProxy`) that replicates all Copilot-Proxy Python logic in TypeScript. Auth is replaced by VS Code's built-in GitHub session (same pattern as vscode-ContextCompilerCopilot2). The embedded HTTP proxy intercepts Copilot traffic via `github.copilot.advanced.debug.overrideProxyUrl`. All routes, translation layer (Anthropic↔OpenAI), rate limiter, exchange storage, and dashboards are ported 1:1.

## Reference projects
- Source logic: Copilot-Proxy/copilot_proxy/
- Architecture template: vscode-ContextCompilerCopilot2/src/

---

## Phase 1 — Scaffold Extension

1. Create `vscode-CopilotProxy/` at workspace root with:
   - `package.json` — contributes config, commands, views (clone from CCC2, rename to `copilotProxy.*`)
   - `tsconfig.json`, `esbuild.js` — copy from CCC2
   - `src/extension.ts` — activate/deactivate, start/stop proxy, register commands
   - `.vscodeignore`, `LICENSE`, `README.md`

2. Settings to contribute (`copilotProxy.*`):
   - `enabled` (boolean, default true)
   - `proxyPort` (number, default 4242)
   - `accountType` (enum: individual/business/enterprise, default individual)
   - `rateLimitSeconds` (number, default 0)
   - `rateLimitWait` (boolean, default false)
   - `logRequests` (boolean, default false)
   - `showToken` (boolean, default false)

3. Commands to register:
   - `Copilot Proxy: Toggle On/Off`
   - `Copilot Proxy: Show Status`
   - `Copilot Proxy: Open Dashboard`
   - `Copilot Proxy: Open Compilation Viewer`
   - `Copilot Proxy: Refresh Token`
   - `Copilot Proxy: Change Port`
   - `Copilot Proxy: Change Account Type`
   - `Copilot Proxy: Reset Metrics`

---

## Phase 2 — Auth Module (`src/copilot-auth.ts`)

Port `auth/copilot_token.py` + `auth/token_store.py`, drop `auth/browser_oauth.py`.

4. `getGitHubToken(): Promise<string>` — `vscode.authentication.getSession('github', ['read:user'])` (same as CCC2's `copilot-auth.ts`)
5. `getCopilotToken(): Promise<{ token: string; baseUrl: string }>` — exchange via `GET https://api.github.com/copilot_internal/v2/token`, in-memory cache with 60s buffer (matching Python's `_REFRESH_BUFFER_SECS = 60`)
6. `resolveBaseUrl(token: string): string` — detect enterprise/business/individual from token `proxy-ep` field
7. `invalidateCache(): void` — clear cached token
8. `getGitHubUsage(): Promise<object>` — `GET https://api.github.com/copilot_internal/user` for `/usage` route

No disk token storage needed — VS Code manages the GitHub session.

---

## Phase 3 — Translation Layer (`src/translate.ts`)

Port `translate/formats.py` in full.

9. `anthropicToOpenAI(body: AnthropicRequest): OpenAIRequest`
   - Convert `system` string/blocks → first message with role=system
   - Convert content blocks (text, tool_use, tool_result) → flat strings
   - Map `stop_sequences` → `stop`, `max_tokens` passthrough
   - Strip `stream_options` for Claude models

10. `openAIToAnthropicResponse(resp: OpenAIResponse, model: string): AnthropicResponse`
    - Map `choices[0].message.content` → `content: [{type: "text", text: ...}]`
    - Map `finish_reason: "stop"` → `stop_reason: "end_turn"`
    - Map `usage.prompt_tokens/completion_tokens` → `usage.input_tokens/output_tokens`

11. `openAIToAnthropicStream(chunk: string): string` — SSE chunk conversion for streaming

---

## Phase 4 — Proxy Server (`src/proxy-server.ts`)

Port `routes/*.py` + `middleware/*.py` into a single `ProxyServer` class (same pattern as CCC2's `ProxyServer`).

12. Class `ProxyServer` with `start(port)`, `stop()`, `isRunning`, `port`
13. Route handlers (all inside `handleRequest(req, res)`):
    - `POST /v1/chat/completions` — port `routes/chat.py`: JSON + streaming, strip `stream_options` for Claude, inject auth headers, store exchange, record metrics
    - `POST /v1/messages` — port `routes/messages.py`: call `anthropicToOpenAI()`, forward, call `openAIToAnthropicResponse()`
    - `POST /v1/messages/count_tokens` — estimate ~4 chars/token
    - `GET /v1/models` — port `routes/models.py`: fetch from upstream `/models`, fallback list
    - `POST /v1/embeddings` — forward as-is to upstream
    - `GET /usage` — port `routes/usage.py`: call GitHub API
    - `GET /quota` — parse JWT claims from cached token
    - `GET /token` — return JWT if `showToken` enabled
    - `POST /token/refresh` — call `invalidateCache()`
    - `GET /health` — `{status, version, auth: {github_token, copilot_token}}`
    - `GET /metrics` — session metrics
    - `GET /metrics/cumulative` — persisted metrics from `metrics.json`
    - `GET /dashboard` — inline HTML (port Python's `_DASHBOARD_HTML`)
    - `GET /compilation` — inline HTML (port Python's `_HTML`)
    - `GET /compilation/data` — return last 200 exchanges

14. **Rate limiter** (port `middleware/rate_limiter.py`):
    - Token bucket in-memory, only for `/v1/chat/completions` and `/v1/messages`
    - Reject mode (HTTP 429) or wait mode based on config

15. **Exchange storage** (port `routes/compilation.py`):
    - In-memory deque maxlen=200
    - JSONL append to `{storageUri}/exchanges.jsonl`
    - `storeExchange(requestId, model, requestBody, responseText)`

16. **Metrics tracking** (port `routes/health.py`):
    - Per-model session counters: `{requests, promptTokens, completionTokens, latencyMs[]}`
    - Cumulative metrics persisted to `{storageUri}/metrics.json`

---

## Phase 5 — Model Registration (`src/chat-language-models.ts`)

17. Reuse CCC2's `syncChatLanguageModels()` exactly, but point proxy URL to `http://localhost:4242/v1`
18. Fetch models from Copilot API, write to `chatLanguageModels.json` under entry name `"CopilotProxy"` at port 4242
19. On first run (and on `Refresh Token` command), upsert the `"CopilotProxy"` entry in `chatLanguageModels.json` with all fetched models. Use the same token/vision/toolCalling metadata pattern as the existing `"Copilot Proxy-OLD"` entry (maxInputTokens per model family: Claude=200000, Gemini=1000000, GPT=128000). Never touch other entries (Copilot, Azure, Ollama, CCC Extension, ContextCompilerCopilot, etc.).

---

## Phase 6 — Extension Wiring (`src/extension.ts`)

19. On activate:
    - Create `OutputChannel`
    - Register sidebar `TreeDataProvider` instances from `sidebar.ts` (Status view + Metrics view)
    - Sidebar includes clickable tree items: "Open Dashboard" → opens `http://localhost:{port}/dashboard` and "Open Compilation Viewer" → opens `http://localhost:{port}/compilation`, both via `simpleBrowser.show` command attached to the `TreeItem.command` property
    - Sidebar has a "Change Port" tree item that triggers an `InputBox` prompt; on confirm: updates `copilotProxy.proxyPort` setting → config change watcher fires → proxy restarts on new port → `chatLanguageModels.json` upserted with new port URLs → sidebar refreshes to show new port. Mirrors CCC2's port-change flow exactly.
    - Start `ProxyServer` if `enabled`: first probe `GET http://localhost:{port}/health` — if response is `{status: "ok"}`, skip starting a new server and set state to "attached" (proxy already running in another window); if probe fails or times out, start a fresh `ProxyServer`. This mirrors CCC2's attach-vs-new logic exactly.
    - Set `github.copilot.advanced.debug.overrideProxyUrl = "http://localhost:{port}"` regardless of attach or new (both windows need the setting)
    - Call `syncChatLanguageModels()`
    - Register all commands
    - Watch config changes → restart proxy on port/accountType change

20. On deactivate:
    - Stop proxy
    - Clear `overrideProxyUrl` setting

---

## Relevant Files (sources)

- `Copilot-Proxy/copilot_proxy/config.py` — constants, COPILOT_HEADERS, COPILOT_API_URLS
- `Copilot-Proxy/copilot_proxy/auth/copilot_token.py` — token exchange, cache logic
- `Copilot-Proxy/copilot_proxy/translate/formats.py` — full Anthropic↔OpenAI translation
- `Copilot-Proxy/copilot_proxy/routes/chat.py` — streaming + JSON response logic
- `Copilot-Proxy/copilot_proxy/routes/messages.py` — Anthropic route
- `Copilot-Proxy/copilot_proxy/routes/models.py` — model list + fallback
- `Copilot-Proxy/copilot_proxy/routes/health.py` — dashboard HTML
- `Copilot-Proxy/copilot_proxy/routes/compilation.py` — exchange storage + viewer
- `Copilot-Proxy/copilot_proxy/middleware/rate_limiter.py` — token bucket
- `vscode-ContextCompilerCopilot2/src/copilot-auth.ts` — auth template to reuse
- `vscode-ContextCompilerCopilot2/src/proxy-server.ts` — ProxyServer class template
- `vscode-ContextCompilerCopilot2/src/extension.ts` — activate/deactivate template
- `vscode-ContextCompilerCopilot2/src/chat-language-models.ts` — model sync template
- `vscode-ContextCompilerCopilot2/package.json` — contributes template

## File structure (new extension)
```
vscode-CopilotProxy/
  src/
    extension.ts          # activate/deactivate
    copilot-auth.ts       # VS Code auth → Copilot JWT
    proxy-server.ts       # embedded HTTP server + all routes
    translate.ts          # Anthropic↔OpenAI translation
    chat-language-models.ts  # chatLanguageModels.json sync
    sidebar.ts            # TreeDataProvider for Status and Metrics sidebar views
    types.ts              # shared interfaces
  package.json
  tsconfig.json
  esbuild.js
```

## Verification
1. Build: `npm run compile` — zero TypeScript errors
2. Package: `vsce package` — produces `copilot-proxy-*.vsix`
3. Install: `code --install-extension copilot-proxy-*.vsix`
4. **Prompt user to reload VS Code window** (`Developer: Reload Window`) before testing
5. Launch Extension Host (F5) — proxy starts on port 4242
3. Confirm `github.copilot.advanced.debug.overrideProxyUrl` set to `http://localhost:4242`
4. Send a chat message in VS Code Copilot → `/compilation/data` shows the exchange
5. Test Anthropic route: `curl -X POST http://localhost:4242/v1/messages -d '{"model":"claude-sonnet-4.6","messages":[...]}'`
6. Test streaming: `curl ... -d '{"stream":true,...}'` shows SSE chunks
7. `GET /health` → `{status: "ok", auth: {github_token: true, copilot_token: true}}`
8. `GET /metrics` → shows per-model counters
9. Open `/dashboard` in browser → renders HTML correctly
10. Rate limiter: set `rateLimitSeconds: 2`, send two rapid requests → second gets 429

## Decisions
- **No disk token storage**: VS Code manages GitHub session; Copilot JWT in-memory only
- **No device OAuth flow**: `login.py` is dropped — VS Code's auth prompt handles it
- **Port default 4242**: Single port for all proxy traffic (no other ports needed)
- **Excluded**: Docker, Typer CLI, pyproject.toml, Python tests — all replaced by extension packaging
- **No multi-process rate limiting**: Single-process Node.js, same limitation as Python (acceptable)
