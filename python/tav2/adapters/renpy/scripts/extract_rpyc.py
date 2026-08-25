"""Extract only script entries (.rpyc/.rpymc/.rpy) from a Ren'Py archive.

Usage: python extract_rpyc.py <archive.rpa> <out_dir> [sdk_root]

Uses the matching Ren'Py SDK's `renpy.loader` (pass the SDK root as the third
argument or set RENPY_SDK; the SDK's bundled python ignores PYTHONPATH, so the
script inserts the SDK root into sys.path itself).
"""

import os
import sys


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: extract_rpyc.py <archive> <out_dir> [sdk_root]")
        return 1

    archive, out_dir = sys.argv[1], sys.argv[2]
    sdk_root = os.environ.get("RENPY_SDK") or (sys.argv[3] if len(sys.argv) > 3 else None)
    if sdk_root:
        sys.path.insert(0, os.path.abspath(sdk_root))
        # Ren'Py 8.5.3's renpy.config has module-level forward references; import
        # renpy.error/object first (as the game bootstrap would do).
        import renpy.error  # noqa: F401
        import renpy.object  # noqa: F401

    from renpy import config, loader

    os.makedirs(out_dir, exist_ok=True)

    # Index the archive via the SDK's loader.
    archive_dir = os.path.dirname(os.path.realpath(archive))
    config.searchpath = [archive_dir]
    config.basedir = os.path.dirname(archive_dir)
    loader.scandirfiles()
    loader.index_archives()

    wanted_base = os.path.basename(archive).lower()
    index = None
    for fn, idx in loader.archives:
        if os.path.basename(fn).lower() == wanted_base:
            index = idx
            break
    if index is None:
        raise RuntimeError(f"archive not found after indexing: {archive}")

    names = list(index)
    script_names = [n for n in names if n.lower().endswith((".rpyc", ".rpymc", ".rpy"))]
    print(f"archive entries: {len(names)}, script entries: {len(script_names)}")

    for name in sorted(script_names):
        f = loader.load_from_archive(name)
        if f is None:
            print(f"  ! read failed: {name}")
            continue
        with f:
            data = f.read()
        target = os.path.join(out_dir, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(data)
        print(f"  + {name} ({len(data)} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
