# codex-dsh-connect

让 Codex 将明确授权的代码任务交给 **DeepSeek 原生 Harness**。这是一个独立 Node.js 项目，通过 stdio MCP 直接启动原生 Harness，无第三方运行时依赖。

```text
Codex → stdio MCP → codex-dsh-connect
                         ↓
              独立 macOS 文件沙箱
                         ↓
              原生 DeepSeek Harness
                         ↓
                 授权项目的文件工具
```

Harness 自己负责模型认证、消息协议、工具循环和用量记录。适配器只管理任务、权限、取消和最终结果，减少需要回传给 Codex 的中间上下文。它不会替换 Codex 内置子代理，也没有测量 GPT 计费节省比例。

## 当前版本

`0.1.0` 支持 macOS、Node `^22.19.0 || >=24.0.0`，以及经验证的官方 `@deepseek-ai/dsh@0.2.1-rc.2`。需要先通过 Harness 自己完成 **DeepSeek 账号登录**；本版本使用原生 `deepseek-account / deepseek-flash`，不要求另配 API Key。其他 Harness 版本会拒绝执行，需先复核原生协议和权限。

每次任务创建全新的临时 profile 和会话。只允许三个项目文件工具，不提供 shell、执行代码、安装依赖、联网工具或历史会话续接。运行结果只保存在当前 MCP 进程内，结束后移除临时会话；不是常驻 Web 服务。

## 安装与接入 Codex

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
node scripts/smoke.mjs --check # 无模型请求、无原凭据访问
node scripts/smoke.mjs --live  # 显式真实模型测试，仅使用合成临时项目
```

已在 macOS / Node 24.16.0 / 官方 Harness 0.2.1-rc.2 验证独立 stdio MCP → 原生 Harness 的真实代码读取、修改及终局回复，2 次文件工具调用，修改后的加法函数通过独立沙箱执行检查。不会把旧项目的测试结果当作本项目的通过记录。

详细边界见 [安全与架构](docs/security.md)。MIT License，作者 [Asher Zeqi / lightporta](https://github.com/lightporta)。
