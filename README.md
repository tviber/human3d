# KINESIS · 人体运动实验室

一个可在浏览器中旋转、缩放和逐帧观察的连续蒙皮人体 Web 应用。人体网格来自 MakeHuman CC0 资源，保留 163 根骨骼、双手五指和原始蒙皮权重。

除原有运动学预设外，项目包含 MyoSim / MuJoCo 肌肉驱动的直拳和无球原地棒球式投掷。完整力学来源保留 416 个执行器、424 条肌腱路径、51 个关节约束 / 耦合和 104 个刚体惯性参数；网页将 44 个活动关节自由度的肌骨记录重映射到连续外部人体表面。

## 启动网页

需要 Node.js 22.12 或更高版本。

```sh
npm ci
npm run dev
```

打开终端显示的地址，默认 <http://127.0.0.1:5173/>。人体、动作和字体均本地打包；浏览器不需要模型服务或 API。资料面板链接到外部研究来源。

```sh
npm test
npm run build
npm run preview
```

## 肌肉驱动动作

动力学动作定义放在 `assets/motions/*.json` 的 `dynamics-motion` 信封（肌肉参数在 `dynamics.action`，记录 URL 在 `dynamics.records`）。同一降阶模型支持的新增动作，除在 `packages/motion-core/src/motion-files.ts` 加一行静态导入外无需改 TypeScript：

```sh
python3 -m venv .venv-dynamics
source .venv-dynamics/bin/activate
pip install -r scripts/requirements-dynamics.txt
npm run dynamics:new -- --id medicine-ball-push --title "药球推送"
# 编辑 assets/motions/medicine-ball-push.json 中 dynamics.action 的阶段、关节角和任务点
npm run dynamics:build -- medicine-ball-push
npm run dynamics:test -- medicine-ball-push
npm run build
```

动作库信封统一由静态注册表加载，网页显示动作名称、说明、阶段标记和物体负载提示。`dynamics:build` 会验证模型参数、计算有界肌肉激励、用 MuJoCo 积分肌骨状态、导出 416 通道记录，并生成 90% 右臂肌力的重新求解对照。模板适用范围、坐标单位和模型限制见 [docs/ACTION-TEMPLATE.md](docs/ACTION-TEMPLATE.md) 与 [docs/DYNAMICS.md](docs/DYNAMICS.md)。

## 已实现

- 自然站立与呼吸、CMU 普通行走、抬手转身、下蹲、持拍准备和正手挥拍。
- 肌肉驱动直拳空击（含腕、拇指及四指关节）与原地棒球式上手投掷；投掷不显示球体。
- Orbit 摄像机、正面 / 侧面 / 背面 / 45° 视角、时间轴拖动、阶段跳转、暂停 / 播放 / 重播与 0.25–2× 倍速。
- 人体表面、绑定骨骼、坐标轴、IK 端点、代表性肌腱路径、支持力和肌肉功率显示。
- 网球拍手柄与持拍手手指刚性握持（左 / 右手均可，工作台按握拍侧参数化）；正常步态肩肘协调和支撑期足部锚定。
- 动作工作台（页头「动作工作台」或 `/workshop.html`）：动作库支持自定义命名的新建 / 复制 / 删除动作并自动保存到浏览器；拖动 IK 末端手柄摆关键姿态，关键帧携带支撑脚锁定 / 握拍 / 触球约束，Hermite 补间生成连续动作；另有实验性约束轨迹生成（Worker 搜索关键帧时序与通道相位，硬门禁后同视角 A/B 预览，用户选择取消或保留），握拍侧左右手切换与整档「镜像动作」副本、洋葱皮相邻姿态对照、固定相机静帧 / 关键帧拼图渲染导出，含关节限位与重心投影检查、参考视频对齐和 JSON 导入导出。实验生成器只优化数值代理，不证明动作自然；设计依据和边界见 [docs/WORKSHOP.md](docs/WORKSHOP.md)。
- 动作服务（`npm run service`，仅 loopback `127.0.0.1:8788`）：v1 HTTP 协议提供能力目录、rig manifest（VRM 语义映射 + 内容哈希）和 `POST /v1/motions` 同步求解，返回规范姿态包（逐骨局部旋转 + root 平移、事件、质量检查）。内置动作以 WorkshopDoc 数据文件（`assets/motions/*.json`）驱动，工作台与服务共用同一求解管线；也可提交自定义 WorkshopDoc。工作台可导出同管线的 .pose.json（与 POST 响应对等）与派生 GLB（或 `npm run package-to-glb`）；服务端渲染/VRMA/MCP 未实现。请求经 Host/Origin/Content-Type 守卫并按 JSON Schema（Ajv 2020 严格模式）校验；返回前经语义校验，违反运动学阈值的动作以 422 `motion_rejected` 拒绝，阈值与已知限制见 [docs/validation.md](docs/validation.md)。契约见 [spec/openapi.yaml](spec/openapi.yaml)，方案见 [docs/ANIMATION-PROTOCOL-PLAN.md](docs/ANIMATION-PROTOCOL-PLAN.md)。

键盘：空格播放 / 暂停，1–8 切换动作，R 重播。拖动画布旋转，滚轮缩放，右键拖动平移。

## 力学动作边界

