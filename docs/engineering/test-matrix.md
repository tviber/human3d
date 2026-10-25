# Owner / 风险 / 测试责任矩阵

用途：按改动范围选**最小验证集**（配合 [review-gates.md](review-gates.md) 的 Level 0–3）。这是约定与人工映射；自动选择器 `npm run check:affected`（PR-11B 已落地）以本表为**唯一权威映射来源**——下面的「选择器映射」表由 `tests/affected-checks.test.ts` 的矩阵一致性测试与 `scripts/lib/affected-checks.mjs` 的 `CATEGORY_CHECKS` 钉死，两边不得漂移。

## 改动 → 最小验证映射

| 改动面（owner） | 典型路径 | 风险 | 开发期最小检查 | 升级触发 |
|---|---|---|---|---|
| 文档/索引/约定 | `docs/**`、各 `AGENTS.md`、README | L0 | diff + `npm run docs:check` | 触及代码注释里被引用的路径时按对应域升级 |
| core 文档模型/采样 | `packages/motion-core/src/document.ts`、`motion-file*.ts`、`motions.ts` | L3 | `apps/web/src/workshop/workshop.test.ts`、`apps/web/src/workshop/mirror.test.ts`、`packages/motion-core/src/grip-side.test.ts`、`regressions.test.ts` + `tsc -b` | 求解输出变化 → `SERVICE_VERSION` bump + golden/探针全量 |
| core 求解/几何 | `solver.ts`、`kinematics.ts`、`rig.ts`、`hand-frame.ts`、`foot.ts`、`props/racket.ts`、`grip.ts`、`limits.ts` | L3 | `kinematics.test.ts`、`solver-hints.test.ts`、`grip-side.test.ts`、`quality.test.ts`、`solver-baseline.test.ts` | 真实路径验证不可省（review-gates L3） |
| 协议/姿态包/导出 | `protocol.ts`、`pose-package.ts`、`package-const.ts`、`package-inspect.ts`、`package-export.ts`、`glb-export.ts`、`validate.ts`（core 内） | L3 | `package-export.test.ts`、`glb-export.test.ts`、`validate.test.ts`、`property.test.ts`、`compiled.test.ts` + `npm run spec:check` | 改 `spec/` 契约按「spec/协议」行 |
| 生成器/质量度量 | `generate.ts`、`quality-probe.ts`、`random-document.ts`、`semantic-map.ts`、`muscle-action.ts` | L2–L3 | `generate.test.ts`、`compiled.test.ts`、`quality.test.ts`（低资源加 `--maxWorkers=1`） | 度量语义变化 → evidence 基线重生成 |
| web 工作台 | `apps/web/src/workshop/` | L3（交互） | `workshop.test.ts`、`mirror.test.ts`；真实交互路径按 [../domain/workshop.md](../domain/workshop.md) 补 QA 断言 | 持久化/撤销/写路径 → 浏览器 QA |
| web 实验室/播放 | `apps/web/src/lab/`、`playback/`、入口页 | L2 | `motion-source.test.ts` + `tsc -b` | 播放源/包导入 → 浏览器 QA |
| server 服务/契约 | `apps/server/src/` | L3 | `service.test.ts`、`contract.test.ts`（= `spec:check`）、`validate.test.ts`、`property.test.ts` | 协议语义 → `SERVICE_VERSION` + golden |
| spec/契约文本 | `spec/*.schema.json`、`spec/openapi.yaml`、`spec/examples/` | L3 | `npm run spec:check` | golden 变化要逐位审 diff（[../decisions/0007-golden-plaintext.md](../decisions/0007-golden-plaintext.md)） |
| 包边界/结构 | 跨包导入、`package.json` 依赖、`tsconfig` | L2 | `tests/architecture.test.ts` + `tsc -b` | 公共入口/包配置 → 保守扩大（fail-open） |
| 动力学资产/工具链 | `assets/motions/`、`assets/dynamics/`、`scripts/*.py`、`public/dynamics/` | L2 | `npm run dynamics:validate`、`dynamics:test`（需 `.venv-dynamics`） | 信封字段 → `motion-files` 相关测试 |
| 持拍动作资产 | `assets/motions/forehand.json` | L3（运动语义） | `apps/web/src/lab/pose-validity.test.ts`（全部持拍动作每键 + 16 等分：无 145° 肘钳位、无手臂—躯干交叉）、`kinematics.test.ts` | 改 `forehand.json` → 另跑 `solver-baseline.test.ts`/`quality.test.ts`/`service.test.ts` 并以 `--update-evidence` 重捕获 golden 与 `evidence/quality-probe-*`；信封 notes/description 变化 → `service.test.ts`、`motion-source.test.ts`。（17 球员正手生成/测量链已随 #21/#30 消融删除，仓外备份 + tag `archive/forehand-17` 可恢复） |
| CI/工具/脚本 | `.github/workflows/`、`scripts/*.mjs`/`*.mts`、`tests/` | L2 | `tsc -b`、受影响脚本定向跑、`tests/*.test.ts` | 依赖/构建行为 → `npm run build` |
| evidence 基线 | `evidence/**` | L1 | 对应测量脚本重跑（`measure-quality-probe.mts`/`bench`/`generate-motion.mts`） | 只写既有基线外的新文件需 review 确认 |

