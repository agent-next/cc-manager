# Agent 飞轮 (Agent Flywheel) 扩展设计

> CC-Manager V1 → V2 演进路线：从线性调度到指数级自治

## 0. 核心洞察

**底层能力在指数增长，编排系统必须跟上。**

Claude Code 自身已经具备启动 Team Agents 的能力——每个 CC 实例不再只是"单兵"，而是一个能指挥子 agent 的"小队长"。这意味着 CC-Manager 的价值不在于管 10 个"士兵"，而在于管 10 个"将军"，每个将军再带自己的团队。

```
V0 (当前): Manager → 10 CC workers → 10 并行任务
V1 (飞轮): Manager → 10 CC leads → 每个 lead 带 team → 30~100 并行能力
V2 (自治): Manager → 动态 agent 树 → agent 自己决定何时分裂/合并
```

## 1. 飞轮模型

### 1.1 什么是 Agent 飞轮

传统的任务调度是线性的：人写 prompt → agent 执行 → 人检查 → 人写下一个 prompt。飞轮模型让这个循环自动旋转：

```
         ┌─────────────────────┐
         │   任务分解 (Plan)    │
         │  大任务 → 子任务列表  │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   并行执行 (Execute) │
         │  N agents × M subs  │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   自动合并 (Merge)   │
         │  git merge + 冲突   │
         │  解决 + 集成验证     │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   反馈学习 (Learn)   │
         │  PROGRESS.md 更新    │
         │  CLAUDE.md 进化      │
         └──────────┬──────────┘
                    │
                    └──────────→ 回到 Plan（飞轮旋转）
```

关键：每一圈旋转，系统变得更聪明——CLAUDE.md 积累了项目知识，PROGRESS.md 记录了什么有效、什么无效，后续 agent 的成功率自然上升。

### 1.2 从 20% 到 95% 的成功率曲线

胡渊鸣的数据：初始派活成功率 ~20%，最终 ~95%。这不是魔法，是飞轮效应：

| 阶段 | 成功率 | 飞轮状态 |
|------|--------|---------|
| 冷启动 | ~20% | CLAUDE.md 空，agent 不了解项目 |
| 第一圈 | ~40% | 几个成功案例写入 PROGRESS.md |
| 第二圈 | ~60% | CLAUDE.md 被手动/自动补充规则 |
| 持续运转 | ~80% | 常见模式都有经验，只有新场景会失败 |
| 稳态 | ~95% | CLAUDE.md 覆盖大部分情况，剩余 5% 是真正的 edge case |

## 2. V1 架构：分层 Agent 树

### 2.1 三层 Agent 模型

