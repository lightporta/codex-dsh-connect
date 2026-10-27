# Security and architecture

**English** | [简体中文](security.zh-CN.md) · [Project overview](../README.md)

This standalone project provides its own MCP server, executor, native event aggregation, permission configuration, and optional Skill. All runtime code is in this repository. It has no external bridge service or dependency on another project's package.

Each task receives a new temporary profile, `DSH_HOME`, `DSH_AGENTS_HOME`, and session directory. Plugins that automatically load personal instructions, skills, settings, previous sessions, telemetry, account UI, or unnecessary providers are disabled. The native process starts in a clean temporary directory, preventing the official launcher from loading the authorized project's `.env` file. The file tools still use the explicitly authorized workspace as their logical root.

## OS isolation

On macOS, Seatbelt uses an allowlist for file-content reads: the authorized project, task scratch directory, installed official Harness, specified Node executable, and required system runtime files. Only the project and scratch directory are writable. The original credential file is a separate, read-only exception and must remain outside writable trees. Child forks are prohibited. Directory metadata is available for path resolution; a literal read permission on `/` supports `getcwd` without granting access to its children. A working directory or the native read-only mode alone cannot provide this boundary.

On Linux, bubblewrap creates filesystem, PID, and other namespaces, clears the environment, drops capabilities, and enables cleanup when its parent dies. It binds the specified Node executable, Harness installation, required system libraries, and selected DNS/TLS files. The project and scratch directory are writable; other mounts are read-only. It does not expose entire host home directories, `/mnt`, `/run`, or all of `/usr`. Node's `HOME` is fixed to the task scratch directory rather than inherited from the parent. Offline probes isolate the network. Live execution explicitly shares the host network so the native provider can request the model. There is no seccomp rule prohibiting forks, so Linux process restrictions differ from Seatbelt's.

Before live Linux execution, the adapter checks only credential metadata: file type, link count, and canonical path. It rejects directories, symlinks, and hard links to avoid mounting a private directory where a single file was intended. The adapter does not read credential contents. `status` and offline checks do not inspect the original credential's metadata either. Mount and tool checks cannot protect against a malicious host process replacing paths concurrently. The trusted installation and authorized project must not be controlled by such a process.

Windows execution uses the Linux backend inside an explicitly selected WSL2 distribution. The `wsl.exe` argument vector directly executes `/usr/bin/env -i` and Linux Node, without a shell. Host configuration, credential environment variables, and the default distribution do not automatically become authorized inputs. Native Windows processes are not the task-isolation backend.

## Project capabilities and network supervision

The three native file tools additionally reject common sensitive workspace paths, symlinks, and hard links. The write tool does not execute the content it writes. The tools check paths and inodes through Node's filesystem APIs, write temporary files, and rename them into place. They are not multi-file transactions and cannot eliminate every race involving an external process replacing ancestor directories. OS isolation remains necessary. Only a project explicitly authorized by the caller belongs in the workspace.

Harness uses the existing account grant itself. The adapter does not read, copy, or print credentials, and the OS policy prevents modification of the original credential file. Native model preparation permits only `GET https://api.deepseek.com/models`; generation permits only `POST https://api.deepseek.com/anthropic/v1/messages`, with a per-task request limit. Native `fetch` supervision rejects other URLs, methods, query strings, and redirects, including profile, balance, bonus, login, logout, history, and Files endpoints. The native provider still owns the protocol. This supervision is not a general proxy or a complete network firewall. Network and arbitrary-code tools are disabled.

## Results, lifecycle, and validation limits

Native stdout follows the NDJSON protocol; model-catalog diagnostics are redirected to captured stderr. The executor requires a normal exit, a final event, and a structured completed state before accepting success. Usage is aggregated from actual step events. MCP treats external answers as data to verify and exposes only bounded, successful final text. It does not provide GPT billing data or a measured savings percentage.

The supported official Harness version and account-authentication route are pinned. Real synthetic isolation has passed CI on macOS and Ubuntu. Native model delegation has also been verified on macOS. Native model execution on Linux and real WSL2 execution remain unverified; see the [validation record](validation.json) and [platform guide](platform-validation.md).

Every task starts a new session; resuming a user's old session is unsupported. The task list is not persisted after MCP exits. A forced `SIGKILL` cannot run normal cleanup callbacks. The launcher's independent timeout bounds the native child's lifetime, and Linux also uses bubblewrap's parent-death behavior. Abnormal termination can leave task-owned temporary files. Normal cancellation and stdio EOF terminate the process tree and clean up. Failed initialization also removes its scratch directory.

Individual MCP messages and the pending output queue are each limited to 1 MiB. Stdout backpressure pauses input parsing until output drains, preventing a slow client from causing unbounded output accumulation.

The project does not read GitHub accounts, create repositories, modify global Codex configuration, publish npm packages, or install Skills automatically. Checks and smoke tests use synthetic temporary projects. After a live smoke test, generated code is checked in a separate offline OS sandbox without access to the original credential file. The macOS verification sandbox also prohibits child forks; Linux uses the process restrictions described above.

The desktop plugin reads its own connector settings file, separate from Codex configuration. Setup saves only explicit project/runtime/credential paths and bounded request limits; it never stores credential contents. Native settings must remain outside the delegated project, including after a manual move or parent-directory symlink. A missing file leaves the server unconfigured; malformed settings stop startup. Settings are loaded once per process, so changing them requires a restart. The bundled delegation skill supplies the intended `cwd` on every task to reject a stale workspace selection across chats.
