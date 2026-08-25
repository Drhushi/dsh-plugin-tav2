/**
 * RPA 归档解析 + 最小 Python pickle 解码器（M1「TS 自解包」第一层）。
 *
 * 格式依据 renpy-8.5.3-sdk/renpy/loader.py 的 RPAv3ArchiveHandler / RPAv2ArchiveHandler：
 * - RPA-3.0：8 字节 magic + 16 位十六进制索引偏移 + 空格 + 8 位十六进制 key + 换行；
 *   索引在偏移处为 zlib(pickle)，条目为 2 元组 (offset, dlen) 或 3 元组 (offset, dlen, start)，
 *   offset/dlen 存储值均与 key 异或；文件内容为原始字节（多段切片拼接）。
 * - RPA-2.0：8 字节 magic + 16 位十六进制索引偏移（无 key、无异或）。
 *
 * pickle 解码器只覆盖 Ren'Py RPA 索引实际用到的 opcode（协议 0–4），
 * 其余 opcode fail-closed 抛错，绝不静默产出错误数据。
 *
 * M4（打包·写）：writeRpaArchive 用协议 2 pickle 编码器 + RPA-3.0 写出，
 * 字节级对齐 CPython（BININT1/2/BININT/LONG1 的取值边界与 Python 一致），
 * 可被 Python 的 pickle.loads 与 Ren'Py loader 直接读取。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 未知类对象的通用结构（M2 调查用）：类名 + NEWOBJ 参数 + BUILD 状态。 */
export interface GlobalInstance {
  __class__: string
  __args__: PickleValue[]
  __state__?: Map<PickleValue, PickleValue>
}

/** pickle 解码结果：int→number、str→string、bytes→Uint8Array、dict→Map、tuple/list→数组。 */
export type PickleValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | PickleValue[]
  | Map<PickleValue, PickleValue>
  | GlobalInstance

/** 一个文件的归档片段（多片段拼接）。 */
export interface RpaEntrySlice {
  offset: number
  dlen: number
  /** 3 元组条目的 start（原始文件切片标记，通常为空 bytes）；无则忽略。 */
  start?: Uint8Array
}

export interface RpaFileEntry {
  name: string
  slices: RpaEntrySlice[]
}

export interface RpaArchive {
  version: 2 | 3
  key: number
  files: Map<string, RpaFileEntry>
  /** 归档原始字节（readRpaFile 依赖它按 offset 切片）。 */
  buffer: Uint8Array
}

// ---------------------------------------------------------------------------
// 最小 Python pickle 解码器（协议 0–4 的 RPA 索引子集）
// ---------------------------------------------------------------------------

interface GlobalFn {
  (args: PickleValue[], viaNewobj?: boolean): PickleValue
  /** 调查模式：函数作为数据引用时的类名（如 builtins.int）。 */
  __pickleName?: string
}
type StackItem = PickleValue | GlobalFn

// 带参数 opcode（来自 pickletools 权威表）
const PROTO = 0x80
const FRAME = 0x95
const BININT = 0x4a
const BININT1 = 0x4b
const BININT2 = 0x4d
const LONG = 0x4c
const LONG1 = 0x8a
const LONG4 = 0x8b
const INT = 0x49
const FLOAT = 0x46
const BINFLOAT = 0x47
const BINUNICODE = 0x58
const SHORT_BINUNICODE = 0x8c
const BINUNICODE8 = 0x8d
const UNICODE = 0x56
const BINSTRING = 0x54
const SHORT_BINSTRING = 0x55
const STRING = 0x53
const BINBYTES = 0x42
const SHORT_BINBYTES = 0x43
const BINBYTES8 = 0x8e
const GLOBAL = 0x63
const STACK_GLOBAL = 0x93
const BINPUT = 0x71
const LONG_BINPUT = 0x72
const BINGET = 0x68
const LONG_BINGET = 0x6a
const PUT = 0x70
const GET = 0x67

