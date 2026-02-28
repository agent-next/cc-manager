#!/usr/bin/env python3
"""
CC-Manager V0: Claude Code 多实例编排系统
==========================================
基于胡渊鸣的 CC Manager 系统逆向分析，实现 10 agent 并行调度。

核心组件:
  - CCDispatcher: 单个 CC 实例的启动、监控、超时控制
  - WorktreePool: Git Worktree 池管理（创建/获取/释放/合并）
  - RalphLoop: 持续从队列取任务分配给空闲 worker
  - WebServer: aiohttp Web 界面 + REST API + WebSocket 实时推送

启动方式:
  python3 manager.py --repo /path/to/your/repo --workers 10 --port 8080
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time
import uuid
from asyncio import Queue
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Callable, Any

import aiohttp
from aiohttp import web

# ============================================================================
# 配置
# ============================================================================

DEFAULT_WORKERS = 10
DEFAULT_PORT = 8080
DEFAULT_TIMEOUT = 300  # 5分钟
DEFAULT_MAX_BUDGET = 5.0  # 每任务最多 $5
CC_BINARY = "claude"

# ============================================================================
# 日志
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("cc-manager")

# ============================================================================
# 数据模型
# ============================================================================


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class Task:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    prompt: str = ""
    status: TaskStatus = TaskStatus.PENDING
    worktree: str = ""
    output: str = ""
    error: str = ""
    events: list = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    timeout: int = DEFAULT_TIMEOUT
    max_budget: float = DEFAULT_MAX_BUDGET
    pid: Optional[int] = None
    cost_usd: float = 0.0
    token_input: int = 0
    token_output: int = 0
    retry_count: int = 0

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "prompt": self.prompt,
            "status": self.status.value,
            "worktree": self.worktree,
            "output": self.output[-2000:] if len(self.output) > 2000 else self.output,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "timeout": self.timeout,
            "pid": self.pid,
            "cost_usd": self.cost_usd,
            "token_input": self.token_input,
            "token_output": self.token_output,
            "retry_count": self.retry_count,
            "event_count": len(self.events),
        }
        return d

    def to_detail_dict(self) -> dict:
        d = self.to_dict()
        d["events"] = self.events[-100:]  # 最近100个事件
        d["output"] = self.output  # 完整输出
        return d


# ============================================================================
# CCDispatcher: 单实例调度器
# ============================================================================


class CCDispatcher:
    """启动并监控单个 Claude Code 实例"""

    def __init__(self, system_prompt: str = ""):
        self.system_prompt = system_prompt

    async def run(
        self,
        task: Task,
        workdir: str,
        on_event: Optional[Callable] = None,
    ) -> Task:
        """
        运行单个 CC 实例。

        Args:
            task: 任务对象
            workdir: 工作目录（worktree 路径）
            on_event: 事件回调（用于 WebSocket 推送）

        Returns:
            更新后的 Task 对象
        """
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now().isoformat()
        task.worktree = os.path.basename(workdir)

        # 构建 prompt
        full_prompt = self._build_prompt(task)

        # 构建命令
        cmd = [
            CC_BINARY,
            "-p", full_prompt,
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--verbose",
        ]

        if task.max_budget > 0:
            cmd.extend(["--max-budget-usd", str(task.max_budget)])

        if self.system_prompt:
            cmd.extend(["--system-prompt", self.system_prompt])

        # 构建环境变量（关键：解除 CC 嵌套限制）
        env = {**os.environ}
        env.pop("CLAUDECODE", None)  # 关键！
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)

        log.info(f"[{task.id}] 启动 CC 实例 @ {workdir}")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
                env=env,
            )
            task.pid = proc.pid
            log.info(f"[{task.id}] PID={proc.pid}")

            if on_event:
                await on_event({
                    "type": "task_started",
                    "task_id": task.id,
                    "pid": proc.pid,
                    "worktree": task.worktree,
                })

            # 带超时的流式读取
            try:
                await asyncio.wait_for(
                    self._read_stream(proc, task, on_event),
                    timeout=task.timeout,
                )
            except asyncio.TimeoutError:
                log.warning(f"[{task.id}] 超时 ({task.timeout}s)，终止进程")
                proc.kill()
                await proc.wait()
                task.status = TaskStatus.TIMEOUT
                task.error = f"Task timed out after {task.timeout}s"
                task.completed_at = datetime.now().isoformat()
                if on_event:
                    await on_event({
                        "type": "task_timeout",
                        "task_id": task.id,
                    })
                return task

            # 等待进程退出
            await proc.wait()

            # 读取 stderr
            stderr_data = await proc.stderr.read()
            if stderr_data:
                stderr_text = stderr_data.decode("utf-8", errors="replace")
                if stderr_text.strip():
                    task.error += stderr_text

            # 判断最终状态
            if task.status == TaskStatus.RUNNING:
                if proc.returncode == 0:
                    task.status = TaskStatus.SUCCESS
                else:
                    task.status = TaskStatus.FAILED
                    task.error += f"\nExit code: {proc.returncode}"

        except Exception as e:
            log.error(f"[{task.id}] 异常: {e}")
            task.status = TaskStatus.FAILED
            task.error = str(e)

        task.completed_at = datetime.now().isoformat()
        task.pid = None

        if on_event:
            await on_event({
                "type": "task_completed",
                "task_id": task.id,
                "status": task.status.value,
            })

        log.info(f"[{task.id}] 完成: {task.status.value}")
        return task

    async def _read_stream(
        self,
        proc: asyncio.subprocess.Process,
        task: Task,
        on_event: Optional[Callable],
    ):
        """读取 stream-json 输出流"""
        async for line in proc.stdout:
            line_text = line.decode("utf-8", errors="replace").strip()
            if not line_text:
                continue

            try:
                event = json.loads(line_text)
            except json.JSONDecodeError:
                # 非 JSON 行，当做普通输出
                task.output += line_text + "\n"
                continue

            event_type = event.get("type", "unknown")
            task.events.append({
                "type": event_type,
                "timestamp": datetime.now().isoformat(),
                "data": self._summarize_event(event),
            })

            # 提取有用信息
            if event_type == "result":
                result_data = event.get("result", "")
                if isinstance(result_data, str):
                    task.output += result_data
                elif isinstance(result_data, dict):
                    task.output += json.dumps(result_data, ensure_ascii=False)
                # 提取 cost/token 信息
                cost_info = event.get("cost_usd") or event.get("costUSD")
                if cost_info:
                    task.cost_usd = float(cost_info)
                usage = event.get("usage", {})
                if usage:
                    task.token_input = usage.get("input_tokens", 0)
                    task.token_output = usage.get("output_tokens", 0)
                task.status = TaskStatus.SUCCESS

            elif event_type == "assistant":
                content = event.get("message", {}).get("content", [])
                for block in content if isinstance(content, list) else []:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                        task.output += text + "\n"

            elif event_type == "error":
                task.error += event.get("error", {}).get("message", str(event))
                task.status = TaskStatus.FAILED

            # WebSocket 推送
            if on_event:
                await on_event({
                    "type": "task_event",
                    "task_id": task.id,
                    "event_type": event_type,
                    "event_count": len(task.events),
                })

    def _build_prompt(self, task: Task) -> str:
        """构建发给 CC 的 prompt"""
        return f"""{task.prompt}

