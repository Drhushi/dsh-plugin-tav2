"""CLI 与 Web 共用的后台任务状态存储：进度、日志与心跳统一落盘。

移植自 TranslateAgent v1 的 translate_agent/task_status.py。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Iterator, TextIO

from tav2.config import PROJECT_ROOT


DEFAULT_STATUS_PATH = PROJECT_ROOT / "work" / "task_status.json"
HEARTBEAT_INTERVAL = 30
STALE_AFTER = 120
MAX_LOG_LINES = 2000


def _now() -> float:
    return time.time()


def _pid() -> int:
    return os.getpid()


class TaskStatusStore:
    """任务状态存储：begin / append_log / set_progress / finish / fail / get / clear。"""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else DEFAULT_STATUS_PATH
        self._lock = threading.Lock()
        self._state: dict[str, Any] | None = None
        self._beat_stop = threading.Event()
        self._beat_thread: threading.Thread | None = None

    def _read(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def _write(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def begin(self, name: str) -> None:
        now = _now()
        with self._lock:
            existing = self._read()
            if existing and self._is_active(existing):
                raise RuntimeError(
                    f"已有任务在运行：{existing.get('name')}（pid={existing.get('pid')}）"
                )
            self._state = {
                "name": name,
                "status": "running",
                "pid": _pid(),
                "started_at": now,
                "heartbeat_at": now,
                "message": "",
                "progress": None,
                "logs": [],
                "error": None,
                "result": None,
            }
            self._write(self._state)
        self._start_heartbeat()

    @staticmethod
    def _is_active(state: dict[str, Any]) -> bool:
        try:
            heartbeat = float(state.get("heartbeat_at") or 0)
        except (TypeError, ValueError):
            heartbeat = 0
        return state.get("status") == "running" and (_now() - heartbeat) <= STALE_AFTER

    def finish(self, result: Any = None) -> None:
        with self._lock:
            if self._state is None:
                return
            self._state["status"] = "done"
            self._state["result"] = result
            self._state["heartbeat_at"] = _now()
            self._write(self._state)
        self._stop_heartbeat()

    def fail(self, error: str) -> None:
        with self._lock:
            if self._state is None:
                return
            self._state["status"] = "error"
            self._state["error"] = str(error)
            self._state["heartbeat_at"] = _now()
            self._write(self._state)
        self._stop_heartbeat()

    def clear(self) -> None:
        self._stop_heartbeat()
        with self._lock:
            self._state = None
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass

    def append_log(self, text: str) -> None:
        line = (text or "").strip()
        if line.startswith("@progress"):
            try:
                self.set_progress(json.loads(line[len("@progress") :].strip()))
            except Exception:
                pass
            return
        with self._lock:
            if self._state is None:
                return
            self._state["logs"].append(text)
            if len(self._state["logs"]) > MAX_LOG_LINES:
                self._state["logs"] = self._state["logs"][-MAX_LOG_LINES:]
            self._state["heartbeat_at"] = _now()
            self._write(self._state)

    def set_progress(self, progress: dict[str, Any]) -> None:
        with self._lock:
            if self._state is None:
                return
            self._state["progress"] = progress
            self._state["message"] = str(progress.get("message") or "")
            self._state["heartbeat_at"] = _now()
            self._write(self._state)

    def touch(self) -> None:
        with self._lock:
            if self._state is not None and self._state.get("status") == "running":
                self._state["heartbeat_at"] = _now()
                self._write(self._state)

    def get(self) -> dict[str, Any] | None:
        state = self._read()
        if not state:
            return None
        state = dict(state)
        state["logs"] = list(state.get("logs") or [])
        try:
            heartbeat = float(state.get("heartbeat_at") or 0)
        except (TypeError, ValueError):
            heartbeat = 0
        if state.get("status") == "running" and (_now() - heartbeat) > STALE_AFTER:
            state["status"] = "error"
            state["error"] = "任务疑似中断（心跳超时）"
        return state

    def _start_heartbeat(self) -> None:
        self._beat_stop.clear()

        def _beat() -> None:
            while not self._beat_stop.wait(HEARTBEAT_INTERVAL):
                self.touch()

        self._beat_thread = threading.Thread(
            target=_beat, daemon=True, name="task-status-heartbeat"
        )
        self._beat_thread.start()

    def _stop_heartbeat(self) -> None:
        thread, self._beat_thread = self._beat_thread, None
        if thread is not None:
            self._beat_stop.set()
            thread.join(timeout=5)


class TeeWriter:
    """同时写真实流与任务存储；@progress 标记转为结构化进度。"""

    def __init__(self, store: TaskStatusStore, real: TextIO | None = None) -> None:
        self.store = store
        self.real = real
        self._buf = ""

    def write(self, s: str) -> int:
        if self.real is not None:
            self.real.write(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._handle_line(line + "\n")
        return len(s)

    def flush(self) -> None:
        if self.real is not None:
            self.real.flush()
        if self._buf:
            line, self._buf = self._buf, ""
            self._handle_line(line)

    def _handle_line(self, line: str) -> None:
        stripped = line.strip()
        if stripped.startswith("@progress"):
            try:
                self.store.set_progress(json.loads(stripped[len("@progress") :].strip()))
            except Exception:
                pass
        else:
            self.store.append_log(line)


@contextmanager
def task_session(name: str, path: str | Path | None = None) -> Iterator[TaskStatusStore]:
    """后台任务会话：落盘状态 + 捕获 stdout/stderr。"""

    store = TaskStatusStore(path)
    store.begin(name)
    tee_out = TeeWriter(store, sys.stdout)
    tee_err = TeeWriter(store, sys.stderr)
    try:
        with redirect_stdout(tee_out), redirect_stderr(tee_err):
            yield store
    except KeyboardInterrupt:
        store.fail("任务被用户中断")
        raise
    except SystemExit as exc:
        code = exc.code
        if code is None or code == 0:
            store.finish()
        else:
            store.fail(str(exc) or "任务被终止")
        raise
    except Exception as exc:  # noqa: BLE001
        store.fail(str(exc))
        raise
    else:
        store.finish()
