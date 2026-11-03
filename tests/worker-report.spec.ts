/** RESULT 块解析、WorkerReport 映射与 worker brief 构造：worker 回复是唯一回传通道，其约定必须机器可判。 */
import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { ticketExecution } from '../src/executor/execution-shared.ts'
import { buildWorkerBrief, composeBriefBody, mapToWorkerReport, parseResultBlock } from '../src/executor/zcode-report.ts'
import { SettingsSchema } from '../src/policy.ts'

const block = (status = 'ready', summary = 'Shipped it', branch = 'feat/x', head = 'abc1234', pr = '#12', next = 'none'): string =>
  `RESULT\nstatus: ${status}\nsummary: ${summary}\nbranch: ${branch}\nhead: ${head}\npr: ${pr}\nnext: ${next}`

it('parses a plain six-line RESULT block, keeping values that contain colons', () => {
  expect(parseResultBlock(`Work done.\n${block('ready', 'Merged: the fix', 'feat/x', 'abc1234', 'org/repo#12', 'await review')}`))
    .toEqual({ status: 'ready', summary: 'Merged: the fix', branch: 'feat/x', head: 'abc1234', pr: 'org/repo#12', next: 'await review' })
})

it('parses a fenced block, and accepts the closing fence and trailing text after it', () => {
  const fenced = `\`\`\`RESULT\nstatus: blocked\nsummary: Need credentials\nbranch: none\nhead: none\npr: none\nnext: ask the owner\n\`\`\`\n以上。`
  expect(parseResultBlock(fenced)).toEqual({ status: 'blocked', summary: 'Need credentials', branch: 'none', head: 'none', pr: 'none', next: 'ask the owner' })
  expect(parseResultBlock('```RESULT```\nstatus: ready\nsummary: s\nbranch: none\nhead: none\npr: none\nnext: none')).toEqual({ status: 'ready',
    summary: 's', branch: 'none', head: 'none', pr: 'none', next: 'none' })
})

it('takes the last RESULT block when several appear', () => {
  const text = `${block('ready', 'First')}\n\n后来又试了一次\n${block('failed', 'Second attempt')}`
  const parsed = parseResultBlock(text)
  expect(parsed?.status).toBe('failed')
  expect(parsed?.summary).toBe('Second attempt')
})

it('returns null for a block that misses a key, is out of order, or is truncated, without falling back to an earlier block', () => {
  expect(parseResultBlock('RESULT\nstatus: ready\nsummary: s\nbranch: b\nhead: h\npr: p')).toBeNull()
  expect(parseResultBlock('RESULT\nstatus: ready\nbranch: b\nsummary: s\nhead: h\npr: p\nnext: n')).toBeNull()
  expect(parseResultBlock(`${block()}\nRESULT\nstatus: ready\nsummary: cut off`)).toBeNull()
})

it('returns null for an unknown status value', () => {
  expect(parseResultBlock(block('done'))).toBeNull()
})

it('returns null when there is no RESULT block at all', () => {
  expect(parseResultBlock('没有任何块')).toBeNull()
  expect(parseResultBlock('')).toBeNull()
})

it('builds the worker brief from the assignment verbatim plus a six-key RESULT instruction', () => {
  const brief = buildWorkerBrief('Fix the bug.\nStep one: reproduce.')
  expect(brief.startsWith('Fix the bug.\nStep one: reproduce.')).toBe(true)
  expect(brief).toContain('RESULT')
  // 头行指令必须点名：真机会省略字面 RESULT 头，严格解析器就只认头行起的块。
  expect(brief).toContain('第一行必须恰为字面 RESULT')
  for (const key of ['status', 'summary', 'branch', 'head', 'pr', 'next']) expect(brief).toContain(`${key}:`)
  expect(brief).toContain('ready')
})

it('maps a parsed ready result to ready only on a clean exit', () => {
  expect(mapToWorkerReport({ parsed: parseResultBlock(block('ready')), exitCode: 0, timedOut: false })).toMatchObject({ state: 'ready' })
})

it('maps a parsed dropped result through on a clean exit', () => {
  // dropped 让票直接结束、不叫人：worker 判断"无事可做/请求不成立"时用它，而不是 failed。
  expect(mapToWorkerReport({ parsed: parseResultBlock(block('dropped')), exitCode: 0, timedOut: false }).state).toBe('dropped')
})

