# 智能调度优化算法技能 - 实现示例

## 1. 基础应用示例

### 1.1 简单调用示例

```java
// 基础排产优化示例
public class BasicProductionSchedulingExample {
    public void runBasicOptimization() {
        // 1. 创建排产问题实例
        ProductionSchedulingProblem problem = new ProductionSchedulingProblem.Builder()
            .setResourceCount(10)  // 10台生产设备
            .setTaskCount(20)      // 20个生产任务
            .setCapabilities(generateCapacityMatrix())
            .setDemands(generateDemands())
            .setConstraints(createConstraints())
            .build();
        
        // 2. 配置优化参数
        OptimizerConfig config = new OptimizerConfig.Builder()
            .setPopulationSize(50)      // 种群大小
            .setMaxGenerations(100)     // 最大代数  
            .setMutationRate(0.15)      // 变异率
            .setTournamentSize(4)       // 锦标赛规模
            .build();
        
        // 3. 创建优化器实例
        SchedulerOptimizer<ProductionSolution> optimizer = 
            new NsgaII_SchedulerOptimizer<>();
        optimizer.configure(config);
        
        // 4. 执行优化
        List<ProductionSolution> results = optimizer.optimize(problem);
        
        // 5. 输出最优解决方案
        System.out.println("找到 " + results.size() + " 个Pareto最优解:");
        for (int i = 0; i < results.size(); i++) {
            System.out.println("解 " + (i+1) + ": " + printSolution(results.get(i)));
        }
    }
    
    private double[][] generateCapacityMatrix() {
        // 生成10x20的资源能力矩阵
        double[][] matrix = new double[10][20];
        for (int i = 0; i < 10; i++) {
            for (int j = 0; j < 20; j++) {
                matrix[i][j] = Math.random() * 100;  // 随机能力值
            }
        }
        return matrix;
    }
    
    private double[] generateDemands() {
        double[] demands = new double[20];
        for (int i = 0; i < 20; i++) {
            demands[i] = 50 + Math.random() * 50;  // 需求值50-100
        }
        return demands;
    }
    
    private ConstraintManager<ProductionSolution> createConstraints() {
        // 创建简单的容量约束
        return new DefaultProductionConstraintManager();
    }
}
```

## 2. 多层级调度示例

### 2.1 两层调度问题示例

```java
public class HierarchicalSchedulingExample {
    public void runFactoryWorkshopScheduling() {
        // 定义两层结构：厂-车间
        HierarchyDefinition hierarchy = new HierarchyDefinition();
        hierarchy.addLevel(MultiLevelConfig.HierarchyLevel.FACTORY);
        hierarchy.addLevel(MultiLevelConfig.HierarchyLevel.WORKSHOP);
        
        // 创建层级调度问题
        HierarchicalSchedulingProblem hProblem = new HierarchicalSchedulingProblem.Builder()
            .hierarchy(hierarchy)
            .factoryResourceCount(5)  // 5个车间
            .factoryTaskCount(10)     // 10个产品线
            .workshopResourceCount(8) // 每车间6台设备
            .workshopTaskCount(15)    // 每车间15个任务
            .interLevelConstraints(createInterLevelConstraints()) // 上下层约束
            .build();
        
        // 配置层级优化参数
        MultiLevelConfig config = new MultiLevelConfig.Builder()
            .baseConfig(new OptimizerConfig.Builder()
                .setPopulationSize(60)
                .setMaxGenerations(150)
                .setMutationRate(0.15)
                .build())
            .levelConfig(MultiLevelConfig.HierarchyLevel.FACTORY, 
                new LevelConfig.Builder()
                    .setObjectiveWeights(new double[]{0.4, 0.3, 0.2, 0.1})  // 厂级目标权重
                    .setAlgorithmParameter("popSize", 80)
                    .build())
            .levelConfig(MultiLevelConfig.HierarchyLevel.WORKSHOP, 
                new LevelConfig.Builder()
                    .setObjectiveWeights(new double[]{0.3, 0.4, 0.2, 0.1})  // 车间级目标权重
                    .setAlgorithmParameter("mutationRate", 0.1)
                    .build())
            .build();
        
        // 使用适配的层级优化器
        SchedulerOptimizer<HierarchicalSolution> hOptimizer = 
            new ProgressiveHierarchicalOptimizer<>();
        hOptimizer.configure(config);
        
        // 执行两层联合优化
        List<HierarchicalSolution> hResults = hOptimizer.optimize(hProblem);
        
        // 分析和展示结果
        System.out.println("两层协调调度结果分析:");
        for (int i = 0; i < Math.min(3, hResults.size()); i++) {
            HierarchicalSolution solution = hResults.get(i);
            System.out.println("\n方案 " + (i+1) + ":");
            System.out.println("厂级目标: " + Arrays.toString(extractFactoryObjectives(solution)));
            System.out.println("车间级目标: " + Arrays.toString(extractWorkshopObjectives(solution)));
        }
    }
    
    private InterLevelConstraintManager createInterLevelConstraints() {
        return new FactoryWorkshopConstraintAdapter();
    }
    
    private double[] extractFactoryObjectives(HierarchicalSolution solution) {
        // 提取厂级目标值
        return solution.getObjectivesForLevel(MultiLevelConfig.HierarchyLevel.FACTORY);
    }
    
    private double[] extractWorkshopObjectives(HierarchicalSolution solution) {
        // 提取车间级目标值
        return solution.getObjectivesForLevel(MultiLevelConfig.HierarchyLevel.WORKSHOP);
    }
}
```

