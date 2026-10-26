# Agent 动作制作审阅环（Motion Authoring Review Loop）

状态：已实现（issue #32 工作包 A + B；C 依赖 #21 的参考量化接口，**保持阻塞**并单独跟踪——仓库内无重投影/拟合实现，不得复制 solver 或假装有该能力）。

目的：外部参考帧 / 人工标注目标 → 坐标与相机条件核对 → 声明目标并用现有工具求解/人工修正 → 固定视角+时刻的参考对照与数值检查 → **有界迭代（≤3 轮）** → 报告无法验证/失败之处 → 交付可编辑 WorkshopDoc。衡量标准是减少「猜坐标 → 改数值 → 重截图」的无效往返，不是产出更多截图与指标。

所有命令在仓库根执行；浏览器步骤在 CI 或非本机开发机跑（见文末移交清单）。原始参考图与大量临时截图放 gitignored 工作区（`.out/`、`tmp/`），**不要自动提交**。

## 0. 坐标与单位约定（读图前必背）

| 系 | 约定 | 常见混淆 |
|---|---|---|
| 图像像素 | 原点**左上**，x 右、y 下，整数像素 | 与世界系 y 向上相反；归一化坐标 = 像素 ÷ 图像宽/高 |
| 相机 | captureStill 固定 640×720；视角方位角 `front`=0°（相机在 +Z 看角色正面）、`side`=90°（相机在 +X，即角色**左**侧）、`back`=180°、`threeQuarter`=−45°（右前斜视，用来暴露遮挡/深度） | 视角名是**相机位置**不是角色朝向；side 看到的是角色左侧 |
| H3D world | 米、+Y 上、+Z 前；该骨架**左=+X、右=−X** | 「屏幕左」≠「角色左」——front 视图里角色左手在画面右侧 |
| 侧别 | `L/R` 一律按**身体侧别**；gripSide 选持拍手 | 不要按画面方位推断 L/R |
| 插值系 | `handFrames` pelvis/world 只影响**手目标插值坐标系**，存储目标仍为世界坐标 | 与 root/torso 参考系无关 |
| 脚接触 | 支撑区间锚定在区间起始帧接触点；离地帧存储摆动中点 | 离地帧的脚位不是当时的脚位 |

**硬规则**：相机未标定/未对齐时，**禁止从 2D 参考点直接编造 3D XYZ**；视觉并排相似**不是**重投影验证。每轮开工先输出下表（模板）：

```
条件核对：
- 参考来源：<图/视频帧/无>
- 相机：<已标定(有内外参)/未标定> → 2D→3D：<可用/不可用>
- 遮挡部位：<列出/无>
- 深度歧义点：<列出/无>
- 本轮可确定：<…>
- 本轮不可确定：<…>（这些只能 unverified，不得写成结论）
```

## 1. 工作流

**Step 0 · 视觉坐标自校准（每次会话读图前一次）**

```sh
sh scripts/check-process-limit.sh && node scripts/agent-vision-check.mjs --emit   # → tmp/agent-vision-<时间>-<pid>/
# 查看 vision-check.png（放大 200%），把 10 个圆点中心 + 红矩形左上/宽高填进 answers.json
sh scripts/check-process-limit.sh && node scripts/agent-vision-check.mjs --check <dir>/answers.json
```

- 每次 `--emit` 生成**随机种子**的新题（`answers.template.json` 带 `challengeId`，种子写在同目录隐藏 sidecar 里）。不要复用上一次的答案或仓库里旧的 `vision-check.result.json`——固定题面等于公开答案，读图能力没被验证。
- `pass`（≤4px）→ 可做像素级读数；`warn`（≤10px）→ 只许大粒度判断（左右/上下/明显穿模），像素级结论一律不可确定；`fail` → **停止读图**，反馈「需要人工标点/校准相机」，不继续随机试角度。
- 本检查只校准**图像平面定位**，不证明 3D 深度/姿态推断能力；不绑定特定模型。
- 2026-10-26 实测记录：本机 agent 自跑 PASS（10 标记 0.0px、矩形 1.4px；`evidence/issue-32/vision-check/`，用固定种子 `issue-32-archived-fixed-seed` 归档，`--check` 可复算出同一结果；测试 `tests/agent-vision-check.test.ts` 钉死随机挑战、错配挑战与 fail/warn 路径）。归档的是**一次历史记录**，不是可复用的题库。

