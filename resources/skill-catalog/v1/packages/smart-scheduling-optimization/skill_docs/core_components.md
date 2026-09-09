# 智能调度优化算法技能 - 核心算法组件

## 1. 多目标优化算法核心

### 1.1 快速非支配排序算法 (Fast Non-dominated Sorting)

```java
public List<List<Individual>> fastNonDominatedSort(List<Individual> population) {
    List<List<Individual>> fronts = new ArrayList<>();
    List<Individual> currentFront = new ArrayList<>();
    
    for (Individual p : population) {
        p.dominationCount = 0;
        p.dominatedSolutions = new ArrayList<>();
        
        for (Individual q : population) {
            if (dominates(p, q)) {
                p.dominatedSolutions.add(q);
            } else if (dominates(q, p)) {
                p.dominationCount++;
            }
        }
        
        if (p.dominationCount == 0) {
            p.rank = 0;
            currentFront.add(p);
        }
    }
    
    fronts.add(currentFront);
    int i = 0;
    while (!fronts.get(i).isEmpty()) {
        List<Individual> nextFront = new ArrayList<>();
        for (Individual p : fronts.get(i)) {
            for (Individual q : p.dominatedSolutions) {
                q.dominationCount--;
                if (q.dominationCount == 0) {
                    q.rank = i + 1;
                    nextFront.add(q);
                }
            }
        }
        i++;
        fronts.add(nextFront);
    }
    
    return fronts;
}
```

关键点：
- 时间复杂度：O(M*N^2)，其中M为目标数量，N为种群大小
- 分层存储，每一层为一个非支配前沿
- 为多目标优化提供优先级排序依据

### 1.2 支配关系判断算法

```java
private boolean dominates(Individual p, Individual q) {
    boolean betterInAnyObjective = false;
    
    for (int i = 0; i < p.objectives.length; i++) {
        if (p.objectives[i] > q.objectives[i]) {
            // p在某个目标上比q差，不支配q
            return false;
        } else if (p.objectives[i] < q.objectives[i]) {
            // p在某个目标上比q好
            betterInAnyObjective = true;
        }
    }
    
    // 必须在某一方优于q才能称p支配q
    return betterInAnyObjective;
}
```

应用说明：
- 比较两个解的支配关系
- 确定最优解集合（Pareto前沿）
- 需要业务专家确定目标函数的优化方向

### 1.3 拥挤度计算算法 (Crowding Distance Assignment)

```java
public void crowdingDistanceAssignment(List<Individual> front) {
    int size = front.size();
    if (size == 0) return;
    
    int numObjectives = front.get(0).objectives.length;
    
    // 初始化所有个体的拥挤度为0
    for (Individual individual : front) {
        individual.crowdingDistance = 0.0;
    }
    
    // 对每个目标函数单独处理
    for (int obj = 0; obj < numObjectives; obj++) {
        // 按目标函数值排序
        front.sort(Comparator.comparingDouble(indiv -> indiv.objectives[obj]));
        
        // 边界个体设置为无穷大
        front.get(0).crowdingDistance = Double.POSITIVE_INFINITY;
        front.get(size - 1).crowdingDistance = Double.POSITIVE_INFINITY;
        
        // 计算中间个体的拥挤距离
        double minObjective = front.get(0).objectives[obj];
        double maxObjective = front.get(size - 1).objectives[obj];
        double range = maxObjective - minObjective;
        
        if (range != 0) {
            for (int i = 1; i < size - 1; i++) {
                double distance = (front.get(i + 1).objectives[obj] - front.get(i - 1).objectives[obj]) / range;
                front.get(i).crowdingDistance += distance;
            }
        }
    }
}
```

算法作用：
- 保证解的多样性，避免算法收敛于局部区域
- 为选择操作提供多样性标准
- 避免解分布不均的问题

## 2. 遗传算法基础操作

### 2.1 锦标赛选择算法 (Tournament Selection)

```java
public Individual tournamentSelection(List<Individual> population, int tournamentSize) {
    Individual best = null;
    
    for (int i = 0; i < tournamentSize; i++) {
        Individual candidate = population.get(random.nextInt(population.size()));
        
        if (best == null) {
            best = candidate;
        } else {
            if (isBetterByRankAndDistance(candidate, best)) {
                best = candidate;
            }
        }
    }
    
    return best;
}

private boolean isBetterByRankAndDistance(Individual candidate, Individual current) {
    if (candidate.rank < current.rank) {
        return true;
    } else if (candidate.rank == current.rank) {
        return candidate.crowdingDistance > current.crowdingDistance;
    }
    return false;
}
```

