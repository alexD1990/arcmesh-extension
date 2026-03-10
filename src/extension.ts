import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { ChatViewProvider } from './chatProvider';
import { ReviewPanel } from './reviewProvider';
import * as yaml from 'js-yaml';

const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->
`;

const ARCHITECTURE_MD_TEMPLATE = `# Architecture

## Overview
<!-- Overordnet arkitektur -->

## Key Components
<!-- Viktige komponenter og deres ansvar -->

## Data Flow
<!-- Dataflyt gjennom systemet -->
`;

const STANDARDS_MD_TEMPLATE = `# Documentation Standards

**Dato:** 2026-03-06
**Status:** Godkjent

## Prioriteringsrekkefølge ved konflikt

1. \`decisions/\` – eksplisitt beslutning trumfer alltid
2. \`architecture.md\` – teknisk presisjon trumfer retning
3. \`components/\` – modulspesifikk trumfer generell
4. \`project.md\` – overordnet retning
5. \`changelog.md\` – historisk logg, ikke normativ

## Skriveregler

- Ingenting overskrives – all historikk bevares
- Datostemp alltid – format YYYY-MM-DD
- En beslutning = én fil i \`decisions/\`
- En komponent = én fil i \`components/\` med akkumulerte seksjoner

## Arbeidsflyt

ContextOS fungerer som en chat-agent. Du stiller spørsmål i chatten,
og AI-en leser kildekode og dokumentasjon selv via tool use.

### Før implementasjon
1. Aktiver planleggingsmodus (Plan: PÅ) i chat-sidebar
2. Be AI-en skrive beslutning til \`decisions/YYYY-MM-DD-slug.md\`

### Etter implementasjon
3. Legg til entry i \`changelog.md\` manuelt eller via chat
4. Oppdater \`components/\` hvis modulansvar endret seg
5. Oppdater \`architecture.md\` hvis systemdesign endret seg

### Regler
- \`decisions/\` skrives alltid før kode
- \`changelog.md\` skrives alltid etter kode
`;

function ensureSystemRepo(workspaceRoot: string) {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [systemRepoPath, path.join(systemRepoPath, 'decisions'), path.join(systemRepoPath, 'components')];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    const projectMd = path.join(systemRepoPath, 'project.md');
    if (!fs.existsSync(projectMd)) fs.writeFileSync(projectMd, PROJECT_MD_TEMPLATE, 'utf8');
    const architectureMd = path.join(systemRepoPath, 'architecture.md');
    if (!fs.existsSync(architectureMd)) fs.writeFileSync(architectureMd, ARCHITECTURE_MD_TEMPLATE, 'utf8');
    const standardsMd = path.join(systemRepoPath, 'STANDARDS.md');
    if (!fs.existsSync(standardsMd)) fs.writeFileSync(standardsMd, STANDARDS_MD_TEMPLATE, 'utf8');
    return systemRepoPath;
}

function ensureConfig(workspaceRoot: string): string {
    const configDir = path.join(workspaceRoot, '.contextos');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        const projectName = path.basename(workspaceRoot);
        const content = [
            `project:`,
            `  name: ${projectName}`,
            `  description: ""`,
            ``,
            `triggers:`,
            `  auto_generate: true`,
            `  on_save: false`,
            ``,
            `model:`,
            `  provider: anthropic`,
            `  name: claude-sonnet-4-6`,
        ].join('\n') + '\n';
        fs.writeFileSync(configPath, content, 'utf8');
        console.log(`[ContextOS] config.yaml opprettet: ${configPath}`);
    }
    return configPath;
}

interface ContextOSConfig {
    project: { name: string; description: string };
    triggers: { auto_generate: boolean; on_save: boolean };
    model: { provider: string; name: string };
}

function loadConfig(workspaceRoot: string): ContextOSConfig {
    const configPath = path.join(workspaceRoot, '.contextos', 'config.yaml');
    const defaultConfig: ContextOSConfig = {
        project: { name: path.basename(workspaceRoot), description: '' },
        triggers: { auto_generate: true, on_save: false },
        model: { provider: 'anthropic', name: 'claude-sonnet-4-6' }
    };
    if (!fs.existsSync(configPath)) {
        console.warn('[ContextOS] config.yaml ikke funnet – bruker default-konfig.');
        return defaultConfig;
    }
    try {
        const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as Partial<ContextOSConfig>;
        if (!parsed?.project) console.warn('[ContextOS] config.yaml mangler "project"-felt.');
        if (!parsed?.triggers) console.warn('[ContextOS] config.yaml mangler "triggers"-felt.');
        if (!parsed?.model) console.warn('[ContextOS] config.yaml mangler "model"-felt.');
        return { ...defaultConfig, ...parsed };
    } catch (e) {
        console.error(`[ContextOS] Feil ved parsing av config.yaml: ${e}`);
        return defaultConfig;
    }
}

