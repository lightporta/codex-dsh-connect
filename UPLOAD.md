# 更新 GitHub 与检查 CI

仓库地址：[lightporta/codex-dsh-connect](https://github.com/lightporta/codex-dsh-connect)。当前为已有 Git 仓库，不需要重新初始化或添加重复 remote。

本次修复更新为 `0.2.1`，在本地 `codex/engineering-cross-platform` 分支提交。已重新完成 macOS DSH 实操，由用户推送并确认修复后的 CI：

```sh
git status --short --branch
git log -1 --oneline
git remote -v
git push -u origin codex/engineering-cross-platform
```

推送、PR 均触发 CI；先确认本次提交的六组三系统测试与两组 macOS/Linux 隔离任务全部成功，再合并到 `main`。已有 PR 会自动更新，无需重复创建。真实 WSL2 另按 [跨平台验证](docs/platform-validation.md) 手动触发；跳过的手动任务不表示 WSL2 已验证。本地通过记录不表示修复后的 GitHub CI 已完成。

若继续用网页上传，上传完整源码并保留 `.github/` 等隐藏目录；不要只上传一个压缩包。Node 项目零运行时依赖，`npm ci --ignore-scripts --offline` 可完成安装。`npm test`、`npm run check`、`npm run test:isolation` 不请求模型。真实模型 smoke 必须显式指定 `--live`。
