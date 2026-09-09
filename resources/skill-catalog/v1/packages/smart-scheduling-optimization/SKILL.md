---
name: smart-scheduling-optimization
description: 基于NSGA-II多目标遗传算法的智能调度优化，用于生产排程、资源分配、多目标优化等场景。适用于"优化排产"、"调度算法"、"多目标优化"、"遗传算法调度"等需求。
---

# 智能调度优化算法技能

基于NSGA-II多目标遗传算法的通用调度优化解决方案，可适配厂-车间-机组等多层级调度需求。

## 使用场景

当用户请求：
- "优化排产算法"
- "调度优化"
- "多目标优化"
- "遗传算法调度"
- "资源分配优化"
- "生产排程优化"
- "改进调度算法"
- "实现多目标遗传算法"

## 技能特点

- **多目标优化**：支持同时优化多个业务目标（产能、成本、准时率等）
- **分层适配**：统一算法模型支持不同的层次化调度需求
- **约束处理**：内置通用约束管理和惩罚机制
- **可参数化**：灵活可调的优化参数适应不同场景
- **可扩展性**：面向接口设计便于定制特定业务组件

## 核心接口定义

### 1. 调度优化器接口

```java
public interface SchedulerOptimizer<T> {
    List<T> optimize(SchedulingProblem<T> problem);
    void configure(OptimizerConfig config);
    List<GenerationRecord> getOptimizationHistory();
}
```

### 2. 调度问题定义接口

```java
public interface SchedulingProblem<T> {
    int getResourceCount();
    int getTaskCount();
    double[][] getCapabilityMatrix();
    double[] getDemands();
    ConstraintManager<T> getConstraintManager();
    double[] getObjectiveWeights();
}
```

### 3. 约束管理接口

```java
public interface ConstraintManager<T> {
    boolean satisfiesAllConstraints(T solution);
    double calculatePenalty(T solution);
    void repairSolution(T solution);
    int getConstraintCount();
}
```

### 4. 遗传算法操作接口

```java
public interface CrossoverOperator<T> {
    T crossover(T parent1, T parent2);
}

public interface MutationOperator<T> {
    T mutate(T individual, double mutationRate);
}

public interface SelectionOperator<T> {
    List<T> select(List<T> population, int size);
}
```

## 配置参数

### 基础参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| populationSize | 50 | 种群大小（30-200） |
| maxGenerations | 100 | 最大迭代代数（100-500） |
| crossoverRate | 0.9 | 交叉率（0.7-0.95） |
| mutationRate | 0.1 | 变异率（0.01-0.2） |
| tournamentSize | 4 | 锦标赛规模（2-7） |
| constraintPenaltyMultiplier | 1000.0 | 约束惩罚乘数 |

### 按问题规模推荐

| 问题规模 | 种群大小 | 迭代代数 |
|----------|----------|----------|
| 简单（<50变量） | 20-30 | 50-100 |
| 中等（50-500变量） | 50-80 | 100-200 |
| 复杂（>500变量） | 80-150 | 200-500 |

### 多层级配置

```java
// 厂级配置
setPopulationSize(80);
setMaxGenerations(300);
setMutationRate(0.18);

// 车间级配置
setPopulationSize(60);
setMaxGenerations(200);
setMutationRate(0.12);

// 设备级配置
setPopulationSize(40);
setMaxGenerations(150);
setMutationRate(0.08);
```

## 核心算法组件

### 1. 快速非支配排序

```java
public List<List<Individual>> fastNonDominatedSort(List<Individual> population) {
    List<List<Individual>> fronts = new ArrayList<>();
    // 时间复杂度：O(M*N^2)
    // M为目标数量，N为种群大小
}
```

### 2. 拥挤度计算

```java
public void crowdingDistanceAssignment(List<Individual> front) {
    // 保证解的多样性，避免算法收敛于局部区域
}
```

### 3. 锦标赛选择

```java
public Individual tournamentSelection(List<Individual> population, int tournamentSize) {
    // 优先选择排名更低（Pareto前沿编号更小）的解
    // 相同前沿内选择拥挤度更大的解
}
```

