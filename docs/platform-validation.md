# 跨平台验证

0.2.0 在 macOS 上完成单元测试和 Windows/Linux 启动策略模拟。模拟能验证参数、路径、环境与失败分支，不能验证系统内核、WSL 或 Harness 的真实兼容性。机器可读记录保存在 [validation.json](validation.json)。

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

Ubuntu 任务安装发行版 bubblewrap；不关闭 AppArmor 或自动放宽主机策略。若系统禁止用户命名空间，任务会失败，应根据系统日志配置相应主机政策后重跑。参考 [Ubuntu 24.04 发布说明](https://documentation.ubuntu.com/release-notes/24.04/)。

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

本次没有推送或运行 GitHub CI，也没有运行 0.2.0 的真实模型 smoke。收到 CI 日志后再更新平台结果；0.1.0 的 macOS 模型记录仅作为历史证据保留。
