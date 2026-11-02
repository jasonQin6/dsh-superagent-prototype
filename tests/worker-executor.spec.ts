/**
 * ZcodeExecutor 的端口级测试：进程一律走本文件底部的自造 fake subprocess（形状与 worker-backend.spec.ts 的相同），
 * Engine 用录音 fake，不跑真实 zcode。锁定 start 的回调序与失败路、deliver 的续跑与 blocked 两路、stop 不再 report，
 * 以及全局并发上限（第 maxWorkers+1 个 start 排队，空位后开跑）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { ZcodeExecutor, type ZcodeHost } from '../src/executor/zcode.ts'

/** 等过若干轮询拍，让异步派发路径（fs、prepare、轮询读）有时间收敛。 */
const wait = (ms = 20): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
/** 轮询直到条件成立或超时；超时后仍断言一次，让失败停在条件本身而不是静默通过。 */
const eventually = async (holds: () => boolean): Promise<void> => {
  for (let rounds = 0; rounds < 500 && !holds(); rounds++) await wait(10)
  expect(holds()).toBe(true)
}
/** 未投递输入之外的首发 RESULT 块：status ready，回复末尾按六行键序。 */
const readyText = ['RESULT', 'status: ready', 'summary: it is done', 'branch: wt-main', 'head: abc1234', 'pr: none', 'next: none'].join('\n')
/** 真机流末尾的 result 行形状：sessionId/response 驼峰，其余字段与本执行器无关。 */
const resultLine = (sessionId: string, response: string): string =>
  JSON.stringify({ type: 'result', sessionId, traceId: 'tr', turnId: 'tu', response, usage: {}, eventCount: 3, projection: { status: 'idle' } })
/** Executor 的 settings：zcode 命令取 `zc-fake`，便于在 fake subprocess 里按 argv[0] 区分 zcode run 与 prepare/verify 的 spawn。 */
const settings = (executor: Record<string, unknown> = {}): Settings =>
  SettingsSchema.parse({ executor: { maxWorkers: 3, prepare: '', zcode: { command: 'zc-fake', timeoutMs: 60_000 }, ...executor } })
/** 一张最小 Ticket：assignment 默认 pending，execution 指向临时目录，便于真实走 prepareDirectory 的 fs 路径。 */
const ticket = (id: string, assignment: Partial<Assignment> = {}, extra: Partial<Ticket> = {}): Ticket => ({
  id, title: `ticket ${id}`, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: 'test', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'test', id: 'op' }, scope: 'test' },
  channels: [], assignments: [{ id: `a-${id}`, state: 'pending', createdAt: '2026-01-01T00:00:00Z', ...assignment }],
  inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  origin: { triggerId: `t-${id}`, triggerIds: [`t-${id}`] },
  execution: { name: `n-${id}`, directory: join(tmpdir(), 'zcode-executor-spec', id), assignment: 'do the thing' },
  ...extra,
})
/** fake subprocess 里的一次 spawn：spec 可断言，输出与退出由测试用 write/settle 手动驱动。 */
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
 * { text, nextOffset, lossy }）。spec.signal 一旦中止或 terminate 被调用，done 就以"被停"结算。
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

/** 录音 fake engine 的回调记录。 */
interface Recorded { call: string, args: unknown[] }

/** 一套端口级 harness：fake subprocess + 录音 engine + 手工 store，装配出被测的 ZcodeExecutor。 */
function harness(options: { settings?: Settings, tickets?: Ticket[], lifetime?: AbortSignal, stateful?: boolean } = {}) {
  const log: Recorded[] = []
  const record = (call: string) => (...args: unknown[]) => { log.push({ call, args }) }
  const store = {
    settings: () => options.settings ?? settings(),
    atomic: (work: () => unknown) => work(),
    tickets: { get: (id: string) => options.tickets?.find(ticket => ticket.id === id) },
    triggers: { get: () => undefined },
  }
  const engine = {
    assignmentStarted: record('assignmentStarted'),
    inputsDelivered: record('inputsDelivered'),
    inputsRead: record('inputsRead'),
    turnEnded: record('turnEnded'),
    report: record('report'),
  }
  // 真 Engine 的 assignmentStarted 会把 assignment 置为 running（assignments.ts 的领域语义）；
  // 录音 fake 默认不做，stateful 模式模拟这一翻转，否则 finish 路径的回归会被录音 fake 掩盖。
  if (options.stateful) {
    const recorded = engine.assignmentStarted
    engine.assignmentStarted = (...args: unknown[]) => {
      const [ticketId, assignmentId] = args as [string, string]
      const started = options.tickets?.find(ticket => ticket.id === ticketId)?.assignments.find(assignment => assignment.id === assignmentId)
      if (started) started.state = 'running'
      recorded(...args)
    }
  }
  const fake = fakeSubprocess()
  const host = {
    // host.context 的契约是 Pick<Context, 'subprocess'>：subprocess 才是 SubprocessRuntime。
    context: { subprocess: fake.runtime }, engine, store,
    machine: { stateDir: join(tmpdir(), 'zcode-executor-spec-state') },
    lifetime: options.lifetime ?? new AbortController().signal,
    environment: () => [],
  } as unknown as ZcodeHost
  return { executor: new ZcodeExecutor(host), log, fake }
}
/** fake 里 argv[0] 为 zcode 命令的 spawn，即真正的 zcode run（prepare/verify 的 spawn 是 git/sh）。 */
const zcodeRuns = (fake: ReturnType<typeof fakeSubprocess>) => fake.spawns.filter(spawn => spawn.spec.argv[0] === 'zc-fake')

