/**
 * ZcodeExecutor 的端口级端到端测试：跑真实 zcode 进程（默认 ~/.local/bin/zcode-wrapper），但不跑 Engine/Runtime。
 * 用 ZCODE_E2E 守卫（注意变量必须放在 env -i 之后，前置赋值会被 env -i 清掉：
 * `env -i HOME="$HOME" PATH="$PATH" ZCODE_E2E=1 pnpm vitest run tests/worker-e2e.spec.ts`）：
 * 默认全量测试不跑真进程；真跑一次 zcode 要几十秒到几分钟，所以单个 it 显式设了远大于默认值的 timeout。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Assignment, Ticket, Trigger } from '../src/core/index.ts'
import type { ZcodeHost } from '../src/executor/zcode.ts'
import { ZcodeExecutor } from '../src/executor/zcode.ts'
import { parseResultBlock } from '../src/executor/zcode-report.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'

/** 一次 run 的上限：给足，让正常的一轮（几十秒到几分钟）永远先结束而不是先超时。 */
const RUN_TIMEOUT_MS = 600_000
/** it 的显式 timeout：必须盖过 run 上限，超时的 run 由执行器先报 failed，测试才能给出可读失败而不是 vitest 掐死。 */
const E2E_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000
/** 给 worker 的任务：小而确定，真机 zcode 在 yolo 模式下应能一次完成并按约定收尾。
 * 故意不在这里复述 RESULT 块格式：块约定只来自 buildWorkerBrief 的固定尾部指令，E2E 要证明的就是生产 brief 单独足以让 worker 按约收尾。 */
const ASSIGNMENT = '在当前工作目录创建文件 notes.md，写入一行 "worker was here"，git add 并 commit。这个临时仓库没有远端：不要 push，也不要开 PR。'

/** Promise 化地跑一条外部命令，失败时把 stderr 带进错误；测试文件可以用 child_process，git 设置与取证都走这里。 */
const run = (file: string, args: readonly string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error([`${file} ${args.join(' ')} failed`, String(stderr).trim()].filter(Boolean).join('\n')))
      else resolve(stdout)
    })
  })
const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** 适配器里的一次真实 spawn：argv 留给测试区分 zcode run 与 prepare/verify 的 spawn，text 是收集到的 stdout 原文；
 * 两个时间戳供并发用例证明两次 run 确实重叠，而不是排队跑完。 */
interface RealSpawn { argv: readonly string[], text: string, spawnedAt: number, finishedAt?: number }

/**
 * 最小真实 subprocess 适配器：node:child_process.spawn 实现 seam 协议（{ done, collected.stdout.readFrom(offset),
 * terminate() }）。为什么不 import 可实例化的真实运行时：@deepseek-ai/dsh-subprocess 只导出抽象 SubprocessRuntime
 * （spawn 是 abstract，实例化还需 cordis Context 并按插件装载），本地实现在 @deepseek-ai/dsh-subprocess-local，
 * 不在本仓 node_modules 里——DSH 宿主运行时在 vitest 里不可得，而 E2E 的目的恰是跑真进程。生产代码不得用
 * child_process 的约束只约束 src/，不适用于本测试文件。graceMs 的排干语义简化为直接杀进程树：spawn 用
 * detached:true 建立进程组，terminate 用 process.kill(-pid) 一并收走 zcode-wrapper exec 出来的 node。
 */
function realSubprocess() {
  const spawns: RealSpawn[] = []
  const runtime = {
    spawn: (spec: { argv: readonly string[], cwd: string, signal?: AbortSignal, env?: Record<string, string | undefined> }) => {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd, detached: true,
        // seam 契约：spec.env 显式合并进父环境；prepare 命令靠它拿到 DSH_SUPERAGENT_DIR/NAME。本测试不做凭据擦除。
        env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const entry: RealSpawn = { argv: spec.argv, text: '', spawnedAt: Date.now() }
      spawns.push(entry)
      let stderr = ''
      child.stdout!.on('data', chunk => { entry.text += chunk })
      child.stderr!.on('data', chunk => { stderr += chunk })
      let terminated = false
      const terminate = (): void => {
        if (terminated || child.pid === undefined) return
        terminated = true
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* 进程组已不存在。 */ }
      }
      spec.signal?.addEventListener('abort', terminate, { once: true })
      const done = new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode, signal) => { entry.finishedAt = Date.now(); resolve({ exitCode, signal: signal ?? null }) })
      })
      return {
        done, terminate,
        collected: {
          stdout: { readFrom: (offset: number) => ({ text: entry.text.slice(offset), nextOffset: entry.text.length, lossy: false }) },
          stderr: { readFrom: (offset: number) => ({ text: stderr.slice(offset), nextOffset: stderr.length, lossy: false }) },
        },
      }
    },
  }
  return { runtime: runtime as unknown as SubprocessRuntime, spawns }
}

