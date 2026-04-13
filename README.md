# ArcMesh

ArcMesh is a VS Code extension that gives AI assistants persistent, structured context about your project. It sets up a local MCP (Model Context Protocol) server and a `system-repo` — a lightweight documentation structure that lives alongside your code — so that tools like GitHub Copilot Chat always have accurate, up-to-date knowledge about your project.

---

## How It Works

When ArcMesh activates, it:

1. Creates a `.arcmesh/system-repo/` directory in your workspace
2. Writes a `.vscode/mcp.json` that registers the local MCP server with VS Code
3. Starts a Node.js MCP server that exposes your system-repo and code repository to AI tools
4. Adds `.arcmesh/` to your `.gitignore`

The MCP server gives Copilot Chat (and any other MCP-compatible client) access to tools for reading and writing your system-repo, browsing your code, and querying git history — without you having to copy-paste context manually.

---

## Requirements

- VS Code 1.109.0 or later
- Node.js 18 or later
- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension

---

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` to launch the extension in a VS Code Extension Development Host

> A `.vsix` package for direct installation will be available in a future release.

---

## System-Repo Structure

ArcMesh creates the following structure inside `.arcmesh/system-repo/`:

```
.arcmesh/
└── system-repo/
    ├── project.md          # Project description, goals, tech stack, status
    ├── architecture.md     # High-level architecture and data flow
    ├── STANDARDS.md        # Documentation rules and conflict resolution priority
    ├── decisions/          # One file per architectural or technical decision
    └── components/         # One file per component with accumulated sections
```

This directory is excluded from git by default. It is local context for your AI assistant, not source code.

---

## MCP Tools

The ArcMesh MCP server exposes the following tools to AI assistants:

| Tool | Description |
|---|---|
| `list_files` | List all files in the system-repo |
| `read_file` | Read a file from the system-repo |
| `write_file` | Write a file to the system-repo |
| `write_planning_doc` | Write to `docs/` or `decisions/` only |
| `list_code_files` | List all files in the code repository |
| `read_code_file` | Read a file from the code repository |
| `search_code` | Full-text search across the code repository |
| `git_log` | Show recent commits |
| `git_show` | Show a specific commit |
| `git_diff` | Diff between two commits |
| `git_blame` | Show who changed each line in a file |

---

## Best Practices

### Keep system-repo up to date
ArcMesh is only as useful as the context you give it. After significant decisions or architectural changes, ask Copilot Chat to update the relevant files:

> "Update `architecture.md` to reflect the new data flow we just discussed."

### Use `decisions/` for every non-trivial choice
One decision per file, dated with `YYYY-MM-DD`. Example filename: `2024-11-01-use-databricks-for-pipeline.md`. This gives your AI assistant a durable record of *why* things are the way they are.

### Use `components/` for module-level documentation
Each component gets one file. Append new sections over time — never overwrite existing content. This preserves the history of how a component evolved.

### Ask in context
Copilot Chat will automatically use ArcMesh tools when you ask questions about your project. You do not need to reference the system-repo explicitly. Just ask naturally:

> "What is the current architecture of this project?"
> "Have we made any decisions about authentication?"
> "Which files are responsible for data ingestion?"

### Conflict resolution priority
When context from different sources conflicts, ArcMesh follows this order:

1. `decisions/` — explicit decisions always win
2. `architecture.md` — technical precision over general direction
3. `components/` — module-specific over general
4. `project.md` — overall direction
5. `changelog.md` — historical log, not normative

---

## Configuration

ArcMesh writes `.vscode/mcp.json` automatically on activation. You do not need to configure anything manually. The file will look like this:

```json
{
  "servers": {
    "arcmesh": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/out/mcpServer.js", "/path/to/.arcmesh/system-repo", "/path/to/workspace"]
    }
  }
}
```

---

## License

MIT