**Step 1 · 条件核对**：按上节模板输出可确定/不可确定项。缺参考就直接声明「无参考，一切对照 unverified」。

**Step 2 · 求解/导入**：改动只落在 WorkshopDoc 或语义命令（`applySemanticEdit`，经工作台语义面板），**不要盲写世界坐标/欧拉角**；每轮修改后必须走真实求解与可编辑导入路径（workshop-capture 的导入即真实 UI 路径）。

**Step 3 · 审阅包（review bundle，需浏览器 → CI/其他机器）**

```sh
npm run dev &   # 等待 /workshop.html 就绪
sh scripts/check-process-limit.sh && node scripts/workshop-capture.mjs <doc.json> --bundle --tag <name>
# 输出：<dir>/<tag>-t<time>-<key|midpoint>-<view>.png + manifest.json
#   · 时刻 = 关键帧 ∪ 区间中点；视角 = front,side,threeQuarter
#   · manifest.bundle.docDigest = sha256(canonical({schema,document}))，与姿态包 definition hash 文档侧一致——改文档必出新摘要
sh scripts/check-process-limit.sh && node scripts/review-crop.mjs --sheet <dir>/manifest.json --out <dir>/sheet.png
```

**Step 4 · 局部检查（本机可跑）**：对高风险部位放大并排（肩/肘/腕、骨盆/膝/足、持拍手与拍头）：

```sh
node scripts/review-crop.mjs evidence/issue-32/synthetic-reference-frame.png <dir>/<shot>.png \
  --region 0.25,0.1,0.5,0.45 --scale 3 --out <dir>/cmp-shoulder.png   # 同区域并排
node scripts/review-crop.mjs <shot>.png --region 0.3,0.4,0.3,0.3 --scale 4 --grid --point 0.42,0.5 --out zoom.png
```

并排只是视觉辅助：参考与渲染同框幅裁剪，**无标定就永远不能写成 mm 级误差**。

**Step 5 · 结构化记录（review.json）**

```sh
node scripts/motion-review.mjs init <dir>/manifest.json [--round N] [--reference ref.png]
# 逐张实际查看 shots[].file，填 visual: ok|suspect（suspect 必填 note）
# findings[] 每条必填：category / evidence / suggestion / uncertainty（写「无」也要显式）
node scripts/motion-review.mjs check <dir>/review.json   # 退出码 0 仅当 verdict=pass
```

`check` 是硬门禁，三种结果要分清：`PASS`（记录合法且无未解决发现，退出 0）、`HANDOFF`（记录合法但仍有真实发现/超轮次，退出 1——这是**审核未通过**，需要修复后开下一轮或按 handoff 移交，不是格式错误）、`INVALID`（记录违背契约，退出 1）。没逐张看图不给过、finding 缺字段不给过、声称「偏离参考」但参考 unverified 直接判错、自动数值异常必须保留与 `numerical.flagged` 对应的 finding（只删 finding 会被拒绝；修复后用新 capture 重新 `init`）、**round > 3 必须填 handoff{reasons,humanItems} 移交人工且永不 PASS**。没有综合评分。

`init` 将原始 manifest 的相对路径和文件 SHA-256 写进 review。`check` 会重新读取这份 manifest，并核对原文件未变化、文档摘要、完整截图身份清单、左右腕异常与对应 finding，以及每张截图文件是否存在；删除部分 `shots`，或同时清空 `findings` 和 `numerical.flagged`，都会被拒绝。修复后用新 capture 重新 `init`。

左右腕残差自动发现用的是**该时刻插值帧的腕目标**（`solved.right/left.wristTarget`），不是最近关键帧的目标；manifest 同时记录 `nearestKeyTarget`，中点处两者通常不同——拿关键帧目标去比会凭空产生 `ik-clamp`。

**Step 6 · 修复或停止**：修复落在 WorkshopDoc/语义命令 → 复跑 Step 3–5（round+1）。第 3 轮仍不合格：停止，如实交付「失败部位 + 诊断证据 + 未解决原因 + 人工介入项」，不调宽阈值掩盖错误。

