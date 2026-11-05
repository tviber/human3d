# 资源与许可证

| 资源 | 作者 / 来源 | 许可证 / 条件 | 本地用途 |
|---|---|---|---|
| base.obj、default.mhskel、default_weights.mhw、三份成年男性形态 target | MakeHuman Team；Data Collection AB / Joel Palmius / Jonas Hauquier 等；见源文件头 | CC0；[官方说明](https://static.makehumancommunity.org/about/license.html)，原许可副本 assets/source/MAKEHUMAN-LICENSE.md | 导出 public/models/human.glb 与 rig.json |
| Z-Anatomy 肌肉/骨骼/皮肤几何缓存、派生肌肉 ID 遮罩与清单 | Gauthier Kervyn / Z-Anatomy；原始 BodyParts3D © DBCLS；固定网格转换：SeemaBansal1，见 [数据来源记录](../assets/anatomy/README.md) | **CC BY-SA 4.0**；[上游许可与署名](../assets/anatomy/z-anatomy/UPSTREAM-LICENSE.txt)；保留数据署名及同许可分发；不使用其内耳/肾脏器官层 | 网格推导的肌肉表面选择；1003 个离线结构中，462 个肌肉组件全部保留身份。源码原有 MIT 许可独立 |
| 35_01.bvh walk（当前）；136_20.bvh（旧版参考） | CMU Graphics Lab，NSF EIA-0196217；Bruce Hahne 的 BVH 转换；[镜像说明](https://github.com/una-dinosauria/cmu-mocap) | 可复制、修改并用于产品；不可单独销售数据（包括转换形式）；见原说明 assets/source/READMEFIRST.txt 及[原站](https://mocap.cs.cmu.edu/) | 单个步态周期重定向为 walk.json，非整个数据集转售 |
| 124_01.bvh Baseball Pitch；02_05.bvh punch/strike | CMU Graphics Lab；BVH 转换说明：[una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap)；[CMU 原站](https://mocap.cs.cmu.edu/) | CMU 数据库允许用于产品，但禁止单独转售数据（包括转换形式）；尊重原数据库致谢要求 | 124_01 用于无球投掷身体参考；02_05 用于通用 punch/strike 参考；手指关键帧是项目工程近似 |
| Three.js | Three.js authors | MIT | 渲染、glTF、动画与 OrbitControls |
| React / React DOM | Meta and contributors | MIT | UI |
| Vite | Vite contributors | MIT | 开发 / 打包 |
| Lucide | Lucide contributors | ISC | UI 图标 |
| DM Sans | Google Fonts respective authors | SIL Open Font License 1.1 | 本地字体；中文使用系统字体回退；完整许可见 public/fonts/OFL.txt |
| MyoSim `myo-sim==0.2.3` 完整肌骨 XML 与参数 | MyoHub；[官方仓库](https://github.com/MyoHub/myo_sim) | Apache-2.0；原许可副本 `assets/source/dynamics/MYO-SIM-LICENSE.txt` | 保留 416 执行器、424 肌腱路径、51 关节约束 / 耦合、104 刚体惯性；网页使用派生降阶模型 |
| MuJoCo `3.6.0` | Google DeepMind；[官方文档](https://mujoco.readthedocs.io/) | Apache-2.0；未复制其程序代码 | Python 仿真与记录导出；浏览器仅读取状态 |
| 棒球投球、直拳生物力学论文 | [棒球投球综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC9950989/)、[直拳测力研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC9798280/)、[精英拳手直拳研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC13285485/) | 只链接并摘述；没有复制图表或全文 | 用于动作时序与关节姿态检查，不是网页动作捕捉输入 |
| 球拍、关键姿态、应用源码 | 本项目 | MIT，见根目录 LICENSE | 原创程序化球拍与动作逻辑 |
| docs/ui-concept.png | 使用内置 ImageGen 生成 | 设计参考，不是模型或动画数据 | 不作为应用中的静态界面使用 |

本项目仅处理 MakeHuman 图形数据，不引用它的 AGPL 软件实现。Blender 是本地资产处理工具，不打包其可执行程序或代码。Elliott、CDC、OpenSim、棒球投球与拳击生物力学论文仅链接并作为设计参考，未转载论文图表或全文。完整 MyoSim 模型的派生 / 分发遵循随附 Apache-2.0 许可。

CMU 致谢：The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.
