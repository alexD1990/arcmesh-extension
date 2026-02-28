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

const transport = new StdioServerTransport();
server.connect(transport);