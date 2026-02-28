# CC-Manager 验收标准 & 测试方案

## 验收哲学

胡渊鸣的 Step 10 说"不看代码，只看结果"。我们对自己的 CC-Manager 也采用同样原则：
**每个组件都必须有可自动化验证的验收条件，不依赖人工 review 代码。**

---

## 系统分层验收矩阵

```
Layer 0: CC CLI 能力验证      ← 前提条件，不可控
Layer 1: 单实例调度器          ← Phase 1 核心
Layer 2: 任务队列 Ralph Loop   ← Phase 1 核心
Layer 3: Web 界面              ← Phase 1 交互
Layer 4: Git Worktree 并行     ← Phase 2 核心
Layer 5: 自动 Merge            ← Phase 2 核心
Layer 6: 质量门禁              ← Phase 3
Layer 7: DAG 调度              ← Phase 3
Layer 8: 可观测性              ← Phase 4
```

---

## Layer 0: CC CLI 能力验证

### 意义
整个系统建立在 `claude -p` 非交互模式之上。如果这个不 work，后面全白搭。

### 测试用例

| ID | 测试项 | 命令 | 通过标准 | 验证方法 |
|----|--------|------|----------|----------|
| L0-1 | 非交互模式可运行 | `claude -p "echo hello" --print` | 返回包含 "hello" 相关文本，退出码 0 | `$? == 0` + 输出非空 |
| L0-2 | JSON 输出格式 | `claude -p "说hi" --output-format json` | 返回合法 JSON | `python3 -c "import json; json.loads(output)"` |
| L0-3 | Stream-JSON 输出 | `claude -p "说hi" --output-format stream-json` | 每行都是合法 JSON，包含 type 字段 | 逐行 `json.loads()`，检查 `type` 存在 |
| L0-4 | 权限跳过 | `claude -p "touch /tmp/cc-test-file" --dangerously-skip-permissions` | `/tmp/cc-test-file` 被创建 | `test -f /tmp/cc-test-file` |
| L0-5 | verbose 模式 | `claude -p "说hi" --output-format stream-json --verbose` | 输出行数 > 非verbose | 比较行数 |
| L0-6 | 预算控制 | `claude -p "说hi" --max-budget-usd 0.01` | 正常执行或因预算停止 | 退出码检查 |
| L0-7 | 模型指定 | `claude -p "说hi" --model sonnet` | 正常返回 | 退出码 0 |
| L0-8 | worktree 内置 | `claude -p "说hi" --worktree test-w` | 自动创建 worktree | `git worktree list` 包含 test-w |
| L0-9 | 嵌套限制绕过 | `unset CLAUDECODE && claude -p "说hi"` | 可以运行 | 退出码 0 |
| L0-10 | system-prompt | `claude -p "回答YES" --system-prompt "你只能回答YES"` | 输出包含 YES | grep |

### 自动化验证脚本

```bash
#!/bin/bash
# test_layer0.sh - CC CLI 能力验证
# 在目标 EC2/服务器上运行

PASS=0; FAIL=0; SKIP=0

run_test() {
    local id="$1" desc="$2" cmd="$3" check="$4"
    echo -n "[$id] $desc ... "
    if eval "$cmd" > /tmp/cc_test_out 2>&1; then
        if eval "$check"; then
            echo "PASS ✓"
            ((PASS++))
        else
            echo "FAIL ✗ (check failed)"
            ((FAIL++))
        fi
    else
        echo "FAIL ✗ (command failed, exit=$?)"
        ((FAIL++))
    fi
}

# 必须在 git repo 中运行
cd /tmp && mkdir -p cc-test-repo && cd cc-test-repo
git init 2>/dev/null; touch .gitkeep; git add . ; git commit -m "init" 2>/dev/null

# 清除嵌套限制
unset CLAUDECODE

run_test "L0-1" "非交互模式" \
    "claude -p 'respond with exactly: PING_OK' --print" \
    "grep -qi 'PING_OK' /tmp/cc_test_out"

run_test "L0-2" "JSON输出" \
    "claude -p 'say ok' --output-format json --print" \
    "python3 -c 'import json,sys; json.loads(open(\"/tmp/cc_test_out\").read())'"

run_test "L0-3" "Stream-JSON" \
    "claude -p 'say ok' --output-format stream-json --print" \
    "python3 -c '
import json
lines = open(\"/tmp/cc_test_out\").readlines()
assert len(lines) > 0
for l in lines:
    if l.strip():
        obj = json.loads(l)
        assert \"type\" in obj
'"

echo ""
echo "========================================="
echo "结果: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
echo "========================================="
```

