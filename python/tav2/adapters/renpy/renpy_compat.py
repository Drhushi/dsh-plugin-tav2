"""复刻 Ren'Py 的字符串解码/编码规则（renpy/lexer.py string() 与 translation.encode_say_string）。

移植自 TranslateAgent v1 的 translate_agent/renpy_compat.py。
"""

from __future__ import annotations

import re


STRING_RE = re.compile(
    r"""r?"([^\\"]|\\.)*"|r?'([^\\']|\\.)*'|r?`([^\\`]|\\.)*`"""
)
TEMP_TAG_RE = re.compile(r"\{\#[^{}\n]*\}")


def ensure_translation_tag(old: str, translation: str) -> str:
    """字符串翻译标签保真：old 含 {#tag} 而译文未携带时，把标签补到译文头部。"""

    if not translation:
        return translation
    tags = TEMP_TAG_RE.findall(old)
    if not tags or TEMP_TAG_RE.search(translation):
        return translation
    return "".join(tags) + translation


def decode_string(literal: str) -> str:
    """把 Ren'Py 字符串字面量解码为实际字符串（含转义与空白折叠）。"""

    raw = False
    if literal.startswith("r"):
        raw = True
        literal = literal[1:]

    body = literal[1:-1]
    if raw:
        return body

    body = re.sub(r"[ \n]+", " ", body)

    def dequote(m: re.Match) -> str:
        c = m.group(1)
        if c == "{":
            return "{{"
        if c == "[":
            return "[["
        if c == "%":
            return "%%"
        if c == "n":
            return "\n"
        if c[0] == "u":
            hex_digits = m.group(2)
            if hex_digits:
                return chr(int(hex_digits, 16))
        return c

    return re.sub(r"\\(u([0-9a-fA-F]{1,4})|.)", dequote, body)


def encode_say_string(s: str) -> str:
    """复刻 renpy.translation.encode_say_string。"""

    s = s.replace("\\", "\\\\")
    s = s.replace("\n", "\\n")
    s = s.replace('"', '\\"')
    s = re.sub(r"(?<= ) ", "\\ ", s)
    return '"' + s + '"'


def quote_unicode(s: str) -> str:
    """复刻 renpy.translation.quote_unicode（字符串块 old/new 的写盘转义）。"""

    s = s.replace("\\", "\\\\")
    s = s.replace('"', '\\"')
    s = s.replace("\a", "\\a")
    s = s.replace("\b", "\\b")
    s = s.replace("\f", "\\f")
    s = s.replace("\n", "\\n")
    s = s.replace("\r", "\\r")
    s = s.replace("\t", "\\t")
    s = s.replace("\v", "\\v")
    return s


_UNQUOTE_MAP = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    '"': '"',
}


def unquote_unicode(s: str) -> str:
    """quote_unicode 的逆操作（Python 字符串字面量语义）。"""

    def repl(m: re.Match) -> str:
        c = m.group(1)
        return _UNQUOTE_MAP.get(c, c)

    return re.sub(r"\\(.)", repl, s)


def find_string_literal(text: str) -> tuple[str, int, int] | None:
    """在语句文本中找第一个 Ren'Py 字符串字面量，返回 (literal, start, end)。"""

    for m in STRING_RE.finditer(text):
        return m.group(0), m.start(), m.end()
    return None
