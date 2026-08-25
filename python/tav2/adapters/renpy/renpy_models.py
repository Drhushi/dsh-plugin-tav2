"""Ren'Py 侧数据模型（移植自 v1 translate_agent/models.py）。"""

from __future__ import annotations

from dataclasses import dataclass, field

from tav2.adapters.renpy.renpy_compat import encode_say_string


@dataclass
class SayLine:
    """对话块中的一条 say 语句。prefix/suffix 保留语句结构，翻译只替换 what。"""

    who: str | None
    what: str
    prefix: str
    suffix: str
    raw: str
    explicit_id: str | None = None
    original_what: str | None = None
    indent: str = ""

    def render(self, what: str | None = None) -> str:
        text = encode_say_string(self.what if what is None else what)
        parts = [self.prefix, text] if self.prefix else [text]
        if self.suffix:
            parts.append(self.suffix)
        return self.indent + " ".join(parts)


@dataclass
class DialogueUnit:
    """一个对话翻译单元（对应 tl 文件中的一个 translate 块）。"""

    identifier: str
    filename: str
    linenumber: int
    label: str | None
    say_lines: list[SayLine] = field(default_factory=list)
    raw_statements: list[str] = field(default_factory=list)
    say_machine: dict[int, str] = field(default_factory=dict)

    @property
    def source_text(self) -> str:
        return "\n".join(s.what for s in self.say_lines if s.what)

    @property
    def translated_text(self) -> str:
        lines = [s.what for s in self.say_lines if s.what]
        if not lines:
            return ""
        translated = [
            self.say_machine.get(i, s.what)
            for i, s in enumerate(self.say_lines)
            if s.what
        ]
        return "\n".join(translated)

    @property
    def is_translated(self) -> bool:
        lines = [s for s in self.say_lines if s.what.strip()]
        if not lines:
            return True
        return all(
            s.what.strip() and s.original_what is not None and s.what != s.original_what
            for s in lines
        )


@dataclass
class StringUnit:
    """一个字符串翻译条目（translate strings 块中的 old/new 对）。"""

    old: str
    new: str
    filename: str
    linenumber: int
    machine: str = ""
    human: str = ""
    status: str = "待审"

    @property
    def source_text(self) -> str:
        return self.old

    @property
    def translated_text(self) -> str:
        return self.human if self.human else self.machine

    @property
    def is_translated(self) -> bool:
        return bool(self.new) and self.new != self.old