function installGitHook(workspaceRoot: string) {
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) { console.log('[ContextOS] Ingen .git – hopper over hook.'); return; }
    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'post-commit');
    const lockFile = path.join(hooksDir, '.contextos_post_commit.lock');
    const DIFF_TEMP_FILE = path.join(os.tmpdir(), 'contextos-post-commit.diff');
    const hookContent = [
        '#!/bin/sh',
        '# ContextOS post-commit hook – autogenerert',
        '',
        'LOCK_FILE="' + lockFile + '"',
        'if [ -f "$LOCK_FILE" ]; then',
        '  echo "[ContextOS] Hook allerede i gang – hopper over." >&2',
        '  exit 0',
        'fi',
        'touch "$LOCK_FILE"',
        'trap \'rm -f "$LOCK_FILE"\' EXIT',
        '',
        'COMMIT_MSG=$(git log -1 --pretty=%B)',
        'if echo "$COMMIT_MSG" | grep -q "Contextos-Skip: true"; then',
        '  echo "[ContextOS] Contextos-Skip: true funnet – hopper over." >&2',
        '  exit 0',
        'fi',
        '',
        'CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git show --name-only --format="" HEAD)',
        'if [ -z "$CHANGED_FILES" ]; then',
        '  exit 0',
        'fi',
        'NON_CONTEXTOS=$(echo "$CHANGED_FILES" | grep -v "^\\.contextos/")',
        'if [ -z "$NON_CONTEXTOS" ]; then',
        '  echo "[ContextOS] Kun .contextos/-filer endret – hopper over." >&2',
        '  exit 0',
        'fi',
        '',
        'DIFF_FILE="' + DIFF_TEMP_FILE + '"',
        'git diff HEAD~1 HEAD > "$DIFF_FILE" 2>/dev/null || git show HEAD > "$DIFF_FILE" 2>/dev/null',
        'exit 0',
    ].join('\n') + '\n';
    fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8', mode: 0o755 });
    console.log(`[ContextOS] post-commit hook installert: ${hookPath}`);
    const cmdHookPath = path.join(hooksDir, 'post-commit.cmd');
    const cmdHookContent = [
        '@echo off',
        'REM ContextOS post-commit hook (Windows) – autogenerert',
        'git diff HEAD~1 HEAD > "%TEMP%\\contextos-post-commit.diff" 2>nul || git show HEAD > "%TEMP%\\contextos-post-commit.diff" 2>nul',
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(cmdHookPath, cmdHookContent, { encoding: 'utf8' });
    console.log(`[ContextOS] post-commit.cmd hook installert: ${cmdHookPath}`);
}

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('ContextOS extension is now active!');
    let systemRepoPath = '';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        systemRepoPath = ensureSystemRepo(workspaceRoot);
        ensureConfig(workspaceRoot);

        const existingApiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
        if (!existingApiKey) {
            const input = await vscode.window.showInputBox({
                prompt: 'Velkommen til ContextOS! Lim inn din Anthropic API-nøkkel for å komme i gang.',
                password: true,
                ignoreFocusOut: true
            });
            if (input) {
                await vscode.workspace.getConfiguration('contextos').update(
                    'apiKey', input, vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage('ContextOS: API-nøkkel lagret. Klar til bruk!');
            }
        }

        let config = loadConfig(workspaceRoot);

        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBar.text = '$(check) ContextOS';
        statusBar.tooltip = 'ContextOS aktiv';
        statusBar.show();
        context.subscriptions.push(statusBar);

        const configWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '.contextos/config.yaml')
        );
        const reloadConfig = () => {
            config = loadConfig(workspaceRoot);
            console.log('[ContextOS] config.yaml reloadet.');
        };
        configWatcher.onDidChange(reloadConfig);
        configWatcher.onDidCreate(reloadConfig);
        context.subscriptions.push(configWatcher);

        installGitHook(workspaceRoot);

        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        mcpProcess.stderr?.on('data', (data) => console.error(`[ContextOS MCP] ${data}`));
        mcpProcess.on('exit', (code) => console.log(`[ContextOS MCP] exited with code ${code}`));

        vscode.window.showInformationMessage('ContextOS: Klar.');
    }

    const provider = new ChatViewProvider(context.extensionUri, systemRepoPath);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('contextos.explainProblem', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('ContextOS: Ingen aktiv editor.');
            return;
        }

        const uri = editor.document.uri;
        const filePath = vscode.workspace.asRelativePath(uri);
        const allDiagnostics = vscode.languages.getDiagnostics(uri);
        const errors = allDiagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        let message: string;
        if (errors.length === 0) {
            vscode.window.showInformationMessage('ContextOS: Ingen feil i denne filen.');
            return;
        } else if (errors.length <= 5) {
            const lines = errors.map(d => `- Ln ${d.range.start.line + 1}: ${d.message}`).join('\n');
            message = `Forklar disse feilene i ${filePath} og hjelp meg å fikse dem:\n${lines}`;
        } else {
            message = `${filePath} har ${errors.length} feil. Les filen og finn rotårsaken.`;
        }

        await provider.sendMessage(message);
    }));
}

export function deactivate() { if (mcpProcess) mcpProcess.kill(); }