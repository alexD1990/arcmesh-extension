import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ReviewDraft {
    changelog: string;
    components: string;
    decisions: string;
}

export class ReviewPanel {
    public static currentPanel: ReviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly systemRepoPath: string,
        draft: ReviewDraft
    ) {
        this._panel = panel;
        this._panel.webview.options = { enableScripts: true };
        this._panel.webview.html = this._getHtml(draft);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (msg) => {
                if (msg.command === 'approve') {
                    await this._writeToSystemRepo(msg.changelog, msg.components, msg.decisions, msg.componentFile ?? '', msg.decisionFile ?? '');
                    vscode.window.showInformationMessage('ContextOS: Dokumentasjon godkjent og lagret i system-repoet.');
                    this.dispose();
                } else if (msg.command === 'reject') {
                    vscode.window.showInformationMessage('ContextOS: Utkast avvist – ingenting ble lagret.');
                    this.dispose();
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(systemRepoPath: string, draft: ReviewDraft) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ReviewPanel.currentPanel) {
            ReviewPanel.currentPanel._panel.reveal(column);
            ReviewPanel.currentPanel._update(draft);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'contextosReview',
            'ContextOS – Godkjenn dokumentasjon',
            column || vscode.ViewColumn.One,
            { enableScripts: true }
        );

        ReviewPanel.currentPanel = new ReviewPanel(panel, systemRepoPath, draft);
    }

    private _update(draft: ReviewDraft) {
        this._panel.webview.html = this._getHtml(draft);
    }

    private async _writeToSystemRepo(changelog: string, components: string, decisions: string, componentFile: string, decisionFile: string) {
        if (!this.systemRepoPath || !fs.existsSync(this.systemRepoPath)) {
            vscode.window.showErrorMessage('ContextOS: system-repo ikke funnet.');
            return;
        }

        // Skriv til changelog.md – legg til øverst
        if (changelog.trim()) {
            const changelogPath = path.join(this.systemRepoPath, 'changelog.md');
            const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
            const timestamp = new Date().toISOString().split('T')[0];
            const entry = `## ${timestamp}\n\n${changelog.trim()}\n\n`;
            fs.writeFileSync(changelogPath, entry + existing, 'utf8');
        }

        // Skriv komponent-oppdateringer til components/{komponentnavn}.md
        if (components.trim()) {
            const compDir = path.join(this.systemRepoPath, 'components');
            if (!fs.existsSync(compDir)) fs.mkdirSync(compDir, { recursive: true });
            const safeName = componentFile.trim().replace(/[^a-zA-Z0-9._-]/g, '-') || 'misc';
            const compPath = path.join(compDir, safeName.endsWith('.md') ? safeName : `${safeName}.md`);
            const existing = fs.existsSync(compPath) ? fs.readFileSync(compPath, 'utf8') : '';
            const timestamp = new Date().toISOString().split('T')[0];
            const entry = `## ${timestamp}\n\n${components.trim()}\n\n`;
            fs.writeFileSync(compPath, entry + existing, 'utf8');
        }

        // Skriv beslutninger til decisions/{dato}-{slug}.md
        if (decisions.trim()) {
            const decDir = path.join(this.systemRepoPath, 'decisions');
            if (!fs.existsSync(decDir)) fs.mkdirSync(decDir, { recursive: true });
            const timestamp = new Date().toISOString().split('T')[0];
            const safeSlug = decisionFile.trim().replace(/[^a-zA-Z0-9._-]/g, '-') || 'decision';
            const decPath = path.join(decDir, `${timestamp}-${safeSlug.endsWith('.md') ? safeSlug.slice(0, -3) : safeSlug}.md`);
            fs.writeFileSync(decPath, `## ${timestamp}\n\n${decisions.trim()}\n`, 'utf8');
        }
    }

    public dispose() {
        ReviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getHtml(draft: ReviewDraft): string {
        const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ContextOS – Review</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 20px;
    box-sizing: border-box;
  }
  h1 { font-size: 1.2em; margin-bottom: 4px; }
  .subtitle { opacity: 0.7; margin-bottom: 24px; font-size: 0.9em; }
  .section { margin-bottom: 20px; }
  .section label {
    display: block;
    font-weight: bold;
    margin-bottom: 6px;
    color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe);
  }
  textarea {
    width: 100%;
    min-height: 100px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 8px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    box-sizing: border-box;
    resize: vertical;
  }
  .hint {
    font-size: 0.8em;
    opacity: 0.6;
    margin-top: 3px;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 24px;
  }
  button {
    padding: 8px 18px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.95em;
  }
  #btn-approve {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #btn-approve:hover { background: var(--vscode-button-hoverBackground); }
  #btn-reject {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  #btn-reject:hover { opacity: 0.85; }
  .badge {
    display: inline-block;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.75em;
    margin-left: 6px;
    vertical-align: middle;
  }
</style>
</head>
<body>
<h1>📝 ContextOS – Godkjenn dokumentasjon</h1>
<p class="subtitle">AI-generert utkast basert på siste git commit. Rediger om nødvendig, godkjenn eller avvis.</p>

<div class="section">
  <label>Changelog-entry <span class="badge">changelog.md</span></label>
  <textarea id="changelog">${esc(draft.changelog)}</textarea>
  <p class="hint">Legges til øverst i changelog.md med dagens dato.</p>
</div>

<div class="section">
  <label>Komponent-oppdateringer</label>
  <input id="componentFile" type="text" placeholder="komponentnavn (f.eks. ProductCard)" style="width:100%;margin-bottom:6px;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;" />
  <textarea id="components">${esc(draft.components)}</textarea>
  <p class="hint">Filnavn avgjør hvilken fil under <code>components/</code> som oppdateres. La tomt for å hoppe over.</p>
</div>

<div class="section">
  <label>Beslutninger</label>
  <input id="decisionFile" type="text" placeholder="slug (f.eks. auth-strategi)" style="width:100%;margin-bottom:6px;padding:6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;" />
  <textarea id="decisions">${esc(draft.decisions)}</textarea>
  <p class="hint">Lagres som <code>decisions/{dato}-{slug}.md</code>. La tomt for å hoppe over.</p>
</div>

<div class="actions">
  <button id="btn-approve">✅ Godkjenn og lagre</button>
  <button id="btn-reject">❌ Avvis</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('btn-approve').addEventListener('click', () => {
    vscode.postMessage({
      command: 'approve',
      changelog: document.getElementById('changelog').value,
      components: document.getElementById('components').value,
      decisions: document.getElementById('decisions').value,
      componentFile: document.getElementById('componentFile').value,
      decisionFile: document.getElementById('decisionFile').value,
    });
  });
  document.getElementById('btn-reject').addEventListener('click', () => {
    vscode.postMessage({ command: 'reject' });
  });
</script>
</body>
</html>`;
    }
}