describe('ZcodeExecutor.start', () => {
  it('runs a start through prepare and reports ready, in the order assignmentStarted, turnEnded, report', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t] })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    // prepare 的目录校验（git config）无匹配键时以退出码 1 结束，verifyDirectory 把它当通过。
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const run = zcodeRuns(fake)[0]!
    expect(run.spec.cwd).toBe(t.execution!.directory)
    run.write(`${resultLine('sess_1', readyText)}\n`)
    run.settle({ exitCode: 0, signal: null })
    await eventually(() => log.length >= 3)
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted', 'turnEnded', 'report'])
    expect(log[2]!.args).toEqual([t.id, { state: 'ready', summary: 'summary: it is done\nbranch: wt-main\nhead: abc1234' }])
  })
  it('reports through a stateful engine that has flipped the assignment to running (regression)', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t], stateful: true })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const run = zcodeRuns(fake)[0]!
    run.write(`${resultLine('sess_1', readyText)}\n`)
    run.settle({ exitCode: 0, signal: null })
    await eventually(() => log.length >= 3)
    // assignmentStarted 之后 assignment 已是 running：finish 不得再要求 pending 才上报。
    expect(t.assignments[0]!.state).toBe('running')
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted', 'turnEnded', 'report'])
    expect(log[2]!.args[1]).toMatchObject({ state: 'ready' })
  })
  it('marks the ticket failed without retrying when the prepare command fails', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ settings: settings({ prepare: 'exit 1' }), tickets: [t] })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => log.length >= 1)
    expect(log.map(entry => entry.call)).toEqual(['report'])
    expect(log[0]!.args[1]).toMatchObject({ state: 'failed' })
    expect(String((log[0]!.args[1] as { summary: string }).summary)).toContain('prepare')
    // PrepareFailed 不重试：除了那一次 prepare 命令，没有再发起任何 spawn。
    expect(fake.spawns.length).toBe(1)
  })
  it('marks the ticket failed when the worker exits cleanly but its reply has no RESULT block', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t] })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const run = zcodeRuns(fake)[0]!
    run.write(`${resultLine('sess_1', 'I did the work but forgot the block.')}\n`)
    run.settle({ exitCode: 0, signal: null })
    await eventually(() => log.length >= 3)
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted', 'turnEnded', 'report'])
    expect(log[2]!.args[1]).toMatchObject({ state: 'failed' })
    expect(String((log[2]!.args[1] as { summary: string }).summary)).toContain('RESULT')
  })
  it('marks the ticket failed when the run hits its deadline', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ settings: settings({ zcode: { command: 'zc-fake', timeoutMs: 30 } }), tickets: [t] })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    // 不 settle：等 deadline 自己到点，由生命周期信号把 run 结算成超时。
    await eventually(() => log.length >= 3)
    expect(log[2]!.args[1]).toMatchObject({ state: 'failed' })
    expect(String((log[2]!.args[1] as { summary: string }).summary)).toContain('超时')
  })
  it('honors the concurrency limit: the (maxWorkers+1)-th start queues and launches once a slot frees', async () => {
    const tickets = [ticket('t1'), ticket('t2'), ticket('t3')]
    const { executor, log, fake } = harness({ settings: settings({ maxWorkers: 2 }), tickets })
    for (const t of tickets) executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 2)
    // 前两个 start 各自先走 prepare 的目录校验；第三个 start 还没排队到 spawn。
    for (const spawn of fake.spawns) spawn.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 2)
    expect(fake.spawns.length).toBe(4)
    // 第一个 run 结束后空出位，第三个 start 才开跑。
    const first = zcodeRuns(fake)[0]!
    first.write(`${resultLine('sess_1', readyText)}\n`)
    first.settle({ exitCode: 0, signal: null })
    await eventually(() => fake.spawns.length === 5)
    fake.spawns[4]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 3)
    expect(log.filter(entry => entry.call === 'assignmentStarted').length).toBe(3)
  })
})

