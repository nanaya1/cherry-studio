# MATLAB仿真工具软件简介 | 控制系统的工具软件MATLAB及其在仿真中的应用 | 液压控制

<!-- src: https://www.mechtool.cn/hydrauliccontrol/hydrauliccontrol_controlsystemtoolsoftwarematlabanditsapplicationinsimulation.html -->

[
]()
## MATLAB仿真工具软件简介
#### MATLAB仿真工具软件简介
MATLAB仿真工具软件简介
控制系统的仿真分析集中体现两个步骤：建模和仿真。其基本思想就是建立物理的或数学的模型来模拟现实的过程，以寻求过程和规律。实物仿真比较直观、形象，如飞机、导弹模型在风洞中的模拟实验；利用沙盘模型作战；以及汽车的道路实验等。利用数学的语言、方法来描述实际问题，并用数值计算方法对这一问题进行分析，这一过程称为数字仿真。人们利用计算机在数值计算上的优势，采用高能计算语言(如FORTRAN-C等)，编制计算程序替代人工求解，这使得数学模型的求解变得更加方便、快捷和精确。有许多专业性和通用性的计算仿真软件，MATLAB是通用性较强的数值计算、机电液综合仿真商业软件之一
MATLAB1.0版于1984年由MATHWORKS公司推出，其名称为由Matrix Laboratory缩写而来，主要的优势在于它强大的矩阵处理和绘图功能。这一点非常适合于现代控制系统的计算机辅助设计。它一推出就立刻引起国际控制学术界的重视。MATLAB把计算、可视化、编程等基本功能都集中在一个易于使用的环境中，并且公式的表达和求解与日常数学运算相似，这一特点，使工程技术人员很容易地熟悉其使用环境，缩短学习和编程时间，为此MATLAB语言也被亲切地称为“演算纸式的语言”
随着MATLAB的不断完善和功能的开发，1993年在MATLAB中集成了具有动态系统建模、仿真工具的SIM-ULINK，使控制系统建模和仿真摆脱了烦琐的关联矩阵求取和输入，让设计者把更多的精力集中在系统的设计和校正上
SIMULINK是图形仿真工具包，能对动态系统进行建模、仿真和综合分析，可处理线性和非线性方程，离散的、连续的和混合系统，进行单任务和多任务仿真分析。工程技术人员不需要编制任何程序，甚至不必编写一行代码，即可完成相当复杂的控制系统的模型构建、仿真和分析校正，能直观、快捷地得到希望的参数
在SIMULINK下进行控制系统仿真，分两步进行：首先是系统建模，其次是系统仿真和分析
SIMULINK环境和元件库
项目
内容
说明
运行MATLAB
![b22d4d59a](https://www.mechdoc.cn/images/hydrauliccontrol/hydrauliccontrol_controlsystemtoolsoftwarematlabanditsapplicationinsimulation1.gif)
MATLAB
Command Windows窗口
双击Windows桌面的![p161c](https://www.mechdoc.cn/images/hydrauliccontrol/hydrauliccontrol_controlsystemtoolsoftwarematlabanditsapplicationinsimulation2.gif)图标，或
者点击开始\所有程序\MATLAB\R2006b\MATLABR2006b，运行MATLAB 7.3.0(R2006b)
激活Simulink仿真元件库浏览窗口
![b22d4d59b](https://www.mechdoc.cn/images/hydrauliccontrol/hydrauliccontrol_controlsystemtoolsoftwarematlabanditsapplicationinsimulation3.gif)
Simulink中的线性元件子库及其成员
Matlab命令窗口激活Simulink的方式有三种：
① 输入Simulink后回车；
② 选择File\New\Model选项；
③ 鼠标点击![p161d](https://www.mechdoc.cn/images/hydrauliccontrol/hydrauliccontrol_controlsystemtoolsoftwarematlabanditsapplicationinsimulation4.gif)图标
本章以MATLAB2006b中的SIMULINK6.5为例介绍。
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