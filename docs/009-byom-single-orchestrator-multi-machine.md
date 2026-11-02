# BYOM（Bring Your Own Machine）：一个 Superagent 控制多台执行机器

## Problem Statement

用户有多台属于自己的机器（例如本地 Mac、本机开发机、云端构建机、放置在机房的 Linux 服务器、经 Tailscale 可达的远端 Debian），希望只运行一个 superagent（一个 Loop、一个 Session 视图、一套 Policy/Policy 版本、一套 Source 订阅），让工单（Ticket）的执行（Assignment）可以落在任意一台机器上，仓库和工具链环境留在机器原地。

现状是：Agent Loop 计算、会话状态、代码仓库工具链环境被绑在同一台机器、同一个进程里。机器休眠或离线，整个 superagent 即停；要在另一台机器上干活，就得在那台机器上再装一套 DSH + 再跑一个 superagent profile，变成 N 台机器 N 个 superagent：N 个数据库、N 个主 Session、N 套 Policy、N 套 Source 订阅，互相不知道对方，注意力成本和配置漂移都乘以 N。

运维型的 SSH 遥控（主机管理、批量命令、文件上传下载、端口转发）解决不了这个问题：它没有 Ticket/Assignment 语义，没有工单目录准备（prepare）语义，没有队列重试，没有执行环境隔离，也没有中断恢复，断线重放还可能重复执行非幂等命令。

## Solution

保持现有域模型（Source、Thread、Eval、Mandate、Ticket、Assignment、Subscription、Channel、Policy、Report）不变，只把“在哪里执行”从“Loop 在哪里”解耦：

1. 存算分离：Loop（Engine + 主 Session 的路由/研判）搬到云端无状态弹性容器，Session 状态进数据库，容器可重启、可扩展，单机休眠不再停服。
2. Loop 与执行环境分离：执行环境留在各机器原地，每台机器只跑一个不存会话状态的轻量 daemon，只负责执行命令并回传结果；Loop 通过 Assignment 把工单绑定到某一台机器的 daemon 上。

用户视角：还是那一个 superagent 面板，还是同一套允许名单和规则；开工单时（或在工单页）选一台机器，执行器 Session 的指令、准备命令、环境变量、git 身份都跟过去一样，只是实际跑命令的那台机器变了；机器离线时，其工单排队或按策略转移，恢复后带恢复说明继续。

## User Stories

1. As an operator, I want to run exactly one superagent for my whole fleet, so that I keep one Policy, one allowed list, and one panel instead of N of everything.
2. As an operator, I want to register a machine（录入一台机器）with a name, tags, and environment, so that later Tickets can target it.
3. As an operator, I want to see each machine 的在线状态、负载（running Assignments、排队数）、最近心跳，so that I know where work can land.
4. As an operator, I want to pause/drain a machine（不再接受新 Assignment，等运行中的结束）, so that I can upgrade or shut it down without killing work.
5. As an operator, I want to remove a machine, so that stale capacity disappears; running Assignments on it are interrupted with a recovery note and requeued.
6. As a requester, I want to name a target machine（或标签）when I ask for work, so that the checkout/toolchain on that machine is used.
7. As a requester, I want a default routing rule（默认落在哪台机器）, so that I don't have to choose every time.
8. As a router（主 Session）, I want routing hints（仓库归属、标签、机器能力、当前负载、策略约束）, so that accept 时能选出合理的执行机器并记录为 Assignment 的一部分。
9. As an executor, I want the Ticket's directory to be created on the target machine（而不是 Loop 所在机器）, so that the repo worktree/checkout uses that machine's disk and toolchain.
10. As an executor, I want the prepare command to run on the target machine with the same execution variables（as environment variables）, so that existing `git worktree` style prepare commands keep working unchanged.
11. As an executor, I want the same command shims（agent 的 gh、bot 的 lark-cli）和 git credential 配置 on the target machine, so that pushes/comments use the agent identity and never leak the operator's personal credentials.
12. As an executor, I want blocked commands to fail by name on the target machine, so that personal CLIs stay out of reach even remotely.
13. As an executor, I want long shell commands to move to background after the same threshold and keep the same 30-minute background limit, so that交互语义与单机一致（能收新消息、超时被 kill 并报告）。
14. As an executor, I want background jobs and subagents lifecycle（wake with result、handoff frees slot、kill on end）to behave the same on a remote machine, so that existing prompt chapters about background work stay true.
15. As an executor, I want a failed prepare to fail the Ticket with output（而不是自动重试）, so thatéa半成品目录不会被当成已准备好。
16. As a ticket owner, I want Inputs（fan-out Triggers、Policy 变更通知、resume、text）delivered to the running Assignment wherever it runs, in order, with the same retry/backoff, so that remote execution doesn't lose or reorder context.
17. As a ticket owner, I want delivery failures to show on the Ticket（而不是全局报错）, so that I know which Ticket is stuck.
18. As a ticket owner, I want worker Reports（progress/waiting/ready/blocked/failed/dropped + questions）relayed identically regardless of machine, so that review/blocked flows don't change.
19. As an operator, I want a host/Loop restart to interrupt running Assignments with recovery notes and resume oldest-first, even when the worker is on another machine, so that升级 Loop 不丢工单。
20. As an operator, I want an offline machine's Tickets to wait（或按配置转移）, not silently fail, and resume with recovery notes when the machine returns, so that笔记本合盖不会丢工作。
21. As an operator, I want per-machine concurrency limits（worker slots + 人消息可挤占一个额外 slot 的规则保持）, so that一台小机器不会被大并发压垮。
22. As an operator, I want secrets to never travel as execution variables（现有规则：变量不含任何密钥）, and daemon credentials to be scoped per machine, so that一台机器被攻破不会交出全部密钥。
23. As an auditor, I want Trigger→Eval→Decision→Ticket→Assignment→Report 的审计链包含执行机器（which machine ran which Assignment）, so that事后可追溯。
24. As an operator, I want existing single-machine deployment to keep working with zero config change（默认执行位置 = 本机）, so that升级是兼容的。
25. As an operator, I want machine logs/artifacts（prepare 输出、command 输出截断、job 结果）visible from the Ticket page, so that排障不用先 ssh 上去。
26. As an operator, I want a machine health entry（与现有 HealthBoard 同一机制）for each daemon, so that panel 的 system problems 能定位到某台机器。
27. As an operator, I want the management API to manage machines over loopback with the same origin rules as today, so that agents can script machine ops without opening the network.
28. As a policy author, I want Policy change notices delivered to live Tickets even when they run remotely, so that规则变更语义不变。
29. As a team, I want prompt text（Delivery requirements、auto-merge 条件、commit 身份）unchanged by machine choice, so that交付质量不因机器而异。

