"""翻译模板生成：优先官方 SDK，回退游戏自带运行时，最后有限解析器。

移植自 TranslateAgent v1 的 translate_agent/templates.py。
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from tav2.adapters.renpy.fallback_parser import parse_dialogue_units
from tav2.adapters.renpy.renpy_compat import quote_unicode
from tav2.adapters.renpy.renpy_models import DialogueUnit, StringUnit


SCAN_STRING_RE = re.compile(
    r"""(?x)
    \b_[_p]?\s*(\((?:[\s\\\n]*[uU]?(?:
    \"\"\"(?:\\.|\\\n|\"{1,2}|[^\\"])*?\"\"\"
    |'''(?:\\.|\\\n|\'{1,2}|[^\\'])*?'''
    |"(?:\\.|\\\n|[^\\"])*"
    |'(?:\\.|\\\n|[^\\'])*'
    ))+\s*\))
    """
)


def _is_python_executable(path: Path) -> bool:
    return path.name.lower().endswith(".py")


def renpy_candidates(game_dir: Path, sdk: str | None) -> list[Path]:
    """按优先级返回可用的 Ren'Py 运行时：配置 SDK → 环境变量 → 游戏自带。"""

    candidates: list[Path] = []
    for base in [sdk, os.environ.get("RENPY_SDK", ""), ""]:
        if not base:
            continue
        base_path = Path(base)
        for name in ("renpy.exe", "renpy.py"):
            candidate = base_path / name
            if candidate.exists():
                candidates.append(candidate)
    for name in ("renpy.exe", "renpy.py"):
        candidate = game_dir / name
        if candidate.exists():
            candidates.append(candidate)
    for candidate in sorted(game_dir.glob("*.exe")):
        if candidate.stem != "renpy" and (game_dir / (candidate.stem + ".py")).exists():
            candidates.append(candidate)
    return candidates


def run_renpy(
    executable: Path, game_dir: Path, args: list[str], timeout: int = 600
) -> subprocess.CompletedProcess:
    """执行 renpy 命令。APPDATA 重定向到临时目录，避免写入用户目录。"""

    import tempfile

    appdata_dir = Path(tempfile.mkdtemp(prefix="renpy_appdata_"))
    env = dict(os.environ)
    env["APPDATA"] = str(appdata_dir)

    cmd = [str(executable)] if not _is_python_executable(executable) else [sys.executable, str(executable)]
    cmd += [str(game_dir)] + args
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=str(executable.parent),
        env=env,
    )


def generate_templates(game_dir: str | Path, lang: str, cfg: dict[str, Any]) -> tuple[str, str | None]:
    """生成 tl/<lang> 模板。返回 (方式, 说明)。

    方式：sdk（官方命令）/ bundled（游戏自带运行时）/ fallback（内置解析器）。
    """

    game_dir = Path(game_dir)
    sdk = cfg.get("renpy_sdk") or None
    candidates = renpy_candidates(game_dir, sdk)

    for executable in candidates:
        try:
            result = run_renpy(executable, game_dir, ["translate", lang, "--no-todo"])
        except Exception as exc:  # noqa: BLE001
            print(f"  [跳过] {executable.name} 执行失败：{exc}")
            continue
        if result.returncode == 0:
            return ("sdk" if _is_sdk(executable) else "bundled"), str(executable)
        print(f"  [跳过] {executable.name} 退出码 {result.returncode}")
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-1:]
        if tail:
            print(f"          {tail[0][:200]}")

    dialogue = parse_dialogue_units(game_dir)
    strings = scan_fallback_strings(game_dir)
    write_fallback_templates(game_dir, lang, dialogue, strings)
    return "fallback", None


def _is_sdk(executable: Path) -> bool:
    return "renpy-8" in str(executable) or "renpy-7" in str(executable)


def scan_fallback_strings(game_dir: Path) -> list[StringUnit]:
    """兜底字符串扫描：_()/_p() 包裹的字符串。"""

    strings: list[StringUnit] = []
    seen: set[str] = set()
    for path in sorted(game_dir.rglob("*.rpy")):
        if "tl" in path.relative_to(game_dir).parts:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(content.split("\n"), start=1):
            for m in SCAN_STRING_RE.finditer(line):
                expr = m.group(1).replace("\\\n", "").strip()
                try:
                    value = ast.literal_eval(expr)
                except Exception:
                    continue
                if not isinstance(value, str) or not value:
                    continue
                if m.group(0).lstrip().startswith("_p"):
                    value = _reformat_p(value)
                if value in seen:
                    continue
                seen.add(value)
                strings.append(
                    StringUnit(
                        old=value,
                        new="",
                        filename=path.relative_to(game_dir).as_posix(),
                        linenumber=lineno,
                    )
                )
    return strings


def _reformat_p(s: str) -> str:
    """_p() 的简化重排：按行去掉首尾空白，空行分隔段落。"""

    lines = s.split("\n")
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped and out and out[-1] != "":
            out.append("")
        elif stripped:
            out.append(stripped)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)


def write_fallback_templates(
    game_dir: Path,
    lang: str,
    dialogue: list[DialogueUnit],
    strings: list[StringUnit],
) -> None:
    """用内置解析器的结果写出 tl/<lang> 模板（SDK 不可用时的兜底）。"""

    tl_dir = game_dir / "tl" / lang
    tl_dir.mkdir(parents=True, exist_ok=True)

    by_file: dict[str, list[DialogueUnit]] = {}
    for unit in dialogue:
        by_file.setdefault(unit.filename, []).append(unit)

    for filename, units in by_file.items():
        lines: list[str] = []
        for unit in units:
            lines.append(f"translate {lang} {unit.identifier}:")
            lines.append("")
            lines.append(f"    # {unit.filename}:{unit.linenumber}")
            for raw in unit.raw_statements:
                lines.append(f"    # {raw}")
                lines.append(f"    {raw}")
            for say in unit.say_lines:
                lines.append(f"    # {say.raw}")
                lines.append(f"    {say.render('')}")
            lines.append("")
        target = tl_dir / filename
        if target.suffix == ".rpym":
            target = target.with_suffix(".rpy")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("\n".join(lines), encoding="utf-8")

    if strings:
        lines = [f"translate {lang} strings:", ""]
        for s in strings:
            lines.append(f"    # {s.filename}:{s.linenumber}")
            lines.append(f'    old "{quote_unicode(s.old)}"')
            lines.append('    new ""')
            lines.append("")
        (tl_dir / "strings.rpy").write_text("\n".join(lines), encoding="utf-8")
