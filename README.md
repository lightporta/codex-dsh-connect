# codex-dsh-connect

English | [简体中文](README.zh-CN.md)

Delegate explicitly authorized coding tasks from Codex to the **native DeepSeek Harness**. This standalone Node.js project launches Harness directly through stdio MCP, with no third-party runtime dependencies.

```text
Codex → stdio MCP → codex-dsh-connect
                         ↓
          Seatbelt / bubblewrap sandbox
                         ↓
              Native DeepSeek Harness
                         ↓
            Authorized project file tools
```

Harness handles model authentication, its message protocol, the tool loop, and usage reporting. The connector manages tasks, permissions, cancellation, and final results, limiting intermediate context returned to Codex. It does not replace Codex's built-in subagents, and no GPT billing savings have been measured.

## Current version

Version `0.2.1` includes a Linux bubblewrap backend, Windows WSL2 configuration, and targeted AppArmor policy preparation for Ubuntu CI. It requires Node `^22.19.0 || >=24.0.0` and the pinned official package `@deepseek-ai/dsh@0.2.1-rc.2`. Complete **DeepSeek account login through Harness itself** before running tasks. The connector uses the native `deepseek-account / deepseek-flash` route and does not require a separate API key. Other Harness versions are rejected.

| Environment | Execution backend | Validation status |
| --- | --- | --- |
| macOS | Seatbelt | Local tests, real isolation, and live Harness file reading, editing, and final-answer return passed for 0.2.1. |
| Linux | `/usr/bin/bwrap` | Ubuntu 24.04 offline CI and real synthetic isolation passed. Live Harness model execution remains unverified. |
| Windows | Linux backend in an explicitly selected WSL2 distribution | Windows host offline CI and WSL argument/configuration simulations passed. Real WSL2 execution remains unverified. |