```
┌─────────────────────────────────────────────────────────────┐
│                    CC-Manager (编排层)                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  RalphLoop (任务调度) + PlanEngine (任务分解)          │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │                                               │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │          Lead Agent Layer (10 worktrees)              │    │
│  │                                                       │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐                │    │
│  │  │ Lead-0  │ │ Lead-1  │ │ Lead-N  │   ...           │    │
│  │  │ Opus4.6 │ │ Opus4.6 │ │ Opus4.6 │                │    │
│  │  │ (Plan+  │ │ (Plan+  │ │ (Plan+  │                │    │
│  │  │  Code)  │ │  Code)  │ │  Code)  │                │    │
│  │  └────┬────┘ └────┬────┘ └────┬────┘                │    │
│  │       │           │           │                       │    │
│  │  ┌────▼────┐ ┌────▼────┐ ┌────▼────┐                │    │
│  │  │ Team    │ │ Team    │ │ Team    │   Sub-agents    │    │
│  │  │Agents   │ │Agents   │ │Agents   │   由 CC 自身    │    │
│  │  │(Sonnet) │ │(Sonnet) │ │(Sonnet) │   内置管理      │    │
│  │  └─────────┘ └─────────┘ └─────────┘                │    │
│  └─────────────────────────────────────────────────────┘    │
│             │                                               │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │              Git Main (合并层)                         │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

核心变化：CC-Manager 不再直接控制每个 agent 的代码级行为，而是把复杂任务分配给 Lead Agent，由 Lead 利用 CC 内置的 team agent 能力自行组织执行。Manager 只关注 worktree 隔离、合并、资源和预算。

### 2.2 PlanEngine — 任务自动分解

V0 的任务是原子的（一个 prompt → 一个 agent）。V1 引入 PlanEngine，将大任务拆成可并行的子任务：

```python
class PlanEngine:
    """将高层目标分解为可并行执行的子任务。"""

    async def decompose(self, goal: str, codebase_context: str) -> list[SubTask]:
        """
        输入: "实现用户认证系统"
        输出: [
            SubTask("设计数据库schema", deps=[]),
            SubTask("实现注册API", deps=["schema"]),
            SubTask("实现登录API", deps=["schema"]),
            SubTask("实现JWT中间件", deps=[]),
            SubTask("编写单元测试", deps=["注册", "登录", "JWT"]),
            SubTask("编写集成测试", deps=["所有API"]),
        ]
        """
        # 使用 CC 自身做 planning (Opus 模型)
        plan_prompt = self._build_plan_prompt(goal, codebase_context)
        plan = await self.planner.run(plan_prompt)
        return self._parse_plan(plan)

    def build_dependency_graph(self, subtasks: list[SubTask]) -> DAG:
        """构建依赖图，确定并行度。"""
        ...

    def schedule(self, dag: DAG, available_workers: int) -> Schedule:
        """
        根据依赖图和可用 workers 生成调度计划。
        无依赖的任务可以并行，有依赖的按拓扑序执行。
        """
        ...
```

### 2.3 任务类型分级

不是所有任务都需要 Lead + Team 的重型编排：

| 类型 | 复杂度 | Agent 配置 | 示例 |
|------|--------|-----------|------|
| **Atomic** | 单文件修改 | 1 Sonnet agent | 修 typo、加日志 |
| **Standard** | 多文件功能 | 1 Opus lead | 新增 API endpoint |
| **Complex** | 跨模块系统 | 1 Opus lead + team | 实现认证系统 |
| **Epic** | 架构级变更 | PlanEngine 分解 → 多 leads | 数据库迁移 + API 重构 |

```python
class TaskClassifier:
    """根据 prompt 和代码库上下文自动分级。"""

    async def classify(self, prompt: str, repo_stats: dict) -> TaskType:
        # 分析因素:
        # - prompt 涉及的文件数估计
        # - 是否涉及新模块/跨模块
        # - 是否有测试要求
        # - 代码库规模
        ...
```

## 3. 自动化反馈回路

### 3.1 PROGRESS.md 自动维护

每个任务完成后，系统自动更新经验库：

```python
class ProgressTracker:
    """自动记录经验教训到 PROGRESS.md"""

    async def record(self, task: Task, outcome: TaskOutcome):
        entry = {
            "task_type": task.classified_type,
            "prompt_pattern": self._extract_pattern(task.prompt),
            "success": outcome.success,
            "duration": outcome.duration,
            "cost": outcome.cost_usd,
            "files_changed": outcome.files,
            "error_pattern": outcome.error_category if not outcome.success else None,
            "lesson": outcome.lesson,  # agent 自己总结的经验
        }
        await self._append_progress(entry)

    async def get_relevant_lessons(self, new_task: Task) -> list[Lesson]:
        """为新任务检索相关的历史经验。"""
        # 基于 embedding 相似度匹配
        ...
```

### 3.2 CLAUDE.md 自动进化

当失败模式反复出现时，系统自动将经验提炼为规则：

```python
class RuleEvolver:
    """从反复出现的模式中提炼规则。"""

    async def check_and_evolve(self, progress: list[ProgressEntry]):
        # 1. 检测反复失败的模式
        failure_patterns = self._detect_recurring_failures(progress)

        for pattern in failure_patterns:
            if pattern.occurrence_count >= 3:
                # 2. 使用 CC 生成新规则
                rule = await self._generate_rule(pattern)
                # 3. 追加到 CLAUDE.md
                await self._append_rule(rule)
                # 4. 记录规则来源
                log.info(f"New rule added: {rule.summary} (from {pattern.count} failures)")
