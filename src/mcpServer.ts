import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const systemRepoPath = process.argv[2];

if (!systemRepoPath) {
    process.stderr.write('Usage: mcpServer.js <system-repo-path>\n');
    process.exit(1);
}

const server = new McpServer({
    name: 'contextos',
    version: '0.1.0',
});

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
    const full = path.join(systemRepoPath, filePath);
    const content = fs.readFileSync(full, 'utf8');
    return { content: [{ type: 'text', text: content }] };
});

server.tool('write_file', 'Write a file to the system repo', { path: z.string(), content: z.string() }, async ({ path: filePath, content }) => {
    const full = path.join(systemRepoPath, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { content: [{ type: 'text', text: 'OK' }] };
});

server.tool(
    'write_planning_doc',
    'Write a planning document directly to docs/ or decisions/ in the system repo. Only allowed paths: docs/ and decisions/. Cannot write to changelog.md or components/.',
    { path: z.string(), content: z.string() },
    async ({ path: filePath, content }) => {
        const normalized = filePath.replace(/\\/g, '/');
        const allowed = normalized.startsWith('docs/') || normalized.startsWith('decisions/');
        if (!allowed) {
            return { content: [{ type: 'text', text: `ERROR: write_planning_doc can only write to docs/ or decisions/. Got: ${filePath}` }] };
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
const transport = new StdioServerTransport();
server.connect(transport);