# 技术选择与运动依据

核查日期：2026-10-17。原有六个预设动作是浏览器运动学动画；直拳与无球原地棒球式投掷使用独立的 MyoSim / MuJoCo 肌肉驱动降阶仿真。项目不是医疗模型、个体数字孪生或专业运动测量系统。

## 采用方案

| 选择 | 依据 / 官方链接 | 采用理由与边界 |
|---|---|---|
| MakeHuman hm08 连续人体、默认骨架、原始权重 | [资源许可](https://static.makehumancommunity.org/about/license.html)、[源资产](https://github.com/makehumancommunity/makehuman/tree/master/makehuman/data)、[2020 许可澄清](https://static.makehumancommunity.org/oldsite/faq/what_changed_regarding_the_license_in_2020.html) | 核心资产 CC0。具备人体拓扑、肌肉外轮廓和完整手指，不依靠拼接几何玩偶。使用官方成年男性形态与 0.65 最大肌肉 / 0.35 平均肌肉混合；非扫描特定真人。 |
| Three.js SkinnedMesh + glTF | [SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html)、[glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) | 保留原始骨架层级与蒙皮权重，骨骼位移由局部刚性变换组成。单一人体实例，动作独立。 |
| AnimationClip / AnimationMixer / Quaternion | [动画系统](https://threejs.org/manual/pages/animation-system.html)、[AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html)、[Quaternion](https://threejs.org/docs/pages/Quaternion.html) | 结构化关键姿态离线采样为动画片段，四元数插值，动作切换交叉淡入，支持任意时间求值、暂停和倍速。 |
| 双骨 IK，带弯曲提示方向 | [Unity 官方 Two Bone IK](https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.2/manual/constraints/TwoBoneIKConstraint.html)、[Three.js CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html) | 肩–肘–腕、髋–膝–踝都是两段固定长度链，解析解足够，容易验证。没有引入迭代多骨 CCD；数学求解器不复制 Unity 实现代码。 |
| Blender Catmull-Clark 网格预处理 | [Subdivision Surface](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/subdivision_surface.html)、[Armature](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/armature.html) | 一次细分，同时插值原始权重。不自动重新绑定。运行时用标准线性混合蒙皮，不具备 Blender Preserve Volume 的双四元数效果。 |
| CMU 实测步态 | [数据库及授权](https://mocap.cs.cmu.edu/)、[BVH 转换说明](https://github.com/una-dinosauria/cmu-mocap) | 比较普通步行片段后采用 35_01（原标签 walk）的 1.28–2.40 s 周期。按目标肢段长度重定向，保留根运动、肩部方向及肘屈曲时序；手指为预设放松姿态，非实测。 |

## 资产转换与坐标

`scripts/build-human.py` 只读取 CC0 数据文件，不复用 MakeHuman 的 AGPL 程序代码。目标形态作用于包含关节定位辅助顶点的完整源网格，随后通过官方关节顶点集的均值计算关节中心。显示网格只导出 body 组，删除非人体辅助面。身高统一为 1.78 m。Blender 仅做一次 Catmull-Clark 细分。输出 163 根骨骼、53514 个几何顶点与原始权重插值结果。随后 `scripts/build-anatomy-surface.py` 恢复 hm08 原始面角 UV（细分处双线性插值），仅在 UV 接缝复制顶点，得到 55784 个渲染顶点；三角面顺序及每个角的位置、法线、骨骼索引与权重保持一致。自定义属性 `_SOURCE_VERTEX` 保留接缝两侧的原顶点身份，姿态诊断据此识别相邻面，避免将 UV 接缝误报为自交。`rig.json.vertices` 保留原几何顶点数。每顶点保留最高四个影响并归一化；这是一项实时渲染近似，细节见生成的 rig.json。

工程坐标为右手系：X 左右，Y 向上，Z 身体前方。关节节点在绑定态具有单位世界旋转；局部平移与 inverseBindMatrices 保存源关节中心。不是 [ISB 临床关节坐标系](https://www.isbweb.org/standards/wrist.html)。界面的膝 / 肘角是骨段几何屈曲角，不能用于临床测量。

骨架包括骨盆、五段躯干、三段颈部、头、锁骨与肩带、上下臂扭转分段、腕、掌骨与各指三段，双下肢及足趾。调试蓝线是蒙皮绑定骨架，并非骨骼表面的解剖几何。

实验室与工作台默认使用统一暖灰白哑光表面。肌肉表面分区使用 Z-Anatomy 的实际解剖网格，替代早期 15 对手绘轮廓：462 个肌肉源组件按肌头/分部合并成 410 个可追溯条目；源清单包含未投影到皮肤的深层或未映射结构，不将其强行涂到表面。当前生成的表面分区数和面积以 `public/models/anatomy-regions.json` 的 `coverage` 为准。选择与许可依据、数据固定版本、来源哈希、重建方法见 [肌肉分区数据说明](../assets/anatomy/README.md)。

分界来自解剖网格，跨模型对应仍是近似，不能视为 MakeHuman 人体的解剖标定；不显示真实肌肉激活或独立肌肉体积。鼠标悬停预览浅橙红高亮，点击或触摸轻点固定选择，空白处轻点或关闭按钮清除；旋转拖动、多指、取消手势与编辑手柄不触发选择。选择不写动作、撤销或持久化；静帧与拼图导出抑制交互高亮并恢复原选择。

资产构建：`python3 scripts/build-anatomy-surface.py`（依赖 `scripts/requirements-anatomy.txt`，可直接处理当前 GLB）；`--check` 校验 GLB、遮罩和区域清单可重现。`scripts/build-human.py` 在 Blender 基础资产生成后自动执行该步骤。交互验收：启动 dev server 后运行 `sh scripts/check-process-limit.sh && QA_BROWSER_CHANNEL=chrome node scripts/anatomy-browser-qa.mjs --out-dir /tmp/human3d-anatomy-qa`；该脚本验证真实指针与模拟触摸，不代表真机结果。

## 关节活动范围

参考 [CDC 正常关节活动范围研究](https://archive.cdc.gov/www_cdc_gov/ncbddd/jointrom/index.html)。该研究包含不同年龄 / 性别的统计值，**人群均值不是个人安全阈值**。代码的数值是保守工程限制；旋转框架亦不等价于临床测量框架。

| 控制 | 工程范围（°） | 实现 |
|---|---|---|
| 肘屈曲 | 0–145 | 双骨 IK 限制最小可达距离，保持固定骨长 |
| 膝屈曲 | 0–135 | 双骨 IK 同上；下蹲保持足部目标 |
| 腕弯曲 | ±60 | 手方向相对前臂的弯曲锥限制 |
| 肩抬升 | 0–165 | 预设范围审核；抬手时锁骨与肩带分担转动 |
| 髋屈曲 / 后伸 | −20–120 | 预设范围审核，非额外动力学约束 |
| 踝跖屈 / 背屈 | −40–20 | 解析几何搜索修正骨盆后移以限制下蹲背屈；步态使用趾 / 跟接地近似 |
| 指 MCP / PIP / DIP | 0–85 / 0–100 / 0–75 | 工程抓握设定，并非从 CDC 数据推导 |

参考 [OpenSim Gait2392](https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53086215/Gait%2B2392%2Band%2B2354%2BModels) 理解髋多轴、膝主要屈伸和足踝分工；本项目没有导入它的骨骼几何或参数。连续人体表面肌肉轮廓来自 MakeHuman 网格；肌肉激励、肌腱路线、刚体质量 / 惯性和关节约束来自独立 MyoSim 力学模型，二者不是同一个模型，也没有肌肉体积随激活变形。

## 六个运动学动作

- **站立与呼吸**：有时间组织的微小胸椎 / 肩部姿态变化；呼吸是工程视觉近似，未模拟肺容积或软组织扩张。
- **行走**：真实 CMU 步态重定向，保留根位移，摄像机跟随平移而保留 Orbit 角度与缩放；地面保持世界坐标，避免把根运动删除后伪装成接地行走。支撑期采用世界坐标锚点和 100 ms 权重过渡，足趾噪声通过有限背屈与简单趾 / 跟 rocker 约束处理；足底接触点是工程近似。周期末 100 ms 四元数接缝混合在足部 IK 前完成；可达性不足时按肢段几何降低骨盆，避免拉长腿或支撑脚滑移。离地与接缝仍是工程近似。
- **抬手与转身**：躯干、颈部、锁骨、肩带和上肢 IK 协调；没有把肩关节当独立摆杆。
- **下蹲**：骨盆后移、降低，躯干前倾，脚掌固定；髋膝踝由同一个目标几何求解，限制膝反弯和骨长变化。
- **持拍准备**：预设右手抓握与稳定支撑。是刚性运动学连接，不是摩擦接触求解。
- **正手挥拍**：参考 [Elliott, 2006, Biomechanics and tennis](https://pmc.ncbi.nlm.nih.gov/articles/PMC2577481/) 对动力链与躯干 / 上肢时序的讨论，组织准备、引拍、加速、击球区、随挥和恢复。骨盆开始回转早于胸廓，肩肘腕随躯干运动；没有可信且可直接再分发的网球动捕数据被采用，故明确标注为研究参考关键姿态。手臂轨迹、各时点、幅度、抓握角度均为工程近似，不是专业正手测量结果。

关键姿态之间使用非均匀三次 Hermite 时间曲线；不会让每个关节按互不相关的正弦函数摆动。原有动作以 `assets/motions/*.json` 的 motion-file 信封保存（信封即当前真源；求解回归基线在 `spec/solver-baseline/`），walk 则是 `clip-motion` 信封指向兼容骨架的 AnimationClip。肌肉驱动动作走单独的参数 JSON 流程，见 [ACTION-TEMPLATE.md](ACTION-TEMPLATE.md)。

## 肌骨动力链与投掷 / 直拳

完整 MyoSim 来源固定为 `myo-sim==0.2.3`，包括 416 个肌肉执行器、424 条肌腱路径、51 个关节耦合 / 约束和 104 个刚体惯性。网页降阶模型为 44 个活动关节自由度加 6 个浮动根速度自由度，包含双侧肩 / 肘、躯干、双侧髋膝踝，以及右腕、拇指和四指；双足固定支撑。完整来源保存在 `assets/source/dynamics/`。细节和边界见 [DYNAMICS.md](DYNAMICS.md)。

投球参考[棒球投球临床动作分期](https://pmc.ncbi.nlm.nih.gov/articles/PMC9950989/)对 windup、stride、cocking、acceleration、release 与 follow-through 的定义；[投球动力链综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC3445126/)总结了骨盆旋转峰值早于上躯干旋转峰值约 18–22% 投球周期，以及前腿制动、躯干和上肢的阶段关系。这里的[六个侧视阶段图（论文 Figure 1）](https://cdn.ncbi.nlm.nih.gov/pmc/blobs/cfb7/9950989/d79e56b6bd0a/10.1177_19417381221078537-fig1.jpg)可直接查看多帧参考。

当前动作选择 CMU Subject 124 的 `124_01 Baseball Pitch` 检查事件顺序，但没有把其跨步动捕直接映射到固定足模型。骨盆相对任务点和幅值来自该研究时序的工程近似，不是运动员测量值。动作不包含球、球体负载、释放或飞行；双脚不离地，不能重现前腿着地制动。

直拳沿用 CMU `02_05 punch/strike` 通用参考，不将它称为专业拳手示范。前手与后手直拳动力链可不同，参考[直拳测力研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC9798280/)和[精英拳手直拳研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC13285485/)。拇指 MCP / IP 的模型坐标正负方向由实际模型限位和网格关节变形确认；负角度表示当前模型中的闭合方向，不外推为通用人体 ROM。四指分别在 MCP、PIP、DIP 弯曲，拇指横过食指近节；测试使用网格骨段之间的几何距离，不模拟软组织接触、冲击或个体手型。

肌肉控制输出由 MuJoCo 积分得到，弱肌力对照重新求解肌肉招募；屏幕只重映射刚体状态到 MakeHuman 连续网格。该模型不是 EMG 驱动，不预测真实拳击冲击、球速或肌肉外形变化。

## 握拍

球拍遵循拍框、弦床、双叉拍喉、拍杆、八边形握柄结构。握柄直径约 32–36 mm，球拍总长约 0.69 m，均是视觉设计尺寸。手指使用官方手部骨架。各指骨段沿握柄圆柱加指腹余量的切线闭合，拇指使用相反环绕方向对掌；指节间弯曲限制为 PIP 100°、DIP 75°。指腹余量 5–6 mm 是视觉工程近似。握柄坐标由掌指骨的局部框架确定，并固定挂载到 wrist_R，整个运动链由肩肘 IK 与胸廓 / 骨盆带动。刚性接触误差可以精确计算，手指与握柄表面包裹仍需视觉审查；没有指腹变形与碰撞。

## 研究后未采用

- [Mixamo 官方 FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)：动作成熟，但需要账户下载，且源文件再分发边界不适合作为本原型的完全离线可复现资产来源。
- [Khronos Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)：适合验证格式，现成示例人体在完整手指 / 解剖轮廓方面不如 MakeHuman。
- [Rigify](https://docs.blender.org/manual/en/5.2/addons/rigify/index.html)：适合 Blender 创作；本项目已具备完整绑定和权重，无需重新生成控制 rig，避免导出约束烘焙复杂度。
- OpenSim：研究级动力学平台，超出第一版轻量交互与可视化目标；保留后续对接空间。

## 左手与行走上肢修正（2026-10-16）

左右手的掌面法向是物理方向，镜像叉积需校正符号；手指屈曲轴具有轴向向量的镜像奇偶性。统一 hand-frame.ts 供掌面控制、放松手指和握柄使用，并验证站立两掌朝内、指尖对称。

普通行走采用“肩关节带动上臂，肘屈伸带动前臂”的 FK 层级。保留 CMU 的肩部方向与肘屈曲采样；从绑定态两骨段标定肘轴，以胸廓外侧轴约束摆臂平面，前臂由上臂旋转与单轴肘屈曲复合得到，不再独立瞄准两骨段。两侧向前屈肘的轴方向相同，不能照搬左右掌面符号。此前左侧法向反号导致了 180° 上臂翻转，现已修正并加入真实片段回归测试。

[Hejrati 等，2016](https://pubmed.ncbi.nlm.nih.gov/27367784/) 的 30 名参与者研究指出正常摆臂轨迹及肩肘相位受到速度、坡度等条件影响；[Arm swing 的肘部研究，2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10277704/) 也分别测量肩、肘活动。本项目据此保留捕捉数据中的协调时序，未把两个关节设为独立正弦摆杆。胸廓参考肘轴、腕中立姿态和足部锁定都是重定向工程近似，并不声称精确重建原表演者的关节轴。
