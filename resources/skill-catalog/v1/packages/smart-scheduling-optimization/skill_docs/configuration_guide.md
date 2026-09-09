# 智能调度优化算法技能 - 配置参数指南

## 1. 基础参数配置

### 1.1 遗传算法核心参数

```java
public class GeneticAlgorithmParameters {
    /**
     * 种群大小 (Population Size)
     * 推荐值：30-200
     * 适用场景：
     * - 30-50: 小规模、简单问题
     * - 50-100: 中等规模、中等复杂度问题
     * - 100-200: 大规模、高复杂度问题
     */
    private int populationSize = 50;
    
    /**
     * 最大迭代代数 (Max Generations)  
     * 推荐值：100-500
     * 评估依据：算法收敛性和计算时间权衡
     * - 100-200: 快速收敛问题
     * - 200-400: 中等复杂度，需要平衡精度和时间的问题
     * - 400-800: 高维复杂解空间
     */
    private int maxGenerations = 200;
    
    /**
     * 交叉率 (Crossover Rate)
     * 推荐值：0.7-0.95
     * - 高值(0.9-0.95): 促进全局探索
     * - 中值(0.8-0.9): 平衡探索与开发
     * - 低值(0.7-0.8): 侧重精确开发
     */
    private double crossoverRate = 0.9;
    
    /**
     * 变异率 (Mutation Rate) 
     * 推荐值：0.01-0.2
     * - 高值(0.15-0.2): 防止早熟收敛，保持多样性
     * - 中值(0.05-0.15): 平衡收敛速度和精度
     * - 低值(0.01-0.05): 用于后期精确调整
     */
    private double mutationRate = 0.1;
    
    /**
     * 锦标赛规模 (Tournament Size)
     * 推荐值：2-7
     * - 2-3: 稍微偏向最优解，保持多样性
     * - 4-5: 选择压力适中
     * - 6-7: 强烈偏向最优解，收敛快但多样可能不足
     */
    private int tournamentSize = 4;
}
```

### 1.2 NSGA-II 算法特定参数

```java
public class NsgaIiSpecificParameters {
    /**
     * 拥挤度计算缩放因子
     * 适用范围：0.001-1000，一般使用 1.0
     * 作用：调整拥挤距离在选择中的影响权重
     */
    private double crowdingDistanceScaleFactor = 1.0;
    
    /**
     * 精英保留比率
     * 适用范围：0.1-0.3，表示每代保留多少比例的最佳解
     * 高值：保留更多优秀解，可能降低探索
     * 低值：保留较少优秀解，保持多样性
     */
    private double elitismRatio = 0.2;
    
    /**
     * 约束惩罚乘数
     * 适用范围：100-10000，根据约束严重程度调整
     * 值较大：强烈惩罚不可行解
     * 值较小：适度容忍约束违法
     */
    private double constraintPenaltyMultiplier = 1000.0;
}
```

## 2. 多目标参数配置

### 2.1 目标函数权重设置

```java
public class MultiObjectiveConfiguration {
    // 示例目标函数权重向量 (示例为调度优化常见的5个目标)
    /**
     * 目标函数权重设计示例： 
     * 1. 完成度 - 最高优先级
     * 2. 设备利用率 - 次要优先级
     * 3. 时间跨度 - 第三优先级 
     * 4. 换线成本 - 第四优先级
     * 5. 均衡性 - 第五优先级
     */
    private double[] objectiveWeights = {0.4, 0.3, 0.15, 0.1, 0.05};
    
    /**
     * 目标函数规范化方法
     * - MIN MAX 归一化: (x-min)/(max-min)  - 适用于已知值域
     * - Z-Score 标准化: (x-mean)/std        - 适用于未知值域
     * - 线性函数变换: ax+b                  - 适用于特定变换需求
     */
    private NormalizationMethod normalizationMethod = NormalizationMethod.MIN_MAX;
    
    enum NormalizationMethod {
        MIN_MAX,    // 最小-最大归一化
        Z_SCORE,    // Z分数标准化  
        LINEAR      // 线性函数变换
    }
}
```

### 2.2 目标优先级策略

```java
public class ObjectivePriorityStrategy {
    // 分层优化策略：按优先级先后优化
    private List<Integer> objectivePriorities = Arrays.asList(0, 1, 2, 3, 4); // 0最高优先级
    
    // 动态权重调整：根据优化进度调整目标权重
    private boolean useAdaptiveWeights = true;
    
    // 临界值控制：某些目标达到阈值后才考虑其他目标
    private ObjectiveThreshold[] thresholds = {
        new ObjectiveThreshold(0, 0.001),      // 目标0完成度：误差<=0.001
        new ObjectiveThreshold(1, 0.8)         // 目标1利用率：>=80%
    };
    
    public static class ObjectiveThreshold {
        int objectiveIndex;
        double thresholdValue;
        boolean isMinimized;  // true表示小于阈值，false表示大于阈值
        
        public ObjectiveThreshold(int index, double value) {
            this.objectiveIndex = index;
            this.thresholdValue = value;
            this.isMinimized = true; // 默认情况：越小越好
        }
    }
}
```

