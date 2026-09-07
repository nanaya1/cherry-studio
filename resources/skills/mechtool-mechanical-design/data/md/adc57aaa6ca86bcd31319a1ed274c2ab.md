# 真空吸盘与真空发生器选型 | 气压传动系统计算

<!-- src: https://www.mechtool.cn/calculation/calculation_selectionofvacuumchuckandvacuumgenerator.html -->

[
]()
## 参考资料
参考资料文档：
[真空发生器及其配件的选用-自动化机构设计工程师速成宝典 实战篇]()
[真空吸盘的计算示例-MiSUMi]()
## 工具介绍及使用说明
你可以在数据资料 [真空发生器的主要技术参数]()
[真空吸盘]()
中查看此工具程序相关的数据参数说明、设计方法及所用到的公式。
## 真空吸盘与真空发生器选型
### 真空吸盘选型计算
| 运动方式
顶吸提升
顶吸平移
侧吸提升
| 负载质量m
kg
| 加速度a
m/s²
| 安全系数S
[
]()
![图](https://www.mechdoc.cn/images/calculation/calculation_selectionofvacuumchuckandvacuumgenerator4.png)
| 摩擦因数μ
[ 查询]()
| 吸盘吸附力FH
N
| 单个吸盘吸附力
N
| 真空度p
kPa
| 吸盘数量n
| 吸盘直径D
mm
| 吸盘面积S
cm²
计算结果
显示公式中的参数说明
真空吸盘的吸吊力根据运动方式用上图中的公式求得：
式中：
m—工件质量，kg
g—重力加速度，g0 ≈10m/s²
a—动态运动时产生的加速度，m/s²
S—安全系数
μ—吸盘与工件间的摩擦因数
真空吸盘的吸吊力与真空度和吸盘面积、直径的关系如下:
FH=0.1*p*S*n=0.1*p*π*D²/4*n;
式中：
p-真空度,kPa; S-吸盘面积,cm²;D-吸盘直径,cm;n-吸盘数量;
### 真空发生器选型计算
| 所选吸盘直径D
mm
| 要求吸盘
响应时间T
s
| 配管内径d
mm
| 配管长度Ld
m
| 配管体积V1
L
| 吸盘体积V2
L
| 发生器最大pv
kPa
| 所需真空度p
kPa
| p/pv
%
| 吸附时间
比例T/T1
[
]()
![图](https://www.mechdoc.cn/images/calculation/calculation_selectionofvacuumchuckandvacuumgenerator5.png)
| 平均吸入流量
Q1
L/min
| 最大吸入流量
Qmax
L/min
计算结果
| 校核响应时间
| 实际Qmax
L/min
| 实际响应时间T
s
1.通过真空发生器的平均吸入流量Q1公式：
Q1=Cq*Qmax
式中：
Cq-系数,Cq=1/3～1/2，流动阻力大时取1/3，一般取1/2;
2.由上式得出最大吸入流量Qmax公式：
Qmax=(2~3)*Q1
设吸盘内的压力从大气压至真空度达63%pv的到达时间为T1,则T1=60V/Q1(无泄漏),s
由此推得：
Qmax=(2~3)*(60*V/T1)
如存在泄露，则
Qmax=(2~3)*(60*V/T1+QL)
式中：
V—总吸附容积,配管体积V1+吸盘体积V2,L
QL—泄漏量,程序默认取0,即无泄漏，L;
3.吸盘内的真空度p在最大真空度Pv=88kPa的63%~95%内选择，即保证吸附力，又不致使吸附相应时间过长；
4.实际Qmax,吸盘体积V2---查样本;
5.配管平均吸入流量Q2=11.1*Cq*S，Q2须大于Q1，请自行校核。
[
]()
[ 上一项 ]()
[ 下一项 ]()
#### 评论
[
![elesa-ganter伊莉莎冈特全系列机械标准配件](https://www.mechdoc.cn/images/ads/elesa-ganterweb.jpg)
]()
[
![m-haste艾姆华世特传动设备](https://www.mechdoc.cn/images/ads/m-hasteweb.png)
]()
[
![关注'机械小哥'微信公众号](https://www.mechdoc.cn/images/index_adwechatmechboy560x172.png)
]()
[
Mechtool
]()
Mechtool 简体中文版提供的内容仅用于提供参考,不保证内容的正确性.通过使用本站内容随之而来的风险与本站无关.版权所有,保留一切权利.
-
- [使用条款]()
-
- [隐私条款]()
-
- [问题反馈]()
-
- [侵权删除]()
-
- [帮助本站]()
-
- 访问量：0