/** ZCode worker 的纯文本契约：`-p` 提示词构造、回复末尾 RESULT 块的解析，以及到 WorkerReport 的映射；不接触进程与 Engine。 */
import type { WorkerReport } from '../core/assignments.ts'
import type { ReportState } from '../core/model.ts'

/** RESULT 块六个键的恰序，构造与解析共用；顺序错即视为违反约定而不是宽容修正。 */
const KEYS = ['status', 'summary', 'branch', 'head', 'pr', 'next'] as const
type ResultKey = (typeof KEYS)[number]
/** 解析成功的一个 RESULT 块：`status` 限于四种终态，其余字段为逐字值，无信息时是字面 `none`。 */
export interface ParsedResult { status: 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; branch: string; head: string; pr: string; next: string }

/** 发给 worker 的固定尾部指令。为什么固定：worker 的回复是唯一的回传通道，结尾约定必须逐字稳定，解析端才能机器可判。
 * 头行必须点名：真机首跑发现模型会省略字面 RESULT 头而只给普通围栏，严格解析器按设计拒绝——指令必须把头行钉死。 */
const BRIEF_TAIL = ['', '完成后，在回复的最后输出一个 RESULT 块。块的第一行必须恰为字面 RESULT（整行只有这一个词；若用围栏，开头写成 ```RESULT）：',
  '随后共六行，每行格式恰为 key: value（冒号加空格），键的顺序必须是：',
  'status: 只能是 ready、blocked、failed、dropped 之一', 'summary: 一句话结果', 'branch: 分支名', 'head: 最新提交的提交号', 'pr: PR 编号或链接',
  'next: 建议的下一步',
  'dropped 只在没有可交付的改动或无事可做时用（请求不成立、已被别处完成），它让票直接结束、不打扰人；其余情况用 ready 或 blocked。',
  '没有对应信息时该行的值写 none；RESULT 头行与六个键一行都不可省略。'].join('\n')

/** 发给 worker 的固定开头：一次性进程没有 session 级提示词，工作区、提交与交付约定只能在这里说清。 */
const BRIEF_INTRO = '你在下面这个工作目录里完成一张工单的请求。改动提交到当前分支；不要新建 worktree、不要切换分支、不要合并。'
/** 工作规则：DSH worker 从 `prompts/work.md` 拿到这些，一次性进程没有会话级提示词，只能由 brief 承担这一份最小集。 */
const BRIEF_RULES = ['工作规则：',
  '- 只做请求范围内的事；需要产品决策、扩大公开接口或碰到凭据/配置，就停下报 blocked，不要自行扩张范围，也不要提问（没有人会回答）。',
  '- 动手前先读仓库里的 AGENTS.md / CLAUDE.md（若有），遵守它的验证与提交约定，提交信息用仓库风格。',
  '- 改动必须自己跑相关检查（测试 / typecheck / lint），把跑过什么写进 summary；没跑过就直说没跑。',
  '- 不合并、不 force push、不删分支、不装依赖、不改与请求无关的代码。',
  '- 做不完报 blocked 并写清剩余工作；没有可交付的改动或无事可做报 dropped。'].join('\n')

/** 交付约定：与 DSH worker 一致，代码改动要 push 并开 draft PR，否则 ready 的票会以"本地提交"收尾、交付链断在本地。 */
const BRIEF_DELIVERY = '交付：代码改动提交后把当前分支 push 到 origin，并用 gh 开一个 draft PR，把 PR 链接写进 RESULT 的 pr 字段；'
  + 'push 或开 PR 失败就报 blocked 并在 summary 里写清失败原因。不要合并、不要开 auto-merge。'

/** composeBriefBody 的输入：票面、assignment、授权说明与原始请求；请求被截断时再带上总数与全文位置。 */
export interface WorkerBriefBody {
  /** The ticket's title. */
  title: string
  /** The ticket's assignment text: a routing note, or the scope of a proactively accepted ticket; omitted when empty. */
  assignment?: string
  /** Instructions the ticket's mandate adds beyond the request, such as the narrower authority of an inferred ticket. */
  mandate?: string
  /** The origin request's text, already capped by the caller. */
  request: string
  /** Total characters of the request before capping; present only when the caller capped it. */
  requestChars?: number
  /** Absolute path of the full request, present only when it was capped and written out. */
  requestRead?: string
}

/**
 * 组装交给 ZCode 的任务正文：票面、assignment、授权说明、原始请求。
 * 为什么请求必须在这里：`ticket.execution.assignment` 只带路由注记——原型由 launch 单独投递 origin trigger，
 * 而 ZCode 没有那条投递通道，请求正文只能由 brief 补上，否则 worker 收到的是一张没有任务的票。
 */
