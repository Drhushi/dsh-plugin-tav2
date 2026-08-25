"""有限 .rpy 解析器：复刻 Ren'Py `Restructurer` 的翻译单元与标识符生成算法。

标识符算法与 renpy/translation/__init__.py 的 Restructurer 一致：
md5(每个语句 get_code() + "\\r\\n") 前 8 位，前缀为 label（点号转下划线）。
移植自 TranslateAgent v1 的 translate_agent/fallback_parser.py（保留算法与注释）。
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from tav2.adapters.renpy.renpy_compat import STRING_RE, decode_string
from tav2.adapters.renpy.renpy_models import DialogueUnit, SayLine


class ParseError(Exception):
    """游戏脚本无法被有限解析器处理。"""


RECURSE_KEYWORDS = {"label", "menu", "if", "elif", "else", "init"}
BLOCK_SKIP_KEYWORDS = {
    "python",
    "while",
    "for",
    "screen",
    "transform",
    "image",
    "style",
    "layeredimage",
    "default",
    "define",
}
TRANSLATABLE_RAW = {"voice", "voice sustain", "nvl clear"}
PLAIN_KEYWORDS = {
    "show",
    "show layer",
    "camera",
    "hide",
    "scene",
    "with",
    "play",
    "stop",
    "queue",
    "window",
    "call",
    "jump",
    "return",
    "pass",
}


def _strip_comment(line: str, in_triple: str | None) -> tuple[str, str | None]:
    """去掉行内 # 注释（字符串外），维护跨行三引号状态。"""

    out: list[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if in_triple:
            out.append(c)
            if c == in_triple and line[i : i + 3] == in_triple * 3:
                if not (i > 0 and line[i - 1] == "\\"):
                    out.append(line[i + 1])
                    out.append(line[i + 2])
                    i += 3
                    in_triple = None
                    continue
            i += 1
            continue
        if c == "#":
            break
        if c in "\"'`":
            if line[i : i + 3] == c * 3 and not (i > 0 and line[i - 1] == "\\"):
                out.append(line[i : i + 3])
                in_triple = c
                i += 3
                continue
            out.append(c)
            i += 1
            while i < len(line):
                out.append(line[i])
                if line[i] == "\\" and i + 1 < len(line):
                    out.append(line[i + 1])
                    i += 2
                    continue
                if line[i] == c:
                    i += 1
                    break
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out), in_triple


def _bracket_balance(text: str) -> int:
    """统计字符串字面量之外的括号余额。"""

    balance = 0
    i = 0
    while i < len(text):
        c = text[i]
        if c in "\"'`":
            m = STRING_RE.match(text, i)
            if m:
                i = m.end()
                continue
        if c in "([{":
            balance += 1
        elif c in ")]}":
            balance -= 1
        i += 1
    return balance


def _in_triple(text: str) -> str | None:
    """判断文本是否处于未闭合的三引号字符串中。"""

    i = 0
    while i < len(text):
        c = text[i]
        if c in "\"'`" and text[i : i + 3] == c * 3:
            if not (i > 0 and text[i - 1] == "\\"):
                return c
        i += 1
    return None


def _read_statements(path: Path) -> list[tuple[int, str, int]]:
    """把 .rpy 文件读成 (缩进, 语句文本, 行号) 列表。"""

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw_lines = f.read().split("\n")

    statements: list[tuple[int, str, int]] = []
    current: tuple[int, list[str], int] | None = None
    triple_state: str | None = None

    def flush() -> None:
        nonlocal current
        if current is not None:
            indent, parts, line = current
            text = " ".join(part.strip() for part in parts).strip()
            if text:
                statements.append((indent, text, line))
            current = None

    for idx, raw in enumerate(raw_lines):
        raw = raw.replace("\ufeff", "")
        stripped_line, triple_state = _strip_comment(raw, triple_state)
        if current is None:
            if not stripped_line.strip():
                continue
            indent = len(stripped_line) - len(stripped_line.lstrip(" \t"))
            current = (indent, [stripped_line.strip()], idx + 1)
        else:
            _indent, parts, _line = current
            parts.append(stripped_line.strip())

        text = " ".join(part for part in current[1]).strip()
        if triple_state is None and _bracket_balance(text) <= 0:
            flush()

    flush()
    return statements


