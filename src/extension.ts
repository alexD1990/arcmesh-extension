import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Describe the project here -->

## Goals
<!-- What is the goal of the project? -->

## Tech Stack
<!-- Technical stack -->

## Status
<!-- Current status and next steps -->
`;

const ARCHITECTURE_MD_TEMPLATE = `# Architecture

## Overview
<!-- High-level architecture -->

## Key Components
<!-- Key components and their responsibilities -->

## Data Flow
<!-- Data flow through the system -->

## Dependencies
<!-- External dependencies and integrations -->
`;

const STANDARDS_MD_TEMPLATE = `# Standards

## Documentation Rules

- Nothing is overwritten – all history is preserved
- Always timestamp – format YYYY-MM-DD
- One decision = one file in \`decisions/\`
- One component = one file in \`components/\` with accumulated sections

## Conflict Resolution Priority

1. \`decisions/\` – explicit decision always wins
2. \`architecture.md\` – technical precision over direction
3. \`components/\` – module-specific over general
4. \`project.md\` – overall direction
5. \`changelog.md\` – historical log, not normative
`;

function ensureSystemRepo(workspaceRoot: string): string {
    const systemRepoPath = path.join(workspaceRoot, '.arcmesh', 'system-repo');
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

function ensureGitignore(workspaceRoot: string) {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const entry = '.arcmesh/';
    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (content.split('\n').some(line => line.trim() === entry)) return;
    const newline = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + newline + entry + '\n', 'utf8');
    console.log(`[ArcMesh] .gitignore updated with ${entry}`);
}

function writeMcpJson(workspaceRoot: string, extensionPath: string, systemRepoPath: string) {
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });
    const mcpJsonPath = path.join(vscodeDir, 'mcp.json');
    const serverScript = path.join(extensionPath, 'out', 'mcpServer.js');
    const config = {
        servers: {
            arcmesh: {
                type: 'stdio',
                command: 'node',
                args: [serverScript, systemRepoPath, workspaceRoot],
            },
        },
    };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[ArcMesh] mcp.json written: ${mcpJsonPath}`);
}

async function runOnboarding(workspaceRoot: string): Promise<boolean> {
    const hasGit = fs.existsSync(path.join(workspaceRoot, '.git'));

    const items = [
        {
            label: '$(repo) Connect to existing repo',
            description: hasGit ? 'Found .git in workspace' : 'No .git found – will only set up ArcMesh',
            action: 'existing' as const,
        },
        {
            label: '$(add) Create new repo',
            description: 'Runs git init in workspace',
            action: 'init' as const,
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'ArcMesh – Welcome',
        placeHolder: 'How would you like to set up this project?',
        ignoreFocusOut: true,
    });

    if (!picked) return false;

    if (picked.action === 'init') {
        const { execSync } = require('child_process');
        try {
            execSync('git init', { cwd: workspaceRoot });
            vscode.window.showInformationMessage('ArcMesh: git init completed.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`ArcMesh: git init failed – ${e.message}`);
            return false;
        }
    }

    return true;
}

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('[ArcMesh] Activated.');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('[ArcMesh] No workspace – aborting.');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const onboardingKey = 'arcmesh.onboardingComplete';
    const onboardingDone = context.globalState.get<boolean>(onboardingKey);

    if (!onboardingDone) {
        const ok = await runOnboarding(workspaceRoot);
        if (!ok) return;
        await context.globalState.update(onboardingKey, true);
    }

    const systemRepoPath = ensureSystemRepo(workspaceRoot);
    console.log(`[ArcMesh] system-repo: ${systemRepoPath}`);

    writeMcpJson(workspaceRoot, context.extensionPath, systemRepoPath);
    ensureGitignore(workspaceRoot);

    const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
    mcpProcess = cp.spawn('node', [serverScript, systemRepoPath, workspaceRoot], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcpProcess.stderr?.on('data', (data) => console.error(`[ArcMesh MCP] ${data}`));
    mcpProcess.on('exit', (code) => console.log(`[ArcMesh MCP] exited with code ${code}`));

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = '$(check) ArcMesh';
    statusBar.tooltip = 'ArcMesh active';
    statusBar.show();
    context.subscriptions.push(statusBar);

    vscode.window.showInformationMessage('ArcMesh ready – open Copilot Chat and ask about your project.');
}

export function deactivate() {
    if (mcpProcess) mcpProcess.kill();
}