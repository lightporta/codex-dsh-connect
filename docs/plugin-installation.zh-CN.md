# 桌面插件安装

[English](plugin-installation.md) | **简体中文** · [项目说明](../README.zh-CN.md)

项目包含可移植插件清单、stdio MCP 启动配置及安装引导 Skill。插件复用直接 MCP 连接的五个委派工具和原生隔离策略。插件包不会安装 Node、DeepSeek Harness、bubblewrap 或 WSL2 发行版。

此包用于本地桌面执行。本地安装与公开插件目录上架是两个步骤；当前公开本地 MCP 提交要求获得合作伙伴资格及组织白名单，本仓库本身不代表已取得这些资格。参阅 [OpenAI 桌面插件要求](https://developers.openai.com/plugins/deploy/desktop-only)。

## 准备执行环境

- 确保桌面应用的 `PATH` 可找到 Node `^22.19.0 || >=24.0.0`。终端能找到 Node，不代表桌面应用也能找到；调整环境后需重启应用。
- 单独安装官方 `@deepseek-ai/dsh@0.2.1-rc.2`，例如执行 `npm install --global @deepseek-ai/dsh@0.2.1-rc.2`，并确认包目录的绝对路径。其他版本会被拒绝。通过 Harness 自身完成账号登录，具体登录流程查看已安装可执行文件的帮助。不要将凭据复制到插件内。
- macOS 使用 Seatbelt；Linux 需要 `/usr/bin/bwrap`，且主机策略允许所需命名空间操作。Ubuntu AppArmor 的要求见[跨平台验证](platform-validation.zh-CN.md)。
- Windows 宿主需要 Node 来运行插件启动器。显式选择一个 WSL2 发行版，在其中安装受支持的 Linux Node、bubblewrap、本连接器和固定版本 Harness，并在该发行版内完成原生账号登录。配置方法见下文。

连接器没有第三方运行时包依赖。带锁文件的源码检出可执行 `npm ci --ignore-scripts --offline`；这条命令不会安装 Harness。

## 选择授权项目

在 macOS 或 Linux 的完整插件目录中执行：

```sh
node bin/codex-dsh-plugin.mjs configure \
  --workspace /absolute/authorized/project \
  --dsh-root /absolute/path/to/node_modules/@deepseek-ai/dsh

node bin/codex-dsh-plugin.mjs status
```

选择一个已存在的具体项目目录。插件运行时、设置、凭据及无关个人文件应位于该目录之外。可选参数包括 `--credential-file /absolute/path`、`--max-requests 4` 和 `--timeout-ms 60000`；只保存凭据位置，不保存内容。默认原生凭据位于 `~/.dsh/.credentials.yaml`，默认 Harness 目录为 `~/.npm-global/lib/node_modules/@deepseek-ai/dsh`。

命令为当前系统用户创建 `~/.config/codex-dsh-connect/plugin.json`；Windows 对应 `%USERPROFILE%\.config\codex-dsh-connect\plugin.json`。这是连接器的设置文件，与插件包中的 `plugin.json` 清单不同。命令不会读取或修改个人 Codex 配置。覆盖已有设置需加 `--force`，且会先保留备份。

默认设置文件在**所有使用该插件的聊天之间选择同一个项目**，不会跟随当前仓库或工作目录切换。更改设置后，需重启或重新加载插件的 MCP 连接。如果需要按项目配置，或同时连接多个工作区，请使用[直接配置命令](../README.zh-CN.md#安装与接入-codex)，并避免为同一个执行器重复启用直接连接。

`configure`、`status` 或 `mcp` 可用 `--settings-file /absolute/path/settings.json` 选择其他设置文件。插件内置 MCP 入口使用默认文件，单独配置自定义文件不会让已安装插件自动读取它；另行维护的 MCP 入口也必须传入相同的 `--settings-file`。不要把设置存入委派项目，也不要将修改缓存插件当作持久配置方式。

### Windows 宿主与 WSL2

在 Windows PowerShell 中进入插件目录，传入所选发行版内的 Linux 路径：

```powershell
node bin/codex-dsh-plugin.mjs configure --wsl-distro Ubuntu-24.04 --wsl-node /usr/bin/node --wsl-cli /home/you/tools/codex-dsh-connect/bin/codex-dsh-connect.mjs --workspace /home/you/projects/example --dsh-root /home/you/.npm-global/lib/node_modules/@deepseek-ai/dsh --credential-file /home/you/.dsh/.credentials.yaml

node bin/codex-dsh-plugin.mjs status
```

插件使用参数数组启动 `wsl.exe`，明确指定发行版并使用干净的 Linux 环境。它不会启动 shell、转换宿主路径、安装 WSL 或隐式选择默认发行版。提供的 Linux 连接器与 Harness 路径必须持续可用。Windows 宿主离线测试通过或配置生成成功，都不能验证真实 WSL2 执行。

## 从本地插件源安装

使用支持本地或仓库插件源的桌面客户端。一个独立测试目录可以这样组织：

```text
local-plugin-test/
├── .agents/plugins/marketplace.json
└── plugins/codex-dsh-connect/
    ├── plugin.json
    ├── mcp.json
    ├── bin/
    ├── lib/
    ├── skills/
    └── ...其他打包文件
```

将完整源码或解压后的包复制到 `plugins/codex-dsh-connect`，保留 `assets`、`docs` 等分发目录。在测试仓库的 `.agents/plugins/marketplace.json` 中添加以下清单；已有清单时合并条目：

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

其中路径相对于 `local-plugin-test`，并非 `.agents/plugins`。在桌面客户端打开测试仓库，重启应用，在插件目录选择 **Codex DSH Local** 源并安装插件。支持插件开发 CLI 的客户端也可用 `codex plugin marketplace add /absolute/path/local-plugin-test` 注册来源，再在桌面应用中安装测试。菜单可用性受客户端与组织策略影响，具体见 [OpenAI 本地插件打包与插件源指南](https://developers.openai.com/plugins/build/plugins)。

宿主安装的是插件缓存副本。测试新版时，更新清单指向的源码副本，再刷新或重启桌面客户端。个人设置保存在独立的连接器设置文件中，避免刷新包时被替换。仅检出此仓库不会修改插件源、安装个人插件或公开发布。

## 验证连接

执行插件的 **Set up／设置** 操作可调用内置安装引导 Skill，也可直接使用上述配置命令。包内 `mcp.json` 通过 `node` 启动 `${PLUGIN_ROOT}/bin/codex-dsh-plugin.mjs mcp`，由宿主展开 `${PLUGIN_ROOT}`。当前工作目录不会授予工作区权限。

尚未配置时，MCP 启动与工具发现可以成功，但 `dsh_status` 会返回 `ready: false`、`reason: workspaceRequired`，任务提交会被拒绝。配置并重启连接后，应能看到 `dsh_status`、`dsh_delegate`、`dsh_run`、`dsh_runs`、`dsh_kill` 五个工具。`dsh_status` 应显示工作区已配置及预期的平台、隔离后端。此检查不读取凭据，也不能证明模型请求或内核命名空间已运行成功。

在 macOS 或 Linux 的完整源码／包目录运行 `npm test`、`npm run check`、`npm run test:isolation`，执行离线测试及真实合成隔离，不请求模型。已有 Windows/WSL2 环境按[真实 WSL2 验证说明](platform-validation.zh-CN.md#真实-windows-wsl2)执行。CI 的 WSL2 任务须手动启用，跳过时仍应保留待验证状态。

需要请求模型进行端到端验收时，先建立只含错误加法函数的临时项目，明确配置该项目并重启连接，再调用 `dsh_delegate`，要求只读取并修复该文件。插件委派时将预期项目的绝对路径作为 `cwd` 传入；若保存的工作区不同，执行器会拒绝请求，避免跨聊天沿用旧选择。用返回的 run ID 调用 `dsh_run`，检查最终答复和实际文件，并独立运行对应代码检查。完成后恢复预期项目设置。已有[真实模型 smoke](../README.zh-CN.md#验证)自动验收的是直接 MCP 路径，使用默认原生安装目录，不等同于桌面插件安装验证。

既有 macOS 委派与 Ubuntu 合成隔离记录，不能证明 Linux Harness 模型调用或真实 WSL2 已通过。应分别报告本地 CLI 检查、实际桌面安装、目标平台隔离与模型任务完成情况。
