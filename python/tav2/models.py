"""引擎无关的数据模型：Document → Scene → Unit，以及场景理解记录。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


UNIT_KINDS = ("dialogue", "narration", "choice", "string")


@dataclass
class Unit:
    """原子可译项。"""

    unit_id: str  # 引擎稳定 id（Ren'Py=官方 md5 标识符；小说=章:段 hash）
    kind: str  # dialogue | narration | choice | string
    source: str  # 原文（不含标签的净化视图由 adapter 另行提供）
    markup: str = ""  # Ren'Py 标签/插值或 markdown 格式符（保留字符串）
    speaker: str = ""  # 规范化角色 id（空=旁白/无）
    scene_id: str = ""
    prev_ids: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)  # 适配器私有元数据

    @property
    def key(self) -> str:
        return self.unit_id


@dataclass
class Scene:
    """语义块（Ren'Py label + 连续行；小说=章/节），按阅读顺序排列。"""

    scene_id: str
    title: str
    order: int
    units: list[Unit] = field(default_factory=list)
    branch: str = "main"  # 分支轨道 id（主线=main）
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Document:
    """一份归一化后的源文档。"""

    engine: str
    game_dir: str
    lang: str
    scenes: list[Scene] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def all_units(self) -> list[Unit]:
        return [u for scene in self.scenes for u in scene.units]


@dataclass
class ThreadItem:
    id: str
    kind: str  # short | long
    text: str
    scenes_since: int = 0


@dataclass
class UnderstandingRecord:
    """每场景结构化理解记录（双阶段协议的第一步产物）。"""

    scene_id: str
    scene_state: dict[str, Any]  # 时间/地点/在场角色/事件
    threads: list[ThreadItem] = field(default_factory=list)
    term_usage: list[dict[str, str]] = field(default_factory=list)  # {source, target}
    style_notes: list[dict[str, str]] = field(default_factory=list)  # {speaker, note}
    flags: list[dict[str, str]] = field(default_factory=list)  # {kind, source, hint}
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scene_id": self.scene_id,
            "scene_state": self.scene_state,
            "threads": [
                {"id": t.id, "kind": t.kind, "text": t.text, "scenes_since": t.scenes_since}
                for t in self.threads
            ],
            "term_usage": self.term_usage,
            "style_notes": self.style_notes,
            "flags": self.flags,
            "raw": self.raw,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnderstandingRecord":
        threads = [
            ThreadItem(
                id=str(t.get("id", "")),
                kind=str(t.get("kind", "short")),
                text=str(t.get("text", "")),
                scenes_since=int(t.get("scenes_since", 0)),
            )
            for t in data.get("threads") or []
        ]
        return cls(
            scene_id=str(data.get("scene_id", "")),
            scene_state=dict(data.get("scene_state") or {}),
            threads=threads,
            term_usage=list(data.get("term_usage") or []),
            style_notes=list(data.get("style_notes") or []),
            flags=list(data.get("flags") or []),
            raw=dict(data.get("raw") or {}),
        )
