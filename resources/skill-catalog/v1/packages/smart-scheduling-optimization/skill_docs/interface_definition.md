# 智能调度优化算法技能 - 接口定义与实现指南

## 1. 核心接口定义

### 1.1 调度优化器接口

```java
public interface SchedulerOptimizer<T> {
    /**
     * 执行调度优化
     * @param problem 调度问题定义
     * @return 优化解集合 (Pareto前沿)
     */
    List<T> optimize(SchedulingProblem<T> problem);
    
    /**
     * 配置优化参数
     * @param config 配置参数对象
     */
    void configure(OptimizerConfig config);
    
    /**
     * 获取优化历史记录（可用于调试和监控）
     * @return 优化过程的世代记录
     */
    List<GenerationRecord> getOptimizationHistory();
}
```

### 1.2 调度问题定义接口

```java
public interface SchedulingProblem<T> {
    /**
     * 获取资源数量  
     * @return 资源总数
     */
    int getResourceCount();
    
    /**
     * 获取任务数量
     * @return 任务总数
     */
    int getTaskCount();
    
    /**
     * 获取资源能力矩阵 (resource x task) 
     * @return 资源对任务的能力矩阵
     */
    double[][] getCapabilityMatrix();
    
    /**
     * 获取需求向量
     * @return 各任务的需求量
     */
    double[] getDemands();
    
    /**
     * 获取约束管理器
     * @return 约束管理器实例
     */
    ConstraintManager<T> getConstraintManager();
    
    /**
     * 获取目标权重
     * @return 目标函数权重向量
     */
    double[] getObjectiveWeights();
}
```

### 1.3 遗传算法操作接口

```java
public interface CrossoverOperator<T> {
    /**
     * 执行交叉操作
     * @param parent1 父代个体1
     * @param parent2 父代个体2
     * @return 生成的子代个体
     */
    T crossover(T parent1, T parent2);
}

public interface MutationOperator<T> {
    /**
     * 执行变异操作
     * @param individual 待变异个体
     * @param mutationRate 变异率
     * @return 变异后的个体
     */
    T mutate(T individual, double mutationRate);
}

public interface SelectionOperator<T> {
    /**
     * 从种群中选择个体
     * @param population 种群
     * @param size 选择个体数量
     * @return 选择的个体列表
     */
    List<T> select(List<T> population, int size);
}
```

### 1.4 约束管理接口

```java
public interface ConstraintManager<T> {
    /**
     * 检查解是否满足所有约束
     * @param solution 待检查的解
     * @return 是否满足约束
     */
    boolean satisfiesAllConstraints(T solution);
    
    /**
     * 计算约束违反度
     * @param solution 解
     * @return 违反惩罚值
     */
    double calculatePenalty(T solution);
    
    /**
     * 修复不可行解 (可选)
     * @param solution 待修复的解
     */
    void repairSolution(T solution);
    
    /**
     * 获取约束数量
     * @return 约束集合数量
     */
    int getConstraintCount();
}
```

## 2. 抽象类实现架构

### 2.1 抽象调度优化器

