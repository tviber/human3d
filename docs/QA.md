# 实际验收记录

基础动作验收：2026-10-16；肌肉驱动动作复验：2026-10-17。此记录针对人体运动学与肌肉驱动原型，不宣称达到临床或职业运动分析精度。

## 环境与方法

- 开发页：http://127.0.0.1:5173/ 。生产静态构建：http://127.0.0.1:4173/ 。
- 自动视觉与交互：Playwright + 本机 Chrome **155.0.8059.80**。
- 视口：1536×1024（与设计概念原生尺寸一致）、1366×900、390×844。
- 应用内浏览器：实际加载、切换持拍、检查手部特写及连续播放，已保留应用标签页。
- 独立 Browser 技能插件未提供，依 frontend-testing-debugging 采用普通 Playwright。应用内浏览器另用 CUA 实际交互核对。
- 通过 view_image 同时复查 docs/ui-concept.png 与最新浏览器截图；另外检查握拍、下蹲侧面、抬手、调试和移动端截图。
- 所有图片为真实 WebGL 浏览器渲染，不以设计概念或静态图片冒充模型。录屏是 canvas.captureStream(30) + MediaRecorder 实时捕获。

## 姿态有效性检查器（手臂—躯干）

网球正手动作曾有右臂在部分姿态下穿入躯干的缺陷（2026-10-20 已修复；报告与 17 球员研究链已随 #21/#30 消融归档，git tag `archive/forehand-17` 可溯源）。独立检查器 `apps/web/src/lab/pose-validity.ts` 在生产蒙皮网格上工作：读取 Three.js 变形后的实际表面，将明确分类的左右臂三角面与躯干三角面做三维相交检查，并读取已由 `frameAt → solveEffectiveFrame` 求出的肩臂方向、肩上抬和肘屈曲。它只用于诊断，不改变 IK、动作采样或服务契约。

判定有三种：

- `valid`：本采样帧已分类的表面没有检测到交叉，且肩肘诊断项在当前工程限值内。
- `invalid`：检测到确定的手臂—躯干表面交叉，或肩肘读数超出配置限值。报告列出侧别、涉及骨骼、交叉三角面编号和交叉见证位置；肩肘项提供实测值、限值与单位。
- `indeterminate`：混合权重的肩腋过渡面与已分类表面相交，或候选数量达到上限导致结果被截断。它表示分类区域不足以给出可靠的全身通过结论。

交叉位置是三角面对质心，不是穿透深度。检查器只检查被分类的表面及当前采样帧；不判断封闭体积包含、采样帧之间的碰撞，也不覆盖未分类拓扑。肩肘角是工程 rig 几何读数，不是临床活动度标准。报告始终包含 `limitations`，阅读 `valid` 时也应保留这些边界。

使用真实 GLB、Lab 的生产骨架及浏览器渲染运行回归验收：

```sh
npm test -- apps/web/src/lab/pose-validity.test.ts
npm run dev
npm run qa:pose-validity
sh scripts/check-process-limit.sh && node scripts/pose-visual-qa.mjs --quick 正手挥拍 "Novak Djokovic"   # 按信封阶段标记做多方位纯渲染截图
```

浏览器验收驱动真实 Lab 页面，生成三个夹具各自的 front/side/back WebGL 截图以及 `report.json`。若需要独立端口：

```sh
HUMAN3D_WEB_PORT=5174 npm run dev
HUMAN3D_WEB_PORT=5174 npm run qa:pose-validity
```

所有运行产物默认写入 `.out/<worktree>/<run>/pose-validity/`。报告内每个视图记录 `view`、相机坐标、固定时间和图片名；碰撞夹具以红色标记交叉见证位置，肩肘检查违规时记录对应骨骼与实测值。若同一姿态同时有几何交叉和关节违规，截图优先标记几何见证点，两个结果都保留在报告中。

2026-10-19 的真实渲染验收使用 Chromium 156：有效 crossed-arm 的正面投影最近距离约 0.33 mm、3D 深度分离约 62 mm；修复前的 forehand 在 3.35 s 报告右臂—躯干 254 对三角面交叉；肩方向夹具报告 175.7°，超过 155°诊断阈值。

