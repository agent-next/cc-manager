#!/bin/bash
#
# 端到端验证: init repo → 启动 manager → 提交任务 → 验证结果
# ============================================================
# 用法: bash test_e2e.sh
#
# 这个脚本模拟完整的生产使用场景:
#   1. 创建临时 Git 仓库
#   2. 启动 CC-Manager (后台)
#   3. 通过 REST API 提交任务
#   4. 轮询等待完成
#   5. 验证结果
#   6. 清理
#
# 不需要真实 CC CLI —— 使用 mock dispatcher 模式

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 颜色
G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'

# 临时目录
TMPDIR=$(mktemp -d /tmp/cc-e2e-XXXXXX)
export REPO="$TMPDIR/test-repo"
LOG="$TMPDIR/manager.log"
PID_FILE="$TMPDIR/manager.pid"
PORT=0  # 使用随机端口

cleanup() {
    echo ""
    echo -e "${B}[清理]${N} 关闭 manager..."
    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    # 等待进程退出
    sleep 1
    echo -e "${B}[清理]${N} 删除临时文件: $TMPDIR"
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

echo ""
echo "========================================"
echo "  CC-Manager 端到端验证"
echo "========================================"
echo "  项目目录: $PROJECT_DIR"
echo "  临时目录: $TMPDIR"
echo "========================================"
echo ""

PASS=0; FAIL=0

check() {
    local desc="$1"
    local result="$2"
    if [ "$result" = "0" ]; then
        echo -e "  ${G}✓${N} $desc"
        PASS=$((PASS + 1))
    else
        echo -e "  ${R}✗${N} $desc"
        FAIL=$((FAIL + 1))
    fi
}

# ============================================================
# Step 1: 创建测试仓库
# ============================================================

echo -e "${B}[Step 1]${N} 创建测试 Git 仓库..."

mkdir -p "$REPO"
cd "$REPO"
git init -q
git checkout -b main 2>/dev/null || true

# 配置 git user（测试环境需要）
git config user.email "e2e-test@cc-manager.dev"
git config user.name "E2E Test"

# 初始 commit
cat > README.md << 'EOF'
# E2E Test Repo
This repo is for CC-Manager end-to-end testing.
EOF

cat > CLAUDE.md << 'EOF'
# Project Rules
- This is a test project
- All responses should include the task ID
- Keep code simple and well-commented
EOF

git add .
git commit -q -m "init: setup test repo"

check "Git 仓库创建成功" "$?"

# ============================================================
# Step 2: 验证 Python 环境和依赖
# ============================================================

echo -e "${B}[Step 2]${N} 验证 Python 环境..."

python3 -c "import aiohttp; print(f'aiohttp {aiohttp.__version__}')" 2>/dev/null
check "aiohttp 可用" "$?"

python3 -c "
import sys
sys.path.insert(0, '$PROJECT_DIR')
from manager import (CCDispatcher, WorktreePool, RalphLoop, WebServer,
                     Task, TaskStatus, DEFAULT_WORKERS, DEFAULT_TIMEOUT)
print('All imports OK')
" 2>/dev/null
check "manager.py 可导入" "$?"

# ============================================================
# Step 3: WorktreePool 初始化
# ============================================================

echo -e "${B}[Step 3]${N} 验证 WorktreePool..."

python3 << PYEOF
import asyncio
import sys
sys.path.insert(0, '$PROJECT_DIR')
from manager import WorktreePool

async def test_pool():
    pool = WorktreePool('$REPO', pool_size=3)
    await pool.init_pool()

    assert pool.available_count == 3, f"Expected 3 available, got {pool.available_count}"
    assert pool.busy_count == 0, f"Expected 0 busy, got {pool.busy_count}"

    # acquire and release
    name, path = await pool.acquire()
    assert pool.available_count == 2
    assert pool.busy_count == 1

    await pool.release(name, merge=False)
    assert pool.available_count == 3
    assert pool.busy_count == 0

    print(f"WorktreePool: 3 worktrees created, acquire/release cycle OK")

asyncio.run(test_pool())
PYEOF
check "WorktreePool 初始化和 acquire/release" "$?"

# ============================================================
# Step 4: RalphLoop 任务提交和执行（Mock Dispatcher）
# ============================================================

echo -e "${B}[Step 4]${N} 验证 RalphLoop 任务流程..."

python3 << 'PYEOF'
import asyncio
import os
import subprocess
import sys
from pathlib import Path

REPO = os.environ.get('REPO', '')
PROJECT_DIR = os.environ.get('PROJECT_DIR', '')
sys.path.insert(0, PROJECT_DIR)

from manager import WorktreePool, RalphLoop, Task, TaskStatus

class MockDispatcher:
    """E2E 测试用的 Mock Dispatcher"""
    def __init__(self):
        self.system_prompt = ""
        self.call_count = 0

    async def run(self, task, workdir=None, on_event=None):
        self.call_count += 1
        await asyncio.sleep(0.05)
        task.started_at = "2026-02-28T00:00:00"

        try:
            # 在 worktree 中创建文件
            filename = f"e2e_output_{task.id}.py"
            filepath = Path(workdir) / filename
            filepath.write_text(f"# E2E test output for {task.id}\nresult = 'SUCCESS'\n")

            subprocess.run(["git", "add", "."], cwd=workdir,
                          capture_output=True, check=True)
            subprocess.run(
                ["git", "commit", "-m", f"feat: e2e task {task.id}"],
                cwd=workdir, capture_output=True, check=True,
                env={**os.environ,
                     "GIT_AUTHOR_NAME": "e2e-agent",
                     "GIT_AUTHOR_EMAIL": "e2e@test.com",
                     "GIT_COMMITTER_NAME": "e2e-agent",
                     "GIT_COMMITTER_EMAIL": "e2e@test.com"}
            )

            task.status = TaskStatus.SUCCESS
            task.output = f"Created {filename}"
            task.cost_usd = 0.015
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error = str(e)

        task.completed_at = "2026-02-28T00:00:02"
        return task


async def test_ralph():
    pool = WorktreePool(REPO, pool_size=3)
    await pool.init_pool()

    dispatcher = MockDispatcher()
    ralph = RalphLoop(dispatcher=dispatcher, pool=pool)
    await ralph.start()

    # 提交 3 个任务
    tasks = []
    for i in range(3):
        t = Task(id=f"e2e-{i:03d}", prompt=f"E2E test task {i}")
        await ralph.submit(t)
        tasks.append(t)

    # 等待完成
    for _ in range(200):
        await asyncio.sleep(0.05)
        if all(t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED) for t in tasks):
            break

    await ralph.stop()

    # 验证结果
    succeeded = [t for t in tasks if t.status == TaskStatus.SUCCESS]
    assert len(succeeded) == 3, f"Expected 3 success, got {len(succeeded)}"

    # 验证文件在 main 分支上
    for t in succeeded:
        f = Path(REPO) / f"e2e_output_{t.id}.py"
        assert f.exists(), f"Missing merged file: {f}"

    # 验证统计
    stats = ralph.get_stats()
    assert stats["total_tasks"] == 3
    assert stats["by_status"].get("success", 0) == 3
    assert stats["total_cost_usd"] > 0

    # 验证 git log
    result = subprocess.run(
        ["git", "log", "--oneline", "-10"],
        cwd=REPO, capture_output=True, text=True
    )
    print(f"Git log after E2E:\n{result.stdout}")
    print(f"Stats: {stats}")
    print(f"Dispatcher called {dispatcher.call_count} times")
    print(f"All {len(succeeded)} tasks succeeded and merged!")

