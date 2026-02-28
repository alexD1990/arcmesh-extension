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
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zod_1 = require("zod");
const systemRepoPath = process.argv[2];
if (!systemRepoPath) {
    process.stderr.write('Usage: mcpServer.js <system-repo-path>\n');
    process.exit(1);
}
const server = new mcp_js_1.McpServer({
    name: 'contextos',
    version: '0.1.0',
});
server.tool('list_files', 'List all files in the system repo', {}, async () => {
    const files = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else
                files.push(path.relative(systemRepoPath, full));
        }
    }
    walk(systemRepoPath);
    return { content: [{ type: 'text', text: files.join('\n') }] };
});
server.tool('read_file', 'Read a file from the system repo', { path: zod_1.z.string() }, async ({ path: filePath }) => {
    const full = path.join(systemRepoPath, filePath);
    const content = fs.readFileSync(full, 'utf8');
    return { content: [{ type: 'text', text: content }] };
});
server.tool('write_file', 'Write a file to the system repo', { path: zod_1.z.string(), content: zod_1.z.string() }, async ({ path: filePath, content }) => {
    const full = path.join(systemRepoPath, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { content: [{ type: 'text', text: 'OK' }] };
});
const transport = new stdio_js_1.StdioServerTransport();
server.connect(transport);
//# sourceMappingURL=mcpServer.js.map