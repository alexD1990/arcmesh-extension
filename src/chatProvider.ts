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

    private _webviewView?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private systemRepoPath: string
    ) {}
    private conversationHistory: Anthropic.MessageParam[] = [];

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._webviewView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'send') {
                await this.handleMessage(msg.text, msg.planningMode === true);
            }
            if (msg.command === 'newChat') {
                this.conversationHistory = [];
                webviewView.webview.postMessage({ command: 'cleared' });
            }
        });
    }

    private postAction(text: string) {
        this._webviewView?.webview.postMessage({ command: 'action', text });
    }

    private postChunk(text: string) {
        this._webviewView?.webview.postMessage({ command: 'chunk', text });
    }

    private postDone() {
        this._webviewView?.webview.postMessage({ command: 'done' });
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

    private async handleMessage(userText: string, planningMode: boolean = false): Promise<void> {
        this.postAction('Leser system-repo...');
        const systemRepoContent = this.readSystemRepo();
        const modelConfig = this.loadModelConfig();

        const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
        if (!apiKey) {
            this._webviewView?.webview.postMessage({ command: 'reply', text: '⚠️ Sett contextos.apiKey i VS Code settings.' });
            return;
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

        const client = new (await import('@anthropic-ai/sdk')).default({ apiKey });

        if (planningMode) {
            // Planning mode: tool_use-loop, ikke streaming
            this.postAction('Kontakter AI (planleggingsmodus)...');
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
                this.postAction(`Skriver til ${input.path}...`);
                const result = this.writePlanningDoc(input.path, input.content);
                messages.push({ role: 'assistant', content: response.content });
                messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: result }] });
                this.postAction('Kontakter AI...');
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
            // Send som chunks for konsistent rendering
            this.postChunk(reply);
            this.postDone();
            return;
        }

        // Standard modus: streaming
        this.postAction('Kontakter AI...');
        try {
            let fullReply = '';
            const stream = await client.messages.stream({
                model: modelConfig.name,
                max_tokens: 1024,
                system: systemPrompt,
                messages: this.conversationHistory,
            });

            for await (const event of stream) {
                if (
                    event.type === 'content_block_delta' &&
                    event.delta.type === 'text_delta'
                ) {
                    this.postChunk(event.delta.text);
                    fullReply += event.delta.text;
                }
            }

            this.conversationHistory.push({ role: 'assistant', content: fullReply });
            this.postDone();
        } catch (e: unknown) {
            this._webviewView?.webview.postMessage({
                command: 'reply',
                text: `Feil: ${e instanceof Error ? e.message : String(e)}`
            });
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; background: #1a1a1f; color: #e0e0e0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  #messages { flex: 1; overflow-y: auto; padding: 12px 10px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
  .bubble.user { align-self: flex-end; max-width: 85%; padding: 9px 13px; border-radius: 16px; border-bottom-right-radius: 4px; background: #2f6feb; color: #fff; line-height: 1.5; word-break: break-word; }
  .bubble.assistant { align-self: flex-start; max-width: 92%; padding: 10px 13px; border-radius: 16px; border-bottom-left-radius: 4px; background: #252530; color: #e0e0e0; border: 1px solid #333340; line-height: 1.6; word-break: break-word; }
  .steps-card { align-self: flex-start; max-width: 92%; background: #1e1e2a; border: 1px solid #333348; border-radius: 12px; overflow: hidden; font-size: 12px; }
  .steps-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; user-select: none; color: #999; }
  .steps-header:hover { background: #252532; }
  .steps-header .spinner { width: 13px; height: 13px; border: 2px solid #444; border-top-color: #5af; border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
  .steps-header .done-icon { width: 13px; height: 13px; color: #4caf7d; flex-shrink: 0; font-size: 13px; line-height: 1; }
  .steps-header .label { flex: 1; color: #bbb; }
  .steps-header .chevron { font-size: 10px; color: #666; transition: transform 0.2s; }
  .steps-header.collapsed .chevron { transform: rotate(-90deg); }
  .steps-body { border-top: 1px solid #2a2a38; }
  .step-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 12px; border-bottom: 1px solid #22222e; color: #888; }
  .step-row:last-child { border-bottom: none; }
  .step-icon { font-size: 12px; margin-top: 1px; flex-shrink: 0; }
  .step-text { line-height: 1.4; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bubble code { background: #1a1a26; border-radius: 4px; padding: 1px 5px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88em; color: #b5cea8; }
  .bubble pre { background: #14141c; border: 1px solid #333; border-radius: 8px; padding: 10px; overflow-x: auto; margin: 6px 0; }
  .bubble pre code { background: none; padding: 0; color: #d4d4d4; }
  .bubble strong { color: #fff; }
  .bubble em { color: #aaa; }
  .bubble ul, .bubble ol { padding-left: 18px; margin: 4px 0; }
  .bubble li { margin: 2px 0; }
  .cursor::after { content: '▌'; animation: blink 0.8s step-end infinite; color: #5af; }
  @keyframes blink { 50% { opacity: 0; } }
  #input-row { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid #2a2a35; background: #1a1a1f; align-items: center; flex-wrap: wrap; }
  #input { flex: 1; min-width: 100px; background: #252530; color: #e0e0e0; border: 1px solid #3a3a48; padding: 6px 10px; border-radius: 8px; font-size: 13px; outline: none; }
  #input:focus { border-color: #2f6feb; }
  button { background: #2f6feb; color: #fff; border: none; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  button:hover { background: #3a7fff; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.secondary { background: #2a2a38; color: #aaa; border: 1px solid #3a3a48; }
  button.secondary:hover { background: #333344; color: #ddd; }
  button.secondary.active { background: #2f6feb; color: #fff; border-color: #2f6feb; }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #3a3a4a; border-radius: 4px; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="input-row">
  <input id="input" type="text" placeholder="Spør om prosjektet..." />
  <button id="send">Send</button>
  <button id="planning-toggle" class="secondary">Plan: AV</button>
  <button id="new-chat" class="secondary">Ny chat</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  let planningMode = false;
  let activeBubble = null;
  let activeText = '';
  let activeStepsCard = null;
  let activeSteps = [];
  let stepsCollapsed = false;

  function stepIcon(text) {
    if (text.includes('system-repo')) return '📂';
    if (text.includes('fil') || text.includes('Leser')) return '📄';
    if (text.includes('Skriver') || text.includes('decisions') || text.includes('docs')) return '✏️';
    if (text.includes('AI') || text.includes('Kontakter')) return '✦';
    if (text.includes('Søker')) return '🔍';
    return '◎';
  }

  function renderMarkdown(text) {
    return text
      .replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\\/li>\\n?)+/g, m => '<ul>' + m + '</ul>')
      .replace(/^### (.+)$/gm, '<strong>$1</strong>')
      .replace(/^## (.+)$/gm, '<strong>$1</strong>')
      .replace(/^# (.+)$/gm, '<strong>$1</strong>')
      .replace(/\\n/g, '<br>');
  }

  function addBubble(role) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function createStepsCard() {
    const card = document.createElement('div');
    card.className = 'steps-card';
    const header = document.createElement('div');
    header.className = 'steps-header';
    header.innerHTML = '<div class="spinner"></div><span class="label">Jobber...</span><span class="chevron">▾</span>';
    const body = document.createElement('div');
    body.className = 'steps-body';
    header.addEventListener('click', () => {
      stepsCollapsed = !stepsCollapsed;
      body.style.display = stepsCollapsed ? 'none' : 'block';
      header.classList.toggle('collapsed', stepsCollapsed);
    });
    card.appendChild(header);
    card.appendChild(body);
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return card;
  }

  function addStepRow(card, text) {
    const body = card.querySelector('.steps-body');
    const row = document.createElement('div');
    row.className = 'step-row';
    row.innerHTML = '<span class="step-icon">' + stepIcon(text) + '</span><span class="step-text">' + text + '</span>';
    body.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function finalizeStepsCard(card, count) {
    const header = card.querySelector('.steps-header');
    header.innerHTML =
      '<span class="done-icon">✓</span>' +
      '<span class="label">Brukte ' + count + ' ' + (count === 1 ? 'handling' : 'handlinger') + '</span>' +
      '<span class="chevron">▾</span>';
    const body = card.querySelector('.steps-body');
    body.style.display = 'none';
    header.classList.add('collapsed');
    stepsCollapsed = true;
  }

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    addBubble('user').textContent = text;
    input.value = '';
    sendBtn.disabled = true;
    activeStepsCard = createStepsCard();
    activeSteps = [];
    stepsCollapsed = false;
    activeBubble = null;
    activeText = '';
    vscode.postMessage({ command: 'send', text, planningMode });
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendBtn.click(); });

  document.getElementById('planning-toggle').addEventListener('click', function() {
    planningMode = !planningMode;
    this.textContent = planningMode ? 'Plan: PÅ' : 'Plan: AV';
    this.classList.toggle('active', planningMode);
  });

  document.getElementById('new-chat').addEventListener('click', () => {
    vscode.postMessage({ command: 'newChat' });
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'action') {
      if (activeStepsCard) {
        addStepRow(activeStepsCard, msg.text);
        activeSteps.push(msg.text);
        const label = activeStepsCard.querySelector('.label');
        if (label) label.textContent = msg.text;
      }
    }
    if (msg.command === 'chunk') {
      if (!activeBubble) {
        activeBubble = addBubble('assistant');
        activeBubble.classList.add('cursor');
        activeText = '';
      }
      activeText += msg.text;
      activeBubble.innerHTML = renderMarkdown(activeText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (msg.command === 'done') {
      if (activeStepsCard) { finalizeStepsCard(activeStepsCard, activeSteps.length); activeStepsCard = null; }
      if (activeBubble) { activeBubble.classList.remove('cursor'); activeBubble.innerHTML = renderMarkdown(activeText); activeBubble = null; activeText = ''; }
      sendBtn.disabled = false;
    }
    if (msg.command === 'reply') {
      if (activeStepsCard) { finalizeStepsCard(activeStepsCard, activeSteps.length); activeStepsCard = null; }
      if (activeBubble) { activeBubble.classList.remove('cursor'); activeBubble = null; }
      addBubble('assistant').textContent = msg.text;
      sendBtn.disabled = false;
    }
    if (msg.command === 'cleared') {
      messagesEl.innerHTML = '';
      activeStepsCard = null;
      activeBubble = null;
      activeText = '';
      activeSteps = [];
    }
  });
</script>
</body>
</html>`;
    }
}