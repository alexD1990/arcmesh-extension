import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'contextos.chatView';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private systemRepoPath: string
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'send') {
                const reply = await this.handleMessage(msg.text);
                webviewView.webview.postMessage({ command: 'reply', text: reply });
            }
        });
    }

    private readSystemRepo(): string {
        if (!this.systemRepoPath || !fs.existsSync(this.systemRepoPath)) {
            return '(system-repo ikke funnet)';
        }
        const files = this.collectFiles(this.systemRepoPath);
        return files.map(f => {
            const rel = path.relative(this.systemRepoPath, f);
            const content = fs.readFileSync(f, 'utf8');
            return `### ${rel}\n${content}`;
        }).join('\n\n');
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

    private async handleMessage(userText: string): Promise<string> {
        const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
        if (!apiKey) return '⚠️ Sett contextos.apiKey i VS Code settings.';

        const systemRepoContent = this.readSystemRepo();
        const client = new Anthropic({ apiKey });

        try {
            const response = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 1024,
                system: `Du er en hjelpsom AI-assistent med kontekst fra prosjektets system-repo.\n\n${systemRepoContent}`,
                messages: [{ role: 'user', content: userText }],
            });
            const block = response.content[0];
            return block.type === 'text' ? block.text : '(ingen tekst i svar)';
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
    vscode.postMessage({ command: 'send', text });
    send.disabled = true;

    window._thinking = thinking;
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') send.click(); });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'reply') {
      if (window._thinking) { window._thinking.remove(); window._thinking = null; }
      addMsg(msg.text, 'assistant');
      send.disabled = false;
    }
  });
</script>
</body>
</html>`;
    }
}