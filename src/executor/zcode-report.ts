/** ZCode worker 的纯文本契约：`-p` 提示词构造、回复末尾 RESULT 块的解析，以及到 WorkerReport 的映射；不接触进程与 Engine。 */
import type { WorkerReport } from '../core/assignments.ts'
import type { ReportState } from '../core/model.ts'

/** RESULT 块六个键的恰序，构造与解析共用；顺序错即视为违反约定而不是宽容修正。 */
const KEYS = ['status', 'summary', 'branch', 'head', 'pr', 'next'] as const
type ResultKey = (typeof KEYS)[number]
/** 解析成功的一个 RESULT 块：`status` 限于三种终态，其余字段为逐字值，无信息时是字面 `none`。 */
export interface ParsedResult { status: 'ready' | 'blocked' | 'failed'; summary: string; branch: string; head: string; pr: string; next: string }

/** 发给 worker 的固定尾部指令。为什么固定：worker 的回复是唯一的回传通道，结尾约定必须逐字稳定，解析端才能机器可判。 */
const BRIEF_TAIL = ['', '完成后，在回复的最后输出一个 RESULT 块：共六行，每行格式恰为 key: value（冒号加空格），键的顺序必须是：',
  'status: 只能是 ready、blocked、failed 之一', 'summary: 一句话结果', 'branch: 分支名', 'head: 最新提交的提交号', 'pr: PR 编号或链接',
  'next: 建议的下一步', '没有对应信息时该行的值写 none；块可以用一对 ``` 围栏包裹。'].join('\n')

/** 构造发给 ZCode `-p` 的全文：assignment 原文在前（不得改写），尾接固定的 RESULT 块指令。 */
export function buildWorkerBrief(assignment: string): string {
  return `${assignment}${BRIEF_TAIL}`
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
  if (status !== 'ready' && status !== 'blocked' && status !== 'failed') return null
  // status 放在展开之后：让收窄出的三值字面量类型留在返回值里，不被 Record 的 string 覆盖。
  return { ...values, status }
}
/** mapToWorkerReport 的输入：worker 进程如何结束，与其回复中解析出的块。 */
export interface WorkerOutcome {
  parsed: ReturnType<typeof parseResultBlock>
  exitCode: number | null
  timedOut: boolean
  stderrTail?: string
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
export function mapToWorkerReport({ parsed, exitCode, timedOut, stderrTail }: WorkerOutcome): WorkerReport {
  if (timedOut) return { state: 'failed', summary: withTail('运行超时：worker 超过时限被终止，回复可能被截断，结果不可信。', stderrTail) }
  // exitCode 为 null 是被杀而非自行退出，与非零同属失败，只是措辞区分，便于人排查。
  if (exitCode === null) return { state: 'failed', summary: withTail('worker 进程被终止（无退出码），未得到可信的执行结果。', stderrTail) }
  if (exitCode !== 0) return { state: 'failed', summary: withTail(`worker 进程以退出码 ${exitCode} 失败。`, stderrTail) }
  // 绿色退出后仍无块，才归因于回复违反了结尾约定。
  if (!parsed) return { state: 'failed', summary: withTail('worker 已结束，但回复中没有可解析的 RESULT 块（缺失或不符合六行键序约定）。', stderrTail) }
  // 块的 status 只可能是三种终态之一，state 因此不会出现 ready 之外的猜测路径。
  const state: ReportState = parsed.status
  return { state, summary: composeSummary(parsed) }
}