---

## Layer 1: 单实例调度器

### 验收条件

| ID | 测试项 | 通过标准 | 验证方法 |
|----|--------|----------|----------|
| L1-1 | 能启动CC子进程 | subprocess 成功启动，PID > 0 | 检查进程存在 |
| L1-2 | 能实时读取stream-json | 每行事件都能被解析 | 解析回调被调用 > 0 次 |
| L1-3 | 能检测任务完成 | CC 退出后状态变为 SUCCESS/FAILED | 状态机断言 |
| L1-4 | 能检测任务超时 | 超过设定时间自动 kill | 设 timeout=30s，给一个会超时的任务 |
| L1-5 | 能捕获错误 | CC 报错时 error 字段非空 | 给一个必然失败的任务 |
| L1-6 | 输出被保存 | 完整的 JSON 日志写入文件 | 文件存在且可解析 |
| L1-7 | 工作目录隔离 | CC 在指定目录运行 | 检查生成文件的路径 |

### 关键测试场景

```python
# test_layer1.py

async def test_happy_path():
    """L1-HP: 正常任务执行"""
    task = Task(
        prompt="在当前目录创建一个 hello.txt，内容写 'CC_WORKS'",
        timeout=120
    )
    result = await dispatcher.run(task, workdir="/tmp/cc-test")
    assert result.status == TaskStatus.SUCCESS
    assert os.path.exists("/tmp/cc-test/hello.txt")
    assert "CC_WORKS" in open("/tmp/cc-test/hello.txt").read()

async def test_timeout():
    """L1-TO: 超时检测"""
    task = Task(
        prompt="请等待 300 秒然后说 done",  # 故意超时
        timeout=10
    )
    result = await dispatcher.run(task, workdir="/tmp/cc-test")
    assert result.status == TaskStatus.TIMEOUT

async def test_failure_detection():
    """L1-FD: 错误检测"""
    task = Task(
        prompt="请读取 /nonexistent/impossible/path.txt 的内容",
        timeout=60
    )
    result = await dispatcher.run(task, workdir="/tmp/cc-test")
    # 应该完成但有错误信息
    assert result.error != "" or result.status == TaskStatus.FAILED

async def test_git_commit():
    """L1-GC: CC 能 git commit"""
    task = Task(
        prompt="创建 feature.py 写一个 add(a,b) 函数，然后 git add 并 git commit",
        timeout=120
    )
    result = await dispatcher.run(task, workdir="/tmp/cc-test-repo")
    assert result.status == TaskStatus.SUCCESS
    # 验证 git log 有新 commit
    log = subprocess.check_output(
        ["git", "log", "--oneline", "-1"],
        cwd="/tmp/cc-test-repo"
    ).decode()
    assert len(log.strip()) > 0

async def test_stream_json_events():
    """L1-SJ: stream-json 事件解析"""
    events = []
    task = Task(prompt="说 hello", timeout=60)
    result = await dispatcher.run(
        task,
        workdir="/tmp/cc-test",
        on_event=lambda e: events.append(e)
    )
    # 至少有 init 和 result 类型
    event_types = {e.get("type") for e in events}
    assert "result" in event_types or len(events) > 0
```

---

## Layer 2: Ralph Loop 任务队列

### 验收条件

| ID | 测试项 | 通过标准 | 验证方法 |
|----|--------|----------|----------|
| L2-1 | 队列 FIFO | 3个任务按顺序执行 | 检查完成时间戳顺序 |
| L2-2 | 队列为空时等待 | 不消耗 CPU，不崩溃 | 等 10s 后加任务，正常执行 |
| L2-3 | 连续执行 | 5个任务自动连续完成 | 所有任务 status == SUCCESS |
| L2-4 | 失败不阻塞 | 任务2失败，任务3仍执行 | 任务3 status == SUCCESS |
| L2-5 | 动态添加 | 执行中添加新任务，被执行 | 新任务被完成 |
| L2-6 | 优雅停止 | 发送停止信号，当前任务完成后退出 | 不丢失进行中任务 |

### 关键测试场景

