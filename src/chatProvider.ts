import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createProvider, ModelConfig } from './providers/providerFactory';
import { Message } from './providers/aiProvider';
import * as yaml from 'js-yaml';
import { resolveContext } from './contextResolver';
import type Anthropic from '@anthropic-ai/sdk';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'contextos.chatView';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private systemRepoPath: string
    ) {}
    private conversationHistory: Anthropic.MessageParam[] = [];

    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'send') {
                const reply = await this.handleMessage(msg.text, msg.planningMode === true);
                webviewView.webview.postMessage({ command: 'reply', text: reply });
            }
            if (msg.command === 'newChat') {
                this.conversationHistory = [];
                webviewView.webview.postMessage({ command: 'cleared' });
            }
        });
    }

    private loadContextMap(): Record<string, string> {
        if (!this.systemRepoPath) return {};
        const workspaceRoot = path.resolve(this.systemRepoPath, '..', '..');
        const configPath = path.join(workspaceRoot, '.contextos', 'config.yaml');
        if (!fs.existsSync(configPath)) return {};
        try {
            const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as any;
            return parsed?.context_map ?? {};
        } catch {
            return {};
        }
    }

    private loadModelConfig(): ModelConfig {
        if (!this.systemRepoPath) return { provider: 'anthropic', name: 'claude-sonnet-4-6' };
        const workspaceRoot = path.resolve(this.systemRepoPath, '..', '..');
        const configPath = path.join(workspaceRoot, '.contextos', 'config.yaml');
        if (!fs.existsSync(configPath)) return { provider: 'anthropic', name: 'claude-sonnet-4-6' };
        try {
            const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as any;
            return parsed?.model ?? { provider: 'anthropic', name: 'claude-sonnet-4-6' };
        } catch {
            return { provider: 'anthropic', name: 'claude-sonnet-4-6' };
        }
    }

    private readSystemRepo(changedFiles?: string[]): string {
        if (!this.systemRepoPath || !fs.existsSync(this.systemRepoPath)) {
            return '(system-repo ikke funnet)';
        }

        let selectedPaths: string[];
        if (changedFiles && changedFiles.length > 0) {
            const contextMap = this.loadContextMap();
            selectedPaths = resolveContext(changedFiles, contextMap);
        } else {
            // Chat uten diff-kontekst: send hele system-repoet
            const files = this.collectFiles(this.systemRepoPath);
            return files.map(f => {
                const rel = path.relative(this.systemRepoPath, f);
                return `### ${rel}\n${fs.readFileSync(f, 'utf8')}`;
            }).join('\n\n');
        }

        const result: string[] = [];
        for (const selected of selectedPaths) {
            const full = path.join(this.systemRepoPath, selected);
            if (!fs.existsSync(full)) continue;
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
                    if (entry.isFile()) {
                        const filePath = path.join(full, entry.name);
                        const rel = path.relative(this.systemRepoPath, filePath);
                        result.push(`### ${rel}\n${fs.readFileSync(filePath, 'utf8')}`);
                    }
                }
            } else {
                const rel = path.relative(this.systemRepoPath, full);
                if (rel === 'changelog.md') {
                    const lines = fs.readFileSync(full, 'utf8').split('\n');
                    result.push(`### ${rel}\n${lines.slice(-10).join('\n')}`);
                } else {
                    result.push(`### ${rel}\n${fs.readFileSync(full, 'utf8')}`);
                }
            }
        }
        return result.join('\n\n');
    }

    private collectFiles(dir: string): string[] {
        const result: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) result.push(...this.collectFiles(full));
            else if (entry.isFile()) result.push(full);
        }
        return result;
    }

    private writePlanningDoc(filePath: string, content: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        const allowed = normalized.startsWith('docs/') || normalized.startsWith('decisions/');
        if (!allowed) {
            return `ERROR: kan kun skrive til docs/ eller decisions/. Fikk: ${filePath}`;
        }
        const full = path.resolve(this.systemRepoPath, filePath);
        if (!full.startsWith(path.resolve(this.systemRepoPath))) {
            return 'ERROR: Path traversal ikke tillatt.';
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return `OK: skrev ${filePath}`;
    }

    private async handleMessage(userText: string, planningMode: boolean = false): Promise<string> {
        const systemRepoContent = this.readSystemRepo();
        const modelConfig = this.loadModelConfig();

        let provider;
        try {
            provider = createProvider(modelConfig);
        } catch (e: unknown) {
            return e instanceof Error ? e.message : String(e);
        }

        const tools: Anthropic.Tool[] = planningMode ? [{
            name: 'write_planning_doc',
            description: 'Skriv et plandokument direkte til docs/ eller decisions/ i system-repoet.',
            input_schema: {
                type: 'object' as const,
                properties: {
                    path: { type: 'string', description: 'Relativ sti, må starte med docs/ eller decisions/' },
                    content: { type: 'string', description: 'Innholdet i filen' },
                },
                required: ['path', 'content'],
            },
        }] : [];

        this.conversationHistory.push({ role: 'user', content: userText });

        const systemPrompt = `Du er en hjelpsom AI-assistent med kontekst fra prosjektets system-repo.\n\n${systemRepoContent}`;

        if (planningMode && modelConfig.provider === 'anthropic') {
            // Planning mode med tool_use – kun støttet for Anthropic foreløpig
            const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
            if (!apiKey) return '⚠️ Sett contextos.apiKey i VS Code settings.';
            const client = new (await import('@anthropic-ai/sdk')).default({ apiKey });
            const messages = this.conversationHistory;

            let response = await client.messages.create({
                model: modelConfig.name,
                max_tokens: 1024,
                system: systemPrompt,
                messages,
                tools,
            });

            while (response.stop_reason === 'tool_use') {
                const toolUseBlock = response.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock;
                const input = toolUseBlock.input as { path: string; content: string };
                const result = this.writePlanningDoc(input.path, input.content);
                messages.push({ role: 'assistant', content: response.content });
                messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: result }] });
                response = await client.messages.create({
                    model: modelConfig.name,
                    max_tokens: 1024,
                    system: systemPrompt,
                    messages,
                    tools,
                });
            }

            const block = response.content[0];
            const reply = block.type === 'text' ? block.text : '(ingen tekst i svar)';
            this.conversationHistory.push({ role: 'assistant', content: reply });
            return reply;
        }

        // Standard sendMessage for alle providers
        try {
            const messages: Message[] = this.conversationHistory.map(m => ({
                role: m.role as 'user' | 'assistant',
                content: typeof m.content === 'string' ? m.content : '',
            }));

            const reply = await provider.sendMessage(messages, systemPrompt);
            this.conversationHistory.push({ role: 'assistant', content: reply });
            return reply;
        } catch (e: unknown) {
            return `Feil: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #messages { flex: 1; overflow-y: auto; margin-bottom: 8px; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-input-background); text-align: right; }
  .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
  #input-row { display: flex; gap: 4px; }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; border-radius: 3px; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  .thinking { opacity: 0.6; font-style: italic; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="input-row">
  <input id="input" type="text" placeholder="Spør om prosjektet..." />
  <button id="send">Send</button>
  <button id="planning-toggle" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer;">Planlegging: AV</button>
  <button id="new-chat" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer;">Ny chat</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');

  function addMsg(text, role) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  send.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    const thinking = addMsg('Tenker...', 'assistant thinking');
    vscode.postMessage({ command: 'send', text, planningMode });
    send.disabled = true;

    window._thinking = thinking;
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') send.click(); });
  let planningMode = false;
  const toggle = document.getElementById('planning-toggle');
  toggle.addEventListener('click', () => {
    planningMode = !planningMode;
    toggle.textContent = planningMode ? 'Planlegging: PÅ' : 'Planlegging: AV';
    toggle.style.background = planningMode ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)';
    toggle.style.color = planningMode ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)';
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'reply') {
      if (window._thinking) { window._thinking.remove(); window._thinking = null; }
      addMsg(msg.text, 'assistant');
      send.disabled = false;
    }
    if (msg.command === 'cleared') {
      messages.innerHTML = '';
    }
  });

  document.getElementById('new-chat').addEventListener('click', () => {
    vscode.postMessage({ command: 'newChat' });
  });
    
</script>
</body>
</html>`;
    }
}