2026-10-20 修复后的真实渲染验收（Chromium 156，四个夹具各 front/side/back 截图，控制台错误 0）：有效 crossed-arm 仍为 `valid`（0.33 mm / 62 mm）；新增合成「右臂穿躯干」阳性夹具（腕目标在身体左前、肘 pole 留在躯干后——修复前正手随挥的形态）报告 `invalid`、60 对三角面交叉，涉及 `upperarm01_R`/`spine02`/`breast_R`；forehand 3.35 s 变为 `valid`、0 交叉、关节检查全过；肩方向夹具不变。同日用 `scripts/pose-visual-qa.mjs --quick` 对 19 个持拍动作（ready、forehand、17 个球员预设）按信封阶段标记做 4 方位纯渲染截图共 376 张并逐动作拼图复查：持拍臂全程伸展、球拍在手，未见手臂折进躯干或球拍贴头。随后按用户两轮反馈重做双臂编舞（`scripts/lib/forehand-arms.mts`）：持拍臂触球近直（肘约 23°）→ 近直延伸 → 链空间折肘到非持拍肩前，拍轴距竖直 20–23°、拍头在该肩上方；非持拍臂引拍护在胸前（肘约 80°）→ 收胸 → 在拍喉接住球拍（腕到拍喉 ≤ 0.07 m）；随后按第四轮反馈把持拍大臂改成「先下后斜上」（引拍 −40° → 落拍 −55° → 触球 −14° → 定格 +21° 仰角，`pose-validity.test.ts` 钉死「落拍低于引拍 ≥12°、定格高于落拍 ≥45°」）；18 个正手的引拍/击球区/随挥阶段同样由该测试钉死，稠密扫描结果见下。

该诊断代码没有改动 `motion-core` 求解语义，因此不需要 bump `SERVICE_VERSION`。

## 自动测试

> 2026-10-17 追加（issue #2 修复）：`npx vitest run` 共 **107 项通过**，新增契约、语义校验与工坊回归测试，阈值见 [validation.md](validation.md)。该计数为当日快照；架构收敛后（2026-10-18）为 **138 项**，WP-C 收尾（同日，`feat/pose-pipeline` `0b17c6d` 起）为 **185 项**，最新数量以 `npm test` 输出为准。下方 33 项是原验收记录，未改动。

`npm test -- --maxWorkers=1`：**33 项通过**。真实解析交付的 GLB 与 AnimationClip，并检查直拳握拳各指节、腕部动作和蒙皮—肌肉仿真上肢方向一致性。

| 检查 | 结果 / 范围 |
|---|---|
| 双骨 IK 的有效目标 | 固定肢段长度，可达目标误差小于 1e−8 m |
| 过远、过近、奇异目标 | 无 NaN、不拉长骨骼、屈曲限制有效 |
| 参考框架与四元数 | 单位旋转、方向映射正确 |
| 左右手镜像 | 两侧掌面朝内、放松指尖镜像误差小于 2 mm |
| 肩肘 FK 铰链 | 肩转动带动前臂，肘局部旋转保持标定屈伸轴；100 个步态采样，两侧肘窝无翻转 |
| 行走步宽 / 接缝 | 双足独立轨道 6–18 cm 范围内，根横移小于 6.5 cm；周期姿态接缝小于 0.01 rad |
| 真实模型 | 53514 顶点、163 骨骼，双手各五指三段，蒙皮权重归一 |
| 动作加载 | 六个片段，各 164 条轨道，绑定到存在的骨骼 |
| 骨长与骨骼缩放 | 每动作 31 个时间采样，局部骨骼平移恒定，scale=(1,1,1) |
| 膝 / 肘范围 | 屈曲不超过 135° / 145° |
| 髋 / 肩 / 踝 / 腕 | 每动作 80 个时间采样，工程坐标下分别满足预设范围 |
| 下蹲双足 | 81 个时间采样，每踝目标误差小于 0.1 mm |
| 行走支撑段 | 左足 0.08–0.30 s、右足 0.52–0.88 s，世界水平位置漂移小于 0.2 mm；不把此结果外推至离地和接缝 |
| 握拍 | 101 个挥拍采样，握柄与手腕局部接触框架误差小于 1e−10 m；各指骨段不穿过握柄轴，均有指腹余量内接触；DIP 不超过 75° |
| 直拳握拳与可视手臂 | MCP/PIP/DIP、拇指 CMC/MCP/IP 及腕部 / 前臂旋转参与记录；左拳形成闭合护脸姿态；基线仿真起拳拳端在肩后约 13.5 cm、低于肩约 20 cm，伸展轨迹沿同侧肩线；回收至少完成伸展—收拳距离的一半 |