describe('ZcodeExecutor.deliver', () => {
  it('resumes the recorded session with the undelivered inputs, then reads them and reports', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t] })
    // 先走一遍首发，让 executor 记下 zcode 会话 id。
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const first = zcodeRuns(fake)[0]!
    first.write(`${resultLine('sess_1', readyText)}\n`)
    first.settle({ exitCode: 0, signal: null })
    await eventually(() => log.length >= 3)
    // 首发结束后来了未投递输入：deliver 以 --resume 续跑，文本是未投递 Inputs 的拼接。
    t.assignments[0]!.state = 'running'
    t.inputs.push({ id: 'i1', kind: 'text', text: 'also do X', at: '2026-01-01T01:00:00Z' })
    t.undelivered.push('i1')
    executor.deliver(t, t.assignments[0]!)
    await eventually(() => zcodeRuns(fake).length === 2)
    const resume = zcodeRuns(fake)[1]!
    expect(resume.spec.argv.indexOf('--resume')).toBeGreaterThan(0)
    expect(resume.spec.argv[resume.spec.argv.indexOf('--resume') + 1]).toBe('sess_1')
    expect(resume.spec.argv[resume.spec.argv.indexOf('-p') + 1]).toContain('also do X')
    expect(log.some(entry => entry.call === 'inputsDelivered' && JSON.stringify(entry.args[2]) === '["i1"]')).toBe(true)
    resume.write(`${resultLine('sess_1', readyText)}\n`)
    resume.settle({ exitCode: 0, signal: null })
    await eventually(() => log.length >= 6)
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted', 'turnEnded', 'report', 'inputsDelivered', 'inputsRead', 'report'])
    expect(log[4]!.args).toEqual([t.id, ['i1']])
    expect(log[5]!.args[1]).toMatchObject({ state: 'ready' })
  })
  it('reports blocked with the reason in the summary when no session exists to resume', async () => {
    const t = ticket('t1', { state: 'running' }, { undelivered: ['i1'], inputs: [{ id: 'i1', kind: 'text', text: 'also do X', at: '2026-01-01T01:00:00Z' }] })
    const { executor, log, fake } = harness({ tickets: [t] })
    executor.deliver(t, t.assignments[0]!)
    await eventually(() => log.length >= 1)
    expect(log.map(entry => entry.call)).toEqual(['report'])
    expect(log[0]!.args[1]).toMatchObject({ state: 'blocked' })
    // 原因写进 summary：这里必须是会话缺失，而不是别的 blocked 理由。
    expect(String((log[0]!.args[1] as { summary: string }).summary)).toContain('会话')
    // 做不到就不发起任何进程，也不走 deliveryFailed。
    expect(fake.spawns.length).toBe(0)
  })
})

describe('ZcodeExecutor.stop', () => {
  it('aborts the in-flight run and never reports for it afterwards', async () => {
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t] })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const run = zcodeRuns(fake)[0]!
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted'])
    executor.stop(t, t.assignments[0]!, 'stopped by a person')
    expect(run.spec.signal?.aborted).toBe(true)
    await wait(60)
    // run 被 abort 结算，但票已停：不再有 turnEnded 与 report。
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted'])
  })
})

describe('ZcodeExecutor lifetime', () => {
  it('aborts the in-flight run when the host stops, and reports the ended run as failed', async () => {
    const controller = new AbortController()
    const t = ticket('t1')
    const { executor, log, fake } = harness({ tickets: [t], lifetime: controller.signal })
    executor.start(t, t.assignments[0]!)
    await eventually(() => fake.spawns.length === 1)
    fake.spawns[0]!.settle({ exitCode: 1, signal: null })
    await eventually(() => zcodeRuns(fake).length === 1)
    const run = zcodeRuns(fake)[0]!
    // run 的 signal 并入了宿主 lifetime：宿主停止也收得走 in-flight run（signal=lifetime 的契约）。
    controller.abort()
    expect(run.spec.signal?.aborted).toBe(true)
    await eventually(() => log.length >= 3)
    expect(log.map(entry => entry.call)).toEqual(['assignmentStarted', 'turnEnded', 'report'])
    expect(log[2]!.args[1]).toMatchObject({ state: 'failed' })
    expect(String((log[2]!.args[1] as { summary: string }).summary)).toContain('被终止')
  })
})