完成后请:
1. git add 所有相关文件
2. git commit -m "feat: [简短描述你做了什么]"
"""

    def _summarize_event(self, event: dict) -> dict:
        """精简事件数据，避免存储过大"""
        summary = {"type": event.get("type")}
        if "message" in event:
            msg = event["message"]
            if isinstance(msg, dict):
                summary["role"] = msg.get("role")
                content = msg.get("content", [])
                if isinstance(content, list):
                    summary["blocks"] = len(content)
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "tool_use":
                                summary["tool"] = block.get("name", "?")
        if "error" in event:
            summary["error"] = str(event["error"])[:200]
        return summary


# ============================================================================
# WorktreePool: Git Worktree 池
# ============================================================================


class WorktreePool:
    """管理 Git Worktree 池，支持并行 CC 实例"""

    def __init__(self, repo_path: str, pool_size: int = DEFAULT_WORKERS):
        self.repo_path = os.path.abspath(repo_path)
        self.pool_size = pool_size
        self.worktrees: dict[str, dict] = {}  # name → {path, busy, branch}
        self._lock = asyncio.Lock()

    async def init_pool(self):
        """初始化 worktree 池"""
        worktree_dir = os.path.join(self.repo_path, ".worktrees")
        os.makedirs(worktree_dir, exist_ok=True)

        # 确保在 main 分支
        await self._git("checkout", "main", ignore_error=True)

        for i in range(self.pool_size):
            name = f"worker-{i}"
            path = os.path.join(worktree_dir, name)
            branch = f"worker/{name}"

            if os.path.exists(path):
                # 已存在的 worktree，重置到 main
                log.info(f"Worktree {name} 已存在，重置...")
                await self._git_in(path, "checkout", branch, ignore_error=True)
                await self._git_in(path, "reset", "--hard", "main", ignore_error=True)
            else:
                # 创建新 worktree
                log.info(f"创建 Worktree: {name}")
                # 先删除可能残留的分支
                await self._git("branch", "-D", branch, ignore_error=True)
                result = await self._git(
                    "worktree", "add", "-b", branch, path, "main",
                    ignore_error=True
                )
                if result.returncode != 0:
                    # 如果分支已存在，尝试不创建分支的方式
                    await self._git(
                        "worktree", "add", path, branch,
                        ignore_error=True
                    )

            self.worktrees[name] = {
                "path": path,
                "branch": branch,
                "busy": False,
                "current_task": None,
            }

        log.info(f"Worktree 池初始化完成: {len(self.worktrees)} workers")

    async def acquire(self) -> Optional[tuple[str, str]]:
        """获取空闲 worktree，返回 (name, path) 或 None"""
        async with self._lock:
            for name, info in self.worktrees.items():
                if not info["busy"]:
                    info["busy"] = True
                    # 重置到最新 main
                    await self._git_in(
                        info["path"], "reset", "--hard", "main",
                        ignore_error=True
                    )
                    return name, info["path"]
        return None

    async def release(self, name: str, merge: bool = True) -> bool:
        """释放 worktree 并可选 merge 到 main"""
        async with self._lock:
            if name not in self.worktrees:
                return False

            info = self.worktrees[name]
            merged = True

            if merge:
                merged = await self._merge_to_main(name, info)

            info["busy"] = False
            info["current_task"] = None
            return merged

    async def _merge_to_main(self, name: str, info: dict) -> bool:
        """将 worktree 分支合并到 main"""
        branch = info["branch"]
        wt_path = info["path"]

        # 检查 worktree 是否有新 commit
        result = await self._git(
            "log", f"main..{branch}", "--oneline",
        )
        if not result.stdout.strip():
            log.info(f"[{name}] 没有新 commit，跳过 merge")
            return True

        log.info(f"[{name}] 合并 {branch} → main")

        # checkout main
        result = await self._git("checkout", "main")
        if result.returncode != 0:
            log.error(f"[{name}] checkout main 失败: {result.stderr}")
            return False

        # merge
        result = await self._git("merge", branch, "--no-edit")
        if result.returncode != 0:
            log.warning(f"[{name}] Merge 冲突! 回退...")
            await self._git("merge", "--abort")
            return False

        log.info(f"[{name}] Merge 成功")

        # 重置 worktree 分支到最新 main
        await self._git_in(wt_path, "reset", "--hard", "main", ignore_error=True)

        return True

    async def get_status(self) -> list[dict]:
        """获取所有 worktree 的状态"""
        statuses = []
        for name, info in self.worktrees.items():
            statuses.append({
                "name": name,
                "path": info["path"],
                "busy": info["busy"],
                "current_task": info.get("current_task"),
            })
        return statuses

    @property
    def available_count(self) -> int:
        return sum(1 for info in self.worktrees.values() if not info["busy"])

    @property
    def busy_count(self) -> int:
        return sum(1 for info in self.worktrees.values() if info["busy"])

    async def _git(self, *args, ignore_error=False) -> subprocess.CompletedProcess:
        """在 repo 根目录执行 git 命令"""
        return await self._run_cmd(
            ["git"] + list(args), cwd=self.repo_path, ignore_error=ignore_error
        )

    async def _git_in(self, path, *args, ignore_error=False) -> subprocess.CompletedProcess:
        """在指定目录执行 git 命令"""
        return await self._run_cmd(
            ["git"] + list(args), cwd=path, ignore_error=ignore_error
        )

    async def _run_cmd(self, cmd, cwd, ignore_error=False) -> subprocess.CompletedProcess:
        """异步运行命令"""
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await proc.communicate()
        result = subprocess.CompletedProcess(
            args=cmd,
            returncode=proc.returncode,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )
        if result.returncode != 0 and not ignore_error:
            log.warning(f"CMD failed: {' '.join(cmd)}: {result.stderr.strip()}")
        return result


# ============================================================================
# RalphLoop: 循环调度器
# ============================================================================


class RalphLoop:
    """
    Ralph Loop: 持续从队列取任务分配给空闲 worker。

    工作流:
      1. 从队列取出待执行任务
      2. 获取空闲 worktree
      3. 启动 CC 实例执行任务
      4. 完成后合并到 main
      5. 释放 worktree
      6. 重复
    """

    def __init__(
        self,
        dispatcher: CCDispatcher,
        pool: WorktreePool,
        on_event: Optional[Callable] = None,
    ):
        self.dispatcher = dispatcher
        self.pool = pool
        self.on_event = on_event
        self.task_queue: asyncio.Queue[Task] = asyncio.Queue()
        self.all_tasks: dict[str, Task] = {}  # id → Task
        self._running = False
        self._active_workers: set[str] = set()

    async def start(self):
        """启动 Ralph Loop"""
        self._running = True
        log.info("Ralph Loop 启动")
        asyncio.create_task(self._loop())

    async def stop(self):
        """优雅停止"""
        log.info("Ralph Loop 停止中...")
        self._running = False
        # 等待所有活跃 worker 完成
        while self._active_workers:
            log.info(f"等待 {len(self._active_workers)} 个 worker 完成...")
            await asyncio.sleep(2)
        log.info("Ralph Loop 已停止")

    async def submit(self, task: Task) -> Task:
        """提交任务到队列"""
        self.all_tasks[task.id] = task
        await self.task_queue.put(task)
        log.info(f"任务入队: [{task.id}] {task.prompt[:60]}...")
        if self.on_event:
            await self.on_event({
                "type": "task_queued",
                "task_id": task.id,
                "queue_size": self.task_queue.qsize(),
            })
        return task

    async def _loop(self):
        """主循环"""
        while self._running:
            # 检查队列和可用 worker
            if self.task_queue.empty():
                await asyncio.sleep(1)
                continue

            worker = await self.pool.acquire()
            if worker is None:
                # 所有 worker 都忙
                await asyncio.sleep(2)
                continue

            # 取出任务
            task = await self.task_queue.get()
            name, path = worker

            # 记录 worker 信息
            self.pool.worktrees[name]["current_task"] = task.id
            self._active_workers.add(name)

            # 异步执行，不阻塞循环
            asyncio.create_task(
                self._execute_and_release(task, name, path)
            )

    async def _execute_and_release(self, task: Task, worker_name: str, worker_path: str):
        """执行任务并释放 worker"""
        try:
            log.info(f"[{task.id}] 分配到 {worker_name}")

            await self.dispatcher.run(
                task, workdir=worker_path, on_event=self.on_event
            )

            # 根据结果决定是否 merge
            should_merge = task.status == TaskStatus.SUCCESS
            merged = await self.pool.release(worker_name, merge=should_merge)

            if should_merge and not merged:
                task.error += "\nMerge conflict detected"
                log.warning(f"[{task.id}] Merge 冲突")
            elif not should_merge:
                await self.pool.release(worker_name, merge=False)

        except Exception as e:
            log.error(f"[{task.id}] 执行异常: {e}", exc_info=True)
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now().isoformat()
            await self.pool.release(worker_name, merge=False)

        finally:
            self._active_workers.discard(worker_name)

        # 推送最终状态
        if self.on_event:
            await self.on_event({
                "type": "task_final",
                "task_id": task.id,
                "status": task.status.value,
            })

    def get_stats(self) -> dict:
        """获取运行统计"""
        tasks = list(self.all_tasks.values())
        total = len(tasks)
        by_status = {}
        for t in tasks:
            s = t.status.value
            by_status[s] = by_status.get(s, 0) + 1

        total_cost = sum(t.cost_usd for t in tasks)
        total_input = sum(t.token_input for t in tasks)
        total_output = sum(t.token_output for t in tasks)

        completed = [
            t for t in tasks
            if t.status in (TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.TIMEOUT)
        ]
        success = [t for t in tasks if t.status == TaskStatus.SUCCESS]
        success_rate = len(success) / len(completed) * 100 if completed else 0

        return {
            "total_tasks": total,
            "by_status": by_status,
            "success_rate": round(success_rate, 1),
            "queue_size": self.task_queue.qsize(),
            "active_workers": len(self._active_workers),
            "available_workers": self.pool.available_count,
            "total_workers": self.pool.pool_size,
            "total_cost_usd": round(total_cost, 4),
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "running": self._running,
        }


# ============================================================================
# WebServer: Web 界面 + API + WebSocket
# ============================================================================


class WebServer:
    """aiohttp Web 服务器"""

    def __init__(self, ralph: RalphLoop, pool: WorktreePool, port: int = DEFAULT_PORT):
        self.ralph = ralph
        self.pool = pool
        self.port = port
        self.ws_clients: set[web.WebSocketResponse] = set()
        self.app = web.Application()
        self._setup_routes()

    def _setup_routes(self):
        self.app.router.add_get("/", self.handle_index)
        self.app.router.add_get("/api/stats", self.handle_stats)
        self.app.router.add_get("/api/tasks", self.handle_list_tasks)
        self.app.router.add_post("/api/tasks", self.handle_submit_task)
        self.app.router.add_get("/api/tasks/{task_id}", self.handle_task_detail)
        self.app.router.add_delete("/api/tasks/{task_id}", self.handle_cancel_task)
        self.app.router.add_get("/api/workers", self.handle_workers)
        self.app.router.add_get("/ws", self.handle_websocket)

    async def broadcast(self, msg: dict):
        """广播消息到所有 WebSocket 客户端"""
        dead = set()
        data = json.dumps(msg, ensure_ascii=False)
        for ws in self.ws_clients:
            try:
                await ws.send_str(data)
            except Exception:
                dead.add(ws)
        self.ws_clients -= dead

    # --- API Handlers ---

    async def handle_index(self, request):
        return web.Response(text=INDEX_HTML, content_type="text/html")

    async def handle_stats(self, request):
        return web.json_response(self.ralph.get_stats())

    async def handle_list_tasks(self, request):
        tasks = sorted(
            self.ralph.all_tasks.values(),
            key=lambda t: t.created_at,
            reverse=True,
        )
        return web.json_response([t.to_dict() for t in tasks])

    async def handle_submit_task(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        prompt = data.get("prompt", "").strip()
        if not prompt:
            return web.json_response({"error": "prompt is required"}, status=400)

        task = Task(
            prompt=prompt,
            timeout=data.get("timeout", DEFAULT_TIMEOUT),
            max_budget=data.get("max_budget", DEFAULT_MAX_BUDGET),
        )
        await self.ralph.submit(task)
        return web.json_response(task.to_dict(), status=201)

    async def handle_task_detail(self, request):
        task_id = request.match_info["task_id"]
        task = self.ralph.all_tasks.get(task_id)
        if not task:
            return web.json_response({"error": "Task not found"}, status=404)
        return web.json_response(task.to_detail_dict())

    async def handle_cancel_task(self, request):
        task_id = request.match_info["task_id"]
        task = self.ralph.all_tasks.get(task_id)
        if not task:
            return web.json_response({"error": "Task not found"}, status=404)

        if task.status == TaskStatus.RUNNING and task.pid:
            try:
                os.kill(task.pid, signal.SIGTERM)
                task.status = TaskStatus.CANCELLED
                task.completed_at = datetime.now().isoformat()
            except ProcessLookupError:
                pass

        return web.json_response(task.to_dict())

    async def handle_workers(self, request):
        statuses = await self.pool.get_status()
        return web.json_response(statuses)

    async def handle_websocket(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.ws_clients.add(ws)
        log.info(f"WebSocket 连接: {len(self.ws_clients)} clients")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    # 可以接收客户端消息（如 ping）
                    pass
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    break
        finally:
            self.ws_clients.discard(ws)
            log.info(f"WebSocket 断开: {len(self.ws_clients)} clients")

        return ws

    async def start(self):
        """启动 Web 服务器"""
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", self.port)
        await site.start()
        log.info(f"Web 服务器启动: http://0.0.0.0:{self.port}")


# ============================================================================
# HTML 前端（内嵌，移动端适配）
# ============================================================================

INDEX_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>CC-Manager</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
  --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text);
  min-height: 100vh; overflow-x: hidden;
}
.container { max-width: 960px; margin: 0 auto; padding: 12px; }

/* Header */
.header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px;
}
.header h1 { font-size: 20px; display: flex; align-items: center; gap: 8px; }
.header h1 span { font-size: 12px; background: var(--accent); color: #000;
  padding: 2px 8px; border-radius: 12px; }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ws-dot.connected { background: var(--green); }
.ws-dot.disconnected { background: var(--red); }

/* Stats bar */
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 8px; margin-bottom: 16px;
}
.stat-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; text-align: center;
}
.stat-card .value { font-size: 24px; font-weight: 700; }
.stat-card .label { font-size: 11px; color: var(--text2); margin-top: 4px; }

/* Input */
.input-area {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px; margin-bottom: 16px;
}
.input-area textarea {
  width: 100%; background: transparent; border: none; color: var(--text);
  font-size: 15px; resize: none; outline: none; min-height: 60px;
  font-family: inherit;
}
.input-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
.btn {
  padding: 8px 20px; border-radius: 8px; border: none; cursor: pointer;
  font-weight: 600; font-size: 14px; transition: all 0.2s;
}
.btn-primary { background: var(--accent); color: #000; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-icon {
  width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font-size: 18px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.btn-icon:hover { border-color: var(--accent); }
.btn-icon.recording { background: var(--red); border-color: var(--red); animation: pulse 1s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

/* Workers */
.workers {
  display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px;
  padding: 8px 0;
}
.worker-dot {
  width: 28px; height: 28px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; border: 1px solid var(--border);
  cursor: default; position: relative;
}
.worker-dot.idle { background: var(--surface); color: var(--text2); }
.worker-dot.busy { background: var(--accent); color: #000; animation: glow 2s infinite; }
@keyframes glow { 0%,100% { box-shadow: 0 0 4px var(--accent); } 50% { box-shadow: 0 0 12px var(--accent); } }

/* Task list */
.tasks { display: flex; flex-direction: column; gap: 8px; }
.task-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px; cursor: pointer;
  transition: border-color 0.2s;
}
.task-card:hover { border-color: var(--accent); }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.task-id { font-family: monospace; font-size: 12px; color: var(--text2); }
.task-status {
  font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
}
.status-pending { background: #30363d; color: var(--text2); }
.status-running { background: rgba(88,166,255,0.2); color: var(--accent); }
.status-success { background: rgba(63,185,80,0.2); color: var(--green); }
.status-failed { background: rgba(248,81,73,0.2); color: var(--red); }
.status-timeout { background: rgba(210,153,34,0.2); color: var(--yellow); }
.status-cancelled { background: rgba(188,140,255,0.2); color: var(--purple); }
.task-prompt { font-size: 14px; line-height: 1.4; word-break: break-all; }
.task-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: var(--text2); }
.task-error { color: var(--red); font-size: 12px; margin-top: 6px; font-family: monospace;
  white-space: pre-wrap; max-height: 100px; overflow-y: auto; }

/* Modal */
.modal-overlay {
  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center;
}
.modal-overlay.show { display: flex; }
.modal {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto; padding: 20px;
}
.modal h2 { margin-bottom: 12px; }
.modal pre { background: var(--bg); padding: 12px; border-radius: 8px;
  font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
.modal .close-btn {
  position: absolute; top: 12px; right: 12px; font-size: 24px;
  cursor: pointer; color: var(--text2); background: none; border: none;
}

/* Empty state */
.empty {
  text-align: center; padding: 40px 20px; color: var(--text2);
}
.empty .icon { font-size: 48px; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>CC-Manager <span>V0</span></h1>
    <div><span class="ws-dot disconnected" id="ws-status"></span></div>
  </div>

  <div class="stats" id="stats">
    <div class="stat-card"><div class="value" id="st-total">-</div><div class="label">Total</div></div>
    <div class="stat-card"><div class="value" id="st-running">-</div><div class="label">Running</div></div>
    <div class="stat-card"><div class="value" id="st-success">-</div><div class="label">Success</div></div>
    <div class="stat-card"><div class="value" id="st-rate">-</div><div class="label">Rate</div></div>
    <div class="stat-card"><div class="value" id="st-queue">-</div><div class="label">Queue</div></div>
    <div class="stat-card"><div class="value" id="st-workers">-</div><div class="label">Workers</div></div>
  </div>

  <div class="workers" id="workers"></div>

  <div class="input-area">
    <textarea id="prompt-input" placeholder="输入任务描述... (Ctrl+Enter 提交)" rows="3"></textarea>
    <div class="input-actions">
      <button class="btn-icon" id="voice-btn" title="语音输入">🎤</button>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font-size:11px;color:var(--text2)" id="char-count">0</span>
        <button class="btn btn-primary" id="submit-btn" onclick="submitTask()">提交任务</button>
      </div>
    </div>
  </div>

  <div class="tasks" id="task-list">
    <div class="empty">
      <div class="icon">⚡</div>
      <div>没有任务。提交一个试试？</div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-content"></div>
</div>

<script>
const API = '';
let ws = null;
let reconnectTimer = null;

// WebSocket
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    document.getElementById('ws-status').className = 'ws-dot connected';
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    refreshAll();
  };
  ws.onclose = () => {
    document.getElementById('ws-status').className = 'ws-dot disconnected';
    if (!reconnectTimer) reconnectTimer = setInterval(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

// API calls
async function fetchJSON(url, opts) {
  const r = await fetch(API + url, opts);
  return r.json();
}

async function refreshStats() {
  const s = await fetchJSON('/api/stats');
  document.getElementById('st-total').textContent = s.total_tasks;
  document.getElementById('st-running').textContent = s.by_status?.running || 0;
  document.getElementById('st-success').textContent = s.by_status?.success || 0;
  document.getElementById('st-rate').textContent = s.success_rate + '%';
  document.getElementById('st-queue').textContent = s.queue_size;
  document.getElementById('st-workers').textContent = `${s.active_workers}/${s.total_workers}`;
}

async function refreshWorkers() {
  const workers = await fetchJSON('/api/workers');
  const el = document.getElementById('workers');
  el.innerHTML = workers.map((w, i) =>
    `<div class="worker-dot ${w.busy ? 'busy' : 'idle'}" title="${w.name}${w.current_task ? '\\nTask: '+w.current_task : ''}">${i}</div>`
  ).join('');
}

async function refreshTasks() {
  const tasks = await fetchJSON('/api/tasks');
  const el = document.getElementById('task-list');
  if (tasks.length === 0) {
    el.innerHTML = '<div class="empty"><div class="icon">⚡</div><div>没有任务。提交一个试试？</div></div>';
    return;
  }
  el.innerHTML = tasks.map(t => `
    <div class="task-card" onclick="showDetail('${t.id}')">
      <div class="task-header">
        <span class="task-id">#${t.id}</span>
        <span class="task-status status-${t.status}">${t.status.toUpperCase()}</span>
      </div>
      <div class="task-prompt">${escapeHtml(t.prompt.substring(0, 120))}${t.prompt.length > 120 ? '...' : ''}</div>
      <div class="task-meta">
        ${t.worktree ? '<span>🔧 ' + t.worktree + '</span>' : ''}
        ${t.cost_usd > 0 ? '<span>💰 $' + t.cost_usd.toFixed(3) + '</span>' : ''}
        <span>${timeAgo(t.created_at)}</span>
      </div>
      ${t.error ? '<div class="task-error">' + escapeHtml(t.error.substring(0, 200)) + '</div>' : ''}
    </div>
  `).join('');
}

async function refreshAll() {
  await Promise.all([refreshStats(), refreshWorkers(), refreshTasks()]);
}

async function submitTask() {
  const input = document.getElementById('prompt-input');
  const prompt = input.value.trim();
  if (!prompt) return;

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;

  try {
    await fetchJSON('/api/tasks', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ prompt })
    });
    input.value = '';
    document.getElementById('char-count').textContent = '0';
    await refreshAll();
  } catch(e) {
    alert('提交失败: ' + e.message);
  }
  btn.disabled = false;
}

async function showDetail(id) {
  const t = await fetchJSON(`/api/tasks/${id}`);
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <h2>#${t.id} <span class="task-status status-${t.status}">${t.status.toUpperCase()}</span></h2>
    <p style="margin-bottom:12px"><strong>Prompt:</strong> ${escapeHtml(t.prompt)}</p>
    ${t.worktree ? '<p><strong>Worker:</strong> ' + t.worktree + '</p>' : ''}
    ${t.started_at ? '<p><strong>Started:</strong> ' + new Date(t.started_at).toLocaleString() + '</p>' : ''}
    ${t.completed_at ? '<p><strong>Completed:</strong> ' + new Date(t.completed_at).toLocaleString() + '</p>' : ''}
    ${t.cost_usd > 0 ? '<p><strong>Cost:</strong> $' + t.cost_usd.toFixed(4) + '</p>' : ''}
    ${t.token_input > 0 ? '<p><strong>Tokens:</strong> ' + t.token_input + ' in / ' + t.token_output + ' out</p>' : ''}
    ${t.error ? '<h3 style="color:var(--red);margin-top:12px">Error</h3><pre>' + escapeHtml(t.error) + '</pre>' : ''}
    ${t.output ? '<h3 style="margin-top:12px">Output</h3><pre>' + escapeHtml(t.output.substring(0, 5000)) + '</pre>' : ''}
    <h3 style="margin-top:12px">Events (${t.event_count || 0})</h3>
    <pre>${JSON.stringify(t.events?.slice(-20) || [], null, 2)}</pre>
    <div style="margin-top:16px;text-align:right">
      <button class="btn btn-primary" onclick="closeModal()">关闭</button>
    </div>
  `;
  modal.classList.add('show');
}

function closeModal() { document.getElementById('modal').classList.remove('show'); }

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function timeAgo(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// Keyboard shortcut
document.getElementById('prompt-input').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitTask(); }
});
document.getElementById('prompt-input').addEventListener('input', e => {
  document.getElementById('char-count').textContent = e.target.value.length;
});

// Voice input (Web Speech API)
const voiceBtn = document.getElementById('voice-btn');
let recognition = null;
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;

  let isRecording = false;
  voiceBtn.onclick = () => {
    if (isRecording) { recognition.stop(); return; }
    isRecording = true;
    voiceBtn.classList.add('recording');
    recognition.start();
  };
  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    document.getElementById('prompt-input').value = transcript;
    document.getElementById('char-count').textContent = transcript.length;
  };
  recognition.onend = () => { isRecording = false; voiceBtn.classList.remove('recording'); };
  recognition.onerror = () => { isRecording = false; voiceBtn.classList.remove('recording'); };
} else {
  voiceBtn.style.display = 'none';
}

// Init
connectWS();
refreshAll();
setInterval(refreshAll, 5000);  // 每5秒刷新
</script>
</body>
</html>
"""