### 2.2 三层调度实现示例

```java
public class ThreeLevelSchedulingExample {
    public void runFactoryWorkshopEquipmentScheduling() {
        // 创建三层调度问题：厂->车间->设备
        ThreeLevelSchedulingProblem problem = new ThreeLevelSchedulingProblem.Builder()
            .factoryLayer(new FactoryLayerConfig.Builder()
                .resourceCount(3)      // 3个生产厂区
                .taskCount(8)         // 8个产品类别
                .build())
            .workshopLayer(new WorkshopLayerConfig.Builder()
                .resourcesPerFactory(4)  // 每厂区4个车间
                .tasksPerWorkshop(10)      // 每车间10个任务
                .build())
            .equipmentLayer(new EquipmentLayerConfig.Builder()              
                .equipmentPerWorkshop(6)   // 每车间6台设备
                .tasksPerEquipment(5)       // 每台设备承接5个工序任务
                .build())
            .couplingConstraints(new ThreeLevelCouplingConstraints())
            .build();
        
        // 采用逐步细化优化策略
        List<ThreeLevelSolution> results = runProgressiveOptimization(problem);
        
        // 展示多层协调效果
        System.out.println("三层协调优化结果");
        results.forEach(solution -> {
            System.out.printf("总适应度: %.2f | 厂层: %.2f | 车间层: %.2f | 设备层: %.2f%n",
                calculateOverallFitness(solution),
                calculateFactoryLevelFitness(solution),
                calculateWorkshopLevelFitness(solution),
                calculateEquipmentLevelFitness(solution)
            );
        });
    }
    
    private List<ThreeLevelSolution> runProgressiveOptimization(ThreeLevelSchedulingProblem problem) {
        ProgressiveHierarchicalOptimizer<ThreeLevelSolution> optimizer = 
            new ProgressiveHierarchicalOptimizer<>();
            
        // 配置分步优化参数
        optimizer.getProgressiveConfig()
            .phase(MultiLevelConfig.HierarchyLevel.FACTORY).iterations(20).population(80)
            .phase(MultiLevelConfig.HierarchyLevel.WORKSHOP).iterations(30).population(60)
            .phase(MultiLevelConfig.HierarchyLevel.EQUIPMENT).iterations(40).population(50);
        
        return optimizer.optimize(problem);
    }
    
    private double calculateOverallFitness(ThreeLevelSolution solution) {
        return Arrays.stream(solution.getObjectives()).average().orElse(0.0);
    }
    
    private double calculateFactoryLevelFitness(ThreeLevelSolution solution) {
        double[] objs = solution.getFactoryLevelObjectives();
        return Arrays.stream(objs).average().orElse(0.0);
    }
    
    // 其他层适应度计算类似...
}
```

