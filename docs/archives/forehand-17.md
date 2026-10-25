# 17 球员正手研究链归档

issue #30 / #21 的消融源为 `cf1313f407282ab21c2b346eb25d80eca33159df`。通用 `assets/motions/forehand.json`、rig、FK/IK、通用质量检查和用户作品格式均保留。

## 远端恢复点

- Git tag：`archive/forehand-17`（已推送到 `origin`，指向 `cf1313f`；该提交同时在 `main` 历史中）。
- 独立恢复包：GitHub Release [`archive/forehand-17`](https://github.com/tviber/human3d/releases/tag/archive/forehand-17) 附件 `h3d-forehand-17-cf1313f40728.zip`，并附 `.zip.sha256`、`MANIFEST.txt`、逐文件 `SHA256SUMS`。
- ZIP SHA-256：`2576dfe21d1f6811e1c29d850ebd3d4e91c735d7d688f52fbd8e2209ad79bab1`。包含 17 个球员 JSON、研究视频/frames、专项脚本、证据及报告，共 152 个文件；每个文件与 `cf1313f` 的 git blob 逐字节一致，仓库是公开的，因此附件不引入新内容。
- 本机副本（仅维护者机器）：`~/Documents/h3d-archives/`，与 Release 附件同一 SHA-256。

## 恢复

只需仓库访问权限，不依赖任何本机文件：

```sh
gh release download archive/forehand-17 --repo tviber/human3d
shasum -a 256 -c h3d-forehand-17-cf1313f40728.zip.sha256
unzip h3d-forehand-17-cf1313f40728.zip && cd h3d-forehand-17-cf1313f40728
shasum -a 256 -c SHA256SUMS
```

然后按原相对路径把需要的文件复制回 checkout。或者不用 ZIP：`git fetch origin tag archive/forehand-17 && git checkout archive/forehand-17 -- <path>`。要重新注册播放器预设，参考源 commit 的 `motion-files.ts` / `types.ts`；无需恢复全部研究链。

已验证（2026-10-25，全新 clone + 从 Release 下载）：ZIP 校验通过，153 项逐文件 SHA-256 全部 OK，17 个球员 JSON 与 tag checkout 逐字节一致。

## 范围

- 归档内不含 localStorage 用户动作和姿态；清理代码未迁移或删除这两类用户数据。
- tracked 文件：源 commit 617 个 / 314,171,617 字节；三项 issue #30 实现提交后（`df2c684`）466 个 / 251,024,597 字节。此统计不含后续审查修复与未跟踪的本机文件。
- 依赖：根 npm 依赖未新增；仅移除 17 正手专项命令和研究目录内独立 pose-debugger 的依赖清单。通用 `forehand` 保留，由生产 rig 的姿态有效性测试继续检查。
- `spec/examples/forehand-study.request.json` 与 `forehand-study.md` 不在删除范围：它们是生成器/服务契约测试的活 fixture。

通用工作台使用方式见 [WORKSHOP.md](../WORKSHOP.md)，验证入口见 [QA.md](../QA.md)。