// 无参数 opcode
const MARK = 0x28
const STOP = 0x2e
const POP = 0x30
const POP_MARK = 0x31
const DUP = 0x32
const NONE = 0x4e
const EMPTY_TUPLE = 0x29
const TUPLE = 0x74
const TUPLE1 = 0x85
const TUPLE2 = 0x86
const TUPLE3 = 0x87
const EMPTY_LIST = 0x5d
const LIST = 0x6c
const EMPTY_DICT = 0x7d
const DICT = 0x64
const APPEND = 0x61
const APPENDS = 0x65
const SETITEM = 0x73
const SETITEMS = 0x75
const REDUCE = 0x52
const NEWOBJ = 0x81
const BUILD = 0x62
const NEWTRUE = 0x88
const NEWFALSE = 0x89
const MEMOIZE = 0x94

function latin1Bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((ch) => ch.charCodeAt(0) & 0xff))
}

/**
 * 解析 GLOBAL 引用的模块名/函数名；仅支持 RPA 索引用到的构造（bytes / _codecs.encode）
 * 与 M2 调查用到的通用构造（collections.defaultdict / __builtin__ list）。
 */
function resolveGlobal(module: string, name: string): GlobalFn {
  const mod = module.trim()
  if ((mod === '__builtin__' || mod === 'builtins') && name === 'bytes') {
    return (args) => {
      if (args.length === 0) return new Uint8Array(0)
      if (args.length === 1 && typeof args[0] === 'number') return new Uint8Array(args[0])
      if (args.length === 1 && args[0] instanceof Uint8Array) return args[0]
      throw new Error(`pickle 解码失败：不支持的 bytes 参数（${args.length} 个）`)
    }
  }
  if (mod === '_codecs' && name === 'encode') {
    return (args) => {
      const [s, enc] = args
      if (typeof s !== 'string') throw new Error('pickle 解码失败：_codecs.encode 参数非字符串')
      const encoding = typeof enc === 'string' ? enc.toLowerCase() : ''
      if (
        encoding === 'latin-1' || encoding === 'latin1'
        || encoding === 'iso8859-1' || encoding === 'ascii'
      ) {
        return latin1Bytes(s)
      }
      throw new Error(`pickle 解码失败：不支持的编码 ${encoding}`)
    }
  }
  if (mod === 'collections' && name === 'defaultdict') {
    // defaultdict 本质是 dict；调查时返回普通 Map（default_factory 不建模）。
    return () => new Map<PickleValue, PickleValue>()
  }
  if ((mod === '__builtin__' || mod === 'builtins') && name === 'list') {
    return (args, viaNewobj) => {
      // NEWOBJ list：(cls, (items,)) → 由 items 建数组；REDUCE list(...) 同理。
      const items = args[0]
      return Array.isArray(items) ? (items as PickleValue[]) : []
    }
  }
  throw new Error(`pickle 解码失败：不支持的 GLOBAL ${mod}.${name}`)
}

function opcodeName(op: number): string {
  if (op >= 0x20 && op <= 0x7e) return `0x${op.toString(16)} '${String.fromCharCode(op)}'`
  return `0x${op.toString(16)}`
}

/**
 * 解码一个 Python pickle 字节流（协议 0–4 的 RPA 索引子集 + M2 调查扩展）。
 * 默认 fail-closed：不认识的 GLOBAL 抛错。传 opts.allowUnknownClasses 时，
 * 未知类退化为通用结构 GlobalInstance（__class__/__args__/__state__），
 * 用于 rpyc 槽内 renpy AST 的结构化调查（不实现类语义）。
 */
