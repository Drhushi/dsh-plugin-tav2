/**
 * 审校导出：MVP 阶段用 CSV（施工规划 10.4 允许 CSV/Markdown）。
 * 列结构与 Python 基线 review.py 保持一致，便于后续 tav2_review_backfill。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backfillMachine, type BackfillStats } from './adapters/renpy/backfill'
import type { Document } from './models'

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function contextFor(units: Document['scenes'][number]['units'], idx: number, maxChars = 240): string {
  const parts: string[] = []
  for (let j = Math.max(0, idx - 2); j < idx; j += 1) {
    const text = units[j]?.source.trim()
    if (text) parts.push(`前: ${text.slice(0, 60)}`)
  }
  for (let j = idx + 1; j < Math.min(units.length, idx + 3); j += 1) {
    const text = units[j]?.source.trim()
    if (text) parts.push(`后: ${text.slice(0, 60)}`)
  }
  return parts.join(' | ').slice(0, maxChars)
}

/** 把本轮译文写入审校 CSV，返回绝对路径。 */
export function writeReviewCsv(
  projectDir: string,
  document: Document,
  translations: Record<string, string>,
  lang = 'chinese',
): string {
  mkdirSync(projectDir, { recursive: true })
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const path = join(projectDir, `review_${lang}_${stamp}.csv`)

  const rows: string[][] = [[
    '类型', '文件', '标识符', '序号', '源文本', '说话人', '上下文', '机器译文', '人工译文', '状态',
  ]]
  for (const scene of document.scenes) {
    for (let idx = 0; idx < scene.units.length; idx += 1) {
      const unit = scene.units[idx]!
      const text = translations[unit.unit_id]
      if (text === undefined) continue
      const context = contextFor(scene.units, idx)
      if (unit.kind === 'string') {
        rows.push([
          'string',
          String(unit.extra.file ?? ''),
          unit.source,
          '',
          unit.source,
          '',
          context,
          text,
          '',
          '待审',
        ])
      } else {
        rows.push([
          'dialogue',
          String(unit.extra.file ?? ''),
          String(unit.extra.identifier ?? ''),
          String(unit.extra.say_index ?? 0),
          unit.source,
          unit.speaker,
          context,
          text,
          '',
          '待审',
        ])
      }
    }
  }

  writeFileSync(path, rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8')
  return path
}


export type ReviewRow = Record<string, string>

const APPLY_STATUSES = new Set(['已确认', '已修改'])

/** 按审校状态过滤本次应回填的行（跳过/无译文/未确认除外）。 */
export function iterAppliedRows(rows: ReviewRow[], force = false): ReviewRow[] {
  const out: ReviewRow[] = []
  for (const row of rows) {
    const status = row['状态'] || '待审'
    if (status === '跳过' || (!APPLY_STATUSES.has(status) && !force)) continue
    const translation = (row['人工译文'] || row['机器译文'] || '').trim()
    if (!translation) continue
    out.push(row)
  }
  return out
}

/** 解析审校 CSV 为行字典列表（支持引号与逗号转义）。 */
export function readReviewCsv(path: string): ReviewRow[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
  const table = parseCsv(text)
  if (table.length === 0) return []
  const header = table[0]!.map((c) => c.trim())
  const rows: ReviewRow[] = []
  for (const cells of table.slice(1)) {
    if (cells.length === 0 || cells.every((c) => !c.trim())) continue
    const row: ReviewRow = {}
    for (let i = 0; i < Math.min(header.length, cells.length); i += 1) {
      row[header[i]!] = cells[i] ?? ''
    }
    rows.push(row)
  }
  return rows
}

/** 把审校 CSV 行回填到 tl 文件；返回 backfill 统计 + skipped。 */
export function backfillReviewCsv(
  gameRoot: string,
  lang: string,
  rows: ReviewRow[],
  force = false,
): BackfillStats & { skipped: number } {
  const dialogueMap = new Map<string, Map<string | number, string>>()
  const stringMap = new Map<string, string>()
  let skipped = 0

  for (const row of rows) {
    const status = row['状态'] || '待审'
    if (status === '跳过' || (!APPLY_STATUSES.has(status) && !force)) {
      skipped += 1
      continue
    }
    const translation = (row['人工译文'] || row['机器译文'] || '').trim()
    if (!translation) {
      skipped += 1
      continue
    }
    const rowType = row['类型'] || ''
    const filename = row['文件'] || ''
    if (rowType === 'dialogue') {
      const identifier = row['标识符'] || ''
      const sayIndex = Number.parseInt(row['序号'] || '0', 10) || 0
      const key = `${filename}|${identifier}`
      if (!dialogueMap.has(key)) dialogueMap.set(key, new Map())
      dialogueMap.get(key)!.set(sayIndex, translation)
    } else if (rowType === 'string') {
      const old = row['标识符'] || ''
      stringMap.set(`${filename}|${old}`, translation)
    }
  }

  const stats = backfillMachine(gameRoot, lang, dialogueMap, stringMap)
  return { ...stats, skipped: stats.skipped + skipped }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