## Implementation Decisions

- **域模型零新增**：复用 001 的词汇（Source、Thread、Eval、Mandate、Ticket、Assignment、Subscription、Channel、Policy、Report、Execution environment）。“机器”是部署（deployment）属性，不是域概念；“在哪跑”是 Assignment 的执行绑定，不进 Engine 的授权核心。全面复用现有准入表、强度（explicit/inferred）、工单阶段表语义。
- **Seams（只有两个，取最高处，贴现有接缝）**：
  - 缝 1（执行）：现有的 Executor 端口。Engine 只认过去式事实（assignmentStarted、inputsDelivered、inputsRead、turnEnded、deliveryFailed、report、assignmentInterrupted），不认“怎么跑的”。新实现与现有 DSH Executor 实现同一端口，Engine 零改。
  - 缝 2（存储）：现有的 Store 仓储口（原子事务 + Trigger/Thread/Ticket/Decision 读写 + Effect 队列 + Outbox 收据 + KV）。云端化只换驱动，不改上层读写语义。理想情况全库只动这两个接缝。
- **分两阶段交付，顺序固定**：
  - 阶段 A（先做）：Loop 与执行分离，Loop 还在单机，但 Executor 可选本地或远端 daemon。验证全部 Ticket 语义在远端成立后再动存储。
  - 阶段 B（后做）：存算分离，Loop 进云端无状态容器 + Session/Store 进数据库。阶段 A 的 daemon 协议保持不变，只是对端从“单机 Loop”变成“云端 Loop”。
- **Daemon 协议（决策 rich 部分，来自原型中 Executor 行为的提炼，非完整 demo）**：daemon 是无状态执行面，不存 Ticket，不做授权判断，只做以下五组调用并回传结构化结果；超时、截断、后台规则与今天单机一致：
  - `prepare { ticket, env } → { ok, output }`（10 分钟超时；失败不自动重试；空目录失败删除、非空保留，与今天一致）
  - `run { cwd, argv, env } → { exitCode, stdout, stderr }`（stdout/stderr 同今天的截断上限；argv 不回显进错误，避免把消息文本带进日志）
  - `jobs { list, kill, collect, wait }`（5 秒转后台、30 分钟上限、handoff 松绑、结束时 kill 语义不变）
  - `fs { mkdir, stat, verify }`（目录校验规则不变；仓库内私配 credential 直接按今天规则判失败）
  - `health { heartbeat, load }`（给 HealthBoard 的每机器条目供数；连续失败 3 次才报系统问题，与现有 effect 健康规则一致）