export function composeBriefBody({ title, assignment, mandate, request, requestChars, requestRead }: WorkerBriefBody): string {
  const parts = [BRIEF_INTRO, BRIEF_RULES, BRIEF_DELIVERY, `工单：${title}`]
  const note = assignment?.trim()
  if (note) parts.push(`assignment：${note}`)
  if (mandate) parts.push(mandate)
  parts.push(`请求：\n${request}`)
  // 截断时给出总数与全文位置：worker 能去读完整正文，不会把"开头部分"当成全部。
  if (requestChars !== undefined) parts.push(`（请求正文共 ${requestChars} 字，以上为开头部分${requestRead ? `；完整正文见 ${requestRead}` : ''}。）`)
  return parts.join('\n\n')
}
/** 构造发给 ZCode `-p` 的全文：正文在前（不得改写），尾接固定的 RESULT 块指令。 */
export function buildWorkerBrief(body: string): string {
  return `${body}${BRIEF_TAIL}`
}
/** 块头判定：整行去空白后恰为三种形态之一，`RESULT` 出现在行中间不算是新块。 */
const isHeader = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed === 'RESULT' || trimmed === '```RESULT' || trimmed === '```RESULT```'
}
/**
 * 取文本中最后一个 RESULT 块。为什么取最后：worker 可能先贴出中间过程再给结论，结论是最后的块；最后一块若坏，
 * 也不回退到前面的块——那可能是被截断的残块，宽容回退会把旧结论当成最终结论。
 */
export function parseResultBlock(text: string): ParsedResult | null {
  const lines = text.split('\n')
  let start = -1
  for (const [index, line] of lines.entries()) if (isHeader(line)) start = index
  if (start < 0) return null
  const values = {} as Record<ResultKey, string>
  let cursor = start + 1
  for (const expected of KEYS) {
    // 只跳过空白行：任何非空且非期望键的行都按乱序或缺键判 null，避免把别的段落误收进块。
    while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++
    const line = lines[cursor]
    const prefix = `${expected}: `
    if (line === undefined || !line.trimStart().startsWith(prefix)) return null
    values[expected] = line.trimStart().slice(prefix.length).trim()
    cursor++
  }
  const { status } = values
  // 块后的围栏收尾与尾随文本不校验：解析在第六个键后即结束，后面是什么与结果无关。
  if (status !== 'ready' && status !== 'blocked' && status !== 'failed' && status !== 'dropped') return null
  // status 放在展开之后：让收窄出的三值字面量类型留在返回值里，不被 Record 的 string 覆盖。
  return { ...values, status }
}
/** mapToWorkerReport 的输入：worker 进程如何结束，与其回复中解析出的块。 */
export interface WorkerOutcome {
  parsed: ReturnType<typeof parseResultBlock>
  exitCode: number | null
  timedOut: boolean
  stderrTail?: string
  /** stdout 曾滑出收集窗口：无块失败时要如实归因「可能被截掉」，不误导成 worker 违约。 */
  outputTruncated?: boolean
}
/** 附加 stderr 末尾。为什么：失败结论往往藏在最后的输出里，summary 是人唯一会读的字段。 */
const withTail = (summary: string, stderrTail?: string): string => {
  const tail = stderrTail?.trim()
  return tail ? `${summary}\n输出末尾：\n${tail}` : summary
}
/** `none` 与空同样视为无信息，组合 summary 时省略。 */
const meaningful = (value: string): boolean => {
  const text = value.trim()
  return text !== '' && text !== 'none'
}
/** 把块的字段无损组合成一行段落的 summary：逐字段带键名保留，无信息的字段省略。 */
const composeSummary = (parsed: ParsedResult): string => {
  const lines = KEYS.filter(key => key !== 'status' && meaningful(parsed[key])).map(key => `${key}: ${parsed[key].trim()}`)
  // 六个字段全无信息时，status 是仅存的事实，保留它以免给出空 summary。
  return lines.length ? lines.join('\n') : `status: ${parsed.status}`
}
/**
 * 把 worker 的结束方式与其回复映射为 WorkerReport。判定顺序即可信度顺序：超时最先（回复可能被截断，块不可信），
 * 其次退出码（非零或被杀都拿不到可信结论），然后才是块本身。
 * 铁律：只有 parsed.status === 'ready' 且 exitCode === 0 且未超时才产出 ready——任何路径都不猜 ready。
 */
export function mapToWorkerReport({ parsed, exitCode, timedOut, stderrTail, outputTruncated }: WorkerOutcome): WorkerReport {
  if (timedOut) return { state: 'failed', summary: withTail('运行超时：worker 超过时限被终止，回复可能被截断，结果不可信。', stderrTail) }
  // exitCode 为 null 是被杀而非自行退出，与非零同属失败，只是措辞区分，便于人排查。
  if (exitCode === null) return { state: 'failed', summary: withTail('worker 进程被终止（无退出码），未得到可信的执行结果。', stderrTail) }
  if (exitCode !== 0) return { state: 'failed', summary: withTail(`worker 进程以退出码 ${exitCode} 失败。`, stderrTail) }
  // 绿色退出后仍无块，才归因于回复违反了结尾约定；输出被截断时改归因于截断。
  if (!parsed) return {
    state: 'failed',
    summary: withTail(outputTruncated
      ? 'worker 已结束，输出超过收集上限被截断，RESULT 块可能因此丢失。'
      : 'worker 已结束，但回复中没有可解析的 RESULT 块（缺失或不符合六行键序约定）。', stderrTail),
  }
  // 块的 status 只可能是四种终态之一，state 因此不会出现 ready 之外的猜测路径。
  const state: ReportState = parsed.status
  return { state, summary: composeSummary(parsed) }
}