## 测试文件落位（按「最高依赖」归属）

- `packages/motion-core/src/*.test.ts`：core 域（采样/求解/镜像/质量/golden/回归/生成器）
- `apps/server/src/*.test.ts`：契约（`contract.test.ts` = `spec:check`）、服务、对等打包、GLB、属性扫描、校验
- `apps/web/src/{workshop,playback}/*.test.ts`：工作台文档/镜像、播放源/导入校验
- `tests/*.test.ts`：包边界（`architecture.test.ts`）、bench 冒烟
- 定向：`npm test -- <path>`；低资源：`--maxWorkers=1 --no-file-parallelism`
- 浏览器 E2E：`npm run qa` / `npm run qa:dynamics`（未进 CI，状态要单独记录）；动作库备份恢复与跨页签并发：`npm run qa:library`，由 CI 的 `browser-qa` workflow 执行

## check:affected 选择器映射（已实现）

唯一权威来源：本节表格 ↔ `CATEGORY_CHECKS`（`scripts/lib/affected-checks.mjs`）由测试保证一致。检查 id → 命令：`docs` = `node scripts/check-docs-links.mjs`；`fast`/`spec`/`vitest` = vitest 对应子集；`build` = `tsc -b` + `vite build`；`dynamics-validate`/`dynamics-test` = 对应 Python 脚本。

| 类别 | 触发路径 | 选中检查 |
|---|---|---|
| docs | `*.md`、`*.mdx`（不在 broad-input 前缀内） | docs |
| web | `apps/web/src/` 下的源文件扩展 | fast,vitest,build |
| server | `apps/server/src/` 下的源文件扩展 | fast,spec,vitest,build |
| motion-core | `packages/motion-core/src/` 下的源文件扩展 | fast,spec,vitest,build |
| dynamics-source | `assets/source/dynamics/myofullbody-complete.xml`、`myofullbody-parameters.json`（仅 status=M） | fast,dynamics-validate,dynamics-test |

- 多类别混改取检查集合**并集**（按 `CHECK_IDS` 固定顺序）；空 diff 选 `fast`。
- 纯 `*.md/*.mdx` 修改只跑 `docs` 检查——不再有 docs-only 全量回退（WP-1A 验收）。
- fail-open：新文件、未知路径、依赖图不完整、公共入口/包配置/TSConfig/CI 改动一律保守扩大验证，不得为省测试错误缩小影响面。
- 输出 machine-readable receipt（base/head SHA、clean/dirty、选中/跳过及理由、命令/结果/耗时、未执行风险）；只有对应准确 head 且工作树验证期间未变的结果可作证据。
- 快照成本分级：plan-only 每边界单次轻量捕获（不含全仓内容 digest），`snapshotConsistency` 标 `single-collected-boundary-git-visible`；`--run` 保留双采完整一致性证明（`double-collected-git-visible`）。
- **性能基线（2025-01 实测，本地 clone，端到端）**：plan-only 下 docs-only 与单文件 TS 改动均为 ~0.5s（2 次轻量捕获），旧实现为 ~2.3–2.9s（4 次全量捕获）；docs-only `--run` ~3.5s（6 次完整捕获，其中 docs 检查本身 <0.5s，其余为正式一致性证据成本）。验收口径：plan-only 选择器自身开销应 ≤1s、相对实际检查耗时只应是小数位占比；`--run` 用于正式验证证据（如交付/合并前），日常迭代优先 plan-only。若快照/扫描成本回升到秒级以上，须重新评估采集策略而不是扩大防御逻辑。
- 开发期最小集合允许 `git diff --check`、小型 Red→Green、相关模块测试；最终 CI 永远跑完整必需套件。
