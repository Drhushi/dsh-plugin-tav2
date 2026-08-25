/**
 * RPYC 容器解析（M2「rpyc 反编译」的第一块：容器读取）。
 *
 * 格式依据 renpy-8.5.3-sdk/renpy/script.py 的
 * write_rpyc_header / write_rpyc_data / read_rpyc_data：
 * - RPYC2 头：8 字节 "RENPY RPC2" + 3 × 12 字节槽表项（III 小端：slot、start、length）。
 * - 数据：头之后依次追加 zlib.compress(level=3) 的槽数据，start/length 指向压缩块。
 * - 文件尾追加 16 字节 MD5（本读取器只定位、不校验）。
 * - 旧版（头无 magic）：整个文件就是 zlib 压缩的单槽数据（视为 slot 1）。
 *
 * 本读取器返回各槽解压后的原始字节；槽内 pickle 负载的解码/反编译属后续里程碑。
 */
import { inflateSync } from 'node:zlib'

export interface RpycSlot {
  slot: number
  start: number
  length: number
}

export interface RpycContainer {
  version: 1 | 2
  /** 槽号 → 解压后的原始字节（RPYC2 的 pickle 负载）。 */
  slots: Map<number, Uint8Array>
  /** 头中记录的槽表（未解压的 start/length，便于诊断）。 */
  table: RpycSlot[]
  legacy: boolean
}

const RPYC2_HEADER = 'RENPY RPC2'
const RPYC2_MAGIC_LEN = 10 // len(RPYC2_HEADER)
const RPYC2_HEADER_LEN = RPYC2_MAGIC_LEN + 3 * 12 // 46 字节

/** 解析 .rpyc 容器（v1 整文件 zlib 或 v2 槽表）；返回各槽解压字节。 */
export function parseRpycContainer(buffer: Uint8Array): RpycContainer {
  if (buffer.length < RPYC2_MAGIC_LEN) throw new Error(`RPYC 文件过短（${buffer.length} 字节）`)
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, RPYC2_MAGIC_LEN))

  if (head !== RPYC2_HEADER) {
    // 旧版 v1：整个文件为 zlib 压缩数据（视为 slot 1）
    return {
      version: 1,
      slots: new Map([[1, new Uint8Array(inflateSync(buffer))]]),
      table: [],
      legacy: true,
    }
  }

  if (buffer.length < RPYC2_HEADER_LEN) {
    throw new Error(`RPYC2 头不足 ${RPYC2_HEADER_LEN} 字节（${buffer.length}）`)
  }
  const dv = new DataView(buffer.buffer, buffer.byteOffset, RPYC2_HEADER_LEN)
  const table: RpycSlot[] = []
  for (let i = 0; i < 3; i++) {
    const slot = dv.getUint32(RPYC2_MAGIC_LEN + i * 12, true)
    if (slot === 0) break
    table.push({
      slot,
      start: dv.getUint32(RPYC2_MAGIC_LEN + i * 12 + 4, true),
      length: dv.getUint32(RPYC2_MAGIC_LEN + i * 12 + 8, true),
    })
  }

  const slots = new Map<number, Uint8Array>()
  for (const s of table) {
    if (s.length <= 0 || s.start >= buffer.length) continue
    const end = Math.min(s.start + s.length, buffer.length)
    slots.set(s.slot, new Uint8Array(inflateSync(buffer.subarray(s.start, end))))
  }
  return { version: 2, slots, table, legacy: false }
}
