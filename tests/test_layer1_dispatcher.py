"""
Layer 1: CCDispatcher 单元测试
==============================
验证 CC 子进程的启动、stream-json 解析、超时、错误处理。
使用 Mock 进程，不需要真实 CC CLI。
"""

import asyncio
import json
import os
import pytest
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))
from manager import CCDispatcher, Task, TaskStatus
from conftest import (
    MockProcess, make_success_stream, make_error_stream,
    make_tool_use_stream, assert_task_success, assert_task_failed
)


class TestDispatcherInit:
    """Dispatcher 初始化。"""

    def test_default_init(self):
        d = CCDispatcher()
        assert d.system_prompt == ""

    def test_custom_system_prompt(self):
        d = CCDispatcher(system_prompt="You are a test agent")
        assert d.system_prompt == "You are a test agent"


class TestDispatcherCommandBuild:
    """命令构建逻辑。"""

    def test_build_prompt_simple(self):
        d = CCDispatcher()
        t = Task(prompt="hello world")
        result = d._build_prompt(t)
        assert "hello world" in result

    def test_build_prompt_with_system(self):
        d = CCDispatcher(system_prompt="Be helpful")
        t = Task(prompt="hello")
        result = d._build_prompt(t)
        # system_prompt 通过 --system-prompt 参数传递，不在 prompt 里
        assert "hello" in result


class TestDispatcherEventParsing:
    """stream-json 事件解析。"""

    def test_summarize_init_event(self):
        d = CCDispatcher()
        evt = {"type": "init", "session_id": "abc", "model": "sonnet"}
        summary = d._summarize_event(evt)
        assert summary["type"] == "init"

    def test_summarize_result_event(self):
        d = CCDispatcher()
        evt = {
            "type": "result", "result": "hello",
            "cost_usd": 0.01, "input_tokens": 100, "output_tokens": 50,
            "duration_ms": 2000
        }
        summary = d._summarize_event(evt)
        assert summary["type"] == "result"

    def test_summarize_tool_use_event(self):
        d = CCDispatcher()
        evt = {"type": "tool_use", "tool": {"name": "Bash", "input": {"command": "ls"}}}
        summary = d._summarize_event(evt)
        assert summary["type"] == "tool_use"

    def test_summarize_error_event(self):
        d = CCDispatcher()
        evt = {"type": "error", "error": {"message": "boom", "code": "ERR"}}
        summary = d._summarize_event(evt)
        assert summary["type"] == "error"


class TestDispatcherRun:
    """run() 方法的完整流程（使用 Mock 进程）。"""

    @pytest.mark.asyncio
    async def test_successful_run(self):
        """成功执行一个任务。"""
        d = CCDispatcher()
        t = Task(prompt="test success", timeout=30)

        mock_proc = MockProcess(make_success_stream("HELLO"))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            result = await d.run(t, "/tmp/test-wt")

        assert result.status == TaskStatus.SUCCESS
        assert result.completed_at is not None
        assert result.started_at is not None
        assert result.cost_usd > 0
        assert "HELLO" in result.output

    @pytest.mark.asyncio
    async def test_failed_run(self):
        """CC 返回错误事件。"""
        d = CCDispatcher()
        t = Task(prompt="test error", timeout=30)

        mock_proc = MockProcess(make_error_stream("Something broke"), returncode=1)

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            result = await d.run(t, "/tmp/test-wt")

        assert result.status == TaskStatus.FAILED
        assert "Something broke" in result.error or result.error != ""

    @pytest.mark.asyncio
    async def test_tool_use_run(self):
        """CC 使用工具然后完成。"""
        d = CCDispatcher()
        t = Task(prompt="use a tool", timeout=30)

        mock_proc = MockProcess(make_tool_use_stream("Bash", "file created"))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            result = await d.run(t, "/tmp/test-wt")

        assert result.status == TaskStatus.SUCCESS
        # 应该有 tool_use 事件记录
        tool_events = [e for e in result.events if e.get("type") == "tool_use"]
        assert len(tool_events) >= 1

    @pytest.mark.asyncio
    async def test_event_callback(self):
        """on_event 回调被正确调用。"""
        d = CCDispatcher()
        t = Task(prompt="test callback", timeout=30)
        received = []

        async def capture(evt):
            received.append(evt)

        mock_proc = MockProcess(make_success_stream("OK"))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            await d.run(t, "/tmp/test-wt", on_event=capture)

        assert len(received) > 0
        types = [e["type"] for e in received]
        # on_event 回调发出的是包装事件: task_started, task_event, task_completed
        assert "task_started" in types or "task_event" in types or "task_completed" in types

    @pytest.mark.asyncio
    async def test_task_completes_with_output(self):
        """任务完成后有输出内容。"""
        d = CCDispatcher()
        t = Task(prompt="test output", timeout=30)

        mock_proc = MockProcess(make_success_stream("RESULT_DATA"))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            result = await d.run(t, "/tmp/test-wt")

        assert result.status == TaskStatus.SUCCESS
        assert len(result.output) > 0
        assert len(result.events) > 0

    @pytest.mark.asyncio
    async def test_env_bypass(self):
        """验证 CLAUDECODE 和 CLAUDE_CODE_ENTRYPOINT 被移除。"""
        d = CCDispatcher()
        t = Task(prompt="test env", timeout=30)
        captured_env = {}

        mock_proc = MockProcess(make_success_stream("OK"))

        original_create = asyncio.create_subprocess_exec

        async def capture_exec(*args, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return mock_proc

        with patch("asyncio.create_subprocess_exec", side_effect=capture_exec):
            # 设置环境变量
            os.environ["CLAUDECODE"] = "1"
            os.environ["CLAUDE_CODE_ENTRYPOINT"] = "test"
            try:
                await d.run(t, "/tmp/test-wt")
            finally:
                os.environ.pop("CLAUDECODE", None)
                os.environ.pop("CLAUDE_CODE_ENTRYPOINT", None)

        # 传给子进程的 env 不应包含这两个变量
        assert "CLAUDECODE" not in captured_env
        assert "CLAUDE_CODE_ENTRYPOINT" not in captured_env
