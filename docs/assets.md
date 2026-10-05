# 原版素材与动画

游戏场景使用初代《植物大战僵尸》的原始图片与 reanim 数据，不使用重绘树形。原计划提供的 [PC 素材索引](https://www.spriters-resource.com/pc_computer/plantsvszombies/asset/29115/page-2/)返回 HTTP 403，无法取得素材包。实际使用公开的 [PvZ_Assets 原版 macOS 素材库](https://github.com/FregD156/PvZ_Assets)，固定提交为 `8ba94e95cfe7d0de5682f8258d3b932dbdac885c`。

## 随源码交付的内容

`frontend/public/assets` 包含 75 个图片键、5 组动画、16 个字体数据文件和 5 个声音文件。树的动画覆盖 `anim_start` 和 `anim_grow1` 至 `anim_grow51`；云层保留 `Cloud1` 至 `Cloud6` 的独立区间。

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 800 × 600 场景尺寸、PNG 路径、图片尺寸、别名、字体与声音 |
| `animations.json` | 稀疏变换轨道、区间、原始 fps 与游戏播放参数 |
| `sources.json` | 固定提交、源 ZIP 摘要、107 个源文件的 URL／SHA-256／大小 |
| `original/reanim/*` | 5 个未改写的原始 reanim 文件 |
| `images/*` | 透明 PNG 图片，供 Canvas 逐层绘制 |
| `images/empty-pot.png` | 使用 `Pot.reanim` 花园姿态的原始图层合成的完整空花盆 |

智慧树、肥料、金币和花盆保留原始轨道的变换。XML 中没有给出的字段继承前一帧，`f < 0` 表示隐藏。JPEG 颜色图搭配同名下划线 PNG 的灰度 alpha，还原为浏览器可直接读取的 RGBA PNG。空花盆由原始花盆姿态合成，不重新绘制。

目前按原素材尺寸交付独立 PNG 和动画索引，浏览器一次预载后缓存使用。清单中没有将多张图片合并成单一纹理图集；Canvas 2D 直接使用这些图片，避免改动原始坐标和透明边缘。

## 重新导入与验证

正常运行、构建和 Docker 部署已包含全部素材，不需要 Python，也不会在启动时访问素材站。

需要重新导入时，在项目根目录运行：

```powershell
python -m pip install -r scripts/requirements-assets.txt
python scripts/import-assets.py
python scripts/verify-assets.py
```

导入脚本将固定提交的 ZIP 缓存到 `.local/asset-source/github.zip`，下载后验证完整 ZIP 的 SHA-256。已有本地 ZIP 可以指定缓存目录；目录中 ZIP 的名称必须为 `github.zip`：

```powershell
python scripts/import-assets.py --cache D:\素材缓存
python scripts/verify-assets.py --archive D:\素材缓存\github.zip --report docs/qa/asset-checks.json
```

不指定 `--archive` 的验证全程离线，检查全部图片、尺寸、别名、动画引用、成长段、云段及原始 reanim 摘要。指定源 ZIP 后，会再验证 107 个源文件摘要，并对 75 张转换图片逐像素比对，包括合成空花盆。目录不存在、图片缺失、alpha 尺寸不符、引用无法解析或 ZIP 摘要变化时，脚本会失败，不会悄悄使用占位图。

## Canvas 消费约定

- `manifest.images[key]` 为相对 `/assets/` 的路径；空花盆必须使用 `EMPTY_POT`，不能取到 `POT_BOTTOM` 等局部图层。
- 树高加载姿态使用 `anim_grow{clamp(height, 1, 50)}` 的末帧；施肥使用 `anim_grow{clamp(height, 1, 51)}`，播放速度为 8 fps。原始 reanim 内 fps 不等于游戏成长时使用的速度。
- 图层顺序为背景、云、树干、草丛、根部／叶子；云分为 6 个独立区间，以 0.2 fps 缓慢移动。
- 原始树偏移为 `(0.5, 0.5)`；施肥动画的场景偏移为 `(340, 300)`。
- 对白背景使用 `IMAGE_STORE_SPEECHBUBBLE2`。高度小于 7 时坐标为 `(400,152)`，小于 12 时为 `(395,60)`，其余为 `(390,52)`；文字区位于气泡内 `(+25,+6,233,144)`。
- 场景逻辑坐标固定为 800 × 600，手机整体缩放。站内金币反馈、中文说明和账号／API／管理面板属于新增界面。

## 核验记录与边界

[资产校验记录](qa/asset-checks.json)已通过。107 个源文件摘要与固定 ZIP 一致，75 张交付图片与原始颜色图／透明度重建结果一致，没有未解析图片引用。

[Steam 原版实机参考](https://steamcommunity.com/sharedfiles/filedetails/?id=2082040168)对应 100 英尺树形。保存的参考为 [source-original-100.jpg](qa/source-original-100.jpg)，与 `anim_grow50` 末帧的并排图为 [source-vs-converted-tree.png](qa/source-vs-converted-tree.png)。树干、根部、草丛轮廓及背景布局吻合。

实际来源是初代 macOS 素材，尚未取得 PC／GOTY 素材包。并排图能看到 PC 实机参考的颜色略亮，交付素材略暗、饱和度略高，因此不能将这次校验表述为 PC／GOTY 逐像素一致。PNG 保留取得的原始颜色，没有为匹配截图重新调色。最终网页的画面、对白位置及手机操作由主浏览器 QA 单独记录。

素材的著作权归原权利人所有。`sources.json` 用于追踪素材来源与转换过程，不是原创资产声明。
