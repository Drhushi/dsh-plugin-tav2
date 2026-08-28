"""编译版 Ren'Py 游戏一键翻译准备（移植自 v1 translate_agent/prep.py）。

自动完成：版本探测 → SDK 定位 → 抽取归档脚本（.rpyc/.rpymc/.rpy，不抽资源）
→ unrpyc 官方 master 反编译 → 源码参考目录组装（game/ 内绝无 archive.rpa，防双载）
→ 官方模板生成（tl/<lang>）→ 模板落真实游戏目录 → 标识符一致性验证
（原版 rpyc 运行时 dump 比对，缺失 0）。

目录约定（默认）：
- 反编译源码参考：<游戏根>/tav2_src/（引擎不加载它，仅供 gui 变量确认/排查/结项后清理）；
- 翻译模板与译文：<游戏根>/game/tl/<lang>/（真实游戏目录，实机可直接加载验证）；
- 显式传 --work 时保留旧暂存区语义：<work>/<游戏名>_prep。

用法见 cli.py 的 `prepare` 子命令（--game/--sdk/--work）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from tav2.adapters.renpy.templates import run_renpy


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_EXTRACTOR = (
    PROJECT_ROOT / "tav2" / "adapters" / "renpy" / "scripts" / "extract_rpyc.py"
)
SDK_PYTHON = "lib/py3-windows-x86_64/python.exe"

DUMP_TEMPLATE = """init 9999 python:

    import json
    import os

    translator = renpy.game.script.translator
    rows = []

    for fn in sorted(translator.file_translates):
        for label, node in translator.file_translates[fn]:
            rows.append({{
                "file": os.path.basename(fn),
                "label": label,
                "identifier": node.identifier,
                "line": getattr(node, "linenumber", None),
            }})

    with open({dump_path!r}, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
"""


def _unrpyc_candidates(cfg: dict[str, Any]) -> list[Path]:
    """unrpyc 候选：配置 > 环境变量 > v1 工具链 > 常见目录。"""

    out: list[Path] = []
    for raw in (
        (cfg.get("renpy") or {}).get("unrpyc"),
        os.environ.get("UNRPYC_PATH", ""),
        Path.home() / "Documents" / "Translate" / "TranslateAgent" / ".tools"
        / "unrpyc-master" / "unrpyc-master" / "unrpyc.py",
        Path.home() / "Documents" / "Translate" / "unrpyc-master" / "unrpyc.py",
    ):
        if raw:
            out.append(Path(raw))
    return out


def resolve_unrpyc(
    unrpyc: str | Path | None = None,
    cfg: dict[str, Any] | None = None,
) -> Path:
    """解析 unrpyc.py 路径；找不到时给出官方 master 下载指引。"""

    cfg = cfg or {}
    candidates = ([Path(unrpyc)] if unrpyc else []) + _unrpyc_candidates(cfg)
    for c in candidates:
        if c.is_file():
            return c
    raise SystemExit(
        "未找到 unrpyc（须官方 master v2.0.3，不支持 UnRen 内嵌版）。"
        "请配置 renpy.unrpyc 或环境变量 UNRPYC_PATH，"
        "或从 https://github.com/CensoredUsername/unrpyc/archive/refs/heads/master.zip 下载解压。"
    )


def detect_renpy_version(game_dir: Path) -> str | None:
    """读 game/script_version.txt，如 (8, 5, 3) -> '8.5.3'。"""

    for rel in ("game/script_version.txt", "script_version.txt"):
        p = game_dir / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"\(?\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?", text)
        if m:
            return ".".join(x for x in m.groups() if x)
    return None


def find_sdk(
    version: str | None,
    sdk: str | None = None,
    cfg: dict[str, Any] | None = None,
    bases: list[Path] | None = None,
) -> Path | None:
    """定位 SDK：--sdk 参数 > 配置 renpy_sdk > 环境变量 > 常见目录。"""

    cfg = cfg or {}
    candidates: list[Path] = []
    if sdk:
        candidates.append(Path(sdk))
    if cfg.get("renpy_sdk"):
        candidates.append(Path(cfg["renpy_sdk"]))
    env = os.environ.get("RENPY_SDK")
    if env:
        candidates.append(Path(env))
    if version:
        candidates.append(Path.home() / "Documents" / "Translate" / f"renpy-{version}-sdk")
        candidates.append(Path("C:/Program Files/RenPy") / f"renpy-{version}-sdk")
    for base in (bases or [Path.home() / "Documents" / "Translate", PROJECT_ROOT]):
        if base.is_dir():
            for p in sorted(base.glob("renpy-*-sdk")):
                candidates.append(p)
    for c in candidates:
        if (c / "renpy.exe").exists():
            return c
    return None


def sdk_python(sdk: Path) -> Path:
    p = sdk / SDK_PYTHON
    if not p.exists():
        raise SystemExit(f"SDK 缺少捆绑 Python：{p}")
    return p


def find_archives(game_dir: Path) -> list[Path]:
    gamedir = game_dir / "game"
    return sorted(gamedir.glob("*.rpa")) + sorted(gamedir.glob("*.rpi"))


def _run(cmd: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def extract_scripts(sdk: Path, archive: Path, out_game: Path, extractor: Path) -> None:
    """抽取归档里的 .rpyc/.rpymc/.rpy 到 out_game（保留相对路径）。"""

    proc = _run([str(sdk_python(sdk)), str(extractor), str(archive), str(out_game), str(sdk)])
    if proc.returncode != 0:
        raise SystemExit(f"抽取失败 {archive}：\n{(proc.stderr or proc.stdout)[-800:]}")
    print(proc.stdout.strip())


def decompile(sdk: Path, game_dir: Path, unrpyc: Path) -> None:
    if not unrpyc.exists():
        raise SystemExit(
            f"未找到 unrpyc：{unrpyc}\n请下载官方 master 分支并解压："
            "https://github.com/CensoredUsername/unrpyc/archive/refs/heads/master.zip"
        )
    proc = _run([str(sdk_python(sdk)), str(unrpyc), str(game_dir)])
    tail = (proc.stderr or proc.stdout or "").strip()
    if proc.returncode != 0:
        raise SystemExit(f"反编译失败：\n{tail[-1200:]}")
    if "failed" in tail.lower():
        raise SystemExit(f"反编译有失败文件：\n{tail[-1200:]}")
    print(tail[-400:])


def copy_loose_files(src_game: Path, dst_game: Path) -> None:
    """拷贝原 game/ 的松散文件；跳过归档/cache/saves/tl；scripts 只补非 .rpy/.rpyc 配套文件。"""

    for entry in src_game.iterdir():
        name = entry.name
        if entry.is_dir():
            if name in ("cache", "saves", "tl"):
                continue
            if name == "scripts":
                for f in entry.rglob("*"):
                    if f.is_file() and f.suffix.lower() not in (".rpy", ".rpyc"):
                        target = dst_game / f.relative_to(src_game)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(f, target)
                continue
            shutil.copytree(entry, dst_game / name, dirs_exist_ok=True)
        elif name.lower().startswith("archive."):
            continue
        else:
            shutil.copy2(entry, dst_game / name)


def cleanup_compiled_artifacts(game_dir: Path) -> None:
    """删反编译产生的 .rpyc；foo_ren.py 配套的保留原 .rpyc 并删对应 .rpy（避免 Ren'Py 冲突）。"""

    for rpyc in sorted(game_dir.rglob("*.rpyc")):
        ren_py = rpyc.parent / (rpyc.stem + "_ren.py")
        rpy = rpyc.with_suffix(".rpy")
        if ren_py.exists():
            if rpy.exists():
                rpy.unlink()
        else:
            rpyc.unlink()
    cache = game_dir / "cache"
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)


