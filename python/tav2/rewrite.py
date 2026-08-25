"""双阶段协议第二步：据理解记录与记忆逐条重写，含完整性/标签硬校验与补译。"""

from __future__ import annotations

from typing import Any

from tav2.gates import tags_preserved
from tav2.llm import BaseLLM, LLMError, extract_json
from tav2.memory import MemoryPack
from tav2.models import Scene, UnderstandingRecord
from tav2.prompts import REWRITE_PROMPT, render
from tav2.adapters.renpy.renpy_compat import ensure_translation_tag


MAX_RETRY_ROUNDS = 3


def rewrite_scene(
    llm: BaseLLM,
    cfg: dict[str, Any],
    scene: Scene,
    memory: MemoryPack,
    understanding: UnderstandingRecord | None,
    units: list[Any] | None = None,
) -> dict[str, str]:
    """重写场景（或指定子批）单元，返回 {unit_id: 译文}（已通过标签与完整性校验）。

    units 缺省时重写整场景；传入子批列表时只处理该子批，保持场景级记忆上下文。
    """

    pending = [u for u in (units if units is not None else scene.units) if u.source]
    result: dict[str, str] = {}
    for round_index in range(MAX_RETRY_ROUNDS + 1):
        missing = [u for u in pending if u.unit_id not in result]
        if not missing:
            break
        prompt = render(REWRITE_PROMPT.template, target=_target_name(cfg))
        user = _user_message(scene, missing, memory, understanding, round_index, cfg)
        try:
            data = extract_json(llm.chat(prompt, user))
        except (LLMError, ValueError, TypeError):
            # 输出截断/解析失败不放弃：下一轮只重发缺失项
            continue
        sources = {u.unit_id: u.source for u in missing}
        for key, value in data.items():
            key = str(key).strip()
            text = str(value).strip()
            if not text:
                continue
            if key not in sources:
                continue
            if not tags_preserved(sources[key], text):
                continue
            result[key] = ensure_translation_tag(sources[key], text)
        if round_index < MAX_RETRY_ROUNDS:
            pass  # 下一轮只重发缺失项
    return result


def _target_name(cfg: dict[str, Any]) -> str:
    return "简体中文"


def _user_message(
    scene: Scene,
    units: list[Any],
    memory: MemoryPack,
    understanding: UnderstandingRecord | None,
    round_index: int,
    cfg: dict[str, Any] | None = None,
) -> str:
    parts: list[str] = []
    if round_index == 0:
        parts.append(f"场景：{scene.title}")
        context_text = _scene_context_text(scene, units, cfg)
        if context_text:
            parts.append("【场景上下文】\n" + context_text)
        if memory.summary:
            parts.append(f"剧情摘要（前文）：\n{memory.summary}")
        if memory.main_summary:
            parts.append(f"主线摘要（分支前文）：\n{memory.main_summary}")
        if understanding is not None:
            parts.append("【理解记录】\n" + _understanding_text(understanding))
        if memory.constants:
            parts.append(
                "常驻背景：\n"
                + "\n".join(f"【{e.get('title')}】{e.get('content')}" for e in memory.constants)
            )
        if memory.lore_hits:
            parts.append(
                "命中背景：\n"
                + "\n".join(f"【{e.get('title')}】{e.get('content')}" for e in memory.lore_hits)
            )
        if memory.glossary:
            parts.append(
                "锁定术语：\n" + "\n".join(f"{s} → {t}" for s, t, _c in memory.glossary)
            )
        if memory.vector_hits:
            parts.append(
                "向量召回：\n"
                + "\n".join(
                    f"【{e.get('title') or e.get('kind')}】{e.get('content')}"
                    for e in memory.vector_hits
                )
            )
        if memory.few_shot:
            lines = ["已译句对示例："]
            for source, translated in memory.few_shot:
                lines.append(f"源: {source}")
                lines.append(f"译: {translated}")
            parts.append("\n".join(lines))
        parts.append("待译文本（整块理解后逐条重写，保持整体一致）：")
    else:
        parts.append("以下标识符上一轮缺失或未通过校验，请补齐：")
    for unit in units:
        label = f"[{unit.speaker}] " if unit.speaker else ""
        parts.append(f"{unit.unit_id}: {label}{unit.source}")
    return "\n\n".join(parts)


def _scene_context_text(
    scene: Scene, units: list[Any], cfg: dict[str, Any] | None
) -> str:
    """有反编译脚本/源 .rpy 时注入 label 标题与子批边界前后 2 行（只读语境）。

    novel 引擎或 tl-only（label 未解析为 noaddr）跳过，保持向后兼容。
    """

    if not cfg or str(cfg.get("engine") or "renpy") != "renpy":
        return ""
    label = scene.scene_id.split("::", 1)[1] if "::" in scene.scene_id else ""
    if not label or label == "noaddr":
        return ""
    ordered = [u for u in scene.units if u.source]

    def _neighbors(unit: Any) -> tuple[str, str]:
        idx = next(
            (i for i, x in enumerate(ordered) if x.unit_id == unit.unit_id), -1
        )
        prev = " | ".join(x.source for x in ordered[max(0, idx - 2) : idx])
        nxt = " | ".join(x.source for x in ordered[idx + 1 : idx + 3])
        return prev, nxt

    lines = [f"label={label}（仅作语境参考，不参与翻译）"]
    for unit in units[:2]:
        prev, _nxt = _neighbors(unit)
        if prev:
            lines.append(f"{unit.unit_id} 前文: {prev[:180]}")
    for unit in units[-2:]:
        _prev, nxt = _neighbors(unit)
        if nxt:
            lines.append(f"{unit.unit_id} 后文: {nxt[:180]}")
    return "\n".join(lines)


def _understanding_text(record: UnderstandingRecord) -> str:
    lines: list[str] = []
    state = record.scene_state
    if state:
        lines.append("场景状态：" + "；".join(f"{k}: {v}" for k, v in state.items()))
    for thread in record.threads:
        lines.append(f"伏笔[{thread.kind}] {thread.text}")
    for usage in record.term_usage:
        lines.append(f"术语：{usage.get('source')} → {usage.get('target')}")
    for note in record.style_notes:
        lines.append(f"风格[{note.get('speaker')}] {note.get('note')}")
    return "\n".join(lines) or "（无）"
