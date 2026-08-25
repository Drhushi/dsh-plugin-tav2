#!/usr/bin/env python3
"""renpy_pack_rpa.py — 把 tl/<lang> 目录打包为 Ren'Py .rpa 补丁（RPA-3.0）。

移植自用户资产 Translate/rpa打包/翻译文件打包工具.py 的 RenPyArchive 写路径，
改为非交互 CLI，供 dsh-plugin-tav2 的 tav2_pack 工具以子进程调用。

用法：
  python renpy_pack_rpa.py --src <tl/lang 目录> --lang <lang> --out <输出.rpa>

产物内部路径为 tl/<lang>/...，放进游戏根目录 game/ 下即可被 Ren'Py 加载；
Ren'Py 语言菜单会自动出现该语言（配合字体补丁即可正常显示）。
"""

import argparse
import codecs
import os
import pickle
import sys
import zlib

RPA3_MAGIC = 'RPA-3.0 '
KEY = 0xDEADBEEF


def pack(src_dir, lang, out_path):
    """遍历 src_dir，写入 RPA-3.0 归档（内部路径 tl/<lang>/<rel>）。"""
    if not os.path.isdir(src_dir):
        raise SystemExit('src 目录不存在: %s' % src_dir)
    files = {}
    for root, _dirs, names in os.walk(src_dir):
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src_dir).replace('\\', '/')
            internal = 'tl/%s/%s' % (lang, rel)
            with open(full, 'rb') as handle:
                files[internal] = handle.read()
    if not files:
        raise SystemExit('src 目录为空: %s' % src_dir)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    offset = 34  # RPA-3.0 头部长度（magic + 16 位 offset + 空格 + 8 位 key + 换行）
    indexes = {}
    with open(out_path, 'wb') as archive:
        archive.seek(offset)
        for internal, content in files.items():
            archive.write(content)
            indexes[internal] = [(offset ^ KEY, len(content) ^ KEY)]
            offset += len(content)
        archive.write(codecs.encode(pickle.dumps(indexes, protocol=2), 'zlib'))
        archive.seek(0)
        archive.write(codecs.encode('%s%016x %08x\n' % (RPA3_MAGIC, offset, KEY)))

    total = sum(len(content) for content in files.values())
    print('{"ok":true,"out":"%s","files":%d,"bytes":%d}' % (
        out_path.replace('\\', '/'), len(files), total))


def main():
    parser = argparse.ArgumentParser(description='把 tl/<lang> 打包为 Ren\'Py .rpa 补丁')
    parser.add_argument('--src', required=True, help='tl/<lang> 目录')
    parser.add_argument('--lang', required=True, help='语言目录名（chinese/english 等）')
    parser.add_argument('--out', required=True, help='输出 .rpa 文件路径')
    args = parser.parse_args()
    try:
        pack(args.src, args.lang, args.out)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print('pack failed: %s' % exc, file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
