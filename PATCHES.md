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
