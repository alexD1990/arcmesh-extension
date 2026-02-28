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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
const os = __importStar(require("os"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const chatProvider_1 = require("./chatProvider");
const reviewProvider_1 = require("./reviewProvider");
const PROJECT_MD_TEMPLATE = `# Project

## Description
<!-- Beskriv prosjektet her -->

## Goals
<!-- Hva er målet med prosjektet? -->

## Tech Stack
<!-- Teknisk stack -->
`;
const DIFF_TEMP_FILE = path.join(os.tmpdir(), 'contextos-post-commit.diff');
function ensureSystemRepo(workspaceRoot) {
    const systemRepoPath = path.join(workspaceRoot, '.contextos', 'system-repo');
    const dirs = [systemRepoPath, path.join(systemRepoPath, 'decisions'), path.join(systemRepoPath, 'components')];
    for (const dir of dirs) {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
    const projectMd = path.join(systemRepoPath, 'project.md');
    if (!fs.existsSync(projectMd))
        fs.writeFileSync(projectMd, PROJECT_MD_TEMPLATE, 'utf8');
    return systemRepoPath;
}
function installGitHook(workspaceRoot) {
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
        console.log('[ContextOS] Ingen .git – hopper over hook.');
        return;
    }
    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir))
        fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'post-commit');
    const hookContent = [
        '#!/bin/sh',
        '# ContextOS post-commit hook – autogenerert',
        `DIFF_FILE="${DIFF_TEMP_FILE}"`,
        'git diff HEAD~1 HEAD > "$DIFF_FILE" 2>/dev/null || git show HEAD > "$DIFF_FILE" 2>/dev/null',
        'exit 0',
    ].join('\n') + '\n';
    fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8', mode: 0o755 });
    console.log(`[ContextOS] post-commit hook installert: ${hookPath}`);
}
function readSystemRepo(systemRepoPath) {
    if (!systemRepoPath || !fs.existsSync(systemRepoPath))
        return '(system-repo ikke funnet)';
    const result = [];
    function collect(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                collect(full);
            else {
                result.push(`### ${path.relative(systemRepoPath, full)}\n${fs.readFileSync(full, 'utf8')}`);
            }
        }
    }
    collect(systemRepoPath);
    return result.join('\n\n');
}
function parseDraft(raw) {
    // Hent seksjonene ved hjelp av XML-lignende tagger
    function extract(tag) {
        const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const m = raw.match(re);
        return m ? m[1].trim() : '';
    }
    const changelog = extract('changelog') || raw; // fallback: hele teksten i changelog
    const components = extract('components');
    const decisions = extract('decisions');
    return { changelog, components, decisions };
}
async function handleDiff(diff, systemRepoPath) {
    const apiKey = vscode.workspace.getConfiguration('contextos').get('apiKey');
    if (!apiKey) {
        vscode.window.showWarningMessage('ContextOS: Sett contextos.apiKey.');
        return;
    }
    const client = new sdk_1.default({ apiKey });
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
        reviewProvider_1.ReviewPanel.createOrShow(systemRepoPath, draft);
    }
    catch (e) {
        vscode.window.showErrorMessage(`ContextOS: Feil: ${e instanceof Error ? e.message : String(e)}`);
    }
}
let mcpProcess;
function activate(context) {
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
        const diffWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(DIFF_TEMP_FILE), path.basename(DIFF_TEMP_FILE)));
        const onDiffChange = async () => {
            if (!fs.existsSync(DIFF_TEMP_FILE))
                return;
            const diff = fs.readFileSync(DIFF_TEMP_FILE, 'utf8');
            if (!diff.trim())
                return;
            fs.unlinkSync(DIFF_TEMP_FILE);
            await handleDiff(diff, systemRepoPath);
        };
        diffWatcher.onDidCreate(onDiffChange);
        diffWatcher.onDidChange(onDiffChange);
        context.subscriptions.push(diffWatcher);
        vscode.window.showInformationMessage('ContextOS: MCP-server og git-hook startet.');
    }
    const provider = new chatProvider_1.ChatViewProvider(context.extensionUri, systemRepoPath);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatProvider_1.ChatViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('contextos.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from contextos!');
    }));
    // Manuell trigger for testing: åpne review-panel med dummy-utkast
    context.subscriptions.push(vscode.commands.registerCommand('contextos.openReview', async () => {
        const draftPath = path.join(os.tmpdir(), 'contextos-draft.md');
        if (fs.existsSync(draftPath)) {
            const raw = fs.readFileSync(draftPath, 'utf8');
            const draft = parseDraft(raw);
            reviewProvider_1.ReviewPanel.createOrShow(systemRepoPath, draft);
        }
        else {
            // Åpne med tomt utkast for testing
            reviewProvider_1.ReviewPanel.createOrShow(systemRepoPath, {
                changelog: '(ingen utkast funnet – skriv inn manuelt)',
                components: '',
                decisions: '',
            });
        }
    }));
}
function deactivate() { if (mcpProcess)
    mcpProcess.kill(); }
//# sourceMappingURL=extension.js.map