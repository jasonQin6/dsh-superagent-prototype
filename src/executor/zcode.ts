/**
 * Zcode 执行器：`kind: 'zcode'` 时每次任务发起一次独立的 zcode CLI run（首发建会话，续跑 --resume），
 * 把 NDJSON 流的 result 行映射回 WorkerReport。Engine 在 command 内同步调用本类，所以 start/deliver 只入内存
 * 队列并立即返回；真正的进程由受 settings.maxWorkers 约束的派发循环异步驱动。会话 id 只存在内存里，
 * 队列同样不跨进程重启，重启后的续跑语义 ADR-0011 尚未覆盖。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { latestAssignment, liveTicket, runningAssignment } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Executor, Ticket, TicketInput } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { ZCODE_DEFAULTS } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { Variable } from '../app/execution-environment.ts'
import { mandateInstructions, prepareDirectory, ticketExecution } from './execution-shared.ts'
import { buildZcodeArgv, runZcodeRun, type ZcodeRunResult } from './zcode-backend.ts'
import { buildWorkerBrief, composeBriefBody, mapToWorkerReport, parseResultBlock } from './zcode-report.ts'

/** What the zcode executor's host must provide. */
export interface ZcodeHost {
  /** The subprocess service used to run prepare commands and zcode runs. */
  readonly context: Pick<Context, 'subprocess'>
  /** Where the executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'report'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic'>
  readonly machine: Pick<Machine, 'stateDir'>
  /** The host's lifetime signal; a run's own signal is combined with it so a host stop also ends runs. */
  readonly lifetime: AbortSignal
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
}
/** Expands a leading `~` of a configured command to the host user's home directory; `~user` paths stay as written. */
const expandHome = (command: string): string => command === '~' || command.startsWith('~/') ? join(homedir(), command.slice(1)) : command
/** 首发 brief 里原始请求的字符上限：`-p` 走 argv，长 issue 正文必须截断；被截断时全文另落 stateDir 供 worker 自己读。 */
const REQUEST_CHARS = 6_000
/** 请求的截断结果：`truncated` 为真时 `text` 只是开头，`chars` 是原文总长。 */
const capRequest = (text: string): { text: string; chars: number; truncated: boolean } => text.length <= REQUEST_CHARS
  ? { text, chars: text.length, truncated: false }
  : { text: text.slice(0, REQUEST_CHARS), chars: text.length, truncated: true }
/** 队列里的一项工作：start 的首发，或 deliver 的续跑。 */
interface QueuedStart { kind: 'start'; ticketId: string; assignmentId: string }
/** deliver 的队列项；inputIds 在派发时从票上快照，供 inputsDelivered/inputsRead。 */
interface QueuedDeliver { kind: 'deliver'; ticketId: string; assignmentId: string; inputIds: string[] }
type QueuedWork = QueuedStart | QueuedDeliver
/** 一个工作位上的记账：run 的生命周期信号、stop 是否已到、以及整段派发（含 prepare 与 run）的 done，供 shutdown 收尾等待。 */
interface RunEntry {
  controller: AbortController
  stopped: boolean
  done?: Promise<unknown>
}
/** deliver 做不到续跑的原因；能续跑时返回 undefined。run 在飞不算：那种 deliver 留在队列里等 run 结束后续跑。 */
const deliveryBlocker = (sessionId: string | undefined): string | undefined =>
  sessionId === undefined ? '输入未投递：该 ticket 还没有可续跑的 zcode 会话（上次 run 未产生 sessionId）。' : undefined

/**
 * A zcode-backed executor: `start` launches one zcode run per assignment and `deliver` resumes the ticket's recorded
 * zcode session with the undelivered inputs, both through an in-memory queue driven under the `maxWorkers` limit.
 * A delivery that arrives while the ticket's run is in flight waits in the queue and resumes once that run settles,
 * because the first run's brief carries only the origin request (no later inputs); one with no session to resume reports `blocked`
 * instead of `deliveryFailed` (ADR-0011), and a failed launch is reported without retries because a half-prepared
 * workspace must not be treated as prepared. `prepare` fills the ticket's execution metadata through the shared
 * execution contract.
 */