投掷阶段参考 CMU subject 124 的 124_01 Baseball Pitch 和公开的投球动力链研究；由于原捕捉包含步幅，而本模型固定双足，应用中的骨盆相对姿态是由这些阶段顺序编排的工程任务关键帧。动作没有球体、释放事件或飞行。拳击关节参考来自通用 CMU punch/strike 片段，握拳各关节角度按 MyoSim 原模型范围参数化，并在可视骨架上检查拇指到食指近节的几何接近；CMU 数据不含手指捕捉，动作也没有冲击。

肌肉控制输出是 MuJoCo 中积分得到的物理状态，动作面板重放的是记录而非实时模拟。连续人体蒙皮表面仅由刚体骨段重定向用于观看，并未参与肌肉力学。真实运动员会有个体差异；模型没有肌电、力台、影像或个体参数标定。研究来源、许可证和限制见 [docs/RESEARCH.md](docs/RESEARCH.md)、[docs/DYNAMICS.md](docs/DYNAMICS.md)、[docs/LICENSES.md](docs/LICENSES.md)。

## 测试与证据

```sh
npm test                  # 人体网格、IK、骨架、手部抓握与动画回归
npm run spec:check        # 契约：Ajv 严格编译、OpenAPI 与服务一致、golden 样例
npm run dynamics:validate # 需要先激活 .venv-dynamics
npm run dynamics:test     # 校验导出的物理记录与参数哈希
npm run qa                # Playwright 浏览器交互与截图；重型模式另录视频并运行动作优化
npm run qa:dynamics       # 肌骨投掷阶段截图、握拳特写与实时投掷录屏
```

浏览器验收使用 Playwright；独立 Browser 技能未提供，应用另在本机 WebView 做了交互检查。截图和结构化结果保存在 `evidence/`；真实 WebGL 录屏及动作优化验收使用 `HUMAN3D_QA_HEAVY=1 npm run qa` 显式启用。验收只表明指定视口 / 模型记录符合数值和视觉检查，不代表临床或运动员验证。

## 项目结构

npm workspaces 三个包，依赖方向单向（web / server → motion-core）；设计记录、边界规则与后续阶段见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

| 包 | 职责 |
|---|---|
| `packages/motion-core`（`@human3d/motion-core`） | 纯运动域：`document.ts`（WorkshopDoc 采样器）、`solver.ts`（FK/IK 求解与合理性检查）、`kinematics.ts` / `rig.ts` / `racket.ts`（骨架、解析 IK、握拍）、`protocol.ts` / `pose-package.ts` / `package-inspect.ts`（姿态包协议、校验与派生）、`motion-file(s).ts`（信封注册表）、`validate.ts`（交付包语义校验）、`quality-probe.ts` / `generate.ts` / `random-document.ts`（质量度量、实验优化器与随机文档生成器）、`package-export.ts` / `glb-export.ts`（导出，后者走 `@human3d/motion-core/glb` 子路径）。无 DOM / node 依赖，three 只作数学库 |
| `apps/web`（`@human3d/web`） | 两个页面入口（`index.html` 实验室 / `workshop.html` 工作台）：`src/lab/`（实验室引擎与动力学回放渲染）、`src/playback/`（统一播放源：clip / 文档 / 动力学记录 / 姿态包共用一个 playhead）、`src/workshop/`（工作台场景、动作库、撤销书与 React 面板）。Vite 的 `publicDir` 仍指向仓库 `public/`，构建产物仍在仓库 `dist/` |
| `apps/server`（`@human3d/server`） | `serve.ts`（loopback HTTP 传输，`node:http` 零新增依赖）、`service.ts`（目录 / 求解编排 / 幂等）、`contract.ts`（Ajv 严格编译 `spec/`）、`rig-manifest.ts`（node:crypto 身份哈希） |

| 资产 / 工具路径 | 职责 |
|---|---|
| `assets/motions/` | 动作信封注册表（含 `dynamics-motion` 肌肉动作参数）与 JSON Schema；由 motion-core 的 `motion-files.ts` 静态导入，Python 工具链也写这里 |
| `assets/source/dynamics/` | 完整 MyoSim XML、416 执行器 / 424 路径 / 惯性清单与许可 |
| `assets/dynamics/` | 可复现肌肉激励、参考轨迹与正向仿真源记录 |
| `public/dynamics/` | 网页用模型、解剖资源、刚体状态和肌腱记录 |
| `scripts/build-dynamics.py` | 从 MyoSim 生成固定约束降阶模型 |
| `scripts/prepare-muscle-actions.py` | 参数任务目标、肌肉激励求解和 MuJoCo 正向积分 |
| `scripts/export-simulation.py` | 力、激活、支撑反力、功率和路径浏览器记录 |
| `scripts/test-dynamics-records.py` | 结构、哈希、限位、支撑、激活和跟踪包络检查 |

## 已知问题

- 当前模型固定双足、左侧护架、肩胛和腰椎细分；右腕 / 拇指 / 四指已进入可动模型。新接触结构、换步 / 滑步、左臂任务、物体释放或模型拓扑仍需要修改模型和求解代码。
- 肩部大幅扭转可能有线性蒙皮体积损失；没有肌肉组织变形、肌腱弹性和碰撞软组织。
- 活动范围和报告的角度来自工程 / 模型坐标，不能代替 ISB 临床角度或个体评估。
- 针对 WebGL 和移动 Safari / Firefox 的完整验收仍需设备覆盖。