- **执行环境一致性**：Execution environment 变量表（key/value/description）原样透传，prepare 以环境变量读、Executor Session 以指令读；变量永不含密钥。agent 命令垫片（gh/lark-cli 指向 agent 身份）与 git credential 配置由 daemon 在本机生成并校验，校验失败按今天的 setup problem 文案報錯。blockedCommands 按名拒绝，但按今天文档注明“防君子不防绝对路径”，不做新的安全承诺。
- **路由决策归属**：机器选择是路由（主 Session/Eval 侧）的事，不是 Engine 的事。accept 时的 outcome 附带目标机器（或标签）；`ticketExecution` 的目录根从“stateDir 下的 work”变为“目标机器的 execution root + 工单短名”，命名规则（短名 + 12 位 Ticket 后缀）不变。默认路由 = 本机，保证老部署零改可用。
- **并发与暂停语义平移**：worker slot 计数改为“每机器配额 + 全局上限”，人消息/状态查询可挤占一个额外 slot 并优先拿下一个空闲 slot 的规则不变。Loop 侧 pause 仍冻住 launch/delivery/reply；机器侧 drain 只冻该机器的新 launch，运行中走完。
- **恢复语义平移**：Loop 重启 → 运行中 Assignment 按今天规则中断并带恢复说明重建（oldest Ticket first）；机器掉线 → 其 running Assignment 按“被中断”上报，Inputs 未读部分保留，重连后重投；排队中 Assignment 留在队列。重启/掉线都不自动重跑失败的 prepare。
- **可观测与审计**：Assignment 记录执行机器；Ticket 页展示机器、prepare 输出、命令输出；Trigger→Decision→Ticket→Assignment→Report 链上机器字段可查。面板复用现有 stage 徽标体系，不新增一套状态色。
- **兼容与隔离**：单机部署是“目标机器 = 本机”的特例。隔离声明与今天一致：以 operator OS 用户运行、可按绝对路径执行、读 operator 家目录；强隔离需求仍走“专用 OS 账号只放 agent 凭证”。daemon 不扩大该承诺。

## Testing Decisions

- 只测外部行为，不测实现细节：断言 Ticket 阶段、Report 序列、Inputs 顺序、恢复说明存在性、审计链机器字段，不 assert 内部轮询次数或 SQL 形状。
- 测缝 1（Executor 端口）：用内存版仓储复用现有域测试（domain tests）的打法，构造“远端 daemon 桩”（prepare 成功/失败、run 超时、机器掉线、重连）走完整 Ticket 生命周期；对照现有单机 Executor 测试的期望（prepare 失败即 fail、后台 30 分钟 kill、handoff 释放 slot）。
- 测缝 2（Store 驱动）：同一组仓储读写用例跑两遍（sqlite 现状 vs 新驱动），含 Effect 队列合并/重试/保序、Outbox 收据三振、重启恢复（interrupted Assignment 重建顺序）。
- 现有测试即先验：core-engine（接收/Eval/扇出/resume/stop/中断 Assignment/pause/Policy 变更/report/attach/失败投递）、stage（阶段表逐行）、background（shell jobs/subagents 等待与 kill）、effects（合并/限流/重试退避/关机）、passes（单 pass 串行）。新增 daemon 契约测试放在同一风格下，不另起框架。
- 端到端只保留一条：单测全过后，一 Ticket 走“远端 prepare→run→report ready”，机器中途掉线一次，恢复后 Ticket 照常结束。

## Out of Scope

- 不做跨 Source 身份映射（001 已拒绝的概念），机器选择不引入“用户在 A 机器的身份等于在 B 机器的身份”。
- 不做 GitHub Enterprise Server、不做多仓库多 checkout 的调度器（仍是一 Ticket 一目录）。
- Daemon 不做通用 CI 算力池（自动扩缩容、按需计费、GPU 调度），只做“用户自己的若干台机器”。
- 不改 Policy 内容、不改研判提示词、不改合并/审批规则。
- 不把运维 SSH 插件（主机管理/批量命令/隧道/Web 终端）合并进来；那是人用的遥控器，不是 Executor 的传输面。
- 本 spec 不定云厂商选型、不定数据库选型，只定语义与接缝。

## Further Notes

- Issue tracker 与 triage label 词汇本次会话未提供，未能按 skill 流程发布到 tracker 并打 `ready-for-agent` 标签；若需发布，请先运行 `/setup-matt-pocock-skills` 提供 tracker 词汇，本文件可直接转贴。当前以仓库内文档形式交付，供审核 Agent 审阅。
- 术语一律采用 001 Domain 中英对照（Trigger 触发、Thread 线程、Eval 评估、Mandate 授权、Ticket 工单、Assignment 派工、Executor 执行器、Execution environment 执行环境、Report 报告）。
- 建议审核重点：缝是否足够高（能否真的只动两个接缝）、daemon 协议是否覆盖了现有 Executor 的全部隐性语义（5 秒/30 分钟/10 分钟三处超时、失败不 retry prepare、恢复说明、额外 slot）、阶段 A 是否可在不动 Engine 的前提下独立交付。
