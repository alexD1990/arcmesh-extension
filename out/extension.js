"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
const chatProvider_1 = require("./chatProvider");
const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->
`;
function ensureSystemRepo(workspaceRoot) {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [
        systemRepoPath,
        path.join(systemRepoPath, 'decisions'),
        path.join(systemRepoPath, 'components'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
    const projectMd = path.join(systemRepoPath, 'project.md');
    if (!fs.existsSync(projectMd))
        fs.writeFileSync(projectMd, PROJECT_MD_TEMPLATE, 'utf8');
    return systemRepoPath;
}
let mcpProcess;
function activate(context) {
    console.log('ContextOS extension is now active!');
    let systemRepoPath = '';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        systemRepoPath = ensureSystemRepo(workspaceRoot);
        const serverScript = path.join(context.extensionPath, 'out', 'mcpServer.js');
        mcpProcess = cp.spawn('node', [serverScript, systemRepoPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        mcpProcess.stderr?.on('data', (data) => console.error(`[ContextOS MCP] ${data}`));
        mcpProcess.on('exit', (code) => console.log(`[ContextOS MCP] exited with code ${code}`));
        vscode.window.showInformationMessage('ContextOS: MCP-server startet.');
    }
    const provider = new chatProvider_1.ChatViewProvider(context.extensionUri, systemRepoPath);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatProvider_1.ChatViewProvider.viewType, provider));
    const disposable = vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    });
    context.subscriptions.push(disposable);
}
function deactivate() {
    if (mcpProcess)
        mcpProcess.kill();
}
//# sourceMappingURL=extension.js.map