def _tokenize(text: str) -> list[tuple[str, str]]:
    """把语句拆成 (类型, 文本) 令牌：WORD / STR / PUNCT。"""

    tokens: list[tuple[str, str]] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c.isspace():
            i += 1
            continue
        m = STRING_RE.match(text, i)
        if m:
            tokens.append(("STR", m.group(0)))
            i = m.end()
            continue
        if c in "()@":
            tokens.append(("PUNCT", c))
            i += 1
            continue
        j = i
        while j < len(text) and not text[j].isspace() and text[j] not in "()@\"'`":
            j += 1
        tokens.append(("WORD", text[i:j]))
        i = j
    return tokens


def _parse_say(text: str, line: int) -> SayLine:
    """解析 say 语句为 SayLine（仅替换 what，结构与子句原样保留）。"""

    tokens = _tokenize(text)
    if not tokens:
        raise ParseError(f"第 {line} 行：空语句被当作 say 解析")

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
            if tokens[idx] == ("PUNCT", "@"):
                in_temp = True
            else:
                (temps if in_temp else attrs).append(tokens[idx][1])
            idx += 1

    if idx >= len(tokens) or tokens[idx][0] != "STR":
        raise ParseError(f"第 {line} 行：未找到 say 的字符串字面量")

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
        raw=text,
        indent="",
    )
    return say


def _classify(text: str) -> str:
    words = text.split()
    if not words:
        return "plain"
    first = words[0].rstrip(":")
    if words[0] == "$":
        return "python"
    two = " ".join(w.rstrip(":") for w in words[:2]) if len(words) >= 2 else first
    if two in TRANSLATABLE_RAW or first in TRANSLATABLE_RAW:
        return two if two in TRANSLATABLE_RAW else first
    if two in RECURSE_KEYWORDS or first in RECURSE_KEYWORDS:
        return two if two in RECURSE_KEYWORDS else first
    if two in BLOCK_SKIP_KEYWORDS or first in BLOCK_SKIP_KEYWORDS:
        return two if two in BLOCK_SKIP_KEYWORDS else first
    if first in PLAIN_KEYWORDS:
        return first
    return "say"


def _is_choice(text: str) -> bool:
    """判断是否为菜单选项行（字符串字面量开头且以冒号结束）。"""

    stripped = text.rstrip()
    if not stripped.endswith(":"):
        return False
    m = STRING_RE.match(stripped)
    return m is not None