```java
public abstract class AbstractSchedulerOptimizer<T> implements SchedulerOptimizer<T> {
    protected OptimizerConfig config;
    
    @Override
    public List<T> optimize(SchedulingProblem<T> problem) {
        // 初始化种群
        List<T> population = initializePopulation(problem);
        
        // 主优化循环
        List<GenerationRecord> history = new ArrayList<>();
        for (int gen = 0; gen < config.getMaxGenerations(); gen++) {
            // 评估种群
            evaluatePopulation(population, problem);
            
            // 选择操作
            List<T> parents = selectionOperator.select(population, config.getPopulationSize());
            
            // 交叉和变异
            List<T> offspring = new ArrayList<>();
            for (int i = 0; i < parents.size(); i += 2) {
                T parent1 = parents.get(i);
                T parent2 = i + 1 < parents.size() ? parents.get(i + 1) : parents.get(i);
                
                T child1 = crossoverOperator.crossover(parent1, parent2);
                T child2 = crossoverOperator.crossover(parent2, parent1);
                
                child1 = mutateOperator.mutate(child1, config.getMutationRate());
                child2 = mutateOperator.mutate(child2, config.getMutationRate());
                
                offspring.add(child1);
                offspring.add(child2);
            }
            
            // 环境选择：父代与子代竞争
            population = environmentalSelection(population, offspring, problem);
            
            // 记录优化历史
            history.add(new GenerationRecord(gen, population, calculateMetrics(population)));
            
            // 检查提前终止条件
            if (shouldTerminate(population)) {
                break;
            }
        }
        this.optimizationHistory = history;
        
        return extractBestSolutions(population);
    }
    
    // 抽象方法由子类实现
    protected abstract List<T> initializePopulation(SchedulingProblem<T> problem);
    protected abstract void evaluatePopulation(List<T> population, SchedulingProblem<T> problem);
    protected abstract List<T> environmentalSelection(List<T> parents, List<T> offspring, SchedulingProblem<T> problem);
    protected abstract List<T> extractBestSolutions(List<T> population);
}
```

## 3. 标准实现类设计

### 3.1 NSGA-II调度优化器

```java
public class NsgaII_SchedulerOptimizer<T> extends AbstractSchedulerOptimizer<T> {
    protected CrossoverOperator<T> crossoverOperator;
    protected MutationOperator<T> mutateOperator;
    protected SelectionOperator<T> selectionOperator;
    
    public NsgaII_SchedulerOptimizer() {
        // 默认操作算子
        this.crossoverOperator = new UniformCrossoverOperator<>();
        this.mutateOperator = new UniformMutationOperator<>();
        this.selectionOperator = new TournamentSelectionOperator<>();
    }
    
    @Override
    protected List<T> initializePopulation(SchedulingProblem<T> problem) {
        // 随机初始化或根据业务规则初始化
        List<T> population = new ArrayList<>();
        for (int i = 0; i < config.getPopulationSize(); i++) {
            T solution = randomInitialization(problem);
            population.add(solution);
        }
        return population;
    }
    
    @Override
    protected void evaluatePopulation(List<T> population, SchedulingProblem<T> problem) {
        for (T solution : population) {
            double[] objectives = calculateObjectives(solution, problem);
            
            // 应用约束惩罚
            ConstraintManager<T> constraints = problem.getConstraintManager();
            if (!constraints.satisfiesAllConstraints(solution)) {
                // 在目标函数中添加惩罚项
                double penalty = constraints.calculatePenalty(solution);
                objectives[0] = objectives[0] + penalty * config.getPenaltyMultiplier();
            }
            
            // 存储目标值（具体方式取决于T的类型）
            storeObjectives(solution, objectives);
        }
    }
    
    @Override
    protected List<T> environmentalSelection(List<T> parents, List<T> offspring, SchedulingProblem<T> problem) {
        // 合并父代和子代
        List<T> combinedPopulation = new ArrayList<>(parents);
        combinedPopulation.addAll(offspring);
        
        // 快速非支配排序
        List<List<T>> fronts = fastNonDominatedSort(combinedPopulation, problem);
        
        List<T> newPopulation = new ArrayList<>();
        int i = 0;
        
        // 选择前面的完整的前沿
        while (newPopulation.size() + fronts.get(i).size() <= config.getPopulationSize()) {
            newPopulation.addAll(fronts.get(i));
            i++;
        }
        
        // 如果加上下一届会超过种群大小，则使用拥挤度选择
        if (newPopulation.size() < config.getPopulationSize()) {
            // 对下一届根据拥挤度排序
            crowdingDistanceAssignment(fronts.get(i));
            fronts.get(i).sort(Comparator.comparingDouble(
                sol -> -getObjectiveProperty(sol, "crowdingDistance")));
            
            // 选择部分个体填满种群
            int remainingSlots = config.getPopulationSize() - newPopulation.size();
            newPopulation.addAll(fronts.get(i).subList(0, remainingSlots));
        }
        
        return newPopulation;
    }
    
    @Override
    protected List<T> extractBestSolutions(List<T> population) {
        // 返回第一前沿（非支配解集）
        SchedulingProblem<T> dummyProblem = null; // 实际使用中需要传递problem参数
        List<List<T>> fronts = fastNonDominatedSort(population, dummyProblem);
        return fronts.size() > 0 ? fronts.get(0) : new ArrayList<>();
    }
    
    /**
     * 快速非支配排序
     */
    protected List<List<T>> fastNonDominatedSort(List<T> population, SchedulingProblem<T> problem) {
        // 实现快速非支配排序算法
        // (具体实现参见core_components.md中的算法)
    }
    
    /**
     * 拥挤距离分配
     */
    protected void crowdingDistanceAssignment(List<T> front) {
        // 实现拥挤距离分配算法
        // (具体实现参见core_components.md中的算法)
    }
}
```

