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

**Dato:** 2026-04-13
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

let mcpProcess: cp.ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('[ContextOS] Aktivert.');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('[ContextOS] Ingen workspace – avbryter.');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const systemRepoPath = ensureSystemRepo(workspaceRoot);
    console.log(`[ContextOS] system-repo: ${systemRepoPath}`);

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

    vscode.window.showInformationMessage('ContextOS: Klar.');
}

export function deactivate() {
    if (mcpProcess) mcpProcess.kill();
}