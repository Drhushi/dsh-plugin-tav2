"""小说抽取：txt / md / epub 归一化为 Document。

约定：
- Scene = 章/节（txt/md 一个文件一章；epub 每个 xhtml 一章）；
- Unit.unit_id = `章:段<sha1[:8]>`（稳定、可续传）；
- kind 按引号启发式分 dialogue/narration（不强制）；
- markup 保留原文（markdown/格式符），译文以侧写文件 tl/<lang>/translations.json 存储，
  原文文件永不改动（避免重排）。
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from tav2.models import Document, Scene, Unit


SOURCE_EXTS = (".txt", ".md", ".markdown", ".epub")


def unit_id(chapter: str, para: int, source: str) -> str:
    digest = hashlib.sha1(source.encode("utf-8")).hexdigest()[:8]
    return f"{chapter}:{para}<{digest}>"


def find_sources(game_dir: str | Path) -> list[Path]:
    """定位小说源：文件直接返回；目录递归收集（排除 tl/ 侧写）。"""

    root = Path(game_dir)
    if root.is_file():
        return [root] if root.suffix.lower() in SOURCE_EXTS else []
    out: list[Path] = []
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in SOURCE_EXTS:
            continue
        rel = f.relative_to(root).parts
        if "tl" in rel:
            continue
        out.append(f)
    return out


def sidecar_path(game_dir: str | Path, lang: str) -> Path:
    """侧写文件路径：tl/<lang>/translations.json（JSON 键即段落 id，天然防重排）。"""

    root = Path(game_dir)
    base = root if root.is_dir() else root.parent
    return base / "tl" / lang / "translations.json"


def load_sidecar(game_dir: str | Path, lang: str) -> dict[str, str]:
    path = sidecar_path(game_dir, lang)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in (data or {}).items()}


def _paragraphs_from_text(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


class _XhtmlText(HTMLParser):
    """把 xhtml 正文抽成段落（按块级标签切分）。"""

    BLOCK_TAGS = {
        "p",
        "div",
        "section",
        "article",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "blockquote",
        "br",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._current: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.BLOCK_TAGS:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCK_TAGS:
            self._flush()

    def handle_data(self, data: str) -> None:
        if data.strip():
            self._current.append(data.strip())

    def _flush(self) -> None:
        text = " ".join(self._current).strip()
        if text:
            self.blocks.append(text)
        self._current = []

    def close(self) -> None:
        self._flush()
        super().close()


def _xhtml_paragraphs(raw: str) -> list[str]:
    parser = _XhtmlText()
    parser.feed(raw)
    parser.close()
    return parser.blocks


def _epub_chapters(path: Path) -> list[tuple[str, list[str]]]:
    with zipfile.ZipFile(path) as zf:
        names = sorted(
            n for n in zf.namelist() if n.lower().endswith((".xhtml", ".html", ".htm"))
        )
        return [
            (name, _xhtml_paragraphs(zf.read(name).decode("utf-8", errors="replace")))
            for name in names
        ]


def _chapters(game_dir: str | Path) -> list[tuple[str, str, Path, list[str]]]:
    """返回 [(chapter_id, title, source_path, paragraphs)]，顺序稳定。"""

    out: list[tuple[str, str, Path, list[str]]] = []
    for chap_idx, src in enumerate(find_sources(game_dir), start=1):
        if src.suffix.lower() == ".epub":
            for sub, (name, paras) in enumerate(_epub_chapters(src), start=1):
                out.append(
                    (
                        f"{chap_idx}-{sub}",
                        f"{src.stem}/{Path(name).stem}",
                        src,
                        paras,
                    )
                )
        else:
            text = src.read_text(encoding="utf-8-sig", errors="replace")
            out.append((str(chap_idx), src.stem, src, _paragraphs_from_text(text)))
    return out


def _kind(text: str) -> str:
    if text.startswith(("“", '"', "「", "『", "'")):
        return "dialogue"
    return "narration"


def load_document(game_dir: str | Path, lang: str = "chinese") -> Document:
    """把小说目录/文件归一化为 Document。"""

    translations = load_sidecar(game_dir, lang)
    chapters = _chapters(game_dir)
    if not chapters:
        raise FileNotFoundError(f"未找到小说文本（.txt/.md/.epub）：{game_dir}")

    scenes: list[Scene] = []
    for chapter_id, title, src_path, paras in chapters:
        scene = Scene(
            scene_id=f"chapter::{chapter_id}",
            title=title,
            order=len(scenes),
            branch="main",
        )
        for para_idx, para_text in enumerate(paras, start=1):
            uid = unit_id(chapter_id, para_idx, para_text)
            translated = translations.get(uid, "")
            scene.units.append(
                Unit(
                    unit_id=uid,
                    kind=_kind(para_text),
                    source=para_text,
                    markup=para_text,
                    scene_id=scene.scene_id,
                    extra={
                        "file": str(src_path),
                        "chapter": chapter_id,
                        "para": para_idx,
                        "format": src_path.suffix.lower().lstrip(".") or "text",
                        "translated": bool(translated.strip()) and translated != para_text,
                        "translation": translated,
                    },
                )
            )
        scenes.append(scene)
    return Document(
        engine="novel",
        game_dir=str(Path(game_dir)),
        lang=lang,
        scenes=scenes,
        extra={"format": "novel"},
    )


def scan_lines(game_dir: str | Path, lang: str = "chinese") -> list[str]:
    document = load_document(game_dir, lang)
    out: list[str] = []
    for u in document.all_units():
        out.append(
            f"[{u.extra.get('chapter')}:{u.extra.get('para')}] {u.source}"
        )
    return out
