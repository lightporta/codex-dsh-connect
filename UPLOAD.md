# 更新 GitHub 与检查 CI

仓库地址：[lightporta/codex-dsh-connect](https://github.com/lightporta/codex-dsh-connect)。当前为已有 Git 仓库，不需要重新初始化或添加重复 remote。

本次更新为 `0.2.0`，在本地 `codex/engineering-cross-platform` 分支提交，由用户推送：

```sh
git status --short --branch
git log -1 --oneline
git remote -v
git push -u origin codex/engineering-cross-platform
```

然后在 GitHub 将该分支与 `main` 比较并创建 PR。推送、PR 均触发 CI。合并前检查全部三系统测试和 macOS/Linux 隔离任务；真实 WSL2 另按 [跨平台验证](docs/platform-validation.md) 手动触发。当前文档与本地通过记录不表示 GitHub CI 已完成。

若继续用网页上传，上传完整源码并保留 `.github/` 等隐藏目录；不要只上传一个压缩包。Node 项目零运行时依赖，`npm ci --ignore-scripts --offline` 可完成安装。`npm test`、`npm run check`、`npm run test:isolation` 不请求模型。真实模型 smoke 必须显式指定 `--live`。