class RestructurerReplica:
    """复刻 Restructurer：跨文件维护已用标识符，逐文件生成翻译单元。"""

    def __init__(self) -> None:
        self.default_ids: set[str] = set()
        self.units: list[DialogueUnit] = []
        self.warnings: list[str] = []
        self.skipped: list[dict[str, object]] = []
        self.menu_choices: list[tuple[str, int, str]] = []

    def parse_game(self, game_dir: str | Path) -> list[DialogueUnit]:
        self.game_dir = Path(game_dir)
        for path in self._list_rpy_files(self.game_dir):
            self._parse_file(path)
        return self.units

    def _list_rpy_files(self, game_dir: Path) -> list[Path]:
        files: list[Path] = []
        for root, _dirs, names in os.walk(game_dir):
            root_path = Path(root)
            rel = root_path.relative_to(game_dir)
            if "tl" in rel.parts:
                continue
            for name in names:
                if name.endswith(".rpy") or name.endswith(".rpym"):
                    files.append(root_path / name)
        files.sort(key=lambda p: (p.relative_to(game_dir).with_suffix("").as_posix(), ""))
        return files

    def _parse_file(self, path: Path) -> None:
        stmts = _read_statements(path)
        self._file_rel = path.relative_to(self.game_dir).as_posix()
        self.preexisting = self._collect_explicit_ids(stmts)
        self.used_ids: set[str] = set()
        self.label: str | None = None
        self.alternate: str | None = None
        self._walk(stmts)

    def _collect_explicit_ids(self, stmts: list[tuple[int, str, int]]) -> set[str]:
        ids: set[str] = set()

        def visit(level: list[tuple[int, str, int]]) -> None:
            i = 0
            while i < len(level):
                _indent, text, line = level[i]
                kind = _classify(text)
                if kind == "say":
                    try:
                        say = _parse_say(text, line)
                    except ParseError:
                        pass
                    else:
                        if say.explicit_id:
                            ids.add(say.explicit_id)
                block = self._children(level, i)
                if block and kind in RECURSE_KEYWORDS:
                    visit(block)
                i = self._after_block(level, i)

        visit(stmts)
        return ids

    @staticmethod
    def _children(stmts: list[tuple[int, str, int]], i: int) -> list[tuple[int, str, int]]:
        base = stmts[i][0]
        j = i + 1
        while j < len(stmts) and stmts[j][0] > base:
            j += 1
        return stmts[i + 1 : j]

    @staticmethod
    def _after_block(stmts: list[tuple[int, str, int]], i: int) -> int:
        base = stmts[i][0]
        j = i + 1
        while j < len(stmts) and stmts[j][0] > base:
            j += 1
        return j

    def _walk(self, stmts: list[tuple[int, str, int]]) -> None:
        group: list[tuple[str, object, int]] = []
        i = 0
        while i < len(stmts):
            _indent, text, line = stmts[i]
            kind = _classify(text)

            if kind in ("if", "elif", "else"):
                block = self._children(stmts, i)
                self._walk(block)
                i = self._after_block(stmts, i)
                continue

            if kind == "label":
                name, hide = self._parse_label(text)
                if not hide:
                    if name.startswith("_"):
                        self.alternate = name
                    else:
                        self.label = name
                        self.alternate = None
                block = self._children(stmts, i)
                self._walk(block)
                i = self._after_block(stmts, i)
                continue

            if kind == "menu":
                self._handle_menu(stmts, i, group)
                i = self._after_block(stmts, i)
                continue

            if kind == "init":
                words = text.split()[:2]
                is_init_python = (
                    len(words) >= 2 and words[0] == "init" and words[1].rstrip(":") == "python"
                )
                if not is_init_python:
                    block = self._children(stmts, i)
                    self._walk(block)
                i = self._after_block(stmts, i)
                continue

            if kind in BLOCK_SKIP_KEYWORDS:
                self.skipped.append(
                    {
                        "file": self._file_rel,
                        "line": line,
                        "kind": "block_skip",
                        "statement": text[:120],
                    }
                )
                i = self._after_block(stmts, i)
                continue

            if kind in TRANSLATABLE_RAW:
                group.append(("raw", text, line))
                i += 1
                continue

            if kind == "say":
                try:
                    say = _parse_say(text, line)
                except ParseError as exc:
                    if group:
                        self.units.append(self._create_unit(group))
                        group = []
                    self.warnings.append(f"{self._file_rel}:{line} 按普通语句处理：{exc}")
                    self.skipped.append(
                        {
                            "file": self._file_rel,
                            "line": line,
                            "kind": "parse_fail",
                            "statement": text[:120],
                        }
                    )
                    i += 1
                    continue
                group.append(("say", say, line))
                self.units.append(self._create_unit(group))
                group = []
                i += 1
                continue

            if group:
                self.units.append(self._create_unit(group))
                group = []
            i += 1

        if group:
            self.units.append(self._create_unit(group))

    def _handle_menu(
        self,
        stmts: list[tuple[int, str, int]],
        i: int,
        group: list[tuple[str, object, int]],
    ) -> None:
        text = stmts[i][1]
        name = self._parse_menu_name(text)
        if name:
            if name.startswith("_"):
                self.alternate = name
            else:
                self.label = name
                self.alternate = None

        body = self._children(stmts, i)
        # 菜单体是拍平的：选项前可能有一段旁白 say；选项正文由 choice_block 递归处理，
        # 不能把选项内的 say 误当旁白重复生成单元（会产生运行时没有的伪块）。
        first_choice = next(
            (idx for idx, item in enumerate(body) if _is_choice(item[1])), None
        )
        head = body if first_choice is None else body[:first_choice]
        choices = [] if first_choice is None else body[first_choice:]

        say_seen = False
        for _indent, btext, bline in head:
            kind = _classify(btext)
            if kind == "say" and not say_seen:
                try:
                    say = _parse_say(btext, bline)
                except ParseError:
                    continue
                if say.who is None:
                    continue
                if "nointeract" not in say.suffix:
                    say.suffix = (say.suffix + " nointeract").strip()
                say.raw = say.render()
                group.append(("say", say, bline))
                self.units.append(self._create_unit(group))
                group.clear()
                say_seen = True

        for idx, item in enumerate(choices):
            _indent, btext, bline = item
            if _is_choice(btext):
                m = STRING_RE.match(btext)
                if m:
                    try:
                        choice_text = decode_string(m.group(0))
                    except Exception:
                        choice_text = ""
                    if choice_text:
                        self.menu_choices.append((self._file_rel, bline, choice_text))
                choice_block = self._children(choices, idx)
                self._walk(choice_block)

        if group:
            self.units.append(self._create_unit(group))
            group.clear()

    @staticmethod
    def _parse_label(text: str) -> tuple[str, bool]:
        rest = text[len("label") :].strip()
        name = re.split(r"\s|\(|:", rest, maxsplit=1)[0]
        hide = "hide" in rest.split(":")[0].split("(")[0].split()
        return name, hide

    @staticmethod
    def _parse_menu_name(text: str) -> str | None:
        rest = text[len("menu") :].strip()
        if not rest:
            return None
        first = rest.split(None, 1)[0]
        if first.endswith(":"):
            return None
        return first.split("(")[0].rstrip(":")

    def _unique_identifier(self, label: str | None, digest: str) -> str:
        base = digest if label is None else label.replace(".", "_") + "_" + digest
        i = 0
        while True:
            suffix = "" if i == 0 else f"_{i}"
            candidate = base + suffix
            if (
                candidate not in self.used_ids
                and candidate not in self.default_ids
                and candidate not in self.preexisting
            ):
                return candidate
            i += 1

    def _create_unit(self, group: list[tuple[str, object, int]]) -> DialogueUnit:
        md5 = hashlib.md5()
        for kind, item, _line in group:
            code = item if kind == "raw" else item.raw  # type: ignore[union-attr]
            md5.update((code + "\r\n").encode("utf-8"))
        digest = md5.hexdigest()[:8]

        id_identifier: str | None = None
        for kind, item, _line in group:
            if kind == "say":
                explicit = item.explicit_id  # type: ignore[union-attr]
                if explicit:
                    id_identifier = explicit

        md5_identifier = self._unique_identifier(self.label, digest)
        if self.alternate is not None:
            alternate = self._unique_identifier(self.alternate, digest)
            identifier = id_identifier or md5_identifier
        elif id_identifier is not None:
            alternate = md5_identifier
            identifier = id_identifier
        else:
            alternate = None
            identifier = md5_identifier

        self.used_ids.add(identifier)
        if alternate is not None:
            self.used_ids.add(alternate)
        self.default_ids.add(identifier)

        say_lines = [item for kind, item, _l in group if kind == "say"]
        raw_statements = [item for kind, item, _l in group if kind == "raw"]
        first_line = group[0][2]
        return DialogueUnit(
            identifier=identifier,
            filename=self._file_rel,
            linenumber=first_line,
            label=self.label,
            say_lines=say_lines,
            raw_statements=raw_statements,
        )


def parse_dialogue_units(game_dir: str | Path) -> list[DialogueUnit]:
    """解析 game/ 下的脚本，返回全部对话翻译单元（模板兜底用）。"""

    replica = RestructurerReplica()
    return replica.parse_game(game_dir)
