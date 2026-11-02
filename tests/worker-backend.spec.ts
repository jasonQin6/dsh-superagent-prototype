/**
 * ZCode 进程后端的契约：argv 首跑/续跑两形态、NDJSON 的增量解析与未知行原文保留、最后一行 result 的抽取，
 * 以及超时与 stop。subprocess 一律用本文件底部的自造 fake，不 import 私有 fixture，也不启动真实二进制。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { buildZcodeArgv, runZcodeRun } from '../src/executor/zcode-backend.ts'

/** 等过若干轮询拍，让先写入的片段确实走一次增量 readFrom。 */
const wait = (ms = 30): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

describe('buildZcodeArgv', () => {
  it('lays out a first run exactly as the contract names it, expanding the default command\'s ~', () => {
    expect(buildZcodeArgv({ brief: 'do it', cwd: '/repo' })).toEqual([
      join(homedir(), '.local/bin/zcode-wrapper'), '-p', 'do it', '--cwd', '/repo', '--mode', 'yolo',
      '--disallowed-tools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', '--output-format', 'stream-json', '--no-color',
    ])
  })
  it('inserts --resume before -p on a resume and lets the caller replace the command', () => {
    expect(buildZcodeArgv({ brief: 'continue', cwd: '/repo', resume: 'sess_9', command: '/opt/zcode' })).toEqual([
      '/opt/zcode', '--resume', 'sess_9', '-p', 'continue', '--cwd', '/repo', '--mode', 'yolo',
      '--disallowed-tools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', '--output-format', 'stream-json', '--no-color',
    ])
  })
})

describe('runZcodeRun', () => {
  const argv = ['zc', '-p', 'x']
  it('spawns through the injected subprocess with a wide stdout, a small stderr and one lifetime signal', async () => {
    const fake = fakeSubprocess()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 1000 })
    const spec = fake.spawns[0]!.spec
    expect(spec.argv).toEqual(argv)
    expect(spec.cwd).toBe('/repo')
    expect(spec.stdio.stdin).toBe('ignore')
    expect(spec.stdio.stdout.maxBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(spec.stdio.stderr.maxBytes).toBe(64 * 1024)
    expect(spec.graceMs).toBeGreaterThan(0)
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    run.stop()
    await run.done
  })
  it('parses the stream incrementally, keeps every line it does not consume verbatim, and reads the last result event', async () => {
    const fake = fakeSubprocess()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 5000 })
    await wait()
    // 真机流里 result 之前全是这类未知事件与 hook 噪声；字段名按真机样例（sessionId/response 驼峰）。
    const noise = JSON.stringify({ eventId: 'e1', payload: {}, seq: 1, sessionId: 'sess_x', timestamp: 1793645411795, traceId: 't1', turnId: 'u1', type: 'session.updated' })
    fake.spawns[0]!.write(`${noise}\n{"type":"model.streaming","payload":{"text":"hi"}}\n`)
    await wait()
    // 写 result 与结算之间不留 await：轮询拍插不进来，这行只能被 done 之后的收尾读看到。
    const result = JSON.stringify({ type: 'result', sessionId: 'sess_1ec2', traceId: 't1', turnId: 'u1', response: 'OK', usage: {}, eventCount: 3, projection: { status: 'idle' } })
    fake.spawns[0]!.write(`${result}\n`)
    fake.spawns[0]!.settle({ exitCode: 0, signal: null })
    const outcome = await run.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.sessionId).toBe('sess_1ec2')
    expect(outcome.resultText).toBe('OK')
    expect(outcome.lines).toEqual([{ raw: noise }, { raw: '{"type":"model.streaming","payload":{"text":"hi"}}' }, JSON.parse(result)])
  })
  it('keeps a broken line as { raw } and survives a result event without the fields it reads', async () => {
    const fake = fakeSubprocess()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 5000 })
    await wait()
    fake.spawns[0]!.write('this is not json\n{"type":"result"}\n')
    fake.spawns[0]!.settle({ exitCode: 0, signal: null })
    const outcome = await run.done
    expect(outcome.lines).toEqual([{ raw: 'this is not json' }, { type: 'result' }])
    expect(outcome.sessionId).toBeUndefined()
    expect(outcome.resultText).toBe('')
  })
  it('reports the last result event when a run emitted more than one', async () => {
    const fake = fakeSubprocess()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 5000 })
    await wait()
    fake.spawns[0]!.write('{"type":"result","sessionId":"sess_old","response":"stale"}\n{"type":"result","sessionId":"sess_new","response":"fresh"}\n')
    fake.spawns[0]!.settle({ exitCode: 0, signal: null })
    const outcome = await run.done
    expect(outcome.sessionId).toBe('sess_new')
    expect(outcome.resultText).toBe('fresh')
    expect(outcome.lines).toEqual([
      { type: 'result', sessionId: 'sess_old', response: 'stale' },
      { type: 'result', sessionId: 'sess_new', response: 'fresh' },
    ])
  })
  it('aborts at the deadline, reporting timedOut with a null exit code', async () => {
    const fake = fakeSubprocess()
    const outcome = await runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 30 }).done
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBeNull()
    expect(outcome.sessionId).toBeUndefined()
    expect(outcome.resultText).toBe('')
  })
  it('does not call an external abort a timeout', async () => {
    const fake = fakeSubprocess()
    const controller = new AbortController()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: controller.signal, timeoutMs: 60_000 })
    controller.abort()
    const outcome = await run.done
    expect(outcome.timedOut).toBe(false)
    expect(outcome.exitCode).toBeNull()
  })
  it('stops idempotently and settles done as stopped', async () => {
    const fake = fakeSubprocess()
    const run = runZcodeRun(fake.runtime, { argv, cwd: '/repo', signal: new AbortController().signal, timeoutMs: 60_000 })
    run.stop()
    run.stop()
    const outcome = await run.done
    expect(fake.spawns[0]!.terminate).toHaveBeenCalledTimes(1)
    expect(outcome.exitCode).toBeNull()
    expect(outcome.timedOut).toBe(false)
    run.stop()
    expect(fake.spawns[0]!.terminate).toHaveBeenCalledTimes(1)
  })
})

interface FakeSpec {
  argv: readonly string[]
  cwd: string
  graceMs: number
  signal?: AbortSignal
  stdio: { stdin: 'ignore', stdout: { maxBytes: number }, stderr: { maxBytes: number } }
}
interface FakeOutcome { exitCode: number | null, signal: string | null }

/**
 * 自造最小 fake subprocess（协议形状与真 collected stdout 相同：readFrom(offset) 返回
 * { text, nextOffset, lossy }）。spec.signal 一旦中止或 fake 的 terminate 被调用，done 就以
 * "被停"结算；输出与退出由测试用 write/settle 手动驱动。
 */
function fakeSubprocess() {
  const spawns: { spec: FakeSpec, write(chunk: string): void, settle(outcome: FakeOutcome): void, terminate: Mock<() => void> }[] = []
  const spawn = vi.fn((spec: FakeSpec) => {
    let text = ''
    let resolve!: (outcome: FakeOutcome) => void
    const done = new Promise<FakeOutcome>(res => { resolve = res })
    spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
    const terminate: Mock<() => void> = vi.fn(() => resolve({ exitCode: null, signal: 'SIGTERM' }))
    spawns.push({ spec, write: chunk => { text += chunk }, settle: resolve, terminate })
    return {
      done, terminate,
      collected: {
        stdout: { readFrom: (offset: number) => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }
  })
  return { runtime: { spawn } as unknown as SubprocessRuntime, spawns }
}
