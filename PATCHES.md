# PATCHES

This fork is pinned by `jasonQin6/dsh-taskboard-ext` as
`github:jasonQin6/dsh-superagent-prototype#<commit>` (ADR-0007, ADR-0009).
Keep it as close to upstream `deepseek-ai/dsh-superagent-prototype@6337fc8`
as possible, and record every patch here.

## 1. `prepare` build hook (infrastructure, permanent)

`lib/` is git-ignored, so a git dependency has no loadable entry point unless it
builds itself during install. `package.json` adds:

```json
"prepare": "tsdown"
```

pnpm installs the package's devDependencies to run `prepare`, so a pinned
install produces `lib/index.js`, `lib/client.js`, the declarations and the
client bundle listed in `files`.

Verified on the fork with Node 26 / pnpm 11.7.0:

```sh
pnpm install        # prepare builds lib/
pnpm check          # typecheck + 1197 tests + build, all green
```

## 2. Host 0.2.1-rc.5 compatibility

The host that loads this pin is DSH `0.2.1-rc.5`; the package's
`peerDependencies` stay `^0.2.1-alpha.2` (which admits `0.2.1-rc.5`) and its
`devDependencies` stay pinned to `0.2.1-alpha.2`, the upstream baseline. The
build and `pnpm check` therefore run against alpha.2 types while the running
bundle uses the host's rc.5 copies.

Trying to move the devDependencies to `0.2.1-rc.5` exposes these adaptation
issues (recorded, not patched here — changing exported types or client
components is source surgery this fork should avoid until upstream catches up):

- `pnpm install` fails in `prepare` because tsdown's declaration build reports
  `TS2883` at `src/deployment.ts:15`: the inferred type of `Config` cannot be
  named without a reference to `Schema` from `@deepseek-ai/schemastery`.
- `tsc --noEmit` reports four rc.5 type changes (the runtime suite itself
  passes: `vitest run` is 1197/1197 green against rc.5):
  - `src/app/http.ts:237`: `ctx.webServer.port` is `number | undefined` in
    rc.5, while `sameOrigin()` takes a `number`.
  - `src/client/deployment.tsx:49`: `ConfigFormSnapshot.mode` no longer exists
    in rc.5 (the `memory`-mode read-only hint).
  - `tests/fixtures/panel-server.ts:461` and
    `tests/panel-deployment.spec.tsx:108` use the same removed `mode` field.

The shipped pin keeps the alpha.2 devDependencies, so the install and
`pnpm check` are green; the HTTP surface is verified against the running rc.5
host by the contract tests in `dsh-taskboard-ext`.

## 3. `goal/worker-module` ZCode worker module (feature branch)

The `goal/worker-module` branch adds a second executor behind the existing
`Executor` port (`src/core/ports.ts`), off by default: `executor.kind`
defaults to `dsh`, so stock deployments keep the `DshExecutor` unless they
explicitly set `kind: 'zcode'`. Decisions in ADR-0011 of
`jasonQin6/dsh-taskboard-ext`; usage in `docs/010-worker.md`. Files:

- `src/executor/execution-shared.ts` — the execution contract the two
  executors share (`ticketExecution`, `prepareDirectory`, `PrepareFailed`)
- `src/executor/zcode.ts` — the `ZcodeExecutor` itself: in-memory queue under
  `maxWorkers`, one zcode run per assignment (the brief carries the ticket's
  origin request, capped with the full text written under `<stateDir>/worker-briefs`),
  resume-or-`blocked` deliveries, stop aborts without reporting
- `src/executor/zcode-backend.ts` — the process backend: the argv contract and
  `runZcodeRun`, which reads one run as an NDJSON stream
- `src/executor/zcode-report.ts` — the plain-text contract: `composeBriefBody`
  (title + assignment + mandate + the origin request), `buildWorkerBrief`,
  `parseResultBlock`, `mapToWorkerReport` (never guesses `ready`)
- `tests/worker-backend.spec.ts`, `tests/worker-report.spec.ts`,
  `tests/worker-config.spec.ts`, `tests/worker-executor.spec.ts` — port-level
  tests on fakes
- `tests/worker-e2e.spec.ts` — real-process end-to-end on this machine (one
  ticket, and two concurrent tickets under `maxWorkers: 2`), guarded by
  `ZCODE_E2E` so the default suite skips it
- `docs/010-worker.md` — enablement, execution model, uncovered semantics, and
  the E2E run method

This is a feature-branch patch record: it takes effect when the fork pin moves
to a commit containing it (ADR-0007 pinning). Before moving the pin, run the
real end-to-end once on the exact commit being pinned
(`ZCODE_E2E=1 pnpm vitest run tests/worker-e2e.spec.ts`): it is the only check
that a production brief makes ZCode read the ticket request and finish with a
RESULT block.

### Environment note (not a source patch)

Run `pnpm check` outside a dsh-superagent worker shell. The Executor exports
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` and a worker-shim `PATH`; two
`tests/runtime.spec.ts` cases assert those are restored after the runtime stops
and fail inside a worker. A clean invocation:

```sh
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM -u GIT_ASKPASS -u GIT_TERMINAL_PROMPT \
  PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  pnpm check
```
