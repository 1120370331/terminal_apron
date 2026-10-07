import { Bot, Check, CircleAlert, FileText, FlaskConical, GitBranch, ListChecks, Play } from "lucide-react";
import type { TaskRunResult } from "../../shared/taskModeTypes";
import { MarkdownContent } from "../task-monitor/MarkdownContent";
import { hasTaskActionGuidance } from "../../shared/taskActionGuidance";
import { taskArtifactLink } from "../../shared/taskArtifactTypes";

interface Props {
  result: TaskRunResult;
  taskId: string;
  runId?: string;
  readOnly?: boolean;
  busy: boolean;
  canResume: boolean;
  followUpActive: boolean;
  approvalCount: number;
  onApprove: () => void;
  onRevise: () => void;
  onResume: () => void;
  canClarify: boolean;
  onClarify: () => void;
}

const verificationLabels = { passed: "通过", failed: "未通过", not_run: "未执行" } as const;

function readableCheck(value: string) {
  const text = value.trim().replace(/(\d+) passed\b/gi, "$1 项通过").replace(/(\d+) failed\b/gi, "$1 项失败").replace(/(\d+) errors?\b/gi, "$1 项报错");
  const boundary = text.search(/[。；]/);
  return boundary < 0 ? { lead: text || "未提供验证说明。", detail: "" } : { lead: text.slice(0, boundary + 1), detail: text.slice(boundary + 1).trim() };
}

