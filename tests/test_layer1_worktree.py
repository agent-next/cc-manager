"""
Layer 1: WorktreePool 单元测试
===============================
验证 Git Worktree 池的创建、获取、释放、合并。
需要真实 Git 操作，使用 tmp_git_repo fixture。
"""

import asyncio
import os
import pytest
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from manager import WorktreePool
from conftest import count_worktrees


class TestWorktreePoolInit:
    """Worktree 池初始化。"""

    @pytest.mark.asyncio
    async def test_init_creates_worktrees(self, tmp_git_repo):
        """init_pool 创建指定数量的 worktree。"""
        pool = WorktreePool(tmp_git_repo, pool_size=3)
        await pool.init_pool()

        assert count_worktrees(tmp_git_repo) == 3
        assert pool.available_count == 3
        assert pool.busy_count == 0

    @pytest.mark.asyncio
    async def test_init_creates_directories(self, tmp_git_repo):
        """每个 worktree 都有对应的目录。"""
        pool = WorktreePool(tmp_git_repo, pool_size=2)
        await pool.init_pool()

        wt_dir = Path(tmp_git_repo) / ".worktrees"
        dirs = list(wt_dir.iterdir())
        assert len(dirs) == 2
        for d in dirs:
            assert d.is_dir()
            assert (d / "CLAUDE.md").exists(), "Worktree should have CLAUDE.md from main"

    @pytest.mark.asyncio
    async def test_init_worktree_branches(self, tmp_git_repo):
        """每个 worktree 有独立的分支。"""
        pool = WorktreePool(tmp_git_repo, pool_size=3)
        await pool.init_pool()

        result = subprocess.run(
            ["git", "branch"], cwd=tmp_git_repo, capture_output=True, text=True
        )
        branches = result.stdout.strip().split("\n")
        # 应该有 main + 3 个 worker 分支
        assert len(branches) >= 4

    @pytest.mark.asyncio
    async def test_pool_size_10(self, tmp_git_repo):
        """支持 10 个 worktree（核心目标）。"""
        pool = WorktreePool(tmp_git_repo, pool_size=10)
        await pool.init_pool()

        assert pool.available_count == 10
        assert count_worktrees(tmp_git_repo) == 10


class TestWorktreeAcquireRelease:
    """获取和释放 worktree。"""

    @pytest.mark.asyncio
    async def test_acquire_returns_tuple(self, tmp_git_repo):
        """acquire 返回 (name, path) 元组。"""
        pool = WorktreePool(tmp_git_repo, pool_size=2)
        await pool.init_pool()

        result = await pool.acquire()
        assert result is not None
        name, path = result
        assert isinstance(name, str)
        assert isinstance(path, str)
        assert os.path.isdir(path)

    @pytest.mark.asyncio
    async def test_acquire_decrements_available(self, tmp_git_repo):
        """acquire 后 available 减少。"""
        pool = WorktreePool(tmp_git_repo, pool_size=3)
        await pool.init_pool()

        assert pool.available_count == 3
        await pool.acquire()
        assert pool.available_count == 2
        assert pool.busy_count == 1

    @pytest.mark.asyncio
    async def test_acquire_all(self, tmp_git_repo):
        """可以获取所有 worktree。"""
        pool = WorktreePool(tmp_git_repo, pool_size=3)
        await pool.init_pool()

        workers = []
        for _ in range(3):
            w = await pool.acquire()
            assert w is not None
            workers.append(w)

        assert pool.available_count == 0
        assert pool.busy_count == 3

    @pytest.mark.asyncio
    async def test_acquire_none_when_exhausted(self, tmp_git_repo):
        """所有 worktree 被占用时返回 None。"""
        pool = WorktreePool(tmp_git_repo, pool_size=1)
        await pool.init_pool()

        await pool.acquire()
        result = await pool.acquire()
        assert result is None

    @pytest.mark.asyncio
    async def test_release_increments_available(self, tmp_git_repo):
        """release 后 available 增加。"""
        pool = WorktreePool(tmp_git_repo, pool_size=2)
        await pool.init_pool()

        name, path = await pool.acquire()
        assert pool.available_count == 1

        await pool.release(name, merge=False)
        assert pool.available_count == 2
        assert pool.busy_count == 0

    @pytest.mark.asyncio
    async def test_acquire_release_cycle(self, tmp_git_repo):
        """获取-释放循环可重复。"""
        pool = WorktreePool(tmp_git_repo, pool_size=1)
        await pool.init_pool()

        for _ in range(5):
            name, path = await pool.acquire()
            assert pool.available_count == 0
            await pool.release(name, merge=False)
            assert pool.available_count == 1


