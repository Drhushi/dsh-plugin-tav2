/** tav2 进程执行结果（与 dsh 无关，便于未来独立复用）。 */
export interface Tav2RunResult {
  /** 命令是否成功完成（exit code 0 且未超时） */
  ok: boolean
  /** 拼接出的命令描述 */
  command: string
  stdout: string
  stderr: string
  /** 进程退出码；超时被杀时为 null */
  code: number | null
  /** 是否超时 */
  timedOut: boolean
  /** 从 stdout 尾部解析出的 JSON 对象（tav2 多数子命令以 JSON 结尾） */
  parsed?: unknown
}

/** 工具返回给模型的规范值。 */
export interface Tav2ToolResult {
  ok: boolean
  command: string
  text: string
  timedOut?: boolean
}

/** 后台任务工具返回的规范值（dsh 运行时负责 job_output/job_list/job_kill）。 */
export interface Tav2JobResult {
  kind: 'background'
  jobId: string
  label: string
}