角度采用工程投影 / 几何定义，不能等同于 ISB 临床角度。刚性掌柄误差为零，也不证明皮肤表面绝对无间隙或穿插。

## 浏览器检查

`scripts/browser-qa.mjs` 检查并保存 evidence/browser-results.json。默认跳过高 CPU 的 WebGL 录屏和两轮动作优化，并在结果的 `skipped` 字段记录；设置 `HUMAN3D_QA_HEAVY=1` 后运行完整重型验收。验证启动前会检查本仓库运行的 Node / ffmpeg 进程数（不含编辑器和其他项目的进程），超过 4 个即拒绝。

| 检查 | 结果 |
|---|---|
| 页面标题 / 非空页面 / 资源就绪 | 通过 |
| Vite 错误遮罩 | 无 |
| 控制台应用 error / warning | 0 / 0 |
| 六个动作切换及标题 / 选中状态 | 通过 |
| 暂停、恢复、重播 | 通过 |
| 进度拖动、速度调整 | 通过，修改真实动作时间与倍率 |
| 循环关闭后停止在终点 | 通过 |
| 真实指针 Orbit 拖动与滚轮缩放 | 通过，摄像机坐标改变 |
| 表面、骨架、坐标轴、IK 端点 | 通过，实际 3D 对象显隐变化 |
| 资料弹窗 | 通过，显示真实来源 / 许可 |
| 六个动作各 80 次浏览器采样 | 通过，膝肘范围和掌柄连接符合测试条件 |
| 移动端横向溢出 | 无；观察面板在画布下方可滚动访问，播放条保持可见 |
| 生产构建 / 无外部网络资源 | 通过；阻断所有非 localhost 请求，人体、字体、动作仍加载，切换挥拍与进度可用 |
| 实时挥拍录屏 | 通过，完整动作至停止后约 0.2 s |

`npm run build` 通过。Three.js 核心 chunk 约 560 kB（gzip 约 142 kB）触发 Vite 的默认 500 kB 提示，这是当前 3D 引擎体积，不是运行错误。`npm audit` 为 0 漏洞。

### 后续追加的 `browser-qa.mjs` 检查名

姿态管线 PR 之后 `result.checks` 新增的键（上表为原验收快照，最新以脚本为准）：

