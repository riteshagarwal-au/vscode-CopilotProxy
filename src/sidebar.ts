/**
 * sidebar.ts
 *
 * TreeDataProviders for the Copilot Proxy activity bar:
 *  - StatusViewProvider  — proxy status, port, account type, auth state
 *  - MetricsViewProvider — session request/token counts + links to dashboards
 */

import * as vscode from 'vscode';
import { getSessionMetrics } from './proxy-server';

// ── Status view ───────────────────────────────────────────────────────────────

class StatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, iconId: string, cmd?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (cmd) this.command = cmd;
  }
}

export class StatusViewProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private running = false;
  private attached = false;
  private port = 4242;
  private accountType = 'individual';

  update(running: boolean, port: number, accountType?: string, attached?: boolean): void {
    this.running = running;
    this.attached = attached ?? false;
    this.port = port;
    if (accountType) this.accountType = accountType;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(e: StatusItem): vscode.TreeItem { return e; }

  getChildren(): StatusItem[] {
    const active = this.running || this.attached;
    const statusLabel = this.running
      ? `running on :${this.port}`
      : this.attached
        ? `attached to :${this.port} (external)`
        : 'stopped';
    const statusIcon = this.running ? 'circle-filled' : this.attached ? 'link' : 'circle-outline';

    const openDashboard: vscode.Command = {
      command: 'simpleBrowser.show',
      title: 'Open Dashboard',
      arguments: [`http://localhost:${this.port}/dashboard`],
    };
    const openCompilation: vscode.Command = {
      command: 'simpleBrowser.show',
      title: 'Open Compilation Viewer',
      arguments: [`http://localhost:${this.port}/compilation`],
    };
    const changePort: vscode.Command = {
      command: 'copilotProxy.changePort',
      title: 'Change Port',
    };

    return [
      new StatusItem('Proxy', statusLabel, statusIcon),
      new StatusItem('Port', String(this.port), 'plug', changePort),
      new StatusItem('Account', this.accountType, 'account', undefined),
      new StatusItem('Mode', active ? 'Active' : 'Disabled', active ? 'check' : 'x'),
      new StatusItem('Open Dashboard', `localhost:${this.port}/dashboard`, 'browser', openDashboard),
      new StatusItem('Open Compilation Viewer', `localhost:${this.port}/compilation`, 'list-tree', openCompilation),
    ];
  }
}

// ── Metrics view ──────────────────────────────────────────────────────────────

class MetricsItem extends vscode.TreeItem {
  constructor(label: string, value: string, iconId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(iconId);
  }
}

export class MetricsViewProvider implements vscode.TreeDataProvider<MetricsItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MetricsItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(e: MetricsItem): vscode.TreeItem { return e; }

  getChildren(): MetricsItem[] {
    const m = getSessionMetrics();
    const uptime = m.uptime_seconds < 60
      ? `${Math.round(m.uptime_seconds)}s`
      : `${Math.floor(m.uptime_seconds / 60)}m`;
    return [
      new MetricsItem('Requests',    String(m.total_requests),                          'symbol-event'),
      new MetricsItem('Prompt',      m.total_prompt_tokens.toLocaleString() + ' tok',    'arrow-up'),
      new MetricsItem('Completion',  m.total_completion_tokens.toLocaleString() + ' tok','arrow-down'),
      new MetricsItem('Total',       m.total_tokens.toLocaleString() + ' tok',           'symbol-numeric'),
      new MetricsItem('Uptime',      uptime,                                             'clock'),
    ];
  }
}
