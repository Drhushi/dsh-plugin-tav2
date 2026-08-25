"""常驻项目 Agent 会话：目标队列、计划与状态机。

每个项目一个会话（session_id 取项目目录的稳定哈希）。serve 后台轮询线程在
会话 idle 且有目标时原子抢占并逐个执行 AgentRunner episode；CLI 的单次
``agent run`` 不经过会话队列，保持独立运行。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from tav2.config import resolve_project_dir
from tav2.db import ProjectDB


def session_id_for_project_dir(project_dir: str | Path) -> str:
    """项目会话 id：基于项目产物目录的稳定哈希（跨实例一致）。"""

    resolved = str(Path(project_dir).resolve()).lower()
    digest = hashlib.sha1(resolved.encode("utf-8")).hexdigest()[:12]
    return f"proj_{digest}"


def _project_db(cfg: dict[str, Any]) -> tuple[ProjectDB, str]:
    game_dir = Path(cfg["game_dir"])
    project_dir = resolve_project_dir(cfg, game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    return db, session_id_for_project_dir(project_dir)


def submit_goal(
    cfg: dict[str, Any],
    goal: str,
    autonomy: str = "",
    max_turns: int = 0,
) -> dict[str, Any]:
    """把目标追加到会话队列；serve 轮询线程会择机执行。"""

    goal = str(goal or "").strip()
    if not goal:
        return {"ok": False, "error": "目标不能为空"}
    db, session_id = _project_db(cfg)
    queued = db.session_add_goal(session_id, goal, autonomy=autonomy, max_turns=max_turns)
    db.close()
    return {"ok": True, "session_id": session_id, "queued": queued, "goal": goal}


def session_status(cfg: dict[str, Any]) -> dict[str, Any]:
    """会话状态：id/status/active_goal/queue/plan/current_run_id。"""

    db, session_id = _project_db(cfg)
    try:
        session = db.get_agent_session(session_id) or {
            "session_id": session_id,
            "status": "idle",
            "active_goal": "",
            "goals": [],
            "plan": [],
        }
        current_run_id = ""
        run = db.latest_agent_run(session_id)
        if run is not None:
            current_run_id = str(run.get("run_id") or "")
        return {
            "session_id": session_id,
            "status": str(session.get("status") or "idle"),
            "active_goal": str(session.get("active_goal") or ""),
            "queue": list(session.get("goals") or []),
            "plan": list(session.get("plan") or []),
            "current_run_id": current_run_id,
        }
    finally:
        db.close()


def stop_session(cfg: dict[str, Any]) -> dict[str, Any]:
    """会话级停止：置 stopping 并停止当前 run（轮间生效）。"""

    db, session_id = _project_db(cfg)
    try:
        db.set_agent_session_status(session_id, "stopping", active_goal="")
        run = db.latest_agent_run(session_id)
        if run is not None and run.get("status") == "running":
            db.set_agent_run_status(run["run_id"], "stopping", summary="会话停止请求")
        return {"ok": True, "session_id": session_id}
    finally:
        db.close()


def resume_session(cfg: dict[str, Any]) -> dict[str, Any]:
    """继续处理队列：stopping → idle，轮询线程随即恢复执行。"""

    db, session_id = _project_db(cfg)
    try:
        db.set_agent_session_status(session_id, "idle", active_goal="")
        return {"ok": True, "session_id": session_id}
    finally:
        db.close()
