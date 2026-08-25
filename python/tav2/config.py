"""配置加载与保存。"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml


PROJECT_ROOT = Path(__file__).resolve().parent.parent


DEFAULT_CONFIG: dict[str, Any] = {
    "engine": "renpy",  # renpy | novel
    "game_dir": "",  # 必填：含 game/ 子目录的游戏根目录（或小说文本根目录）
    "lang": "chinese",  # 目标语言目录名（Ren'Py 的 tl/<lang>）
    "renpy_sdk": "",  # 可选；留空自动探测（游戏自带运行时或 RENPY_SDK 环境变量）
    "renpy": {
        "unrpyc": "",  # 可选；unrpyc.py 路径（编译版 prepare 用），留空自动探测 v1 工具链
        "template_patch": True,  # prepare 时把官方模板缺失的对话/选项补入 tl
        "patch_missing_strings": False,  # 除菜单选项外，缺失的 _()/_p() 字符串是否也补入
    },
    "llm": {
        "base_url": "https://api.deepseek.com/v1",
        "api_key_env": "TRANSLATE_AGENT_API_KEY",
        "model": "deepseek-v4-flash",
        "temperature": 0.3,
        "max_tokens": 8192,
        "timeout": 180,
        "reasoning_effort": "",  # 可选：透传给支持思考的模型
        "price_per_1m_input": 0.0,  # 美元/百万输入 token；>0 时估算成本
        "price_per_1m_output": 0.0,
        "mock": False,  # True 时用内置 FakeLLM（测试/冒烟，不联网）
    },
    # 当前 API 供应商 profile 名（deepseek | opencode | 留空=完全自定义）。
    # 一旦 config.yaml 显式写入 llm_profile，加载时用对应 profile 覆写 llm 字段；
    # 旧配置（未写过该键）保持完全兼容，不覆写。
    "llm_profile": "deepseek",
    "llm_profiles": {
        "deepseek": {
            "base_url": "https://api.deepseek.com/v1",
            "api_key_env": "TRANSLATE_AGENT_API_KEY",
            "model": "deepseek-v4-flash",
            "temperature": 0.3,
            "max_tokens": 8192,
            "timeout": 180,
            "reasoning_effort": "",
            "price_per_1m_input": 0.0,
            "price_per_1m_output": 0.0,
        },
        "opencode": {
            "base_url": "https://opencode.ai/zen/go/v1",  # OpenCode Go 订阅端点；按量付费改回 https://opencode.ai/zen/v1
            "api_key_env": "OPENCODE_API_KEY",
            "model": "deepseek-v4-flash",
            "temperature": 0.3,
            "max_tokens": 8192,
            "timeout": 180,
            "reasoning_effort": "",
            "price_per_1m_input": 0.0,
            "price_per_1m_output": 0.0,
        },
    },
    "context": {
        "max_tokens": 6000,  # 单个重写请求的待译文本预算（约）
        "scene_max_units": 40,  # 单场景最大单元数（超过则切分）
        "adaptive_batch": True,  # 动态批大小反馈闭环（失败收缩/成功放大）
        "budget_tokens": 400000,  # 本轮总 token 预算上限，0=不限（正式版全量可按项目规模调高）
        "adaptive_min_units": 10,  # 自适应下限（条）
        "adaptive_min_tokens": 1500,  # 自适应下限（token）
        "adaptive_max_units": 80,  # 自适应上限（条）
        "adaptive_max_tokens": 12000,  # 自适应上限（token）
        "adaptive_shrink": 0.5,  # 连续失败后的收缩因子
        "adaptive_grow": 1.5,  # 连续成功后的放大因子
        "adaptive_fail_threshold": 2,  # 连续失败 N 批触发收缩
        "adaptive_success_threshold": 3,  # 连续成功 N 批触发放大
        "summary_tokens": 500,  # 滚动摘要长度上限
        "few_shot_pairs": 6,  # 携带的最近已译句对数量
        "summary_every": 5,  # 每 N 场景更新一次滚动摘要
        "polish_every": 5,  # 每 N 场景做一次一致性复查
        "max_workers": 4,  # 分支并行最大并发数
        "understanding_reasoning_effort": "",  # 理解阶段推理强度（留空=跟随 llm）
    },
    "worldbook": {
        "enabled": True,
        "chunk_tokens": 3200,
        "max_constants": 5,  # 常驻条目上限
        "max_content_chars": 120,  # 单条目内容上限
        "reasoning_effort": "none",  # 世界书生成关闭推理以控成本
    },
    "scan": {
        "enabled": True,
        "min_frequency": 6,  # 候选最低出现次数
        "stopwords": [],  # 额外停用词（内置常见中英文通用词表，这里可追加）
        "max_items": 500,
        "context_window_lines": 2,
        "max_context_samples": 3,
        "source_language_guard": True,  # 目标语言字符占比 >20% 时中止
    },
    "deliberation": {
        "batch_size": 10,
        "auto_approve_high": True,  # 高置信且无撞车自动采纳
    },
    "search": {
        "enabled": False,  # 联网查证总开关（默认关；自用可选开）
        "engine": "off",  # off | tavily | duckduckgo | deepseek
        "api_key_env": "TAVILY_API_KEY",
        "max_results": 5,
        "timeout": 15,
    },
    "memory": {
        "vector_enabled": False,  # 向量检索兜底（需配置 embedding_model）
        "embedding_model": "",
        "top_k": 3,
    },
    "branch": {
        "parallel": False,  # 独立分支并行执行（默认顺序）
        "detect": True,  # 按 label 首段识别分支
    },
    "review": {
        "enabled": False,  # True 时翻译产出审校表（xlsx）人工确认后再回填
    },
    "fonts": {
        "enabled": True,
        "default": "noto_sans_sc",
        "map": {},  # 原字体名 -> 字体 id/文件名
        "names": {},  # 英文显示名 -> 中文名（写入 names.rpy）
        "dir": "",  # 本地字体目录（文件名直引）
    },
    "review_dir": "projects",  # 工作产物根目录（相对本工程或绝对路径）
    "web": {"port": 8765},
    "localization": {"style": "mixed"},  # faithful | mixed | localized
    "recent_projects": [],
}


def default_config() -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_CONFIG)


def find_config_path(path: str | Path | None = None) -> Path | None:
    """解析配置路径：显式指定原样返回；未指定按查找顺序返回第一个已存在的文件。"""

    if path:
        return Path(path)
    for candidate in (
        Path.cwd() / "config.yaml",
        Path.cwd() / "config.yml",
        PROJECT_ROOT / "config.yaml",
        PROJECT_ROOT / "config.example.yaml",
    ):
        if candidate.exists():
            return candidate
    return None


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    resolved = find_config_path(path)
    if resolved is None:
        raise FileNotFoundError(
            "未找到配置文件。请先运行 `python -m tav2 init` 生成 config.yaml。"
        )
    with open(resolved, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    cfg = _merge(default_config(), data)
    # 仅当用户显式选择了供应商（config 里写了 llm_profile）时才用 profile 覆写，
    # 旧配置（未写过该键）保持 llm 字段原样，完全向后兼容。
    if "llm_profile" in data:
        _apply_llm_profile(cfg)
    _validate(cfg)
    return cfg


# profile 覆写涉及的非敏感 LLM 字段（api_key 明文与 mock 永远不写进 profile）
LLM_PROFILE_KEYS = (
    "base_url",
    "api_key_env",
    "model",
    "temperature",
    "max_tokens",
    "timeout",
    "reasoning_effort",
    "price_per_1m_input",
    "price_per_1m_output",
)


def _apply_llm_profile(cfg: dict[str, Any]) -> None:
    """把选中 profile 的值应用到 cfg["llm"]；profile 不存在则不动。"""

    name = str(cfg.get("llm_profile") or "").strip()
    profiles = cfg.get("llm_profiles") or {}
    profile = profiles.get(name) if isinstance(profiles, dict) else None
    if not isinstance(profile, dict):
        return
    llm = cfg.setdefault("llm", {})
    for key in LLM_PROFILE_KEYS:
        if key in profile and profile[key] is not None:
            llm[key] = profile[key]


def _sync_llm_to_profile(cfg: dict[str, Any]) -> None:
    """保存前把当前生效的 llm 值写回选中 profile，保证网页微调不丢失。"""

    name = str(cfg.get("llm_profile") or "").strip()
    profiles = cfg.get("llm_profiles")
    if not name or not isinstance(profiles, dict):
        return
    profile = profiles.get(name)
    if not isinstance(profile, dict):
        return
    llm = cfg.get("llm") or {}
    for key in LLM_PROFILE_KEYS:
        if key in llm:
            profile[key] = llm[key]


def set_llm_profile(cfg: dict[str, Any], name: str) -> dict[str, str]:
    """切换供应商 profile（本地生效）；返回错误字典，空表示成功。"""

    name = str(name or "").strip()
    profiles = cfg.get("llm_profiles") or {}
    if not name:
        cfg["llm_profile"] = ""
        return {}
    if name not in profiles:
        return {"llm_profile": f"未知供应商 profile：{name}"}
    cfg["llm_profile"] = name
    _apply_llm_profile(cfg)
    # 切换供应商后清空旧明文 key，避免误用上一家供应商的 key
    cfg.setdefault("llm", {})["api_key"] = ""
    return {}


def _validate(cfg: dict[str, Any]) -> None:
    env_name = str(cfg.get("llm", {}).get("api_key_env") or "").strip()
    if not env_name:
        raise ValueError("配置缺少 llm.api_key_env（API Key 的环境变量名）")
    base_url = str(cfg.get("llm", {}).get("base_url") or "").strip()
    model = str(cfg.get("llm", {}).get("model") or "").strip()
    if not cfg.get("llm", {}).get("mock") and (not base_url or not model):
        raise ValueError("配置缺少 llm.base_url 或 llm.model")


def api_key(cfg: dict[str, Any]) -> str | None:
    literal = str(cfg.get("llm", {}).get("api_key") or "").strip()
    if literal:
        return literal
    env_name = cfg["llm"].get("api_key_env", "TRANSLATE_AGENT_API_KEY")
    return os.environ.get(env_name)


# 前端可编辑的配置白名单（其余配置只读；桌面端复用同一份契约）
EDITABLE_TOP_KEYS = ("game_dir", "engine", "lang")
EDITABLE_LLM_KEYS = (
    "base_url",
    "model",
    "api_key_env",
    "api_key",
    "mock",
    "temperature",
    "max_tokens",
    "reasoning_effort",
)


_PROFILE_PUBLIC_KEYS = tuple(k for k in EDITABLE_LLM_KEYS if k != "api_key")


def public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """返回前端可展示/编辑的配置子集（profiles 不含明文 api_key）。"""

    llm = cfg.get("llm") or {}
    profiles = cfg.get("llm_profiles") or {}
    return {
        "game_dir": str(cfg.get("game_dir") or ""),
        "engine": str(cfg.get("engine") or "renpy"),
        "lang": str(cfg.get("lang") or "chinese"),
        "llm": {k: llm.get(k) for k in EDITABLE_LLM_KEYS},
        "llm_profile": str(cfg.get("llm_profile") or ""),
        "llm_profiles": {
            str(name): (
                {k: prof.get(k) for k in _PROFILE_PUBLIC_KEYS}
                if isinstance(prof, dict)
                else {}
            )
            for name, prof in profiles.items()
        },
        "web": {"port": int((cfg.get("web") or {}).get("port", 8765))},
        "review_dir": str(cfg.get("review_dir") or "projects"),
    }


def apply_config_patch(cfg: dict[str, Any], patch: Any) -> dict[str, str]:
    """把前端补丁合并进 cfg（原地生效），返回 {字段: 错误信息}；无错误返回空 dict。"""

    errors: dict[str, str] = {}
    if not isinstance(patch, dict):
        return {"_": "配置必须是对象"}
    if "llm_profile" in patch:
        profile_name = str(patch["llm_profile"] or "").strip()
        profiles = cfg.get("llm_profiles") or {}
        if profile_name and profile_name not in profiles:
            errors["llm_profile"] = f"未知供应商 profile：{profile_name}"
        else:
            cfg["llm_profile"] = profile_name
            if profile_name:
                _apply_llm_profile(cfg)
                cfg.setdefault("llm", {})["api_key"] = ""
    for key in EDITABLE_TOP_KEYS:
        if key not in patch:
            continue
        value = patch[key]
        if key == "engine" and str(value) not in ("renpy", "novel"):
            errors[key] = "engine 必须为 renpy 或 novel"
            continue
        if key in ("game_dir", "lang") and not str(value or "").strip():
            errors[key] = f"{key} 不能为空"
            continue
        if key == "game_dir":
            game_dir = str(value).strip()
            cfg[key] = game_dir
            remember_recent_project(cfg, game_dir)
            continue
        cfg[key] = str(value).strip()
    llm_patch = patch.get("llm")
    if isinstance(llm_patch, dict):
        for key in EDITABLE_LLM_KEYS:
            if key not in llm_patch:
                continue
            value = llm_patch[key]
            if key == "mock":
                cfg["llm"][key] = bool(value)
            elif key == "temperature":
                try:
                    cfg["llm"][key] = float(value)
                except (TypeError, ValueError):
                    errors["llm.temperature"] = "temperature 必须是数字"
            elif key == "max_tokens":
                try:
                    cfg["llm"][key] = int(value)
                except (TypeError, ValueError):
                    errors["llm.max_tokens"] = "max_tokens 必须是整数"
            elif key == "api_key":
                cfg["llm"][key] = str(value or "").strip()
            else:
                cfg["llm"][key] = str(value or "").strip()
    if not str(cfg.get("llm", {}).get("api_key_env") or "").strip():
        errors["llm.api_key_env"] = "api_key_env 不能为空"
    if not cfg.get("llm", {}).get("mock"):
        if not str(cfg.get("llm", {}).get("base_url") or "").strip():
            errors["llm.base_url"] = "非 mock 模式必须配置 base_url"
        if not str(cfg.get("llm", {}).get("model") or "").strip():
            errors["llm.model"] = "非 mock 模式必须配置 model"
    return errors


def remember_recent_project(cfg: dict[str, Any], game_dir: str, limit: int = 20) -> None:
    """把 game_dir 记入 recent_projects（按项目名去重、最近使用在前），供网页下拉一键切换。"""

    game_dir = str(game_dir or "").strip()
    if not game_dir:
        return
    name = Path(game_dir).name or "game"
    recent = [
        r
        for r in cfg.get("recent_projects") or []
        if isinstance(r, dict) and r.get("name") != name
    ]
    recent.insert(0, {"name": name, "game_dir": game_dir})
    cfg["recent_projects"] = recent[:limit]


def remembered_game_dir(cfg: dict[str, Any], project_name: str) -> str:
    """按项目名查最近记忆的游戏目录；未记录返回空串。"""

    for r in cfg.get("recent_projects") or []:
        if isinstance(r, dict) and r.get("name") == project_name:
            return str(r.get("game_dir") or "")
    return ""


def resolve_project_dir(cfg: dict[str, Any], game_dir: str | Path) -> Path:
    """返回工作产物目录：projects/<游戏名>。"""

    base = Path(cfg.get("review_dir", "projects"))
    if not base.is_absolute():
        base = PROJECT_ROOT / base
    name = Path(game_dir).name or "game"
    return base / name


def write_example_config(path: str | Path) -> Path:
    path = Path(path)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(default_config(), f, allow_unicode=True, sort_keys=False)
    return path


def save_config(cfg: dict[str, Any], path: str | Path) -> Path:
    _sync_llm_to_profile(cfg)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
    return path


def _merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result
