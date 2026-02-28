"""
Layer 1: Task 数据模型单元测试
=============================
验证 Task 的创建、状态转换、序列化。
"""

import json
import pytest
from datetime import datetime

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from manager import Task, TaskStatus


class TestTaskCreation:
    """任务创建和默认值。"""

    def test_default_task(self):
        t = Task(prompt="hello")
        assert t.prompt == "hello"
        assert t.status == TaskStatus.PENDING
        assert t.id  # 有 ID
        assert len(t.id) == 8
        assert t.worktree == ""
        assert t.output == ""
        assert t.error == ""
        assert t.events == []
        assert t.pid is None
        assert t.cost_usd == 0.0

    def test_custom_id(self):
        t = Task(id="custom-1", prompt="test")
        assert t.id == "custom-1"

    def test_unique_ids(self):
        ids = set(Task(prompt=f"t{i}").id for i in range(100))
        assert len(ids) == 100, "IDs should be unique"

    def test_created_at_auto(self):
        t = Task(prompt="test")
        dt = datetime.fromisoformat(t.created_at)
        assert (datetime.now() - dt).total_seconds() < 5

    def test_custom_timeout(self):
        t = Task(prompt="test", timeout=600)
        assert t.timeout == 600

    def test_custom_budget(self):
        t = Task(prompt="test", max_budget=10.0)
        assert t.max_budget == 10.0


class TestTaskSerialization:
    """to_dict / to_detail_dict 序列化。"""

    def test_to_dict_basic(self):
        t = Task(id="ser-1", prompt="hello world")
        d = t.to_dict()
        assert d["id"] == "ser-1"
        assert d["prompt"] == "hello world"
        assert d["status"] == "pending"
        assert "events" not in d  # to_dict 不含 events 列表
        assert "event_count" in d

    def test_to_dict_output_truncation(self):
        t = Task(prompt="big output")
        t.output = "A" * 5000
        d = t.to_dict()
        assert len(d["output"]) == 2000, "Output should be truncated to 2000"

    def test_to_dict_small_output_no_truncation(self):
        t = Task(prompt="small")
        t.output = "ABC"
        d = t.to_dict()
        assert d["output"] == "ABC"

    def test_to_detail_dict_includes_events(self):
        t = Task(prompt="detail")
        t.events = [{"type": "init"}, {"type": "result"}]
        d = t.to_detail_dict()
        assert "events" in d
        assert len(d["events"]) == 2

    def test_to_detail_dict_event_truncation(self):
        t = Task(prompt="many events")
        t.events = [{"type": "evt", "i": i} for i in range(200)]
        d = t.to_detail_dict()
        assert len(d["events"]) == 100, "Events should be truncated to 100"

    def test_json_serializable(self):
        t = Task(prompt="json test")
        t.status = TaskStatus.SUCCESS
        t.cost_usd = 0.05
        j = json.dumps(t.to_dict())
        assert isinstance(j, str)
        parsed = json.loads(j)
        assert parsed["status"] == "success"


class TestTaskStatus:
    """状态枚举。"""

    def test_all_statuses(self):
        statuses = [s.value for s in TaskStatus]
        expected = ["pending", "running", "success", "failed", "timeout", "cancelled"]
        assert set(statuses) == set(expected)

    def test_status_is_string(self):
        assert TaskStatus.PENDING == "pending"
        assert TaskStatus.SUCCESS == "success"

    def test_status_transition(self):
        t = Task(prompt="test")
        assert t.status == TaskStatus.PENDING

        t.status = TaskStatus.RUNNING
        t.started_at = datetime.now().isoformat()
        assert t.status == TaskStatus.RUNNING

        t.status = TaskStatus.SUCCESS
        t.completed_at = datetime.now().isoformat()
        assert t.status == TaskStatus.SUCCESS
