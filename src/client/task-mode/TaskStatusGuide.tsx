import { CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import type { TaskReport } from "../../shared/taskTypes";
import type { TaskModeState } from "../../shared/taskModeTypes";
import { isTaskOutputFailure } from "../../shared/taskOutputRecovery.js";
import { hasTaskActionGuidance } from "../../shared/taskActionGuidance";

interface Props { state: TaskModeState; latestReport?: TaskReport; approvalCount: number }

export function TaskStatusGuide({ state, latestReport, approvalCount }: Props) {
  const active = ["planning", "working", "reviewing"].includes(state.phase);
  const previousBlock = [...state.runs].reverse().find(run => run.result?.status === "blocked")?.result;
  const currentBlock = state.runs.find(run => run.id === state.activeRunId)?.result;
  const outputReadFailure = state.runs.find(run => run.id === state.activeRunId)?.jobs.some(isTaskOutputFailure);
  const cause = (state.phase === "blocked" ? currentBlock?.stopReason || state.error : previousBlock?.stopReason)?.split(/[；。]/)[0];
  const guidance = currentBlock && hasTaskActionGuidance(currentBlock);

  if (state.phase === "awaiting_authorization") return <section className="tm-status-guide" data-state="review"><CircleAlert/><div><strong>待确认 · 授权请求</strong><p>左侧列出具体请求，点击顶部“批准授权”后继续执行。</p></div></section>;

  if (approvalCount > 0) return <section className="tm-status-guide" data-state="review" aria-label="当前任务需要你的确认">
    <CircleAlert /><div><strong>需要你处理 {approvalCount} 项 Codex 请求</strong><p>请查看左侧的具体授权内容，点击顶部“批准授权”后任务会继续。</p></div>
  </section>;

  if (active) return <section className="tm-status-guide" data-state="working" aria-label="当前任务需要你做什么">
    <Clock3 /><div><strong>当前无需你操作，任务正在继续</strong>
      <p>{state.phase === "planning" ? "正在确认任务目标和剩余交付项。" : state.phase === "reviewing" ? state.runs.find(run=>run.id===state.activeRunId)?.jobs.some(job=>job.purpose==="clarify_report"&&!job.processed) ? "代理正在补齐停下原因、用户行动和后续步骤，已有执行结果保留。" : "正在检查任务效果和验证证据。" : "正在实施并验证这项任务。"}{cause ? ` 上一轮停在“${cause}”，本轮正在复核和推进剩余工作。` : ""}</p>
      <small>下一步由代理汇报结果；若确实需要你决定或提供条件，页面会明确列出。</small>
    </div>
  </section>;

  if (state.phase === "blocked") return <section className="tm-status-guide" data-state="blocked" aria-label="任务暂停原因和下一步">
    <CircleAlert /><div><strong>任务未完成，当前执行已暂停</strong>
      <p><b>为什么停下：</b>{outputReadFailure ? "平台暂未识别有效的最终汇报，已保留原始消息、代码和执行记录。" : cause || "代理未提供明确的阻塞原因，请查看本轮验证和对话。"}</p>
      <p><b>你现在需要做什么：</b>{outputReadFailure ? "点击“重新读取汇报”，系统会重读原回合并沿用已有执行结果。" : guidance ? currentBlock.humanActions!.length ? currentBlock.humanActions!.map(item=>item.action).join("；") : "无需提供材料或决定。可点击‘继续执行剩余工作’执行下列代理步骤。" : currentBlock ? "点击‘补齐行动说明’，让代理明确列出需要你提供的条件及代理下一步，已有执行结果保留。" : latestReport?.nextStep || "请查看上方错误和 Codex 对话，解决提示的问题后点击‘重试执行’。"}</p>
      {guidance && currentBlock.agentNextSteps!.length > 0 && <p><b>接下来完成什么：</b>{currentBlock.agentNextSteps!.filter(step=>step.length<=240).slice(0,3).join("；")||"详细安排见本轮汇报。"}</p>}
    </div>
  </section>;

  if (state.phase === "needs_confirmation") return <section className="tm-status-guide" data-state="review" aria-label="任务等待验收">
    <CircleAlert /><div><strong>待验收 · 本轮已达到验收条件</strong><p>请查看下方汇报和审查材料，然后选择“验收通过”或“提出修改”。</p></div>
  </section>;

  if (state.phase === "completed") return <section className="tm-status-guide" data-state="done" aria-label="任务完成状态">
    <CircleCheck /><div><strong>本轮已完成</strong><p>如需继续推进，可在下方添加下一步指示。</p></div>
  </section>;

  return null;
}