## 3. 多层级参数推荐

### 3.1 厂级配置推荐

```java
public class FactoryLevelConfig extends OptimizerConfig {
    public FactoryLevelConfig() {
        // 厂级优化重视全局协调和长期效益
        setPopulationSize(80);          // 较大的种群确保全局搜索
        setMaxGenerations(300);         // 更长代数，追求精确
        setMutationRate(0.18);          // 较高变异，避免早熟
        setCrossoverRate(0.92);         // 高交叉率，加速全局探索
    }
    
    // 厂级目标权重 - 注重整体效率和成本控制
    private double[] factoryObjectives = {
        0.4,  // 产出最大化
        0.25, // 成本最小化  
        0.2,  // 能耗控制
        0.1,  // 约束满足度
        0.05  // 均衡性
    };
    
    // 厂级特殊约束处理
    public void applyFactoryConstraints() {
        setConstraintPenaltyMultiplier(2000.0); // 更严格的约束处理
    }
}
```

### 3.2 车间级配置推荐

```java
public class WorkshopLevelConfig extends OptimizerConfig {
    public WorkshopLevelConfig() {
        // 车间级关注执行效率和资源协调
        setPopulationSize(60);         
        setMaxGenerations(200);        
        setMutationRate(0.12);         
        setCrossoverRate(0.88);        
    }
    
    // 车间级目标权重 - 关注生产效率和执行精度
    private double[] workshopObjectives = {
        0.3,  // 准时交付
        0.3,  // 设备利用率最大化    
        0.25, // 换线成本最小化
        0.1,  // 库存优化
        0.05  // 平衡性
    };
    
    // 车间级约束关注点
    public void applyWorkshopConstraints() {
        // 设置换线约束和维护窗口约束
    }
}
```

### 3.3 设备级配置推荐

```java
public class EquipmentLevelConfig extends OptimizerConfig {
    public EquipmentLevelConfig() {
        // 设备级注重精度和约束满足
        setPopulationSize(40);          
        setMaxGenerations(150);         
        setMutationRate(0.08);           // 较低变异，保持已有的好解
        setCrossoverRate(0.80);        
    }
    
    // 设备级目标权重 - 重执行准确和约束
    private double[] equipmentObjectives = {
        0.35, // 任务完成准确性
        0.3,  // 设备状态最佳
        0.2,  // 工艺参数合规  
        0.1,  // 维护计划遵守
        0.05  // 顺序合理性
    };
    
    // 精密约束处理
    public void applyEquipmentConstraints() {
        setConstraintPenaltyMultiplier(5000.0); // 更高的违约惩罚
    }
}
```

## 4. 自适应配置策略

### 4.1 动态参数调整规则

```java
public class AdaptiveParameterAdjustment {
    private OptimizerConfig currentConfig;
    
    /**
     * 根据优化进程动态调整参数
     * @param generation 当前代数
     * @param diversity 指示种群多样性
     * @param convergence 指示收敛程度
     */
    public void adjustParameters(int generation, double diversity, double convergence) {
        
        // 根据多样性调整变异率
        if (diversity < 0.1) {  // 多样性不足，加大变异
            currentConfig.setMutationRate(
                Math.min(0.25, currentConfig.getMutationRate() * 1.1)
            );
        } else if (diversity > 0.6) {  // 多样性充足，可适当减少变异
            currentConfig.setMutationRate(
                Math.max(0.05, currentConfig.getMutationRate() * 0.95)
            );
        }
        
        // 根据收敛情况调整交叉率
        if (convergence < 0.1) {  // 早期阶段，鼓励探索
            currentConfig.setCrossoverRate(0.92);
        } else if (convergence > 0.8) {  // 后期阶段，鼓励开发
            currentConfig.setCrossoverRate(0.85);
        }
        
        // 根据代数调整种群大小
        if (generation > currentConfig.getMaxGenerations() * 0.7 && 
            diversity < 0.2) {
            currentConfig.setPopulationSize(
                Math.min(200, (int)(currentConfig.getPopulationSize() * 1.1))
            );
        }
    }
    
    /**
     * 根据问题特征自适应配置
     * @param problemSize 问题规模（变量数量）
     * @param constraintDensity 约束密度
     * @param objectiveCount 目标数量
     */
    public void configureByProblemCharacteristics(int problemSize, 
                                                  double constraintDensity, 
                                                  int objectiveCount) {
        // 问题规模大，则使用较大的种群
        if (problemSize > 1000) {
            currentConfig.setPopulationSize(150);
            currentConfig.setMaxGenerations(400);
        } else if (problemSize > 500) {
            currentConfig.setPopulationSize(100);
            currentConfig.setMaxGenerations(300);
        }
        
        // 约束密集则加强约束处理
        if (constraintDensity > 0.3) {  // 约束比例 > 30%
            currentConfig.setConstraintPenaltyMultiplier(3000.0);
        }
        
        // 目标数量影响拥挤距离的计算方式
        if (objectiveCount > 5) {
            // 高维目标空间使用改进的拥挤距离估计
            currentConfig.setUseEnhancedCrowdingDistance(true);
        }
    }
}
```

