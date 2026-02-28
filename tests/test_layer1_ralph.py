"""
Layer 1: RalphLoop 单元测试
============================
验证任务队列、调度循环、并发执行。
使用 Mock Dispatcher 和 Mock WorktreePool。
"""

import asyncio
import pytest
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))
from manager import RalphLoop, CCDispatcher, WorktreePool, Task, TaskStatus
from conftest import assert_task_success


class MockWorktreePool:
    """模拟 WorktreePool。"""

    def __init__(self, count=3):
        self._available = [(f"worker-{i}", f"/tmp/wt-{i}") for i in range(count)]
        self._busy = []
        self.pool_size = count
        # 模拟 worktrees dict (RalphLoop._loop 会访问)
        self.worktrees = {
            f"worker-{i}": {"path": f"/tmp/wt-{i}", "busy": False, "current_task": None}
            for i in range(count)
        }

    async def init_pool(self):
        pass

    async def acquire(self):
        if not self._available:
            return None
        w = self._available.pop(0)
        self._busy.append(w)
        name = w[0]
        self.worktrees[name]["busy"] = True
        return w

    async def release(self, name, merge=True):
        for w in self._busy:
            if w[0] == name:
                self._busy.remove(w)
                self._available.append(w)
                self.worktrees[name]["busy"] = False
                self.worktrees[name]["current_task"] = None
                return True
        return False

    @property
    def available_count(self):
        return len(self._available)

    @property
    def busy_count(self):
        return len(self._busy)


class MockDispatcher:
    """模拟 CCDispatcher，立即完成任务。"""

    def __init__(self, delay=0.01, fail=False):
        self.delay = delay
        self.fail = fail
        self.call_count = 0
        self.system_prompt = ""

    async def run(self, task, workdir=None, on_event=None):
        self.call_count += 1
        await asyncio.sleep(self.delay)
        task.started_at = "2026-01-01T00:00:00"
        task.completed_at = "2026-01-01T00:00:01"

        if self.fail:
            task.status = TaskStatus.FAILED
            task.error = "Mock failure"
        else:
            task.status = TaskStatus.SUCCESS
            task.output = f"OK from task {task.id}"
            task.cost_usd = 0.01

        return task


class TestRalphLoopSubmit:
    """任务提交。"""

    @pytest.mark.asyncio
    async def test_submit_single_task(self):
        """提交一个任务。"""
        pool = MockWorktreePool(count=2)
        dispatcher = MockDispatcher()
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        task = Task(prompt="hello")
        submitted = await ralph.submit(task)
        assert submitted.id == task.id
        assert submitted.status == TaskStatus.PENDING

    @pytest.mark.asyncio
    async def test_submit_multiple_tasks(self):
        """提交多个任务。"""
        pool = MockWorktreePool(count=5)
        dispatcher = MockDispatcher()
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        tasks = [Task(prompt=f"task {i}") for i in range(5)]
        for t in tasks:
            await ralph.submit(t)

        assert len(ralph.all_tasks) == 5


class TestRalphLoopExecution:
    """任务执行和调度。"""

    @pytest.mark.asyncio
    async def test_start_and_process(self):
        """启动循环，任务被执行。"""
        pool = MockWorktreePool(count=2)
        dispatcher = MockDispatcher(delay=0.01)
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()
        task = Task(prompt="process me")
        await ralph.submit(task)

        # 等待任务完成
        for _ in range(50):
            await asyncio.sleep(0.05)
            if task.status in (TaskStatus.SUCCESS, TaskStatus.FAILED):
                break

        await ralph.stop()
        assert task.status == TaskStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_concurrent_execution(self):
        """多个任务并发执行。"""
        pool = MockWorktreePool(count=3)
        dispatcher = MockDispatcher(delay=0.05)
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()

        tasks = [Task(prompt=f"concurrent {i}") for i in range(3)]
        for t in tasks:
            await ralph.submit(t)

        # 等待所有任务完成
        for _ in range(100):
            await asyncio.sleep(0.05)
            if all(t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED) for t in tasks):
                break

        await ralph.stop()

        succeeded = [t for t in tasks if t.status == TaskStatus.SUCCESS]
        assert len(succeeded) == 3
        assert dispatcher.call_count == 3

    @pytest.mark.asyncio
    async def test_queue_overflow(self):
        """任务多于 workers 时排队。"""
        pool = MockWorktreePool(count=1)
        dispatcher = MockDispatcher(delay=0.05)
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()

        tasks = [Task(prompt=f"queued {i}") for i in range(3)]
        for t in tasks:
            await ralph.submit(t)

        # 等待所有任务完成
        for _ in range(200):
            await asyncio.sleep(0.05)
            if all(t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED) for t in tasks):
                break

        await ralph.stop()

        succeeded = [t for t in tasks if t.status == TaskStatus.SUCCESS]
        assert len(succeeded) == 3, f"Expected 3, got {len(succeeded)}: {[t.status for t in tasks]}"

    @pytest.mark.asyncio
    async def test_failed_task_handling(self):
        """失败的任务正确记录。"""
        pool = MockWorktreePool(count=1)
        dispatcher = MockDispatcher(delay=0.01, fail=True)
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()
        task = Task(prompt="will fail")
        await ralph.submit(task)

        for _ in range(50):
            await asyncio.sleep(0.05)
            if task.status != TaskStatus.PENDING:
                break

        await ralph.stop()
        assert task.status == TaskStatus.FAILED


class TestRalphLoopStats:
    """统计信息。"""

    @pytest.mark.asyncio
    async def test_stats_initial(self):
        """初始统计全为零。"""
        pool = MockWorktreePool(count=2)
        dispatcher = MockDispatcher()
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        stats = ralph.get_stats()
        assert stats["total_tasks"] == 0
        assert stats["by_status"] == {}
        assert stats["active_workers"] == 0
        assert stats["available_workers"] == 2
        assert stats["total_cost_usd"] == 0

    @pytest.mark.asyncio
    async def test_stats_after_execution(self):
        """执行后统计正确。"""
        pool = MockWorktreePool(count=2)
        dispatcher = MockDispatcher(delay=0.01)
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()

        tasks = [Task(prompt=f"stat {i}") for i in range(3)]
        for t in tasks:
            await ralph.submit(t)

        for _ in range(100):
            await asyncio.sleep(0.05)
            if all(t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED) for t in tasks):
                break

        await ralph.stop()

        stats = ralph.get_stats()
        assert stats["total_tasks"] == 3
        assert stats["by_status"].get("success", 0) == 3
        assert stats["total_cost_usd"] == pytest.approx(0.03, abs=0.001)


class TestRalphLoopLifecycle:
    """生命周期管理。"""

    @pytest.mark.asyncio
    async def test_start_stop(self):
        """start 和 stop 正常工作。"""
        pool = MockWorktreePool(count=1)
        dispatcher = MockDispatcher()
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()
        assert ralph._running

        await ralph.stop()
        assert not ralph._running

    @pytest.mark.asyncio
    async def test_double_stop(self):
        """重复 stop 不报错。"""
        pool = MockWorktreePool(count=1)
        dispatcher = MockDispatcher()
        ralph = RalphLoop(dispatcher=dispatcher, pool=pool)

        await ralph.start()
        await ralph.stop()
        await ralph.stop()  # 不应抛异常
