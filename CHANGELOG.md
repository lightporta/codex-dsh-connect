# Changelog

## 0.2.0 — 2026-10-27

- 新增 Linux bubblewrap 启动后端：只读运行时、明确可写项目与临时目录、环境白名单和凭据文件元数据检查。
- 新增 Windows WSL2 配置生成，显式发行版及 Linux 路径，使用 argv 与干净环境启动。
- 修复初始化失败后的临时目录残留、Windows 取消顺序及 Unix 提前退出导致的子进程遗漏，以及 MCP 输出积压；补充回归测试。
- CLI/MCP 版本统一来自 package.json；配置保留凭据位置和请求/超时限额；修复 Windows 测试文件发现。
- CI 扩展为三种系统与 Node 22/24，增加真实合成隔离、自托管 WSL2 手动检测和包内容检查。
- 本机 macOS 66 项测试通过；Linux/Windows 策略模拟通过。真实 Linux/WSL2 及新版真实 Harness 模型执行仍待验证。

## 0.1.0 — 2026-10-24

- 独立 stdio MCP 与 CLI，直接使用原生 DeepSeek Harness 账号路由。
- 每任务全新 profile/session，显式项目权限、macOS 文件隔离与原生 HTTP 端点监督。
- 三种有界项目文件工具、异步委派、轮询、取消与用量完整度记录。
- 终局答案分页、隐私字段过滤、显式配置生成和可选 Skill 安装。
- 离线测试、CI、实际文件隔离检查与真实原生代码修改 smoke。
