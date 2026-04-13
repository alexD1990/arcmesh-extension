import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const systemRepoPath = process.argv[2];
const workspaceRoot = process.argv[3];

if (!systemRepoPath || !workspaceRoot) {
    process.stderr.write('Usage: mcpServer.js <system-repo-path> <workspace-root>\n');
    process.exit(1);
}

const EXCLUDED = new Set(['.git', 'node_modules', 'out', 'dist', '.next', '__pycache__']);

const server = new McpServer({
    name: 'contextos',
    version: '0.2.0',
});

// ── System-repo tools ─────────────────────────────────────────────────────────

server.tool('list_files', 'List all files in the system repo', {}, async () => {
    const files: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(path.relative(systemRepoPath, full));
        }
    }
    walk(systemRepoPath);
    return { content: [{ type: 'text', text: files.join('\n') }] };
});

server.tool('read_file', 'Read a file from the system repo', { path: z.string() }, async ({ path: filePath }) => {
    const full = path.resolve(systemRepoPath, filePath);
    if (!full.startsWith(path.resolve(systemRepoPath))) {
        return { content: [{ type: 'text', text: 'ERROR: Path traversal not allowed.' }] };
    }
    if (!fs.existsSync(full)) {
        return { content: [{ type: 'text', text: `ERROR: File not found: ${filePath}` }] };
    }
    const content = fs.readFileSync(full, 'utf8');
    return { content: [{ type: 'text', text: content }] };
});

server.tool('write_file', 'Write a file to the system repo', { path: z.string(), content: z.string() }, async ({ path: filePath, content }) => {
    const full = path.resolve(systemRepoPath, filePath);
    if (!full.startsWith(path.resolve(systemRepoPath))) {
        return { content: [{ type: 'text', text: 'ERROR: Path traversal not allowed.' }] };
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { content: [{ type: 'text', text: 'OK' }] };
});

server.tool(
    'write_planning_doc',
    'Write a planning document to docs/ or decisions/ in the system repo.',
    { path: z.string(), content: z.string() },
    async ({ path: filePath, content }) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (!normalized.startsWith('docs/') && !normalized.startsWith('decisions/')) {
            return { content: [{ type: 'text', text: `ERROR: Only docs/ and decisions/ allowed. Got: ${filePath}` }] };
        }
        const full = path.resolve(systemRepoPath, filePath);
        if (!full.startsWith(path.resolve(systemRepoPath))) {
            return { content: [{ type: 'text', text: 'ERROR: Path traversal not allowed.' }] };
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return { content: [{ type: 'text', text: `OK: wrote ${filePath}` }] };
    }
);

// ── Code-repo tools ───────────────────────────────────────────────────────────

server.tool('list_code_files', 'List all files in the code repository', {}, async () => {
    const results: string[] = [];
    function walk(dir: string, depth: number) {
        if (depth > 10) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (EXCLUDED.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else results.push(path.relative(workspaceRoot, full));
        }
    }
    walk(workspaceRoot, 0);
    return { content: [{ type: 'text', text: results.join('\n') || '(empty)' }] };
});

server.tool('read_code_file', 'Read a file from the code repository', { path: z.string() }, async ({ path: filePath }) => {
    const full = path.resolve(workspaceRoot, filePath);
    if (!full.startsWith(path.resolve(workspaceRoot))) {
        return { content: [{ type: 'text', text: 'ERROR: Path traversal not allowed.' }] };
    }
    if (!fs.existsSync(full)) {
        return { content: [{ type: 'text', text: `ERROR: File not found: ${filePath}` }] };
    }
    const stat = fs.statSync(full);
    if (stat.size > 200 * 1024) {
        return { content: [{ type: 'text', text: `ERROR: File too large (${Math.round(stat.size / 1024)}KB > 200KB).` }] };
    }
    const content = fs.readFileSync(full, 'utf8');
    return { content: [{ type: 'text', text: content }] };
});

server.tool('search_code', 'Search for text across all files in the code repository', { query: z.string() }, async ({ query }) => {
    const results: string[] = [];
    const lq = query.toLowerCase();
    function walk(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (EXCLUDED.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            try {
                const lines = fs.readFileSync(full, 'utf8').split('\n');
                const rel = path.relative(workspaceRoot, full);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(lq)) {
                        results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                        if (results.length >= 100) return;
                    }
                }
            } catch { /* skip unreadable */ }
        }
    }
    walk(workspaceRoot);
    if (results.length === 0) return { content: [{ type: 'text', text: '(no matches)' }] };
    const truncated = results.length === 100 ? '\n... (truncated at 100 results)' : '';
    return { content: [{ type: 'text', text: results.join('\n') + truncated }] };
});

const transport = new StdioServerTransport();
server.connect(transport);