export class ZcodeExecutor implements Executor {
  /** The zcode CLI command this executor runs, with a leading `~` expanded. */
  readonly command: string
  /** The maximum runtime one zcode invocation gets. */
  readonly timeoutMs: number
  /** FIFO of starts and deliveries waiting for a worker slot. */
  private readonly waiting: QueuedWork[] = []
  /** The tickets holding a worker slot right now: reserved at dequeue, gone when their dispatch ends. */
  private readonly runs = new Map<string, RunEntry>()
  /** Each ticket's last zcode session id, from its runs' result events; the resume handle of `deliver`. */
  private readonly sessions = new Map<string, string>()
  constructor(private readonly host: ZcodeHost) {
    const options = host.store.settings().executor.zcode ?? ZCODE_DEFAULTS
    this.command = expandHome(options.command)
    this.timeoutMs = options.timeoutMs
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /** Parks the assignment's start in the in-memory queue; the dispatch loop launches it when a slot is free. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.waiting.push({ kind: 'start', ticketId: ticket.id, assignmentId: assignment.id })
    this.pump()
  }
  /** Parks the ticket's delivery in the in-memory queue; it either resumes the recorded session or reports blocked. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.waiting.push({ kind: 'deliver', ticketId: ticket.id, assignmentId: assignment.id, inputIds: [] })
    this.pump()
  }
  /** Aborts the ticket's in-flight run; the Engine calls this after the ticket or assignment has already ended, so nothing reports afterwards. */
  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    // 票或任一 Assignment 已结束：续跑句柄随之作废，不再为已结束的票留会话。
    this.sessions.delete(ticket.id)
    const entry = this.runs.get(ticket.id)
    if (!entry) return
    entry.stopped = true
    entry.controller.abort(reason)
  }
  /** No events to listen for. */
  install(): void {}
  /** The queue and the session ids live only in memory, so a restart reconciles nothing. */
  resume(): void {}
  /** Aborts every in-flight run and waits for their streams to settle. */
  async shutdown(): Promise<void> {
    const entries = [...this.runs.values()]
    for (const entry of entries) { entry.stopped = true; entry.controller.abort('dsh-superagent stopped') }
    await Promise.allSettled(entries.map(entry => entry.done))
  }
  /** Aborts every in-flight run and drops the queue and the session ids. */
  dispose(): void {
    for (const entry of this.runs.values()) { entry.stopped = true; entry.controller.abort('dsh-superagent disposed') }
    this.runs.clear(); this.waiting.length = 0; this.sessions.clear()
  }
  /** The number of tickets holding a worker slot right now. */
  activeCount(): number { return this.runs.size }
  /**
   * Dispatches from the queue while work is dispatchable: work whose ticket ended or whose assignment was replaced is
   * dropped silently, the rest waits for a slot within `maxWorkers`. A delivery whose ticket has a run in flight stays
   * queued and is picked up by the pump that runs when that run settles — reporting it `blocked` instead would
   * structurally starve inputs that arrive between `assignmentStarted` and the run's spawn, because the first run's
   * brief carries only the assignment text. Work whose ticket is not in flight but sits behind a blocked queue head is
   * still dispatched (the queue only orders per-ticket fairness, not global blocking). The slot is reserved
   * synchronously so two dispatches cannot take the last one. After the host lifetime aborted nothing is dispatched:
   * the runtime is stopping and queued work must not write new reports into it.
   */
  private pump(): void {
    for (;;) {
      if (this.host.lifetime.aborted) { this.waiting.length = 0; return }
      while (this.waiting.length) {
        const head = this.waiting[0]!
        const ticket = this.host.store.tickets.get(head.ticketId)
        if (ticket && liveTicket(ticket) && this.currentAssignment(ticket, head)) break
        this.waiting.shift()
      }
      if (!this.waiting.length) return
      if (this.runs.size >= this.host.store.settings().executor.maxWorkers) return
      // 只派发不被同票在飞挡住的工作：一个 ticket 同时只发一个 run，否则新工作位会覆盖旧条目，
      // stop 就再也 abort 不到先前的 run；被挡住的项留在原位等 run 结束后的 pump。
      const index = this.waiting.findIndex(work => !this.runs.has(work.ticketId))
      if (index < 0) return
      const work = this.waiting.splice(index, 1)[0]!
      const entry: RunEntry = { controller: new AbortController(), stopped: false }
      this.runs.set(work.ticketId, entry)
      const settled = this.dispatch(work, entry).finally(() => {
        if (this.runs.get(work.ticketId) === entry) this.runs.delete(work.ticketId)
        this.pump()
      })
      // done 记整段派发而不是仅 run.done：shutdown 才能等到还在 prepare 的派发收尾。
      entry.done = settled
      void settled
    }
  }
  /** 该 ticket 的最新 Assignment 仍是 work 针对的那一个（首发要求 pending，续跑要求 running）时返回它。 */
  private currentAssignment(ticket: Ticket, work: QueuedWork): Assignment | undefined {
    const assignment = work.kind === 'start' ? latestAssignment(ticket) : runningAssignment(ticket)
    return assignment?.id === work.assignmentId && (work.kind === 'start' ? assignment.state === 'pending' : true) ? assignment : undefined
  }
  /**
   * run 结束后的可上报校验。首发在 assignmentStarted 之后 assignment 已是 running（真 Engine 的领域语义），
   * 不能复用派发时点的 pending 校验；prepare 早失败时它仍是 pending，两种都要放行，只排除已结束与被替换。
   */
  private reportableAssignment(ticket: Ticket, work: QueuedWork): Assignment | undefined {
    const assignment = work.kind === 'start' ? latestAssignment(ticket) : runningAssignment(ticket)
    return assignment?.id === work.assignmentId && assignment.state !== 'ended' ? assignment : undefined
  }
  private async dispatch(work: QueuedWork, entry: RunEntry): Promise<void> {
    try {
      if (work.kind === 'start') await this.runStart(work, entry)
      else await this.runDeliver(work, entry)
    } catch (error) {
      // 本执行器没有 transient 重试语义：prepare 抛错、进程起不来等一切未预期的失败都落成 failed 报告。
      this.reportFailure(work, entry, error)
    }
  }
  /** 本票 origin trigger 的正文；取不到时给可读的占位，不静默发出一张空任务。 */
  private requestText(ticket: Ticket): string {
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
    return trigger ? `${trigger.actor.id}: ${trigger.text}` : `[origin request ${ticket.origin.triggerId} is not available]`
  }
  /** 请求被截断时把全文写进 stateDir，供 worker 自己读；写失败返回 undefined，run 仍按截断后的 brief 进行。 */
  private async writeFullRequest(ticket: Ticket, text: string): Promise<string | undefined> {
    const directory = join(this.host.machine.stateDir, 'worker-briefs')
    const path = join(directory, `${ticket.id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(path, `${text}\n`, 'utf8')
      return path
    } catch { return undefined }
  }
  /** 首发一次 zcode run：先备好工作目录，再 assignmentStarted，run 结束后 turnEnded 与 report。 */
  private async runStart(work: QueuedStart, entry: RunEntry): Promise<void> {
    const ticket = this.host.store.tickets.get(work.ticketId)
    if (!ticket || entry.stopped || !this.currentAssignment(ticket, work)) return
    // run 的生命周期 = 宿主 lifetime + 本 run 的信号：stop/shutdown 与宿主停止都收得走它。
    const signal = AbortSignal.any([this.host.lifetime, entry.controller.signal])
    await prepareDirectory({ context: this.host.context, store: this.host.store,
      lifetime: signal, environment: prepared => this.host.environment(prepared) }, ticket)
    const current = this.host.store.tickets.get(work.ticketId)
    if (!current || entry.stopped || !this.currentAssignment(current, work)) return
    this.host.store.atomic(() => { this.host.engine.assignmentStarted(work.ticketId, work.assignmentId) })
    const directory = current.execution?.directory ?? ''
    // 请求正文来自 origin trigger：execution.assignment 只带路由注记（原型由 launch 单独投递 trigger），
    // 少了它 worker 收到的就是一张没有任务的票。长正文截断，全文落 stateDir 并给出路径。
    const origin = this.requestText(current)
    const request = capRequest(origin)
    const read = request.truncated ? await this.writeFullRequest(current, origin) : undefined
    // 写全文期间票可能被停掉：spawn 前再确认一次，避免为已结束的票起进程。
    if (entry.stopped) return
    const body = composeBriefBody({ title: current.title, assignment: current.execution?.assignment,
      mandate: mandateInstructions(current.mandate), request: request.text,
      ...(request.truncated ? { requestChars: request.chars, requestRead: read } : {}) })
    const argv = buildZcodeArgv({ brief: buildWorkerBrief(body), cwd: directory, command: this.command })
    const run = runZcodeRun(this.host.context.subprocess, { argv, cwd: directory, signal, timeoutMs: this.timeoutMs })
    const outcome = await run.done
    this.finish(work, entry, outcome)
  }
  /** 以 --resume 续跑该 ticket 记录的 zcode 会话，文本是未投递 Inputs 的拼接；没有会话可续时报告 blocked。 */
  private async runDeliver(work: QueuedDeliver, entry: RunEntry): Promise<void> {
    const ticket = this.host.store.tickets.get(work.ticketId)
    if (!ticket || entry.stopped || !this.currentAssignment(ticket, work)) return
    const sessionId = this.sessions.get(work.ticketId)
    // pump 只在该票无在飞 run 时才会派发 deliver，所以这里能挡住的只有会话缺失。
    const blocker = deliveryBlocker(sessionId)
    if (blocker) {
      // 报告可能被 Engine 拒绝（票恰好结束）：无票可报，安静放弃。
      try { this.host.store.atomic(() => { this.host.engine.report(work.ticketId, { state: 'blocked', summary: blocker }) }) }
      catch { /* 票已结束：无票可报。 */ }
      return
    }
    const inputs = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).filter((input): input is TicketInput => !!input)
    work.inputIds = inputs.map(input => input.id)
    if (!work.inputIds.length) return
    const text = inputs.map(input => this.inputText(input)).filter(part => part !== undefined).join('\n\n')
    const directory = ticket.execution?.directory ?? ''
    const argv = buildZcodeArgv({ brief: buildWorkerBrief(text), cwd: directory, resume: sessionId, command: this.command })
    const run = runZcodeRun(this.host.context.subprocess,
      { argv, cwd: directory, signal: AbortSignal.any([this.host.lifetime, entry.controller.signal]), timeoutMs: this.timeoutMs })
    // 文本已交给进程，投递即成事实；worker 把消息读进步骤后由 run 结束时的 inputsRead 记账。
    this.host.store.atomic(() => { this.host.engine.inputsDelivered(work.ticketId, work.assignmentId, work.inputIds) })
    const outcome = await run.done
    this.finish(work, entry, outcome)
  }
  /** run 结束后的记账：stopped 或票已变则不再 report（也不记它的会话）；两种 run 都先记 turnEnded，续跑再记 inputsRead 与 report。 */
  private finish(work: QueuedWork, entry: RunEntry, outcome: ZcodeRunResult): void {
    if (entry.stopped) return
    const ticket = this.host.store.tickets.get(work.ticketId)
    if (!ticket || !liveTicket(ticket) || !this.reportableAssignment(ticket, work)) return
    if (outcome.sessionId) this.sessions.set(work.ticketId, outcome.sessionId)
    const report = mapToWorkerReport({ parsed: parseResultBlock(outcome.resultText), exitCode: outcome.exitCode, timedOut: outcome.timedOut,
      stderrTail: outcome.stderrTail, outputTruncated: outcome.lossy })
    if (work.kind === 'start') {
      this.host.store.atomic(() => { this.host.engine.turnEnded(work.ticketId, work.assignmentId) })
      this.host.store.atomic(() => { this.host.engine.report(work.ticketId, report) })
    } else {
      // 续跑也是一次 worker turn：与首发一样先记 turnEnded（assignment.idleAt 与面板时长用它），再记 inputsRead 与 report。
      this.host.store.atomic(() => { this.host.engine.turnEnded(work.ticketId, work.assignmentId) })
      this.host.store.atomic(() => {
        this.host.engine.inputsRead(work.ticketId, work.inputIds)
        this.host.engine.report(work.ticketId, report)
      })
    }
  }
  /** 派发路径上任何未预期失败的兜底报告；stopped 或票已变时安静放弃，报告本身再抛也只放弃。 */
  private reportFailure(work: QueuedWork, entry: RunEntry, error: unknown): void {
    try {
      if (entry.stopped) return
      const ticket = this.host.store.tickets.get(work.ticketId)
      if (!ticket || !liveTicket(ticket) || !this.reportableAssignment(ticket, work)) return
      this.host.store.atomic(() => { this.host.engine.report(work.ticketId, { state: 'failed', summary: String(error) }) })
    } catch { /* 票在检查与报告之间结束：Engine 的 report 会抛 UserError，此时无票可报，安静放弃。 */ }
  }
  /** 把一个 Input 渲染进续跑文本；reopen 是历史遗留形态，没有可投的文本。 */
  private inputText(input: TicketInput): string | undefined {
    if (input.kind === 'text') return input.text
    if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
    if (input.kind === 'trigger') {
      const trigger = this.host.store.triggers.get(input.triggerId)
      const body = trigger ? `${trigger.actor.id}: ${trigger.text}` : `[trigger ${input.triggerId}]`
      const note = input.note ? ` (routing note: ${input.note})` : ''
      // context 标记必须保留：它告诉 worker 这条消息只在上下文线程里，不是发给本票的，不能当成授权的工作。
      return input.context ? `[Context only, not addressed to this ticket] ${body}${note}` : `${body}${note}`
    }
    if (input.kind === 'resumed') return 'This ticket was resumed by a person\'s message under the same mandate; continue within the original scope.'
    if (input.kind === 'policy-changed') {
      // 政策变化的细则（哪条规则不再适用、是否还收推断工作）约束 worker 的剩余范围，逐条带过去。
      return ['Policy change:',
        ...(input.effect?.rules ?? []).map(rule => rule.change === 'disabled'
          ? `Rule ${rule.name} (${rule.id}) no longer applies: finish only a change within it, or report dropped.`
          : `Rule ${rule.name} (${rule.id}) changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
        ...(input.effect?.proactive === false ? ['Work inferred from a rule is no longer accepted: finish what is in progress, or report dropped.'] : []),
        ...(input.effect?.requesterAllowed === false ? [`Its sender may no longer start work here; take no new requests from them on it.`] : [])].join('\n')
    }
    return undefined
  }
}