```python
async def test_ralph_loop_fifo():
    """L2-1: 三个任务按顺序执行"""
    results = []
    for i in range(3):
        queue.put(Task(
            prompt=f"创建 task_{i}.txt 内容写 'TASK_{i}'",
            timeout=120
        ))

    await ralph_loop.run_until_empty(max_wait=600)

    for i in range(3):
        assert os.path.exists(f"/tmp/cc-test-repo/task_{i}.txt")
        content = open(f"/tmp/cc-test-repo/task_{i}.txt").read()
        assert f"TASK_{i}" in content

async def test_ralph_loop_continuous():
    """L2-3: 五个文件创建任务连续完成"""
    files = ["a.py", "b.py", "c.py", "d.py", "e.py"]
    for f in files:
        queue.put(Task(
            prompt=f"创建 {f}，写一个简单的 Python 函数",
            timeout=120
        ))

    await ralph_loop.run_until_empty(max_wait=900)

    created = [f for f in files if os.path.exists(f"/tmp/cc-test-repo/{f}")]
    success_rate = len(created) / len(files)
    assert success_rate >= 0.8, f"成功率 {success_rate:.0%} < 80%"

async def test_failure_does_not_block():
    """L2-4: 失败任务不阻塞后续"""
    queue.put(Task(prompt="读取不存在的文件 /xxx/yyy", timeout=30))  # 会失败
    queue.put(Task(prompt="创建 after_fail.txt 写 OK", timeout=120))  # 应该执行

    await ralph_loop.run_until_empty(max_wait=300)

    assert os.path.exists("/tmp/cc-test-repo/after_fail.txt")
```

---

## Layer 3: Web 界面

### 验收条件

| ID | 测试项 | 通过标准 | 验证方法 |
|----|--------|----------|----------|
| L3-1 | 服务启动 | HTTP 200 on / | `curl -s -o /dev/null -w "%{http_code}" localhost:8080` == 200 |
| L3-2 | 移动端适配 | viewport meta 存在 | HTML 包含 `<meta name="viewport"` |
| L3-3 | 提交任务 | POST /api/tasks 返回 task_id | HTTP 201 + JSON 包含 id |
| L3-4 | 查看状态 | GET /api/tasks 返回列表 | JSON 数组，每项有 id/status/prompt |
| L3-5 | 实时更新 | WebSocket 推送状态变化 | WS 连接后收到 status_change 事件 |
| L3-6 | 语音输入框 | 页面包含录音按钮 | DOM 存在 `#voice-btn` |
| L3-7 | 任务详情 | GET /api/tasks/:id 返回详情 | 包含 output, error, events |
| L3-8 | Plan 审批 | Plan 模式任务显示审批按钮 | UI 渲染 approve/reject 按钮 |

### 自动化测试

```python
# test_layer3.py
import requests

BASE = "http://localhost:8080"

def test_server_up():
    r = requests.get(BASE)
    assert r.status_code == 200

def test_mobile_viewport():
    r = requests.get(BASE)
    assert 'name="viewport"' in r.text

def test_submit_task():
    r = requests.post(f"{BASE}/api/tasks", json={
        "prompt": "创建 test.txt"
    })
    assert r.status_code == 201
    data = r.json()
    assert "id" in data
    assert data["status"] == "pending"
    return data["id"]

def test_list_tasks():
    r = requests.get(f"{BASE}/api/tasks")
    assert r.status_code == 200
    tasks = r.json()
    assert isinstance(tasks, list)
    if len(tasks) > 0:
        assert "id" in tasks[0]
        assert "status" in tasks[0]

def test_task_detail():
    task_id = test_submit_task()
    r = requests.get(f"{BASE}/api/tasks/{task_id}")
    assert r.status_code == 200
    data = r.json()
    assert "prompt" in data
    assert "status" in data

def test_websocket():
    """需要 websocket-client 库"""
    import websocket
    ws = websocket.create_connection(f"ws://localhost:8080/ws")
    # 提交一个任务触发状态变更
    requests.post(f"{BASE}/api/tasks", json={"prompt": "say hi"})
    # 等待收到至少一个消息（5秒超时）
    ws.settimeout(5)
    try:
        msg = ws.recv()
        data = json.loads(msg)
        assert "type" in data  # status_change, task_update, etc.
    except websocket.WebSocketTimeoutException:
        pass  # 可接受，首次可能没触发
    ws.close()

# API 契约验证（JSON Schema）
TASK_SCHEMA = {
    "type": "object",
    "required": ["id", "prompt", "status", "created_at"],
    "properties": {
        "id": {"type": "string"},
        "prompt": {"type": "string"},
        "status": {"type": "string", "enum": ["pending", "running", "success", "failed", "timeout"]},
        "created_at": {"type": "string"},
        "started_at": {"type": ["string", "null"]},
        "completed_at": {"type": ["string", "null"]},
        "output": {"type": "string"},
        "error": {"type": "string"},
        "worktree": {"type": ["string", "null"]},
        "events": {"type": "array"}
    }
}
```

