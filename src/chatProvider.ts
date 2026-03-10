import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ModelConfig } from './providers/providerFactory';
import * as yaml from 'js-yaml';
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
        const initialModel = this.loadModelConfig();
        webviewView.webview.postMessage({ command: 'modelUpdated', name: initialModel.name });

        webviewView.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg.command === 'send') {
                await this.handleMessage(msg.text);
            }
            if (msg.command === 'newChat') {
                this.conversationHistory = [];
                webviewView.webview.postMessage({ command: 'cleared' });
            }
            if (msg.command === 'updateModel') {
                this.updateModelInConfig(msg.provider, msg.name);
                webviewView.webview.postMessage({ command: 'modelUpdated', name: msg.name });
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

    private updateModelInConfig(provider: string, name: string): void {
        if (!this.systemRepoPath) return;
        const workspaceRoot = path.resolve(this.systemRepoPath, '..', '..');
        const configPath = path.join(workspaceRoot, '.contextos', 'config.yaml');
        if (!fs.existsSync(configPath)) return;
        try {
            const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as any;
            if (!parsed) return;
            parsed.model = { provider, name };
            fs.writeFileSync(configPath, yaml.dump(parsed), 'utf8');
        } catch (e) {
            console.error('[ContextOS] Feil ved oppdatering av modell i config.yaml:', e);
        }
    }

    // ── Tool implementations ──────────────────────────────────────────────────

    private getRepoRoot(repo: 'source' | 'docs'): string {
        if (repo === 'docs') return this.systemRepoPath;
        return path.resolve(this.systemRepoPath, '..', '..');
    }

    private toolListFiles(repo: 'source' | 'docs'): string {
        const root = this.getRepoRoot(repo);
        if (!fs.existsSync(root)) return `ERROR: rot ikke funnet: ${root}`;
        const EXCLUDED = new Set(['.git', 'node_modules', 'out', 'dist', '.next', '__pycache__']);
        const results: string[] = [];
        const walk = (dir: string, depth: number) => {
            if (depth > 4) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (EXCLUDED.has(e.name)) continue;
                const rel = path.relative(root, path.join(dir, e.name));
                if (e.isDirectory()) {
                    results.push(rel + '/');
                    walk(path.join(dir, e.name), depth + 1);
                } else {
                    results.push(rel);
                }
            }
        };
        walk(root, 0);
        return results.join('\n') || '(tom mappe)';
    }

    private toolReadFile(repo: 'source' | 'docs', filePath: string): string {
        const root = this.getRepoRoot(repo);
        const full = path.resolve(root, filePath);
        // Path traversal guard
        if (!full.startsWith(path.resolve(root))) return 'ERROR: Path traversal ikke tillatt.';
        if (!fs.existsSync(full)) return `ERROR: Fil ikke funnet: ${filePath}`;
        const stat = fs.statSync(full);
        if (stat.size > 200 * 1024) return `ERROR: Fil for stor (${Math.round(stat.size / 1024)}KB > 200KB).`;
        try {
            return fs.readFileSync(full, 'utf8');
        } catch (e) {
            return `ERROR: Kunne ikke lese fil: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    private toolSearchFiles(repo: 'source' | 'docs', query: string): string {
        const root = this.getRepoRoot(repo);
        if (!fs.existsSync(root)) return `ERROR: rot ikke funnet: ${root}`;
        const EXCLUDED = new Set(['.git', 'node_modules', 'out', 'dist', '.next', '__pycache__']);
        const results: string[] = [];
        const lq = query.toLowerCase();
        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (EXCLUDED.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    walk(full);
                } else if (e.isFile()) {
                    try {
                        const content = fs.readFileSync(full, 'utf8');
                        const lines = content.split('\n');
                        const rel = path.relative(root, full);
                        lines.forEach((line: string, i: number) => {
                            if (line.toLowerCase().includes(lq)) {
                                results.push(`${rel}:${i + 1}: ${line.trim()}`);
                            }
                        });
                    } catch { /* skip unreadable */ }
                }
            }
        };
        walk(root);
        if (results.length === 0) return '(ingen treff)';
        if (results.length > 100) return results.slice(0, 100).join('\n') + `\n... (${results.length - 100} flere treff avkortet)`;
        return results.join('\n');
    }

    // ── Tool definitions for Anthropic API ───────────────────────────────────

    private getAgentTools(): Anthropic.Tool[] {
        return [
            {
                name: 'list_files',
                description: 'List filer og mapper i workspace. repo="source" er kildekode-rotet, repo="docs" er system-repo (dokumentasjon, plans, decisions).',
                input_schema: {
                    type: 'object' as const,
                    properties: {
                        repo: { type: 'string', enum: ['source', 'docs'], description: '"source" for kildekode, "docs" for system-repo' },
                    },
                    required: ['repo'],
                },
            },
            {
                name: 'read_file',
                description: 'Les innholdet i én fil. repo="source" for kildekode, repo="docs" for system-repo.',
                input_schema: {
                    type: 'object' as const,
                    properties: {
                        repo: { type: 'string', enum: ['source', 'docs'], description: '"source" for kildekode, "docs" for system-repo' },
                        path: { type: 'string', description: 'Relativ filsti fra repo-roten' },
                    },
                    required: ['repo', 'path'],
                },
            },
            {
                name: 'search_files',
                description: 'Søk etter tekst (case-insensitiv grep) i alle filer i repoet.',
                input_schema: {
                    type: 'object' as const,
                    properties: {
                        repo: { type: 'string', enum: ['source', 'docs'], description: '"source" for kildekode, "docs" for system-repo' },
                        query: { type: 'string', description: 'Tekst å søke etter' },
                    },
                    required: ['repo', 'query'],
                },
            },
        ];
    }

    // ── Dispatch tool call ────────────────────────────────────────────────────

    private dispatchTool(name: string, input: Record<string, string>): string {
        if (name === 'list_files') {
            return this.toolListFiles(input.repo as 'source' | 'docs');
        }
        if (name === 'read_file') {
            return this.toolReadFile(input.repo as 'source' | 'docs', input.path);
        }
        if (name === 'search_files') {
            return this.toolSearchFiles(input.repo as 'source' | 'docs', input.query);
        }
        return `ERROR: Ukjent tool: ${name}`;
    }

    private actionLabelFor(name: string, input: Record<string, string>): string {
        if (name === 'list_files') return `list_files(${input.repo})`;
        if (name === 'read_file') return `read_file(${input.repo}, ${input.path})`;
        if (name === 'search_files') return `search_files(${input.repo}, "${input.query}")`;
        return name;
    }

    // ── Main message handler ──────────────────────────────────────────────────

    private async handleMessage(userText: string): Promise<void> {
        const modelConfig = this.loadModelConfig();

        const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
        if (!apiKey) {
            this._webviewView?.webview.postMessage({ command: 'reply', text: '⚠️ Sett contextos.apiKey i VS Code settings.' });
            return;
        }

        const client = new (await import('@anthropic-ai/sdk')).default({ apiKey });

        const tools: Anthropic.Tool[] = this.getAgentTools();

        const systemPrompt = `Du er en hjelpsom AI-assistent for dette VS Code-prosjektet.
Du har tilgang til følgende verktøy for å hente informasjon ved behov:
- list_files(repo): list filer i "source" (kildekode) eller "docs" (system-repo/dokumentasjon)
- read_file(repo, path): les én fil
- search_files(repo, query): søk etter tekst i filer

Bruk verktøyene proaktivt for å besvare spørsmål om prosjektet. Start gjerne med å lese relevante filer i system-repo (docs) for kontekst.`;

        this.conversationHistory.push({ role: 'user', content: userText });

        const messages: Anthropic.MessageParam[] = [...this.conversationHistory];

        // ── Tool-use loop ─────────────────────────────────────────────────────
        this.postAction('Kontakter AI...');

        let response = await client.messages.create({
            model: modelConfig.name,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            tools,
        });

        while (response.stop_reason === 'tool_use') {
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const block of response.content) {
                if (block.type !== 'tool_use') continue;
                const toolBlock = block as Anthropic.ToolUseBlock;
                const input = toolBlock.input as Record<string, string>;
                const label = this.actionLabelFor(toolBlock.name, input);
                this.postAction(label);

                const result = this.dispatchTool(toolBlock.name, input);

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolBlock.id,
                    content: result,
                });
            }

            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: toolResults });

            this.postAction('Kontakter AI...');
            response = await client.messages.create({
                model: modelConfig.name,
                max_tokens: 4096,
                system: systemPrompt,
                messages,
                tools,
            });
        }

        // ── Extract final text response ───────────────────────────────────────
        // response already contains the final answer – extract and send as chunks.
        const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
        const finalText = textBlock?.text ?? '(ingen tekst i svar)';

        this.conversationHistory.push({ role: 'assistant', content: finalText });

        // Stream via SDK from the start for true token-by-token delivery.
        // We rebuild messages without tool history to get a clean stream.
        const streamMessages: Anthropic.MessageParam[] = [
            ...this.conversationHistory.slice(0, -1) // all except the assistant reply we just pushed
        ];

        // Actually: just send finalText as chunks directly – we already have it.
        const CHUNK_SIZE = 8;
        for (let i = 0; i < finalText.length; i += CHUNK_SIZE) {
            this.postChunk(finalText.slice(i, i + CHUNK_SIZE));
            await new Promise(r => setTimeout(r, 8));
        }
        this.postDone();
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
    <html lang="no">
    <head>
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
        font-family: Inter, system-ui, -apple-system, sans-serif;
        font-size: 14px;
        background: #1a1a1f;
        color: #e0e0e0;
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }

    /* ── Messages area ──────────────────────────────────────── */
    #messages {
        flex: 1;
        overflow-y: auto;
        padding: 24px 16px 16px;
        scroll-behavior: auto;
    }

    #messages-inner {
        max-width: 700px;
        margin: 0 auto;
    }

    /* ── Bubbles ────────────────────────────────────────────── */
    .bubble.user {
        display: block;
        margin-left: auto;
        margin-right: 0;
        margin-bottom: 16px;
        max-width: 80%;
        padding: 10px 14px;
        border-radius: 18px;
        border-bottom-right-radius: 4px;
        background: #2563eb;
        color: #fff;
        line-height: 1.6;
        word-break: break-word;
        font-size: 14px;
    }

    .bubble.assistant {
        display: block;
        margin-left: 0;
        margin-right: auto;
        margin-bottom: 16px;
        max-width: 100%;
        padding: 12px 16px;
        border-radius: 18px;
        border-bottom-left-radius: 4px;
        background: #252530;
        color: #e0e0e0;
        border: 1px solid #333340;
        line-height: 1.6;
        word-break: break-word;
        font-size: 14px;
    }

    /* ── Loading: orbiting dots (B9) ────────────────────────── */
    .loading-bubble {
        display: block;
        margin-left: 0;
        margin-bottom: 16px;
        padding: 14px 16px;
        border-radius: 18px;
        border-bottom-left-radius: 4px;
        background: #252530;
        border: 1px solid #333340;
        width: 56px;
    }

    .orbit-container {
        position: relative;
        width: 28px;
        height: 28px;
    }

    .orbit-dot {
        position: absolute;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #55aaff;
        top: 50%;
        left: 50%;
        margin-top: -3px;
        margin-left: -3px;
    }

    .orbit-dot:nth-child(1) {
        animation: orbit 1.2s linear infinite;
        animation-delay: 0s;
    }
    .orbit-dot:nth-child(2) {
        animation: orbit 1.2s linear infinite;
        animation-delay: -0.4s;
    }
    .orbit-dot:nth-child(3) {
        animation: orbit 1.2s linear infinite;
        animation-delay: -0.8s;
    }

    @keyframes orbit {
        0%   { transform: rotate(0deg)   translateX(10px) rotate(0deg); }
        100% { transform: rotate(360deg) translateX(10px) rotate(-360deg); }
    }

    /* ── Steps card ─────────────────────────────────────────── */
    .steps-card {
        display: block;
        margin-bottom: 16px;
        max-width: 100%;
        background: #1e1e2a;
        border: 1px solid #333348;
        border-radius: 12px;
        overflow: hidden;
        font-size: 12px;
    }

    .steps-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        user-select: none;
        color: #999;
    }
    .steps-header:hover { background: #252532; }
    .steps-header .spinner {
        width: 13px;
        height: 13px;
        border: 2px solid #444;
        border-top-color: #55aaff;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
    }
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

    /* ── Inline code ────────────────────────────────────────── */
    .bubble code {
        background: #1a1a26;
        border-radius: 4px;
        padding: 2px 6px;
        font-family: var(--vscode-editor-font-family, "Fira Code", monospace);
        font-size: 0.87em;
        color: #b5cea8;
    }

    /* ── Code blocks with header bar ───────────────────────── */
    .code-block {
        margin: 10px 0;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid #2e2e3e;
    }

    .code-block-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        background: #1e1e2e;
        border-bottom: 1px solid #2e2e3e;
    }

    .code-block-lang {
        font-size: 11px;
        color: #888;
        font-family: var(--vscode-editor-font-family, monospace);
        text-transform: lowercase;
        letter-spacing: 0.03em;
    }

    .code-copy-btn {
        background: transparent;
        border: 1px solid #3a3a4e;
        color: #888;
        padding: 2px 8px;
        border-radius: 5px;
        font-size: 11px;
        cursor: pointer;
        font-family: Inter, system-ui, sans-serif;
        transition: background 0.15s, color 0.15s;
    }
    .code-copy-btn:hover { background: #2a2a3e; color: #ccc; border-color: #5a5a6e; }
    .code-copy-btn.copied { color: #4caf7d; border-color: #4caf7d; }

    .code-block pre { margin: 0; border: none; border-radius: 0; }
    .code-block pre code { background: none; padding: 0; }
    .hljs { background: #12121a !important; padding: 14px 16px !important; font-size: 13px !important; line-height: 1.55 !important; }

    /* ── Markdown elements ──────────────────────────────────── */
    .bubble strong { color: #fff; font-weight: 600; }
    .bubble em { color: #aaa; }
    .bubble ul, .bubble ol { padding-left: 20px; margin: 6px 0; }
    .bubble li { margin: 3px 0; line-height: 1.6; }
    .bubble p { margin: 6px 0; }

    /* ── Cursor blink ───────────────────────────────────────── */
    .cursor::after { content: "\\u258c"; animation: blink 0.8s step-end infinite; color: #55aaff; }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Input area ─────────────────────────────────────────── */
    #input-row {
        display: flex;
        flex-direction: column;
        padding: 8px 16px 12px;
        border-top: 1px solid #252530;
        background: #1a1a1f;
    }

    #input-row-inner {
        max-width: 700px;
        margin: 0 auto;
        width: 100%;
    }

    #input-box {
        background: #252530;
        border: 1px solid #363644;
        border-radius: 14px;
        display: flex;
        flex-direction: column;
        padding: 10px 12px 8px;
        gap: 6px;
        transition: border-color 0.15s;
    }
    #input-box:focus-within { border-color: #2563eb; }

    #input {
        background: transparent;
        color: #e0e0e0;
        border: none;
        padding: 0;
        font-family: Inter, system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        outline: none;
        resize: none;
        min-height: 60px;
        max-height: 180px;
        overflow-y: auto;
        width: 100%;
    }
    #input::placeholder { color: #555; }

    #input-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    #input-left { display: flex; gap: 6px; }
    #input-right { display: flex; gap: 6px; align-items: center; }

    /* ── Buttons ────────────────────────────────────────────── */
    button {
        font-family: Inter, system-ui, sans-serif;
        cursor: pointer;
        border: none;
        transition: background 0.15s;
    }
    button:disabled { opacity: 0.4; cursor: default; }

    #new-chat {
        background: transparent;
        color: #666;
        border: 1px solid #333340;
        padding: 4px 10px;
        border-radius: 8px;
        font-size: 12px;
    }
    #new-chat:hover { background: #252530; color: #aaa; }

    #model-btn {
        background: transparent;
        color: #666;
        border: 1px solid #333340;
        padding: 4px 10px;
        border-radius: 8px;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;
    }
    #model-btn:hover { background: #252530; color: #aaa; }

    #send {
        background: #2563eb;
        color: #fff;
        border: none;
        width: 32px;
        height: 32px;
        border-radius: 9px;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
    }
    #send:hover { background: #3a7fff; }
    #send:disabled { opacity: 0.4; cursor: default; }

    /* ── Model popup ────────────────────────────────────────── */
    #model-popup {
        display: none;
        position: absolute;
        bottom: 120px;
        left: 16px;
        background: #1e1e2a;
        border: 1px solid #333348;
        border-radius: 12px;
        min-width: 220px;
        z-index: 100;
        overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    }
    #model-popup.visible { display: block; }
    .model-group-label { padding: 8px 14px 4px; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
    .model-option { padding: 8px 14px; cursor: pointer; color: #ccc; font-size: 13px; display: flex; align-items: center; justify-content: space-between; }
    .model-option:hover { background: #252535; color: #fff; }
    .model-option.selected { color: #fff; }
    .model-option .check { color: #4caf7d; font-size: 14px; }
    .model-divider { height: 1px; background: #2a2a38; margin: 4px 0; }

    /* ── Scrollbar ──────────────────────────────────────────── */
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: #3a3a4a; border-radius: 4px; }
    </style>
    </head>
    <body>

    <div id="messages">
    <div id="messages-inner"></div>
    </div>

    <div id="model-popup"></div>

    <div id="input-row">
    <div id="input-row-inner">
        <div id="input-box">
        <textarea id="input" placeholder="Spør om prosjektet..." rows="3"></textarea>
        <div id="input-bottom">
            <div id="input-left">
            <button id="new-chat">Ny chat</button>
            </div>
            <div id="input-right">
            <button id="model-btn">Sonnet 4.6 &#9662;</button>
            <button id="send">&#8593;</button>
            </div>
        </div>
        </div>
    </div>
    </div>

    <script>
    const vscode = acquireVsCodeApi();
    const messagesInner = document.getElementById("messages-inner");
    const messagesEl = document.getElementById("messages");
    const input = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    let activeBubble = null;
    let activeText = "";
    let activeStepsCard = null;
    let activeSteps = [];
    let stepsCollapsed = false;
    let loadingBubble = null;

    function stepIcon(text) {
        if (text.startsWith("list_files")) return "\\u{1F4C2}";
        if (text.startsWith("read_file")) return "\\u{1F4C4}";
        if (text.startsWith("search_files")) return "\\u{1F50D}";
        if (text.startsWith("write_planning_doc")) return "\\u270F\\uFE0F";
        return "\\u25CE";
    }

    function removeLoadingBubble() {
        if (loadingBubble) {
        loadingBubble.remove();
        loadingBubble = null;
        }
    }

    function addLoadingBubble() {
        removeLoadingBubble();
        const div = document.createElement("div");
        div.className = "loading-bubble";
        const orbit = document.createElement("div");
        orbit.className = "orbit-container";
        for (let i = 0; i < 3; i++) {
        const dot = document.createElement("div");
        dot.className = "orbit-dot";
        orbit.appendChild(dot);
        }
        div.appendChild(orbit);
        messagesInner.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        loadingBubble = div;
        return div;
    }

    function renderCodeBlock(lang, code) {
        const validLang = lang && hljs.getLanguage(lang) ? lang : null;
        const highlighted = validLang
        ? hljs.highlight(code, { language: validLang }).value
        : hljs.highlightAuto(code).value;
        const langLabel = lang
        ? "<span class=\\"code-block-lang\\">" + lang + "</span>"
        : "<span class=\\"code-block-lang\\"></span>";
        const copyBtn = "<button class=\\"code-copy-btn\\" onclick=\\"copyCode(this)\\">Kopier</button>";
        return (
        "<div class=\\"code-block\\">" +
            "<div class=\\"code-block-header\\">" + langLabel + copyBtn + "</div>" +
            "<pre><code class=\\"hljs\\">" + highlighted + "</code></pre>" +
        "</div>"
        );
    }

    function copyCode(btn) {
        const pre = btn.closest(".code-block").querySelector("pre");
        if (!pre) return;
        navigator.clipboard.writeText(pre.innerText).then(function() {
        btn.textContent = "Kopiert!";
        btn.classList.add("copied");
        setTimeout(function() {
            btn.textContent = "Kopier";
            btn.classList.remove("copied");
        }, 1800);
        });
    }

    function renderMarkdown(text) {
        return text
            // Vi bruker \` for å hindre at TS tror strengen avsluttes
            .replace(/\`{3}(\\w*)\\n?([\\s\\S]*?)\`{3}/g, function(_, lang, code) {
                return renderCodeBlock(lang, code);
            })
            .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
            .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
            .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
            .replace(/^[\\-\\*] (.+)$/gm, "<li>$1</li>")
            .replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>")
            .replace(/(<li>.*<\\/li>\\n?)+/g, function(m) { return "<ul>" + m + "</ul>"; })
            .replace(/^### (.+)$/gm, "<strong>$1</strong>")
            .replace(/^## (.+)$/gm, "<strong>$1</strong>")
            .replace(/^# (.+)$/gm, "<strong>$1</strong>")
            .replace(/\\n/g, "<br>");
    }

    function addBubble(role) {
        const div = document.createElement("div");
        div.className = "bubble " + role;
        messagesInner.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    function createStepsCard() {
        const card = document.createElement("div");
        card.className = "steps-card";
        const header = document.createElement("div");
        header.className = "steps-header";
        header.innerHTML = "<div class=\\"spinner\\"></div><span class=\\"label\\">Jobber...</span><span class=\\"chevron\\">\\u25be</span>";
        const body = document.createElement("div");
        body.className = "steps-body";
        header.addEventListener("click", function() {
        stepsCollapsed = !stepsCollapsed;
        body.style.display = stepsCollapsed ? "none" : "block";
        header.classList.toggle("collapsed", stepsCollapsed);
        });
        card.appendChild(header);
        card.appendChild(body);
        messagesInner.appendChild(card);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return card;
    }

    function addStepRow(card, text) {
        const body = card.querySelector(".steps-body");
        const row = document.createElement("div");
        row.className = "step-row";
        const icon = document.createElement("span");
        icon.className = "step-icon";
        icon.textContent = stepIcon(text);
        const label = document.createElement("span");
        label.className = "step-text";
        label.textContent = text;
        row.appendChild(icon);
        row.appendChild(label);
        body.appendChild(row);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finalizeStepsCard(card, count) {
        const header = card.querySelector(".steps-header");
        const body = card.querySelector(".steps-body");
        const noun = count === 1 ? "handling" : "handlinger";
        header.innerHTML =
        "<span class=\\"done-icon\\">\\u2713</span>" +
        "<span class=\\"label\\">Brukte " + count + " " + noun + "</span>" +
        "<span class=\\"chevron\\">\\u25be</span>";
        body.style.display = "none";
        header.classList.add("collapsed");
        header.addEventListener("click", function() {
        const isCollapsed = header.classList.contains("collapsed");
        body.style.display = isCollapsed ? "block" : "none";
        header.classList.toggle("collapsed", !isCollapsed);
        });
    }

    sendBtn.addEventListener("click", function() {
        const text = input.value.trim();
        if (!text) return;
        addBubble("user").textContent = text;
        input.value = "";
        input.style.height = "auto";
        sendBtn.disabled = true;
        activeStepsCard = null;
        activeSteps = [];
        stepsCollapsed = false;
        activeBubble = null;
        activeText = "";
        addLoadingBubble();
        vscode.postMessage({ command: "send", text: text });
    });

    input.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });
    input.addEventListener("input", function() {
        input.style.height = "auto";
        input.style.height = input.scrollHeight + "px";
    });

    const MODELS = [
        { provider: "anthropic", label: "Sonnet 4.6", name: "claude-sonnet-4-6" },
        { provider: "anthropic", label: "Haiku 4.5", name: "claude-haiku-4-5-20251001" },
        { provider: "openai",    label: "GPT-4o", name: "gpt-4o" },
        { provider: "openai",    label: "GPT-4o mini", name: "gpt-4o-mini" },
        { provider: "google",    label: "Gemini 2.0 Flash", name: "gemini-2.0-flash" },
        { provider: "google",    label: "Gemini 1.5 Pro", name: "gemini-1.5-pro" },
    ];

    let selectedModel = MODELS[0];

    function buildModelPopup() {
        const popup = document.getElementById("model-popup");
        popup.innerHTML = "";
        const groups = ["anthropic", "openai", "google"];
        const groupLabels = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };
        groups.forEach(function(group, gi) {
        const lbl = document.createElement("div");
        lbl.className = "model-group-label";
        lbl.textContent = groupLabels[group];
        popup.appendChild(lbl);
        MODELS.filter(function(m) { return m.provider === group; }).forEach(function(m) {
            const opt = document.createElement("div");
            opt.className = "model-option" + (m.name === selectedModel.name ? " selected" : "");
            const nameSpan = document.createElement("span");
            nameSpan.textContent = m.label;
            opt.appendChild(nameSpan);
            if (m.name === selectedModel.name) {
            const check = document.createElement("span");
            check.className = "check";
            check.textContent = "\\u2713";
            opt.appendChild(check);
            }
            opt.addEventListener("click", function() {
            selectedModel = m;
            document.getElementById("model-btn").textContent = m.label + " \\u25be";
            vscode.postMessage({ command: "updateModel", provider: m.provider, name: m.name });
            popup.classList.remove("visible");
            buildModelPopup();
            });
            popup.appendChild(opt);
        });
        if (gi < groups.length - 1) {
            const divider = document.createElement("div");
            divider.className = "model-divider";
            popup.appendChild(divider);
        }
        });
    }

    buildModelPopup();

    document.getElementById("model-btn").addEventListener("click", function(e) {
        e.stopPropagation();
        document.getElementById("model-popup").classList.toggle("visible");
    });

    document.addEventListener("click", function() {
        document.getElementById("model-popup").classList.remove("visible");
    });

    document.getElementById("new-chat").addEventListener("click", function() {
        vscode.postMessage({ command: "newChat" });
    });

    window.addEventListener("message", function(e) {
        const msg = e.data;

        if (msg.command === "action") {
        removeLoadingBubble();
        if (!activeStepsCard) {
            activeStepsCard = createStepsCard();
        }
        addStepRow(activeStepsCard, msg.text);
        activeSteps.push(msg.text);
        const lbl = activeStepsCard.querySelector(".label");
        if (lbl) lbl.textContent = msg.text;
        }

        if (msg.command === "chunk") {
        removeLoadingBubble();
        if (!activeBubble) {
            activeBubble = addBubble("assistant");
            activeBubble.classList.add("cursor");
            activeText = "";
        }
        activeText += msg.text;
        activeBubble.textContent = activeText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        if (msg.command === "done") {
        removeLoadingBubble();
        if (activeStepsCard) { finalizeStepsCard(activeStepsCard, activeSteps.length); activeStepsCard = null; }
        if (activeBubble) {
            activeBubble.classList.remove("cursor");
            activeBubble.innerHTML = renderMarkdown(activeText);
            activeBubble = null;
            activeText = "";
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
        sendBtn.disabled = false;
        }

        if (msg.command === "reply") {
        removeLoadingBubble();
        if (activeStepsCard) { finalizeStepsCard(activeStepsCard, activeSteps.length); activeStepsCard = null; }
        if (activeBubble) { activeBubble.classList.remove("cursor"); activeBubble = null; }
        addBubble("assistant").textContent = msg.text;
        sendBtn.disabled = false;
        }

        if (msg.command === "cleared") {
        messagesInner.innerHTML = "";
        activeStepsCard = null;
        activeBubble = null;
        activeText = "";
        activeSteps = [];
        loadingBubble = null;
        }

        if (msg.command === "modelUpdated") {
        const m = MODELS.find(function(x) { return x.name === msg.name; });
        if (m) {
            selectedModel = m;
            document.getElementById("model-btn").textContent = m.label + " \\u25be";
            buildModelPopup();
        }
        }
    });
    </script>
    </body>
    </html>`;
        }
    }