## 目标函数设计示例

```java
public double[] evaluate(ProductionSolution solution) {
    double[] objectives = new double[5];
    
    objectives[0] = calculateUnfulfilledAmount(solution);     // 未完成量最小化
    objectives[1] = -calculateResourceEfficiency(solution);   // 资源效率最大化
    objectives[2] = calculateSwitchCost(solution);            // 换线成本最小化
    objectives[3] = -calculateDeliveryCompliance(solution);   // 交付满足率最大化
    objectives[4] = -calculateLoadBalancing(solution);        // 负载均衡最大化
    
    return objectives;
}
```

## 目标权重配置

### 厂级目标权重
```java
double[] factoryObjectives = {0.4, 0.25, 0.2, 0.1, 0.05};
// 产出最大化、成本最小化、能耗控制、约束满足度、均衡性
```

### 车间级目标权重
```java
double[] workshopObjectives = {0.3, 0.3, 0.25, 0.1, 0.05};
// 准时交付、设备利用率、换线成本、库存优化、平衡性
```

### 设备级目标权重
```java
double[] equipmentObjectives = {0.35, 0.3, 0.2, 0.1, 0.05};
// 任务完成准确性、设备状态最佳、工艺参数合规、维护计划遵守、顺序合理性
```

## 使用示例

### 基础调用

```java
// 1. 创建调度问题
SchedulingProblem<ProductionSolution> problem = new SchedulingProblem.Builder()
    .setResourceCount(10)
    .setTaskCount(20)
    .setCapabilities(capacityMatrix)
    .setDemands(demands)
    .setConstraints(constraintManager)
    .build();

// 2. 配置优化参数
OptimizerConfig config = new OptimizerConfig.Builder()
    .setPopulationSize(50)
    .setMaxGenerations(100)
    .setMutationRate(0.15)
    .setTournamentSize(4)
    .build();

// 3. 执行优化
SchedulerOptimizer<ProductionSolution> optimizer = new NsgaII_SchedulerOptimizer<>();
optimizer.configure(config);
List<ProductionSolution> results = optimizer.optimize(problem);
```

### 多层级调度

```java
// 定义两层结构：厂-车间
HierarchyDefinition hierarchy = new HierarchyDefinition();
hierarchy.addLevel(HierarchyLevel.FACTORY);
hierarchy.addLevel(HierarchyLevel.WORKSHOP);

// 配置层级优化参数
MultiLevelConfig config = new MultiLevelConfig.Builder()
    .baseConfig(baseOptimizerConfig)
    .levelConfig(HierarchyLevel.FACTORY, factoryLevelConfig)
    .levelConfig(HierarchyLevel.WORKSHOP, workshopLevelConfig)
    .build();
```

## 自适应参数调整

```java
public void adjustParameters(int generation, double diversity, double convergence) {
    // 多样性不足时加大变异
    if (diversity < 0.1) {
        config.setMutationRate(Math.min(0.25, config.getMutationRate() * 1.1));
    }
    // 后期阶段鼓励开发
    if (convergence > 0.8) {
        config.setCrossoverRate(0.85);
    }
}
```

## 相关文档

- [核心组件](skill_docs/core_components.md) - NSGA-II算法核心、遗传算子
- [接口定义](skill_docs/interface_definition.md) - 标准接口定义
- [多层级策略](skill_docs/multi_level_strategy.md) - 分层调度策略
- [实现示例](skill_docs/implementation_examples.md) - 具体应用案例
- [配置指南](skill_docs/configuration_guide.md) - 参数优化建议

## 注意事项

1. 明确问题的解空间结构和约束条件
2. 合理设定多目标权重以符合业务实际需要
3. 根据问题规模设定合理算法参数
4. 验证优化结果的可行性和合理性
5. 约束密集问题需提高 constraintPenaltyMultiplier

---
*此技能基于实际项目中的调度优化方案提炼而成，持续优化中*