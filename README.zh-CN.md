# codex-dsh-connect

[English](README.md) | 简体中文

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/lightporta/codex-dsh-connect)
[![Listed on Glama](https://img.shields.io/badge/Listed%20on-Glama-6B5BFF)](https://glama.ai/mcp/servers/lightporta/codex-dsh-connect)

让 Codex 将明确授权的代码任务交给 **DeepSeek 原生 Harness**。这是一个独立 Node.js 项目，通过 stdio MCP 直接启动原生 Harness，无第三方运行时依赖。

```text
Codex → stdio MCP → codex-dsh-connect
                         ↓
         Seatbelt / bubblewrap 文件沙箱
                         ↓
              原生 DeepSeek Harness
                         ↓
                 授权项目的文件工具
```

Harness 自己负责模型认证、消息协议、工具循环和用量记录。适配器只管理任务、权限、取消和最终结果，减少需要回传给 Codex 的中间上下文。它不会替换 Codex 内置子代理，也没有测量 GPT 计费节省比例。

## 当前版本

`0.2.1` 包含 Linux bubblewrap 后端和 Windows WSL2 配置，补充 Ubuntu CI 的 AppArmor 定向策略准备。要求 Node `^22.19.0 || >=24.0.0`、固定官方 `@deepseek-ai/dsh@0.2.1-rc.2`。需要先通过 Harness 自己完成 **DeepSeek 账号登录**；使用原生 `deepseek-account / deepseek-flash`，不要求另配 API Key。其他 Harness 版本会拒绝执行。

| 环境 | 执行方式 | 当前验证范围 |
| --- | --- | --- |
| macOS | Seatbelt | 本机单元测试、真实隔离、0.2.1 的实际 Harness 读取/修改及终局返回通过 |
| Linux | `/usr/bin/bwrap` | Ubuntu 24.04 离线 CI 与真实合成隔离通过；真实 Harness 模型运行待验证 |
| Windows | 选定 WSL2 内的 Linux 后端 | Windows 宿主离线 CI、WSL 参数与配置模拟通过；真实 WSL2 运行待验证 |

Windows 原生 Node 仅用于配置生成和协议测试；执行任务须进入 WSL2。0.2.1 修复后的[实际 CI](https://github.com/lightporta/codex-dsh-connect/actions/runs/40446548374)已通过六组三系统离线测试与两组 macOS/Linux 真实合成隔离，手动 WSL2 任务跳过。Linux/WSL2 的真实 Harness 模型运行仍待验证。详细状态见 [验证记录](docs/validation.json)。

每次任务创建全新的临时 profile 和会话。只允许三个项目文件工具，不提供 shell、执行代码、安装依赖、联网工具或历史会话续接。运行结果只保存在当前 MCP 进程内，结束后移除临时会话；不是常驻 Web 服务。

## 安装与接入 Codex

使用桌面插件时，请参考[插件安装与配置引导](docs/plugin-installation.zh-CN.md)。项目已包含 `plugin.json`、`mcp.json`、委派及安装引导技能和原创图标。插件未配置工作区时可以启动，但会拒绝委派；用户显式选择项目后才启用执行。设置保存在插件缓存之外，刷新安装包不会覆盖。对同一执行器选择一种接入方式，避免重复工具。

解压到自己的代码目录后：

```sh
cd /absolute/path/codex-dsh-connect
npm ci --ignore-scripts --offline
node bin/codex-dsh-connect.mjs --help
node bin/codex-dsh-connect.mjs status --workspace /absolute/authorized/project
node bin/codex-dsh-connect.mjs config --workspace /absolute/authorized/project
```

`--workspace` 必须显式指定现存的项目目录。最后一条命令仅打印配置片段，例如：

```toml
[mcp_servers.codex_dsh_connect]
command = "/absolute/path/to/node"
args = ["/absolute/path/codex-dsh-connect/bin/codex-dsh-connect.mjs", "mcp", "--workspace", "/absolute/authorized/project"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

将实际生成的片段合并到你选定的 Codex 配置。项目不会读取或修改全局 Codex 配置，也不读取默认客户端配置。不要把整个 home、Documents 或其他包含无关个人文件的目录当作 workspace。

原生安装不在常规 npm 路径时，显式传入：

```sh
node bin/codex-dsh-connect.mjs config \
  --workspace /absolute/authorized/project \
  --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

默认安装路径为 `~/.npm-global/lib/node_modules/@deepseek-ai/dsh`。默认原生凭据位置为 `~/.dsh/.credentials.yaml`；适配器不读取、显示或复制该文件，仅让沙箱中的 Harness 对其只读使用。也可用 `--credential-file /absolute/path` 明确指定位置。

### Linux 与 Windows WSL2

Linux 需先安装发行版的 bubblewrap，例如 Ubuntu 的 `sudo apt-get install bubblewrap`，并允许非特权用户命名空间。Ubuntu 24.04 的 AppArmor 可能还需要管理员加载发行版的 bwrap 专用策略，见 [跨平台验证](docs/platform-validation.zh-CN.md)。未安装或系统策略不允许时会失败，不会降级为无隔离运行。Node、Harness 安装目录须使用实际的规范路径；只有授权项目与临时目录可写。

Windows 先在选定的 WSL2 发行版中安装 Linux Node、bubblewrap、本项目和 Harness，并在该发行版内完成原生登录。可直接在 WSL2 运行前述命令，或在 Windows 生成启动片段：

```powershell
node bin/codex-dsh-connect.mjs config --wsl-distro Ubuntu-24.04 --wsl-node /usr/bin/node --wsl-cli /home/you/tools/codex-dsh-connect/bin/codex-dsh-connect.mjs --workspace /home/you/projects/example --dsh-root /home/you/.npm-global/lib/node_modules/@deepseek-ai/dsh --credential-file /home/you/.dsh/.credentials.yaml
```

所有路径均属于选定发行版，不自动转换 Windows 路径。生成的 `wsl.exe --distribution ... --exec /usr/bin/env -i ...` 使用独立参数，无 shell、无宿主凭据环境转发。建议项目放在发行版 Linux 文件系统中。`config` 也会保留显式的 `--credential-file`、`--max-requests` 和 `--timeout-ms`。

官方文档：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)。

## 委派与文件能力

| MCP 工具 | 行为 |
| --- | --- |
| `dsh_status` | 检查原生安装、平台、workspace 配置与任务限额，不读取凭据 |
| `dsh_delegate` | 异步提交新任务，立即返回 run id |
| `dsh_run` | 最长 25 秒轮询，仅返回有界的终局答案和用量 |
| `dsh_runs` | 有界的任务 id/状态列表，不回传提示词或结果正文 |
| `dsh_kill` | 请求取消进程树；继续轮询确认终局 |

提交任务时写清允许修改的文件、期望行为和验收条件。`cwd` 如被提供，必须等于配置的 workspace，不能扩大文件权限。

原生 Harness 仅看到 `project_list_files`、`project_read_text`、`project_write_text`。文件限 64 KiB，路径限 8 层/512 字符，工具输出限 8192 字符。拒绝绝对路径、`..`、符号链接、硬链接，以及 `.git`、`.env`、凭据、私钥等常见敏感路径；父目录须已存在。写入使用同目录临时文件和原子重命名。任务完成后由 Codex 或用户按项目的验证方式检查差异和测试，Harness 本身没有执行测试命令的工具。

任务默认最长 120 秒、最多 8 次模型生成请求，可显式设 `--timeout-ms`（1000–300000）和 `--max-requests`（1–16）。单进程最多 2 个并发任务，保留最近 50 个终局结果。MCP 轮询不阻塞取消；stdio EOF 或正常退出会清理任务和临时目录。

返回 JSON 默认限 8000 字符，可用 `maxOutputChars` 调整到 1024–16000；长答案使用 `resultOffset` / `output.nextOffset` 分页。运行中、失败或取消的中间文本、原始推理、工具轨迹、stderr 和任务回显不进入答案。`usage.source = native-dsh-reported`，缺失的统计桶明确标记 unknown；不把未报告的用量当成零。

## CLI 与可选 Skill

CLI 的 `run` 会等待单个任务完成：

```sh
node bin/codex-dsh-connect.mjs run "修复 src/math.js 的加法错误，最后简述改动" \
  --workspace /absolute/authorized/project

node bin/codex-dsh-connect.mjs run - --workspace /absolute/authorized/project < task.md
```

Skill 只在显式指定的目录安装，已有目录拒绝覆盖；`--force` 会先保留备份。不自动安装到个人 Skills 目录：

```sh
node bin/codex-dsh-connect.mjs skill install --dest ./work/codex-dsh-connect-skill
```

## 验证

```sh
npm test
npm run check
npm run test:platforms     # 本机运行 Linux/WSL 参数与策略模拟
npm run test:isolation    # macOS/Linux 真实合成文件隔离；无 Harness/账号/模型
node scripts/smoke.mjs --check # 无模型请求、无原凭据访问
node scripts/smoke.mjs --live  # 显式真实模型测试，仅使用合成临时项目
```

0.2.1 在 macOS / Node 24.16.0 通过 66 项测试，并重新完成实际 stdio MCP → Harness 委派：子代理读取并修复合成项目的 `math.mjs`，完成两次文件工具调用，返回非空终局答案，修改后的加法函数通过独立离线沙箱验收。该结果只验证本机组合，不替代 Linux/WSL2 实操。

推送后 GitHub Actions 自动运行 macOS、Ubuntu、Windows × Node 22/24 的离线测试、包检查，以及 macOS/Linux 的真实合成隔离。Windows hosted runner 的测试不代表 WSL2 已运行。

### 为什么 WSL2 检查显示 skipped？

WSL2 任务配置为手动、可选的真实环境检测：只有触发事件为 `workflow_dispatch` 且勾选 `run_wsl2` 才运行；该选项默认是 `false`。普通 push、PR，或手动运行时未勾选，都会按设计跳过。这不表示 WSL2 验证成功。

运行它需要预先注册匹配 `[self-hosted, Windows, X64, wsl2]` 标签的 Windows runner，并在宿主安装 PowerShell 7（`pwsh`）；其服务账号下须已有选定的 WSL2 发行版，并在发行版内安装符合要求的 Linux Node 和 `/usr/bin/bwrap`。勾选运行但没有匹配 runner 时，任务会排队，不会因缺少 runner 而显示 skipped。任务使用合成文件，不需要 Harness、真实凭据或模型请求。

含该配置的工作流进入默认分支后，在 GitHub Actions → CI → Run workflow 中选择目标分支，勾选 `run_wsl2`，填写发行版名称和 Linux Node 路径。完整设置与本地 PowerShell 命令见 [跨平台验证](docs/platform-validation.zh-CN.md)。

详细边界见 [安全与架构](docs/security.zh-CN.md)，版本记录见 [更新日志](CHANGELOG.zh-CN.md)。MIT License，作者 [Asher Zeqi / lightporta](https://github.com/lightporta)。
