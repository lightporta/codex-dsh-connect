# 上传至 GitHub

本压缩包是独立 `codex-dsh-connect` 项目。先解压，再上传文件夹内的源码；直接把 zip 上传成一个仓库文件不会自动展开为项目。

1. 在自己的 GitHub 新建空仓库 `codex-dsh-connect`。
2. 打开解压后的 `codex-dsh-connect` 目录。
3. 用 GitHub Desktop 添加该目录并 Publish，或使用下列命令。若网页上传，需一并上传 `.github/`、`.gitignore` 等隐藏项。

```sh
git init -b main
git add .
git commit -m "Initial standalone Codex DeepSeek Harness connector"
git remote add origin https://github.com/lightporta/codex-dsh-connect.git
git push -u origin main
```

源码和测试不含凭据、个人会话或 node_modules。`npm ci --ignore-scripts --offline` 可完成零依赖安装。`npm test` 和 `npm run check` 不调用模型；`node scripts/smoke.mjs --live` 会显式使用已有 DeepSeek 登录来运行临时测试。