export function decodePickle(
  data: Uint8Array,
  opts?: { allowUnknownClasses?: boolean },
): PickleValue {
  const allowUnknown = opts?.allowUnknownClasses ?? false
  const stack: StackItem[] = []
  const marks: number[] = []
  const memo = new Map<number, StackItem>()
  let pos = 0

  const fail = (msg: string): never => { throw new Error(`pickle 解码失败：${msg}`) }
  const need = (n: number): void => { if (pos + n > data.length) fail('数据截断') }
  const readU8 = (): number => { need(1); return data[pos++]! }
  const readU16 = (): number => { need(2); const v = data[pos]! | (data[pos + 1]! << 8); pos += 2; return v }
  const readI32 = (): number => { need(4); const v = (data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24)); pos += 4; return v }
  const readU32 = (): number => readI32() >>> 0
  const readU64 = (): number => {
    need(8)
    let v = 0n
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[pos + i]!)
    pos += 8
    return Number(v)
  }
  const readBytes = (n: number): Uint8Array => { need(n); const b = data.subarray(pos, pos + n); pos += n; return new Uint8Array(b) }
  const readUtf8 = (n: number): string => new TextDecoder().decode(readBytes(n))
  const readLine = (): string => {
    let out = ''
    while (pos < data.length) {
      const c = data[pos]!
      pos += 1
      if (c === 0x0a) break
      out += String.fromCharCode(c)
    }
    return out
  }
  const readRawLine = (): Uint8Array => {
    const start = pos
    while (pos < data.length && data[pos]! !== 0x0a) pos += 1
    const line = data.subarray(start, pos)
    if (pos < data.length) pos += 1 // 吃掉换行
    return new Uint8Array(line)
  }
  const readLongLittleEndian = (n: number): number => {
    const b = readBytes(n)
    // pickle LONG1/LONG4：n 字节小端、二进制补码，符号位在最高字节
    // （正数最高字节为 0x00，负数最高字节为 0xff）
    let big = 0n
    for (let i = n - 1; i >= 0; i--) big = (big << 8n) | BigInt(b[i]!)
    if (n > 0 && (b[n - 1]! & 0x80) !== 0) big -= 1n << BigInt(n * 8)
    return Number(big)
  }
  const top = (): StackItem => {
    if (stack.length === 0) fail('空栈')
    return stack[stack.length - 1]!
  }
  const asValue = (v: StackItem): PickleValue => {
    if (typeof v !== 'function') return v
    // 函数作为数据引用（如 defaultdict 的 default_factory）时转成可序列化的通用结构。
    return { __class__: v.__pickleName ?? '<global>', __args__: [] }
  }
  const pop = (): StackItem => {
    if (stack.length === 0) fail('空栈')
    return stack.pop()!
  }
  const popValue = (): PickleValue => asValue(pop())
  const popMark = (): number => {
    const m = marks.pop()
    if (m !== undefined) return m
    return fail('前无 MARK')
  }
  const topList = (): PickleValue[] => {
    const t = top()
    if (Array.isArray(t)) return t
    return fail('目标不是 list')
  }
  const topMap = (): Map<PickleValue, PickleValue> => {
    const t = top()
    if (t instanceof Map) return t
    return fail('目标不是 dict')
  }
  /** 解析 GLOBAL 引用；未知类在 allowUnknown 时退化为通用结构工厂。 */
  const makeGlobal = (mod: string, name: string): GlobalFn => {
    try {
      return resolveGlobal(mod, name)
    } catch (err) {
      if (!allowUnknown) throw err
      const factory = (args: PickleValue[]): PickleValue => ({
        __class__: `${mod}.${name}`,
        __args__: args as PickleValue[],
      })
      factory.__pickleName = `${mod}.${name}`
      return factory
    }
  }

  while (true) {
    const op = readU8()
    switch (op) {
      case PROTO: readU8(); break
      case FRAME: readU64(); break

      case MARK: marks.push(stack.length); break
      case POP: stack.pop(); break
      case POP_MARK: stack.length = popMark(); break
      case DUP: stack.push(top()); break

      case NONE: stack.push(null); break
      case NEWTRUE: stack.push(true); break
      case NEWFALSE: stack.push(false); break

      case EMPTY_TUPLE: stack.push([]); break
      case TUPLE1: { const a = popValue(); stack.push([a]); break }
      case TUPLE2: { const b = popValue(); const a = popValue(); stack.push([a, b]); break }
      case TUPLE3: { const c = popValue(); const b = popValue(); const a = popValue(); stack.push([a, b, c]); break }
      case TUPLE: {
        const m = popMark()
        stack.push(stack.splice(m) as PickleValue[])
        break
      }

      case EMPTY_LIST: stack.push([]); break
      case LIST: {
        const m = popMark()
        stack.push(stack.splice(m) as PickleValue[])
        break
      }

      case EMPTY_DICT: stack.push(new Map()); break
      case DICT: {
        const m = popMark()
        const items = stack.splice(m)
        if (items.length % 2 !== 0) fail('DICT 键值不配对')
        const map = new Map<PickleValue, PickleValue>()
        for (let i = 0; i < items.length; i += 2) {
          map.set(asValue(items[i]!), asValue(items[i + 1]!))
        }
        stack.push(map)
        break
      }

      case APPEND: { const item = popValue(); topList().push(item); break }
      case APPENDS: {
        const m = popMark()
        const items = stack.splice(m)
        const list = topList()
        for (const it of items) list.push(asValue(it))
        break
      }
      case SETITEM: {
        const value = popValue()
        const key = popValue()
        topMap().set(key, value)
        break
      }
      case SETITEMS: {
        const m = popMark()
        const items = stack.splice(m)
        if (items.length % 2 !== 0) fail('SETITEMS 键值不配对')
        const map = topMap()
        for (let i = 0; i < items.length; i += 2) {
          map.set(asValue(items[i]!), asValue(items[i + 1]!))
        }
        break
      }

      case REDUCE: {
        const args = pop()
        const func = pop()
        if (!Array.isArray(args)) fail('REDUCE args 非 tuple')
        if (typeof func !== 'function') fail('REDUCE 非函数')
        stack.push((func as GlobalFn)(args as PickleValue[]))
        break
      }
      case NEWOBJ: {
        // 协议 2：cls.__new__(cls, *args)；renpy AST 类与 __builtin__ list 用此 opcode。
        const args = pop()
        const cls = pop()
        if (!Array.isArray(args)) fail('NEWOBJ args 非 tuple')
        if (typeof cls !== 'function') fail('NEWOBJ 非类')
        stack.push((cls as GlobalFn)(args as PickleValue[], true))
        break
      }
      case BUILD: {
        // inst.__setstate__(state)；通用实例把 dict 状态记入 __state__。
        const state = pop()
        const inst = pop()
        if (
          state instanceof Map
          && typeof inst === 'object' && inst !== null
          && !Array.isArray(inst) && !(inst instanceof Map) && !(inst instanceof Uint8Array)
        ) {
          (inst as GlobalInstance).__state__ = state
        }
        stack.push(inst)
        break
      }
      case GLOBAL: {
        const mod = readLine()
        const name = readLine()
        stack.push(makeGlobal(mod, name))
        break
      }
      case STACK_GLOBAL: {
        const name = pop()
        const mod = pop()
        if (typeof mod === 'string' && typeof name === 'string') {
          stack.push(makeGlobal(mod, name))
          break
        }
        return fail('STACK_GLOBAL 栈结构错误')
      }

      case BINPUT: memo.set(readU8(), top()); break
      case LONG_BINPUT: memo.set(readU32(), top()); break
      case BINGET: {
        const v = memo.get(readU8())
        if (v !== undefined) { stack.push(v); break }
        return fail('BINGET 未知 memo')
      }
      case LONG_BINGET: {
        const v = memo.get(readU32())
        if (v !== undefined) { stack.push(v); break }
        return fail('LONG_BINGET 未知 memo')
      }
      case PUT: memo.set(Number.parseInt(readLine(), 10) || 0, top()); break
      case GET: {
        const v = memo.get(Number.parseInt(readLine(), 10) || 0)
        if (v !== undefined) { stack.push(v); break }
        return fail('GET 未知 memo')
      }
      case MEMOIZE: memo.set(memo.size, top()); break

      case BININT: stack.push(readI32()); break
      case BININT1: stack.push(readU8()); break
      case BININT2: stack.push(readU16()); break
      case LONG: {
        let line = readLine()
        if (line.endsWith('L') || line.endsWith('l')) line = line.slice(0, -1)
        stack.push(Number.parseInt(line, 10))
        break
      }
      case LONG1: stack.push(readLongLittleEndian(readU8())); break
      case LONG4: stack.push(readLongLittleEndian(readU32())); break
      case INT: stack.push(Number.parseInt(readLine(), 10)); break
      case FLOAT: stack.push(Number.parseFloat(readLine())); break
      case BINFLOAT: {
        need(8)
        const v = new DataView(data.buffer, data.byteOffset + pos, 8).getFloat64(0, false)
        pos += 8
        stack.push(v)
        break
      }

      case BINUNICODE: stack.push(readUtf8(readU32())); break
      case SHORT_BINUNICODE: stack.push(readUtf8(readU8())); break
      case BINUNICODE8: stack.push(readUtf8(readU64())); break
      case UNICODE: stack.push(new TextDecoder().decode(readRawLine())); break

      case BINSTRING: stack.push(readBytes(readU32())); break
      case SHORT_BINSTRING: stack.push(readBytes(readU8())); break
      case STRING: stack.push(latin1Bytes(readLine())); break
      case BINBYTES: stack.push(readBytes(readU32())); break
      case SHORT_BINBYTES: stack.push(readBytes(readU8())); break
      case BINBYTES8: stack.push(readBytes(readU64())); break

      case STOP: {
        const v = pop()
        if (stack.length !== 0) fail('STOP 时栈非空')
        if (typeof v !== 'function') return v
        return fail('STOP 栈顶是函数')
      }

      default:
        fail(`不支持的 opcode ${opcodeName(op)}（位置 ${pos - 1}）`)
    }
  }
}

