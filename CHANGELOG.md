# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

- Add a portable desktop plugin manifest, stdio MCP startup, setup/delegation skills, and bilingual installation instructions. Save explicit workspace settings outside the plugin cache and refuse delegation before setup.
- Reuse the existing Windows WSL2 argv launcher for plugin startup. Keep real WSL2 and live Linux Harness validation pending.
- Pass 73 offline tests locally on macOS / Node 24.16.0, including seven plugin startup/settings/package regression tests. No new live model request was made for this integration.
- Add English versions of the README, security notes, platform validation guide, and changelog, with matching Chinese editions.
- Explain the manual WSL2 CI trigger, self-hosted runner requirements, and remaining validation limits.
- Clarify that the verification sandbox prohibits forks on macOS; Linux uses its documented namespace and capability restrictions.

## 0.2.1 — 2026-10-27

- Address the Ubuntu CI `loopback: Failed RTM_NEWADDR` failure with a preparation step restricted to GitHub-hosted Linux runners. Load the distribution's AppArmor `bwrap-userns-restrict` profile when needed, while retaining the global restriction, offline network namespace, and capability removal.
- Assert the network namespace and zero effective capabilities in the synthetic isolation probe.
- Require the live smoke test to complete, return a nonempty final answer, and make at least two file-tool calls. Include the returned result and a safe failure-phase identifier in the report.
- Pass 66 offline tests on macOS. Repeat real DSH delegation: read and repair synthetic code, receive the final answer, and verify the code in a separate sandbox.
- Record the Ubuntu isolation failure in 0.2.0. After the 0.2.1 fix, all six offline CI combinations and both macOS/Linux isolation jobs passed; the manual WSL2 job was skipped.

## 0.2.0 — 2026-10-27

- Add a Linux bubblewrap backend with read-only runtime mounts, explicit writable project and scratch directories, an environment allowlist, and credential-file metadata checks.
- Add Windows WSL2 configuration generation with an explicit distribution and Linux paths, using argument arrays and a clean environment.
- Fix scratch-directory leaks after failed initialization, descendant-process cleanup on Windows and Unix, and unbounded MCP output accumulation. Add regression coverage.
- Read CLI and MCP versions from `package.json`, preserve credential paths and request/timeout limits in generated configuration, and make test discovery work on Windows.
- Expand CI to three operating systems and Node 22/24, with real synthetic isolation, optional self-hosted WSL2 validation, and package-content checks.
- Pass 66 tests on macOS and simulated Linux/Windows launch-policy checks. At this release, real Linux/WSL2 execution and live Harness validation for the new release remained pending.

## 0.1.0 — 2026-10-24

- Introduce a standalone stdio MCP server and CLI using native DeepSeek Harness account authentication.
- Create a fresh profile and session for each task, with explicit workspace authorization, macOS filesystem isolation, and supervision of native HTTP endpoints.
- Provide three bounded project-file tools, asynchronous delegation, polling, cancellation, and usage-completeness reporting.
- Add final-answer pagination, private-field filtering, explicit configuration generation, and optional Skill installation.
- Include offline tests, CI, real filesystem-isolation checks, and a live native code-editing smoke test.