class TestWorktreeMerge:
    """Worktree 合并到 main。"""

    @pytest.mark.asyncio
    async def test_merge_with_changes(self, tmp_git_repo):
        """worktree 中有 commit 时合并到 main。"""
        pool = WorktreePool(tmp_git_repo, pool_size=1)
        await pool.init_pool()

        name, path = await pool.acquire()

        # 在 worktree 中创建文件并 commit
        test_file = Path(path) / "new_feature.py"
        test_file.write_text("print('hello from worktree')\n")
        subprocess.run(["git", "add", "."], cwd=path, capture_output=True, check=True)
        subprocess.run(
            ["git", "commit", "-m", "feat: add new feature"],
            cwd=path, capture_output=True, check=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "agent", "GIT_AUTHOR_EMAIL": "agent@test.com",
                 "GIT_COMMITTER_NAME": "agent", "GIT_COMMITTER_EMAIL": "agent@test.com"}
        )

        # release with merge
        success = await pool.release(name, merge=True)
        assert success

        # 验证 main 分支有这个文件
        assert (Path(tmp_git_repo) / "new_feature.py").exists()

    @pytest.mark.asyncio
    async def test_release_no_merge(self, tmp_git_repo):
        """merge=False 时不合并。"""
        pool = WorktreePool(tmp_git_repo, pool_size=1)
        await pool.init_pool()

        name, path = await pool.acquire()

        # 创建文件并 commit
        (Path(path) / "should_not_merge.py").write_text("x = 1\n")
        subprocess.run(["git", "add", "."], cwd=path, capture_output=True, check=True)
        subprocess.run(
            ["git", "commit", "-m", "feat: skip merge"],
            cwd=path, capture_output=True, check=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "agent", "GIT_AUTHOR_EMAIL": "agent@test.com",
                 "GIT_COMMITTER_NAME": "agent", "GIT_COMMITTER_EMAIL": "agent@test.com"}
        )

        await pool.release(name, merge=False)

        # main 不应该有这个文件
        assert not (Path(tmp_git_repo) / "should_not_merge.py").exists()


class TestWorktreeStatus:
    """Worktree 池状态查询。"""

    @pytest.mark.asyncio
    async def test_get_status(self, tmp_git_repo):
        """get_status 返回所有 worktree 的状态。"""
        pool = WorktreePool(tmp_git_repo, pool_size=3)
        await pool.init_pool()

        statuses = await pool.get_status()
        assert len(statuses) == 3
        for s in statuses:
            assert "name" in s
            assert "busy" in s
            assert s["busy"] is False  # 初始都是空闲

    @pytest.mark.asyncio
    async def test_status_reflects_acquire(self, tmp_git_repo):
        """acquire 后 status 更新。"""
        pool = WorktreePool(tmp_git_repo, pool_size=2)
        await pool.init_pool()

        name, _ = await pool.acquire()

        statuses = await pool.get_status()
        busy = [s for s in statuses if s["busy"]]
        idle = [s for s in statuses if not s["busy"]]
        assert len(busy) == 1
        assert len(idle) == 1
        assert busy[0]["name"] == name
