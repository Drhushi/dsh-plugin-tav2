/**
 * 校验回填：标识符集合一致、逐行标签保持。
 * 移植自 tav2 的 adapters/renpy/adapter.py 的 verify() 部分（不含 template_integrity 覆盖率）。
 */
import { tagsPreserved } from '../../gates'
import { loadWork } from './tlparser'

export interface VerifyReport {
  dialogue_blocks: number
  expected_blocks: number
  missing_blocks: number
  missing_ids: string[]
  tag_violations: number
  tag_violation_samples: string[]
  /** S17 护栏：say 行说话人不是「合法标识符」或「带引号字符串」的条数（Ren'Py 会拒绝这类输出）。 */
  invalid_speakers: number
  invalid_speaker_samples: string[]
  strings: number
  coverage: unknown
}

/**
 * 校验 tl/<lang>：至少实现 dialogue_blocks / expected_blocks / missing_blocks / missing_ids /
 * tag_violations / tag_violation_samples / strings。
 * expectedBlocks 未提供时，用 tl 中已有的 dialogue blocks 作为 expected（此时 missing_blocks 为 0）。
 */
export function verifyRenpy(
  gameDir: string,
  lang: string,
  expectedBlocks?: Set<string>,
): VerifyReport {
  const [, dialogue, strings] = loadWork(gameDir, lang)

  const blocks = new Set(dialogue.map((u) => u.identifier).filter((id) => id !== ''))
  const expected = expectedBlocks ?? new Set(blocks)
  const missingIds = [...expected].filter((id) => !blocks.has(id)).sort()
  const missingBlocks = missingIds.length

  const tagViolations: string[] = []
  const speakerViolations: string[] = []
  // S17 护栏：Ren'Py 的 say 说话人必须是合法标识符（sora/mc）或带引号字符串（掩名 "..." / "???"）。
  // 裸 `... "译"` / `??? "译"` 是非法输出（Ren'Py：expected statement），必须被 check 拦下。
  const SPEAKER_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
  const SPEAKER_QUOTED_RE = /^"[^"]*"$/
  for (const unit of dialogue) {
    for (let i = 0; i < unit.sayLines.length; i += 1) {
      const say = unit.sayLines[i]!
      const source = say.originalWhat ?? say.what
      const current = say.what
      if (
        current.trim() !== '' &&
        source !== current &&
        !tagsPreserved(source, current)
      ) {
        tagViolations.push(`${unit.filename}:${unit.identifier}#${i}`)
      }
      const who = say.who
      if (
        who !== null &&
        !SPEAKER_IDENT_RE.test(who) &&
        !SPEAKER_QUOTED_RE.test(who)
      ) {
        speakerViolations.push(`${unit.filename}:${unit.identifier}#${i} speaker=${who}`)
      }
    }
  }

  return {
    dialogue_blocks: blocks.size,
    expected_blocks: expected.size,
    missing_blocks: missingBlocks,
    missing_ids: missingIds.slice(0, 20),
    tag_violations: tagViolations.length,
    tag_violation_samples: tagViolations.slice(0, 10),
    invalid_speakers: speakerViolations.length,
    invalid_speaker_samples: speakerViolations.slice(0, 10),
    strings: strings.length,
    // template_integrity 覆盖率未实现（M5 最小闭环）。
    coverage: null,
  }
}
