# 五个运动数据集能否支撑 human3d 的正手与脚接触

核查日期：2026-10-21。范围只到「能不能当参照」为止。没有改 `packages/motion-core`、协议、服务或界面，也没有把样本接进运行时。Issue [#17](https://github.com/tinyviber/human3d/issues/17) 和 [#2](https://github.com/tinyviber/human3d/issues/2) 由其他分支处理，本报告不实现它们。

## 结论

这五个数据集里，没有一个现在就能给 human3d 的 17 个正手预设提供可用的世界坐标下蹲深度或脚接触参照。这里的否定只针对 #17 的深度、髋下降和脚接触真值。对 human3d 的其他工作，SportsPose 和 AthletePose3D 仍有价值（见「两个问题分开看」），不应因为对 #17 是 E 就排除。

已经用真实文件核对过的部分：

- **Tennis Serve Dataset** 的 3 条发球是单目模型抬出来的 17 点序列。骨长在 1.4–1.7 秒的片段里中位变异系数 0.13–0.18；骨盆的水平坐标被钉在原点；每一帧较低的那只踝被放在高度 0。头到较低踝大约 1.13–1.17，而元数据里的选手身高是 1.78–1.96 m。它测的是抬升模型的不稳定，不是动捕真值，也不是正手。
- **Tennis Player Actions** 的四份 COCO JSON 是后方手机画面上的 18 点二维标注，每份 500 张图。JSON 里没有帧号或时间戳，所以时间顺序没有被验证。按文件名排序后，正手有 67 对相邻样本的关节位移超过 80 px；这是标签顺序上的跳变计数，不是运动事件。没有地面、没有米、没有深度，像素髋高不能换算成下蹲深度。
- **侧视/俯视数据集** 的四个 CSV 是落点距离，行数 99+99+20+18=236，和说明里的击球条数一致。没有关节点。
- **AthletePose3D** 只读了 24 KB 的 `cam_param.json`。姿态压缩包最小的 `pose_3d.zip` 是 1.4 GB，`data.zip` 是 35 GB，没有下载。许可限定为非商业科研，不得交给第三方，也不得放进商业产品。
- **SportsPose** 需要用学术邮箱申请。公开页面、论文和加载代码可以读，数据本身没有取。

因此这次没有新建 GitHub issue。能立刻用上的结论是一条边界：#17 的下蹲目标仍然来自项目自己的源视频；上面任何一个外部集都不能替它。把「申请数据」或「下载 1.4 GB」写成待办，在样本还没过骨长和地面检查之前，没有可验收的代码步骤。

## human3d 现在要的参照是什么

求解路径是 `frameAt → solveEffectiveFrame`：骨盆根位移、躯干角、双手双脚的任务空间目标，再加支撑脚接触区间（[solver.md](../../docs/domain/solver.md)、[motion-model.md](../../docs/domain/motion-model.md)）。坐标系是右手系，X 左右、Y 向上、Z 向前，身高 1.78 m（[RESEARCH.md](../../docs/RESEARCH.md)）。肩–肘–腕和髋–膝–踝是定长双骨 IK。膝屈曲的工程范围是 0–135°，踝背屈上限约 20°。接触锁的是踝点目标，不是足底网格。

#17 里已经量过的现象是：17 个正手预设的髋下降只有大约 3.6–13.4 cm，从准备到引拍只有 0.6–2.2 cm；同一批视频的二维髋高比例互相矛盾。要填的是这些源视频上的三维髋下降，外加支撑脚不滑、后踝不顶满限位。

能直接帮助这件事的数据，需要同时具备：世界坐标里的骨盆和双脚、稳定的骨长、已知的米制尺度、以及正手（最好还能对上具体选手）。下面五个数据集按这个标准分类。

| 代号 | 含义 |
|---|---|
| A | 检验当前这种视频姿态估计靠不靠谱 |
| B | 三维动作或关键帧参照 |
| C | 检验运动学：关节角、骨长、时间连续 |
| D | 按选手的网球正手参照 |
| E | 现在不适合用 |

## 两个问题分开看

前面的分类只回答一件事：这个数据能不能给 #17 的 17 个正手预设提供世界坐标下的髋下降、脚接触或深度真值。对这件事，五个数据集都是否定的，所以表里标 E。

这不等于它们对 human3d 没有用。下表单独列另一个问题：这个数据对其他工作有没有价值，比如评估单目姿态的误差、做击球阶段的标注、检验姿态质量检查。表中的用途都是未验证的候选，本次没有取得数据做实验。

| 数据集 | 对 #17 | 对 human3d 其他工作的候选用途（未验证） | 限制 |
|---|---|---|---|
| SportsPose | 否。多相机估计，没有这 17 个人的正手 | 多相机三角化比单目抬升更接近测量，可以用来考单目估计的关节误差和骨长一致性。网球子集可能适用。论文报告的与标记动捕平均差 34.5 mm，可作误差条的起点 | 学术申请，仅学术用途；单位和坐标系要拿到数据后核实 |
| AthletePose3D | 否。没有网球，下蹲和转体只在投掷和跳跃里间接出现 | 120 fps 高速动作的单目模型误差评估。论文报告的 MPJPE（常规训练约 214 mm，微调后约 65 mm）可作为参照范围 | 仅非商业科研，不得交给第三方，不得放进商业产品；最小姿态包 1.4 GB |
| Tennis Player Actions | 否。二维、后方视角、无时间戳 | 动作类别（forehand / backhand / ready / serve）是阶段级标签，可作阶段划分的检验或标注起点。每帧的细分阶段没有单独标注，要另行核对 | 没有米制，像素不能当测量 |
| Tennis Serve Dataset | 否（样本是否定结果） | 姿态质量检查的负面测试样本。三条样本的已知问题（骨长 CV 0.13–0.18、根节点钉在原点、较低踝钉在 0、骨架身高约 1.13–1.17 m 与元数据身高不一致）可检验检查能否抓到 | 全是发球，没有正手 |
| 侧视与俯视 | 否。没有关节点 | 低优先级。落点距离适合球路统计，与人体姿态无关 | 没有关节点；视频的分辨率和帧率未核实 |

SportsPose 和 AthletePose3D 不因为对 #17 是 E 而排除。前者的价值在多相机参照，后者在高速动作的误差评估。两者都没有取得数据，所以上表只是候选。

## 对照表

| 数据集 | 怎么拿到 | 许可 | 公开体量 | 这次实际下载 | 原始视频 | 姿态从哪来 | 对 #17 的分类 |
|---|---|---|---|---|---|---|---|
| [SportsPose](https://christianingwersen.github.io/SportsPose/) | 学术邮箱申请，[下载页](https://christianingwersen.github.io/SportsPose/download.html) 写明免费、不可转让、仅学术 | 自定义学术许可，引用论文才算遵守 | 论文：24 人、约 17.6 万–19.2 万姿态、7 相机、约 150 万帧 | 0。未申请 | 论文写有 7 路同步视频；加载代码按 `videos/` 读 | 多相机 HRNet 三角化，再经图搜索和 6 Hz Butterworth。评估子集相对 Qualisys 平均 34.5 mm | 对 #17：E。取得数据并抽到网球片段后，可再评估 B/C 用途 |
| [AthletePose3D](https://github.com/calvinyeungck/AthletePose3D) | Google Drive，打开即视为接受许可 | 仅非商业科研；不得向第三方提供，不得放进商业产品、影片或游戏 | README：约 130 万帧、16.5 万姿态。Drive 页面：`data.zip` 35 GB，`pose_2d.zip` 29 GB，`pose_3d.zip` 1.4 GB | 只下了 `cam_param.json`（24,206 字节） | 论文写有同步视频；zip 未打开 | 论文：Qualisys 多相机无标记重建。发布包另有 COCO / H3.6M 的 `.npy`。姿态包未解析 | 对 #17：E。其他用途见「两个问题分开看」 |
| [Tennis Player Actions](https://data.mendeley.com/datasets/nv3rpsxhhk/1) DOI [10.17632/nv3rpsxhhk.1](https://doi.org/10.17632/nv3rpsxhhk.1) | Mendeley 直接下载 | CC BY 4.0（snapshot API 的 `licence.short_name`） | 说明：508 MB，2000 张 1280×720 JPEG + 4 个 JSON | 4 个 JSON 共 1,257,000 字节，外加 1 张 `F_001.jpeg`（221,014 字节） | 源是 30 fps 手机视频；发布的是抽帧图像，不是视频文件 | 人工 COCO-Annotator，18 点二维 | A 的反面教材；作为 B/C/D 是 E |
| [Tennis Serve Dataset](https://github.com/jasnwag/tennis_serve_dataset) | Google Drive 直接下载 | 仓库写明 CC BY 4.0 | README：5966 次发球、109 名选手、113 场 2024 美网 | 3 个 `.npy`（18,080 + 17,468 + 20,324 字节）和全部 `metadata.parquet`（108,777 字节）。关键点目录列出 5500 个文件，其余未下 | 来自转播，数据集里没有视频文件 | README：RTMPose 的 COCO-17 二维，再由 MotionBERT 抬到三维，并用 DTW 对齐 | A，而且是否定结果。B/C/D 都是 E |
| [侧视与俯视](https://data.mendeley.com/datasets/75m8vz7jr2/4) DOI [10.17632/75m8vz7jr2.4](https://doi.org/10.17632/75m8vz7jr2.4) | Mendeley 直接下载 | CC BY 4.0（snapshot API） | 说明：2.42 GB，472 段视频 + 4 个 CSV | 4 个 CSV 共 3,493 字节。点开一个侧视文件夹：99 个 mp4，单个约 4.5–6.2 MB，合计约 518 MB，未下载 | 有，侧视和俯视各一套 | 无姿态标注 | E |

关节、坐标和地面：

| 数据集 | 关节 | 坐标、单位、采样 | 相机、地面、脚 | 和正手 / 下蹲 / 转体 / 步法的关系 |
|---|---|---|---|---|
| SportsPose | 论文与公开骨架代码：COCO 17，含踝，无足跟足趾，无手指 | 论文：90 Hz，7 台 1920×1200 硬件同步。单位要等拿到 `.npy` 才能定。加载器把单位换算留给调用方 | 论文：有标定，重投影约 0.8 px；采集体积约 2×2 m。评估用 Qualisys，标记在体表，和 HRNet 的关节中心之间有协议差 | 五个动作含 tennis，但是实验者自由发挥，不是 17 名职业选手的正手库。有跳和挥臂，步法被小体积限制 |
| AthletePose3D | 论文：原始 55 或 86 点；训练发布另有 COCO 与 H3.6M | 论文：跑 120 fps，田赛和花滑 60 fps；世界坐标再变到相机坐标。`cam_param.json` 没有单位字段 | 已读文件：24 个相机，`fs` 12、`rm` 4、`tnf` 8，与论文的花滑 / 跑 / 田赛机位数一致。内参是 3×3，主点落在 1920×1080 量级；外参旋转行列式约 1，平移另存在 `xyz`，幅度约数千，和 Qualisys 常用的毫米一致，但是文件没写单位 | 动作是跑、铅球、铁饼、标枪、六种跳跃。没有网球。下蹲和转体只在投掷和跳跃里间接出现 |
| Tennis Player Actions | 18 点：COCO 身体 17 点加 `neck`。`v` 只有 0/1/2 | 像素。数据论文写源视频 30 fps、1280×720。JSON 不保留时间戳 | 数据论文：相机在底线后约 6.4 m、从球员身后拍。高度没有记录。无地面平面，无足跟足趾 | 类名有 forehand、backhand、ready、serve。一名青少年选手，后方视角。下蹲深度无法从像素髋高读出 |
| Tennis Serve | 每帧 17×3。仓库称 COCO；三条样本的左右长骨对称性更符合 H3.6M（骨盆在 index 0） | 数值大约在 −0.5 到 1.4。元数据 `n_frames/duration_sec` 在全部 5966 行上都是 60.0 fps（59.998–60.002）。序列长度 60–120 帧，不是 README 写的固定长度 | 无相机、无世界地面。样本里 joint 0 的 xy 恒为 0，较低踝的竖直坐标恒为 0 | 全是发球。109 名公开赛选手，含身高和球速，但没有正手，也没有可还原的步法轨迹 |
| 侧视与俯视 | 无 | CSV 单位是米：到最近双打边线和到端线的距离，出界为负 | 说明里没有内参。视频文件夹未打开，所以分辨率和帧率没有核实 | 直线球和斜线球的落点。与人体姿态无关 |

## 已解析的样本

脚本是 [audit_pose.py](audit_pose.py)。它只读本地文件，写出统计 JSON 和 SVG 棍图，不下载、不调用求解器。`selftest` 覆盖这些检查：刚体骨架得到 high 置信；16、55、86 个关节一律拒绝；结构随机的 17 关节在 auto 下被拒绝；被钉在地面上的骨架会被标出；自然排序；无时间戳的二维序列不做连续运动分析，有 `frame_index` 的才做。下面的数字来自 [evidence/](evidence/) 中的 JSON。

### 发球三维：三条真实 `.npy`

选取覆盖目录首、中、尾的三个文件，并用 `metadata.parquet` 对上选手。元数据共 5966 行、109 名发球者、113 个 `match_id`，身高 160–203 cm，球速 98–218 km/h。三条样本是：

| 文件 | 选手 | 身高 | 帧数 | 时长 | 球速 |
|---|---|---|---|---|---|
| `2024-usopen-1101_pt0001_srv1.npy` | Jannik Sinner | 191 cm | 88 | 1.4667 s | 180 km/h |
| `2024-usopen-1408_pt0182_srv1.npy` | Alexei Popyrin | 196 cm | 85 | 1.4167 s | 189 km/h |
| `2024-usopen-2407_pt0201_srv1.npy` | Qinwen Zheng | 178 cm | 99 | 1.6500 s | 177 km/h |

拓扑是量出来的：把同一条序列分别按 H3.6M-17 和 COCO-17 连长骨，比较两种连法的左右长骨对数误差。三条的 H3.6M 误差是 0.045–0.064，COCO-17 是 0.355–0.519，差值 0.30–0.47，三条都判为 `symmetry_confidence: high`，所以自动选 H3.6M-17。这和 README 的「COCO 17」不一致。这个分数只说明左右对称性更像 H3.6M，不能证明关节顺序，确定顺序需要来源的文档。JSON 里保留两种连法的分数，见 [sinner-srv1.json](evidence/sinner-srv1.json)。`--skeleton` 可以指定布局；`ambiguous` 为真时 auto 直接拒绝。Sinner 已用新脚本重跑，数字与旧版相同，只多了置信字段。Popyrin 和 Zheng 的源文件这次没有取回，JSON 仍是旧格式。按它们存下的分数，同样会得到 high，但这是按旧数字推算，不是重跑的结果。

竖直轴是头和双踝平均值分离最大的那一轴，三条都是第 3 轴，头在正方向。在这个轴上：

| 样本 | 骨长中位 CV | 骨盆高度极差 | 头到较低踝 | 身高 / 骨架 | 两踝高度差最大 | 右肘屈曲最大 | 肩线单帧最大转角 |
|---|---|---|---|---|---|---|---|
| Sinner | 0.169 | 0.432 | 1.170 | 1.63 | 0.666 | 173° | 170° |
| Popyrin | 0.128 | 0.382 | 1.171 | 1.67 | 0.587 | 155° | 53° |
| Zheng | 0.179 | 0.337 | 1.134 | 1.57 | 0.642 | 172° | 133° |

Sinner 这一条里，颈–头骨长均值 0.045、最小 0.025、最大 0.195（CV 0.40）；胸–右肩最小收到 0.009。右踝相邻帧位移中位 0.014、最大 0.705。按 60 fps，最大那一帧约 42 m/s，而中位只有约 0.8 m/s。右腕最大单帧位移 0.731。肩线转角在 Sinner 和 Zheng 两条上跨过 360°，中间有 130° 以上的单帧跳变，不能当成躯干转体。

较低踝竖直坐标的绝对值最大为 0，骨盆 xy 的绝对值最大为 0。也就是每一帧都把骨盆平移到水平原点，再把较低的那只脚放到高度 0。这样得到的「骨盆高度极差」是相对较低脚的，不是世界坐标里的下蹲。Zheng 的元数据身高 1.78 m，和 human3d 的骨架身高数字相同，骨架本身仍然只有约 1.13。

棍图是每帧单独缩放的，只用来看点怎么连，不表示米制大小：[sinner-srv1.svg](evidence/sinner-srv1.svg)、[popyrin-srv1.svg](evidence/popyrin-srv1.svg)、[zheng-srv1.svg](evidence/zheng-srv1.svg)。

这些序列是 MotionBERT 一类单目抬升的输出。本报告把它们记为模型估计。多相机重建或标记动捕才有资格被叫做测量参照，而这三条都不是。

### 二维网球动作：四份 JSON 都解析了

每份 500 张图、500 条标注，类别名 Forehand / Backhand / Ready / Serve，关键点顺序与数据论文的表一致。`F_001.jpeg` 的尺寸是 1280×720，和 JSON 的 `width/height` 一致。正手有 1 个点落在画面外，反手 12 个，准备 1 个，发球 0 个。`v=0` 极少，正手 9000 个点里只有 1 个。

文件名是零填充的（F_001 … F_500），按文件名排序与文件内顺序完全一致。但 JSON 里没有帧号或时间戳，所以时间顺序没有被验证（`temporal_order_verified: false`）。脚本因此只做两件事：

- **标签顺序上的相邻跳变（诊断）。** 每对相邻样本里，各关节位移的中位数。正手中位 29.4 px，第 90 百分位 102 px，超过 80 px 的有 67 对；阈值 40 / 80 / 120 px 时分别是 165 / 67 / 41 对。反手 68 对，准备 100 对，发球 35 对。这些是标签顺序的跳变，不是运动事件。
- **骨长 CV。** 原始值和除以躯干长度的值都在 JSON 的 `bones_px` 里。正手左小腿的 CV 是 0.228，除以躯干后是 0.144；右小腿 0.248 → 0.132；左右肩距除以躯干后仍有 0.382。后方视角下转体会压短左右肩距，所以连归一化后的二维骨长也不是刚体骨长。

不做连续运动分析。之前的版本在按文件名排序后的片段里算过髋的图像纵向幅度与躯干长度之比（中位 0.87 / 1.01 / 1.09），那是对标签顺序切段的结果，不是运动，已经删除。像素髋高没有米制也没有地面，即使顺序被确认，也不能换算成 #17 要的骨盆下降。

棍图取排序后的首、中、尾三帧，标题写的是 `sorted sample`，不表示运动帧：[forehand-2d.svg](evidence/forehand-2d.svg)。完整统计见 [forehand-2d.json](evidence/forehand-2d.json)、[backhand-2d.json](evidence/backhand-2d.json)、[ready-2d.json](evidence/ready-2d.json)、[serve-2d.json](evidence/serve-2d.json)。

### 落点 CSV

四个文件的列都是序号、到最近双打边线的米、到端线的米。室内斜线 99 行，其中端线距离有 5 个负数（最小 −1.03 m），和说明里「出界为负」一致。室内直线 99 行，室外斜线 20 行，室外直线 18 行。99+99+20+18=236，等于说明中的击球数；侧视加俯视才是 472 段视频。已点名的室内斜线侧视文件夹恰好 99 个 mp4。没有关节点，脚本只做了范围统计：[indoor_cross.json](evidence/indoor_cross.json) 等。

### 只读了相机文件的 AthletePose3D

`cam_param.json` 的键是 `fs_camera_1..12`、`rm_camera_1..4`、`tnf_camera_1..8`。每个相机有 3×3 `affine_intrinsics_matrix`、长度 5 的 `distortion`、3×3 `extrinsic_matrix` 和长度 3 的 `xyz`。旋转行列式在 0.999999–1.000001。焦距约 1109–1686。这个文件证明发布包里确实有分项相机参数，也和论文的机位数量对得上。它不包含任何一帧姿态，所以骨长、脚接触和骨盆都没有被实测。姿态结论停留在论文：无标记多相机、标定误差小于 1 mm、跑 120 fps、其余 60 fps。论文把多相机结果当作单目模型的对照，那个对照本身没有在本机打开。

许可文本写明仅非商业科研，并且不得把数据提供给第三方。相机文件留在 `/tmp`，没有进入 git。

### SportsPose：公开材料，零字节数据

申请信要交给 Christian Mikkelstrup（页面上的地址是 `cmomi` at `dtu.dk`），内容包括姓名、学术单位、学术邮箱和用途。许可是免费、不可转让、仅学术，发表时要引用 2023 年的研讨会论文，只引用网址不算。

论文里已经写明、但本机没有复核的内容：室内为主、也有室外；动作是 baseball pitch、jump、tennis、volleyball、soccer；每人约 5 次；COCO 17；90 Hz；7 相机；三角化后用时间图和 4 阶 6 Hz Butterworth。和 Qualisys 的平均差 34.5 mm 来自另一批身上有标记的序列，作者把这批从训练姿态里分开。标记在皮肤上，HRNet 点在关节中心附近，两者之间有他们用线性变换去对齐的协议差。所以即便以后拿到数据，也应把它写成「有误差条的多相机估计」，而不是标记动捕真值。

公开加载代码（`sportspose/dataset.py`、`plot_skeleton_3d.py`）按人、按动作读 `.npy`，骨架连线是 COCO 下标。仓库不包含数据。

## 和 human3d 的差距

| 数据集 | A 视频姿态是否可信 | B 三维关键帧 | C 骨长与时间 | D 选手正手 | 对 #17 |
|---|---|---|---|---|---|
| SportsPose | 它本身是多相机估计，可用来考单目模型；我们没有考 | 网球片段有可能，未看到文件 | 论文给了 34.5 mm 的外部对照；骨长尚未量 | 没有这 17 个人 | E |
| AthletePose3D | 论文说常规数据集上训的单目模型在运动动作上 MPJPE 约 214 mm，微调后约 65 mm。这是论文数字 | 动作类型不对，包也没下 | 相机文件已核对；姿态未量 | 无网球 | E |
| 二维动作 | 后方像素坐标没有米制、地面或时间戳，像素髋高不能当作骨盆下降，也无法判断它是否漂移 | 无三维 | 无时间戳，骨长随透视变 | 一名选手的分类帧，不是轨迹 | E，只保留为反例 |
| 发球三维 | 三条样本的骨长、脚尖峰和肩线跳变说明这种抬升结果不能当测量 | 无世界根轨迹，尺度也不是选手身高 | 时间是 60 fps，但骨长不连续 | 发球，不是正手 | E（A 的否定样本）。其他用途：姿态质量检查的负面测试样本 |
| 落点 | 与姿态估计无关 | 无 | 无 | 无 | E |

没有写转换器。WorkshopDoc 要的是米制根位移、脚的接触区间、手的目标和定长骨。这三份已经打开的姿态样本缺少世界轨迹、地面、手指、球拍，以及和 1.78 m 骨架一致的骨长。硬转会把缺失的量填上。脚本停在检查，检查没过就不生成文档。

## 按收益排序

1. **先把外部集排除出 #17 的深度目标。** 这是这次唯一已经核实、而且立刻有用的结果。17 个预设的厘米级髋下降，仍然只能从项目自己的源视频量。不需要新模型。
2. **外源三维以后若再考虑，先过这支脚本。** 骨长中位 CV、根节点是否被钉死、骨架高度和元数据身高的比，这三项在发球样本上已经能把不可用的序列挡在求解器外面。脚本留在 `research/`，不进运行时，也不进 CI：现在没有一份会通过的数据值得守门。
3. **SportsPose 的网球子集是另一个问题的候选：单目估计误差的多相机参照。** 对 #17 没有用（没有这 17 个人的正手）。它有网球、踝点、90 Hz 和与标记系统的对照。申请之前没有样本，所以不单独立项。申请信必须走学术身份，不能绕过。
4. **AthletePose3D 是另一个问题的候选：高速动作的单目误差评估。** 对 #17 没有用。最小姿态包 1.4 GB，许可只允许非商业科研，不能进产品。
5. **二维动作图只在要训练检测器时才有用。** human3d 不训练姿态网络，后方像素也不能标定骨盆。
6. **落点 CSV 是球的位置。** 和脚接触、骨盆无关。

## 原型

```bash
# 发球三维（DATA 为本地目录，布局见 evidence/manifest.json）
python3 research/sports-datasets/audit_pose.py npy DATA/tsd/2024-usopen-1101_pt0001_srv1.npy --fps 60 --height-cm 191 --label sinner-srv1 --out research/sports-datasets/evidence
# 二维网球动作（forehand 额外给出 fps 与图像尺寸）
python3 research/sports-datasets/audit_pose.py coco DATA/tpa/forehand.json --fps 30 --image DATA/tpa/F_001.jpeg --label forehand-2d --out research/sports-datasets/evidence
# 落点 CSV
python3 research/sports-datasets/audit_pose.py csv DATA/side/indoor_cross.csv --out research/sports-datasets/evidence
python3 research/sports-datasets/audit_pose.py selftest
```

输入是本地的 `.npy` `(T, J, 3)`、COCO 风格 JSON，或落点 CSV。输出是同名的统计 JSON；姿态输入再加一张 SVG。依赖只有 Python 3 和 numpy。`npy` 可用 `--skeleton {auto,h36m17,coco17}` 指定关节布局。

误差从哪来：

- 17 点的关节名不是文件里读出的，是按左右骨长对称性选的。`--skeleton` 可以指定布局，但只有来源文档写明关节顺序时才应该用。对称性不明确时，auto 直接拒绝，不再硬选。JSON 里记录 `symmetry_confidence`、`ambiguous`、`source`，以及两种连法的分数。置信度只描述左右对称性，不证明关节顺序。
- 16、55、86 等其他关节数直接拒绝。之前的版本会按 COCO-17 的下标硬算，现在不会。
- 对称性阈值（0.15、0.20；置信度 high 需要 0.10、0.25）只在三条发球样本上看过，不是通用标准。对称性用的是各骨的平均长度，每帧抖动不进这个分数；抖动体现在骨长 CV 里。
- 竖直轴是头和踝分离最大的轴。若抬升模型把身体放平，这个轴会选错；三条发球样本的头–踝向量在第 3 轴上约 1.1、在另外两轴上小于 0.4，所以这次的选择和身体朝向一致。
- 关节角是三点夹角，180° 为伸直。它分不出过伸和屈曲，也分不出 human3d 的踝背屈，因为没有脚跟和足趾。
- COCO 的顺序：只有 `frame_index` 或 `timestamp_s` 为唯一的数值时才按它排序；否则按文件名的自然排序（`T_2` 在 `T_10` 之前），并且不做连续运动分析。`sorted_neighbor_jumps` 只是诊断。
- 二维默认 80 px 切断阈值；40 / 80 / 120 px 的诊断计数都写进了 JSON。
- 二维骨长的原始 CV 混有远近。JSON 里同时给了除以躯干之后的 CV，透视缩短仍然在。
- `--fps` 和 `--height-cm` 由调用者传入。60 fps 和三名选手的身高来自读过的 parquet，不是 `.npy` 自己写的。
- 较低踝「钉在 0」的判定是该坐标绝对值小于 1e-3。三条样本的实测最大值是 0。

## 证据清单与复现

[evidence/manifest.json](evidence/manifest.json) 列出每个输入的来源（Mendeley 的数据集 ID、版本、文件 ID、下载地址；Drive 的文件 ID）、许可、字节数、SHA-256、关节格式，以及每个输出的命令和输入。`DATA` 指按清单里 `local_path` 摆放的本地目录。仓库不带下载器，输入文件也不进 git。

这次做过的核对：

- 修改前的脚本（提交 `829eee0`）跑出的 14 个文件，与仓库原件逐字节一致：8 个 COCO 的 JSON 和 SVG，4 个落点 CSV 的 JSON，Sinner 的 JSON 和 SVG。
- 修改后的脚本重跑这批输入：4 个落点 CSV 的 JSON 与 Sinner 的 SVG 字节不变；Sinner 的 JSON 只多了 `topology` 里的置信字段；4 个 COCO 的骨长、缺失率、画面外点数与修改前相同，去掉了按标签顺序切段的统计，换成 `sorted_neighbor_jumps` 和 `temporal_order_verified: false`。
- Popyrin 和 Zheng 的源 `.npy` 这次没有取回（Drive 文件夹列表分页，前 50 项之外没有找到文件 ID），它们的 JSON 和 SVG 仍是修改前生成的。清单里标为 `regenerated_with_current_script: false`。

修改脚本后执行的验证：

- `python3 -m py_compile research/sports-datasets/audit_pose.py`：通过。
- `python3 research/sports-datasets/audit_pose.py selftest`：`selftest ok`。
- CLI：55 关节被拒绝；结构随机的 17 关节在 auto 下被拒绝；Sinner 用 `--skeleton coco17` 时记录 `source: caller` 和 `warning`。
- `node scripts/check-docs-links.mjs`（`npm run docs:check` 调用的同一脚本，未安装 node_modules，直接用 node 运行）：54 个 Markdown 文件，0 条死链。
- 未运行 `npm test`：改动只在 `research/` 下，不进运行时。

## Issue

没有新建。仓库里与本题直接相关的已有条目是 [#17](https://github.com/tinyviber/human3d/issues/17)（用源视频的三维测量定下蹲）和 [#2](https://github.com/tinyviber/human3d/issues/2)（求解与契约的总评审）。本次核实的结果是「这些数据集填不上 #17」，这不构成第二个实现任务。SportsPose 申请和 AthletePose3D 的大包下载都还没有样本证据，按本次约定只写在报告里。

## 下载量、失败项、未做完的事

这次工作区里能核对 SHA-256 的输入共 **1,608,364 字节**（约 1.6 MB），都在 `/tmp`，没有提交：

| 文件 | 字节 | 核对 |
|---|---|---|
| 四个动作 JSON（forehand、backhand、ready_position、serve） | 1,257,000 | 本地 SHA-256 等于 Mendeley 平台的 `sha256_hash` |
| `F_001.jpeg` | 221,014 | 同上 |
| 四个落点 CSV | 3,493 | 同上（一个文件名保留了源里的拼写 `Outdoot`） |
| Sinner 的 `.npy` | 18,080 | 只有本地 SHA-256（Drive 不提供哈希） |
| `metadata.parquet` | 108,777 | 只有本地 SHA-256 |

原始会话里还取得过 Popyrin 和 Zheng 的 `.npy`（17,468 与 20,324 字节）和 AthletePose3D 的 `cam_param.json`（24,206 字节）。这次工作区里已不存在，`.npy` 的文件 ID 也没有重新找到，所以它们只在清单里记录字节数，没有哈希。`cam_param.json` 不被任何输出使用。

明确没有下载的大包：SportsPose 全部；AthletePose3D 的 `data.zip`（35 GB）、`pose_2d.zip`（29 GB）、`pose_3d.zip`（1.4 GB）；二维数据集其余约 508 MB 图像，即 1999 张；侧视/俯视视频（说明为 2.42 GB，已看到的一个文件夹约 518 MB）。Google Drive 的关键点目录列出 5500 个文件，其余 `.npy` 未下。

失败或走弯路的尝试：

- `api.mendeley.com` 上猜的 public-api 路径返回 404。文件列表后来走 `data.mendeley.com/public-api/datasets/{id}/` 得到，下载地址为 `public-files` 形式。
- Mendeley 的 `files` 接口偶发 502，重试后成功。它的 `folderId` 参数对子目录无效，只返回前 100 项。
- Google Drive 的文件夹页面只列出前 50 项，Popyrin 和 Zheng 的 `.npy` 因此没找到 ID。
- 环境里的新 pyarrow 要求 NumPy 2。parquet 是用装在 `/tmp` 的 pyarrow 16 读的，没有改项目依赖。
- AthletePose3D 的三个压缩包链接打开的是 Drive 的病毒扫描页。体积从该页读出，没有点继续下载。
- 没有把发球序列送进求解器。骨长、地面和尺度在进求解器之前就已经不满足参照条件。

未做完：

- SportsPose 的学术申请和任何一帧真实姿态。
- AthletePose3D 的姿态序列。最小可用姿态包是 1.4 GB，许可也不允许再分发。
- 侧视/俯视 mp4 的编码、分辨率和帧率。说明页没有写，文件没有打开。
- Popyrin、Zheng 两个样本用新脚本重跑。
- 任何到 WorkshopDoc 或姿态包的转换。