// ---------------------------------------------------------------------------
// RPA 归档解析
// ---------------------------------------------------------------------------

function normalizeIndex(
  index: unknown,
  key: number,
): Map<string, RpaFileEntry> {
  if (!(index instanceof Map)) {
    throw new Error(`RPA 索引结构异常：期望 dict，实际 ${typeof index}`)
  }
  const files = new Map<string, RpaFileEntry>()
  for (const [name, entries] of index) {
    if (typeof name !== 'string' || !Array.isArray(entries)) {
      throw new Error(`RPA 索引结构异常：name=${String(name)} entries=${typeof entries}`)
    }
    const slices: RpaEntrySlice[] = entries.map((raw) => {
      if (!Array.isArray(raw)) throw new Error(`RPA 索引条目异常：${typeof raw}`)
      if (raw.length === 2) {
        if (typeof raw[0] !== 'number' || typeof raw[1] !== 'number') {
          throw new Error(`RPA 索引条目异常：${String(raw[0])}/${String(raw[1])}`)
        }
        return { offset: xorUint32(raw[0], key), dlen: xorUint32(raw[1], key) }
      }
      if (raw.length === 3) {
        if (typeof raw[0] !== 'number' || typeof raw[1] !== 'number') {
          throw new Error(`RPA 索引条目异常：${String(raw[0])}/${String(raw[1])}`)
        }
        return {
          offset: xorUint32(raw[0], key),
          dlen: xorUint32(raw[1], key),
          start: raw[2] instanceof Uint8Array ? raw[2] : undefined,
        }
      }
      throw new Error(`RPA 索引条目元组长度异常：${raw.length}`)
    })
    files.set(name, { name, slices })
  }
  return files
}

