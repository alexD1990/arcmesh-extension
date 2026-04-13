import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->

## Status
<!-- Nåværende status og neste steg -->
`;

const ARCHITECTURE_MD_TEMPLATE = `# Architecture

## Overview
<!-- Overordnet arkitektur -->

## Key Components
<!-- Viktige komponenter og deres ansvar -->

## Data Flow
<!-- Dataflyt gjennom systemet -->

## Dependencies
<!-- Eksterne avhengigheter og integrasjoner -->
`;

const STANDARDS_MD_TEMPLATE = `# Standards

## Dokumentasjonsregler

- Ingenting overskrives – all historikk bevares
- Datostemp alltid – format YYYY-MM-DD
- En beslutning = én fil i \`decisions/\`
- En komponent = én fil i \`components/\` med akkumulerte seksjoner

## Prioriteringsrekkefølge ved konflikt

1. \`decisions/\` – eksplisitt beslutning trumfer alltid
2. \`architecture.md\` – teknisk presisjon trumfer retning
3. \`components/\` – modulspesifikk trumfer generell
4. \`project.md\` – overordnet retning
5. \`changelog.md\` – historisk logg, ikke normativ
`;

function ensureSystemRepo(workspaceRoot: string): string {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [
        systemRepoPath,
        path.join(systemRepoPath, 'decisions'),
        path.join(systemRepoPath, 'components'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    const files: [string, string][] = [
        ['project.md', PROJECT_MD_TEMPLATE],
        ['architecture.md', ARCHITECTURE_MD_TEMPLATE],
        ['STANDARDS.md', STANDARDS_MD_TEMPLATE],
    ];
    for (const [name, template] of files) {
        const filePath = path.join(systemRepoPath, name);
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, template, 'utf8');
    }
    return systemRepoPath;
}

function writeMcpJson(workspaceRoot: string, extensionPath: string, systemRepoPath: string) {
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });
    const mcpJsonPath = path.join(vscodeDir, 'mcp.json');
    const serverScript = path.join(extensionPath, 'out', 'mcpServer.js');
    const config = {
        servers: {
            contextos: {
                type: 'stdio',
                command: 'node',
                args: [serverScript, systemRepoPath, workspaceRoot],
            },
        },
    };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[ContextOS] mcp.json skrevet: ${mcpJsonPath}`);
}

async function runOnboarding(workspaceRoot: string): Promise<boolean> {
    const hasGit = fs.existsSync(path.join(workspaceRoot, '.git'));

    const items = [
        {
            label: '$(repo) Koble til eksisterende repo',
            description: hasGit ? 'Fant .git i workspace' : 'Ingen .git funnet – vil kun sette opp ContextOS',
            action: 'existing' as const,
        },
        {
            label: '$(add) Opprett nytt repo',
            description: 'Kjører git init i workspace',
            action: 'init' as const,
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'ContextOS – Velkommen',
        placeHolder: 'Hvordan vil du sette opp dette prosjektet?',
        ignoreFocusOut: true,
    });

    if (!picked) return false;

    if (picked.action === 'init') {
        const { execSync } = require('child_process');
        try {
            execSync('git init', { cwd: workspaceRoot });
            vscode.window.showInformationMessage('ContextOS: git init fullført.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`ContextOS: git init feilet – ${e.message}`);
            return false;
        }
    }

    return true;
}

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('[ContextOS] Aktivert.');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('[ContextOS] Ingen workspace – avbryter.');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const onboardingKey = 'contextos.onboardingComplete';
    const onboardingDone = context.globalState.get<boolean>(onboardingKey);

    if (!onboardingDone) {
        const ok = await runOnboarding(workspaceRoot);
        if (!ok) return;
        await context.globalState.update(onboardingKey, true);
    }

    const systemRepoPath = ensureSystemRepo(workspaceRoot);
    console.log(`[ContextOS] system-repo: ${systemRepoPath}`);

    writeMcpJson(workspaceRoot, context.extensionPath, systemRepoPath);

    const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
    mcpProcess = cp.spawn('node', [serverScript, systemRepoPath, workspaceRoot], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcpProcess.stderr?.on('data', (data) => console.error(`[ContextOS MCP] ${data}`));
    mcpProcess.on('exit', (code) => console.log(`[ContextOS MCP] exited with code ${code}`));

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = '$(check) ContextOS';
    statusBar.tooltip = 'ContextOS aktiv';
    statusBar.show();
    context.subscriptions.push(statusBar);

    vscode.window.showInformationMessage('ContextOS klar – åpne Copilot Chat og spør om prosjektet ditt.');
}

export function deactivate() {
    if (mcpProcess) mcpProcess.kill();
}