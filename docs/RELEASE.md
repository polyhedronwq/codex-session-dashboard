# 发布流程

本项目通过 **GitHub Actions** 自动发布：推送 `v*` tag 后，`release.yml` 会构建发布包、
在干净的 Windows runner 上做隔离安装自检，然后创建 GitHub Release 并上传 zip + SHA256。

## 发版步骤

1. **改版本与 CHANGELOG**
   - `VERSION` 改成新版本号（如 `1.2.2`）
   - `CHANGELOG.md` 顶部加 `## <版本>` 段（Release 说明会自动取这一段）
2. **本地构建 + 自检**
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -NoMirror
   # 解压 dist-package/codex-dashboard-<版本>.zip 后：
   #   install.ps1 -CheckOnly
   #   install.ps1 -Yes -TestHome <临时目录>
   ```
   套件跑绿（`verify\run-all.ps1`）再提交。
3. **提交并推 main**
   ```
   git add -A && git commit -m "1.2.2：..."
   git push origin main
   ```
4. **打 tag 并推送**（tag 必须与 VERSION 一致，否则流水线直接失败）
   ```
   git tag -a v1.2.2 -m "v1.2.2"
   git push origin v1.2.2
   ```
5. **等 Actions 的 Release 工作流**
   - 构建 → `-CheckOnly` 校验包完整性 → `-TestHome` 隔离安装 → 断言产物
   - 通过后自动创建 Release，附件：`codex-dashboard-<版本>.zip` 与 `.sha256`
   - 失败可到 Actions 里 "Re-run job"；重复执行会**覆盖**已有 Release 的附件与说明
6. **验收**
   - Release 页面能看到 zip + SHA256，说明里带安装步骤
   - 下载 zip 解压后校验 SHA256 与页面一致
   - 双击 `install.cmd` 走一遍真实安装（或在本地跑 `-TestHome`）

## 本地手动建 Release（可选）

流水线不可用时，本机装了 `gh` 且已登录，也可以手动：

```
gh release create v1.2.2 dist-package/codex-dashboard-1.2.2.zip dist-package/codex-dashboard-1.2.2.zip.sha256 \
  --title "codex-session-dashboard v1.2.2" --notes-file release-notes.md
```

## 维护说明

- **不要**在 `workflow_dispatch` 里对 main 手动跑 Release 工作流：它会按 `VERSION` 找 tag，找不到就失败（这是有意防止误发）。
- 发布包由 CI 在干净 runner 上构建，不包含本机路径（`build.ps1 -NoMirror` 已由 CI 检查）。
- 发布包**未签名**：SmartScreen 可能提示"未知发布者"；如未来购买代码签名证书，在 `build.ps1`/流水线里加签名步骤即可。
- `share/`、`dist/`、`dist-package/` 都是构建产物，不提交（见 `.gitignore`）。