/** 解析 RPA-2.0 / RPA-3.0 归档；返回文件索引（含异或脱混淆后的切片）。 */
export function parseRpaArchive(buffer: Uint8Array): RpaArchive {
  if (buffer.length < 24) throw new Error(`RPA 文件过短（${buffer.length} 字节）`)
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, 8))

  if (head === 'RPA-3.0 ') {
    if (buffer.length < 40) throw new Error('RPA-3.0 头不足 40 字节')
    const l = buffer.subarray(0, 40)
    const offset = Number.parseInt(new TextDecoder('latin1').decode(l.subarray(8, 24)), 16)
    const key = Number.parseInt(new TextDecoder('latin1').decode(l.subarray(25, 33)), 16)
    if (Number.isNaN(offset) || offset <= 0 || offset >= buffer.length) {
      throw new Error(`RPA-3.0 索引偏移异常：${offset}`)
    }
    const indexPickle = inflateSync(buffer.subarray(offset))
    const index = decodePickle(new Uint8Array(indexPickle))
    return { version: 3, key, files: normalizeIndex(index, key), buffer }
  }

  if (head === 'RPA-2.0 ') {
    const l = buffer.subarray(0, 24)
    const offset = Number.parseInt(new TextDecoder('latin1').decode(l.subarray(8, 24)), 16)
    if (Number.isNaN(offset) || offset <= 0 || offset >= buffer.length) {
      throw new Error(`RPA-2.0 索引偏移异常：${offset}`)
    }
    const indexPickle = inflateSync(buffer.subarray(offset))
    const index = decodePickle(new Uint8Array(indexPickle))
    return { version: 2, key: 0, files: normalizeIndex(index, 0), buffer }
  }

  throw new Error(`不支持的 RPA 头：${head}`)
}

