/**
 * extension.ts — VS Code extension entry point for Copilot Proxy.
 *
 * On activation:
 *  1. Starts an embedded HTTP proxy on port 4242 (configurable)
 *  2. Sets github.copilot.advanced.debug.overrideProxyUrl to route Copilot traffic through it
 *  3. Registers sidebar views (Status + Metrics)
 *  4. Registers commands
 *  5. Syncs chatLanguageModels.json with all available Copilot models
 *  6. On deactivation: stops proxy and restores Copilot setting
 *
 * Multi-window: if port 4242 is already in use by another proxy instance (same extension),
 * the second window attaches silently instead of starting a new server.
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { ProxyServer, resetMetrics } from './proxy-server';
import { invalidateCache } from './copilot-auth';
import { StatusViewProvider, MetricsViewProvider } from './sidebar';
import { syncChatLanguageModels } from './chat-language-models';

const COPILOT_PROXY_SETTING = 'github.copilot.advanced';
const PROXY_URL_KEY = 'debug.overrideProxyUrl';

let proxyServer: ProxyServer | null = null;
let _isAttached = false;         // true = another window owns the proxy
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Copilot Proxy');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[cp] Activating Copilot Proxy extension...');

  const cfg = vscode.workspace.getConfiguration('copilotProxy');
  const enabled     = cfg.get<boolean>('enabled', true);
  const port        = cfg.get<number>('proxyPort', 4242);
  const accountType = cfg.get<string>('accountType', 'individual');

  // Sidebar views — register first so they always appear even if proxy fails
  const statusViewProvider  = new StatusViewProvider();
  const metricsViewProvider = new MetricsViewProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('copilotProxy.statusView',  statusViewProvider),
    vscode.window.registerTreeDataProvider('copilotProxy.metricsView', metricsViewProvider),
  );

  if (enabled) {
    try {
      await startProxy(context, port);
    } catch (err) {
      outputChannel.appendLine(`[cp] startProxy failed: ${err}`);
      vscode.window.showErrorMessage(`Copilot Proxy: failed to start — ${err}`);
    }
  }

  statusViewProvider.update(!!proxyServer?.isRunning, port, accountType, _isAttached);

  // Commands
  context.subscriptions.push(

    vscode.commands.registerCommand('copilotProxy.toggle', async () => {
      const nowEnabled = vscode.workspace.getConfiguration('copilotProxy').get<boolean>('enabled', true);
      await vscode.workspace.getConfiguration('copilotProxy').update('enabled', !nowEnabled, vscode.ConfigurationTarget.Global);
      if (!nowEnabled) {
        const p = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
        await startProxy(context, p);
        vscode.window.showInformationMessage('Copilot Proxy: enabled ✓');
      } else {
        await stopProxy();
        vscode.window.showInformationMessage('Copilot Proxy: disabled');
      }
      statusViewProvider.update(!!proxyServer?.isRunning, vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242), undefined, _isAttached);
    }),

    vscode.commands.registerCommand('copilotProxy.showStatus', () => {
      const p = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
      const state = proxyServer?.isRunning ? `running on port ${p}` : _isAttached ? `attached to port ${p}` : 'stopped';
      vscode.window.showInformationMessage(`Copilot Proxy: ${state}`);
    }),

    vscode.commands.registerCommand('copilotProxy.openDashboard', () => {
      const p = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
      vscode.commands.executeCommand('simpleBrowser.show', `http://localhost:${p}/dashboard`);
    }),

    vscode.commands.registerCommand('copilotProxy.openCompilation', () => {
      const p = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
      vscode.commands.executeCommand('simpleBrowser.show', `http://localhost:${p}/compilation`);
    }),

    vscode.commands.registerCommand('copilotProxy.refreshToken', async () => {
      invalidateCache();
      await syncChatLanguageModels(outputChannel);
      vscode.window.showInformationMessage('Copilot Proxy: token cache cleared, models re-synced.');
    }),

    vscode.commands.registerCommand('copilotProxy.changePort', async () => {
      const current = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
      const input = await vscode.window.showInputBox({
        prompt: 'Enter new proxy port',
        value: String(current),
        validateInput: v => /^\d+$/.test(v) && +v > 1024 && +v < 65536 ? null : 'Enter a port between 1025–65535',
      });
      if (!input) return;
      await vscode.workspace.getConfiguration('copilotProxy').update('proxyPort', Number(input), vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('copilotProxy.changeAccountType', async () => {
      const types = [
        { label: 'individual', description: 'https://api.githubcopilot.com' },
        { label: 'business',   description: 'https://api.business.githubcopilot.com' },
        { label: 'enterprise', description: 'https://api.enterprise.githubcopilot.com' },
      ];
      const current = vscode.workspace.getConfiguration('copilotProxy').get<string>('accountType', 'individual');
      const picked = await vscode.window.showQuickPick(types, { title: 'Select Account Type', placeHolder: `Current: ${current}` });
      if (!picked) return;
      await vscode.workspace.getConfiguration('copilotProxy').update('accountType', picked.label, vscode.ConfigurationTarget.Global);
      statusViewProvider.update(!!proxyServer?.isRunning, vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242), picked.label, _isAttached);
      vscode.window.showInformationMessage(`Copilot Proxy: account type set to ${picked.label}`);
    }),

    vscode.commands.registerCommand('copilotProxy.resetMetrics', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all Copilot Proxy metrics? This cannot be undone.',
        { modal: true }, 'Reset',
      );
      if (confirm !== 'Reset') return;
      resetMetrics();
      metricsViewProvider.refresh();
      vscode.window.showInformationMessage('Copilot Proxy: metrics reset.');
    }),

    vscode.commands.registerCommand('copilotProxy.restartProxy', async () => {
      const p = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
      await stopProxy();
      await startProxy(context, p);
      const at = vscode.workspace.getConfiguration('copilotProxy').get<string>('accountType', 'individual');
      statusViewProvider.update(!!proxyServer?.isRunning, p, at, _isAttached);
      vscode.window.showInformationMessage(`Copilot Proxy: restarted on port ${p}`);
    }),
  );

  // React to config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('copilotProxy')) return;
      const newCfg    = vscode.workspace.getConfiguration('copilotProxy');
      const nowEnabled = newCfg.get<boolean>('enabled', true);
      const nowPort    = newCfg.get<number>('proxyPort', 4242);
      const nowAccount = newCfg.get<string>('accountType', 'individual');

      if (nowEnabled && !proxyServer?.isRunning && !_isAttached) {
        await startProxy(context, nowPort);
      } else if (!nowEnabled && (proxyServer?.isRunning || _isAttached)) {
        await stopProxy();
      } else if (nowEnabled && proxyServer?.isRunning && nowPort !== proxyServer.port) {
        await stopProxy();
        await startProxy(context, nowPort);
      }
      statusViewProvider.update(!!proxyServer?.isRunning, nowPort, nowAccount, _isAttached);
    }),
  );

  // Refresh metrics sidebar every 10s
  const timer = setInterval(() => metricsViewProvider.refresh(), 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  outputChannel.appendLine('[cp] Extension activated.');
}

export async function deactivate(): Promise<void> {
  // Only stop the server if this window owns it (not if attached)
  if (!_isAttached) {
    await stopProxy();
  } else {
    // Attached window just clears its own Copilot proxy setting
    await clearCopilotProxyUrl();
    _isAttached = false;
  }
  outputChannel?.appendLine('[cp] Extension deactivated.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startProxy(context: vscode.ExtensionContext, port: number): Promise<void> {
  proxyServer = new ProxyServer(outputChannel, context.storageUri);
  try {
    await proxyServer.start(port);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE')) {
      const isProxy = await probeExistingProxy(port);
      if (isProxy) {
        outputChannel.appendLine(`[cp] Port ${port} in use by another Copilot Proxy instance — attaching.`);
        proxyServer = null;
        _isAttached = true;
        await setCopilotProxyUrl(`http://127.0.0.1:${port}`);
        vscode.window.showInformationMessage(`Copilot Proxy: attached to existing proxy on port ${port}.`);
        return;
      }
      proxyServer = null;
      throw new Error(`Port ${port} is in use by another application. Change the port in settings.`);
    }
    proxyServer = null;
    throw err;
  }

  await setCopilotProxyUrl(`http://127.0.0.1:${port}`);
  vscode.window.showInformationMessage(`Copilot Proxy: active on port ${port} — all Copilot traffic is proxied.`);
  syncChatLanguageModels(outputChannel);
}

async function probeExistingProxy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = '';
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve(res.statusCode === 200 && data.includes('ok')));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function stopProxy(): Promise<void> {
  if (!_isAttached) {
    proxyServer?.stop();
  }
  proxyServer = null;
  _isAttached = false;
  await clearCopilotProxyUrl();
}

async function setCopilotProxyUrl(url: string): Promise<void> {
  try {
    await vscode.workspace.getConfiguration(COPILOT_PROXY_SETTING).update(
      PROXY_URL_KEY, url, vscode.ConfigurationTarget.Global,
    );
    outputChannel.appendLine(`[cp] Set ${COPILOT_PROXY_SETTING}.${PROXY_URL_KEY} = ${url}`);
  } catch (err) {
    outputChannel.appendLine(`[cp] Warning: could not set Copilot proxy URL: ${err}`);
  }
}

async function clearCopilotProxyUrl(): Promise<void> {
  try {
    await vscode.workspace.getConfiguration(COPILOT_PROXY_SETTING).update(
      PROXY_URL_KEY, undefined, vscode.ConfigurationTarget.Global,
    );
    outputChannel.appendLine('[cp] Cleared Copilot proxy URL.');
  } catch (err) {
    outputChannel.appendLine(`[cp] Warning: could not clear Copilot proxy URL: ${err}`);
  }
}
