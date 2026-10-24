# 安全与架构

本项目有自己的 MCP、执行器、原生事件汇总、权限配置与 Skill，所有运行时代码均在本仓库。没有外部桥接服务或其他项目包依赖。

每个任务都创建独立临时 profile、临时 DSH_HOME、DSH_AGENTS_HOME 和会话目录。自动读取个人 instructions、skills、settings、历史会话、telemetry、账号 UI 和非必要 provider 的插件被禁用。原生进程从干净的临时目录启动，避免官方启动器自动载入授权项目的 `.env`；逻辑文件工具根仍是显式授权的 workspace。

macOS Seatbelt 对文件内容读取采用允许列表：只开放授权项目、临时运行目录、已安装的官方 Harness、指定 Node 与必要系统运行时。仅授权项目和临时目录可写；原生凭据是独立的单文件只读例外，不能落入可写树。禁止 child fork。目录元数据用于路径解析；对 `/` 的 literal 读取仅支持 getcwd，不开放子文件。普通 cwd 或原生 read-only 模式本身不能替代这一边界。

三种原生文件工具进一步阻止访问 workspace 中常见敏感路径、符号链接和硬链接。代码修改工具不会执行内容。工具通过 Node 文件 API 检查路径和 inode，并进行临时文件写入与 rename；它们不是多文件事务，也不能消除恶意外部进程并发替换祖先目录的全部竞态。OS 隔离仍是必要条件。只有调用者明确授权的项目应进入 workspace。

Harness 自己使用已有账号 grant，适配器不读、复制或打印凭据；内核禁止修改原凭据。原生模型准备只允许 `GET https://api.deepseek.com/models`，模型调用只允许 `POST https://api.deepseek.com/anthropic/v1/messages`，每任务生成请求有上限。native fetch 监督拒绝其他 URL、方法、query 和 redirect，包括资料、余额、bonus、登录、登出、历史与 Files 接口。协议仍由原生 provider 负责；此监督不是通用代理或完整网络防火墙。禁用了网络/任意代码工具。

工具 stdout 使用原生 NDJSON；模型目录的原生日志转到捕获的 stderr。执行器只接受 normal exit + final + structured completed 为成功，按实际每步事件汇总用量。MCP 将外部答案视为待验证的数据，只投影已成功终局的文本并限制字符数。没有 GPT 计费数据或节省比例。

当前版本仅支持 macOS Seatbelt、固定已复核的官方 Harness 版本和账号登录。每次任务新建会话，不支持恢复用户旧会话。MCP 退出后任务列表不持久化。系统强制 SIGKILL 无法执行进程的正常清理回调，launcher 的独立超时仍限制原生子进程寿命；异常中断可能留下仅包含该任务的临时文件。常规取消和 EOF 退出会终止进程树并清理。

本项目不会读取 GitHub 账号、自动创建仓库、修改 Codex 全局配置、发布 npm 包或自动安装 Skill。检查与 smoke 都使用合成临时项目。真实 smoke 完成后，生成代码在另一个不允许凭据、网络或 child fork 的 OS 沙箱中执行验收。
