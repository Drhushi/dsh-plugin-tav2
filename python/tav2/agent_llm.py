"""主管循环的 LLM 适配：react 协议（纯文本 JSON）解析。

每轮只输出一个 JSON：{"action": "<工具名>", "args": {...}} 表示调用工具；
{"final": "<结论>"} 表示任务完成。tav2 现有 chat 接口即可支撑，无需函数调用协议。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from tav2.llm import BaseLLM, LLMError, extract_json


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class AgentTurn:
    is_final: bool
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)


def _render_history(messages: list[dict[str, Any]]) -> str:
    """把消息历史序列化为纯文本上下文。"""

    lines: list[str] = []
    for m in messages:
        role = str(m.get("role") or "")
        content = str(m.get("content") or "")
        if role == "user":
            lines.append(f"用户：{content}")
        elif role == "assistant":
            calls = m.get("tool_calls") or []
            for c in calls:
                args = c.get("arguments") or {}
                lines.append(
                    f"助手调用工具：{c.get('name')}({json.dumps(args, ensure_ascii=False)})"
                )
            if content:
                lines.append(f"助手：{content}")
        elif role == "tool":
            lines.append(f"工具返回（{m.get('tool_call_id') or '?'}）：{(content or '')[:2000]}")
    return "\n".join(lines) if lines else "（暂无历史）"


class AgentLLM:
    """把 LLM 的纯文本输出解析为主管循环的一轮动作或结论。"""

    def __init__(self, llm: BaseLLM) -> None:
        self._llm = llm

    def turn(
        self,
        system: str,
        history: list[dict[str, Any]],
        schemas: list[dict[str, Any]],
    ) -> AgentTurn:
        prompt = _render_history(history)
        raw = self._llm.chat(system, prompt)
        try:
            data = extract_json(raw)
        except LLMError:
            start = raw.find("{")
            end = raw.rfind("}")
            if start < 0 or end <= start:
                raise LLMError(f"主管模型输出缺少 JSON：{raw[:200]!r}") from None
            data = json.loads(raw[start : end + 1])
        if not isinstance(data, dict):
            raise LLMError(f"主管模型输出不是 JSON 对象：{raw[:200]!r}")
        if "final" in data:
            return AgentTurn(is_final=True, content=str(data.get("final") or ""))
        action = data.get("action")
        if not action:
            raise LLMError(f"主管模型输出缺少 action/final：{raw[:200]!r}")
        args = data.get("args")
        if not isinstance(args, dict):
            args = {}
        return AgentTurn(
            is_final=False,
            tool_calls=[
                ToolCall(
                    id=f"call_{uuid.uuid4().hex[:8]}",
                    name=str(action).strip(),
                    arguments=args,
                )
            ],
        )
