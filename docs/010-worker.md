# 010 Worker：ZCode 执行器（`kind: 'zcode'`）

本文档记录 fork 的 `goal/worker-module` 特性分支新增的第二个 Executor 实现：`ZcodeExecutor`（`src/executor/zcode.ts`），它与 `DshExecutor` 实现同一个 Executor 端口（缝 1，见 [009 BYOM](009-byom-single-orchestrator-multi-machine.md)），Engine 与 Policy、Store 零改。决策背景与被否方案见 ext 仓 `dsh-taskboard-ext` 的 `docs/adr/0011-worker-module.md`；工单的授权、投递与阶段语义不变，见 [003 Execution](003-execution.md)。模块清单见 [007 Architecture](007-architecture.md)。

## 如何开启

在 settings 的 `executor` 块里把 `kind` 显式设为 `'zcode'`（[007 Architecture](007-architecture.md) 的 Modules 表列出实现文件）。`kind` 缺省时按 `'dsh'` 处理：不配置就仍是 `DshExecutor`，存量部署零影响。

```json
{
  "executor": {
    "kind": "zcode",
    "maxWorkers": 3,
    "prepare": "git -C /path/to/repo worktree add \"$DSH_SUPERAGENT_DIR\" -b \"agent/$DSH_SUPERAGENT_NAME\"",
    "zcode": { "command": "~/.local/bin/zcode-wrapper", "timeoutMs": 1800000 }
  }
}
```

`executor.kind` 与 `executor.zcode` 都没有 zod 默认值（缺省由使用方按 `'dsh'` 与 `ZCODE_DEFAULTS` 处理），`zcode` 块可以整体省略：

| 选项 | 默认值（`ZCODE_DEFAULTS`，`src/policy.ts`） | 含义 |
| --- | --- | --- |
| `zcode.command` | `~/.local/bin/zcode-wrapper` | zcode CLI 命令；开头的 `~` 展开为宿主用户主目录，不经 shell 启动 |
| `zcode.timeoutMs` | `1800000`（30 分钟） | 一次 zcode run 的最大运行时间，到点终止进程并报 `failed`（超时） |

其余 executor 选项沿用现状：`maxWorkers` 是全局并发上限，`prepare` 命令为每张票准备工作目录，`directory` 是执行目录根（空则 `<stateDir>/work`）。`prepare` 命令在票的父目录里以 `sh -c` 运行，拿到执行环境变量（`src/app/execution-environment.ts`）：`DSH_SUPERAGENT_DIR`（票的执行目录）、`DSH_SUPERAGENT_NAME`（票的短名，也是目录名）、`DSH_SUPERAGENT_TICKET`（票 id）。ZCode 凭据沿用本机 `~/.zcode`，模块不新造 key；不改 `~/.dsh`。

## 执行模型

- **一次性进程，非长驻会话**。每张票的每个 Assignment 触发一次独立的 zcode run：`start` → `prepareDirectory`（复用原型 prepare 机制）→ `assignmentStarted` → run → `turnEnded` → `report`。首发建会话（`-p <brief> --cwd <worktree> --mode yolo --disallowed-tools AskUserQuestion EnterPlanMode ExitPlanMode --output-format stream-json --no-color`），续跑用 `--resume <sessionId>`。子进程一律走 `ctx.subprocess`，不裸 `child_process`。
- **NDJSON result 行**。stdout 按行增量 `JSON.parse`；只消费最后一行 `type:"result"` 的 `sessionId` 与 `response`（驼峰字段），其余行（未知事件、hook 噪声、坏行）按原文保留，不按事件数判成功。增量读取是 offset 制的，done 之后还有一次收尾读兜底排干管道。
- **RESULT 协议**。`buildWorkerBrief` 把 assignment 原文原样置前，尾接固定的六行 RESULT 块指令（`status`/`summary`/`branch`/`head`/`pr`/`next`，顺序恰定）。取回复中最后一个块解析；判定顺序即可信度顺序：超时最先、退出码次之、然后才是块本身——退出码非 0、超时、解析不出都报 `failed`，只有 `status: ready` 且干净退出才产出 `ready`，任何路径不猜 ready。
- **deliver = `--resume`，在飞则排队等结算**。未投递 Inputs 到来时，若该票记录了 zcode 会话且没有 run in flight，则以 `--resume` 续跑，文本是未投递 Inputs 的拼接，投递后 run 结束时同事务记 `inputsRead` 与 report；run 在飞时到达的 deliver 留在队列里，等该 run 结束后由派发循环续跑（首发 brief 只带 assignment 文本，发射前后到达的输入必须经续跑送达）；没有会话可续（如重启后）才 `report blocked` 写明原因，不报 `deliveryFailed`、不重试。已知边界：首发 run 以 `ready` 终结票时，还在等的 deliver 随票作废——一次性 run 模型下输入不并入已完成的结论。
- **stop = abort**。run 的生命周期信号 = 宿主 lifetime + 本 run 的 controller + 超时 deadline 的合成；`stop`/`shutdown`/宿主停止都收得走它，由 subprocess 适配层终止进程树。stop 之后不再为该票 report；宿主 lifetime 中止后排队的待派发工作直接丢弃，不派发也不报告。
- **并发 = `maxWorkers`，每票单飞**。一个内存 FIFO 在 `maxWorkers` 个工作位下派发；同一张票同时至多一个 in-flight run，被同票在飞挡住的队列项原地等待，不挡其他票的派发。prepare 失败不重试（半成品目录不得当成已准备好），直接 `failed`。

队列、工作位与会话 id 都只在内存里，不跨进程重启。

## 未覆盖语义（v1 明确不做，对齐 ADR-0011）

- 后台 job（5 秒转后台 / 30 分钟上限）、subagent slot、per-turn 持有 slot 的并发语义：zcode worker 是单进程一次性执行，没有回合与后台工作。
- transient 重试矩阵：仅保留「launch/prepare 失败 → `failed` report」，没有 3 次指数退避。
- resume 不跨重启：会话 id 只在内存，重启后 `deliver` 会报 `blocked`（无可续跑会话）；重启的中断恢复语义 ADR-0011 尚未覆盖。
- `inputsRead` 只能在续跑 run 完成后近似上报，无法观察「Session 取入 step」。
- 每机器 HealthBoard 条目与多机路由（docs/009 阶段 B 之后的事）；health 条目仍归 `DshExecutor`。

## 端到端验证（E2E）

`tests/worker-e2e.spec.ts` 在真机上跑一次端口级端到端：临时 git 主仓（仓级 `user.email`/`user.name`）+ `git worktree` prepare + 真实 zcode 进程，断言回调序（`assignmentStarted → turnEnded → report`）、`ready` 报告、RESULT 块原文，以及 worktree 里 worker 的新 commit 含 `notes.md`；它不跑整个 Engine/Runtime。该测试被 `ZCODE_E2E` 环境变量守卫，默认全量测试不跑真进程（真跑一次要几十秒到几分钟，单个用例显式设了 timeout）：

```sh
env -i HOME="$HOME" PATH="$PATH" ZCODE_E2E=1 pnpm vitest run tests/worker-e2e.spec.ts
```

`ZCODE_E2E=1` 必须写在 `env -i` 之后：`env -i` 以空环境启动，写在它前面的变量会被丢弃。不需要干净 shell 时，`ZCODE_E2E=1 pnpm vitest run tests/worker-e2e.spec.ts` 等价。前提：真机存在 `~/.local/bin/zcode-wrapper` 与 `git`，且 zcode 凭据可用。