## 3. 自定义约束处理示例

### 3.1 自定义约束管理器

```java
public class CustomProductionConstraintManager implements ConstraintManager<ProductionSolution> {
    private double maxOverloadRatio = 0.15;  // 最大超载比例15%
    private List<Long> priorityTasks = new ArrayList<>();  // 优先级任务
    
    @Override
    public boolean satisfiesAllConstraints(ProductionSolution solution) {
        // 检查资源过载约束
        if (!checkResourceOverLoad(solution)) {
            return false;
        }
        
        // 检查优先级任务约束
        if (!checkPriorityTaskConstraints(solution)) {
            return false;
        }
        
        // 检查连续性约束
        if (!checkContinuityConstraints(solution)) {
            return false;
        }
        
        return true;
    }
    
    @Override
    public double calculatePenalty(ProductionSolution solution) {
        double penalty = 0.0;
        
        // 资源过载惩罚
        penalty += calculateOverLoadPenalty(solution);
        
        // 优先级任务违规惩罚
        penalty += calculatePriorityPenalty(solution);
        
        // 连续性违约惩罚
        penalty += calculateContinuityPenalty(solution);
        
        return penalty;
    }
    
    private boolean checkResourceOverLoad(ProductionSolution solution) {
        // 检查资源是否超过容量
        List<List<Integer>> assignments = solution.getResourceAssignments();
        for (int resource = 0; resource < assignments.size(); resource++) {
            double totalLoad = calculateResourceLoad(solution, resource);
            double capacity = getResourceCapacity(resource);
            if (totalLoad > capacity * (1 + maxOverloadRatio)) {
                return false;
            }
        }
        return true;
    }
    
    private double calculateOverLoadPenalty(ProductionSolution solution) {
        double totalPenalty = 0.0;
        // 按超出程度累加惩罚
        for (int resource = 0; resource < solution.getResourceCount(); resource++) {
            double totalLoad = calculateResourceLoad(solution, resource);
            double capacity = getResourceCapacity(resource);
            if (totalLoad > capacity) {
                totalPenalty += (totalLoad - capacity) * 10;  // 按超额程度惩罚
            }
        }
        return totalPenalty;
    }
    
    // 其他约束检查和计算方法...
}
```

### 3.2 适应度函数定制

```java
public class CustomProductionFitnessEvaluator implements FitnessEvaluator<ProductionSolution> {
    private OptimizerConfig optimizerConfig;
    
    @Override
    public double[] evaluate(ProductionSolution solution, SchedulingProblem<ProductionSolution> problem) {
        double[] objectives = new double[5]; // 定义5个目标
        
        // 目标1: 未完成量最小化
        objectives[0] = calculateUnfulfilledAmount(solution);
        
        // 目标2: 资源使用效率最大化
        objectives[1] = -calculateResourceEfficiency(solution);  // 负号因为要最大化
        
        // 目标3: 跨资源切换(换牌)最小化  
        objectives[2] = calculateSwitchCost(solution);
        
        // 目标4: 交付时限满足率最大化
        objectives[3] = -calculateDeliveryCompliance(solution, problem.getDemands());  // 负号因为最大化
        
        // 目标5: 均衡性最大化
        objectives[4] = -calculateLoadBalancing(solution);  // 负号因为最大化
        
        // 添加约束惩罚
        ConstraintManager<ProductionSolution> constraints = problem.getConstraintManager();
        double penalty = constraints.calculatePenalty(solution);
        objectives[0] += penalty;  // 在最重要的目标上添加惩罚
        
       	return objectives;
    }
    
    private double calculateUnfulfilledAmount(ProductionSolution solution) {
        // 计算未完成的任务量
        List<Double> plannedQuantities = solution.getPlannedQuantities();
        double[] demands = solution.getExpectedDemands();  // 实际是problem传递过来的
        
        double unfulfilled = 0.0;
        for (int i = 0; i < demands.length; i++) {
            unfulfilled += Math.max(0, demands[i] - plannedQuantities.get(i));
        }
        return unfulfilled;
    }
    
    private double calculateResourceEfficiency(ProductionSolution solution) {
        // 计算资源利用效率
        double totalEfficiency = 0.0;
        for (int resource = 0; resource < solution.getResourceCount(); resource++) {
            totalEfficiency += calculateOneResourceEfficiency(solution, resource);
        }
        return totalEfficiency / solution.getResourceCount();
    }
    
    // 其他评估方法类似...
}
```

