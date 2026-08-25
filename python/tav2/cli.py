"""CLI 入口：init / prepare / worldbook / terms / deliberate / translate / status /
check / backfill / deploy / approvals / agent / serve。"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from tav2.config import (
    find_config_path,
    load_config,
    resolve_project_dir,
    save_config,
    set_llm_profile,
    write_example_config,
)
from tav2.db import ProjectDB
from tav2.llm import create_llm


def _args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tav2", description="TranslateAgent v2")
    parser.add_argument("--config", default=None, help="config.yaml 路径")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="生成示例配置")
    p_prepare = sub.add_parser("prepare", help="生成 tl 模板与字体补丁")
    p_prepare.add_argument("--game", default=None)
    p_prepare.add_argument("--sdk", default=None)
    p_prepare.add_argument(
        "--work",
        default=None,
        help="工作根目录（默认 <工程根>/work；编译版解包/反编译/staging 产物所在）",
    )
    p_wb = sub.add_parser("worldbook", help="生成世界书条目")
    p_wb.add_argument("--force", action="store_true", help="覆盖已生成条目")
    p_terms = sub.add_parser("terms", help="快筛术语候选入库")
    p_terms.add_argument("--apply", default=None, help="JSON 文件 [[源,译,类别],...] 批量锁定")
    sub.add_parser("deliberate", help="多方位推敲待决术语")
    p_tr = sub.add_parser("translate", help="双阶段翻译并直写 tl（或出审校表）")
    p_tr.add_argument("--limit", type=int, default=None)
    p_tr.add_argument("--batch-mode", choices=("auto", "fixed"), default="")
    p_tr.add_argument("--budget", type=int, default=0, help="本轮总 token 预算，0=用配置默认")
    p_tr.add_argument("--dry-run", action="store_true")
    p_tr.add_argument("--review", action="store_true", help="本次走审校表模式")
    sub.add_parser("status", help="查看项目状态")
    sub.add_parser("check", help="一致性审计与回填校验")
    p_bf = sub.add_parser("backfill", help="从审校表回填")
    p_bf.add_argument("--review-file", required=True, help="审校表 xlsx 路径")
    p_dp = sub.add_parser("deploy", help="把 tl/<lang> 拷到目标游戏目录")
    p_dp.add_argument("--target", required=True, help="原版游戏根目录")
    p_ap = sub.add_parser("approvals", help="审批队列管理")
    p_ap.add_argument("action", choices=["list", "approve", "reject"])
    p_ap.add_argument("id", type=int, nargs="?", default=None)
    p_agent = sub.add_parser("agent", help="对话式主管 Agent（会话/目标/审批）")
    p_agent.add_argument(
        "action",
        choices=["run", "goal", "status", "approve", "reject", "stop", "resume"],
    )
    p_agent.add_argument("--goal", default="", help="目标文本（run/goal）")
    p_agent.add_argument(
        "--autonomy", default="", help="自主级别 suggest / auto_low / auto_high"
    )
    p_agent.add_argument("--max-turns", type=int, default=0)
    p_agent.add_argument("--run-id", default="")
    p_agent.add_argument("--resume", action="store_true", help="恢复上次 run 的历史")
    p_agent.add_argument("--id", type=int, default=None, help="审批动作 id（approve/reject）")
    p_agent.add_argument("--reason", default="", help="驳回原因（reject）")
    p_cfg = sub.add_parser("config", help="LLM 供应商 profile：list / switch")
    p_cfg.add_argument("action", choices=["list", "switch"])
    p_cfg.add_argument("name", nargs="?", default=None, help="profile 名（switch 用）")
    p_srv = sub.add_parser("serve", help="启动本地 Web 过程页")
    p_srv.add_argument("--port", type=int, default=None)
    return parser.parse_args(argv)


def _setup(cfg_path: str | None) -> tuple[dict[str, Any], ProjectDB, Any]:
    cfg = load_config(cfg_path)
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    project_dir = resolve_project_dir(cfg, adapter.game_dir)
    db = ProjectDB(project_dir / "db.sqlite")
    llm = create_llm(cfg)
    return cfg, db, llm


def _cmd_init(args: argparse.Namespace) -> int:
    path = write_example_config(Path.cwd() / "config.yaml")
    print(f"已生成示例配置：{path}")
    print("请编辑 game_dir 与 llm.api_key_env，然后运行 `python -m tav2 prepare`。")
    return 0


def _cmd_prepare(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    if args.game:
        cfg["game_dir"] = args.game
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    project_dir = resolve_project_dir(cfg, adapter.game_dir)
    _db = ProjectDB(project_dir / "db.sqlite")
    stats = adapter.prepare(
        sdk=args.sdk,
        work_dir=Path(args.work) if args.work else None,
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def _cmd_worldbook(args: argparse.Namespace) -> int:
    cfg, db, llm = _setup(args.config)
    existing = db.load_worldbook()
    if existing and not args.force:
        print(f"世界书已有 {len(existing)} 条（--force 可重新生成）。")
        return 0
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    lines = adapter.scan_lines()
    if not lines:
        print("未找到可扫描的原文行。")
        return 1
    print(f"扫描 {len(lines)} 行原文…")

    def progress(done: int, total: int) -> None:
        print(f"  [世界书] 块 {done}/{total}")

    from tav2.worldbook import generate_worldbook

    entries = generate_worldbook(llm, cfg, lines, progress=progress)
    from tav2.worldbook import coverage_report

    report = coverage_report(entries, _source_file_count(lines), len(lines))
    for warning in report["warnings"]:
        print(f"  [覆盖率告警] {warning}")
    print(
        f"覆盖率：条目 {report['entries']}，来源文件 {report['source_files']}，"
        f"引用文件 {report['files_referenced']}（{report['file_coverage']:.0%}）"
    )
    db.save_worldbook([e.to_dict() for e in entries])
    print(f"世界书生成完成：{len(entries)} 条（常驻 {sum(1 for e in entries if e.kind == 'constant')} 条）。")
    return 0


def _source_file_count(lines: list[str]) -> int:
    """统计 scan_lines 前缀 [文件:行号] 中的不同文件数。"""

    names: set[str] = set()
    for line in lines:
        m = re.match(r"\[([^:\]]+):", line)
        if m:
            names.add(m.group(1))
    return len(names)


def _cmd_terms(args: argparse.Namespace) -> int:
    cfg, db, _llm = _setup(args.config)
    if args.apply:
        path = Path(args.apply)
        items = json.loads(path.read_text(encoding="utf-8"))
        from tav2.terms import lock_terms

        locked = lock_terms(db, [tuple(i) for i in items])
        print(f"已锁定 {locked} 条术语。")
        return 0
    from tav2.adapters import get_adapter
    from tav2.scanning import scan_lines
    from tav2.terms import seed_terms

    adapter = get_adapter(cfg)
    lines = adapter.scan_lines()
    candidates = scan_lines(lines, cfg)
    seeded = seed_terms(db, candidates)
    print(f"扫描出 {len(candidates)} 个候选，入库 {seeded} 个。")
    print("下一步：`python -m tav2 deliberate` 多方位推敲。")
    return 0


def _cmd_deliberate(args: argparse.Namespace) -> int:
    cfg, db, llm = _setup(args.config)
    from tav2.deliberation import evaluate_candidates

    stats = evaluate_candidates(llm, db, cfg)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def _cmd_translate(args: argparse.Namespace) -> int:
    cfg, db, llm = _setup(args.config)
    if args.review:
        cfg["review"]["enabled"] = True
    from tav2.adapters import get_adapter
    from tav2.task_status import task_session
    from tav2.translate import TranslateRunner

    adapter = get_adapter(cfg)
    with task_session("translate"):
        runner = TranslateRunner(cfg, adapter, db, llm)
        stats = runner.run(
            limit=args.limit,
            dry_run=args.dry_run,
            batch_mode=args.batch_mode,
            budget=args.budget,
        )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    if cfg.get("review", {}).get("enabled", False):
        print("审校模式：请人工确认 projects/<游戏>/review_*.xlsx 后运行 backfill。")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    cfg, db, _llm = _setup(args.config)
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    document = adapter.extract()
    total_units = len(document.all_units())
    pending = [u for u in document.all_units() if not u.extra.get("translated", False)]
    print(f"引擎：{adapter.engine}")
    print(f"场景：{len(document.scenes)}  单元：{total_units}  待译：{len(pending)}")
    print(f"锁定术语：{len(db.locked_terms())}  待决候选：{len(db.pending_terms())}")
    print(f"世界书条目：{len(db.load_worldbook())}")
    print(f"待审批：{len(db.pending_approvals())}")
    for branch in ("main",):
        summary = db.get_summary(branch)
        if summary:
            print(f"[{branch} 摘要] {summary[:80]}…")
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    cfg, db, _llm = _setup(args.config)
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    report = adapter.verify()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("missing_blocks", 0) == 0 else 1


def _cmd_backfill(args: argparse.Namespace) -> int:
    cfg, db, _llm = _setup(args.config)
    from tav2.adapters import get_adapter
    from tav2.adapters.renpy.backfill import backfill_review, iter_applied_rows
    from tav2.review import read_review_sheet

    adapter = get_adapter(cfg)
    rows = read_review_sheet(Path(args.review_file))
    applied_rows = list(iter_applied_rows(rows))
    stats = backfill_review(adapter.game_dir, adapter.lang, rows)
    if applied_rows:
        from tav2.translate import unit_context_fp

        document = adapter.extract()
        meta = {u.unit_id: u for u in document.all_units()}
        scene_by_unit = {
            u.unit_id: scene for scene in document.scenes for u in scene.units
        }
        synced = 0
        for row in applied_rows:
            unit = _match_review_unit(row, meta)
            if unit is None:
                continue
            translation = str(row.get("人工译文") or row.get("机器译文") or "").strip()
            if not translation:
                continue
            db.set_unit_status(unit.unit_id, "translated")
            fp = (
                unit_context_fp(unit, scene_by_unit[unit.unit_id])
                if unit.unit_id in scene_by_unit
                else ""
            )
            db.tm_put(unit.source, unit.unit_id, translation, fp)
            synced += 1
        stats["db_synced"] = synced
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def _match_review_unit(row: dict[str, Any], meta: dict[str, Any]):
    """把审校行映射回 Unit（按文件/标识符/序号或字符串 old）。"""

    row_type = str(row.get("类型") or "")
    filename = str(row.get("文件") or "")
    if row_type == "dialogue":
        identifier = str(row.get("标识符") or "")
        try:
            say_index = int(row.get("序号") or 0)
        except (TypeError, ValueError):
            say_index = 0
        unit = meta.get(f"{identifier}#{say_index}")
        if unit is not None and unit.extra.get("file") == filename:
            return unit
        return None
    if row_type == "string":
        old = str(row.get("标识符") or "")
        for unit in meta.values():
            if (
                unit.kind == "string"
                and unit.extra.get("file") == filename
                and unit.source == old
            ):
                return unit
    return None


def _cmd_deploy(args: argparse.Namespace) -> int:
    cfg, _db, _llm = _setup(args.config)
    from tav2.adapters import get_adapter

    adapter = get_adapter(cfg)
    gamedir = adapter.game_dir / "game" if (adapter.game_dir / "game").is_dir() else adapter.game_dir
    tl_dir = gamedir / "tl" / adapter.lang
    if not tl_dir.exists():
        print(f"未找到 {tl_dir}")
        return 1
    target = Path(args.target)
    target_game = target / "game" if (target / "game").is_dir() else target
    target_tl = target_game / "tl" / adapter.lang
    shutil.copytree(tl_dir, target_tl, dirs_exist_ok=True)
    font_dir = tl_dir / "font"
    if font_dir.exists():
        shutil.copytree(font_dir, target_tl / "font", dirs_exist_ok=True)
    print(f"已部署 tl/{adapter.lang} → {target_tl}")
    return 0


def _cmd_approvals(args: argparse.Namespace) -> int:
    cfg, db, _llm = _setup(args.config)
    if args.action == "list":
        for item in db.pending_approvals():
            print(f"[{item['id']}] {item['kind']}: {json.dumps(item['payload'], ensure_ascii=False)}")
        return 0
    if args.id is None:
        print("需要审批 id。")
        return 1
    ok = db.decide_approval(args.id, "approved" if args.action == "approve" else "rejected")
    if not ok:
        print("审批失败（id 不存在）。")
        return 1
    # 批准术语时同步锁定到 terms 表
    item = db.conn.execute(
        "SELECT * FROM approval_queue WHERE id=?", (args.id,)
    ).fetchone()
    if item and item["kind"] == "term" and args.action == "approve":
        payload = json.loads(item["payload"])
        db.upsert_term(
            payload.get("source", ""),
            payload.get("target", ""),
            "",
            status="locked",
            confidence=str(payload.get("confidence") or "human"),
            evidence=str(payload.get("rationale") or ""),
        )
    print(f"已{ '批准' if args.action == 'approve' else '驳回' } {args.id}。")
    return 0


def _cmd_config(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    path = find_config_path(args.config) or Path.cwd() / "config.yaml"
    if args.action == "list":
        current = str(cfg.get("llm_profile") or "")
        print(f"当前供应商：{current or '（自定义，未应用任何 profile）'}")
        for name, prof in (cfg.get("llm_profiles") or {}).items():
            if not isinstance(prof, dict):
                continue
            print(
                f"  - {name}: base_url={prof.get('base_url')} "
                f"model={prof.get('model')} key_env={prof.get('api_key_env')}"
            )
        print("切换：python -m tav2 --config config.yaml config switch <name>")
        return 0
    if args.action == "switch":
        if not args.name:
            print("需要指定 profile 名（先运行 config list 查看可用项）。")
            return 1
        errors = set_llm_profile(cfg, args.name)
        if errors:
            print("；".join(f"{k}: {v}" for k, v in errors.items()))
            return 1
        try:
            save_config(cfg, path)
        except OSError as exc:
            print(f"配置写入失败：{exc}")
            return 1
        print(
            f"已切换到供应商：{args.name}（base_url={cfg['llm']['base_url']}, "
            f"model={cfg['llm']['model']}）"
        )
        print("请在环境变量中配置对应 API Key（或通过网页配置界面填写明文 Key）。")
        return 0
    return 1


def _cmd_serve(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    from tav2.web import serve

    serve(cfg, port=args.port, config_path=args.config)
    return 0


def _cmd_agent(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    if args.action == "goal":
        from tav2.agent_session import submit_goal

        result = submit_goal(
            cfg, args.goal, autonomy=args.autonomy, max_turns=args.max_turns
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    if args.action == "run":
        from tav2.agent import run_agent
        from tav2.task_status import task_session

        with task_session("agent"):
            result = run_agent(
                cfg,
                goal=args.goal,
                autonomy=args.autonomy,
                max_turns=args.max_turns,
                run_id=args.run_id,
                resume=args.resume,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("status") in ("done", "stopped") else 1
    if args.action == "status":
        from tav2.agent import agent_status
        from tav2.agent_session import session_status

        merged = {**session_status(cfg), **agent_status(cfg)}
        print(json.dumps(merged, ensure_ascii=False, indent=2))
        return 0
    if args.action in ("approve", "reject"):
        if args.id is None:
            print("需要 --id 指定审批动作。")
            return 1
        from tav2.agent import approve_action, reject_action

        if args.action == "approve":
            result = approve_action(cfg, args.id)
        else:
            result = reject_action(cfg, args.id, args.reason)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    if args.action == "stop":
        from tav2.agent_session import stop_session

        result = stop_session(cfg)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    if args.action == "resume":
        from tav2.agent_session import resume_session

        result = resume_session(cfg)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    return 1


def main(argv: list[str] | None = None) -> int:
    args = _args(argv)
    handlers = {
        "init": _cmd_init,
        "prepare": _cmd_prepare,
        "worldbook": _cmd_worldbook,
        "terms": _cmd_terms,
        "deliberate": _cmd_deliberate,
        "translate": _cmd_translate,
        "status": _cmd_status,
        "check": _cmd_check,
        "backfill": _cmd_backfill,
        "deploy": _cmd_deploy,
        "approvals": _cmd_approvals,
        "agent": _cmd_agent,
        "config": _cmd_config,
        "serve": _cmd_serve,
    }
    try:
        return handlers[args.command](args)
    except Exception as exc:  # noqa: BLE001
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