参数说明：
- tournamentSize: 锦标赛规模，一般建议设置为2-7
- 优先选择排名更低（Pareto前沿编号更小）的解
- 相同前沿内选择拥挤度更大的解

### 2.2 遗传算子

### 2.2.1 交叉操作 (Crossover)

```java
public Individual crossover(Individual parent1, Individual parent2) {
    // 实现细节根据解的编码方式有所不同
    // 针对调度问题通常采用：
    // - 模型交叉：保持部分资源分配模式
    // - 路径交叉：在任务执行路径上进行片段交换

    Individual offspring = new Individual();
    offspring.solution = customCrossoverOperator(parent1.solution, parent2.solution);
    
    // 维持解的可行性
    validateAndRepair(offspring);
    
    return offspring;
}
```

### 2.2.2 变异操作 (Mutation)

```java
public Individual mutate(Individual individual, double mutationRate) {
    if (random.nextDouble() < mutationRate) {
        // 变异操作的具体实现，通常包括：
        // - 资源重新分配
        // - 任务顺序交换
        // - 约束保持机制下的调整
        
        applyMutationOperation(individual);
        
        // 确保变异后的解满足约束条件
        validateAndRepair(individual);
    }
    return individual;
}
```

## 3. 组合优化工具

### 3.1 基础组合算法

```java
public List<List<T>> getAllCombinations(List<T> input) {
    List<List<T>> result = new ArrayList<>();
    
    if (input == null || input.isEmpty()) {
        return result;
    }
    
    // 从长度1到输入列表的长度，计算所有可能的组合
    for (int length = 1; length <= input.size(); length++) {
        List<List<T>> combinations = getCombinationsOfSpecificLength(input, length);
        result.addAll(combinations);
    }
    
    return result;
}

private List<List<T>> getCombinationsOfSpecificLength(List<T> input, int length) {
    List<List<T>> result = new ArrayList<>();
    
    if (length == 0) {
        result.add(new ArrayList<>());
        return result;
    }
    
    getCombinationsRecursive(input, length, 0, new ArrayList<>(), result);
    return result;
}
```

应用场景：
- 资源分配问题：计算给定资源的所有可用组合
- 约束检查：验证资源组合是否满足需求
- 多解生成：生成多样性较高的初始解集

## 4. 评价函数

### 4.1 关键性能指标

```java
// 最大完工时间计算 (Makespan)
private double calculateMakespan(double[] machineTimes) {
    double makespan = 0;
    for (double time : machineTimes) {
        if (time > makespan) {
            makespan = time;
        }
    }
    return makespan;
}

// 负载均衡度测量
private double calculateLoadBalance(double[] utilization) {
    double mean = Arrays.stream(utilization).average().orElse(0.0);
    double variance = Arrays.stream(utilization)
        .map(val -> Math.pow(val - mean, 2))
        .average().orElse(0.0);
    return Math.sqrt(variance);
}
```

注意：评价函数的设计直接影响优化目标的方向和质量，需要根据实际业务需求设定。

## 5. 工具类组件

### 5.1 分布工具类

```java
public class DistributionUtils {
    // 将需求按能力比例分配
    public static <T> Map<T, Double> allocateByCapacity(List<T> resources, 
        Map<T, Double> capacities, double totalNeed) {
        
        double totalCapacity = capacities.values().stream()
            .mapToDouble(Double::doubleValue)
            .sum();
            
        if (totalCapacity == 0) return new HashMap<>();
        
        Map<T, Double> allocation = new HashMap<>();
        for (T resource : resources) {
            double ratio = capacities.get(resource) / totalCapacity;
            allocation.put(resource, ratio * totalNeed);
        }
        return allocation;
    }
}
```

## 6. 组件应用要点

1. **算法选择**：根据问题特点选用适合的算子
2. **参数调优**：针对具体问题调整种群大小、生成代数等参数
3. **约束处理**：确保优化解严格满足业务约束条件
4. **性能评估**：定期监控算法收敛情况和解的质量