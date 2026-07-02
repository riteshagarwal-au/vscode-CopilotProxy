/**
 * copilot-auth.ts
 *
 * Exchanges VS Code's built-in GitHub session for a Copilot API JWT.
 * No OAuth device flow needed — the user is already signed in to GitHub in VS Code.
 * Ports: Copilot-Proxy/auth/copilot_token.py (60s refresh buffer)
 */

import * as vscode from 'vscode';

interface CopilotToken {
  token: string;
  expiresAt: number; // unix timestamp seconds
  baseUrl: string;
}

let _cached: CopilotToken | null = null;
const REFRESH_BUFFER_SECS = 60; // Match Python's _REFRESH_BUFFER_SECS

export function resolveBaseUrl(token: string): string {
  if (token.includes('proxy-ep=proxy.enterprise.')) {
    return 'https://api.enterprise.githubcopilot.com';
  }
  if (token.includes('proxy-ep=proxy.business.')) {
    return 'https://api.business.githubcopilot.com';
  }
  return 'https://api.githubcopilot.com';
}

function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() / 1000 > expiresAt - REFRESH_BUFFER_SECS;
}

/**
 * Return a valid Copilot JWT, fetching/refreshing as needed.
 */
export async function getCopilotToken(): Promise<{ token: string; baseUrl: string }> {
  if (_cached && !isExpiringSoon(_cached.expiresAt)) {
    return { token: _cached.token, baseUrl: _cached.baseUrl };
  }

  const githubToken = await getGitHubToken();

  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${githubToken}`,
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'User-Agent': 'GithubCopilot/1.0.0',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to get Copilot token: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { token: string; expires_at?: number };
  const expiresAt = data.expires_at ?? Math.floor(Date.now() / 1000) + 1800;

  _cached = {
    token: data.token,
    expiresAt,
    baseUrl: resolveBaseUrl(data.token),
  };

  return { token: _cached.token, baseUrl: _cached.baseUrl };
}

/**
 * Get the raw GitHub OAuth token from VS Code's session.
 */
export async function getGitHubToken(): Promise<string> {
  let session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
  if (!session) {
    session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
  }
  if (!session) {
    throw new Error('Not signed in to GitHub. Please sign in via VS Code (Accounts menu).');
  }
  return session.accessToken;
}

/**
 * Force re-fetch on next getCopilotToken() call.
 */
export function invalidateCache(): void {
  _cached = null;
}

/**
 * Return cached token string (for /token debug endpoint).
 */
export function getCachedTokenString(): string | null {
  return _cached?.token ?? null;
}

/**
 * Return cached token expiry (for /quota endpoint).
 */
export function getCachedExpiresAt(): number | null {
  return _cached?.expiresAt ?? null;
}
