"""LLM 客户端：OpenAI 兼容 HTTP 客户端 + 可注入的 FakeLLM（测试/冒烟）。"""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable

import requests

from tav2.config import api_key


class LLMError(Exception):
    pass


_RETRY_LOCK = threading.Lock()

_AUX_PATTERNS = (
    re.compile(r"<thinking>[\s\S]*?</thinking>", re.IGNORECASE),
    re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE),
    re.compile(r"<!--[\s\S]*?-->"),
)


def strip_aux(content: str) -> str:
    text = content or ""
    for pattern in _AUX_PATTERNS:
        text = pattern.sub("", text)
    return text.strip()


def extract_json(content: str) -> dict[str, Any]:
    """从 LLM 响应中提取 JSON 对象（容错 markdown 围栏与前后缀）。"""

    text = strip_aux(content)
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise LLMError(f"响应中未找到 JSON 对象：{content[:200]!r}")
    return json.loads(text[start : end + 1])


def extract_json_array(content: str) -> list[dict[str, Any]]:
    text = strip_aux(content)
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        raise LLMError(f"响应中未找到 JSON 数组：{content[:200]!r}")
    return json.loads(text[start : end + 1])


def _is_retryable(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status == 429 or status >= 500
    name = type(exc).__name__.lower()
    return any(k in name for k in ("timeout", "connection", "ratelimit"))


class BaseLLM:
    """LLM 抽象基类：记录用量与耗时。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.usage: dict[str, int] = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
        self.elapsed_seconds: float = 0.0

    def chat(self, system: str, user: str, **kwargs: Any) -> str:
        raise NotImplementedError

    def chat_json(self, system: str, user: str, **kwargs: Any) -> dict[str, Any]:
        return extract_json(self.chat(system, user, **kwargs))

    def chat_json_array(self, system: str, user: str, **kwargs: Any) -> list[dict[str, Any]]:
        return extract_json_array(self.chat(system, user, **kwargs))

    def _record(self, prompt_tokens: int, completion_tokens: int) -> None:
        with self._lock:
            self.usage["calls"] += 1
            self.usage["prompt_tokens"] += int(prompt_tokens or 0)
            self.usage["completion_tokens"] += int(completion_tokens or 0)

    def _add_elapsed(self, seconds: float) -> None:
        with self._lock:
            self.elapsed_seconds += seconds

    def usage_snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self.usage)


class HttpLLM(BaseLLM):
    """OpenAI 兼容 chat/completions 客户端。"""

    def __init__(self, cfg: dict[str, Any]) -> None:
        super().__init__()
        llm = cfg["llm"]
        key = api_key(cfg)
        if not key:
            raise LLMError(
                f"未设置 API Key 环境变量 {llm.get('api_key_env', 'TRANSLATE_AGENT_API_KEY')}"
            )
        self.base_url = str(llm["base_url"]).rstrip("/")
        self.api_key = key
        self.model = str(llm["model"])
        self.temperature = float(llm.get("temperature", 0.3))
        self.max_tokens = int(llm.get("max_tokens", 4096))
        self.timeout = int(llm.get("timeout", 180))
        self.reasoning_effort = str(llm.get("reasoning_effort") or "").strip()
        self._session = requests.Session()

    def chat(self, system: str, user: str, **kwargs: Any) -> str:
        max_tokens = kwargs.get("max_tokens") or self.max_tokens
        reasoning_effort = kwargs.get("reasoning_effort")
        if reasoning_effort is None:
            reasoning_effort = self.reasoning_effort
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.temperature,
            "max_tokens": max_tokens,
        }
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort
        started = time.monotonic()
        try:
            last_error: Exception | None = None
            for attempt in range(4):
                try:
                    resp = self._session.post(
                        f"{self.base_url}/chat/completions",
                        json=payload,
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        timeout=self.timeout,
                    )
                    if resp.status_code != 200:
                        exc = LLMError(
                            f"HTTP {resp.status_code}: {resp.text[:300]}"
                        )
                        exc.status_code = resp.status_code  # type: ignore[attr-defined]
                        raise exc
                    data = resp.json()
                    self._record(
                        int((data.get("usage") or {}).get("prompt_tokens") or 0),
                        int((data.get("usage") or {}).get("completion_tokens") or 0),
                    )
                    return str(data["choices"][0]["message"]["content"] or "")
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    if not _is_retryable(exc):
                        raise
                    with _RETRY_LOCK:
                        time.sleep(min(2**attempt, 8))
            raise LLMError(f"LLM 调用失败：{last_error}")
        finally:
            self._add_elapsed(time.monotonic() - started)


class FakeLLM(BaseLLM):
    """可编程假 LLM：按调用顺序返回预设响应，或由 hook 生成。"""

    def __init__(self, responses: list[str] | None = None, hook: Callable[[str, str], str] | None = None):
        super().__init__()
        self.responses = list(responses or [])
        self.hook = hook
        self.calls: list[tuple[str, str]] = []

    def chat(self, system: str, user: str, **kwargs: Any) -> str:
        self.calls.append((system, user))
        self._record(0, 0)
        if self.hook is not None:
            return self.hook(system, user)
        if not self.responses:
            return "{}"
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


def create_llm(cfg: dict[str, Any]) -> BaseLLM:
    """按配置创建 LLM 客户端。"""

    if cfg.get("llm", {}).get("mock"):
        return FakeLLM()
    return HttpLLM(cfg)


def embed_texts(cfg: dict[str, Any], texts: list[str]) -> list[list[float]] | None:
    """可选向量兜底：调用 OpenAI 兼容 /embeddings。未配置时返回 None。"""

    model = str(cfg.get("memory", {}).get("embedding_model") or "").strip()
    if not model or not cfg.get("memory", {}).get("vector_enabled"):
        return None
    key = api_key(cfg)
    if not key:
        return None
    base_url = str(cfg["llm"]["base_url"]).rstrip("/")
    resp = requests.post(
        f"{base_url}/embeddings",
        json={"model": model, "input": texts},
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        timeout=int(cfg["llm"].get("timeout", 180)),
    )
    if resp.status_code != 200:
        return None
    data = resp.json()
    return [item["embedding"] for item in data.get("data") or []]
