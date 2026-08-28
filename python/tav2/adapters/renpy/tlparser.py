"""解析 / 重建 tl/<语言>/*.rpy 翻译文件。

移植自 TranslateAgent v1 的 translate_agent/tlparser.py。
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path

from tav2.adapters.renpy.fallback_parser import _tokenize
from tav2.adapters.renpy.renpy_compat import (
    TEMP_TAG_RE,
    decode_string,
    ensure_translation_tag,
    quote_unicode,
    unquote_unicode,
)
from tav2.adapters.renpy.renpy_models import DialogueUnit, SayLine, StringUnit


HEADER_RE = re.compile(r"^translate\s+(\S+)\s+([^:]+):$")

# old/new 只属于 strings 块；混进对话块（如旧版把游戏自带 translate 块写进模板）时不按 say 解析
NON_SAY_PREFIXES = ("voice", "nvl", "pass", "if ", "else", "elif", "$", "python", "call", "jump", "old ", "new ")


def _parse_string_literal(literal: str) -> str:
    """解析 tl 文件中的字符串字面量（Python 语义）。"""

    literal = literal.strip()
    try:
        return ast.literal_eval(literal)
    except Exception:
        if len(literal) >= 2 and literal[0] == literal[-1] and literal[0] in "\"'`":
            return unquote_unicode(literal[1:-1])
        return unquote_unicode(literal)


@dataclass
class StringPair:
    old_idx: int
    new_idx: int
    old: str
    new: str


@dataclass
class TlChunk:
    kind: str  # "dialogue" | "strings" | "python" | "style" | "raw"
    raw: list[str] = field(default_factory=list)
    header_index: int = 0
    identifier: str | None = None
    say_lines: list[SayLine] = field(default_factory=list)
    originals: list[SayLine] = field(default_factory=list)
    body_lines: list[tuple[int, str, bool]] = field(default_factory=list)
    pairs: list[StringPair] = field(default_factory=list)


def _parse_say_line(text: str, indent: str = "") -> SayLine | None:
    """解析 tl 文件中的规范 say 行；失败返回 None。"""

    stripped = text.strip()
    if not stripped:
        return None
    if stripped.startswith(NON_SAY_PREFIXES):
        return None
    tokens = _tokenize(stripped)
    if not tokens:
        return None

    who: str | None = None
    attrs: list[str] = []
    temps: list[str] = []
    idx = 0
    if tokens[0][0] == "STR":
        if len(tokens) > 1 and tokens[1][0] == "STR":
            who = decode_string(tokens[0][1])
            idx = 1
    else:
        who = tokens[0][1]
        idx = 1
        in_temp = False
        while idx < len(tokens) and tokens[idx][0] != "STR":
            if tokens[idx][0] == "PUNCT":
                # say 的 who/属性区只有词与 @；出现括号等标点说明是函数调用等表达式语句
                # （如死块里回读的 renpy.register_shader(...)），当 say 解析会产出非法说话人单元。
                if tokens[idx][1] != "@":
                    return None
                in_temp = True
            else:
                # say 行的 who/属性位不可能含 =；含 = 的是赋值行（gui.text_font = "..."），
                # 解析成 say 会产出非法说话人噪声单元（invalid_speakers / 待译队列污染）。
                if tokens[idx][0] == "WORD" and "=" in tokens[idx][1]:
                    return None
                (temps if in_temp else attrs).append(tokens[idx][1])
            idx += 1

    if idx >= len(tokens) or tokens[idx][0] != "STR":
        return None

    what = decode_string(tokens[idx][1])
    prefix_parts: list[str] = []
    if who is not None:
        prefix_parts.append(who)
    prefix_parts.extend(attrs)
    if temps:
        prefix_parts.append("@")
        prefix_parts.extend(temps)

    suffix_parts: list[str] = []
    for kind, value in tokens[idx + 1 :]:
        suffix_parts.append(value)

    say = SayLine(
        who=who,
        what=what,
        prefix=" ".join(prefix_parts),
        suffix=" ".join(suffix_parts),
        raw=stripped,
        indent=indent,
    )
    return say


def parse_tl_file(path: Path, lang: str) -> list[TlChunk]:
    """解析单个 tl 文件为块列表。"""

    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")
    chunks: list[TlChunk] = []
    current: TlChunk | None = None

    for idx, line in enumerate(lines):
        m = HEADER_RE.match(line.strip())
        if m and m.group(1) == lang:
            if current is not None:
                chunks.append(current)
            identifier = m.group(2).strip()
            if identifier == "strings":
                current = TlChunk(kind="strings", header_index=idx, identifier="strings")
            elif identifier == "python":
                current = TlChunk(kind="python", header_index=idx, identifier="python")
            elif identifier.startswith("style "):
                current = TlChunk(kind="style", header_index=idx, identifier=identifier)
            else:
                current = TlChunk(kind="dialogue", header_index=idx, identifier=identifier)
            current.raw.append(line)
            continue

        if current is None:
            if not chunks:
                chunks.append(TlChunk(kind="raw", raw=[line]))
            elif line.strip():
                chunks.append(TlChunk(kind="raw", raw=[line]))
            else:
                chunks[-1].raw.append(line)
            continue

        current.raw.append(line)
        stripped = line.strip()

        if current.kind == "strings":
            old_m = re.match(r"^old\s+(.+)$", stripped)
            new_m = re.match(r"^new\s+(.+)$", stripped)
            if old_m:
                current.pairs.append(
                    StringPair(idx, -1, _parse_string_literal(old_m.group(1)), "")
                )
            elif new_m and current.pairs and current.pairs[-1].new_idx == -1:
                pair = current.pairs[-1]
                pair.new = _parse_string_literal(new_m.group(1))
                pair.new_idx = len(current.raw) - 1
        elif current.kind == "dialogue":
            if stripped.startswith("#") or not stripped:
                current.body_lines.append((idx, line, False))
            else:
                say = _parse_say_line(stripped, indent=line[: len(line) - len(line.lstrip())])
                if say is not None:
                    original = _parse_say_line(_last_comment_line(current))
                    if original is not None:
                        say.original_what = original.what
                    current.originals.append(original)
                    current.say_lines.append(say)
                    current.body_lines.append((idx, line, True))
                else:
                    current.body_lines.append((idx, line, False))

    if current is not None:
        chunks.append(current)
    return chunks


def parse_tl_directory(game_dir: Path, lang: str) -> list[tuple[Path, list[TlChunk]]]:
    """解析 tl/<lang>/ 下所有 .rpy 文件。"""

    gamedir = game_dir / "game" if (game_dir / "game").is_dir() else game_dir
    tl_dir = gamedir / "tl" / lang
    result: list[tuple[Path, list[TlChunk]]] = []
    if not tl_dir.exists():
        return result
    for path in sorted(tl_dir.rglob("*.rpy")):
        result.append((path, parse_tl_file(path, lang)))
    return result


def _last_comment_line(chunk: TlChunk) -> str:
    """取块内最近一条 # 注释的内容。"""

    for idx, text, _is in reversed(chunk.body_lines):
        stripped = text.strip()
        if stripped.startswith("# "):
            return stripped[2:]
    return ""