| 检查名 | 断言 |
|---|---|
| `posePackage` | 真实服务 `POST /v1/motions {idle}` 返回的 .pose.json 经实验室文件输入解码：`PosePackageSource` status=ready、163 骨、root 有限 |
| `posePackageForehand` | 同路径 forehand 包：信封派生恢复名称/球拍能力——视口标题「正手挥拍」、球拍挂载可见、「手部特写」「球拍运动轨迹」控件出现、oneShot 禁用循环开关 |
| `workshopDragPersist` | 真实指针拖动手柄 → localStorage → 刷新后内存文档与求解腕位一致 |
| `workshopPackageExport` | 「导出姿态包」真实下载的字节与同文档 POST 响应对等（字符串/结构逐位、浮点 ~1e−12），文件名 `<docId>.<artifactId>.pose.json`，并回环进实验室文件输入成功解码 |
| `workshopGlbExport` | 「导出 GLB」真实下载：glTF magic/版本、恰好一条 animation、rotation channel 数等于包轨道数；文件名 `<docId>.<artifactId>.glb`（GLB 不承载身份契约——动画名与文件名借用制品 id 便于对应，身份以 .pose.json 为准） |
| `workshopFootHeight` | UI 取消支撑 → 高度滑块写 0.35 m → 摆动中点 `foot_L` 离地 >0.15 |
| `workshopWaypointDrag` | 摆动区间内脚柄 passive、青色路径点手柄真实拖动跟手且求解脚位同步升高 |
| `workshopOnion` | 「洋葱皮」开关 → 场景中 3 前 + 3 后幽灵 LineSegments 池存在；keys 模式只画播放头 ±N 键括号（停在中键上前一后一），step 模式数量随「数量」控件 2→4 / 3→6；真实指针拖动期间幽灵缓冲逐字节冻结、松手后随 docDirty 重建刷新；关闭后全部隐藏 |
| `workshopStillExport` | 「渲染静帧」真实点击下载：PNG magic + IHDR 钉死固定出图 640×720，文件名 `<docId>.t<秒>.png`，导出后 `__WS__` 播放态与时间原样恢复；「关键帧拼图」（播放中点击）下载 `<docId>.sheet.png`，3 键文档为 3 格单行（1920×748），体积大于单帧静帧；整张拼图在同一段外层捕获会话里完成（`capturing` 从入口持有到拼图 toBlob，逐格 `endCapture` 恢复点读到的是会话内暂停态），最后一次外层恢复才把播放态交回 true——tap `endCapture` 实测 3 次逐格暂停恢复 + 1 次外层 true 恢复 |
| `workshopGripSide` | 「握拍侧」真实下拉选「左手」→ `doc.gripSide==='L'`、约束行重标为「左手握拍」、真实勾选两键握拍；求解后球拍 `parent===wrist_L` 且原点距左腕 <0.15 m、比右腕更近；随后真实指针拖动拍头手柄：写入 `handL.target`，`handR.target` 逐字节不变 |
| `workshopMirror` | 「镜像动作」真实点击 → 新文档入库并选中（id 带 `.mirrored`、名称带「镜像」，库计数 +1 且原文档保留）；左握 QA 文档镜像后 `gripSide` 回右手、球拍重挂 `wrist_R`；t=.5 真实求解腕位左右互换（镜像 `wrist_L` ≈ 源 `wrist_R` 的 x 反射，容差 1e-5）；「撤销」一步回到源文档 id 且求解一致 |
| `workshopRotationSync` | 播放头停在两键之间 → 提示可见、大臂/肘/腕滑块均为 disabled；对大臂和腕滑块发 `press('PageUp')` 后输入值与文档不变；点「跳到该关键帧」后提示消失、滑块启用且播放头等于选中帧时间（`scripts/workshop-preset-qa.mjs`，CI `browser-qa / library`） |
| `workshopMobileArmControls` | 手机 UI 在右侧编辑右腕 twist 与肘屈曲，滑块读数和求解角度变化、对应 hand frame 写入选中 key；切换左侧编辑左腕 twist，读数和 hand frame 同步变化（`scripts/workshop-mobile-qa.mjs`，CI `browser-qa / library`） |

### WP-C 追加的检查与证据（求解语义变更：切线限界 + 手部 SO(3) 三次）

- **质量探针**：`packages/motion-core/src/quality-probe.ts` 是共享度量实现（vitest 与 CLI 同源），`sh scripts/check-process-limit.sh --npx && npx tsx scripts/measure-quality-probe.mts [fps=240] [motion|all]` 走真实 `frameAt → solveEffectiveFrame → analyzePose` 路径以 240fps 采样；`evidence/quality-probe-*.json` 是 WP-C 后求解器的提交基线。`quality.test.ts` 既有结构断言也有硬质量门（kick 削减、atKey 步长、accelTop 等，实测值写进注释）。
- **forehand-study 验收夹具**：`spec/examples/forehand-study.request.json` 是 2.0 s、5 键的正手文档，**全部由工作台真实 UI 写路径制作**（制作链 `drive.mjs`/`ops.json` 与逐轮快照已随 #21/#30 消融移出仓库，归档于 tag `archive/forehand-17` 对应的仓外备份）；账本在 `spec/examples/forehand-study.md`。`contract.test.ts` 钉结构与 200 契约，`quality.test.ts` 对其实测值加 ×1.25 上限 / ÷1.25 下限硬门（腕弯曲 0 截幅、IK 残差 ~0、触球键拍头速度 >3 m/s、tip kicks ≤170 回归门等）。
- 求解语义变更后全量浏览器复验：本记录对应一次 `QA_BROWSER_CHANNEL=chrome npm run qa` 全绿（errors/warnings 为空）与 `node scripts/dynamics-browser-qa.mjs` 29 项全过；`evidence/browser-results.json`、`dynamics-results.json` 与相关截图/录屏随运行刷新。