---

## Layer 4: Git Worktree 并行

### 验收条件

| ID | 测试项 | 通过标准 | 验证方法 |
|----|--------|----------|----------|
| L4-1 | 创建 worktree 池 | N 个 worktree 被创建 | `git worktree list` 行数 == N+1 |
| L4-2 | 并行执行 | 3个任务同时在不同 worktree 运行 | 3 个 CC 进程同时存在 |
| L4-3 | 互不干扰 | worktree A 的改动不影响 B | 各 worktree 文件独立 |
| L4-4 | worktree 回收 | 任务完成后 worktree 可复用 | 同一 worktree 执行第2个任务成功 |
| L4-5 | 总吞吐量提升 | 5并行 vs 1串行，耗时比 > 2x | 计时对比 |
| L4-6 | 并行 commit | 多个 worktree 同时 commit 无冲突 | 所有 commit 成功 |

### 关键量化测试

```python
async def test_parallel_throughput():
    """L4-5: 并行吞吐量 > 串行 2 倍"""
    import time

    # 5个独立任务（不改同一文件）
    tasks = [
        Task(prompt=f"创建 parallel_{i}.py 写一个函数 func_{i}()", timeout=120)
        for i in range(5)
    ]

    # 串行基准
    t0 = time.time()
    for task in tasks:
        await dispatcher.run(task, workdir="/tmp/serial-test")
    serial_time = time.time() - t0

    # 并行执行
    t0 = time.time()
    await asyncio.gather(*[
        dispatcher.run(task, workdir=pool.acquire()[1])
        for task in tasks
    ])
    parallel_time = time.time() - t0

    speedup = serial_time / parallel_time
    print(f"串行: {serial_time:.1f}s, 并行: {parallel_time:.1f}s, 加速比: {speedup:.1f}x")
    assert speedup >= 2.0, f"加速比 {speedup:.1f}x < 2x"
```

---

## Layer 5: 自动 Merge

### 验收条件

| ID | 测试项 | 通过标准 | 验证方法 |
|----|--------|----------|----------|
| L5-1 | 无冲突 merge | 不同文件的改动自动合并到 main | main 包含所有文件 |
| L5-2 | 冲突检测 | 同一文件改动被检测为冲突 | merger 返回 conflict=True |
| L5-3 | 冲突恢复 | 冲突后 main 不处于 broken 状态 | `git status` 干净 |
| L5-4 | merge 顺序 | commit 时间戳正确 | `git log` 顺序合理 |
| L5-5 | PROGRESS.md 更新 | merge 后经验被记录 | PROGRESS.md 有新条目 |

### 测试场景

```python
async def test_no_conflict_merge():
    """L5-1: 两个不同文件的修改能自动合并"""
    # Worker 1 创建 file_a.py
    # Worker 2 创建 file_b.py
    # 两个都 merge 到 main
    # main 同时包含 file_a.py 和 file_b.py

    t1 = Task(prompt="创建 file_a.py 写函数 a()")
    t2 = Task(prompt="创建 file_b.py 写函数 b()")

    w1_name, w1_path = pool.acquire()
    w2_name, w2_path = pool.acquire()

    await asyncio.gather(
        dispatcher.run(t1, workdir=w1_path),
        dispatcher.run(t2, workdir=w2_path),
    )

    assert pool.release(w1_name) == True  # merge 成功
    assert pool.release(w2_name) == True  # merge 成功

    # main 包含两个文件
    main_files = os.listdir("/tmp/cc-test-repo")
    assert "file_a.py" in main_files
    assert "file_b.py" in main_files

async def test_conflict_detection():
    """L5-2: 同一文件的冲突被检测到"""
    t1 = Task(prompt="创建 shared.py 写 VERSION='1.0'")
    t2 = Task(prompt="创建 shared.py 写 VERSION='2.0'")

    w1_name, w1_path = pool.acquire()
    w2_name, w2_path = pool.acquire()

    await asyncio.gather(
        dispatcher.run(t1, workdir=w1_path),
        dispatcher.run(t2, workdir=w2_path),
    )

    result1 = pool.release(w1_name)
    result2 = pool.release(w2_name)

    # 至少一个应该是冲突
    assert not (result1 and result2), "应该检测到冲突"

    # main 不应处于 broken 状态
    status = subprocess.check_output(
        ["git", "status", "--porcelain"],
        cwd="/tmp/cc-test-repo"
    ).decode()
    assert "UU" not in status, "main 不应有未解决冲突"
```