/** 录音 fake engine 的回调记录（照 worker-executor.spec.ts 的 harness 简化，不需要 stateful 翻转）。 */
interface Recorded { call: string, args: unknown[] }
/** Executor 变量的最小形状：prepareDirectory 只取 key/value。 */
const variable = (key: string, value: string): { key: string, value: string } => ({ key, value })

describe.skipIf(!process.env.ZCODE_E2E)('ZcodeExecutor end-to-end（真实 zcode 进程）', () => {
  /** 每个用例的临时根目录：临时主仓与其 worktree 都在里面，afterAll 整体删除。 */
  const roots: string[] = []
  const tempRoot = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'zcode-e2e-')); roots.push(dir); return dir }

  afterAll(async () => {
    // 主仓连同它名下的 worktree 目录一起删；删不掉（如平台锁）时安静放弃，不遮蔽测试结论。
    for (const dir of roots) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('start 备好 worktree，跑真 zcode，按序回写并产出 ready 报告', { timeout: E2E_TIMEOUT_MS }, async () => {
    // 临时主仓：mkdtemp + git init + 本仓级 user.email/user.name，不依赖操作员的全局 git 配置。
    const root = await tempRoot()
    const mainRepo = join(root, 'repo')
    await run('git', ['init', mainRepo])
    await run('git', ['-C', mainRepo, 'config', 'user.email', 'e2e@example.invalid'])
    await run('git', ['-C', mainRepo, 'config', 'user.name', 'zcode e2e'])
    await writeFile(join(mainRepo, 'README.md'), 'seed\n')
    await run('git', ['-C', mainRepo, 'add', 'README.md'])
    await run('git', ['-C', mainRepo, 'commit', '-m', 'seed'])
    const seedHead = (await run('git', ['-C', mainRepo, 'rev-parse', 'HEAD'])).trim()

    // settings：prepare 用 git worktree 建工作目录，目录与名字来自 host.environment 提供的
    // DSH_SUPERAGENT_DIR/DSH_SUPERAGENT_NAME（变量名与语义见 src/app/execution-environment.ts 的 EXECUTOR_VARIABLES）；
    // zcode.command 用默认 wrapper（真机存在），timeoutMs 给足。executor.kind 与本测试无关：直接构造 ZcodeExecutor。
    const worktree = join(root, 'work', 'e2e-worker')
    const settings: Settings = SettingsSchema.parse({ executor: {
      maxWorkers: 1,
      prepare: `git -C ${mainRepo} worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"`,
      zcode: { command: '~/.local/bin/zcode-wrapper', timeoutMs: RUN_TIMEOUT_MS },
    } })
    const t: Ticket = {
      id: 'e2e-0001-worker', title: 'ticket e2e', decisionId: 'd-e2e',
      mandate: { strength: 'explicit', policyVersion: 'test', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'test', id: 'op' }, scope: 'test' },
      channels: [], assignments: [{ id: 'a-e2e', state: 'pending', createdAt: '2026-01-01T00:00:00Z' } as Assignment],
      inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId: 't-e2e', triggerIds: ['t-e2e'] },
      // 产品路径：explicit 票的 assignment 为空，任务正文只在 origin trigger 上；brief 必须把它带进提示词。
      execution: { name: 'e2e-worker', directory: worktree, assignment: '' },
    }
    const origin = { id: 't-e2e', text: ASSIGNMENT, actor: { source: 'test', id: 'jason' } } as unknown as Trigger
    const log: Recorded[] = []
    const record = (call: string) => (...args: unknown[]) => { log.push({ call, args }) }
    const fake = realSubprocess()
    const host = {
      context: { subprocess: fake.runtime },
      engine: {
        assignmentStarted: record('assignmentStarted'), inputsDelivered: record('inputsDelivered'),
        inputsRead: record('inputsRead'), turnEnded: record('turnEnded'), report: record('report'),
      },
      store: {
        settings: () => settings,
        atomic: (work: () => unknown) => work(),
        tickets: { get: (id: string) => id === t.id ? t : undefined },
        triggers: { get: (id: string) => id === origin.id ? origin : undefined },
      },
      machine: { stateDir: join(root, 'state') },
      lifetime: new AbortController().signal,
      paused: () => false,
      environment: (ticket: Ticket) => [variable('DSH_SUPERAGENT_DIR', ticket.execution?.directory ?? ''),
        variable('DSH_SUPERAGENT_NAME', ticket.execution?.name ?? '')],
    } as unknown as ZcodeHost

    const executor = new ZcodeExecutor(host)
    executor.start(t, t.assignments[0]!)
    // run 由 zcode 自己的 timeoutMs 兜底（超时后执行器会报 failed），这里只需等 report 到来。
    for (let rounds = 0; rounds < E2E_TIMEOUT_MS / 250 && !log.some(entry => entry.call === 'report'); rounds++) await wait(250)

    // 证据：worker 回复原文取自适配器收集的 zcode stdout 的最后 result 行（sessionId/response 驼峰字段）。
    const zcodeRun = fake.spawns.find(spawn => spawn.argv[0]!.endsWith('zcode-wrapper'))
    const resultLine = zcodeRun?.text.split('\n').filter(line => line.trim() !== '').map(line => { try { return JSON.parse(line) as { type?: string, response?: unknown } } catch { return undefined } })
      .filter(value => value?.type === 'result' && typeof value.response === 'string').at(-1)
    const reply = typeof resultLine?.response === 'string' ? resultLine.response : '(stream 里没有 result 行)'
    const calls = log.map(entry => entry.call)
    const report = log.filter(entry => entry.call === 'report').at(-1)?.args[1] as { state: string, summary: string } | undefined
    console.log('[e2e] engine 回调序列:', calls.join(' → '))
    console.log('[e2e] worker 回复（RESULT 块原文）:\n' + reply)
    console.log('[e2e] report:', JSON.stringify(report))
    if (existsSync(worktree)) {
      console.log('[e2e] git -C worktree log --oneline -2:\n' + await run('git', ['-C', worktree, 'log', '--oneline', '-2']))
      console.log('[e2e] git -C worktree show --stat HEAD:\n' + await run('git', ['-C', worktree, 'show', '--stat', 'HEAD']))
    }

    // 断言。报告 state 是 ready 的隐含条件即 run 以退出码 0 干净结束（mapToWorkerReport 只有这条路径产出 ready）；
    // 不是 ready 时把执行器的 summary 与回复原文一起给出，保证模型没按指令做时失败可读。
    const diagnostics = `report=${JSON.stringify(report)}\n回复原文:\n${reply}`
    expect(report, `执行器应产出 ready 报告（ready 隐含 run 以退出码 0 结束）:\n${diagnostics}`).toBeDefined()
    expect(report!.state, `报告应为 ready:\n${diagnostics}`).toBe('ready')
    expect(calls, 'engine 回调序列应为 assignmentStarted → turnEnded → report').toEqual(['assignmentStarted', 'turnEnded', 'report'])
    const parsed = parseResultBlock(reply)
    expect(parsed, `worker 回复末尾应能解析出六行 RESULT 块:\n${diagnostics}`).not.toBeNull()
    expect(parsed!.status).toBe('ready')

    // worktree 存在，worker 在里面留下了一个新 commit，且新 commit 含 notes.md。
    expect(existsSync(worktree), `worktree 目录应存在: ${worktree}`).toBe(true)
    const worktreeHead = (await run('git', ['-C', worktree, 'rev-parse', 'HEAD'])).trim()
    expect(worktreeHead, 'worktree 的 HEAD 应是 worker 的新 commit，而不是主仓的种子 commit').not.toBe(seedHead)
    const headStat = await run('git', ['-C', worktree, 'show', '--stat', 'HEAD'])
    expect(headStat, `worker 的新 commit 应包含 notes.md:\n${headStat}`).toContain('notes.md')
    // 没有留下未提交的改动（worker 应把 notes.md 一起 commit）。
    const status = await run('git', ['-C', worktree, 'status', '--porcelain'])
    expect(status.trim(), `worktree 应是干净的:\n${status}`).toBe('')

    executor.dispose()
  })

  it('runs two tickets at once against the real binary (maxWorkers: 2)', { timeout: E2E_TIMEOUT_MS }, async () => {
    // 并发验证：两个独立的 zcode 进程同时跑，各自在自己的 worktree 里提交。ZCode 共享 ~/.zcode 的会话库，
    // 这里要证明的是它们不互相踩（进程级隔离），而不是吞吐。
    const root = await tempRoot()
    const mainRepo = join(root, 'repo')
    await run('git', ['init', mainRepo])
    await run('git', ['-C', mainRepo, 'config', 'user.email', 'e2e@example.invalid'])
    await run('git', ['-C', mainRepo, 'config', 'user.name', 'zcode e2e'])
    await writeFile(join(mainRepo, 'README.md'), 'seed\n')
    await run('git', ['-C', mainRepo, 'add', 'README.md'])
    await run('git', ['-C', mainRepo, 'commit', '-m', 'seed'])

    const settings: Settings = SettingsSchema.parse({ executor: {
      maxWorkers: 2,
      prepare: `git -C ${mainRepo} worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"`,
      zcode: { command: '~/.local/bin/zcode-wrapper', timeoutMs: RUN_TIMEOUT_MS },
    } })
    /** 每个工单一个独立文件与一条独立 worktree；任务同样只走 origin trigger（产品路径）。 */
    const task = (file: string): string => `在当前工作目录创建文件 ${file}，写入一行 "${file} was here"，git add 并 commit。`
      + '这个临时仓库没有远端：不要 push，也不要开 PR。'
    const ticketFor = (id: string, file: string): Ticket => ({
      id, title: `ticket ${id}`, decisionId: `d-${id}`,
      mandate: { strength: 'explicit', policyVersion: 'test', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'test', id: 'op' }, scope: 'test' },
      channels: [], assignments: [{ id: `a-${id}`, state: 'pending', createdAt: '2026-01-01T00:00:00Z' } as Assignment],
      inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      origin: { triggerId: `t-${id}`, triggerIds: [`t-${id}`] },
      execution: { name: id, directory: join(root, 'work', id), assignment: '' },
    })
    const tickets = [ticketFor('c1', 'one.md'), ticketFor('c2', 'two.md')]
    const triggers: Record<string, Trigger> = Object.fromEntries(tickets.map((ticket, index) => [ticket.origin.triggerId,
      { id: ticket.origin.triggerId, text: task(index === 0 ? 'one.md' : 'two.md'), actor: { source: 'test', id: 'jason' } } as unknown as Trigger]))

    const log: Recorded[] = []
    const record = (call: string) => (...args: unknown[]) => { log.push({ call, args }) }
    const fake = realSubprocess()
    const host = {
      context: { subprocess: fake.runtime },
      engine: {
        assignmentStarted: record('assignmentStarted'), inputsDelivered: record('inputsDelivered'),
        inputsRead: record('inputsRead'), turnEnded: record('turnEnded'), report: record('report'),
      },
      store: {
        settings: () => settings,
        atomic: (work: () => unknown) => work(),
        tickets: { get: (id: string) => tickets.find(ticket => ticket.id === id) },
        triggers: { get: (id: string) => triggers[id] },
      },
      machine: { stateDir: join(root, 'state') },
      lifetime: new AbortController().signal,
      paused: () => false,
      environment: (ticket: Ticket) => [variable('DSH_SUPERAGENT_DIR', ticket.execution?.directory ?? ''),
        variable('DSH_SUPERAGENT_NAME', ticket.execution?.name ?? '')],
    } as unknown as ZcodeHost

    const executor = new ZcodeExecutor(host)
    for (const ticket of tickets) executor.start(ticket, ticket.assignments[0]!)
    for (let rounds = 0; rounds < E2E_TIMEOUT_MS / 250 && log.filter(entry => entry.call === 'report').length < 2; rounds++) await wait(250)

    const reports = log.filter(entry => entry.call === 'report')
    const diagnostics = JSON.stringify(reports)
    expect(reports.length, `两个工单都应回写报告: ${diagnostics}`).toBe(2)
    for (const report of reports) expect((report.args[1] as { state: string }).state, diagnostics).toBe('ready')

    // 各自的 worktree 里留下各自的 commit，互不串味。
    for (const [id, file] of [['c1', 'one.md'], ['c2', 'two.md']] as const) {
      const directory = join(root, 'work', id)
      const stat = await run('git', ['-C', directory, 'show', '--stat', 'HEAD'])
      expect(stat, `${id} 的提交应包含 ${file}:\n${stat}`).toContain(file)
      expect((await run('git', ['-C', directory, 'status', '--porcelain'])).trim(), `${id} 的 worktree 应是干净的`).toBe('')
    }

    // 并发不是排队：两个 run 的时间区间必须重叠。
    const runs = fake.spawns.filter(spawn => spawn.argv[0]!.endsWith('zcode-wrapper'))
    expect(runs.length, '应有两个真实的 zcode 进程').toBe(2)
    const [first, second] = runs as [RealSpawn, RealSpawn]
    expect(Math.min(first.finishedAt ?? 0, second.finishedAt ?? 0), '两个 run 的时间区间应重叠')
      .toBeGreaterThan(Math.max(first.spawnedAt, second.spawnedAt))

    executor.dispose()
  })
})
