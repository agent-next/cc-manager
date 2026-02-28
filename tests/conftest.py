"""
CC-Manager 测试配置
==================
共享 fixtures, mock 对象, 和测试工具。
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# 将 manager 加入 path
sys.path.insert(0, str(Path(__file__).parent.parent))
from manager import (
    Task, TaskStatus, CCDispatcher, WorktreePool, RalphLoop,
    WebServer, DEFAULT_WORKERS, DEFAULT_TIMEOUT
)


# ============================================================
# Event Loop
# ============================================================

@pytest.fixture(scope="session")
def event_loop():
    """全局事件循环，避免每个测试重建。"""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# ============================================================
# 临时 Git 仓库
# ============================================================

@pytest.fixture
def tmp_git_repo(tmp_path):
    """创建一个真实的临时 Git 仓库用于测试。"""
    repo = tmp_path / "test-repo"
    repo.mkdir()

    # git init
    subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
    subprocess.run(["git", "checkout", "-b", "main"], cwd=repo, capture_output=True)

    # 初始 commit
    (repo / "README.md").write_text("# Test Repo\n")
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=repo, capture_output=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@test.com",
             "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "test@test.com"}
    )

    # CLAUDE.md
    (repo / "CLAUDE.md").write_text("# Project Rules\n- Test project\n")
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", "docs: add CLAUDE.md"],
        cwd=repo, capture_output=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@test.com",
             "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "test@test.com"}
    )

    yield str(repo)


@pytest.fixture
def tmp_git_repo_with_worktrees(tmp_git_repo):
    """带有 worktree 池的临时仓库。"""
    # 创建 .worktrees 目录
    wt_dir = Path(tmp_git_repo) / ".worktrees"
    wt_dir.mkdir(exist_ok=True)
    yield tmp_git_repo


# ============================================================
# Task Fixtures
# ============================================================

@pytest.fixture
def sample_task():
    """创建一个样本 Task。"""
    return Task(
        id="test-001",
        prompt="respond with exactly: HELLO_WORLD",
        timeout=60,
        max_budget=1.0,
    )


@pytest.fixture
def sample_tasks():
    """创建多个测试任务。"""
    return [
        Task(id=f"batch-{i:03d}", prompt=f"Task {i}: say hello_{i}", timeout=30)
        for i in range(5)
    ]


# ============================================================
# Mock CC Process
# ============================================================

def make_cc_stream_output(events: list[dict]) -> bytes:
    """生成模拟的 CC stream-json 输出。"""
    lines = []
    for evt in events:
        lines.append(json.dumps(evt))
    return "\n".join(lines).encode()


def make_success_stream(text: str = "HELLO_WORLD") -> bytes:
    """生成一个成功完成的 CC stream 输出。"""
    events = [
        {"type": "init", "session_id": "test-session", "model": "sonnet"},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}},
        {"type": "result", "result": text,
         "cost_usd": 0.01, "input_tokens": 100, "output_tokens": 50,
         "duration_ms": 2000, "duration_api_ms": 1500},
    ]
    return make_cc_stream_output(events)


def make_error_stream(error_msg: str = "Something failed") -> bytes:
    """生成一个失败的 CC stream 输出。"""
    events = [
        {"type": "init", "session_id": "test-session", "model": "sonnet"},
        {"type": "error", "error": {"message": error_msg, "code": "INTERNAL_ERROR"}},
    ]
    return make_cc_stream_output(events)


def make_tool_use_stream(tool_name: str = "Bash", result: str = "OK") -> bytes:
    """生成包含工具调用的 CC stream 输出。"""
    events = [
        {"type": "init", "session_id": "test-session", "model": "sonnet"},
        {"type": "tool_use", "tool": {"name": tool_name, "input": {"command": "echo test"}}},
        {"type": "tool_result", "tool": {"name": tool_name}, "result": result},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done"}]}},
        {"type": "result", "result": "Done",
         "cost_usd": 0.02, "input_tokens": 200, "output_tokens": 100,
         "duration_ms": 5000, "duration_api_ms": 4000},
    ]
    return make_cc_stream_output(events)


class MockProcess:
    """模拟 asyncio subprocess。"""

    def __init__(self, stream_data: bytes, returncode: int = 0, delay: float = 0):
        self.stdout = AsyncStreamReader(stream_data)
        self.stderr = AsyncStreamReader(b"")
        self.returncode = returncode
        self.pid = os.getpid()
        self._delay = delay

    async def wait(self):
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        return self.returncode

    def kill(self):
        pass

    def terminate(self):
        pass


class AsyncStreamReader:
    """模拟异步流读取器，支持 async for 迭代。"""

    def __init__(self, data: bytes):
        self._lines = [l + b"\n" for l in data.split(b"\n") if l.strip()]
        self._index = 0

    async def readline(self) -> bytes:
        if self._index < len(self._lines):
            line = self._lines[self._index]
            self._index += 1
            return line
        return b""

    def at_eof(self) -> bool:
        return self._index >= len(self._lines)

    async def read(self) -> bytes:
        """读取所有剩余数据。"""
        remaining = b"".join(self._lines[self._index:])
        self._index = len(self._lines)
        return remaining

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        if self._index < len(self._lines):
            line = self._lines[self._index]
            self._index += 1
            return line
        raise StopAsyncIteration


# ============================================================
# 辅助函数
# ============================================================

def assert_task_success(task: Task):
    """断言任务成功完成。"""
    assert task.status == TaskStatus.SUCCESS, f"Expected SUCCESS, got {task.status}: {task.error}"
    assert task.completed_at is not None
    assert task.started_at is not None


def assert_task_failed(task: Task):
    """断言任务失败。"""
    assert task.status in (TaskStatus.FAILED, TaskStatus.TIMEOUT)
    assert task.completed_at is not None


def count_worktrees(repo_path: str) -> int:
    """计算仓库中的 worktree 数量。"""
    result = subprocess.run(
        ["git", "worktree", "list"], cwd=repo_path, capture_output=True, text=True
    )
    # 第一行是 main repo 自身
    lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
    return len(lines) - 1  # 减去 main


def git_log_oneline(repo_path: str, n: int = 10) -> list[str]:
    """获取最近的 git log。"""
    result = subprocess.run(
        ["git", "log", "--oneline", f"-{n}"],
        cwd=repo_path, capture_output=True, text=True
    )
    return result.stdout.strip().split("\n")