def _build_game_dir(
    real_game: Path,
    sdk: Path,
    parent_root: Path,
    name: str,
    unrpyc: Path,
    extractor: Path | None = None,
) -> Path:
    """建源码参考目录：抽脚本 + 反编译 + 组装。返回游戏根目录（含 game/）。"""

    root = parent_root / name
    game = root / "game"
    parent_resolved = parent_root.resolve()
    root_resolved = root.resolve()
    if game.exists():
        if root_resolved == parent_resolved or parent_resolved not in root_resolved.parents:
            raise SystemExit(f"拒绝重建非工作区目录：{root}")
        shutil.rmtree(root, ignore_errors=True)
    game.mkdir(parents=True)

    extractor = extractor or DEFAULT_EXTRACTOR
    for archive in find_archives(real_game.parent):
        print(f"== 抽取 {archive.name} ==")
        extract_scripts(sdk, archive, game, extractor)

    print("== 反编译 ==")
    decompile(sdk, game, unrpyc)

    print("== 组装源码参考目录（清理编译产物、补松散文件）==")
    copy_loose_files(real_game, game)
    # 先补松散文件（如 *_ren.py）再清理：cleanup 需要根据 _ren.py 判断保留哪个版本
    cleanup_compiled_artifacts(game)
    return root


def generate_templates(sdk: Path, source_root: Path, lang: str) -> None:
    """用官方 SDK 在源码参考目录（无 archive.rpa）上生成 tl/<lang> 模板。"""

    print("== SDK 生成官方模板 ==")
    proc = run_renpy(sdk / "renpy.exe", staging_root, ["translate", lang], timeout=900)
    if proc.returncode != 0:
        raise SystemExit(
            f"模板生成失败（退出码 {proc.returncode}）:\n"
            f"{(proc.stderr or proc.stdout).strip()[-1200:]}"
        )


