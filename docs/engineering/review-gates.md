# 审查门禁与验证生命周期

本文合并两条既有口径：原 AGENTS.md 的「测试与验证策略」（Level 0–3）与 issue #11 的 Review/Verify 生命周期。**权威分工**：审查协议字段级契约（brief 字段、verdict、record 字段、rework/handoff 规则、模板与示例）在 [review-protocol.md](review-protocol.md)；本文拥有验证级别映射与合并门禁现状。`.agents/skills/` 规范 skill 属 **规划/待实现（PR-11A 遗留）**；`check:affected` 已实现（PR-11B，plan-only 出选择回执、`--run` 执行并出完整一致性回执）。在 skill 落地前，两级 review 由任务流程中的独立 reviewer 按两文手工执行。

## 目标循环

```text
Issue → task-slice / 契约与方案预审
  → 独立 worktree 实现（开发中可做最小 Red→Green / 定向测试）
  → Fast Review（只找确定的 blockers；不做昂贵验证）
      ├─ REWORK → 修复 → 只复审相关差异与新风险
      ├─ ESCALATE → 重新规划/冻结接口，禁止盲目循环
      └─ PROCEED → affected checks → Final Review
                        → Ready PR → 完整必需 CI/真实路径验收 → Merge
```

## 不可突破的约束

- Fast Review 是**提前证伪门禁**，不是替代测试：已发现的失败必须调查，不得用「省时间」掩盖。
- 仅 REWORK 阶段避免*不必要的*全量测试/生产构建/浏览器 E2E/完整 CI；高风险真实路径测试仍必须在合并前完成。
- Reviewer 尽量独立于 Implementer，基于明确的 base/head SHA、实际 diff 与任务契约判断；不以「看起来 OK」或虚构分数作为通过依据。
- 完整必需检查绑定**最终待合并 head SHA**；新提交使旧结果过期。未执行的验证不得写为通过；被 CI 跳过的 job 不构成绕过必需门禁的路径。

## Fast Review（开发期证伪）

输入：task brief + `git diff <base>...<head>`（含未提交差异）。逐条检查清单、verdict 与 record 字段契约见 [review-protocol.md](review-protocol.md)「Fast Review」节；此处保留门禁语义。

检查（只找确定的 blockers）：需求遗漏、反向依赖、破坏性 API、身份/版本/坐标系/接触语义、实现路径是否真实、测试被弱化、明显调用链错误——追踪必要的调用方与被调用方，不只看单文件。

输出：`PROCEED | REWORK | ESCALATE`；每个 blocker 附文件定位、失败机制、最小复现/验证建议。建议性重构与风格意见不阻断；发现可信的致命 blocker 可提早结束。**此阶段禁止跑全仓测试/build/E2E/bench。**

REWORK 后只复审 blocker 修复及受影响调用链，未变区域不重复评审；连续出现同类架构级返工 → ESCALATE 回 Plan，不做无限修补（轮数上限可由任务配置）。

## Final Review（PROCEED + affected checks 之后）

审完整 diff：结构与测试质量、真实路径/协议/golden/性能风险、残余验证缺口。输出可操作 blocker、advisory、必须执行的验收项；不因 CI 绿就 rubber-stamp。

## 验证级别（改动范围 → 开发期最小验证）

| 级别 | 范围 | 开发期要求 |
|---|---|---|
| Level 0 | 仅文档/注释等不影响运行行为 | 检查 diff + `npm run docs:check`（改了 .md 时），无需构建测试 |
| Level 1 | 独立函数、UI 局部逻辑、插值计算 | 直接相关的定向 vitest；行为变化补测试；涉及类型接口跑 `sh scripts/check-process-limit.sh --npx && npx tsc -b` |
| Level 2 | 共享类型、状态流、数据格式、模块间契约 | 所有受影响模块测试 + `tsc -b`；涉及构建配置跑 `npm run build` |
| Level 3 | 协议、骨骼运动语义、IK、动力学、持久化、关键交互路径 | **必须**验证受影响的真实实现路径（不得以 mock 代替）；补集成/E2E；资源不足可移交 CI/其他机器但必须记录未完成项 |

执行细节：优先 `npm test -- <test-file>`；根与 workspace 的 npm 验证入口在目标命令启动前按一个额外 Node / ffmpeg 进程预留检查；直接运行 `node` 前执行 `sh scripts/check-process-limit.sh`，直接运行 `npx` 前执行 `sh scripts/check-process-limit.sh --npx`；Vitest 默认单线程 worker 且不并行测试文件，内部再复核进程上限；浏览器 QA 共享串行锁且 Chromium renderer 限 1；`npm run qa` 默认跳过 WebGL 录屏和两轮动作优化，`HUMAN3D_QA_HEAVY=1` 才启用；`npm run build` 已含 `tsc -b`；失败先查根因再决定重试，不无限重试，也不重复跑未受影响的全量集合。

## 合并门禁现状与规划

- **现状（PR-11A 已落地）**：`test` workflow 区分 Draft/Ready——Draft 只跑 `fast`（bounded A1 检查）且 `required` 报 `draft_deferred`；Ready 与 `main` push 跑 `full`（`docs:check`、`tsc -b`、`spec:check`、全量 vitest、`build`）+ `dynamics`；稳定聚合检查 `test / required` 只认实际成功（skipped/cancelled/stale/unrun 一律红）。事件矩阵见 [ci-lifecycle.md](ci-lifecycle.md)（`converted_to_draft`/`ready_for_review` 已在 PR #15 实测复演；`main` push 事件与远端 branch protection 配置——`test / required` 为必需检查——仍是待完成验收项，`main` 当前无任何保护规则）。浏览器 E2E（`npm run qa`）**未进 CI**，其验证状态必须单独记录。
- **已实现（PR-11B）**：`check:affected`（plan-only 选择回执）与 `--run`（顺序执行选中检查 + 完整一致性回执）；类别映射的唯一权威是 [test-matrix.md](test-matrix.md)「选择器映射」表，与 `CATEGORY_CHECKS` 有矩阵一致性测试钉死。
- **规划/待实现**：`check:full`（完整本地验证的统一封装）。
- **规划/待实现（PR-11A 遗留）**：`.agents/skills/` 下的 `task-slice`/`fast-review`/`final-review`/`handoff` 规范 skill。

## 最终交付报告（每次任务必须说明）

- 已执行的验证及结果；
- 未执行的验证及原因；
- 是否需要 CI 或其他机器继续验证；
- 哪些风险尚未排除。

不得将「未运行」描述为「测试通过」。
