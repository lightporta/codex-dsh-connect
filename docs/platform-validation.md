# 跨平台验证

0.2.1 在 macOS 上完成单元测试、Windows/Linux 启动策略模拟及真实 DSH 委派和代码验收。模拟不能验证目标系统内核、WSL 或 Harness 的真实兼容性。机器可读记录保存在 [validation.json](validation.json)。

## 本机与推送后的自动任务

```sh
npm ci --ignore-scripts --offline
npm test
npm run check
npm run test:platforms
npm run test:isolation
```

`test:platforms` 可在 macOS 运行策略模拟；Linux 元数据检查使用临时合成文件。Windows 上明确跳过 POSIX 文件系统专属检查，使用 junction 验证目录链接边界，且保留独立硬链接测试。测试发现通过 Node 枚举文件，不依赖 shell 通配符展开。

GitHub Actions 的 `Offline tests` 在 macOS、Ubuntu 24.04、Windows 上分别运行 Node 22、24，共六种组合，并检查语法和 npm 包。`Real synthetic OS isolation` 在 macOS、Ubuntu 运行真实内核隔离探测，仅使用合成临时文件，不安装 Harness、不访问账号、不请求模型。检查授权文件可写、运行时只读、外部文件不可读写、合成凭据在离线模式不可见及 live 挂载模式只读。

0.2.0 的[实际 CI](https://github.com/lightporta/codex-dsh-connect/actions/runs/40445112637)已确认六组离线任务与 macOS 隔离成功，Ubuntu 隔离在 bwrap 初始化时出现 `loopback: Failed RTM_NEWADDR: Operation not permitted`。Ubuntu 24.04 默认 AppArmor 限制会影响非特权用户命名空间内的 capabilities；参考 [Ubuntu 24.04 发布说明](https://documentation.ubuntu.com/release-notes/24.04/)。

0.2.1 的 `scripts/prepare-linux-ci.sh` 仅允许普通用户在 GitHub 托管 Linux runner 运行：安装发行版包，先实际探测，必要时才加载 `apparmor-profiles` 自带的 `bwrap-userns-restrict`。已有不同或禁用的策略、未知错误会明确失败。它不关闭全局 AppArmor 限制，也不把离线模式改为共享网络；探针额外核对网络命名空间及零有效 capabilities。修复后的真实 Ubuntu 结果待再次推送 CI。

个人 Ubuntu/WSL 主机不自动运行该准备脚本。遇到同类 AppArmor 限制时，由管理员审阅后安装 `apparmor-profiles`，将 `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` 安装到 `/etc/apparmor.d/` 并用 `apparmor_parser -r` 加载；已有自定义策略应由管理员处理。参考 [Ubuntu AppArmor 管理说明](https://ubuntu.com/server/docs/how-to/security/apparmor/)。

## 真实 Windows WSL2

Hosted Windows 离线测试只验证 Windows Node 上的协议、生命周期和配置模拟。真实 WSL2 任务使用预先配置的、自托管 Windows x64 runner；添加 `wsl2` 标签，确保其服务账号下已安装所选 WSL2 发行版。发行版中须已有符合 engines 的 Linux Node 和 `/usr/bin/bwrap`。

含 `workflow_dispatch` 的配置进入默认分支后，在 GitHub Actions → CI → Run workflow 中选含本次修改的分支，启用 `run_wsl2`，填写 `wsl_distribution` 与 `wsl_node`。任务验证发行版注册信息为 Version 2，将显式源码复制到 Linux 临时目录，运行离线测试和真实 bubblewrap 合成隔离，最后删除临时副本。该任务不会安装 WSL、更改默认发行版或使用个人账号。没有相应 runner 时应保留“待验证”状态。

本地已有环境也可在仓库根目录用 PowerShell 运行：

```powershell
./scripts/wsl-ci.ps1 -Distribution Ubuntu-24.04 -NodePath /usr/bin/node
```

WSL 行为参考 [Microsoft WSL 基本命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)；Linux 沙箱原语参考 [bubblewrap](https://github.com/containers/bubblewrap)。

## Harness 端到端验收

上述 CI 不替代真实 Harness 验证。在目标 Linux 或 WSL2 环境安装固定 `@deepseek-ai/dsh@0.2.1-rc.2` 并自行完成原生账号登录后，先运行 `node scripts/smoke.mjs --check`，验证原生启动及文件隔离且不访问原凭据；再在明确授权的情况下运行 `node scripts/smoke.mjs --live`，验证合成代码修改及独立沙箱验收。成功日志只代表对应平台与安装组合。

本次读取了已有 0.2.0 的 GitHub CI 日志，并为 0.2.1 重新运行 macOS 真实模型 smoke：MCP 委派完成，子代理执行两次文件工具调用，成功返回修复 `math.mjs` 的终局答案，独立离线沙箱验证加法行为。此次修复未推送或合并；Linux/WSL2 的真实 Harness 验收仍待目标环境运行。