Native Windows Node is used for configuration generation and protocol tests; task execution runs inside WSL2. The [recorded 0.2.1 CI run](https://github.com/lightporta/codex-dsh-connect/actions/runs/40446548374) passed six OS/Node offline combinations and both macOS/Linux real synthetic isolation jobs. The manual WSL2 job was skipped. Live Harness model execution on Linux/WSL2 remains unverified. See the [validation record](docs/validation.json) for exact evidence.

Each task gets a fresh temporary profile and session. Harness receives only three project file tools: no shell, code execution, dependency installation, network tools, or old-session resumption. Results are retained only in the current MCP process, and temporary sessions are removed after completion. This is not a persistent web service.

## Install and connect to Codex

For the bundled desktop plugin, follow the [plugin installation and setup guide](docs/plugin-installation.md). It includes `plugin.json`, `mcp.json`, delegation and setup skills, and an original icon. The plugin starts without a workspace and refuses delegation until you explicitly configure one. Settings survive package refreshes outside the plugin cache. Use one connection route for a given executor to avoid duplicate tools.

From your source checkout or extracted source directory:

```sh
cd /absolute/path/codex-dsh-connect
npm ci --ignore-scripts --offline
node bin/codex-dsh-connect.mjs --help
node bin/codex-dsh-connect.mjs status --workspace /absolute/authorized/project
node bin/codex-dsh-connect.mjs config --workspace /absolute/authorized/project
```

`--workspace` must explicitly identify an existing project directory. The last command only prints a configuration snippet, for example:

```toml
[mcp_servers.codex_dsh_connect]
command = "/absolute/path/to/node"
args = ["/absolute/path/codex-dsh-connect/bin/codex-dsh-connect.mjs", "mcp", "--workspace", "/absolute/authorized/project"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Merge the generated snippet into your chosen Codex configuration. The project does not read or modify global Codex configuration or read default client configuration. Authorize a specific project directory; keep unrelated personal files outside that workspace.

If Harness is installed outside the default npm location, pass its directory explicitly:

```sh
node bin/codex-dsh-connect.mjs config \
  --workspace /absolute/authorized/project \
  --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

The default installation directory is `~/.npm-global/lib/node_modules/@deepseek-ai/dsh`. Native credentials default to `~/.dsh/.credentials.yaml`. The connector does not read, display, or copy their contents; only the sandboxed Harness receives read-only access. Use `--credential-file /absolute/path` to select another location. Linux performs metadata checks on that file before a live launch.

### Linux and Windows WSL2

Install your distribution's bubblewrap package first, for example `sudo apt-get install bubblewrap` on Ubuntu, and ensure that unprivileged user namespaces are allowed. Ubuntu 24.04 AppArmor may also require an administrator to load the distribution's dedicated bwrap policy; see [platform validation](docs/platform-validation.md). Missing dependencies or restrictive host policy cause execution to fail; there is no unsandboxed fallback. Node and Harness installation paths must be canonical. Only the authorized project and task scratch directory are writable.

On Windows, install Linux Node, bubblewrap, this project, and Harness inside the selected WSL2 distribution, then complete native account login there. Run the preceding commands directly inside WSL2, or generate a Windows launch snippet:

```powershell
node bin/codex-dsh-connect.mjs config --wsl-distro Ubuntu-24.04 --wsl-node /usr/bin/node --wsl-cli /home/you/tools/codex-dsh-connect/bin/codex-dsh-connect.mjs --workspace /home/you/projects/example --dsh-root /home/you/.npm-global/lib/node_modules/@deepseek-ai/dsh --credential-file /home/you/.dsh/.credentials.yaml
```

All supplied paths belong to that distribution; Windows paths are not translated automatically. The generated `wsl.exe --distribution ... --exec /usr/bin/env -i ...` launch uses an argument vector without a shell or inherited host credential environment. Keep the project on the distribution's Linux filesystem where possible. Configuration generation also preserves explicit `--credential-file`, `--max-requests`, and `--timeout-ms` settings.

Official documentation: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex Skills](https://learn.chatgpt.com/docs/build-skills).

## Delegation and file capabilities

| MCP tool | Behavior |
| --- | --- |
| `dsh_status` | Check the native installation, platform, workspace configuration, and limits without reading credentials. |
| `dsh_delegate` | Submit a new task asynchronously and immediately return a run ID. |
| `dsh_run` | Poll for up to 25 seconds and return bounded final-answer and usage data. |
| `dsh_runs` | List bounded run IDs and states without prompts or result bodies. |
| `dsh_kill` | Request process-tree cancellation; poll afterwards to confirm a terminal state. |

Specify the allowed files, expected behavior, and acceptance criteria in each task. If supplied, `cwd` must equal the configured workspace; it cannot expand file authorization.

Native Harness sees only `project_list_files`, `project_read_text`, and `project_write_text`. Files are limited to 64 KiB, paths to eight segments/512 characters, and tool output to 8,192 characters. The tools reject absolute paths, `..`, symlinks, hard links, and common sensitive paths such as `.git`, `.env`, credentials, and private keys. Parent directories must already exist. Writes use a same-directory temporary file followed by atomic rename. Codex or the user must inspect changes and run the project's checks afterwards; Harness has no tool for executing tests.

Tasks default to 120 seconds and eight model generation requests. Set `--timeout-ms` (1000–300000) and `--max-requests` (1–16) explicitly to adjust those limits. One MCP process allows at most two concurrent tasks and retains the latest 50 terminal results. MCP polling does not block cancellation. Stdio EOF and normal shutdown clean up tasks and temporary directories.

Returned JSON defaults to an 8,000-character budget; `maxOutputChars` accepts 1024–16000. Page long answers with `resultOffset` and `output.nextOffset`. Intermediate text from running, failed, or cancelled tasks, raw reasoning, tool traces, stderr, and prompt echoes are excluded from the answer. Usage is marked `source = native-dsh-reported`; missing counters are reported as unknown rather than fabricated zeroes.

## CLI and optional Skill

The CLI `run` command waits for one task to complete:

```sh
node bin/codex-dsh-connect.mjs run "Fix the addition bug in src/math.js and briefly describe the change" \
  --workspace /absolute/authorized/project

node bin/codex-dsh-connect.mjs run - --workspace /absolute/authorized/project < task.md
```

Skill installation requires an explicit destination and refuses to overwrite an existing directory. `--force` preserves a backup first. It does not automatically install into your personal Skills directory:

```sh
node bin/codex-dsh-connect.mjs skill install --dest ./work/codex-dsh-connect-skill
```

## Validation

```sh
npm test
npm run check
npm run test:platforms         # Linux/WSL launch argument and policy simulations
npm run test:isolation        # Real macOS/Linux isolation using synthetic files; no Harness/account/model
node scripts/smoke.mjs --check # Native startup and isolation checks; no model request or original credential access
node scripts/smoke.mjs --live  # Explicit live model test using a synthetic temporary project
```

On macOS / Node 24.16.0, version 0.2.1 passed 66 tests and a fresh live stdio MCP → Harness delegation. The subagent read and repaired `math.mjs` in a synthetic project, made two file tool calls, and returned a nonempty final answer. The modified addition function passed independent verification in an offline sandbox. This evidence covers that local combination, not live Linux/WSL2 execution.

Pushes and pull requests automatically run offline tests and package checks on macOS, Ubuntu, and Windows with Node 22/24, plus real synthetic isolation on macOS and Linux. Windows host tests do not verify WSL2 execution.

### Why is the WSL2 CI check skipped?

The real WSL2 job is a manual, opt-in test. Its condition requires the `workflow_dispatch` event and `run_wsl2 = true`; that input defaults to `false`. A push, pull request, or manual run without the checkbox therefore skips it by design. A skipped job is not evidence that WSL2 works.

To run it, register an existing Windows runner with all four labels: `[self-hosted, Windows, X64, wsl2]`, and install PowerShell 7 (`pwsh`) on that host. The runner's service account must already have the selected WSL2 distribution, with a supported Linux Node executable and `/usr/bin/bwrap` installed inside it. If the job is enabled but no matching runner is available, it waits in the queue rather than being skipped. The test uses synthetic files and requires no Harness installation, real credentials, or model requests.

After the workflow with `workflow_dispatch` is present on the default branch, open GitHub Actions → CI → Run workflow, select the target branch, enable `run_wsl2`, and enter the distribution name and Linux Node path. See [platform validation](docs/platform-validation.md) for complete setup and the local PowerShell command.

Read [security and architecture](docs/security.md) for the full boundaries and the [changelog](CHANGELOG.md) for release history. MIT License. Author: [Asher Zeqi / lightporta](https://github.com/lightporta).
