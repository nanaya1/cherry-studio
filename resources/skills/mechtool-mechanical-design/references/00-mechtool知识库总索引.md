# Mechtool 机械设计知识库 · 总索引

> 精编参考文档（本 references/ 目录）由 mechtool.cn 2261 页语料蒸馏而成。
> 完整语料内嵌于本 skill `data/md/`（2261 个 md，645 万字，自包含），索引 `data/md_index.json`。
> 检索: `python3 scripts/search_corpus.py search <关键词>`
> 注意: 大量标准数据表(轴承尺寸/螺纹/弹簧大表)与公式图未全量进精编文档，精确数值以语料检索或原标准为准。

## 文档导航

| 编号 | 文档 | 内容概要 |
|------|------|---------|
| 00 | 本文件 | 总索引 |
| 01 | 01-工程材料.md | 钢牌号表示法、碳钢/合金钢/不锈钢/铸铁力学性能与用途、铝合金、热处理、合金元素作用 |
| 02 | 02-轴承与轴.md | 轴承分类/代号/各国对照/尺寸载荷表/寿命计算/公差配合游隙/组合设计、滑动轴承、轴设计、联轴器 |
| 03 | 03-紧固与连接.md | 螺纹基础/螺栓预紧防松/强度等级/紧螺栓校核/螺母垫圈挡圈销键 |
| 04 | 04-传动系统.md | 带传动/V带设计/齿轮材料/蜗杆传动/链传动/减速器与电机选用 |
| 05 | 05-液压气动密封.md | 液压泵马达分类参数/控制阀/液压缸/静动密封/机械密封/气动 |
| 06 | 06-弹簧设计.md | 弹簧类型代号/材料/尺寸系列/压缩拉伸弹簧设计/碟簧 |
| 07 | 07-公差配合与制图.md | 公差配合基础/优先配合表/形位公差/粗糙度标注/机械制图规范(图线/剖面/尺寸注法/表面结构/常用件画法) |
| 08 | 08-力学公式.md | 强度理论/弯曲/接触应力公式指引+SI单位换算 |
| 09 | 09-设计计算工具.md | 轴/齿轮/轴承/螺栓/V带/滚子链/滑动螺旋/滚珠丝杠设计计算流程与公式 |
| 10 | 10-结构设计与禁忌.md | 切削/铸造/锻造工艺性、热处理防裂、提高强度刚度禁忌 |

## 主题 → 文档快速映射

- 材料牌号/性能/热处理 → 01
- 轴承选型/尺寸/寿命、轴、联轴器 → 02
- 螺纹/螺栓/键销挡圈 → 03
- V带/同步带/齿轮/蜗杆/链/减速器/电机 → 04
- 泵/阀/缸/密封 → 05
- 弹簧 → 06
- 公差/配合/粗糙度/制图规范 → 07
- 力学公式/单位 → 08
- 设计计算流程（选型计算） → 09
- 结构工艺/禁忌 → 10

## 语料主题目录（检索前缀）
基础资料(/infoanddata /unitandconversion)、工程材料(/metalmaterial /nonmetalmaterial /heattreatment /othermaterial)、
紧固与连接(/boltsandnuts /stdboltsandnuts /thread)、轴承与轴(/bearing /shaftsandcouplings)、
机械制图与精度(/drawingandaccuracy /measuringandcuttingtools)、弹簧(/spring)、
传动系统(/geardrive /beltdrive /reducer /motor /chain 等)、液压气动密封(/hydraulic /hydrauliccontrol /pneumatic /seal)、
结构设计(/partstructure /mechanicaldesigntaboo /molddesign)、力学公式(/mechanicsformula /formular)、
设计计算(/calculation /CAD /CAE /mechanicalbook)、标准资料(/mechstds /manual)

## 已知局限（查询时注意）
1. **公式类页面**(formular/mechanicsformula): 核心公式为 PNG 图片，语料正文多空白；精确公式查在线原页
2. **图片型目录**: reducer(减速器规格)、motor(电机表)、部分 mechanicaldesigntaboo(禁忌图例) 为图片表
3. **标准大表**: 轴承尺寸(GB/T 276 等)、螺纹、弹簧规格表数值未全量入文档，用检索脚本查语料
4. 爬虫仍在补抓剩余 ~2900 页（多为尺寸明细页），新页入库后语料自动可检索
