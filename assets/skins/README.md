# 超赛动漫换肤资产

`ssj-projection.png` 是按当前 `human.glb` 正背面参考生成的赛璐璐颜色图；`ssj-face.png` 是独立的高清面部投影画稿。原始提示词及工具信息在 [provenance.json](provenance.json)。使用内置 imagegen，工具未暴露模型版本，不能确认是 Image-2.5。发型轮廓参考[《龙珠 FighterZ》官方角色图](https://dba.bn-ent.net/character/)。

`scripts/bake-ssj-skin.py` 将生成图烘焙到模型原有 UV，输出 `public/models/skins/ssj-body.png`（2048²）与眼球贴图 `ssj-eyes.png`（1024×512）。高清面部按模板的眼位、鼻尖、嘴和下巴做纵向配准。离线依赖 Python、numpy、scipy、Pillow；运行 `python scripts/bake-ssj-skin.py`，不改 GLB。`ssj-hair.png` 是另一次生成的金发色块材质。

运行时两页共用 `SkinSwap` 和 `SkinSwitch`：

- 仅首次开启才加载贴图；失败保留默认外观并允许重试；重复切换复用资源；关闭精确恢复原网格与材质。
- `ssj-geometry.ts` 只克隆显示网格，略放大头部并压平真人眼窝、鼻梁和嘴唇；1.54 m 以下顶点不动。UV、拓扑、蒙皮权重与骨骼保持原值；法线按源顶点身份合并，避免 UV 接缝。眼球用相同头部变形对齐。原 GLB、动作数据与求解路径保持不变。
- `ssj-hair.ts` 用 Three.js 生成独立的三维发底和尖发束；先从当前显示网格的上半头部拟合发底中心与半径，再按头部尺寸布置发束、两束刘海及鬓角，最后按绑定姿态挂到头骨。头皮颜色图本身保持光头，金发颜色只由独立发型网格的材质提供；默认皮肤不创建发型，切回默认则隐藏整个发型。身体、眼睛、头发使用 `MeshToonMaterial`，叠加固定视角光的两段色阶和细轮廓线；它仍是可旋转、可播放动作的三维网格。
- 肌群高亮独立采样原有遮罩；换肤是会话显示状态，不写动作库。GLB 导出继续使用原始模型；静帧导出保留当前动漫外观，相机为较高的发型留出空间。

短裤与靴子仍是表面绘制，保留原肢体与脚趾轮廓；面部是现有网格的风格化变形，未重建专用角色拓扑。

定向测试：`npm test -- apps/web/src/theme/ssj-geometry.test.ts apps/web/src/theme/ssj-hair.test.ts`。真实 UI 回归：启动本 checkout 的 dev server 后，在仓库根运行 `QA_BROWSER_CHANNEL=chrome node scripts/skin-browser-qa.mjs`；另设端口使用 `HUMAN3D_WEB_PORT`。覆盖两页、失败重试、原网格/材质还原、UV/权重/源数据不变、肌群拾取、播放中换肤、静帧导出、资源释放及移动端控件。