## 5. 特定场景配置建议

### 5.1 实时调度场景

```java
public class RealTimeSchedulingConfig extends OptimizerConfig {
    public RealTimeSchedulingConfig() {
        // 实时场景：优先保证响应时间
        setPopulationSize(30);          // 缩减种群加快计算
        setMaxGenerations(50);          // 减少迭代次数
        setMutationRate(0.15);          // 稍高变异，快速找到满意解
        setCrossoverRate(0.85);
        
        // 启用快速收敛检测：如果连续几代目标值变化很小则提前结束
        setEarlyTerminationEnabled(true);
        setEarlyTerminationThreshold(0.0001);
        setStagnationGenerations(10);   // 如果10代无改进，提前终止
    }
    
    // 实时调度目标优先级
    private double[] realTimeObjectives = {
        0.5,   // 响应及时性 - 最高
        0.3,   // 基本可行性
        0.2    // 质量优化 - 较低
    };
}
```

### 5.2 长期计划场景

```java
public class LongTermPlanningConfig extends OptimizerConfig {
    public LongTermPlanningConfig() {
        // 长期计划：追求更优质量和全面性
        setPopulationSize(120);         // 大种群，充分探索
        setMaxGenerations(500);         // 充足迭代，深入搜索
        setMutationRate(0.1);           // 温和变异，精致开发
        setCrossoverRate(0.9);
    }
    
    // 长期计划注重稳定性和全面性
    private double[] planningObjectives = {
        0.3,   // 资源利用率
        0.25,  // 成本控制
        0.2,   // 风险分散
        0.15,  // 客户满意度
        0.1    // 协调性
    };
    
    // 保存优化历史以供后续分析
    public boolean saveOptimizationHistory = true;
    public int historyDetailLevel = 2; // 保存细节等级
}
```

## 6. 配置验证与调优

### 6.1 参数敏感性分析

```java
public class SensitivityAnalysis {
    public ParameterImpactReport analyzeParameterSensitivity() {
        // 测试各项参数的变化对最终结果的影响
        ParameterImpactReport report = new ParameterImpactReport();
        
        List<double[]> baselineResults = runOptimizationWithConfig(BASELINE_CONFIG);
        
        // 改变参数后重新运行
        OptimizerConfig testConfig = BASELINE_CONFIG.copy();
        testConfig.setPopulationSize(100);
        List<double[]> popSizeResults = runOptimizationWithConfig(testConfig);
        
        report.addImpact("populationSize", calculateDifference(baselineResults, popSizeResults));
        
        testConfig = BASELINE_CONFIG.copy();
        testConfig.setMutationRate(0.2);
        List<double[]> mutRateResults = runOptimizationWithConfig(testConfig);
        
        report.addImpact("mutationRate", calculateDifference(baselineResults, mutRateResults));
        
        // 类似的对其他参数进行敏感性分析...
        return report;
    }
    
    public double calculateDifference(List<double[]> results1, List<double[]> results2) {
        // 计算两种参数配置的差异度
        // 可以使用Hausdorff距离等指标
        return 0.1; // 简化返回值示例
    }
}

class ParameterImpactReport {
    private Map<String, Double> sensitivityCoefficients = new HashMap<>();
    
    public void addImpact(String parameterName, double impactValue) {
        sensitivityCoefficients.put(parameterName, impactValue);
    }
    
    public String getSensitiveParameters() {
        return sensitivityCoefficients.entrySet().stream()
            .filter(entry -> entry.getValue() > 0.1)  // 认为变化大于0.1的参数敏感
            .map(Map.Entry::getKey)
            .collect(Collectors.joining(", "));
    }
}
```

通过以上配置指南，您可以根据不同问题的特点和需求来合理设置调度优化算法的参数，从而获得更好的优化效果。在实际应用中，建议结合敏感性分析和实验验证来确定最适合具体问题的参数配置。