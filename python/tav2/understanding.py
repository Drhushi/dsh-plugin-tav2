"""双阶段协议第一步：场景理解（结构化记录写入 DB）。"""

from __future__ import annotations

from typing import Any

from tav2.llm import BaseLLM, LLMError
from tav2.memory import MemoryPack
from tav2.models import Scene, ThreadItem, UnderstandingRecord
from tav2.prompts import UNDERSTANDING_PROMPT, render


def generate_understanding(
    llm: BaseLLM,
    cfg: dict[str, Any],
    scene: Scene,
    memory: MemoryPack,
) -> UnderstandingRecord | None:
    """为场景生成结构化理解记录；解析失败返回 None（不阻塞翻译）。"""

    source_text = "\n".join(u.source for u in scene.units if u.source)
    if not source_text:
        return None
    reasoning = str(cfg.get("context", {}).get("understanding_reasoning_effort") or "")
    prompt = render(UNDERSTANDING_PROMPT.template)
    user = _user_message(scene, source_text, memory)
    try:
        data = llm.chat_json(prompt, user, reasoning_effort=reasoning or None)
    except (LLMError, ValueError, TypeError):
        return None
    record = UnderstandingRecord.from_dict(
        {
            "scene_id": scene.scene_id,
            "scene_state": data.get("scene_state") or {},
            "threads": data.get("threads") or [],
            "term_usage": data.get("term_usage") or [],
            "style_notes": data.get("style_notes") or [],
            "flags": data.get("flags") or [],
        }
    )
    record.raw = data
    return record


def _user_message(scene: Scene, source_text: str, memory: MemoryPack) -> str:
    parts = [
        f"场景：{scene.title}",
        f"分支：{scene.branch}",
    ]
    if memory.summary:
        parts.append(f"剧情摘要（前文）：\n{memory.summary}")
    if memory.main_summary:
        parts.append(f"主线摘要（分支前文）：\n{memory.main_summary}")
    if memory.constants:
        parts.append("常驻背景：\n" + "\n".join(f"【{e.get('title')}】{e.get('content')}" for e in memory.constants))
    if memory.lore_hits:
        parts.append("命中背景：\n" + "\n".join(f"【{e.get('title')}】{e.get('content')}" for e in memory.lore_hits))
    if memory.glossary:
        parts.append("锁定术语：\n" + "\n".join(f"{s} → {t}" for s, t, _c in memory.glossary))
    parts.append("场景原文：\n" + source_text)
    return "\n\n".join(parts)