```

### 3.3 成本控制闭环

```python
class BudgetController:
    """多层预算控制。"""

    def __init__(self):
        self.budget_per_task = 5.0      # 单任务上限
        self.budget_per_hour = 50.0     # 每小时上限
        self.budget_daily = 200.0       # 每日上限
        self.budget_total = 1000.0      # 总预算

    async def can_dispatch(self, task: Task) -> tuple[bool, str]:
        """检查是否可以调度新任务。"""
        if self._hourly_spend() > self.budget_per_hour:
            return False, "Hourly budget exceeded"
        if self._daily_spend() > self.budget_daily:
            return False, "Daily budget exceeded"
        return True, "OK"

    def adjust_model(self, task: Task) -> str:
        """根据剩余预算和任务复杂度选择模型。"""
        remaining = self.budget_daily - self._daily_spend()
        if remaining < 20:
            return "haiku"  # 预算紧张用小模型
        if task.type == TaskType.ATOMIC:
            return "sonnet"  # 简单任务不需要 Opus
        return "opus"        # 复杂任务用最强模型
```

## 4. V2 愿景：自治 Agent 网络

### 4.1 Agent 自我复制

当 CC 能启动 team agents 时，一个自然的延伸是：agent 自己判断何时需要分裂。

```
当前: Manager 决定并行度
V2:   Agent 自己说 "这个任务太大了，我需要 3 个帮手"
```

```python
class AdaptiveDispatcher:
    """支持 agent 动态请求资源。"""

    async def handle_resource_request(self, lead_id: str, request: ResourceRequest):
        """Lead agent 请求更多 worktrees/sub-agents。"""
        if request.type == "more_workers":
            available = self.pool.available_count
            granted = min(request.count, available, self.max_per_lead)
            sub_worktrees = []
            for _ in range(granted):
                wt = await self.pool.acquire()
                if wt:
                    sub_worktrees.append(wt)
            return sub_worktrees

        if request.type == "upgrade_model":
            if self.budget.can_afford_upgrade():
                return {"model": "opus"}
            return {"model": "sonnet", "reason": "budget constraint"}
```

### 4.2 合并冲突自动解决

10+ agents 并行写代码，合并冲突不可避免。V2 引入自动化冲突解决：

```python
class ConflictResolver:
    """Git 合并冲突自动解决。"""

    async def resolve(self, worktree: str, target: str = "main") -> MergeResult:
        result = await self._try_merge(worktree, target)

        if result.has_conflicts:
            # 策略 1: 简单冲突（不同文件修改同一区域）→ 自动选择
            if result.conflict_type == "simple":
                return await self._auto_resolve_simple(result)

            # 策略 2: 语义冲突（逻辑不兼容）→ 启动新 agent 解决
            if result.conflict_type == "semantic":
                resolver_task = Task(
                    prompt=self._build_resolve_prompt(result),
                    timeout=120,
                )
                return await self.dispatcher.run(resolver_task, worktree)

            # 策略 3: 严重冲突 → 人工介入
            return MergeResult(success=False, needs_human=True,
                              conflicts=result.conflicts)

        return result
```

### 4.3 质量门控 (Quality Gate)

飞轮不能只追求速度，还需要质量保证：

```python
class QualityGate:
    """合并前自动质量检查。"""

    async def check(self, worktree: str, task: Task) -> QualityReport:
        checks = await asyncio.gather(
            self._run_linter(worktree),
            self._run_tests(worktree),
            self._check_type_safety(worktree),
            self._review_diff_size(worktree),
        )

        report = QualityReport(checks=checks)

        if report.has_blockers:
            # 给 agent 反馈，让它修复
            fix_task = Task(
                prompt=f"Fix the following issues:\n{report.blocker_summary}",
                parent_id=task.id,
            )
            return report, fix_task

        return report, None
