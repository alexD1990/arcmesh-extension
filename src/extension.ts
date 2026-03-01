import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { ChatViewProvider } from './chatProvider';
import { ReviewPanel, ReviewDraft } from './reviewProvider';

const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->
`;

const DIFF_TEMP_FILE = path.join(os.tmpdir(), 'contextos-post-commit.diff');

function ensureSystemRepo(workspaceRoot: string) {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [systemRepoPath, path.join(systemRepoPath, 'decisions'), path.join(systemRepoPath, 'components')];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    const projectMd = path.join(systemRepoPath, 'project.md');
    if (!fs.existsSync(projectMd)) fs.writeFileSync(projectMd, PROJECT_MD_TEMPLATE, 'utf8');
    return systemRepoPath;
}

function installGitHook(workspaceRoot: string) {
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) { console.log('[ContextOS] Ingen .git – hopper over hook.'); return; }
    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'post-commit');
    const lockFile = path.join(hooksDir, '.contextos_post_commit.lock');
    const hookContent = [
        '#!/bin/sh',
        '# ContextOS post-commit hook – autogenerert',
        '',
        '# Reentrancy-guard: forhindrer re-entry ved samtidige kjøringer',
        `LOCK_FILE="${lockFile}"`,
        'if [ -f "$LOCK_FILE" ]; then',
        '  echo "[ContextOS] Hook allerede i gang – hopper over." >&2',
        '  exit 0',
        'fi',
        'touch "$LOCK_FILE"',
        'trap \'rm -f "$LOCK_FILE"\' EXIT',
        '',
        '# Contextos-Skip trailer: manuell override via commit message',
        'COMMIT_MSG=$(git log -1 --pretty=%B)',
        'if echo "$COMMIT_MSG" | grep -q "Contextos-Skip: true"; then',
        '  echo "[ContextOS] Contextos-Skip: true funnet – hopper over." >&2',
        '  exit 0',
        'fi',
        '',
        '# Alt 1: Skipper hvis alle endrede filer er under .contextos/',
        'CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git show --name-only --format="" HEAD)',
        'if [ -z "$CHANGED_FILES" ]; then',
        '  exit 0',
        'fi',
        'NON_CONTEXTOS=$(echo "$CHANGED_FILES" | grep -v "^\\.contextos/")',
        'if [ -z "$NON_CONTEXTOS" ]; then',
        '  echo "[ContextOS] Kun .contextos/-filer endret – hopper over for å unngå bootstrap-loop." >&2',
        '  exit 0',
        'fi',
        '',
        `DIFF_FILE="${DIFF_TEMP_FILE}"`,
        'git diff HEAD~1 HEAD > "$DIFF_FILE" 2>/dev/null || git show HEAD > "$DIFF_FILE" 2>/dev/null',
        'exit 0',
    ].join('\n') + '\n';
    fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8', mode: 0o755 });
    console.log(`[ContextOS] post-commit hook installert: ${hookPath}`);
}

function readSystemRepo(systemRepoPath: string): string {
    if (!systemRepoPath || !fs.existsSync(systemRepoPath)) return '(system-repo ikke funnet)';
    const result: string[] = [];
    function collect(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) collect(full);
            else { result.push(`### ${path.relative(systemRepoPath, full)}\n${fs.readFileSync(full, 'utf8')}`); }
        }
    }
    collect(systemRepoPath);
    return result.join('\n\n');
}

function parseDraft(raw: string): ReviewDraft {
    // Hent seksjonene ved hjelp av XML-lignende tagger
    function extract(tag: string): string {
        const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const m = raw.match(re);
        return m ? m[1].trim() : '';
    }
    const changelog = extract('changelog') || raw; // fallback: hele teksten i changelog
    const components = extract('components');
    const decisions = extract('decisions');
    return { changelog, components, decisions };
}

async function handleDiff(diff: string, systemRepoPath: string) {
    const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
    if (!apiKey) { vscode.window.showWarningMessage('ContextOS: Sett contextos.apiKey.'); return; }

    const client = new Anthropic({ apiKey });
    const prompt = `Du er en teknisk dokumentasjonshjelper for prosjektet beskrevet i system-repoet.
Basert på følgende git diff, generer dokumentasjon strukturert med disse XML-taggene:

<changelog>
En kort changelog-entry (maks 3 linjer) som beskriver hva som ble endret.
</changelog>

<components>
Eventuelle oppdateringer til berørte komponenter. La tagg-innholdet være tomt om ingen komponenter er berørt.
</components>

<decisions>
Eventuelle beslutninger som bør dokumenteres. La tagg-innholdet være tomt om ingen nye beslutninger.
</decisions>

Git diff:
${diff}

Eksisterende system-repo kontekst:
${readSystemRepo(systemRepoPath)}`;

    try {
        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
        });
        const block = response.content[0];
        const raw = block.type === 'text' ? block.text : '';
        const draft = parseDraft(raw);

        // Åpne review-panel
        ReviewPanel.createOrShow(systemRepoPath, draft);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`ContextOS: Feil: ${e instanceof Error ? e.message : String(e)}`);
    }
}

let mcpProcess: cp.ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('ContextOS extension is now active!');
    let systemRepoPath = '';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        systemRepoPath = ensureSystemRepo(workspaceRoot);
        installGitHook(workspaceRoot);

        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        mcpProcess.stderr?.on('data', (data) => console.error(`[ContextOS MCP] ${data}`));
        mcpProcess.on('exit', (code) => console.log(`[ContextOS MCP] exited with code ${code}`));

        const diffWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(DIFF_TEMP_FILE), path.basename(DIFF_TEMP_FILE))
        );
        const onDiffChange = async () => {
            if (!fs.existsSync(DIFF_TEMP_FILE)) return;
            const diff = fs.readFileSync(DIFF_TEMP_FILE, 'utf8');
            if (!diff.trim()) return;
            fs.unlinkSync(DIFF_TEMP_FILE);
            await handleDiff(diff, systemRepoPath);
        };
        diffWatcher.onDidCreate(onDiffChange);
        diffWatcher.onDidChange(onDiffChange);
        context.subscriptions.push(diffWatcher);

        vscode.window.showInformationMessage('ContextOS: MCP-server og git-hook startet.');
    }

    const provider = new ChatViewProvider(context.extensionUri, systemRepoPath);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    }));

    // Manuell trigger for testing: åpne review-panel med dummy-utkast
    context.subscriptions.push(vscode.commands.registerCommand('contextos.openReview', async () => {
        const draftPath = path.join(os.tmpdir(), 'contextos-draft.md');
        if (fs.existsSync(draftPath)) {
            const raw = fs.readFileSync(draftPath, 'utf8');
            const draft = parseDraft(raw);
            ReviewPanel.createOrShow(systemRepoPath, draft);
        } else {
            // Åpne med tomt utkast for testing
            ReviewPanel.createOrShow(systemRepoPath, {
                changelog: '(ingen utkast funnet – skriv inn manuelt)',
                components: '',
                decisions: '',
            });
        }
    }));
}

export function deactivate() { if (mcpProcess) mcpProcess.kill(); }