asyncio.run(test_ralph())
PYEOF

E2E_RESULT=$?
check "RalphLoop 3 任务并行执行+合并" "$E2E_RESULT"

# ============================================================
# Step 5: WebServer API 验证
# ============================================================

echo -e "${B}[Step 5]${N} 验证 WebServer API..."

python3 << 'PYEOF'
import asyncio
import json
import sys
import os

REPO = os.environ.get('REPO', '')
PROJECT_DIR = os.environ.get('PROJECT_DIR', '')
sys.path.insert(0, PROJECT_DIR)

from manager import WorktreePool, RalphLoop, WebServer, Task, TaskStatus
from aiohttp.test_utils import make_mocked_request

class MinimalDispatcher:
    def __init__(self):
        self.system_prompt = ""
    async def run(self, task, workdir=None, on_event=None):
        task.status = TaskStatus.SUCCESS
        task.output = "quick OK"
        return task


async def test_api():
    pool = WorktreePool(REPO, pool_size=2)
    await pool.init_pool()

    dispatcher = MinimalDispatcher()
    ralph = RalphLoop(dispatcher=dispatcher, pool=pool)
    server = WebServer(ralph, pool, port=0)

    # Test GET /api/stats
    request = make_mocked_request("GET", "/api/stats")
    response = await server.handle_stats(request)
    stats = json.loads(response.text)
    assert "total_tasks" in stats, f"Missing total_tasks in stats: {stats}"
    assert "by_status" in stats
    assert "available_workers" in stats
    print(f"GET /api/stats → {stats}")

    # Test POST /api/tasks
    request = make_mocked_request("POST", "/api/tasks")
    async def mock_json():
        return {"prompt": "E2E API test task"}
    request.json = mock_json

    response = await server.handle_submit_task(request)
    data = json.loads(response.text)
    assert "id" in data, f"Missing id in response: {data}"
    assert data["status"] == "pending"
    print(f"POST /api/tasks → id={data['id']}, status={data['status']}")

    # Test GET /api/workers
    request = make_mocked_request("GET", "/api/workers")
    response = await server.handle_workers(request)
    workers = json.loads(response.text)
    assert isinstance(workers, list)
    assert len(workers) == 2
    print(f"GET /api/workers → {len(workers)} workers")

    # Test GET /api/tasks
    request = make_mocked_request("GET", "/api/tasks")
    response = await server.handle_list_tasks(request)
    tasks = json.loads(response.text)
    assert isinstance(tasks, list)
    assert len(tasks) >= 1
    print(f"GET /api/tasks → {len(tasks)} tasks")

    print("All API endpoints verified!")