```

## 5. 实现路线图

### Phase 1: 强化基础 (V0 → V0.5) — 1~2 周

当前 V0 已有 60 个测试全部通过。下一步：

- [ ] 端到端集成测试（真实 CC 调用，非 mock）
- [ ] WebSocket 实时推送压力测试
- [ ] 10 worktree 并行合并的冲突处理
- [ ] 预算控制和自动降级
- [ ] 错误重试（指数退避 + 最大重试次数）

### Phase 2: 飞轮 MVP (V1.0) — 2~4 周

- [ ] PlanEngine: 大任务自动分解
- [ ] TaskClassifier: 按复杂度分级
- [ ] ProgressTracker: 自动记录经验
- [ ] CLAUDE.md 自动追加规则
- [ ] BudgetController: 多层预算控制
- [ ] Web UI: 任务依赖图可视化

### Phase 3: Team Agent 集成 (V1.5) — 4~6 周

- [ ] Lead Agent 配置模板
- [ ] CC team agent API 集成
- [ ] AdaptiveDispatcher: 动态资源分配
- [ ] Sub-worktree 管理（嵌套隔离）
- [ ] 跨 team 合并策略

### Phase 4: 自治网络 (V2.0) — 长期

- [ ] ConflictResolver: 自动合并冲突解决
- [ ] QualityGate: 合并前自动检查
- [ ] RuleEvolver: CLAUDE.md 自动进化
- [ ] Agent 间通信协议
- [ ] 分布式 worktree pool（多机器）

## 6. 关键度量

飞轮是否真正转起来，看这些指标：

| 指标 | V0 基线 | V1 目标 | V2 目标 |
|------|---------|---------|---------|
| 并行度 | 10 agents | 10 leads × 3 subs = 30 | 动态, 50~100 |
| 任务成功率 | 手动验证 | >80% 自动 | >95% 自动 |
| 人工干预频率 | 每任务 | 每 5 任务 | 每 20 任务 |
| Commit 频率 | ~1/min | ~3/min | ~5/min |
| 单日产出 (commits) | ~500 | ~1500 | ~3000 |
| 平均成本/commit | ~$0.05 | ~$0.03 | ~$0.02 |
| CLAUDE.md 规则数 | 手动 | 半自动增长 | 自动进化 |
| 冲突解决 | 手动 | 半自动 | 全自动 |

## 7. 设计原则

1. **Agent Ready**: 每一层都先写测试再实现，确保 agent 可以安全接手
2. **渐进复杂度**: 先让简单的转起来，再加复杂度——不要一步到 V2
3. **预算即限速器**: 永远不能无限制烧钱，每层都有硬上限
4. **人在回路**: V1/V2 的"自动"不是"无人"——关键决策仍需人类确认
5. **可观测性优先**: 飞轮转得越快，可观测性越重要——每个 agent 的行为都要可追踪
6. **失败是养料**: 每次失败都应该让系统变好，而不是简单重试

## 8. 与现有系统的对接

当前 `manager.py` 的改造点：

```python
# 现有接口保持不变
class RalphLoop:
    # 新增: PlanEngine 集成
    def __init__(self, dispatcher, pool, on_event=None,
                 plan_engine: Optional[PlanEngine] = None):
        self.plan_engine = plan_engine or PlanEngine()

    async def submit(self, task: Task) -> Task:
        # 新增: 自动分类和分解
        task.type = await self.classifier.classify(task.prompt)

        if task.type == TaskType.EPIC:
            subtasks = await self.plan_engine.decompose(task.prompt)
            for st in subtasks:
                st.parent_id = task.id
                await self._enqueue(st)
        else:
            await self._enqueue(task)

        return task
```

WebServer API 扩展：

```
GET  /api/stats          ← 现有
POST /api/tasks          ← 现有
GET  /api/tasks          ← 现有
GET  /api/tasks/:id      ← 现有
GET  /api/workers        ← 现有
GET  /api/plan/:goal     ← 新增: 预览任务分解
GET  /api/progress       ← 新增: 经验库查询
GET  /api/rules          ← 新增: 当前规则列表
POST /api/rules          ← 新增: 手动添加规则
GET  /api/budget          ← 新增: 预算状态
WS   /ws                 ← 现有
```

---

*文档版本: 2026-02-28 | 作者: CC-Manager Team*
*基于 V0 (60 tests passing) 的实际运行经验编写*
