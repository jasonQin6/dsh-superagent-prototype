/** RESULT 块解析、WorkerReport 映射与 worker brief 构造：worker 回复是唯一回传通道，其约定必须机器可判。 */
import { expect, it } from 'vitest'
import { buildWorkerBrief, mapToWorkerReport, parseResultBlock } from '../src/executor/zcode-report.ts'

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
