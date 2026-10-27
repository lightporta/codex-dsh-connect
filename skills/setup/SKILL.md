---
name: setup
description: Set up or repair the local codex-dsh-connect plugin, including an explicitly authorized project, native DeepSeek Harness prerequisites, and MCP readiness.
---

Set up this desktop plugin for the user's intended project. Read the [installation guide](../../docs/plugin-installation.md), or its [Chinese edition](../../docs/plugin-installation.zh-CN.md), for commands and platform-specific prerequisites.

Locate the installed plugin root containing `plugin.json` and `bin/codex-dsh-plugin.mjs`; use absolute executable paths and argument arrays. Confirm the intended project from the conversation. Ask for its path only if it is missing or ambiguous; the plugin directory and current directory do not authorize a workspace. The default settings select one project across chats, so make that scope clear before changing an existing selection.

Check the Node version and Harness package metadata. This release requires Node `^22.19.0 || >=24.0.0` and `@deepseek-ai/dsh@0.2.1-rc.2`. On macOS use Seatbelt; Linux needs `/usr/bin/bwrap` and permitted namespaces. A Windows host must select a WSL2 distribution and supply Linux Node, connector, Harness, and project paths. Use the guide's WSL2 launcher rather than native Windows execution. Report missing prerequisites without silently changing system sandbox policy.

The user completes account login through native Harness. Consult the installed Harness executable's help for its login flow; do not invent a login command or read credentials, personal Codex settings, or previous sessions. Only a credential file path may be configured. Do not put tokens or credential contents in settings, prompts, or reports.

Use `node bin/codex-dsh-plugin.mjs configure --workspace /absolute/project` from the identified plugin root, adding explicit installation, credential-path, or budget options when needed. This writes connector settings only, normally to `~/.config/codex-dsh-connect/plugin.json`. It does not modify Codex configuration. An existing file is preserved unless replacement is authorized; `--force` retains a backup. `--settings-file` changes only the invocation using it, so a custom file also needs a matching MCP launch argument. Keep all configuration outside the delegated project.

Run the launcher's `status`, restart or reload the plugin connection, and call its `dsh_status`. Until configuration is supplied, `workspaceRequired` is expected and delegation must remain unavailable. The existing five delegation tools should appear after installation. Readiness confirms prerequisites, not a successful sandbox or model run; it does not disclose the saved project's path. Pass the user's intended absolute project path as `cwd` with plugin `dsh_delegate` calls so an old or mismatched selection is rejected. Use the synthetic offline isolation check for the target platform; run a live synthetic delegation only when requested or already authorized, then inspect the actual edited file and final result.

Do not duplicate an existing direct MCP configuration for the same executor. For separate projects or simultaneous workspaces, use the explicit per-project configuration route in the guide. Installation does not authorize publishing a plugin, changing a marketplace, or editing unrelated global configuration. Report what was checked, the selected project and platform, any restart still required, and the exact limits of the validation; real WSL2 and live Linux Harness execution remain unverified until run on those systems.
