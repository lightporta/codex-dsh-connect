# Desktop plugin installation

**English** | [简体中文](plugin-installation.zh-CN.md) · [Project overview](../README.md)

The project includes a portable plugin manifest, bundled stdio MCP configuration, and a setup skill. It uses the same five delegation tools and native isolation as the direct MCP connection. Plugin packaging does not install Node, DeepSeek Harness, bubblewrap, or a WSL2 distribution.

This package is for local desktop execution. Local installation and a public directory listing are separate steps. Public local-MCP submissions currently require approved-partner access and organization allowlisting; this repository does not establish either. See [OpenAI's desktop-only plugin requirements](https://developers.openai.com/plugins/deploy/desktop-only).

## Prepare the execution environment

- Make Node `^22.19.0 || >=24.0.0` available to the desktop application's `PATH`. A shell's Node installation may not be visible to a desktop app; restart the app after changing its environment.
- Install the official `@deepseek-ai/dsh@0.2.1-rc.2` package separately, for example with `npm install --global @deepseek-ai/dsh@0.2.1-rc.2`, and identify its absolute package directory. Other versions are rejected. Complete account login through Harness itself, consulting the installed executable's help for the available login workflow. Never copy credentials into the plugin.
- On macOS, the executor uses Seatbelt. On Linux, install `/usr/bin/bwrap` and ensure the required namespace operations are permitted. See [platform validation](platform-validation.md) for Ubuntu AppArmor prerequisites.
- On Windows, install Node on the host for the plugin launcher. Install a supported Linux Node, bubblewrap, this connector, and pinned Harness inside an explicitly chosen WSL2 distribution. Complete native Harness account login in that distribution. See the Windows configuration below.

The connector itself has no third-party runtime package dependencies. For a source checkout with the lockfile, `npm ci --ignore-scripts --offline` prepares it without installing Harness.

## Select an authorized project

Run these commands from the complete plugin directory on macOS or Linux:

```sh
node bin/codex-dsh-plugin.mjs configure \
  --workspace /absolute/authorized/project \
  --dsh-root /absolute/path/to/node_modules/@deepseek-ai/dsh

node bin/codex-dsh-plugin.mjs status
```

Use an existing, specific project directory. Keep the plugin runtime, settings, credentials, and unrelated personal files outside that directory. `--credential-file /absolute/path`, `--max-requests 4`, and `--timeout-ms 60000` are optional; only the credential location is stored, never its contents. Native default credentials are at `~/.dsh/.credentials.yaml`, and the default Harness directory is `~/.npm-global/lib/node_modules/@deepseek-ai/dsh`.

The command creates `~/.config/codex-dsh-connect/plugin.json` for the current OS user. Windows uses `%USERPROFILE%\.config\codex-dsh-connect\plugin.json`. This file belongs to the connector; it is separate from the packaged `plugin.json` manifest. No personal Codex configuration is read or changed. Existing settings require `--force` to replace and are backed up first.

One default settings file selects **one project across plugin chats**. It does not follow the active repository or current working directory. Restart or reload the plugin's MCP connection after changing settings. Use the [direct configuration command](../README.md#install-and-connect-to-codex) for project-specific connections or multiple simultaneous workspaces, and avoid enabling a duplicate direct connection for the same executor.

`--settings-file /absolute/path/settings.json` can select a separate file for `configure`, `status`, or `mcp`. The packaged MCP entry uses the default file; configuring a custom file alone does not make the installed plugin load it. A separately maintained MCP entry must pass the same `--settings-file` argument. Do not store settings in the delegated project or edit a cached plugin as persistent configuration.

### Windows host and WSL2

From the plugin directory in Windows PowerShell, supply paths inside the chosen distribution:

```powershell
node bin/codex-dsh-plugin.mjs configure --wsl-distro Ubuntu-24.04 --wsl-node /usr/bin/node --wsl-cli /home/you/tools/codex-dsh-connect/bin/codex-dsh-connect.mjs --workspace /home/you/projects/example --dsh-root /home/you/.npm-global/lib/node_modules/@deepseek-ai/dsh --credential-file /home/you/.dsh/.credentials.yaml

node bin/codex-dsh-plugin.mjs status
```

The plugin launches `wsl.exe` with an argument vector, explicit distribution, and clean Linux environment. It does not use a shell, translate host paths, install WSL, or select the default distribution implicitly. The Linux connector and Harness installation must remain available at the supplied locations. A Windows-host offline test or successful configuration generation does not validate real WSL2 execution.

## Install from a local marketplace

Use a supported desktop client's local or repository marketplace. A concrete test layout is:

```text
local-plugin-test/
├── .agents/plugins/marketplace.json
└── plugins/codex-dsh-connect/
    ├── plugin.json
    ├── mcp.json
    ├── bin/
    ├── lib/
    ├── skills/
    └── ...other packaged project files
```

Copy the complete source or extracted package into `plugins/codex-dsh-connect`, including `assets`, `docs`, and the other distributed directories. Put this catalog at the test repository's `.agents/plugins/marketplace.json`, merging entries if a catalog already exists:

```json
{
  "name": "codex-dsh-local",
  "interface": { "displayName": "Codex DSH Local" },
  "plugins": [
    {
      "name": "codex-dsh-connect",
      "source": {
        "source": "local",
        "path": "./plugins/codex-dsh-connect"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

The source path resolves from `local-plugin-test`, not from `.agents/plugins`. Open that test repository in your desktop client, restart the app, select **Codex DSH Local** in its Plugins directory, and install the plugin. In clients supporting the authoring CLI, `codex plugin marketplace add /absolute/path/local-plugin-test` can register the source; use the desktop app to install and test it. Menu availability depends on the client and organization policy. Follow [OpenAI's local plugin packaging and marketplace guide](https://developers.openai.com/plugins/build/plugins).

The host installs a cached copy of the plugin. Update the catalog's source copy and refresh or restart the desktop client when testing a new revision. Keep user-specific settings in the separate connector settings file so package refreshes do not replace them. No marketplace, personal plugin installation, or public publication happens merely by checking out this repository.

## Verify the connection

Run the plugin's **Set up** action to invoke its bundled onboarding skill, or use the configuration commands above. The packaged `mcp.json` starts `node` with `${PLUGIN_ROOT}/bin/codex-dsh-plugin.mjs mcp`; the host expands `${PLUGIN_ROOT}`. The current directory grants no workspace access.

Before configuration, MCP startup and tool discovery can succeed while `dsh_status` reports `ready: false` and `reason: workspaceRequired`; task submission is refused. After configuration and connection restart, check the five tools: `dsh_status`, `dsh_delegate`, `dsh_run`, `dsh_runs`, and `dsh_kill`. `dsh_status` must report a configured workspace and the expected platform/isolation backend. Its readiness check does not read credentials and does not prove a successful model request or namespace launch.

From the complete source/package directory on macOS or Linux, run `npm test`, `npm run check`, and `npm run test:isolation` for offline tests and real synthetic isolation without a model request. On Windows with an existing WSL2 setup, follow the [real WSL2 validation instructions](platform-validation.md#run-real-windows-wsl2-validation). The CI WSL2 job is manual and remains unverified when skipped.

For end-to-end acceptance when a model request is intended, create a disposable project containing a deliberately incorrect addition function, configure that project explicitly, restart the connection, and ask `dsh_delegate` to read and repair only that file. Include the intended project's absolute path as `cwd` in plugin delegation calls: the executor rejects it if the saved workspace is different, guarding against a stale selection across chats. Poll the returned run ID with `dsh_run`, inspect its final answer and the actual file, and independently run the appropriate code check. Restore the intended project selection afterward. The existing [live smoke test](../README.md#validation) automates this acceptance for the direct MCP route; it uses the default native installation and is not a desktop plugin installation test.

Recorded macOS delegation and Ubuntu synthetic isolation results do not establish live Linux Harness execution or real WSL2 support. Report local CLI checks, actual desktop installation, platform isolation, and a completed live task separately.
