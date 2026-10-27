# 安全与架构

本项目有自己的 MCP、执行器、原生事件汇总、权限配置与 Skill，所有运行时代码均在本仓库。没有外部桥接服务或其他项目包依赖。

每个任务都创建独立临时 profile、临时 DSH_HOME、DSH_AGENTS_HOME 和会话目录。自动读取个人 instructions、skills、settings、历史会话、telemetry、账号 UI 和非必要 provider 的插件被禁用。原生进程从干净的临时目录启动，避免官方启动器自动载入授权项目的 `.env`；逻辑文件工具根仍是显式授权的 workspace。

macOS Seatbelt 对文件内容读取采用允许列表：只开放授权项目、临时运行目录、已安装的官方 Harness、指定 Node 与必要系统运行时。仅授权项目和临时目录可写；原生凭据是独立的单文件只读例外，不能落入可写树。禁止 child fork。目录元数据用于路径解析；对 `/` 的 literal 读取仅支持 getcwd，不开放子文件。普通 cwd 或原生 read-only 模式本身不能替代这一边界。

Linux 使用 bubblewrap 创建独立文件系统、PID 等命名空间，清空环境、移除 capabilities 并设置父进程死亡清理。仅绑定指定 Node、Harness、必要系统库和 DNS/TLS 文件；项目与临时目录可写，其余挂载只读。不会挂载宿主 home、`/mnt`、`/run` 或整个 `/usr`。Node 的 HOME 固定为该任务临时目录；不继承个人 HOME。离线探测隔离网络，live 模式显式共享宿主网络，以便原生 provider 请求模型。bubblewrap 没有配置禁止 fork 的 seccomp 规则，因此它与 Seatbelt 的进程约束不同。

Linux 在 live 启动前只检查凭据的文件类型、链接数和规范路径等元数据，拒绝目录、符号链接、硬链接，避免把私人目录作为单文件挂载。适配器不读凭据内容，`status` 和离线检查也不访问原凭据元数据。文件挂载及工具检查不能抵御宿主恶意进程同时替换路径；受信安装与授权项目不得由恶意外部进程操控。

Windows 执行路径为显式选定 WSL2 中的 Linux 后端。`wsl.exe` 参数中直接执行 `/usr/bin/env -i` 和 Linux Node，不经 shell；Windows 宿主配置、凭据环境与默认发行版不会自动成为授权。Windows 原生进程不是任务隔离后端。

三种原生文件工具进一步阻止访问 workspace 中常见敏感路径、符号链接和硬链接。代码修改工具不会执行内容。工具通过 Node 文件 API 检查路径和 inode，并进行临时文件写入与 rename；它们不是多文件事务，也不能消除恶意外部进程并发替换祖先目录的全部竞态。OS 隔离仍是必要条件。只有调用者明确授权的项目应进入 workspace。

Harness 自己使用已有账号 grant，适配器不读、复制或打印凭据；内核禁止修改原凭据。原生模型准备只允许 `GET https://api.deepseek.com/models`，模型调用只允许 `POST https://api.deepseek.com/anthropic/v1/messages`，每任务生成请求有上限。native fetch 监督拒绝其他 URL、方法、query 和 redirect，包括资料、余额、bonus、登录、登出、历史与 Files 接口。协议仍由原生 provider 负责；此监督不是通用代理或完整网络防火墙。禁用了网络/任意代码工具。

工具 stdout 使用原生 NDJSON；模型目录的原生日志转到捕获的 stderr。执行器只接受 normal exit + final + structured completed 为成功，按实际每步事件汇总用量。MCP 将外部答案视为待验证的数据，只投影已成功终局的文本并限制字符数。没有 GPT 计费数据或节省比例。

当前固定已复核的官方 Harness 版本和账号登录。macOS 与 Ubuntu 的真实合成隔离已通过 CI；macOS 原生模型委派也已验收，Linux 原生模型及 WSL2 实操仍待完成；见验证记录。每次任务新建会话，不支持恢复用户旧会话。MCP 退出后任务列表不持久化。系统强制 SIGKILL 无法执行进程的正常清理回调，launcher 的独立超时限制原生子进程寿命，Linux 另有 bubblewrap 父进程死亡约束；异常中断可能留下任务临时文件。常规取消和 EOF 退出会终止进程树并清理。初始化失败也会清除已创建的临时目录。

MCP 单条消息和待发送队列各限 1 MiB；stdout 背压会暂停输入解析，排空后恢复，避免慢客户端导致无界输出积压。

本项目不会读取 GitHub 账号、自动创建仓库、修改 Codex 全局配置、发布 npm 包或自动安装 Skill。检查与 smoke 都使用合成临时项目。真实 smoke 完成后，生成代码在另一个不允许凭据、网络或 child fork 的 OS 沙箱中执行验收。
