import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { ChatViewProvider } from './chatProvider';
import { ReviewPanel, ReviewDraft } from './reviewProvider';
import * as yaml from 'js-yaml';
import { resolveContext } from './contextResolver';

const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->
`;

const DIFF_TEMP_FILE = path.join(os.tmpdir(), 'contextos-post-commit.diff');

const ARCHITECTURE_MD_TEMPLATE = `# Architecture

## Overview
<!-- Overordnet arkitektur -->

## Key Components
<!-- Viktige komponenter og deres ansvar -->

## Data Flow
<!-- Dataflyt gjennom systemet -->
`;

const STANDARDS_MD_TEMPLATE = `# Documentation Standards

**Dato:** 2026-03-04
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

### Før implementasjon
1. Skriv beslutning i \`decisions/YYYY-MM-DD-slug.md\`

### Etter implementasjon
2. Legg til entry i \`changelog.md\`
3. Oppdater \`components/\` hvis modulansvar endret seg
4. Oppdater \`architecture.md\` hvis systemdesign endret seg

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
            `context_map:`,
            `  "src/components/": components/`,
            `  "src/api/":        decisions/api.md`,
            `  "src/lib/":        components/lib.md`,
            `  "*.config.*":      decisions/config.md`,
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
    context_map: Record<string, string>;
    triggers: { auto_generate: boolean; on_save: boolean };
    model: { provider: string; name: string };
}

function loadConfig(workspaceRoot: string): ContextOSConfig {
    const configPath = path.join(workspaceRoot, '.contextos', 'config.yaml');
    const defaultConfig: ContextOSConfig = {
        project: { name: path.basename(workspaceRoot), description: '' },
        context_map: {},
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
    const cmdHookPath = path.join(hooksDir, 'post-commit.cmd');
    const cmdHookContent = [
        '@echo off',
        'REM ContextOS post-commit hook (Windows) – autogenerert',
        'git diff HEAD~1 HEAD > "%TEMP%\\contextos-post-commit.diff" 2>nul || git show HEAD > "%TEMP%\\contextos-post-commit.diff" 2>nul',
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(cmdHookPath, cmdHookContent, { encoding: 'utf8' });
    console.log(`[ContextOS] post-commit.cmd hook installert: ${cmdHookPath}`);
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

function parseChangedFiles(diff: string): string[] {
    const files: string[] = [];
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            files.push(line.slice(6).trim());
        }
    }
    return files;
}

function readSystemRepoSelective(systemRepoPath: string, selectedPaths: string[]): string {
    if (!systemRepoPath || !fs.existsSync(systemRepoPath)) return '(system-repo ikke funnet)';
    const result: string[] = [];

    for (const selected of selectedPaths) {
        const full = path.join(systemRepoPath, selected);
        if (!fs.existsSync(full)) continue;

        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
                if (entry.isFile()) {
                    const filePath = path.join(full, entry.name);
                    const rel = path.relative(systemRepoPath, filePath);
                    result.push(`### ${rel}\n${fs.readFileSync(filePath, 'utf8')}`);
                }
            }
        } else {
            const rel = path.relative(systemRepoPath, full);
            // Spesialhåndtering for changelog.md: kun siste 10 linjer
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

const outputChannel = vscode.window.createOutputChannel('ContextOS');

async function handleDiff(diff: string, systemRepoPath: string, config: ContextOSConfig) {
    const apiKey = vscode.workspace.getConfiguration('contextos').get<string>('apiKey');
    if (!apiKey) { vscode.window.showWarningMessage('ContextOS: Sett contextos.apiKey.'); return; }

    const changedFiles = parseChangedFiles(diff);
    const selectedPaths = resolveContext(changedFiles, config.context_map);

    outputChannel.appendLine(`[ContextOS] Endrede filer: ${changedFiles.join(', ') || '(ingen)'}`);
    outputChannel.appendLine(`[ContextOS] Valgt kontekst: ${selectedPaths.join(', ')}`);
    outputChannel.show(true);

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
${readSystemRepoSelective(systemRepoPath, selectedPaths)}`;

    try {
        const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
        });
        const block = response.content[0];
        const raw = block.type === 'text' ? block.text : '';
        const draft = parseDraft(raw);
        ReviewPanel.createOrShow(systemRepoPath, draft);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`ContextOS: Feil: ${e instanceof Error ? e.message : String(e)}`);
    }
}

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('ContextOS extension is now active!');
    let systemRepoPath = '';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        systemRepoPath = ensureSystemRepo(workspaceRoot);
        const configPath = ensureConfig(workspaceRoot);
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
        statusBar.text = config.triggers.auto_generate ? '$(check) ContextOS: Auto' : '$(circle-slash) ContextOS: Manuell';
        statusBar.tooltip = 'ContextOS trigger-modus';
        statusBar.command = 'contextos.generateDocumentation';
        statusBar.show();
        context.subscriptions.push(statusBar);

        const configWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '.contextos/config.yaml')
        );
        const reloadConfig = () => {
            config = loadConfig(workspaceRoot);
            statusBar.text = config.triggers.auto_generate ? '$(check) ContextOS: Auto' : '$(circle-slash) ContextOS: Manuell';
            outputChannel.appendLine('[ContextOS] config.yaml reloadet.');
            outputChannel.show(true);
        };
        configWatcher.onDidChange(reloadConfig);
        configWatcher.onDidCreate(reloadConfig);
        context.subscriptions.push(configWatcher);

        if (config.triggers.on_save) {
            const saveWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(workspaceRoot, '**/*')
            );
            saveWatcher.onDidChange(async (uri) => {
                if (uri.fsPath.includes('.contextos')) return;
                outputChannel.appendLine(`[ContextOS] Fil lagret: ${uri.fsPath} – genererer dokumentasjon...`);
                outputChannel.show(true);
                const diff = cp.execSync(`git -C "${workspaceRoot}" diff HEAD -- "${uri.fsPath}"`).toString();
                if (!diff.trim()) return;
                await handleDiff(diff, systemRepoPath, config);
            });
            context.subscriptions.push(saveWatcher);
        }
        installGitHook(workspaceRoot);

        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        mcpProcess.stderr?.on('data', (data) => console.error(`[ContextOS MCP] ${data}`));
        mcpProcess.on('exit', (code) => console.log(`[ContextOS MCP] exited with code ${code}`));

        const diffWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(DIFF_TEMP_FILE), path.basename(DIFF_TEMP_FILE))
        );
        const lastDiff = path.join(os.tmpdir(), 'contextos-last.diff');

        const onDiffChange = async () => {
            if (!fs.existsSync(DIFF_TEMP_FILE)) return;
            const diff = fs.readFileSync(DIFF_TEMP_FILE, 'utf8');
            if (!diff.trim()) return;
            fs.writeFileSync(lastDiff, diff, 'utf8');
            fs.unlinkSync(DIFF_TEMP_FILE);
            if (!config.triggers.auto_generate) {
                outputChannel.appendLine('[ContextOS] auto_generate=false – hopper over auto-generering.');
                outputChannel.show(true);
                return;
            }
            await handleDiff(diff, systemRepoPath, config);
        };
        diffWatcher.onDidCreate(onDiffChange);
        diffWatcher.onDidChange(onDiffChange);
        context.subscriptions.push(diffWatcher);

        context.subscriptions.push(vscode.commands.registerCommand('contextos.generateDocumentation', async () => {
            if (fs.existsSync(lastDiff)) {
                const diff = fs.readFileSync(lastDiff, 'utf8');
                await handleDiff(diff, systemRepoPath, config);
            } else {
                vscode.window.showWarningMessage('ContextOS: Ingen diff tilgjengelig. Gjør en commit først.');
            }
        }));

        vscode.window.showInformationMessage('ContextOS: MCP-server og git-hook startet.');
    }

    const provider = new ChatViewProvider(context.extensionUri, systemRepoPath);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    }));
}

export function deactivate() { if (mcpProcess) mcpProcess.kill(); }