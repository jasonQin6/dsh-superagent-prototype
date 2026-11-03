/** The execution contract shared by executors: a ticket's execution metadata (worktree name, workspace directory, assignment text), its workspace directory preparation, and the mandate instructions a worker is told beyond the request. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AssessmentOutcome, Execution, Mandate, Ticket } from '../core/index.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'

/** Maximum runtime for a workspace prepare command. */
export const PREPARE_TIMEOUT_MS = 10 * 60_000
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
export class PrepareFailed extends Error {}
/** What an executor's host must provide to prepare a ticket's workspace directory. */
export interface PrepareHost {
  /** The subprocess service used to run prepare commands. */
  readonly context: Pick<Context, 'subprocess'>
  readonly store: Pick<Store, 'settings'>
  readonly lifetime: AbortSignal
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/**
 * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
 * execution environment variables, then verifies the directory as the worker sees it.
 * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
 * @throws PrepareFailed with the command's output when the prepare command fails.
 */
export async function prepareDirectory(host: PrepareHost, ticket: Ticket): Promise<void> {
  const directory = ticket.execution?.directory ?? ''
  await mkdir(dirname(directory), { recursive: true })
  const command = host.store.settings().executor.prepare.trim()
  const env = Object.fromEntries(host.environment(ticket).map(variable => [variable.key, variable.value]))
  // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
  const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
  if (command) await runAsWorker(host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
    .catch(async (error: unknown) => {
      // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
      await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
      throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  await mkdir(directory, { recursive: true })
  await verifyDirectory(directory, host.context.subprocess, host.lifetime)
}
/**
 * Returns additional instruction for a worker beyond the request: for work accepted proactively under rules
 * (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