it('tells the worker to push the branch and open a draft PR before reporting ready', () => {
  const brief = buildWorkerBrief(composeBriefBody({ title: 'T', request: 'R' }))
  expect(brief).toContain('push')
  expect(brief).toContain('draft PR')
  expect(brief).toContain('RESULT 的 pr')
  expect(brief).toContain('blocked')
})

it('maps a parsed blocked or failed result through on a clean exit', () => {
  expect(mapToWorkerReport({ parsed: parseResultBlock(block('blocked')), exitCode: 0, timedOut: false }).state).toBe('blocked')
  expect(mapToWorkerReport({ parsed: parseResultBlock(block('failed')), exitCode: 0, timedOut: false }).state).toBe('failed')
})

it('reports failed on a timeout even when the worker said ready', () => {
  const report = mapToWorkerReport({ parsed: parseResultBlock(block('ready')), exitCode: 0, timedOut: true, stderrTail: 'partial output' })
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('超时')
  expect(report.summary).toContain('partial output')
})

it('reports failed with the exit code on a non-zero exit even when the worker said ready', () => {
  const report = mapToWorkerReport({ parsed: parseResultBlock(block('ready')), exitCode: 3, timedOut: false, stderrTail: 'boom' })
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('3')
  expect(report.summary).toContain('boom')
})

it('reports failed when the process was killed without an exit code, even when the worker said ready', () => {
  const report = mapToWorkerReport({ parsed: parseResultBlock(block('ready')), exitCode: null, timedOut: false, stderrTail: 'killed mid-run' })
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('killed mid-run')
})

it('reports failed when no RESULT block can be parsed', () => {
  const report = mapToWorkerReport({ parsed: null, exitCode: 0, timedOut: false })
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('RESULT')
})

it('attributes a missing block to output truncation when the run reported lossy stdout', () => {
  const report = mapToWorkerReport({ parsed: null, exitCode: 0, timedOut: false, outputTruncated: true })
  expect(report.state).toBe('failed')
  expect(report.summary).toContain('被截断')
})

it('composes the report summary from the block without losing fields, omitting the ones without information', () => {
  const full = mapToWorkerReport({ parsed: parseResultBlock(block('ready', 'Shipped it', 'feat/x', 'abc1234', '#12', 'watch CI')), exitCode: 0, timedOut: false })
  expect(full.state).toBe('ready')
  for (const piece of ['Shipped it', 'feat/x', 'abc1234', '#12', 'watch CI']) expect(full.summary).toContain(piece)
  const sparse = mapToWorkerReport({ parsed: parseResultBlock(block('ready', 'Shipped it')), exitCode: 0, timedOut: false })
  expect(sparse.summary).toContain('Shipped it')
  expect(sparse.summary).not.toContain('none')
})

it('composes the brief body from the ticket title, the request and the optional assignment and mandate', () => {
  const body = composeBriefBody({ title: 'Parser crashes', assignment: 'Routing note: keep it small', mandate: 'Limited authority.',
    request: 'The login page crashes when I submit the form.' })
  for (const piece of ['Parser crashes', 'Routing note: keep it small', 'Limited authority.', 'The login page crashes when I submit the form.'])
    expect(body).toContain(piece)
  // assignment 为空时不留空标题：brief 里不该出现没有内容的 “assignment：”。
  const bare = composeBriefBody({ title: 'T', assignment: '  ', request: 'R' })
  expect(bare).not.toContain('assignment：')
})

it('names the total length and the full-text path when the request was capped', () => {
  const body = composeBriefBody({ title: 'T', request: 'head', requestChars: 9_000, requestRead: '/state/worker-briefs/t1.md' })
  expect(body).toContain('请求正文共 9000 字')
  expect(body).toContain('/state/worker-briefs/t1.md')
})

it('keeps the ticket request in the brief when ticketExecution carries no assignment for an explicit ticket', () => {
  // 产品路径回归：explicit 票的 execution.assignment 为空，请求只能用 origin trigger 补进 brief。
  const ticket = {
    id: 't1', title: 'Parser crashes', decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 's', id: 'a' }, scope: 's' },
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
  } as unknown as Ticket
  const execution = ticketExecution(ticket, { kind: 'accept', title: 'Parser crashes', scope: 's', reason: 'r', name: 'parser-crash' },
    SettingsSchema.parse({}), '/tmp/state')
  expect(execution.assignment).toBe('')
  const brief = buildWorkerBrief(composeBriefBody({ title: ticket.title, assignment: execution.assignment, request: 'The login page crashes.' }))
  expect(brief).toContain('The login page crashes.')
  expect(brief).toContain('RESULT')
})
