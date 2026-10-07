import { Clock3, Gauge } from "lucide-react";
import type { TaskThreadUsage, TaskUsageSummary } from "../../shared/taskUsageTypes";
import { windowLabel } from "./codexUsageView";
import "./taskUsage.css";
import { taskProcessedTimeView, type TaskProcessingTime } from "./taskProcessedTime";

export function TaskProcessedTimeBadge({ processing, now }: { processing?: TaskProcessingTime; now: number }) {
  const view = taskProcessedTimeView(processing, now);
  return <span className="task-usage-badge tp-processed-time" data-coverage={view.partial ? "partial" : "complete"} title={view.title}><Clock3 />{view.label}{view.value && <span>{view.value}</span>}{view.partial && <small>部分记录</small>}</span>;
}

type Usage = TaskThreadUsage | TaskUsageSummary;
export function millions(value: number): string { return value > 0 && value < 50000 ? "<0.1M" : `${(value / 1e6).toFixed(1)}M`; }
export function oneDecimal(value: number): string { return value > 0 && value < .05 ? "<0.1" : value.toFixed(1); }
function moneyText(value: number, currency: "USD" | "CNY"): string { const amount = oneDecimal(value); return `${amount.startsWith("<") ? "<" : ""}${currency === "USD" ? "$" : "¥"}${amount.replace(/^</, "")}`; }

export function TaskUsageBadge({ usage, compact = false }: { usage?: Usage; compact?: boolean }) {
  if (!usage || usage.mode === "unknown") return <span className="task-usage-badge task-usage-pending"><Gauge />用量读取中</span>;
  const subscription = usage.mode === "subscription";
  const cost = usage.relayCost;
  const caption = subscription ? usage.tokens ? millions(usage.tokens.totalTokens) : "Tokens —" : cost ? moneyText(cost.amount, cost.currency) : usage.mode === "mixed" ? "混合计费" : "费用 —";
  const title = subscription ? `当前${"threads" in usage ? "任务" : "对话"}累计 ${usage.tokens?.totalTokens.toLocaleString() ?? "未返回"} Tokens。预估额度采用 Codex 返回值；账户窗口用量是整个订阅账户的统计。` : cost ? `预估已消耗金额：${cost.amount.toFixed(6)} ${cost.currency}，${cost.source === "codex" ? "由 Codex 返回" : "按已设置的中转费率和真实用量估算"}。` : "中转只展示费用；可在 Codex 信息中设置中转费率，或等待服务返回金额。";
  return <span className="task-usage-badge" data-mode={usage.mode} title={title}><Gauge /><span>{caption}</span>{subscription && "complete" in usage && !usage.complete && <small>部分</small>}{!compact && subscription && usage.estimatedCredits !== null && <small>预估额度 {oneDecimal(usage.estimatedCredits)} credits</small>}{!compact && subscription && usage.accountQuota && <small>账户已用 {usage.accountQuota.usedPercent.toFixed(1)}%</small>}{!subscription && cost && !compact && <small>预估费用</small>}</span>;
}

export function TaskUsagePanel({ usage }: { usage?: TaskUsageSummary }) {
  if (!usage) return null;
  const subscription = usage.mode === "subscription";
  return <details className="tm-task-usage"><summary><span>任务用量</span><TaskUsageBadge usage={usage} /><span className="task-usage-open-hint">查看明细</span></summary><div className="task-usage-body">
    {subscription && usage.tokens && <div className="task-usage-numbers"><div><span>累计 Tokens</span><strong>{millions(usage.tokens.totalTokens)}</strong></div><div><span>输入</span><strong>{millions(usage.tokens.inputTokens)}</strong></div><div><span>缓存命中</span><strong>{millions(usage.tokens.cachedInputTokens)}</strong></div><div><span>输出</span><strong>{millions(usage.tokens.outputTokens)}</strong></div></div>}
    {subscription && <p className="task-usage-note">缓存属于输入，推理已计入输出。订阅额度没有固定的 Token 换算比例；{usage.estimatedCredits === null ? "Codex 暂未返回对话级预估额度。" : `本任务预估使用 ${oneDecimal(usage.estimatedCredits)} credits。`}{usage.accountQuota && <> 当前账户{windowLabel(usage.accountQuota.windowMinutes)}已用 {usage.accountQuota.usedPercent.toFixed(1)}%，包含其他会话。</>}</p>}
    {usage.mode === "relay" && <p className="task-usage-note">中转展示已消耗金额。{usage.relayCost ? usage.relayCost.source === "codex" ? "金额采用服务返回的预估值。" : "金额按配置费率和真实输入、缓存、输出用量估算，最终账单以中转服务为准。" : usage.threads.some(thread => thread.relayCost) ? "部分对话的金额或币种不同，请按对话查看。" : "当前服务未返回金额，且尚未设置可用于估算的中转费率。"}</p>}
    {usage.mode === "mixed" && <p className="task-usage-note">此任务包含不同计费方式，请按对话查看用量与费用。</p>}
    <div className="task-usage-threads">{usage.threads.map(thread => <div key={thread.threadId}><span title={thread.name}>{thread.name}</span><TaskUsageBadge usage={thread} compact /></div>)}</div>
    {usage.mode !== "subscription" && <a className="task-usage-rates-link" href="/task-monitor/?mode=task-mode&screen=codex&codexTab=settings">调整中转估算费率</a>}
    {usage.updatedAt && <small className="task-usage-updated">用量更新于 {new Date(usage.updatedAt).toLocaleTimeString()}</small>}
  </div></details>;
}