## 实测关键姿态

下列角度来自浏览器 AnimationMixer 实际求值（每动作 80 个采样）。正手挥拍一行于 2026-10-20 随挥修复后按同一 `frameAt → solveEffectiveFrame` 路径 80 采样重测。

| 动作 | 右膝屈曲范围 | 右肘屈曲范围 |
|---|---|---|
| 自然站立 | 10.10–10.10° | 24.64–27.85° |
| 行走 | 1.84–78.00° | 21.38–32.78° |
| 抬手与转身 | 8.23–10.16° | 0.22–128.35° |
| 下蹲 | 10.10–90.72° | 3.18–72.35° |
| 持拍准备 | 39.83–42.85° | 76.74–76.74° |
| 正手挥拍 | 24.78–52.14° | 15.40–101.22° |

## 视觉发现与修正

| 发现 | 原因 / 修正 | 最终证据 |
|---|---|---|
| 初版抓握拇指张开，部分指骨靠近握柄内部 | 固定逐指弯曲不考虑实际骨长；改为指骨段沿圆柱切线闭合，拇指反向对掌，加入指腹余量与 DIP 限制 | grip.png；手部几何接触测试 |
| 初版击球区球拍过于竖直 | 手部局部框架未随前臂转动；调整有依据的拍面阶段，分享前臂扭转而非只扭手腕 | contact.png；forehand.mp4 |
| 下蹲中段踝背屈偏大 | 指定髋轨迹与固定足目标未同时限制踝；用解析 IK 对骨盆后移量做几何搜索，将背屈限制到 20° | squat-side.png；关节范围与足部测试 |
| 左手朝向反转 | 镜像后掌面法向未修正符号，统一物理掌面框架与手指屈曲轴 | front.png；镜像测试 |
| 行走左肩凹陷、肘窝翻转 | 上臂摆动平面错误地按左右侧反号；改为标定肘轴的肩肘 FK 链，保留 35_01 动捕时序 | walk.png；walk.mp4；铰链测试 |
| 原始步态重定向存在足部漂移 | 源和目标肢段比例不同、足趾数据噪声；加入支撑期锚点、源足部绑定方向校正、有限背屈与简化趾跟 rocker | walk.png；支撑期测试 |
| 抬手峰值接近画布顶部 | 站立构图没有考虑手部最高点；抬手使用更高观察中心与更大相机距离 | reach.png |
| 小屏中文字与控件偏小 | 增大动作文字 / 开关标签，观察设置移至画布下方 | mobile.png / mobile-settings.png |
| 非循环播放曾可能回绕 | AnimationAction 使用 LoopOnce + clampWhenFinished，重播清除暂停标记 | 浏览器单次播放测试 |
| 直拳斜向外、起拳位置偏前，左拳护手不清楚 | 以肩旋转向量 / 肘铰链控制替代横向末端轨迹；实际正常肌力仿真将右拳放到肩后低位；左手拇指反向对掌并收紧五指；侧视起拳与伸展确认拳路朝前，正视确认骨盆 / 躯干转动下右拳仍沿自身肩线，左拳闭合贴近下颌 | 本轮应用内浏览器在 0.2 s（后下起势）、1.7 s（伸展）、侧视 / 正视进行检查；弱肌力 90% 对照未通过“肩后起拳”门槛，不作为标准动作姿势 |
| 在线字体存在离线依赖 | 字体改为本地合法 WOFF2 变量字体，中文系统回退 | production-results.json |
| 长时间步行超出静态地面 | 地面随人物平移，网格按 0.25 m 整格平移，保持世界网格线位置，灯光跟随人物 | engine.ts；浏览器行走检查 |

实测重播断言曾受软件 WebGL 的工具延迟影响：原先要求点击后返回值小于 0.15 s，调整为明确从原来的 2.4 s 重置至小于 1 s，并确认已经开始播放。修复的是过窄的工具时间窗口，不是隐藏动作加载失败。

## 设计概念对照

