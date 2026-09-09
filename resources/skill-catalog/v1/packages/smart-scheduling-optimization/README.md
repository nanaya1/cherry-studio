# 智能调度优化算法技能（Smart Scheduling Optimization）

## 技能概述

本技能基于NSGA-II多目标遗传算法，旨在为各类调度优化问题提供可重用的解决方案设计。该技能源于烟草设备排产经验，经过抽象和通用化设计，能够处理厂-车间-机组等多层次调度需求。

### 技能特点
- **多目标优化**：支持同时优化多个业务目标（产能、成本、准时率等）
- **分层适配**：统一算法模型支持不同的层次化调度需求
- **约束处理**：内置通用约束管理和惩罚机制
- **可参数化**：灵活可调的优化参数适应不同场景
- **可扩展性**：面向接口设计便于定制特定业务组件

### 解决的主要问题
1. 资源分配优化：将有限资源合理分配给多个任务
2. 约束满足问题：在复杂业务约束条件下找到可行解
3. 多目标平衡：权衡多个可能冲突的优化目标
4. 分层调度协调：解决厂、车间、机组等不同层级间的调度冲突

## 使用场景

### 适用领域
- 制造业生产排程计划
- 物流运输调度
- 配送路线优化
- 电力调度

### 排除场景
- 高度实时性单点优化（如毫秒级响应）
- 过于简单的单一维度调度

## 核心组件概览

- **NSGA-II优化算法**：快速非支配排序与多目标协同优化
- **约束管理器**：保障解的可行性和业务合规性
- **适应度函数**：量化调度方案优劣
- **层次分解策略**：将复杂的分层问题统一解决
- **自适应参数调优**：根据问题特征调整算法参数

## 快速入门

以下是如何在项目中使用的简单示例：

### 1. 定义调度问题
```java
SchedulingProblem<YourSolutionType> problem = new SchedulingProblem.Builder()
    .setResourceCount(10)  // 总共10个资源
    .setTaskCount(20)      // 需要完成20个任务
    .setConstraints(constraintManager)  // 设置约束管理器
    .setDemand(demands)    // 设置任务需求量
    .setCapabilities(capacityMatrix)  // 设置资源能力矩阵
    .build();
```

### 2. 配置优化器参数
```java
OptimizerConfig config = new OptimizerConfig.Builder()
    .setPopulationSize(50)        // 种群大小
    .setCrossoverRate(0.9)        // 交叉率
    .setMutationRate(0.15)        // 变异率
    .setMaxGenerations(100)       // 最大迭代代数
    .setTournamentSize(4)         // 锦标赛规模
    .build();

SchedulerOptimizer optimizer = new NsgaII_SchedulerOptimizer<>();
optimizer.configure(config);
```

### 3. 执行优化并获取结果
```java
List<YourSolutionType> results = optimizer.optimize(problem);
```

## 技能组成部分

1. **[核心算法组件](skill_docs/core_components.md)**：包括NSGA-II算法核心、遗传算子等
2. **[接口定义](skill_docs/interface_definition.md)**：定义了标准接口使技能可移植
3. **[多层级策略](skill_docs/multi_level_strategy.md)**：指导如何分层调度
4. **[实现示例](skill_docs/implementation_examples.md)**：具体应用案例
5. **[配置指南](skill_docs/configuration_guide.md)**：参数优化建议

## 进阶实践

### 层次化调度
该技能可有效处理分层调度场景，通过合理的参数设置可应用于:
- 厂级优化（全局资源分配）
- 车间级优化（本地资源调度）
- 设备级调度（精确作业序列安排）

### 约束处理
内置可扩展约束机制，可处理：
- 容量限制约束
- 时间窗口约束
- 优先级限制约束
- 多资源协同约束

## 配置调优建议

根据问题复杂度：
- 简单问题（<50变量）：使用较小种群（20-30）和迭代代数（50-100）
- 中等问题（50-500变量）：使用中等参数（种群：50-80，代数：100-200）  
- 复杂问题（>500变量）：使用较大参数（种群：80-150，代数：200-500）

## 贡献和扩展

我们欢迎社区贡献:
- 提交新的优化目标函数
- 扩展特定行业的约束处理器
- 开发新的交叉变异算子

## 相关资源

- 文档详情: [完整技能文档](skill_docs/)
- 算法原理: [NSGA-II 论文](链接 TBD)
- 开源案例: [示例代码](examples/)

---
*此技能基于实际项目中的调度优化方案提炼而成，持续优化中*。