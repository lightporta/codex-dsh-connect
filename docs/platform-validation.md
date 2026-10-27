# Cross-platform validation

**English** | [简体中文](platform-validation.zh-CN.md) · [Project overview](../README.md)

Version 0.2.1 has local macOS unit tests, Windows/Linux launch-policy simulations, and a real DSH delegation and code-verification result. Simulations do not verify the target kernel, WSL, or native Harness compatibility. Machine-readable evidence is in [validation.json](validation.json).

## Local checks and automatic CI

```sh
npm ci --ignore-scripts --offline
npm test
npm run check
npm run test:platforms
npm run test:isolation
```

`test:platforms` runs launch-policy simulations on macOS; Linux metadata checks use synthetic temporary files. On native Windows, POSIX-specific filesystem tests are explicitly skipped, directory-link boundaries are checked with junctions, and independent hard-link tests remain enabled. Node discovers test files directly, without relying on shell wildcard expansion.

GitHub Actions runs `Offline tests` on macOS, Ubuntu 24.04, and Windows with Node 22 and 24: six combinations, including syntax and npm-package checks. `Real synthetic OS isolation` runs actual kernel isolation probes on macOS and Ubuntu. It uses only synthetic temporary files, without installing Harness, accessing an account, or requesting a model. The probe checks writable authorized files, read-only runtime files, denied outside-file reads and writes, and a synthetic credential that is hidden offline and read-only under the live mount policy.

The [0.2.0 CI run](https://github.com/lightporta/codex-dsh-connect/actions/runs/40445112637) passed all six offline jobs and macOS isolation. Ubuntu isolation failed during bwrap initialization with `loopback: Failed RTM_NEWADDR: Operation not permitted`. Ubuntu 24.04's default AppArmor restrictions affect capabilities inside unprivileged user namespaces; see the [Ubuntu release notes](https://documentation.ubuntu.com/release-notes/24.04/).

Version 0.2.1 adds `scripts/prepare-linux-ci.sh`, restricted to an ordinary user on a GitHub-hosted Linux runner. It installs distribution packages, probes the existing setup, and loads the distribution's `bwrap-userns-restrict` profile only when needed. A different or disabled existing policy, or an unknown failure, causes an explicit failure. It does not disable the global AppArmor restriction or share the host network for offline tests. The probe also checks network-namespace identity and zero effective capabilities.

At the recorded revision `a6e6044`, the [fixed CI run](https://github.com/lightporta/codex-dsh-connect/actions/runs/40446548374) passed all six offline jobs and both macOS/Linux isolation jobs. The manual WSL2 job was skipped. This is evidence for that revision, not an assertion that every later commit has completed CI.

Personal Ubuntu/WSL machines do not run the CI preparation script automatically. For the same AppArmor restriction, an administrator can review and install `apparmor-profiles`, copy `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` into `/etc/apparmor.d/`, and load it with `apparmor_parser -r`. Existing custom policies require administrator handling. See [Ubuntu's AppArmor administration guide](https://ubuntu.com/server/docs/how-to/security/apparmor/).

## Why the WSL2 job is skipped

The current workflow deliberately makes real WSL2 validation a manual task:

```yaml
if: github.event_name == 'workflow_dispatch' && inputs.run_wsl2
runs-on: [self-hosted, Windows, X64, wsl2]
```

A normal `push` or `pull_request` does not satisfy the event condition, so the job is skipped. A manually dispatched run also skips it unless `run_wsl2` is enabled; that input defaults to `false`. A skipped job is neither a WSL2 test failure nor a passing WSL2 result.

The hosted Windows offline jobs still run on pushes and PRs. They check the protocol, process lifecycle, and configuration simulations under Windows Node. They do not validate a real WSL2 distribution, its kernel, or bubblewrap execution inside it.

## Run real Windows WSL2 validation

The current job needs an existing, online, self-hosted Windows x64 runner matching **all four** labels: `self-hosted`, `Windows`, `X64`, and `wsl2`. Its service account must have the selected WSL2 distribution installed and be able to run PowerShell 7 (`pwsh`). Inside the distribution, install a Linux Node version satisfying `package.json` engines and `/usr/bin/bwrap`, and ensure the host policy permits the required namespace operations.

After the workflow containing `workflow_dispatch` is on the default branch:

1. Open GitHub **Actions → CI → Run workflow**.
2. Select the branch to validate.
3. Enable `run_wsl2`.
4. Set `wsl_distribution` to the existing distribution name and `wsl_node` to its absolute Linux Node path.
5. Run the workflow and inspect the WSL2 job's result.

Once the job is enabled, a missing or offline matching runner leaves it queued waiting for a runner. That differs from a job skipped by the `if` condition. Keep WSL2 marked as unverified until the job actually completes successfully.

The PowerShell script verifies that the selected distribution is registered as Version 2, copies an explicit set of source files to a Linux temporary directory, runs offline tests and actual bubblewrap synthetic isolation, and removes the temporary copy. It does not install WSL, change the default distribution, access DeepSeek credentials, or request a model.

On an existing local Windows/WSL2 setup, run this from the repository root in PowerShell:

```powershell
./scripts/wsl-ci.ps1 -Distribution Ubuntu-24.04 -NodePath /usr/bin/node
```

See [Microsoft's WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands), the [bubblewrap project](https://github.com/containers/bubblewrap), [GitHub's manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), and [self-hosted runner documentation](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

## Native Harness end-to-end acceptance

These CI jobs do not replace real Harness validation. On the target Linux or WSL2 system, install the pinned `@deepseek-ai/dsh@0.2.1-rc.2` and complete the native account login yourself. First run `node scripts/smoke.mjs --check` to check native startup and file isolation without accessing the original credential. Then, with explicit authorization, run `node scripts/smoke.mjs --live` to check synthetic code modification and independent sandbox acceptance. A successful result applies only to that platform and installation combination.

The macOS 0.2.1 live smoke completed MCP delegation, made two file-tool calls, returned a final answer reporting the `math.mjs` fix, and verified addition behavior in a separate offline sandbox. Commit `a6e6044` was pushed by the user and passed eight automatic CI checks. Real Harness model execution on Linux and real WSL2 acceptance still require execution on those target systems.
