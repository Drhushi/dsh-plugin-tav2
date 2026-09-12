/**
 * tav2kit doctor：环境自检（node / python / tav2 后端 / 项目 config.yaml / 密钥 env）。
 * 只做存在性与连通性检查，不执行翻译；供 agent 与人工在任意目录快速定位环境问题。
 * 检查结果返回给调用方渲染（人读 / --json），python 探测可注入（测试离线）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginVersion } from '../version'
import { resolvePythonRepo } from '../core/tav2'
import { loadRaw } from './config'

export interface DoctorCheck {
  name: string
  ok: boolean
  note?: string
  /** 可选项失败不影响总评（如项目、密钥 env——脱离项目/免鉴权场景合法）。 */
  optional?: boolean
}

export interface DoctorProbe {
  /** Python 可执行探测：返回版本描述或 undefined（不可用）。测试注入用。 */
  python?: (python: string) => Promise<string | undefined>
}

function defaultPythonProbe(python: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | undefined) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const child = spawn(python, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.stderr?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      const timer = setTimeout(() => {
        child.kill()
        done(undefined)
      }, 10_000)
      child.on('error', () => {
        clearTimeout(timer)
        done(undefined)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        done(code === 0 ? out.trim() : undefined)
      })
    } catch {
      done(undefined)
    }
  })
}

/** Node 版本是否满足 engines 要求（>=22.19.0）。 */
function nodeVersionOk(): boolean {
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj === undefined || min === undefined) return false
  return maj > 22 || (maj === 22 && min >= 19)
}

export async function runDoctor(
  opts: { python: string; projectDir: string; hasProjectConfig: boolean },
  deps: DoctorProbe = {},
): Promise<DoctorCheck[]> {
  const pythonProbe = deps.python ?? defaultPythonProbe
  const checks: DoctorCheck[] = []

  checks.push({
    name: 'tav2kit 版本',
    ok: true,
    note: pluginVersion(),
  })

  const nodeOk = nodeVersionOk()
  checks.push({
    name: 'Node 版本（要求 >=22.19.0）',
    ok: nodeOk,
    note: `当前 ${process.versions.node}`,
  })

  const pythonVer = await pythonProbe(opts.python)
  checks.push({
    name: `Python 可执行（${opts.python}）`,
    ok: pythonVer !== undefined,
    note: pythonVer ?? '未找到或不可执行',
  })

  const repo = resolvePythonRepo({ pythonRepo: '' })
  checks.push({
    name: 'tav2 Python 后端（prepare/rpa 链路前置）',
    ok: repo !== '' && existsSync(repo),
    note: repo || '未找到内置 python/，也未配置 TAV2_PYTHON_REPO',
  })

  checks.push({
    name: '项目 config.yaml（status/check/verify/report/fingerprint 需要）',
    ok: opts.hasProjectConfig,
    optional: true,
    note: opts.hasProjectConfig ? opts.projectDir : `未找到（${opts.projectDir}）；detect/skill/doctor/version 可脱离项目使用`,
  })

  const keySet = Boolean(process.env.TRANSLATE_API_KEY?.trim())
  checks.push({
    name: '翻译密钥 env TRANSLATE_API_KEY',
    ok: true,
    optional: true,
    note: keySet ? '已设置' : '未设置（本地模型免鉴权可忽略；专用渠道需要时再配）',
  })

  // LLM 直连渠道就绪度（CLI 侧唯一渠道来源 = config.yaml translationApi；密钥走 apiKeyEnv env）。
  if (opts.hasProjectConfig) {
    const raw = loadRaw(join(opts.projectDir, 'config.yaml'))
    const api = raw?.translationApi
    const str = (k: string): string | undefined => {
      const v = api && typeof api === 'object' && !Array.isArray(api) ? (api as Record<string, unknown>)[k] : undefined
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }
    const baseUrl = str('baseUrl')
    const apiKeyEnv = str('apiKeyEnv')
    const keyReady = apiKeyEnv === undefined || Boolean(process.env[apiKeyEnv]?.trim())
    checks.push({
      name: '翻译渠道（config.yaml translationApi）',
      ok: Boolean(baseUrl) && keyReady,
      optional: true,
      note: baseUrl
        ? `${baseUrl}${apiKeyEnv !== undefined ? `（密钥 env ${apiKeyEnv}${keyReady ? ' 已设置' : ' 未设置'}）` : '（免鉴权）'}`
        : '未配置：tav2kit config set translationApi.baseUrl <接口地址> [--model <模型>]（本地免鉴权可留空 apiKeyEnv）',
    })
  }

  return checks
}
