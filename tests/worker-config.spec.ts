/** Executor selection by settings: the default kind builds a DshExecutor, `kind: 'zcode'` builds the zcode executor with its option defaults, and an unknown kind is refused. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExecutor } from '../src/app/runtime.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import { ZcodeExecutor } from '../src/executor/zcode.ts'
import { ExecutorConfigSchema, SettingsSchema, type Settings } from '../src/policy.ts'

/** A minimal host: the factory and both executors' constructors only read settings and register effect handlers. */
const host = (executor: Settings['executor']): ExecutorHost => {
  const settings = SettingsSchema.parse({ executor })
  return {
    store: { settings: () => settings, tickets: { open: () => [] } },
    effects: { enqueue: () => {}, handle: () => () => {} },
    machine: { stateDir: '/tmp/dsh-worker-config' },
  } as unknown as ExecutorHost
}

describe('executor kind', () => {
  it('builds a DshExecutor for the default settings and for kind dsh', () => {
    expect(createExecutor(host(SettingsSchema.parse({}).executor))).toBeInstanceOf(DshExecutor)
    expect(createExecutor(host({ ...SettingsSchema.parse({}).executor, kind: 'dsh' }))).toBeInstanceOf(DshExecutor)
  })
  it('builds a ZcodeExecutor for kind zcode and fills the zcode option defaults', () => {
    expect(SettingsSchema.parse({ executor: { kind: 'zcode', zcode: {} } }).executor.zcode)
      .toEqual({ command: '~/.local/bin/zcode-wrapper', timeoutMs: 1_800_000 })
    const executor = createExecutor(host(SettingsSchema.parse({ executor: { kind: 'zcode', zcode: {} } }).executor))
    expect(executor).toBeInstanceOf(ZcodeExecutor)
    expect((executor as ZcodeExecutor).command).toBe(join(homedir(), '.local/bin/zcode-wrapper'))
    expect((executor as ZcodeExecutor).timeoutMs).toBe(1_800_000)
  })
  it('applies the zcode option defaults when the whole zcode block is absent', () => {
    const executor = createExecutor(host(SettingsSchema.parse({ executor: { kind: 'zcode' } }).executor)) as ZcodeExecutor
    expect(executor.command).toBe(join(homedir(), '.local/bin/zcode-wrapper'))
    expect(executor.timeoutMs).toBe(1_800_000)
  })
  it('refuses an unknown executor kind', () => {
    expect(ExecutorConfigSchema.safeParse({ kind: 'claude' }).success).toBe(false)
  })
})
