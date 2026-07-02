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
const FREE_MODEL_IDS = new Set(['gpt-3.5-turbo', 'gpt-4', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini']);

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

function modelName(id: string, displayName: string): string {
  return FREE_MODEL_IDS.has(id) ? `${displayName} (Free)` : displayName;
}

function buildFreeModels(proxyUrl: string): ModelEntry[] {
  return [
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (Free)', url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 16385,  maxOutputTokens: 4096  },
    { id: 'gpt-4',         name: 'GPT-4 (Free)',          url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 8192,   maxOutputTokens: 4096  },
    { id: 'gpt-4.1',       name: 'GPT-4.1 (Free)',        url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096  },
    { id: 'gpt-4o',        name: 'GPT-4o (Free)',         url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096  },
    { id: 'gpt-4o-mini',   name: 'GPT-4o mini (Free)',    url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 128000, maxOutputTokens: 8096  },
  ];
}

function buildFallbackModels(proxyUrl: string): ModelEntry[] {
  return [
    ...buildFreeModels(proxyUrl),
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (via Copilot Proxy)', url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 200000, maxOutputTokens: 64000, reasoningEffort: 'low' },
    { id: 'claude-haiku-4.5',  name: 'Claude Haiku 4.5 (via Copilot Proxy)',  url: proxyUrl, toolCalling: true, vision: false, maxInputTokens: 136000, maxOutputTokens: 64000, reasoningEffort: 'low' },
    { id: 'claude-opus-4.6',   name: 'Claude Opus 4.6 (via Copilot Proxy)',   url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 200000, maxOutputTokens: 64000, reasoningEffort: 'low' },
    { id: 'gemini-3.5-flash',  name: 'Gemini 3.5 Flash (via Copilot Proxy)',  url: proxyUrl, toolCalling: true, vision: true,  maxInputTokens: 1000000, maxOutputTokens: 8096  },
  ];
}

async function fetchModels(outputChannel: vscode.OutputChannel, proxyUrl: string): Promise<ModelEntry[]> {
  try {
    const { token, baseUrl } = await getCopilotToken();
    const modelsUrl = (baseUrl.includes('enterprise') || baseUrl.includes('business'))
      ? `${baseUrl}/models`
      : `${baseUrl}/models`;

    const resp = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.99.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
        'User-Agent': 'GithubCopilot/1.0.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
    });

    if (!resp.ok) {
      outputChannel.appendLine(`[cp:lm] Models API returned ${resp.status} — using fallback`);
      return buildFallbackModels(proxyUrl);
    }

    const json = await resp.json() as { data?: Array<{
      id: string;
      name?: string;
      model_picker_enabled?: boolean;
      capabilities?: {
        family?: string;
        limits?: { max_prompt_tokens?: number; max_output_tokens?: number };
        supports?: { tool_calls?: boolean; vision?: boolean };
      };
    }> };

    const data = json.data ?? [];
    const apiModels: ModelEntry[] = data
      .filter(m => m.model_picker_enabled !== false && !m.id.includes('embedding'))
      .map(m => {
        const lim = m.capabilities?.limits ?? {};
        const sup = m.capabilities?.supports ?? {};
        const isReasoning = /o1|o3|thinking|claude|gemini/i.test(m.id);
        const entry: ModelEntry = {
          id: m.id,
          name: modelName(m.id, `${m.name ?? m.id} (via Copilot Proxy)`),
          url: proxyUrl,
          toolCalling: sup.tool_calls ?? true,
          vision: sup.vision ?? false,
          maxInputTokens: lim.max_prompt_tokens ?? 128000,
          maxOutputTokens: lim.max_output_tokens ?? 8096,
        };
        if (isReasoning) entry.reasoningEffort = 'low';
        return entry;
      });

    // Ensure free models always present
    const returnedIds = new Set(apiModels.map(m => m.id));
    const missingFree = buildFreeModels(proxyUrl).filter(m => !returnedIds.has(m.id));
    return [...apiModels, ...missingFree];
  } catch (err) {
    outputChannel.appendLine(`[cp:lm] Could not fetch models: ${err}`);
    return buildFallbackModels(proxyUrl);
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
    if (models.length === 0) { outputChannel.appendLine('[cp:lm] No models — skipping'); return; }

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