---

## Layer 6-8: 高级功能（Phase 3-4）

### Layer 6: 质量门禁

| ID | 测试项 | 通过标准 |
|----|--------|----------|
| L6-1 | 语法检查 | Python 文件通过 `python -m py_compile` |
| L6-2 | CC Review | Reviewer CC 返回 APPROVED 或 CHANGES_REQUESTED |
| L6-3 | 门禁拦截 | 质量不合格的代码不被 merge |

### Layer 7: DAG 调度

| ID | 测试项 | 通过标准 |
|----|--------|----------|
| L7-1 | 依赖解析 | A→B→C 的依赖正确识别 |
| L7-2 | 拓扑排序 | 无环图正确排序，有环图报错 |
| L7-3 | 并行度最大化 | 无依赖任务并行执行 |

### Layer 8: 可观测性

| ID | 测试项 | 通过标准 |
|----|--------|----------|
| L8-1 | 实时状态 | Dashboard 显示每个 worker 状态 |
| L8-2 | 成功率统计 | 显示 success/fail/timeout 比例 |
| L8-3 | 耗时统计 | 显示平均/P50/P95 任务耗时 |
| L8-4 | Token 统计 | 显示累计 token 消耗 |

---

## 端到端验收（最终大考）

### E2E-1: "胡渊鸣场景"复现

```
输入：通过手机 Web 界面，用语音输入 5 个独立的功能需求
预期：
  - 5 个任务被并行分配到 5 个 worktree
  - 每个任务在 5 分钟内完成
  - 所有代码自动 merge 到 main
  - 成功率 >= 80%（4/5 成功）
  - 总耗时 < 10 分钟（而非串行的 25 分钟）
  - PROGRESS.md 被更新
  - Web 界面实时显示进度

验证：
  1. git log --oneline | wc -l  # 至少 5 个新 commit
  2. git diff main~5..main --stat  # 显示 5 个新文件
  3. 所有任务 status == SUCCESS 或合理的 FAILED
  4. Web界面截图对比
```

### E2E-2: 鲁棒性测试

```
输入：同时提交 10 个任务，其中：
  - 3 个正常任务
  - 2 个会超时的任务
  - 2 个会失败的任务
  - 3 个正常任务

预期：
  - 系统不崩溃
  - 正常任务全部完成（6/6）
  - 超时任务被正确标记
  - 失败任务被正确标记
  - 队列正常排空
```

### E2E-3: 长时间运行稳定性

```
输入：在 Ralph Loop 中连续跑 2 小时

预期：
  - 内存无泄漏（RSS < 500MB）
  - 无僵尸进程
  - 日志文件有序
  - 可随时添加新任务
  - 成功率保持 > 80%
```

---

## 验收执行流程

```
1. 部署到目标机器（EC2 / 本地 Linux）
2. 运行 test_layer0.sh → 全部 PASS 才继续
3. 启动 CC-Manager
4. 运行 pytest test_layer1.py -v
5. 运行 pytest test_layer2.py -v
6. 运行 pytest test_layer3.py -v
7. 运行 E2E-1 手动验收
8. 运行 E2E-2 鲁棒性验收
9. 输出验收报告
```

---

## 成功率计算公式

```
任务成功率 = (STATUS=SUCCESS 的任务数) / (总任务数) × 100%

目标：
  Phase 1 (单实例): >= 70%
  Phase 2 (并行):   >= 80%
  Phase 3 (智能):   >= 95% (追平胡渊鸣)
  超越目标:         >= 98%
```

---

## 非功能验收

| 维度 | 标准 | 验证方法 |
|------|------|----------|
| 部署时间 | < 10 分钟从零到运行 | 计时 |
| 依赖数量 | < 5 个 Python 包 | `pip list | wc -l` |
| 单文件启动 | `python manager.py` 即可 | 实际操作 |
| 数据备份 | 每小时自动备份 | cron + 检查备份文件 |
| 崩溃恢复 | kill -9 后重启不丢数据 | 实际操作 |
| 移动端体验 | iPhone Safari 可用 | 实际截图 |
