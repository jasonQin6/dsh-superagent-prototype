/**
 * ZCode 进程后端：把一次 ZCode CLI run 当作一条 NDJSON 流跑完。argv 契约在这里定死；subprocess 由调用方
 * 注入（ctx.subprocess），本模块不认识 Engine，也不启动真实二进制。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** 默认命令是操作员本地的 wrapper；不经 shell 启动，所以 ~ 必须在这里展开。 */
export const DEFAULT_ZCODE_COMMAND = '~/.local/bin/zcode-wrapper'
/** stdout 收集上限：一次 run 的流里带大量工具输出，常规 1MB 会把头部挤掉。 */
const STDOUT_MAX_BYTES = 8 << 20
const STDERR_MAX_BYTES = 1 << 16
/** 轮询间隔只影响中间输出的可见延迟；done 之后还有一次收尾读兜底。 */
const POLL_MS = 10
/** 与 runAsWorker 一致的宽限，让 provider 在进程退出后排干管道。 */
const GRACE_MS = 2000

export interface ZcodeArgvOptions { brief: string, cwd: string, resume?: string, command?: string }

const expandTilde = (command: string): string =>
  command === '~' || command.startsWith('~/') ? join(homedir(), command.slice(1)) : command

/** 首跑与续跑只差一段：resume 把 `--resume <id>` 插在 `-p` 之前，其余契约逐项固定。 */
export function buildZcodeArgv({ brief, cwd, resume, command = DEFAULT_ZCODE_COMMAND }: ZcodeArgvOptions): string[] {
  return [expandTilde(command), ...(resume ? ['--resume', resume] : []), '-p', brief, '--cwd', cwd, '--mode', 'yolo',
    '--disallowed-tools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', '--output-format', 'stream-json', '--no-color']
}

/** 解析成功保留的事件对象：本模块只消费 result 行，其余事件按原文进 { raw }。 */
export interface ZcodeResultEvent { type: 'result', [key: string]: unknown }
/** 一行流输出：result 事件对象，或任何别的行（未知事件、hook 噪声、坏行）的原样文本。 */
export type ZcodeLine = ZcodeResultEvent | { raw: string }

export interface ZcodeRunResult {
  exitCode: number | null
  /** 到点超时：deadline 触发而外部生命周期 signal 未触发。 */
  timedOut: boolean
  /** 最后一行 result 事件的会话 id，供 --resume；取不到为 undefined。 */
  sessionId?: string
  /** 最后一行 result 事件的 response 文本；取不到为空串。 */
  resultText: string
  lines: ZcodeLine[]
}

export interface ZcodeRunOptions { argv: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number }
export interface ZcodeRunHandle { done: Promise<ZcodeRunResult>, stop(): void }

/** 只把 result 行留成对象；解析失败不抛，坏行与流噪声一起按原文保留。 */
const parseLine = (text: string): ZcodeLine => {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === 'result') return value as ZcodeResultEvent
  } catch { /* 坏行按原文保留。 */ }
  return { raw: text }
}

/** 最后一行 result 事件的会话与文本；字段缺失或形状未知时给 undefined/空串，不抛。 */
const lastResult = (lines: readonly ZcodeLine[]): { sessionId?: string, resultText: string } => {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line || 'raw' in line) continue
    return {
      sessionId: typeof line.sessionId === 'string' ? line.sessionId : undefined,
      resultText: typeof line.response === 'string' ? line.response : '',
    }
  }
  return { sessionId: undefined, resultText: '' }
}

/**
 * 启动一次 run：外部 signal 与超时 deadline 合成一个生命周期 signal 交给 spawn，到点由 provider 的终止流程收场；
 * 期间以小间隔增量读 stdout，done 之后再多读一次收尾，因为 provider 退出后才排干管道。
 */
export function runZcodeRun(subprocess: SubprocessRuntime, { argv, cwd, signal, timeoutMs }: ZcodeRunOptions): ZcodeRunHandle {
  // deadline 必须是独立的第二个信号：结束时靠"谁触发"区分超时与外部中止。
  const deadline = AbortSignal.timeout(timeoutMs)
  let timedOut = false
  deadline.addEventListener('abort', () => { if (!signal.aborted) timedOut = true }, { once: true })
  const lifetime = AbortSignal.any([signal, deadline])
  const handle = subprocess.spawn({
    argv, cwd, graceMs: GRACE_MS, signal: lifetime,
    stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
  })
  const lines: ZcodeLine[] = []
  let offset = 0
  let tail = ''
  const poll = (): void => {
    const read = handle.collected.stdout?.readFrom(offset)
    if (!read?.text) return
    offset = read.nextOffset
    tail += read.text
    for (let at = tail.indexOf('\n'); at >= 0; at = tail.indexOf('\n')) {
      lines.push(parseLine(tail.slice(0, at)))
      tail = tail.slice(at + 1)
    }
  }
  const timer = setInterval(poll, POLL_MS)
  timer.unref?.()
  // provider 失败时主 done 拒绝给调用方；这个分支只负责别把轮询留着。
  handle.done.catch(() => { clearInterval(timer) })
  const done = handle.done.then(outcome => {
    clearInterval(timer)
    poll()
    // 没有换行结尾的残余也算一行；坏行会以 { raw } 兜住。
    if (tail) lines.push(parseLine(tail))
    return { exitCode: outcome.exitCode, timedOut, ...lastResult(lines), lines }
  })
  // terminate 是 seam 的唯一终止动词且本身幂等；再守一层，让 stop 可重复调用而终止只发生一次。
  let stopped = false
  return { done, stop: () => { if (stopped) return; stopped = true; handle.terminate() } }
}
