# 领域不变量：工作台 UI 与持久化

改 `apps/web/src/workshop/`、播放源或工作台 E2E 前必读本文。功能全景见 [../WORKSHOP.md](../WORKSHOP.md)，验收记录见 [../QA.md](../QA.md)。

## 真实写路径

- 算法支持的每个能力都必须存在真实 UI 写入路径（learning [5]）：参数能进文档、有控件、禁用态合理。QA 验收用真实指针/输入事件（`browser-qa.mjs`），不直调引擎写方法（读路径/播放控制除外）。
- 测试复现「出问题的具体交互路径」（learning [10]）：修交互 bug 要配一条走真实事件的断言，旁路改数据不算覆盖。
- 初始选中 id 必须来自已加载动作，面板显示的回退关键帧也必须可写；姿态编辑先将预览定位到该关键帧。不能只更新滑块局部数字而因旧 id 静默跳过文档写入。

## 显示与编辑分离

- 渲染位置 ≠ 编辑目标时必须拆两个控件：摆动区间内脚柄 `passive`（显示真实位置、拾取穿透），青色 `swing` 手柄绑离地帧存储目标、跟手（learning [6]）。手柄必须跟手是所见即所得底线。
- 死数据写入口就近提示（learning [7]）：末尾离地帧无后续区间、存储高度不会被采样——UI 给出显式提示且不显路径点手柄。

## 拍柄棱面与手指开合（ADR-0010）

- **bevel 不是求解输入**：`gripBevel` 只转拍面（`mountRacket` 后的局部 roll），拍头在柄轴上、手指绕圆柄包裹、没有骨骼读它——改棱面轨迹不变。但它是文档字段，**照常进请求指纹与定义哈希**（改棱面 = 新 artifact id、同轨迹）；不要为它开「仅展示不入指纹」的旁路。
- 编号手掌相对且左右镜像（`bevelSign` 右 +1 / 左 −1）：`mirrorDoc` 原样保留 `gripBevel`，镜像后球拍是源的精确 x 镜像（grip-side.test.ts 逐点钉死；探针 x≠0 时左右对应点是**局部 x 取反**的点）。
- 缺省即规范：显式 1 被 `normalizeDoc` 折叠、未写旧文档字节不变；导出仅在非 1 时写 `presentation.bevel`。
- **handSpread 的 0.5 是缺省规范形态**：写 0.5 = 删通道；`applyHandShape` 在 0.5 走与旧 `relaxHand` **逐位相同**的快速路径（articulateHand 会引入 −0 分量泄漏进包字节）——改 hand-shape/solver 时不得破坏该等价（hand-shape.test.ts 钉死）。通道追加在 `flattenPose` 尾部（L=47/R=48），旧索引不动；生成器 handL/handR 相位移动必须捎带自己的 spread 通道（`EXTRAS`）。
- 手型移动指节骨骼 = 运动语义变化，必须 bump `SERVICE_VERSION`（本切片 0.8.0→0.9.0，`WORKSHOP_REVISION` v4→v5）。

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

