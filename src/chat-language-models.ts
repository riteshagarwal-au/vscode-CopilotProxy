/**
 * chat-language-models.ts
 *
 * Upserts the "CopilotProxy" entry in chatLanguageModels.json with all
 * models fetched live from the GitHub Copilot API.
 * Ported from vscode-ContextCompilerCopilot2/src/chat-language-models.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCopilotToken } from './copilot-auth';

const ENTRY_NAME = 'CopilotProxy';

// GPT models are gated — only these specific IDs are allowed through (all are free tier).
// All non-GPT models (Claude, Gemini, etc.) pass through automatically via model_picker_enabled.
// Limits and capabilities come entirely from the Copilot API — nothing is hardcoded.
const ALLOWED_FREE_MODEL_IDS = new Set(['gpt-4', 'gpt-4.1', 'gpt-4o']);

interface ModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningEffort?: string;
}

interface LMEntry {
  name: string;
  vendor: string;
  apiKey: string;
  apiType: string;
  models: ModelEntry[];
}

function getChatLMPath(): string {
  const p = process.platform;
  if (p === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json');
  if (p === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'Code', 'User', 'chatLanguageModels.json');
  return path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');
}

function modelDisplayName(id: string, apiName: string): string {
  const suffix = ALLOWED_FREE_MODEL_IDS.has(id) ? ' (Free)' : ' (via Copilot Proxy)';
  return `${apiName}${suffix}`;
}

async function fetchModels(outputChannel: vscode.OutputChannel, proxyUrl: string): Promise<ModelEntry[]> {
  try {
    const { token, baseUrl } = await getCopilotToken();

    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.99.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    });

    if (!resp.ok) {
      outputChannel.appendLine(`[cp:lm] Models API returned ${resp.status} — skipping sync`);
      return [];
    }

    const json = await resp.json() as { data?: Array<{
      id: string;
      name?: string;
      model_picker_enabled?: boolean;
      capabilities?: {
        limits?: { max_prompt_tokens?: number; max_output_tokens?: number };
        supports?: { tool_calls?: boolean; vision?: boolean };
      };
    }> };

    const models: ModelEntry[] = [];
    for (const m of json.data ?? []) {
      // Skip embeddings
      if (m.id.includes('embedding')) { continue; }
      // GPT-4 family: only allow exact IDs — snapshots and mini variants are excluded
      const isGpt4Family = /^gpt-4/i.test(m.id);
      if (isGpt4Family && !ALLOWED_FREE_MODEL_IDS.has(m.id)) { continue; }
      // All other models (GPT-5, Claude, Gemini, etc.): pass through if model_picker_enabled
      if (!isGpt4Family && m.model_picker_enabled === false) { continue; }

      const lim = m.capabilities?.limits ?? {};
      const sup = m.capabilities?.supports ?? {};
      const isReasoning = /o1|o3|thinking|claude|gemini/i.test(m.id);

      const entry: ModelEntry = {
        id: m.id,
        name: modelDisplayName(m.id, m.name ?? m.id),
        url: proxyUrl,
        toolCalling: sup.tool_calls ?? true,
        vision: sup.vision ?? false,
        // All limits come directly from the API — no hardcoded values
        maxInputTokens: lim.max_prompt_tokens ?? 128000,
        maxOutputTokens: lim.max_output_tokens ?? 4096,
      };
      if (isReasoning) { entry.reasoningEffort = 'low'; }
      models.push(entry);
    }

    outputChannel.appendLine(`[cp:lm] Fetched ${models.length} allowed models from API`);
    return models;
  } catch (err) {
    outputChannel.appendLine(`[cp:lm] Could not fetch models: ${err}`);
    return [];
  }
}

export async function syncChatLanguageModels(outputChannel: vscode.OutputChannel): Promise<void> {
  try {
    const port = vscode.workspace.getConfiguration('copilotProxy').get<number>('proxyPort', 4242);
    const proxyUrl = `http://localhost:${port}/v1`;
    const filePath = getChatLMPath();
    outputChannel.appendLine(`[cp:lm] Syncing ${filePath}`);

    let entries: LMEntry[] = [];
    if (fs.existsSync(filePath)) {
      try { entries = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LMEntry[]; } catch { /* ignore */ }
    }

    const models = await fetchModels(outputChannel, proxyUrl);
    if (models.length === 0) { outputChannel.appendLine('[cp:lm] No models returned from API — skipping write to preserve existing config'); return; }

    const newEntry: LMEntry = {
      name: ENTRY_NAME,
      vendor: 'customendpoint',
      apiKey: 'dummy-key-for-local',
      apiType: 'chat-completions',
      models,
    };

    const idx = entries.findIndex(e => e.name === ENTRY_NAME);
    if (idx >= 0) entries[idx] = newEntry;
    else entries.push(newEntry);

    fs.writeFileSync(filePath, JSON.stringify(entries, null, '\t'), 'utf8');
    outputChannel.appendLine(`[cp:lm] Wrote ${models.length} models to chatLanguageModels.json`);
  } catch (err) {
    outputChannel.appendLine(`[cp:lm] Failed: ${err}`);
  }
}
