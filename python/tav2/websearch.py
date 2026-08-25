"""联网查证（可选）：DeepSeek 原生 web_search / Tavily / DuckDuckGo；未配置时返回空证据。

查证结果只作证据，最终决策权在用户。deepseek 失败时自动降级：
deepseek → tavily → duckduckgo（缓存中记录实际命中引擎）。
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any
from urllib.parse import unquote, urlparse

import requests

from tav2.config import api_key


_ENGINE_CHAIN = {
    "deepseek": ("deepseek", "tavily", "duckduckgo"),
    "auto": ("tavily", "duckduckgo"),
    "tavily": ("tavily",),
    "duckduckgo": ("duckduckgo",),
}


def _page_title(url: str) -> str:
    """从 URL 提取干净标题（去掉 #ws_call_id 片段与 .md/.html 后缀）。"""

    try:
        path = unquote(urlparse(url).path)
    except Exception:
        path = url
    segments = [s for s in path.split("/") if s]
    title = segments[-1] if segments else url
    lower = title.lower()
    for suffix in (".md", ".html", ".htm"):
        if lower.endswith(suffix):
            title = title[: -len(suffix)]
            break
    title = title.replace("_", " ").replace("-", " ").strip()
    return title[:80] or url[:80]


def _query_hash(query: str) -> str:
    return hashlib.md5(query.encode("utf-8")).hexdigest()


def _deepseek(query: str, cfg: dict[str, Any]) -> list[dict[str, str]]:
    """DeepSeek Responses API 原生 web_search（tools:[{type:web_search}]）。

    结果来源兼容三种格式：
    1. message 内容块的 annotations（url_citation，OpenAI 标准）；
    2. web_search_call.action 的 open_page URL；
    3. 直接输出项 type=web_search（部分实现）。
    搜索动作（action.type=search）只作为已执行查证的记录，不冒充结果。
    """

    llm = cfg.get("llm") or {}
    base_url = str(llm.get("base_url") or "https://api.deepseek.com/v1").rstrip("/")
    key = api_key(cfg)
    if not key:
        return []
    max_results = int(cfg.get("search", {}).get("max_results", 5))
    resp = requests.post(
        f"{base_url}/responses",
        json={
            "model": str(llm.get("model") or "deepseek-chat"),
            "tools": [{"type": "web_search", "max_results": max_results}],
            "input": query,
        },
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        timeout=int(cfg.get("search", {}).get("timeout", 15)),
    )
    if resp.status_code != 200:
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in resp.json().get("output") or []:
        itype = item.get("type")
        if itype == "web_search":
            url = str(item.get("url") or "")
            if url and url not in seen:
                seen.add(url)
                out.append(
                    {
                        "title": str(item.get("title") or url[:80]),
                        "url": url,
                        "snippet": str(item.get("content") or item.get("snippet") or ""),
                    }
                )
            continue
        if itype == "web_search_call":
            action = item.get("action") or {}
            if action.get("type") == "open_page":
                url = str(action.get("url") or "")
                if url and url not in seen:
                    seen.add(url)
                    out.append({"title": _page_title(url), "url": url, "snippet": ""})
            continue
        if itype == "message":
            content = item.get("content") or []
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                anns = block.get("annotations") or []
                if not isinstance(anns, list):
                    continue
                for ann in anns:
                    if not isinstance(ann, dict):
                        continue
                    url = str(ann.get("url") or "")
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    out.append(
                        {
                            "title": str(ann.get("title") or url[:80]),
                            "url": url,
                            "snippet": str(ann.get("content") or ann.get("snippet") or ""),
                        }
                    )
    return out[: int(cfg.get("search", {}).get("max_results", 5))]


def _tavily(query: str, cfg: dict[str, Any]) -> list[dict[str, str]]:
    key = os.environ.get(str(cfg.get("search", {}).get("api_key_env") or "TAVILY_API_KEY") or "")
    if not key:
        return []
    resp = requests.post(
        "https://api.tavily.com/search",
        json={
            "api_key": key,
            "query": query,
            "max_results": int(cfg.get("search", {}).get("max_results", 5)),
        },
        timeout=int(cfg.get("search", {}).get("timeout", 15)),
    )
    if resp.status_code != 200:
        return []
    out: list[dict[str, str]] = []
    for item in (resp.json().get("results") or []):
        out.append(
            {
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
                "snippet": str(item.get("content") or ""),
            }
        )
    return out


def _duckduckgo(query: str, cfg: dict[str, Any]) -> list[dict[str, str]]:
    try:
        resp = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": "Mozilla/5.0 tav2"},
            timeout=int(cfg.get("search", {}).get("timeout", 15)),
        )
    except requests.RequestException:
        return []
    if resp.status_code != 200:
        return []
    out: list[dict[str, str]] = []
    for m in re.finditer(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', resp.text
    ):
        title = re.sub(r"<[^>]+>", "", m.group(2))
        out.append({"title": title, "url": m.group(1), "snippet": ""})
        if len(out) >= int(cfg.get("search", {}).get("max_results", 5)):
            break
    return out


def search(cfg: dict[str, Any], db: Any, query: str) -> list[dict[str, str]]:
    """执行一次查证（带幂等缓存）；失败自动沿引擎链降级。engine=off 时返回 []。"""

    search_cfg = cfg.get("search") or {}
    engine = str(search_cfg.get("engine") or "off").lower()
    if not search_cfg.get("enabled", False) or engine == "off":
        return []
    chain = _ENGINE_CHAIN.get(engine, ())
    if not chain:
        return []
    qh = _query_hash(query)
    if db is not None:
        cached = db.search_cache_get(qh)
        if cached is not None:
            return cached
    impls = {
        "deepseek": _deepseek,
        "tavily": _tavily,
        "duckduckgo": _duckduckgo,
    }
    results: list[dict[str, str]] = []
    used = "off"
    for name in chain:
        try:
            results = impls[name](query, cfg)
        except Exception:
            results = []
        if results:
            used = name
            break
    if db is not None:
        db.search_cache_put(qh, used, query, results)
    return results