def collect_template_ids(tl_dir: Path, lang: str) -> set[str]:
    ids: set[str] = set()
    for p in sorted(tl_dir.rglob("*.rpy")):
        if p.name == "common.rpy":
            continue
        ids |= set(
            re.findall(
                rf"^translate {re.escape(lang)} (\S+):",
                p.read_text(encoding="utf-8", errors="replace"),
                re.M,
            )
        )
    return ids


def verify_identifiers(
    sdk: Path,
    real_game: Path,
    work_root: Path,
    lang: str,
    staging_root: Path,
    name: str,
    keep: bool = False,
) -> dict[str, Any]:
    """用原版 rpyc 跑 lint，dump 运行时标识符，与模板比对（缺失 0）。"""

    print("== 标识符验证 ==")
    verify_root = work_root / f"{name}_verify"
    verify_game = verify_root / "game"
    if verify_game.exists():
        shutil.rmtree(verify_root, ignore_errors=True)
    verify_game.mkdir(parents=True)

    for archive in find_archives(real_game.parent):
        extract_scripts(sdk, archive, verify_game, DEFAULT_EXTRACTOR)
        shutil.copy2(archive, verify_game / archive.name)
    copy_loose_files(real_game, verify_game)

    dump_path = staging_root / f"ta_identifiers_{lang}.json"
    if dump_path.exists():
        dump_path.unlink()
    (verify_game / "_ta_dump.rpy").write_text(
        DUMP_TEMPLATE.format(dump_path=str(dump_path)),
        encoding="utf-8",
    )

    proc = run_renpy(sdk / "renpy.exe", verify_root, ["lint"], timeout=900)
    if not dump_path.exists():
        raise SystemExit(
            f"标识符 dump 未生成（lint 退出码 {proc.returncode}）：\n"
            f"{(proc.stderr or proc.stdout).strip()[-1200:]}"
        )

    dump_ids = {row["identifier"] for row in json.loads(dump_path.read_text(encoding="utf-8"))}
    template_ids = collect_template_ids(staging_root / "game" / "tl" / lang, lang)
    missing = dump_ids - template_ids
    extra = template_ids - dump_ids - {"strings"}
    result = {
        "runtime_ids": len(dump_ids),
        "template_ids": len(template_ids),
        "missing_blocks": len(missing),
        "missing": sorted(missing),
        "extra": sorted(extra),
        "ok": not missing,
    }
    print(
        f"  运行时标识符 {len(dump_ids)}，模板标识符 {len(template_ids)}，"
        f"缺失 {len(missing)}，多余 {len(extra)}"
    )
    if not result["ok"]:
        print("  缺失示例：", list(missing)[:5])
    if not keep:
        shutil.rmtree(verify_root, ignore_errors=True)
    return result