def load_work(
    game_dir: Path, lang: str
) -> tuple[list[tuple[Path, list[TlChunk]]], list[DialogueUnit], list[StringUnit]]:
    """加载 tl/<lang>：返回 (文件块, 对话单元, 字符串单元)。"""

    files = parse_tl_directory(game_dir, lang)
    dialogue: list[DialogueUnit] = []
    strings: list[StringUnit] = []

    gamedir = Path(game_dir) / "game" if (Path(game_dir) / "game").is_dir() else Path(game_dir)
    tl_root = gamedir / "tl" / lang
    for path, chunks in files:
        rel = path.relative_to(tl_root).as_posix()
        for chunk in chunks:
            if chunk.kind == "dialogue":
                line = _chunk_line_number(chunk)
                unit = DialogueUnit(
                    identifier=chunk.identifier or "",
                    filename=rel,
                    linenumber=line,
                    label=None,
                    say_lines=list(chunk.say_lines),
                    raw_statements=[
                        text for _i, text, is_say in chunk.body_lines if not is_say and text.strip()
                    ],
                )
                for say, original in zip(chunk.say_lines, chunk.originals):
                    # original 可能为 None（注释行解析不成 say，如 `# file:line`）；与上方 L174 守卫对齐。
                    say.original_what = original.what if original is not None else None
                dialogue.append(unit)
            elif chunk.kind == "strings":
                for pair in chunk.pairs:
                    strings.append(
                        StringUnit(
                            old=pair.old,
                            new=pair.new,
                            filename=rel,
                            linenumber=pair.old_idx,
                        )
                    )
    return files, dialogue, strings