## 2. 失败类别（review.json findings 的 category）

| category | 含义 | 典型证据 |
|---|---|---|
| `side-view-wrong` | 左右侧别/视角错 | side 视图拍头朝向与预期相反；L/R 写反 |
| `deviates-from-reference` | 末端可达但明显偏离参考 | 数值全绿 + 并排明显不同（**要求参考可判定**） |
| `ik-clamp` | IK clamp/限位 | wristResidualMm > 5（init 自动生成 numeric-invalid finding） |
| `penetration-contact-drift` | 肢体穿透或脚接触漂移 | 穿身截图文件名；support-slip 检查项失败 |
| `reference-unjudgeable` | 参考未标定/遮挡无法判定 | 无内外参、关节被遮挡——结论只能是 unverified |

`solveStatus`（数值合法与否）与参考匹配**分开**陈述：关节合法 ≠ 动作真实。

## 3. 仓库内演示素材（`evidence/issue-32/`）

- `ready-swing-contact.workshop.json`：全新 ready→引拍→击球→随挥→回位文档（**非**内置预设）；`tests/issue-32-fixture.test.ts` 在真实 `parseDoc → frameAt → solveEffectiveFrame → analyzePose` 路径上验证全部审阅时刻（腕残差 0.0mm、无限位违反）。
- `synthetic-reference-frame.png`：合成参考帧（火柴人，持拍臂下垂、与 fixture 击球姿态故意不一致、**无标定**）。用于演示：视觉可判「不一致」→ referenceStatus 只能是 `inconsistent`（且不可给量化误差）；若声称 `deviates-from-reference` 但 referenceStatus=`unverified`，`check` 直接拒绝。
- `vision-check/`：一次视觉坐标自校准的归档记录（`answers.json` + 隐藏 sidecar 提供该次随机题的固定种子 + `vision-check.result.json`），可用 `--check` 复算；它证明的只是**当时**那一次读图能力，不是可复用题库，也不要拿它当本轮会话的校准凭据。
- `example-review.json`：review 记录的**手写示例**（字段形状演示），不是一次真实 capture 的产物；真实链路的可运行证据是 CI 里的 `review-bundle-browser-qa`（见第 4 节）与本地 `tests/review-bundle-qa.test.ts`。
- 负例演示路径：图像坐标读错 → Step 0 fail 分支（测试钉死）；数值合法但与参考不符 → fixture + 合成参考的 findings 流程；不可观测/未校准 → `reference-unjudgeable` 类别与 unverified 规则；中点残差误算 → `tests/review-bundle-qa.test.ts` 用同一 fixture 的最近关键帧目标复现旧算法的虚假 `ik-clamp` 并要求验收检查拒绝。

## 4. 移交与边界

- **本机（macpro）禁跑任何浏览器自动化**（kernel panic）；Step 3 的 capture 在 CI 或其他开发机执行。固定输入可复现：同一 doc + 版本 + 视角集合 → 相同图片与摘要（时间戳/机器环境除外）。`browser-qa` workflow 的「Capture and review the real issue-32 bundle」步骤用 `evidence/issue-32/ready-swing-contact.workshop.json` 跑真实导入 → key+中点截图 → manifest → `motion-review init/check`，由 `scripts/review-bundle-browser-qa.mjs` 断言左右腕中点残差 ≤5 mm、插值目标与最近关键帧目标有实质差异、manifest 完整性与未查看门禁；随后将完整 shot ledger 标为 `ok` 跑 CLI 正向 PASS 契约样例。这个自动填写仅验证真实截图与 CLI 记录的完整数据路径，不表示 CI 做了视觉判断；真正的视觉 `ok` 仍须 agent/人工逐图查看。
- 工具为 CLI/Agent-first：不在工作台加 UI 面板、不建新渲染器、不新增图像依赖（PNG codec 为 `scripts/lib/png.mjs` 零依赖实现）。review 过程不修改用户动作——capture 只读导入，修改必须经确认的 WorkshopDoc/语义命令路径。
- C（#21 参考量化诊断）在真实接口合并前保持阻塞并如实标记，不复制 solver。
- 保存/撤销/导入/回放/JSON/GLB 旧路径不受影响：本环只读消费 `workshop-capture` 产物。