/** 归档内全部文件名。 */
export function listRpaFiles(archive: RpaArchive): string[] {
  return [...archive.files.keys()]
}

/** 按名读取一个文件（多段切片拼接为原始字节）；不存在返回 undefined。 */
export function readRpaFile(archive: RpaArchive, name: string): Uint8Array | undefined {
  const entry = archive.files.get(name)
  if (!entry) return undefined
  const total = entry.slices.reduce((n, s) => n + s.dlen, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const s of entry.slices) {
    const end = Math.min(s.offset + s.dlen, archive.buffer.length)
    if (s.offset >= end) continue
    out.set(archive.buffer.subarray(s.offset, end), pos)
    pos += end - s.offset
  }
  return out
}

// ---------------------------------------------------------------------------
// 解包到磁盘（prepare 链路替换 `python -m tav2 prepare` 解包步骤的前置能力）
// ---------------------------------------------------------------------------

export interface UnpackRpaOptions {
  /** 只解包匹配该正则的条目名；缺省解包全部。 */
  include?: RegExp
}

/** 无符号 32 位 XOR（JS 的 ^ 是有符号 int32，会因符号位错误地负化 ≥2^31 的值）。 */
function xorUint32(a: number, b: number): number {
  return ((a >>> 0) ^ (b >>> 0)) >>> 0
}

/**
 * 把归档内条目按内部路径解包到 destDir 下。
 * 返回写入的内部路径清单；对越界路径（../、绝对路径）fail-closed 拒绝。
 */
