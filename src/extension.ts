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

## System-Repo Location

- The system-repo is always located at \`<workspaceRoot>/.arcmesh/system-repo/\`
- All paths passed to MCP server args MUST be absolute
- Relative paths are forbidden in \`mcp.json\` server args

## Cloud Sync Config

- \`.arcmesh/cloud.json\` – inneholder \`cloudUrl\` (ikke sensitiv, ikke versjonskontrollert)
- \`.arcmesh/.cloud-token\` – API-token (sensitiv, ikke versjonskontrollert)
- Begge filer dekkes av \`.arcmesh/\`-oppføringen i \`.gitignore\`
- Format for \`cloud.json\`: \`{ "cloudUrl": "https://..." }\`
- Konfigureres via kommandoen \`ArcMesh: Configure Cloud Sync\`
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
}

function isGitInstalled(): boolean {
    try {
        cp.execSync('git --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

type GitState = 'git-ready' | 'skip' | 'no-git';

async function detectGitState(
    workspaceRoot: string,
    workspaceState: vscode.Memento
): Promise<GitState> {
    if (!isGitInstalled()) {
        vscode.window.showInformationMessage(
            'ArcMesh: Git is not installed. Install it from git-scm.com to enable full functionality.',
            'Get Git'
        ).then(choice => {
            if (choice === 'Get Git') {
                vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com'));
            }
        });
        return 'no-git';
    }

    if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
        return 'git-ready';
    }

    if (workspaceState.get<boolean>('arcmesh.skipGitPrompt') === true) {
        return 'skip';
    }

    const items = [
        { label: 'Yes – run git init', action: 'init' as const },
        { label: 'No', action: 'no' as const },
        { label: "Don't ask again", action: 'never' as const },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'ArcMesh – Git not found',
        placeHolder: 'This workspace has no git repository. Initialize one?',
        ignoreFocusOut: true,
    });

    if (!picked || picked.action === 'no') return 'skip';

    if (picked.action === 'never') {
        await workspaceState.update('arcmesh.skipGitPrompt', true);
        return 'skip';
    }

    try {
        cp.execSync('git init', { cwd: workspaceRoot });
    } catch (e: any) {
        vscode.window.showErrorMessage(`ArcMesh: git init failed – ${e.message}`);
        return 'skip';
    }

    return 'git-ready';
}

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('[ArcMesh] Activated.');

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = '$(circle-slash) ArcMesh';
    statusBar.tooltip = 'ArcMesh – click to activate';
    statusBar.command = 'arcmesh.activate';
    statusBar.show();
    context.subscriptions.push(statusBar);

    const cmd = vscode.commands.registerCommand('arcmesh.activate', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('ArcMesh: No workspace folder open.');
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const systemRepoPath = ensureSystemRepo(workspaceRoot);
        writeMcpJson(workspaceRoot, context.extensionPath, systemRepoPath);
        ensureGitignore(workspaceRoot);

        const gitState = await detectGitState(workspaceRoot, context.workspaceState);

        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        if (mcpProcess) mcpProcess.kill();
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath, workspaceRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        mcpProcess.stderr?.on('data', (data) => console.error(`[ArcMesh MCP] ${data}`));
        mcpProcess.on('exit', (code) => console.log(`[ArcMesh MCP] exited with code ${code}`));

        statusBar.text = gitState === 'git-ready' ? '$(check) ArcMesh + Git' : '$(check) ArcMesh';
        statusBar.tooltip = 'ArcMesh active';
        statusBar.command = undefined;

        vscode.window.showInformationMessage('ArcMesh ready – open Copilot Chat and ask about your project.');
    });

    const cloudCmd = vscode.commands.registerCommand('arcmesh.configureCloudSync', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('ArcMesh: No workspace folder open.');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const cloudUrl = await vscode.window.showInputBox({
            title: 'ArcMesh Cloud Sync – URL',
            prompt: 'Enter your ArcMesh Cloud URL',
            placeHolder: 'https://cloud.arcmesh.io',
            ignoreFocusOut: true,
        });
        if (!cloudUrl) return;

        const token = await vscode.window.showInputBox({
            title: 'ArcMesh Cloud Sync – Token',
            prompt: 'Enter your API token',
            password: true,
            ignoreFocusOut: true,
        });
        if (!token) return;

        const arcmeshDir = path.join(workspaceRoot, '.arcmesh');
        fs.mkdirSync(arcmeshDir, { recursive: true });

        fs.writeFileSync(
            path.join(arcmeshDir, 'cloud.json'),
            JSON.stringify({ cloudUrl }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(arcmeshDir, '.cloud-token'),
            token,
            'utf8'
        );

        vscode.window.showInformationMessage('ArcMesh: Cloud sync configured.');
    });

    context.subscriptions.push(cmd);
    context.subscriptions.push(cloudCmd);
}

export function deactivate() {
    if (mcpProcess) mcpProcess.kill();
}