### 3.2 标准配置类

```java
public class OptimizerConfig {
    private int populationSize = 50;
    private int maxGenerations = 100;
    private double mutationRate = 0.1;
    private double crossoverRate = 0.9;
    private int tournamentSize = 5;
    private double penaltyMultiplier = 1000.0;
    private boolean useElitism = true;
    private double convergenceThreshold = 0.001;
    
    // getters and setters
    public int getPopulationSize() { return populationSize; }
    public void setPopulationSize(int populationSize) { this.populationSize = populationSize; }
    
    // 其他 getter/setter 方法...
}
```

## 4. 实现建议

### 4.1 编码方式设计

```java
/**
 * 染色体编码示例 - 物料-资源矩阵模式
 * 每个解表示一个调度方案，结构为 List<List<ResourceIndex>>
 * 外层：对应各项任务
 * 内层：每项任务分配的资源序列
 */
public class SchedulingSolution {
    private List<List<Integer>> geneStructure; // 任务-资源分配结构
    private double[] objectives;              // 多目标值
    private int rank;                         // Pareto等级
    private double crowdingDistance;          // 拥挤距离
}
```

### 4.2 自定义操作算子

```java
// 自定义调度专用交叉算子
public class SchedulingCrossoverOperator<T> implements CrossoverOperator<T> {
    @Override
    public T crossover(T parent1, T parent2) {
        // 业务场景相关的交叉操作
        // 例如: 保持关键资源的分配模式，交换部分任务
        return performCustomCrossover(parent1, parent2);
    }
    
    private T performCustomCrossover(T parent1, T parent2) {
        // 根据业务约束定义自定义交叉逻辑
        // 确保交叉后仍满足可行性约束
    }
}

// 约束保持变异算子
public class ConstraintAwareMutationOperator<T> implements MutationOperator<T> {
    @Override
    public T mutate(T individual, double mutationRate) {
        if (Math.random() < mutationRate) {
            // 执行变异但确保不违反关键约束
            return performConstraintPreservingMutation(individual);
        }
        return individual;
    }
}
```

## 5. 集成指南

### 5.1 适配业务特定问题

```java
public class ProductionSchedulingProblem implements SchedulingProblem<ProductionSolution> {
    private double[] demand;
    private double[][] capabilityMatrix;
    private Map<String, Double> constraintParams;
    
    @Override
    public int getResourceCount() {
        return capabilityMatrix.length;
    }
    
    @Override
    public int getTaskCount() {
        return demand.length;
    }
    
    // 实现其他必要方法...
}
```

通过这些接口定义和实现指南，您可以轻松地将调度优化算法适配到各种业务场景中。关键是要根据具体的业务需求实现对应的接口，并确保解的编码方式和约束满足条件符合实际情况。