export function unpackRpaScripts(
  archive: RpaArchive,
  destDir: string,
  opts: UnpackRpaOptions = {},
): string[] {
  const root = resolve(destDir)
  const written: string[] = []
  for (const name of listRpaFiles(archive)) {
    if (opts.include && !opts.include.test(name)) continue
    const target = resolve(root, name)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`RPA 条目路径越界：${name}`)
    }
    const content = readRpaFile(archive, name)
    if (content === undefined) throw new Error(`RPA 条目缺失：${name}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written.push(name)
  }
  return written
}

// ---------------------------------------------------------------------------
// M4（打包·写）：RPA-3.0 写入器 + 协议 2 pickle 编码器
// ---------------------------------------------------------------------------

export interface WriteRpaOptions {
  /** 归档异或 key；缺省 0xDEADBEEF（与 scripts/renpy_pack_rpa.py 一致）。 */
  key?: number
}

/** 协议 2 整数编码：边界与 CPython 的 save_int 一致（BININT1/BININT2/BININT/LONG1）。 */
function pickleInt(v: number): Uint8Array {
  if (v >= 0 && v <= 0xff) return new Uint8Array([0x4b, v]) // BININT1
  if (v >= 0 && v <= 0xffff) {
    return new Uint8Array([0x4d, v & 0xff, (v >> 8) & 0xff]) // BININT2
  }
  if (v >= -0x80000000 && v <= 0x7fffffff) {
    const u = v >>> 0
    return new Uint8Array([0x4a, u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff]) // BININT
  }
  return pickleLong1(v)
}

/** LONG1：n 字节小端 + 二进制补码符号字节（与 CPython save_long 一致）。 */
function pickleLong1(v: number): Uint8Array {
  const neg = v < 0
  const abs = neg ? -v : v
  const bitLen = abs === 0 ? 0 : Math.floor(Math.log2(abs)) + 1
  const nbytes = Math.max(1, (bitLen >> 3) + 1)
  const out = new Uint8Array(nbytes + 2)
  out[0] = 0x8a // LONG1
  out[1] = nbytes
  let value = neg ? v + 2 ** (8 * nbytes) : v
  for (let i = 0; i < nbytes; i++) {
    out[2 + i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return out
}

function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

/**
 * 协议 2 索引 pickle：{"name": [(offset^key, dlen^key)], ...}
 * 结构逐字节对齐 CPython pickle.dumps(protocol=2)（dict/BINPUT/MARK/
 * BINUNICODE/EMPTY_LIST/TUPLE2/APPEND/SETITEMS/STOP）。
 */
function encodeIndexPickle(
  entries: Array<{ name: string; offset: number; dlen: number }>,
  key: number,
): Uint8Array {
  const enc = new TextEncoder()
  const out: number[] = []
  const push = (b: number[] | Uint8Array) => { for (const x of b) out.push(x) }
  push([0x80, 0x02]) // PROTO 2
  push([0x7d, 0x71, 0x00]) // EMPTY_DICT + BINPUT 0
  push([0x28]) // MARK
  let memo = 1
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    push([0x58, ...le32(nameBytes.length)]) // BINUNICODE
    push(nameBytes)
    push([0x71, memo++]) // BINPUT（name）
    push([0x5d, 0x71, memo++]) // EMPTY_LIST + BINPUT
    push(pickleInt(xorUint32(e.offset, key)))
    push(pickleInt(xorUint32(e.dlen, key)))
    push([0x86, 0x71, memo++]) // TUPLE2 + BINPUT
    push([0x61]) // APPEND
  }
  push([0x75, 0x2e]) // SETITEMS + STOP
  return new Uint8Array(out)
}

/**
 * 写入 RPA-3.0 归档：头（34 字节）+ 文件原始字节 + zlib(pickle 索引)。
 * 产物可被本仓库 parseRpaArchive 读取，也可被 Python pickle.loads 与
 * Ren'Py loader 读取（字节级兼容 CPython）。
 */
export function writeRpaArchive(
  files: Map<string, Uint8Array>,
  opts: WriteRpaOptions = {},
): Uint8Array {
  const key = opts.key ?? 0xdeadbeef
  const entries: Array<{ name: string; offset: number; dlen: number }> = []
  let offset = 34 // RPA-3.0 头长度
  for (const [name, content] of files) {
    entries.push({ name, offset, dlen: content.length })
    offset += content.length
  }
  const indexBytes = new Uint8Array(deflateSync(encodeIndexPickle(entries, key)))
  const header = `RPA-3.0 ${offset.toString(16).padStart(16, '0')} ${key.toString(16).padStart(8, '0')}\n`
  const headerBytes = new TextEncoder().encode(header)
  if (headerBytes.length !== 34) throw new Error(`RPA-3.0 头长度异常：${headerBytes.length}`)

  const out = new Uint8Array(headerBytes.length + (offset - 34) + indexBytes.length)
  let p = 0
  out.set(headerBytes, p)
  p += headerBytes.length
  for (const e of entries) {
    out.set(files.get(e.name)!, p)
    p += e.dlen
  }
  out.set(indexBytes, p)
  return out
}