## 4. 高级配置策略示例

### 4.1 参数动态调整

```java
public class AdaptiveParameterStrategy {
    public void applyAdaptiveConfiguration(
        SchedulerOptimizer<?> optimizer,
        SchedulingProblem<?> problem,
        int generation, 
        List<?> currentPopulation
    ) {
        OptimizerConfig config = optimizer.getCurrentConfig();
        
        // 计算种群多样性指标
        double diversity = calculatePopulationDiversity(currentPopulation);
        
        if (diversity < 0.1) {  // 多样性太低，易陷入局部最优
            config.setMutationRate(Math.min(0.3, config.getMutationRate() * 1.2));
            config.setCrossoverRate(Math.max(0.7, config.getCrossoverRate() * 0.9));
        } else if (diversity > 0.8) {  // 多样性太高，收敛慢
            config.setMutationRate(Math.max(0.05, config.getMutationRate() * 0.9));
            config.setCrossoverRate(Math.min(0.95, config.getCrossoverRate() * 1.1));
        }
        
        // 动态调整种群大小
        if (generation > 50 && isConvergingSlowly(currentPopulation)) {
            config.setPopulationSize(Math.min(config.getPopulationSize() * 1.1, 200));
        }
    }
    
    private double calculatePopulationDiversity(List<?> population) {
        // 使用欧几里得距离或海明距离计算种群多样性
        // 这里简化示例
        return 0.5;  // 实际实现需要详细计算
    }
    
    private boolean isConvergingSlowly(List<?> population) {
        // 判断是否收敛过慢
        return false;  // 实现需要监测多代变化趋势
    }
}
```

### 4.2 多算法融合策略

```java
public class HybridOptimizationStrategy {
    private SchedulerOptimizer<?>[] optimizers;
    private double[] algorithmWeights;
    
    public HybridOptimizationStrategy() {
        // 组合NSGA-II, SPEA2 等多目标优化算法
        optimizers = new SchedulerOptimizer[] {
            new NsgaII_SchedulerOptimizer<>(),
            new Spea2SchedulerOptimizer<>(),
            new MoeAddSchedulerOptimizer<>()
        };
        algorithmWeights = new double[] {0.5, 0.3, 0.2};  // 各算法贡献权重
    }
    
    public <T> List<T> optimizeWithHybridStrategy(SchedulingProblem<T> problem) {
        List<List<T>> algorithmResults = new ArrayList<>();
        
        // 运行各个算法获得初步解集
        for (int i = 0; i < optimizers.length; i++) {
            List<T> partialResults = optimizers[i].optimize(problem);
            algorithmResults.add(partialResults);
        }
        
        // 合并结果，重新评估和排序
        return mergeAndReoptimize(algorithmResults, problem);
    }
    
    private <T> List<T> mergeAndReoptimize(List<List<T>> algorithmResults, SchedulingProblem<T> problem) {
        // 合并来自不同算法的解
        Set<T> mergedSet = new HashSet<>();
        for (List<T> result : algorithmResults) {
            mergedSet.addAll(result);
        }
        
        // 在合并集中找出真正的帕累托前沿
        List<T> mergedList = new ArrayList<>(mergedSet);
        return extractTrueParetoFront(mergedList, problem);
    }
    
    private <T> List<T> extractTrueParetoFront(List<T> solutions, SchedulingProblem<T> problem) {
        // 使用NSGA-II的方法来重新进行非支配排序
        return new NsgaII_SchedulerOptimizer<T>().extractFinalParetoFront(solutions, problem);
    }
    
    private interface AlgorithmCombiner<T> {
        List<T> combineResults(List<List<T>> individualResults);
    }
}
```

这些示例展示了如何将调度优化算法技能应用到具体的调度场景中，从基础应用到多层次、约束处理和高级配置等各个方面都提供了实际实现范例。可以根据您的具体需求调整上述示例以适配业务场景。