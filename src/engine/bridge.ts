/**
 * 临时 Python 桥：仅保留给 engineBackend=python 的 A/B 对照路径；
 * TS 后端（engineBackend=ts）已由 TS 适配器直接加载文档（M5 已落地）。
 */

import { spawnSync } from 'node:child_process'
import type { Config } from '../config'
import { resolveConfigPath } from './config'
import { Document, type DocumentJson } from './models'

const DUMP_SCRIPT = `
import json, sys
from tav2.config import load_config, resolve_project_dir
from tav2.adapters import get_adapter
cfg = load_config(sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None)
adapter = get_adapter(cfg)
doc = adapter.extract()
def u(d):
    return {"unit_id": d.unit_id, "kind": d.kind, "source": d.source, "markup": d.markup,
            "speaker": d.speaker, "scene_id": d.scene_id, "prev_ids": list(d.prev_ids),
            "extra": dict(d.extra)}
out = {
  "document": {
    "engine": doc.engine, "game_dir": doc.game_dir, "lang": doc.lang,
    "scenes": [{"scene_id": s.scene_id, "title": s.title, "order": s.order,
                "branch": s.branch, "extra": dict(s.extra),
                "units": [u(x) for x in s.units]} for s in doc.scenes]
  },
  "db_path": str(resolve_project_dir(cfg, adapter.game_dir) / "db.sqlite"),
  "scan_lines": adapter.scan_lines() if hasattr(adapter, "scan_lines") else [],
}
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(out, ensure_ascii=False))
`

export interface BridgeResult {
  document: Document
  dbPath: string
  /** 世界书/术语扫描用的原文行（含 [文件:行号] 前缀，M5 由 TS 适配器产出）。 */
  scanLines: string[]
}

/** 通过 python -c 调用 tav2 适配器导出文档与 DB 路径。 */
export function documentFromPython(config: Config): BridgeResult {
  const cfgPath = config.engineConfigPath || resolveConfigPath('', config.projectDir)
  const args = ['-c', DUMP_SCRIPT]
  if (cfgPath && config.projectDir) args.push(cfgPath)
  const result = spawnSync(config.python, args, {
    cwd: config.projectDir || undefined,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`文档桥接失败：${String(result.stderr || result.stdout || 'python 不可用').slice(0, 500)}`)
  }
  const data = JSON.parse(String(result.stdout ?? '')) as { document: DocumentJson; db_path: string; scan_lines?: string[] }
  return {
    document: Document.fromJson(data.document),
    dbPath: data.db_path,
    scanLines: Array.isArray(data.scan_lines) ? data.scan_lines.map(String) : [],
  }
}
