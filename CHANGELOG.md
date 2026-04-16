# Changelog

## [0.2.3] - 2026-04-16

### Added
- Five new MCP tools for git operations on system-repo: `system_repo_git_status`, `system_repo_git_add`, `system_repo_git_commit`, `system_repo_git_push`, `system_repo_git_pull`

### Changed
- `mcpServer.ts` now has a dedicated `runGitSystemRepo` helper scoped to `systemRepoPath`, mirroring the existing `runGit` helper for the code repository

All notable changes to ArcMesh will be documented in this file.

## [0.2.2] - 2026-04-14

### Changed
- Replaced one-time onboarding wizard with `detectGitState` on every activation
- Git prompt now uses per-workspace "Don't ask again" state instead of global flag
- Status bar shows `ArcMesh + Git` when git is available, `ArcMesh` otherwise

### Fixed
- No longer blocks activation permanently if onboarding was skipped
- Informational message with "Get Git" link shown when git is not installed

## [0.2.1] - 2026-04-13

### Added
- Extension logo

## [0.2.0] - 2026-04-13

### Added
- MCP server exposing system-repo and code repository tools to AI assistants
- Git tools: `git_log`, `git_show`, `git_diff`, `git_blame`
- Code tools: `list_code_files`, `read_code_file`, `search_code`
- System-repo tools: `list_files`, `read_file`, `write_file`, `write_planning_doc`
- Automatic `mcp.json` generation in `.vscode/`
- Automatic `.gitignore` entry for `.arcmesh/`
- Onboarding QuickPick on first activation