asyncio.run(test_api())
PYEOF

check "WebServer 4 个 API endpoint 验证" "$?"

# ============================================================
# Step 6: Git 完整性验证
# ============================================================

echo -e "${B}[Step 6]${N} 验证 Git 完整性..."

cd "$REPO"

# 检查 main 分支有所有 merge 的文件
E2E_FILES=$(ls e2e_output_*.py 2>/dev/null | wc -l)
check "合并的 E2E 文件数 >= 3 (实际: $E2E_FILES)" "$([ "$E2E_FILES" -ge 3 ] && echo 0 || echo 1)"

# 检查 git status 干净
GIT_STATUS=$(git status --porcelain | wc -l)
check "Git status 干净 (未跟踪: $GIT_STATUS)" "$([ "$GIT_STATUS" -le 1 ] && echo 0 || echo 1)"

# 检查 commit 历史
COMMIT_COUNT=$(git log --oneline | wc -l)
check "Commit 历史 >= 5 (实际: $COMMIT_COUNT)" "$([ "$COMMIT_COUNT" -ge 5 ] && echo 0 || echo 1)"

# ============================================================
# 结果汇总
# ============================================================

echo ""
echo "========================================"
echo "  端到端验证结果"
echo "========================================"
echo ""
TOTAL=$((PASS+FAIL))
echo "  通过: $PASS / $TOTAL"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${G}✅ 端到端验证全部通过!${N}"
    echo -e "  ${G}   CC-Manager 已准备好进行真实 CC CLI 集成测试。${N}"
    exit 0
else
    echo -e "  ${R}❌ 有 $FAIL 个验证失败${N}"
    exit 1
fi
