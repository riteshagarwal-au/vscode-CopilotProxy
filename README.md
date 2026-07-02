# vscode-CopilotProxy

A VS Code extension that runs an embedded HTTP proxy on port **4242**, intercepting all GitHub Copilot traffic through `github.copilot.advanced.debug.overrideProxyUrl`. No OAuth device flow — it reuses VS Code's built-in GitHub authentication session.

## Features

- **Transparent proxy** — routes `/v1/chat/completions`, `/v1/messages` (Anthropic), `/v1/embeddings`, `/v1/models`
- **Anthropic ↔ OpenAI translation** — automatically converts Claude-format requests to OpenAI format and back
- **Usage dashboard** — live metrics, quotas, model usage tabs, available models table with tier/filter
- **Message inspector** — side-by-side input/output viewer for every request
- **Activity bar sidebar** — Status and Metrics tree views with clickable links
- **Rate limiting** — optional per-request delay, configurable in settings
- **Exchange storage** — persists up to 200 exchanges to `exchanges.jsonl` across sessions
- **Multi-window support** — second VS Code window attaches to the existing proxy silently
- **chatLanguageModels.json sync** — registers a `CopilotProxy` entry at `http://localhost:4242/v1`

## Requirements

- VS Code 1.95+
- GitHub Copilot subscription

## Author

**Ritesh Agarwal** — [☕ Buy me a coffee](https://buymeacoffee.com/riteshagarwal)
- Signed into GitHub in VS Code (`GitHub` authentication provider)

## Quick Start

1. Install the `.vsix` or from the marketplace
2. Reload VS Code — the proxy starts automatically on port 4242
3. Open the **Copilot Proxy** sidebar in the activity bar
4. Click **Open Dashboard** to view metrics and available models

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Session metrics |
| `GET` | `/metrics/cumulative` | All-time metrics (persisted) |
| `GET` | `/dashboard` | Usage dashboard (HTML) |
| `GET` | `/compilation` | Message inspector (HTML) |
| `GET` | `/compilation/data` | Raw exchange list (JSON) |
| `GET` | `/usage` | GitHub Copilot quota data |
| `GET` | `/quota` | Parsed JWT claims |
| `GET` | `/v1/models` | Available models from Copilot API |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + JSON) |
| `POST` | `/v1/messages` | Anthropic-compatible chat |
| `POST` | `/v1/embeddings` | Embeddings passthrough |
| `POST` | `/token/refresh` | Invalidate token cache |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotProxy.enabled` | `true` | Enable/disable the proxy |
| `copilotProxy.proxyPort` | `4242` | Port to listen on |
| `copilotProxy.accountType` | `individual` | `individual`, `business`, or `enterprise` |
| `copilotProxy.rateLimitSeconds` | `0` | Minimum seconds between requests (0 = disabled) |
| `copilotProxy.rateLimitWait` | `false` | Wait instead of rejecting when rate limited |
| `copilotProxy.logRequests` | `false` | Log all requests to output channel |
| `copilotProxy.showToken` | `false` | Enable `/token` endpoint for JWT debug |

## Commands

| Command | Description |
|---------|-------------|
| `Copilot Proxy: Toggle` | Enable/disable the proxy |
| `Copilot Proxy: Show Status` | Show current proxy status |
| `Copilot Proxy: Open Dashboard` | Open usage dashboard in Simple Browser |
| `Copilot Proxy: Open Compilation Viewer` | Open message inspector in Simple Browser |
| `Copilot Proxy: Refresh Token` | Invalidate and re-fetch Copilot token |
| `Copilot Proxy: Change Port` | Change the proxy port |
| `Copilot Proxy: Change Account Type` | Switch between individual/business/enterprise |
| `Copilot Proxy: Reset Metrics` | Clear all session and cumulative metrics |
| `Copilot Proxy: Restart Proxy` | Restart the embedded server |

## Development

```bash
# Install dependencies
npm install

# Build
npm run compile

# Package
npx vsce package --no-git-tag-version --allow-missing-repository

# Install locally
code --install-extension vscode-copilot-proxy-0.1.0.vsix
```

## Architecture

```
extension.ts          → activate/deactivate, command registration
proxy-server.ts       → embedded http.Server, all routes, metrics, HTML dashboards
copilot-auth.ts       → VS Code GitHub session → Copilot JWT (with caching)
translate.ts          → Anthropic ↔ OpenAI format translation
chat-language-models.ts → sync chatLanguageModels.json
sidebar.ts            → Activity bar Status + Metrics tree views
types.ts              → Shared TypeScript interfaces
```

## License

MIT
