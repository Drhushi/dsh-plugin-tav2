"""本地 Web 过程页：项目仪表盘 + 运行过程可视 + 审批/术语/世界书管理。

单文件前端（tav2/webui/index.html）通过 /api/* 接口读写项目级 SQLite
知识库；任务状态仍来自全局 TaskStatusStore。网页只读监测与审批/编辑，
不提供启动/停止任务的能力。
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from tav2.config import (
    PROJECT_ROOT,
    apply_config_patch,
    public_config,
    remember_recent_project,
    remembered_game_dir,
    resolve_project_dir,
    save_config,
)
from tav2.db import ProjectDB
from tav2.task_status import TaskStatusStore


WEBUI_DIR = Path(__file__).resolve().parent / "webui"

# 后台重启退出码：serve 进程收到 /api/restart 后以该码退出，
# 启动器守护循环检测到该码会自动重新拉起（正常退出码 0 不重启）。
RESTART_EXIT_CODE = 23


def _default_restart_trigger() -> None:
    """默认重启触发器：稍等让响应先发出，再以约定退出码终止进程。"""

    def _delayed_exit() -> None:
        time.sleep(0.8)
        print(
            "后台重启：服务已退出（退出码 23）。"
            "若由 tav2_launcher.ps1 启动会自动拉起，否则请手动重启。",
            flush=True,
        )
        os._exit(RESTART_EXIT_CODE)

    threading.Thread(target=_delayed_exit, daemon=True).start()

# 前端静态校验依据：index.html 里 fetch 的 /api/* 路径必须匹配这些前缀。
API_PREFIXES = (
    "/api/status",
    "/api/projects",
    "/api/overview",
    "/api/runs",
    "/api/run/",
    "/api/approvals",
    "/api/terms",
    "/api/worldbook",
    "/api/agent",
    "/api/config",
    "/api/restart",
)


def _projects(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    base = Path(cfg.get("review_dir", "projects"))
    if not base.is_absolute():
        base = PROJECT_ROOT / base
    out: list[dict[str, Any]] = []
    if base.is_dir():
        for child in sorted(base.iterdir()):
            if child.is_dir():
                db_path = child / "db.sqlite"
                out.append(
                    {
                        "name": child.name,
                        "has_db": db_path.exists(),
                        "game_dir": remembered_game_dir(cfg, child.name),
                    }
                )
    return out


def _project_db_path(cfg: dict[str, Any], name: str) -> Path | None:
    """校验项目名并返回 db.sqlite 路径；不存在或路径越界返回 None。"""

    base = Path(cfg.get("review_dir", "projects"))
    if not base.is_absolute():
        base = PROJECT_ROOT / base
    if not name:
        return None
    try:
        candidate = (base / name).resolve()
        candidate.relative_to(base.resolve())
    except (ValueError, OSError):
        return None
    db_path = candidate / "db.sqlite"
    return db_path if db_path.exists() else None


def _configured_project(cfg: dict[str, Any]) -> str:
    """serve 配置对应的项目名（Agent 执行只作用于该项目）。"""

    game_dir = str(cfg.get("game_dir") or "")
    return Path(game_dir).name or ""


def make_handler(
    cfg: dict[str, Any],
    status_store: TaskStatusStore | None = None,
    config_path: str | Path | None = None,
    restart_trigger: Any = None,
) -> type[BaseHTTPRequestHandler]:
    status_store = status_store or TaskStatusStore()
    config_path = Path(config_path) if config_path else PROJECT_ROOT / "config.yaml"
    restart_trigger = restart_trigger or _default_restart_trigger

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        # ------------------------------------------------------------------ helpers

        def _send_json(self, data: Any, status: int = 200) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, status: int, message: str) -> None:
            self._send_json({"error": message}, status=status)

        def _send_file(self, path: Path, content_type: str) -> None:
            if not path.exists():
                self.send_response(404)
                self.end_headers()
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _path(self) -> str:
            return self.path.partition("?")[0]

        def _query(self) -> dict[str, list[str]]:
            _, _, qs = self.path.partition("?")
            return urllib.parse.parse_qs(qs)

        def _project(self) -> str:
            names = self._query().get("project")
            return str(names[-1]) if names else ""

        def _open_db(self) -> ProjectDB | None:
            db_path = _project_db_path(cfg, self._project())
            if db_path is None:
                return None
            return ProjectDB(db_path)

        def _read_json_body(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            if not raw.strip():
                return {}
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return {}
            return data if isinstance(data, dict) else {}

        def _split(self, prefix: str, suffix: str | None = None) -> str | None:
            """取前缀与可选后缀之间的片段；不匹配返回 None。"""

            path = self._path()
            if not path.startswith(prefix):
                return None
            rest = path[len(prefix) :]
            if suffix is not None:
                if not rest.endswith(suffix):
                    return None
                rest = rest[: -len(suffix)]
            rest = rest.strip("/")
            return rest or None

        # ------------------------------------------------------------------ GET

        def do_GET(self) -> None:  # noqa: N802
            path = self._path()
            if path in ("/", "/index.html"):
                self._send_file(WEBUI_DIR / "index.html", "text/html; charset=utf-8")
                return
            if path == "/api/status":
                self._send_json(status_store.get())
                return
            if path == "/api/projects":
                self._send_json({"projects": _projects(cfg)})
                return
            if path == "/api/config":
                self._send_json({"config": public_config(cfg)})
                return

            db = self._open_db()
            if db is None:
                self._send_error(404, "项目不存在或没有知识库")
                return
            try:
                if path == "/api/overview":
                    self._send_json(self._overview(db))
                elif path == "/api/runs":
                    self._send_json({"runs": db.recent_runs(50)})
                elif path == "/api/agent/session":
                    self._send_json(self._agent_session(db))
                elif path == "/api/agent/messages":
                    self._send_json(self._agent_messages(db))
                elif path == "/api/agent/actions":
                    self._send_json(self._agent_actions(db))
                elif path == "/api/approvals":
                    self._send_json({"approvals": db.pending_approvals()})
                elif path == "/api/terms":
                    raw_status = (self._query().get("status") or ["all"])[-1]
                    status = (
                        raw_status
                        if raw_status in ("candidate", "locked", "rejected")
                        else None
                    )
                    self._send_json({"terms": db.all_terms(status)})
                elif path == "/api/worldbook":
                    self._send_json({"entries": db.load_worldbook(active_only=False)})
                elif path.startswith("/api/run/"):
                    run_id = self._split("/api/run/")
                    if run_id is None:
                        self._send_error(404, "缺少 run_id")
                        return
                    run = db.run_by_id(run_id)
                    if run is None:
                        self._send_error(404, "run 不存在")
                        return
                    self._send_json(self._run_detail(db, run))
                else:
                    self._send_error(404, "接口不存在")
            finally:
                db.close()

        def _overview(self, db: ProjectDB) -> dict[str, Any]:
            terms = db.all_terms()
            counts = {"locked": 0, "candidate": 0, "rejected": 0}
            for t in terms:
                counts[t["status"]] = counts.get(t["status"], 0) + 1
            return {
                "project": self._project(),
                "units": db.unit_stats(),
                "terms": counts,
                "worldbook_entries": len(db.load_worldbook(active_only=False)),
                "pending_approvals": len(db.pending_approvals()),
                "main_summary": db.get_summary("main"),
                "recent_runs": db.recent_runs(5),
            }

        def _run_detail(self, db: ProjectDB, run: dict[str, Any]) -> dict[str, Any]:
            run_id = str(run["run_id"])
            summary = str(run.get("summary") or "")
            try:
                stats = json.loads(summary)
                if not isinstance(stats, dict):
                    stats = {"text": summary}
            except (ValueError, TypeError):
                stats = {"text": summary}
            scenes: list[dict[str, Any]] = []
            for row in db.all_understandings():
                units = db.units_with_translations(str(row["scene_id"]))
                translated = sum(1 for u in units if u["status"] == "translated")
                scenes.append(
                    {
                        "scene_id": row["scene_id"],
                        "branch": row["branch"],
                        "created_at": row["created_at"],
                        "understanding": row["record"],
                        "units": units,
                        "unit_counts": {"total": len(units), "translated": translated},
                    }
                )
            return {
                "run": run,
                "stats": stats,
                "usage": db.usage_for(run_id),
                "scenes": scenes,
            }

        # ---------------------------------------------------------- agent 只读

        def _agent_session(self, db: ProjectDB) -> dict[str, Any]:
            from tav2.agent_session import session_id_for_project_dir

            sid = session_id_for_project_dir(Path(db.path).parent)
            session = db.get_agent_session(sid)
            if session is None:
                return {
                    "session_id": sid,
                    "status": "idle",
                    "active_goal": "",
                    "queue": [],
                    "plan": [],
                    "current_run_id": "",
                    "recent_runs": [],
                    "configured": self._project() == _configured_project(cfg),
                }
            latest = db.latest_agent_run(sid)
            current_run_id = str(latest.get("run_id") or "") if latest else ""
            return {
                "session_id": sid,
                "status": str(session.get("status") or "idle"),
                "active_goal": str(session.get("active_goal") or ""),
                "queue": list(session.get("goals") or []),
                "plan": list(session.get("plan") or []),
                "current_run_id": current_run_id,
                "recent_runs": db.recent_agent_runs(3, sid),
                "configured": self._project() == _configured_project(cfg),
            }

        def _agent_messages(self, db: ProjectDB) -> dict[str, Any]:
            from tav2.agent_session import session_id_for_project_dir

            try:
                limit = int((self._query().get("limit") or ["100"])[-1])
            except ValueError:
                limit = 100
            sid = session_id_for_project_dir(Path(db.path).parent)
            return {"messages": db.agent_messages(sid, limit=max(1, min(limit, 500)))}

        def _agent_actions(self, db: ProjectDB) -> dict[str, Any]:
            from tav2.agent_session import session_id_for_project_dir

            sid = session_id_for_project_dir(Path(db.path).parent)
            status = (self._query().get("status") or [""])[-1]
            run = (self._query().get("run") or [""])[-1]
            if run:
                items = db.agent_actions_for_run(run)
            else:
                items = db.agent_actions_for_session(sid, status=status or "")
            return {"actions": items}

        def _require_agent_project(self) -> bool:
            """Agent 执行/审批只作用于 serve 配置的项目。"""

            if self._project() == _configured_project(cfg):
                return True
            self._send_error(
                400, "该项目的 Agent 会话请在对应项目配置下用 CLI 执行（agent run/goal/approve）"
            )
            return False

        # ------------------------------------------------------------------ POST

        def do_POST(self) -> None:  # noqa: N802
            path = self._path()
            if path == "/api/restart":
                self._post_restart()
                return
            if path == "/api/config":
                self._post_config()
                return
            if path == "/api/projects/select":
                self._post_project_select()
                return
            db = self._open_db()
            if db is None:
                self._send_error(404, "项目不存在或没有知识库")
                return
            try:
                if path.startswith("/api/agent/actions/"):
                    self._post_agent_action(db)
                elif path == "/api/agent/goal":
                    self._post_agent_goal(db)
                elif path == "/api/agent/stop":
                    self._post_agent_stop(db)
                elif path == "/api/agent/resume":
                    self._post_agent_resume(db)
                elif path.startswith("/api/approvals/"):
                    self._post_approval(db)
                elif path.startswith("/api/terms/"):
                    self._post_term(db)
                elif path.startswith("/api/worldbook/"):
                    self._post_worldbook(db)
                else:
                    self._send_error(404, "接口不存在")
            finally:
                db.close()

        def _post_restart(self) -> None:
            """请求后台重启：先优雅中断当前任务，再触发进程退出（由启动器拉起）。"""

            try:
                st = status_store.get()
                if st and st.get("status") == "running":
                    status_store.fail("后台重启，任务已中断")
                from tav2.agent_session import stop_session

                stop_session(cfg)
            except Exception:  # noqa: BLE001 重启前清理尽力而为
                pass
            self._send_json({"ok": True, "restarting": True})
            try:
                restart_trigger()
            except Exception:  # noqa: BLE001
                pass

        def _post_config(self) -> None:
            """前端配置：白名单字段热生效并写回 config.yaml。"""

            body = self._read_json_body()
            errors = apply_config_patch(cfg, body)
            if not errors and str(cfg.get("game_dir") or "").strip():
                remember_recent_project(cfg, str(cfg["game_dir"]))
            if errors:
                self._send_error(400, "；".join(f"{k}: {v}" for k, v in errors.items()))
                return
            try:
                save_config(cfg, config_path)
            except OSError as exc:
                self._send_error(500, f"配置写入失败：{exc}")
                return
            self._send_json({"ok": True, "config": public_config(cfg)})

        def _post_project_select(self) -> None:
            """下拉切换项目：按记忆自动更新 game_dir 并落盘，无需手动输入路径。"""

            body = self._read_json_body()
            name = str(body.get("name") or "").strip()
            game_dir = remembered_game_dir(cfg, name)
            if not game_dir:
                self._send_error(
                    404,
                    f"项目 {name} 未记录游戏目录，请先在 ⚙ 配置 中选择/输入一次",
                )
                return
            if str(cfg.get("game_dir") or "").strip() != game_dir:
                cfg["game_dir"] = game_dir
                remember_recent_project(cfg, game_dir)
                try:
                    save_config(cfg, config_path)
                except OSError as exc:
                    self._send_error(500, f"配置写入失败：{exc}")
                    return
            self._send_json({"ok": True, "config": public_config(cfg)})

        def _post_agent_goal(self, db: ProjectDB) -> None:
            from tav2.agent_session import session_id_for_project_dir

            if not self._require_agent_project():
                return
            body = self._read_json_body()
            goal = str(body.get("goal") or "").strip()
            if not goal:
                self._send_error(400, "goal 不能为空")
                return
            sid = session_id_for_project_dir(Path(db.path).parent)
            queued = db.session_add_goal(
                sid,
                goal,
                autonomy=str(body.get("autonomy") or ""),
                max_turns=int(body.get("max_turns") or 0),
            )
            self._send_json({"ok": True, "session_id": sid, "queued": queued, "goal": goal})

        def _post_agent_stop(self, db: ProjectDB) -> None:
            from tav2.agent_session import session_id_for_project_dir

            if not self._require_agent_project():
                return
            sid = session_id_for_project_dir(Path(db.path).parent)
            db.set_agent_session_status(sid, "stopping", active_goal="")
            run = db.latest_agent_run(sid)
            if run is not None and run.get("status") == "running":
                db.set_agent_run_status(run["run_id"], "stopping", summary="会话停止请求")
            self._send_json({"ok": True, "session_id": sid})

        def _post_agent_resume(self, db: ProjectDB) -> None:
            from tav2.agent_session import session_id_for_project_dir

            if not self._require_agent_project():
                return
            sid = session_id_for_project_dir(Path(db.path).parent)
            db.set_agent_session_status(sid, "idle", active_goal="")
            self._send_json({"ok": True, "session_id": sid})

        def _post_agent_action(self, db: ProjectDB) -> None:
            path = self._path()
            suffix = "/approve" if path.endswith("/approve") else "/reject"
            rest = self._split("/api/agent/actions/", suffix)
            if rest is None:
                self._send_error(404, "路径无效")
                return
            try:
                action_id = int(rest)
            except ValueError:
                self._send_error(400, "id 无效")
                return
            if not self._require_agent_project():
                return
            from tav2.agent import approve_action, reject_action

            if suffix == "/approve":
                result = approve_action(cfg, action_id)
            else:
                reason = str(self._read_json_body().get("reason") or "")
                result = reject_action(cfg, action_id, reason)
            status = 200 if result.get("ok") else 400
            self._send_json(result, status=status)

        def _post_approval(self, db: ProjectDB) -> None:
            rest = self._split("/api/approvals/", "/decide")
            if rest is None:
                self._send_error(404, "路径无效")
                return
            try:
                approval_id = int(rest)
            except ValueError:
                self._send_error(400, "id 无效")
                return
            action = self._read_json_body().get("action")
            if action not in ("approved", "rejected"):
                self._send_error(400, "action 必须为 approved 或 rejected")
                return
            if not db.decide_approval(approval_id, action):
                self._send_error(404, "审批不存在")
                return
            # 与 CLI approvals 行为一致：批准术语时同步锁定到 terms 表
            if action == "approved":
                item = db.approval_by_id(approval_id)
                if item and item["kind"] == "term":
                    payload = item["payload"]
                    db.upsert_term(
                        str(payload.get("source") or ""),
                        str(payload.get("target") or ""),
                        "",
                        status="locked",
                        confidence=str(payload.get("confidence") or "human"),
                        evidence=str(payload.get("rationale") or ""),
                    )
            self._send_json({"ok": True})

        def _post_term(self, db: ProjectDB) -> None:
            if self._path().endswith("/decide"):
                rest = self._split("/api/terms/", "/decide")
                if rest is None:
                    self._send_error(404, "路径无效")
                    return
                try:
                    term_id = int(rest)
                except ValueError:
                    self._send_error(400, "id 无效")
                    return
                action = self._read_json_body().get("action")
                if action not in ("locked", "rejected"):
                    self._send_error(400, "action 必须为 locked 或 rejected")
                    return
                if not db.decide_term(term_id, action):
                    self._send_error(404, "术语不存在")
                    return
                self._send_json({"ok": True})
                return

            rest = self._split("/api/terms/")
            if rest is None:
                self._send_error(404, "路径无效")
                return
            try:
                term_id = int(rest)
            except ValueError:
                self._send_error(400, "id 无效")
                return
            body = self._read_json_body()
            target = body.get("target")
            category = body.get("category")
            if target is None and category is None:
                self._send_error(400, "至少提供 target 或 category")
                return
            if not db.update_term(term_id, target=target, category=category):
                self._send_error(404, "术语不存在")
                return
            self._send_json({"ok": True})

        def _post_worldbook(self, db: ProjectDB) -> None:
            rest = self._split("/api/worldbook/")
            if rest is None:
                self._send_error(404, "路径无效")
                return
            try:
                entry_id = int(rest)
            except ValueError:
                self._send_error(400, "id 无效")
                return
            allowed = {"kind", "title", "content", "active", "keywords", "source_refs"}
            fields = {
                k: v for k, v in self._read_json_body().items() if k in allowed
            }
            if not fields:
                self._send_error(400, "至少提供一个可编辑字段")
                return
            if not db.update_worldbook_entry(entry_id, **fields):
                self._send_error(404, "世界书条目不存在")
                return
            self._send_json({"ok": True})

    return Handler


def serve(
    cfg: dict[str, Any],
    port: int | None = None,
    config_path: str | Path | None = None,
) -> None:
    port = port or int(cfg.get("web", {}).get("port", 8765))
    status_store = TaskStatusStore()
    handler = make_handler(cfg, status_store=status_store, config_path=config_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    _start_poller(cfg, status_store)
    print(f"tav2 Web 过程页：http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def _run_next_goal(
    cfg: dict[str, Any], status_store: TaskStatusStore
) -> dict[str, Any] | None:
    """为 serve 配置的项目抢占一个目标并执行 episode（阻塞）；无目标返回 None。"""

    from tav2.agent import run_agent
    from tav2.adapters import get_adapter
    from tav2.agent_session import session_id_for_project_dir

    adapter = get_adapter(cfg)
    project_dir = resolve_project_dir(cfg, adapter.game_dir)
    sid = session_id_for_project_dir(project_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    try:
        claimed = db.session_claim_goal(sid)
    finally:
        db.close()
    if claimed is None:
        return None

    goal = str(claimed.get("goal") or "")
    try:
        status_store.begin(f"agent: {goal}")
    except Exception:
        db = ProjectDB(project_dir / "db.sqlite")
        try:
            db.session_release_claim(sid, claimed)
        finally:
            db.close()
        return None

    db = ProjectDB(project_dir / "db.sqlite")

    def progress(current: int, total: int, message: str) -> None:
        try:
            status_store.set_progress(
                {
                    "phase": "agent",
                    "stage": "agent",
                    "current": current,
                    "total": total,
                    "message": message,
                }
            )
            status_store.append_log(f"[agent] {message}\n")
        except Exception:
            pass

    try:
        result = run_agent(
            cfg,
            goal=goal,
            autonomy=str(claimed.get("autonomy") or ""),
            max_turns=int(claimed.get("max_turns") or 0),
            session_id=sid,
            progress=progress,
        )
        db.session_finish_episode(sid)
        status_store.finish(result=result)
        return result
    except Exception as exc:  # noqa: BLE001
        db.session_release_claim(sid, claimed)
        db.session_finish_episode(sid)
        status_store.fail(str(exc))
        return {"ok": False, "error": str(exc)}
    finally:
        db.close()


def _start_poller(
    cfg: dict[str, Any], status_store: TaskStatusStore, interval: float = 2.0
) -> threading.Thread:
    """后台轮询：全局任务空闲时抢占并执行会话目标队列。"""

    def loop() -> None:
        while True:
            try:
                state = status_store.get()
                if state is None or state.get("status") != "running":
                    _run_next_goal(cfg, status_store)
            except Exception:
                pass
            time.sleep(interval)

    thread = threading.Thread(target=loop, daemon=True, name="agent-poller")
    thread.start()
    return thread