export function TaskRunReport({ result, taskId, runId, readOnly=false, busy, canResume, canClarify, followUpActive, approvalCount, onApprove, onRevise, onResume, onClarify }: Props) {
  const guidance = hasTaskActionGuidance(result);
  const summary = result.summary.trim();
  const hasMarkdownSections = /^\s*#{1,4}\s+/m.test(summary);
  const sentences = hasMarkdownSections ? [] : summary.match(/[^。！？!?]+[。！？!?]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
  const headline = hasMarkdownSections ? "查看下方分章节汇报" : sentences[0] || "代理已结束本轮检查。";
  const explanation = sentences.slice(1);
  const risks = [...new Set(result.risks.map(value => value.trim()).filter(Boolean))];
  const failedChecks = result.verification.filter(item => item.result === "failed").length;
  const baselineAlsoFailed = result.verification.some(item => /(?:HEAD|原版本|基线).{0,40}(?:同样|一致|失败)/i.test(item.details || ""));
  const passed = result.verification.filter(item => item.result === "passed").length;
  const failed = result.verification.filter(item => item.result === "failed").length;
  const continuing=result.status==="in_progress";
  const nextSteps=result.agentNextSteps??[];
  const publicNextSteps=nextSteps.filter(step=>step.length<=240).slice(0,3);
  const internalNextSteps=[...new Set([...nextSteps.filter(step=>!publicNextSteps.includes(step)),...(result.internalNextSteps??[])])];
  const status = continuing ? "running" : result.status === "done" ? "done" : result.status === "blocked" ? "blocked" : "review";
  const statusLabel = continuing ? "推进中" : result.status === "done" ? "已完成" : result.status === "blocked" ? result.pauseCategory==="unclear_requirement"?"需求待澄清":result.pauseCategory==="exception"?"异常":"阻塞" : "待确认";
  const statusTitle = continuing ? "阶段进展已记录，代理正在继续完成剩余工作" : result.status === "done" ? "本轮目标已完成" : result.status === "blocked" ? "本轮有进展，任务尚未完成" : "执行已结束，等待你的确认";

  return <article className="tp-result tm-report">
    <header className="tm-report-header">
      <span className="tm-report-kicker"><Bot /> 阶段汇报</span>
      <span className="tp-status" data-status={status}><span className="tp-dot" />{statusLabel}</span>
    </header>
    {runId && <a className="tp-button tm-report-document" href={taskArtifactLink(taskId, {runId})} target="_blank" rel="noreferrer"><FileText />查看完整汇总<span>新标签打开 ↗</span></a>}
    <section className="tm-report-section tm-report-conclusion">
      <h4>结论</h4>
      <strong>{statusTitle}</strong>
      <p>{headline}</p>
    </section>
    {result.status === "blocked" && <section className="tm-report-section tm-report-stop">
      <h4><CircleAlert /> 为什么这一轮停下</h4>
      <p>{result.stopReason || "这份旧汇报缺少明确停下原因，需要代理补齐行动说明。"}</p>
      {failedChecks > 0 && <small>另有 {failedChecks} 项检查未通过；这不自动表示都是本次代码引入的问题，逐项说明见“验证情况”。</small>}
      {baselineAlsoFailed && <small>其中有检查在原版本上也失败，代理需要先区分原有问题与本次回归。</small>}
    </section>}
    {result.status !== "done" && <section className="tm-report-section tm-report-next">
      <h4>你需要做什么</h4>
      {approvalCount > 0 && <p>当前有 {approvalCount} 项 Codex 请求等待确认，请查看页首的确认卡。</p>}
      {guidance ? result.humanActions!.length > 0 ? <ol className="tm-report-human-actions">{result.humanActions!.map((item,index) => <li key={index}><strong>{item.action}</strong><p>为什么需要你：{item.reason}</p><p>完成后：{item.unblocks}</p></li>)}</ol> : <p>{continuing ? "当前无需操作，代理正按下方步骤继续推进到可验收。" : "本轮无需你提供材料或决定。"}{canResume ? "请点击‘继续执行剩余工作’，代理将按下方清单推进。" : ""}{continuing ? "" : followUpActive ? "代理正在处理下一轮。" : result.status === "needs_confirmation" ? "请审查本轮结果，确认通过或提出修改。" : "下方列出了代理负责的剩余工作。"}</p> : <><p>这份汇报缺少具体行动说明，无法判断需要你提供什么。请点击“补齐行动说明”，代理会列出所需条件、提交方式及后续工作。</p><small>该操作保留已有代码、产物和发布候选，只补充报告。</small>{!readOnly && canClarify && <button className="tp-button tp-primary" disabled={busy} onClick={onClarify}>补齐行动说明</button>}</>}
      {guidance && publicNextSteps.length > 0 && <><h4>接下来完成什么</h4><ol>{publicNextSteps.map((step,index) => <li key={index}>{step}</li>)}</ol></>}
      {guidance && internalNextSteps.length > 0 && <details className="tm-report-internal"><summary>执行安排与技术细节</summary><ol>{internalNextSteps.map((step,index)=><li key={index}>{step}</li>)}</ol></details>}
      {!readOnly && canResume && guidance && <button className="tp-button tp-primary" disabled={busy} onClick={onResume}><Play />{result.humanActions!.length > 0 ? "已补充条件，继续执行" : "继续执行剩余工作"}</button>}
    </section>}
    {(hasMarkdownSections || explanation.length > 0) && <section className="tm-report-section">
      <h4><ListChecks /> 进展说明</h4>
      {hasMarkdownSections ? <MarkdownContent source={summary} /> : explanation.map((sentence, index) => <p key={index}>{sentence}</p>)}
    </section>}
    {result.verification.length > 0 && <details className="tm-report-section tm-report-validation">
      <summary><FlaskConical /> 验证情况 <span className="tm-report-section-count">{passed} 项通过{failed > 0 ? ` · ${failed} 项未通过` : ""}{result.verification.length - passed - failed > 0 ? ` · ${result.verification.length - passed - failed} 项未执行` : ""}</span></summary>
      <div className="tm-report-checks">{result.verification.map((check, index) => {
        const explanation = readableCheck(check.details || "");
        return <article className="tm-report-check" key={`${check.command}-${index}`}>
          <span className="tm-report-check-status" data-result={check.result}>{verificationLabels[check.result]}</span>
          <div><p>{explanation.lead}</p>{explanation.detail && <details><summary>查看详细说明</summary><p>{explanation.detail}</p></details>}<details><summary>查看原始命令</summary><code>{check.command}</code></details></div>
        </article>;
      })}</div>
    </details>}
    {risks.length > 0 && <section className="tm-report-section">
      <h4><CircleAlert /> 未完成与风险</h4>
      <ul className="tm-report-risks">{risks.slice(0, 3).map((risk, index) => <li key={index}>{risk}</li>)}</ul>
      {risks.length > 3 && <details className="tm-report-more"><summary>查看其余 {risks.length - 3} 项</summary><ul className="tm-report-risks">{risks.slice(3).map((risk, index) => <li key={index + 3}>{risk}</li>)}</ul></details>}
    </section>}
    {result.changedFiles.length > 0 && <section className="tm-report-section">
      <details className="tm-report-changes"><summary><GitBranch /> 代码改动 · {result.changedFiles.length} 个文件</summary>
        {result.changes.length ? result.changes.map((change, index) => <div key={`${change.path}-${index}`}><strong>{change.path}</strong><pre className="tp-diff">{change.diff || "本次工具记录没有提供 Diff"}</pre></div>) : <ul>{result.changedFiles.map(file => <li key={file}>{file}</li>)}</ul>}
      </details>
    </section>}
    {result.artifacts.length > 0 && <section className="tm-report-section tp-review-artifact">
      <h4>重要审查材料</h4>
      {result.artifacts.map(file => {
        if (file.deleted) return <p key={file.id}>{file.name} · 已删除</p>;
        const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimeType);
        const preview = Boolean(file.previewFormat) || image;
        const href = file.previewFormat ? file.previewUrl ?? taskArtifactLink(taskId, { attachmentId: file.id }) : image ? file.url : `${file.url}${file.url.includes("?") ? "&" : "?"}download=1`;
        return <a href={href} target={preview ? "_blank" : undefined} rel={preview ? "noreferrer" : undefined} download={preview ? undefined : true} key={file.id}>{image && <img className="tp-art-image" src={file.url} alt={file.name} />}<span>{preview ? "预览" : "下载"} · {file.name}{file.previewFormat ? ` · ${file.previewFormat === "html" ? "HTML" : "Markdown"}` : ""}{preview ? " ↗" : ""}</span></a>;
      })}
    </section>}
    {!readOnly && result.status === "needs_confirmation" && <div className="tp-row tm-report-actions"><button className="tp-button tp-primary" disabled={busy} onClick={onApprove}><Check /> 确认通过</button><button className="tp-button" onClick={onRevise}>提出修改</button></div>}
    {result.reviewedAt && <p className="tp-small tp-muted tm-report-reviewed">人工确认于 {new Date(result.reviewedAt).toLocaleString()}</p>}
  </article>;
}