- **Review 不写文档**：`WorkshopEngine.setEditable(false)` 隐藏手柄与触球标记并拒绝编辑拾取（允许只读肌群高亮选择）；时间轴在 Review 下只 seek、不重定时，姿态卡整体 `inert`。桌面和手机均默认 Review，轨迹与重心/支撑叠加默认关闭；进入 Edit 后按需展开语义调整与编辑手柄。抽屉只是 CSS（`.ws-compact`），开关不重建 canvas、不丢相机/编辑状态。
- **语义命令**走 `applySemanticEdit`（`packages/motion-core/src/semantic-edit.ts`）：白名单 `部位 × 侧别 × 动作 × 度数` → 编码进既有 `PoseParams` 字段（不改 schema）→ 生产 `frameAt → solveEffectiveFrame` → 从求解后的骨骼读回解剖角，返回 `requested/actual/residual/reason`；不足 0.5° 或带动支撑脚即 `ok:false`，界面显示原因，不报成功。输入文档不被修改：预览总从事务开始时的同一基底重算，确认 = 一条撤销记录，取消 = 恢复基底并丢掉该记录。
- **只动被指令的关节**：髋 / 膝语义是对该关节以下的腿做刚性 FK（`foot.target/pole/yaw/pitch` 一起旋转），肩 / 肘同理（`rotateArmAbout`）；`CHILD_JOINTS` 列出必须不变的子关节角，超过 1.5° 判失败。支撑帧上调腿 = 本帧离地 + 相邻帧接管原接触点（显示姿态逐骨核对 ≤1 mm），并补偿掉被取消支撑后不再施加的自动骨盆后移。
- 「落地」= `groundFoot`：只改本帧，竖直平移整体（自动骨盆后移保持为本帧原值并折算进 `root.z`），支撑腿重新求解；够不到 / 踝超限时拒绝，文档不变。
- 关节旋转条显示选中帧求解后的绝对角度，不保存组件内增量。**只暴露求解器真能独立兑现的自由度**（三者都经 `frameAt → solveEffectiveFrame` 实测 round-trip）：
  - **大臂**：肩相对 `shoulder01`→`upperarm01` 的 YXZ 三通道（`lift/swing/twist` = X/Y/Z）全部可控，读回残差 0.00°。肩是球关节，`rotateArmAbout` 把世界旋转编码进手目标 / 肘 pole，脚本无关。
  - **前臂**：`rig.limb` 由腕目标与 pole 反解 `lowerarm01`，方向与弯曲平面是**输出**；绕前臂自身纵轴的旋转对读回值 **0.000° 影响**，lift/swing 目标残差 20–40° 且串到其他轴。因此前臂只提供**肘铰链角**（`readElbowAngle`/`setElbowAngle`，0° 伸直，受 `LIMITS.elbowFlexion[1]` 或自由手臂 180° 限制），实测精确 round-trip；三轴伪绝对量不再伪装成独立控制量。
  - **腕**：腕相对 `lowerarm01` 的 YXZ 三通道精确可控（0.00° 残差）。非自由手臂时求解器把**合成弯曲角**（手前向与前臂轴夹角）夹到 `WRIST_BEND_LIMIT_DEG`，不是逐通道限位：屈伸 / 侧偏可能在滑轨端点前饱和（实测屈曲约 50° 饱和），旋前旋后不受影响；面板给出提示，自由手臂下三通道 ±180° 精确。
  - 欧拉分支：一个旋转有两组等价 YXZ 三元组（`(x,y,z)` 与 `(π−x, y±π, z±π)`），lift 过 ±90° 时标准解码会让三条滑轨一起跳。控件保留上一次读数作 reference，只在候选三元组经四元数回代验证等价时切换，因此 1° 步进拖拽全程连续（rotation-controls.test.ts 钉死）。分段 twist 骨只由求解器处理，不单独显示。
  - ±180° 接缝：`+180°` 与 `−180°` 是同一旋转但滑轨两端。环绕后一律取 +180° 会让从 −175° 拖到 −180° 的滑轨跳到右端；读数沿用上一次读数的符号，左来停左端、右来停右端。仅精确落在 ±180° 时生效，179.2° 这类邻近值不会被翻符号。
- 滑块读数描述**播放头**姿态，写入目标是**选中关键帧**（`editAtKey` 写入前会重新 seek）。播放头不在该帧上（含播放中——时钟每帧移动，否则门控会随经过该帧而闪烁）时旋转滑块**禁用**，面板提示当前时刻并给出「跳到该关键帧」按钮：读数与编辑目标一致时才允许拖动，而不是先允许在错误上下文里编辑再解释。门控判据是 `rotationControlsInSync`（`rotation-controls.ts`，有单测）。手指开合只读写作者值，不受此门控。
- 底层 `rotateArmJoint` 的 lift/swing/twist 仍是工程轴 API，未改名为解剖术语；工作台绝对角度控件通过 `rotateArmAbout` 编码到现有手目标 / 肘 pole，腕角编码到手方向向量。语义肩屈/外展用胸廓轴，肘屈伸绕求解后的肘铰链。
- 审阅反馈是会话态（不写 WorkshopDoc），导出为 `kind:'h3d-review-feedback'` JSON。
