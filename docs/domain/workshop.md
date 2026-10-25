# 领域不变量：工作台 UI 与持久化

改 `apps/web/src/workshop/`、播放源或工作台 E2E 前必读本文。功能全景见 [../WORKSHOP.md](../WORKSHOP.md)，验收记录见 [../QA.md](../QA.md)。

## 真实写路径

- 算法支持的每个能力都必须存在真实 UI 写入路径（learning [5]）：参数能进文档、有控件、禁用态合理。QA 验收用真实指针/输入事件（`browser-qa.mjs`），不直调引擎写方法（读路径/播放控制除外）。
- 测试复现「出问题的具体交互路径」（learning [10]）：修交互 bug 要配一条走真实事件的断言，旁路改数据不算覆盖。
- 初始选中 id 必须来自已加载动作，面板显示的回退关键帧也必须可写；姿态编辑先将预览定位到该关键帧。不能只更新滑块局部数字而因旧 id 静默跳过文档写入。

## 显示与编辑分离

- 渲染位置 ≠ 编辑目标时必须拆两个控件：摆动区间内脚柄 `passive`（显示真实位置、拾取穿透），青色 `swing` 手柄绑离地帧存储目标、跟手（learning [6]）。手柄必须跟手是所见即所得底线。
- 死数据写入口就近提示（learning [7]）：末尾离地帧无后续区间、存储高度不会被采样——UI 给出显式提示且不显路径点手柄。

## 撤销与文档生命周期

- 撤销合并窗口的键是「同一文档、同一事务」（`RecordGate`）：跨文档/撤销后必录新快照；增量控件把文档纪元编进 key 随撤销重置（learning [13]）。
- **跨文档恢复只做选择切换**：快照是指针，undo/redo 恢复目标 id ≠ 当前 id 时只 `selectDoc`，绝不向异 id 文档写内容；同 id 恢复才覆写自身历史。新文档（如镜像产物）的书预存源快照 → 一步选回。
- 删文档连同其撤销书（`onRemoved` 钩子）；恢复目标不在库中走 hint，不静默吞步。

## 持久化与隔离

- `MotionLibrary`：JSON 损坏或 `schemaVersion` 未知时整体进隔离区、跳过自动保存、原文不覆盖（learning [14]）；隔离导出对字符串原文原样导出。
- 生成预览（`generationPreview`）是易失覆盖，不落 localStorage、不进库字节；取消清空候选恢复源，保留才复制为新文档。

## 渲染导出

- `captureStill`/`captureSheet`：固定 640×720 / 固定相机预设出图，编辑器叠加物默认不入图；`CaptureMutex` 入口互斥，拼图全程持有 `captureDepth`，全部 tile 对同一文档冻结副本求解。

## 审阅 / 编辑模式与语义控件（issue #23）

- **Review 不写文档**：`WorkshopEngine.setEditable(false)` 隐藏手柄与触球标记并拒绝编辑拾取（允许只读肌群高亮选择）；时间轴在 Review 下只 seek、不重定时，姿态卡整体 `inert`。手机默认 Review，桌面默认 Edit。抽屉只是 CSS（`.ws-compact`），开关不重建 canvas、不丢相机/编辑状态。
- **语义命令**走 `applySemanticEdit`（`packages/motion-core/src/semantic-edit.ts`）：白名单 `部位 × 侧别 × 动作 × 度数` → 编码进既有 `PoseParams` 字段（不改 schema）→ 生产 `frameAt → solveEffectiveFrame` → 从求解后的骨骼读回解剖角，返回 `requested/actual/residual/reason`；不足 0.5° 或带动支撑脚即 `ok:false`，界面显示原因，不报成功。输入文档不被修改：预览总从事务开始时的同一基底重算，确认 = 一条撤销记录，取消 = 恢复基底并丢掉该记录。
- **只动被指令的关节**：髋 / 膝语义是对该关节以下的腿做刚性 FK（`foot.target/pole/yaw/pitch` 一起旋转），肩 / 肘同理（`rotateArmAbout`）；`CHILD_JOINTS` 列出必须不变的子关节角，超过 1.5° 判失败。支撑帧上调腿 = 本帧离地 + 相邻帧接管原接触点（显示姿态逐骨核对 ≤1 mm），并补偿掉被取消支撑后不再施加的自动骨盆后移。
- 「落地」= `groundFoot`：只改本帧，竖直平移整体（自动骨盆后移保持为本帧原值并折算进 `root.z`），支撑腿重新求解；够不到 / 踝超限时拒绝，文档不变。
- 现有 `rotateArmJoint` 的 lift/swing/twist 仍是工程轴，未改名为解剖术语；语义肩屈/外展用胸廓轴（`rotateArmAbout`），肘屈伸绕求解后的肘铰链。
- 审阅反馈是会话态（不写 WorkshopDoc），导出为 `kind:'h3d-review-feedback'` JSON。
