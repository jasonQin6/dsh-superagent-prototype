/** Zcode executor skeleton: fills the shared execution contract and parks queued work in memory, driving no zcode process yet. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssessmentOutcome, Assignment, Executor, Ticket } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { ZCODE_DEFAULTS } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { ticketExecution } from './execution-shared.ts'

/** What the zcode executor's host must provide. */
export interface ZcodeHost {
  readonly store: Pick<Store, 'settings'>
  readonly machine: Pick<Machine, 'stateDir'>
}
/** Expands a leading `~` of a configured command to the host user's home directory; `~user` paths stay as written. */
const expandHome = (command: string): string => command === '~' || command.startsWith('~/') ? join(homedir(), command.slice(1)) : command
/**
 * A skeleton of the zcode-backed executor: `start` and `deliver` park their work in an in-memory queue nothing consumes,
 * and `stop`, `install`, `resume`, `shutdown` and `dispose` do nothing, so the Runtime can already assemble and type
 * against `kind: 'zcode'` while no zcode process is called yet. `prepare` fills the ticket's execution metadata through
 * the shared execution contract, like every executor must.
 */
export class ZcodeExecutor implements Executor {
  /** The zcode CLI command this executor would run, with a leading `~` expanded. */
  readonly command: string
  /** The maximum runtime one zcode invocation would get. */
  readonly timeoutMs: number
  /** The starts and deliveries parked in memory until a real executor consumes them. */
  private readonly queue: { ticketId: string; assignmentId?: string }[] = []
  constructor(private readonly host: ZcodeHost) {
    const options = host.store.settings().executor.zcode ?? ZCODE_DEFAULTS
    this.command = expandHome(options.command)
    this.timeoutMs = options.timeoutMs
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /** Parks the assignment's start in the in-memory queue. */
  start(ticket: Ticket, assignment: Assignment): void { this.queue.push({ ticketId: ticket.id, assignmentId: assignment.id }) }
  /** Parks the ticket's delivery in the in-memory queue. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.queue.push({ ticketId: ticket.id }) }
  /** Nothing runs, so a stop ends nothing. */
  stop(_ticket: Ticket, _assignment: Assignment, _reason: string): void {}
  /** No events to listen for yet. */
  install(): void {}
  /** Nothing to reconcile after a restart while nothing runs. */
  resume(): void {}
  /** Nothing running, so shutdown waits for nothing. */
  async shutdown(): Promise<void> {}
  /** Nothing to unsubscribe from. */
  dispose(): void {}
  /** Nothing runs, so no ticket holds a worker slot. */
  activeCount(): number { return 0 }
}