def cmd_prepare(
    game_dir: str | Path,
    lang: str = "chinese",
    sdk: str | None = None,
    work_root: str | Path | None = None,
    unrpyc: str | Path | None = None,
    keep_verify: bool = False,
    cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """编译版游戏一键 prepare 入口。返回统计字典并写报告 JSON 到源码参考目录。"""

    game_dir = Path(game_dir)
    if not (game_dir / "game").is_dir():
        raise SystemExit(f"游戏目录无效或缺少 game/ 子目录：{game_dir}")

    version = detect_renpy_version(game_dir)
    print(f"Ren'Py 版本：{version or '未知'}")
    sdk_path = find_sdk(version, sdk, cfg)
    if sdk_path is None:
        raise SystemExit("未找到匹配 SDK，请用 --sdk 指定（版本须与游戏一致）")
    print(f"SDK：{sdk_path}")

    # 源码参考目录：默认放 <游戏根>/tav2_src（用户可见、结项可清）；
    # 显式 --work 保留旧暂存区语义（<work>/<游戏名>_prep）。
    if work_root is not None:
        verify_root_parent = Path(work_root)
        verify_root_parent.mkdir(parents=True, exist_ok=True)
        source_root = verify_root_parent / (game_dir.name + "_prep")
    else:
        verify_root_parent = PROJECT_ROOT / "work"
        verify_root_parent.mkdir(parents=True, exist_ok=True)
        source_root = game_dir.parent / "tav2_src"
    unrpyc_path = resolve_unrpyc(unrpyc, cfg)

    source_dir = _build_game_dir(game_dir / "game", sdk_path, source_root.parent, source_root.name, unrpyc_path)
    generate_templates(sdk_path, source_dir, lang)
    # Ren'Py 生成模板时会向 scripts/ 写回 .rpyc，收尾清理保持源码参考目录整洁
    cleanup_compiled_artifacts(source_dir / "game")

    staging_tl = source_dir / "game" / "tl" / lang
    if not staging_tl.is_dir():
        raise SystemExit("模板目录未生成")

    # 模板落到真实游戏目录（tl 全部为新增文件，符合非侵入契约）：
    # 之后翻译 / 实机语言切换验证 / 封包都在真实游戏目录进行，源码参考目录只留反编译源码。
    real_tl = game_dir / "game" / "tl" / lang
    if real_tl.resolve() != staging_tl.resolve():
        shutil.copytree(staging_tl, real_tl, dirs_exist_ok=True)
        shutil.rmtree(staging_tl, ignore_errors=True)

    # 先用原版 rpyc 跑 lint 生成运行时标识符 dump（编译版的权威标识符集）
    verify = verify_identifiers(
        sdk_path,
        game_dir / "game",
        verify_root_parent,
        lang,
        source_dir,
        source_root.name,
        keep=keep_verify,
    )

    from tav2.adapters.renpy.template_diff import template_integrity

    renpy_cfg = (cfg or {}).get("renpy") or {}
    runtime_ids: set[str] | None = None
    dump_path = source_dir / f"ta_identifiers_{lang}.json"
    if dump_path.exists():
        runtime_ids = {
            row["identifier"] for row in json.loads(dump_path.read_text(encoding="utf-8"))
        }
    integrity = template_integrity(
        game_dir / "game",
        lang,
        source_dir=source_dir / "game",
        patch=bool(renpy_cfg.get("template_patch", True)),
        patch_strings=bool(renpy_cfg.get("patch_missing_strings", False)),
        runtime_ids=runtime_ids,
    )
    print(
        "模板完整性：源码 "
        f"{integrity['source_dialogue_units']} 单元 / 模板 "
        f"{integrity['template_dialogue_blocks']} 块（权威 "
        f"{'运行时' if runtime_ids is not None else '源码'} 口径），缺失补入 "
        f"{len(integrity['added_from_source'])}，选项字符串补入 "
        f"{integrity['added_strings']}，跳过审计 "
        f"{integrity['skipped_source_statements']} 条"
    )

    from tav2.adapters.renpy import fonts as renpy_fonts
    from tav2.adapters.renpy import tlparser
    from tav2.tokens import estimate_tokens

    font_stats = renpy_fonts.generate_font_patches(game_dir, lang, cfg or {})
    _files, dialogue, strings = tlparser.load_work(game_dir, lang)
    src_tokens = sum(estimate_tokens(u.source_text) for u in dialogue) + sum(
        estimate_tokens(s.source_text) for s in strings
    )
    print(
        f"对话单元：{len(dialogue)}｜字符串：{len(strings)}｜"
        f"源文本约 {src_tokens} token"
    )
    summary = {
        "game": str(game_dir),
        "version": version,
        "sdk": str(sdk_path),
        "source_dir": str(source_dir),
        "tl": str(real_tl),
        "dialogue": len(dialogue),
        "strings": len(strings),
        "source_tokens": src_tokens,
        "fonts": font_stats,
        "template_integrity": integrity,
        "identifier_verify": verify,
    }
    report_path = source_dir / "prepare_report.json"
    report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告：{report_path}")
    print(
        "\n== 下一步 ==\n"
        f"翻译模板已写入真实游戏目录：{real_tl}\n"
        f"反编译源码参考在 {source_dir}（引擎不加载它，仅供 gui 变量确认与排查）。\n"
        "无需切换项目：tav2_status / tav2_translate_batch / tav2_check 直接绑定原游戏目录。\n"
        "语言切换可立即实机验证（游戏内 设置→语言）；确认通过后再 tav2_pack 封包，\n"
        "封包时可传 clean_source=true 清理源码参考目录。"
    )
    return summary