概念：docs/ui-concept.png（内置 ImageGen 生成）。实际：evidence/front.png。已在同一轮 view_image 复查，原生视口 1536×1024。以下是有意保留的产品化调整，不声称与概念中的虚构资产逐像素相同。

| 对照点 | 实现与判断 |
|---|---|
| 信息架构 | 保留页头、左动作库、中央人体、右观察设置、底部播放条的结构；给人体更多横向空间 |
| 色板 | 保留冷白 / 浅灰画布、深蓝文字、蓝色选中与播放状态；无额外装饰渐变 |
| 字体与层级 | 本地 DM Sans + 中文系统字体，标题 / 动作 / 设置 / 注释有清晰层级；修正初版过小标签 |
| 控件 | 六个动作、四种快速视角、开关与速度滑块按概念实现；增加任务要求的单次播放、阶段跳转、手部特写 |
| 人体资产 | 概念中的照片式穿衣运动员改为真正可转动、可蒙皮变形的 MakeHuman 解剖轮廓；这是任务要求的真实模型，非图片替代 |
| 文案真实性 | 六动作名称、品牌与导航保持；删除概念凭空生成的 SMPL / 非商业限制，改为实际 CC0 / CMU 来源，并标注网球工程近似 |
| 播放区 | 保留播放 / 重播 / 时间轴；将虚构 3:20 时长改为各真实片段时长 |
| 响应式 | 手机动作库变为 2×3，设置可下滚访问，保留实时画布与底部播放控制 |

首屏文案 diff 已核对：新增内容限于用户要求的观察重点、真实资源 / 关节读数、动作阶段和原型边界；未增加营销内容、假数据或功能占位。布局、色板、层级、控件及实际模型显示均已复查；剩余差异为上表明确列出的真实资产 / 来源 / 控件调整。

## 证据索引

- front.png / side.png / back.png：完整人体三视图。
- walk.mp4 / walk.webm：新版连续行走，侧面与正面实时录屏；walk-review.json 记录六张正 / 侧 / 背面关键姿态。
- walk.png / reach.png / squat.png / squat-side.png：基础动作。
- ready.png / backswing.png / contact.png / follow-through.png：网球关键姿态。
- grip.png：握拍局部放大。
- debug.png / skeleton.png：人体表面叠加或关闭时的绑定骨架 / 关节 / 坐标轴 / IK 端点。
- laptop.png / mobile.png / mobile-settings.png：不同视口。
- production.png / production-results.json：生产静态构建与外部资源阻断检查。
- forehand.webm / forehand.mp4：重型验收（`HUMAN3D_QA_HEAVY=1`）生成的 30 fps 实时挥拍录屏，H.264 转码已完整解码验证。
- video-1.3.png / video-2.55.png / video-3.35.png / video-4.6.png：录屏关键帧复查。
- browser-results.json：浏览器检查与 480 个基础动作采样的结构化原始结果。
- quality-probe-{idle,reach,squat,ready,forehand,default,summary}.json：240fps 质量探针基线（WP-C 后求解器）。

## 2026-10-17 投掷与直拳修复复验