def _chunk_line_number(chunk: TlChunk) -> int:
    """从块内 `# file:line` 注释解析行号。"""

    for idx, text, _is in chunk.body_lines:
        m = re.search(r":(\d+)\s*$", text.strip())
        if m:
            return int(m.group(1))
    return 0


def rebuild_chunk(
    chunk: TlChunk,
    say_translations: dict[int, str] | None = None,
    string_translations: dict[str, str] | None = None,
) -> list[str]:
    """重建块内容。say_translations: say_lines 下标 -> 译文；string_translations: old -> 新译文。"""

    if chunk.kind in ("raw", "python", "style"):
        return list(chunk.raw)

    if chunk.kind == "dialogue":
        translations = say_translations or {}
        out: list[str] = [chunk.raw[0]] if chunk.raw else []
        say_index = 0
        for idx, text, is_say in chunk.body_lines:
            if not is_say:
                out.append(text)
                continue
            original = chunk.say_lines[say_index]
            new_what = translations.get(say_index)
            out.append(original.render(new_what) if new_what is not None else text)
            say_index += 1
        return out

    out = list(chunk.raw)
    string_translations = string_translations or {}
    if string_translations:
        old_has_new: dict[int, bool] = {}
        last_old_idx: int | None = None
        for idx, line in enumerate(out):
            stripped = line.strip()
            if re.match(r"^old\s+(.+)$", stripped):
                last_old_idx = idx
                old_has_new[idx] = False
            elif re.match(r"^new\s+(.+)$", stripped) and last_old_idx is not None:
                old_has_new[last_old_idx] = True
        result: list[str] = []
        current_old: str | None = None
        for idx, line in enumerate(out):
            stripped = line.strip()
            old_m = re.match(r"^old\s+(.+)$", stripped)
            new_m = re.match(r"^new\s+(.+)$", stripped)
            if old_m:
                current_old = _parse_string_literal(old_m.group(1))
                result.append(line)
                if not old_has_new.get(idx, False):
                    translation = string_translations.get(current_old)
                    if translation is not None:
                        translation = ensure_translation_tag(current_old, translation)
                        indent = line[: len(line) - len(line.lstrip())]
                        result.append(indent + 'new "{}"'.format(quote_unicode(translation)))
            elif new_m and current_old is not None:
                translation = string_translations.get(current_old)
                if translation is not None:
                    translation = ensure_translation_tag(current_old, translation)
                    indent = line[: len(line) - len(line.lstrip())]
                    result.append(indent + 'new "{}"'.format(quote_unicode(translation)))
                else:
                    result.append(line)
            else:
                result.append(line)
        return result
    return out


def restore_chunk(chunk: TlChunk) -> list[str]:
    """把已翻译的块还原为模板态。"""

    if chunk.kind in ("raw", "python", "style"):
        return list(chunk.raw)

    if chunk.kind == "dialogue":
        out: list[str] = [chunk.raw[0]] if chunk.raw else []
        say_index = 0
        for _idx, text, is_say in chunk.body_lines:
            if not is_say:
                out.append(text)
                continue
            say = chunk.say_lines[say_index] if say_index < len(chunk.say_lines) else None
            if say is not None and say.original_what is not None:
                out.append(say.render(say.original_what))
            else:
                out.append(text)
            say_index += 1
        return out

    remove = {pair.new_idx for pair in chunk.pairs if pair.new_idx >= 0}
    return [line for i, line in enumerate(chunk.raw) if i not in remove]


def restore_tl_file(path: Path, lang: str) -> int:
    """把单个 tl 文件还原为模板态并写回；返回发生变化的块数。"""

    chunks = parse_tl_file(path, lang)
    restored = [restore_chunk(c) for c in chunks]
    changed = 0
    for chunk, lines in zip(chunks, restored):
        if lines != chunk.raw:
            changed += 1
    if changed == 0:
        return 0
    text = path.read_text(encoding="utf-8", errors="replace")
    trailing = "\n" if text.endswith("\n") else ""
    body = "\n".join(line for lines in restored for line in lines)
    path.write_text(body + trailing, encoding="utf-8")
    rpyc = path.with_suffix(".rpyc")
    if rpyc.exists():
        rpyc.unlink()
    return changed
