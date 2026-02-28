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

function ensureSystemRepo(workspaceRoot: string) {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [
        systemRepoPath,
        path.join(systemRepoPath, 'decisions'),
        path.join(systemRepoPath, 'components'),
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const projectMd = path.join(systemRepoPath, 'project.md');
    if (!fs.existsSync(projectMd)) {
        fs.writeFileSync(projectMd, PROJECT_MD_TEMPLATE, 'utf8');
    }

    return systemRepoPath;
}

let mcpProcess: cp.ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('ContextOS extension is now active!');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const systemRepoPath = ensureSystemRepo(workspaceRoot);

        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        mcpProcess.stderr?.on('data', (data) => {
            console.error(`[ContextOS MCP] ${data}`);
        });

        mcpProcess.on('exit', (code) => {
            console.log(`[ContextOS MCP] exited with code ${code}`);
        });

        vscode.window.showInformationMessage('ContextOS: MCP-server startet.');
    }

    const disposable = vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {
    if (mcpProcess) {
        mcpProcess.kill();
    }
}