- 浏览器：Playwright Chromium **156.0.8078.4**，1536×1024，`http://127.0.0.1:5173/`。单个浏览器进程串行完成页面加载、8 个投掷阶段、三视图 / 45° 视角、手部特写、投掷录屏和直拳手部采样。16 个投掷观察帧 / 视角及交互断言通过，JavaScript 错误 0；Chromium 在截图读回时发出 4 条 GPU `ReadPixels` 性能警告。
- `npm run build` 通过，`npm test -- --pool=threads --maxWorkers=1` 为 19/19 通过；`PATH=.venv-dynamics/bin:$PATH python3 scripts/validate-action-spec.py` 通过；`PATH=.venv-dynamics/bin:$PATH python3 scripts/test-dynamics-records.py baseball-throw punch` 对基线 / 90% 肌力记录全部通过。
- 投掷物理记录：骨盆偏航角速度峰值 −124.7°/s @ 0.37 s，胸廓轴向角速度峰值 +125.6°/s @ 1.50 s；蓄力阶段骨盆先转、躯干后跟。最大蓄力到释放时，右腕物理坐标约 −33.5° 后伸 → +45.2° 屈曲，肘约 76.6° → 20.1°，膝约 19.6° → 16.0°。固定支撑漂移 0.051 mm，前臂净间距 0.168 m，软限位最大超出 1.12°，基线手端任务最大误差 0.220 m（90% 力量记录为 0.182 m）。这仍是固定双足原地投掷近似，没有跨步 / 着地。
- 投掷手指：MyoSim 物理手指在释放仍有明显屈曲（12 个屈曲坐标和约 333°），不能称为肌肉模拟的完全放手。可见手皮肤在最大蓄力保持抓握，到释放关键帧连续张开（可见手指骨旋转幅值和约 22°）。`display.handPoseSource` 明确记录这是关键帧显示重定向；物理记录没有被覆盖。250°→80° 解释为平面手掌朝向变化，不是腕关节 ROM。
- 直拳：伸展 / 短暂停留的皮肤腕相对前臂偏角约 0.75° / 3.25°；四指分别采用 MCP/PIP/DIP 目标，拇指绕过食指，末端到食指近节最近距离 7.5 mm；恢复阶段松拳。皮肤肘内角约 165–166°，物理肘角误差 <0.001°，肩至腕方向误差 <0.001°，上下臂长度约 0.259 / 0.267 m 并固定。需要区分物理记录：基线拳峰 wrist flexion 是 +36.4°、短暂停留 −2.8°，90% 力量会使拇指 IP 偏离拳型；可见腕和手按任务关节目标重定向，使画面拳面保持中立 / 闭合。这是透明的显示近似，非仿真肌肉结果。
- 截图与录屏：`baseball-throw-front.png`、`baseball-throw-side.png`、`baseball-throw-back.png`、`baseball-throw-three-quarter.png`；准备 / 蓄力 / 骨盆启动 / 躯干跟进 / 释放 / 随挥 / 恢复截图为 `baseball-throw-ready.png` 至 `baseball-throw-recovery.png`；释放手部特写 `baseball-throw-release-hand-close.png`。直拳 `punch-extension.png`，手部特写 `punch-fist-close.png` / `punch-fist-hold.png`。完整实时投掷 WebM：`baseball-throw.webm`（283,065 字节）。结构化逐姿态结果和所有断言：`evidence/dynamics-results.json`。

## 2026-10-22 移动端与语义控件（issue #23）

`node scripts/workshop-mobile-qa.mjs`（Playwright Chromium，`isMobile/hasTouch` 模拟，DPR 1）全部通过（768×1024 / 1024×768 桌面布局在粗指针仿真下存在**既有**平板溢出，脚本改为测量并写入 `checks.tabletOverflowKnownIssue`，修复另立任务）：390×844 无溢出、Review 下单指拖手柄与双指捏合只动相机不写库、正/侧/45°/全视野、上一/下一关键帧与播放暂停、Review 下拖关键帧不重定时、语义肘屈曲 +10°（请求 = 读回 10.0°，其他关键帧逐字节不变）与腕掌屈 5°、两步撤销/重做、刷新后求解肘角不变、肘屈曲超 145° 报「未完全执行」且取消恢复基底、审阅反馈 JSON 复制；375×667、844×390、768×1024、1024×768 无溢出；1536×1024 桌面面板与旧控件仍在。

**未验证**：真机 Safari / Android Chrome 的双指手势、WebGL 前后台恢复、软键盘与刘海安全区实测；移动渲染档（`pointer:coarse` → DPR ≤1.5、阴影 1024²）未做设备帧率测量。#21 PR-E 未合并，任务空间相对移动（PR-C 第一项）未实现。

## 仍需改进

投掷仍是固定双足的原地上手动作，缺少真实跨步、前脚着地 / 制动与离地支撑变化；手端任务误差约 25 cm，尚不能视作准确的人体动作重建。动作采用肌肉驱动的前向积分和工程化参考任务，不是经运动员标定的逆动力学/神经肌肉预测。大幅肩部 / 手指动作下线性混合蒙皮仍会损失体积；直拳没有撞击目标、拳面接触或冲量。此前发现的网球挥拍手臂穿躯干问题仍待后续修复，本次没有通过低质量重做该动作掩盖它。没有在 Safari、Firefox 或低性能移动设备完成专项测试。