# ============================================================================
# 主程序
# ============================================================================


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="CC-Manager V0")
    parser.add_argument("--repo", required=True, help="Git 仓库路径")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help=f"Worker 数量 (默认 {DEFAULT_WORKERS})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Web 端口 (默认 {DEFAULT_PORT})")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help=f"任务超时(秒) (默认 {DEFAULT_TIMEOUT})")
    parser.add_argument("--budget", type=float, default=DEFAULT_MAX_BUDGET, help=f"每任务预算($) (默认 {DEFAULT_MAX_BUDGET})")
    parser.add_argument("--system-prompt", default="", help="CC 系统提示词")

    args = parser.parse_args()

    # 验证 repo
    repo = os.path.abspath(args.repo)
    if not os.path.isdir(os.path.join(repo, ".git")):
        log.error(f"错误: {repo} 不是有效的 Git 仓库")
        sys.exit(1)

    # 初始化组件
    log.info(f"CC-Manager V0 启动中...")
    log.info(f"  Repo: {repo}")
    log.info(f"  Workers: {args.workers}")
    log.info(f"  Port: {args.port}")

    # 1. WorktreePool
    pool = WorktreePool(repo, pool_size=args.workers)
    await pool.init_pool()

    # 2. Dispatcher
    dispatcher = CCDispatcher(system_prompt=args.system_prompt)

    # 3. WebServer（先创建以便 broadcast 可用）
    web_server = None

    async def on_event(msg):
        if web_server:
            await web_server.broadcast(msg)

    # 4. RalphLoop
    ralph = RalphLoop(dispatcher=dispatcher, pool=pool, on_event=on_event)

    # 5. WebServer
    web_server = WebServer(ralph=ralph, pool=pool, port=args.port)

    # 启动
    await ralph.start()
    await web_server.start()

    log.info(f"✅ CC-Manager 就绪! 打开 http://localhost:{args.port}")

    # 保持运行
    try:
        while True:
            await asyncio.sleep(60)
            stats = ralph.get_stats()
            log.info(
                f"[心跳] Tasks={stats['total_tasks']} "
                f"Running={stats['active_workers']}/{stats['total_workers']} "
                f"Rate={stats['success_rate']}% "
                f"Queue={stats['queue_size']} "
                f"Cost=${stats['total_cost_usd']}"
            )
    except asyncio.CancelledError:
        await ralph.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("收到中断信号，退出")
