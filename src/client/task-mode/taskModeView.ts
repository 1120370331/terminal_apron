import type { TaskItem } from "../../shared/taskTypes";
import type { TaskModeList, TaskModeViewPreferences } from "../../shared/taskModeTypes";
export const MODE_STATUSES = ["not_started","in_progress","recovering","pending_manual_acceptance","blocked","paused","done"] as const;
export const STATUS_NAMES:Record<string,string>={not_started:"未开始",in_progress:"进行中",recovering:"自动恢复中",pending_manual_acceptance:"待人工确认",pending_auto_acceptance:"代理检查中",blocked:"阻塞",paused:"已暂停",done:"已完成"};
export const POLICY_NAMES:Record<string,string>={auto:"自动拆分",parallel:"偏好多 Worker",single:"单 Worker"};
export type ModeSummary=TaskModeList["states"][number];
export function visibleStatus(task:TaskItem,state?:Pick<ModeSummary,"phase"|"instructionCount"|"heartbeat">):string {
  if(!state?.instructionCount)return task.status==="pending_auto_acceptance"?"in_progress":task.status;
  if(state.heartbeat?.status==="recovering"&&["planning","working","reviewing"].includes(state.phase))return "recovering";
  return ({idle:task.status,planning:"in_progress",working:"in_progress",reviewing:"in_progress",paused:"paused",blocked:"blocked",needs_confirmation:"pending_manual_acceptance",completed:"done"} as Record<string,string>)[state.phase]??task.status;
}
export function localDay(value:string|Date|undefined):string {if(!value)return "";const date=new Date(value);if(Number.isNaN(date.getTime()))return "";return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
export function filterTasks(tasks:TaskItem[],states:Map<string,ModeSummary>,view:TaskModeViewPreferences,today=new Date()) {
  const f=view.filters;const day=localDay(today);let start="",end="";
  if(f.period==="custom"){start=f.start;end=f.end;}else if(f.period!=="all"){const date=new Date(today);date.setDate(date.getDate()-(f.period==="yesterday"?1:f.period==="7"?6:f.period==="30"?29:0));start=localDay(date);end=f.period==="yesterday"?start:day;}
  const positions=new Map(view.taskOrder.map((id,index)=>[id,index]));const manual=(a:TaskItem,b:TaskItem)=>(positions.get(a.id)??1e9)-(positions.get(b.id)??1e9)||b.createdAt.localeCompare(a.createdAt);
  return tasks.filter(task=>{const state=states.get(task.id),status=visibleStatus(task,state);if(f.query&&!`${task.title} ${task.key} ${task.descriptionMd} ${task.tags.join(" ")}`.toLowerCase().includes(f.query.toLowerCase()))return false;
    if(f.status!=="all"&&(f.status==="unfinished"?status==="done":f.status==="attention"?!["pending_manual_acceptance","blocked"].includes(status):status!==f.status))return false;
    if(f.project!=="all"&&task.project!==f.project)return false;if(f.tag&&!task.tags.some(tag=>tag.toLocaleLowerCase()===f.tag.toLocaleLowerCase()))return false;if(f.policy!=="all"&&(state?.settings.workerPolicy??"auto")!==f.policy)return false;
    if(f.material==="attachments"&&!task.attachments.length)return false;if(f.material==="review"&&status!=="pending_manual_acceptance")return false;if(f.material==="code"&&!task.latestReport?.changedFiles.length)return false;
    if(start&&end&&start>end)return false;
    if(f.period!=="all"){const value=localDay(task[f.dateField]);if(!value||start&&value<start||end&&value>end)return false;}return true;
  }).sort((a,b)=>{if(f.sort==="manual")return manual(a,b);const field=f.sort.startsWith("created")?"createdAt":f.sort.startsWith("completed")?"completedAt":"updatedAt";const av=a[field],bv=b[field];if(!av)return bv?1:manual(a,b);if(!bv)return -1;return (f.sort.endsWith("asc")?av.localeCompare(bv):bv.localeCompare(av))||manual(a,b);});
}
export function reorder(order:string[],all:string[],source:string,target:string,after=false):string[] {const result=[...new Set([...order.filter(id=>all.includes(id)),...all])];if(source===target||!result.includes(source)||!result.includes(target))return result;result.splice(result.indexOf(source),1);result.splice(result.indexOf(target)+(after?1:0),0,source);return result;}
export const taskLink=(id:string)=>`/task-monitor/?mode=task-mode&task=${encodeURIComponent(id)}`;
export const documentLink=(id:string)=>`/task-monitor/?mode=task-mode&document=${encodeURIComponent(id)}`;
export function taskExcerpt(markdown:string) {return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g,"$1").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[#*`>_]/g,"").replace(/\s+/g," ").trim();}
export function referencesFromMarkdown(markdown:string,taskId:string) {return {referenceTaskIds:[...new Set([...markdown.matchAll(/(?:\?|&)task=([0-9a-f-]{36})/gi)].map(match=>match[1]))].filter(id=>id!==taskId),documentIds:[...new Set([...markdown.matchAll(/(?:\?|&)document=([0-9a-f-]{36})/gi)].map(match=>match[1]))]};}
