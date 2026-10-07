import { useEffect, useRef, useState } from "react";
import { Plus, Save, Tags, X } from "lucide-react";
import type { TaskItem, TaskTagSummary } from "../../shared/taskTypes";
import { DEVELOPMENT_TASK_TAGS } from "../../shared/taskTags";
import { taskApi } from "../taskApi";
import { ModeDialog } from "./ModeDialog";
const message=(error:unknown)=>error instanceof Error?error.message:"标签操作失败";

function tone(name:string){let hash=0;for(const character of name)hash=(hash*31+character.charCodeAt(0))>>>0;return hash%6;}
export function TaskTagList({tags,limit=12}:{tags:string[];limit?:number}){
  return tags.length?<span className="tm-task-tags" aria-label={`任务标签：${tags.join("、")}`}>{tags.slice(0,limit).map(tag=><span className="tm-tag" data-tone={tone(tag)} key={tag}>{tag}</span>)}{tags.length>limit&&<span className="tm-tag tm-tag-more" title={tags.slice(limit).join("、")}>+{tags.length-limit}</span>}</span>:null;
}

export function TaskTagPicker({project,value,onChange,disabled=false}:{project:string;value:string[];onChange:(tags:string[])=>void;disabled?:boolean}){
  const [catalog,setCatalog]=useState<TaskTagSummary[]>(DEVELOPMENT_TASK_TAGS.map(name=>({name,taskCount:0,builtin:true}))),[draft,setDraft]=useState(""),[error,setError]=useState("");
  useEffect(()=>{let alive=true;setError("");setCatalog(DEVELOPMENT_TASK_TAGS.map(name=>({name,taskCount:0,builtin:true})));void taskApi.tagCatalog(project).then(next=>{if(alive)setCatalog(next.tags);}).catch(error=>{if(alive)setError(`无法读取项目标签：${message(error)}`);});return()=>{alive=false;};},[project]);
  const has=(name:string)=>value.some(tag=>tag.toLocaleLowerCase()===name.toLocaleLowerCase());
  function add(name:string){const tag=name.replace(/\s+/g," ").trim();if(!tag)return;if(tag.length>40){setError("标签最多 40 个字符。");return;}if(has(tag)){setDraft("");return;}if(value.length>=12){setError("单个任务最多设置 12 个标签。");return;}setError("");onChange([...value,tag]);setDraft("");}
  return <div className="tm-tag-picker"><div className="tp-row tp-between"><strong>标签 · 可多选</strong><span className="tp-small tp-muted">{value.length} / 12</span></div><div className="tm-selected-tags">{value.length?value.map(tag=><button type="button" className="tm-tag" data-tone={tone(tag)} disabled={disabled} key={tag} aria-label={`移除标签 ${tag}`} onClick={()=>onChange(value.filter(name=>name!==tag))}>{tag}<X/></button>):<span className="tp-small tp-muted">选择常用标签，或创建项目标签。</span>}</div><div className="tm-tag-input"><input className="tp-input" aria-label="自定义标签" placeholder="输入标签，按回车添加" maxLength={40} value={draft} disabled={disabled} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();add(draft);}}}/><button type="button" className="tp-button" disabled={disabled||!draft.trim()} onClick={()=>add(draft)}><Plus/>添加标签</button></div><details className="tm-tag-suggestions" open><summary>{project?`${project} · 可复用标签`:"可复用标签"}</summary><div>{catalog.filter(tag=>!has(tag.name)&&(!draft||tag.name.toLocaleLowerCase().includes(draft.toLocaleLowerCase()))).map(tag=><button type="button" className="tm-tag-choice" key={tag.name} disabled={disabled||value.length>=12} onClick={()=>add(tag.name)} title={tag.builtin?"内置开发标签":`项目标签 · ${tag.taskCount} 个任务`}>{tag.name}{tag.taskCount>0&&<small>{tag.taskCount}</small>}{tag.builtin&&<small>常用</small>}</button>)}</div></details>{error&&<p className="tm-error" role="alert">{error}</p>}</div>;
}

export function TaskTagControl({task,refresh,onNotice}:{task:TaskItem;refresh:()=>Promise<void>;onNotice:(text:string)=>void}){
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");const original=useRef<string[]>([]);
  function open(){original.current=[...task.tags];setDraft([...task.tags]);setError("");setEditing(true);}
  async function save(){setBusy(true);setError("");try{const before=new Set(original.current.map(tag=>tag.toLocaleLowerCase())),after=new Set(draft.map(tag=>tag.toLocaleLowerCase()));await taskApi.setTags(task.id,{add:draft.filter(tag=>!before.has(tag.toLocaleLowerCase())),remove:original.current.filter(tag=>!after.has(tag.toLocaleLowerCase()))});await refresh();setEditing(false);onNotice("任务标签已保存，可在同项目其他任务中复用。");}catch(error){setError(message(error));}finally{setBusy(false);}}
  return <><div className="tm-task-tag-control"><TaskTagList tags={task.tags}/><button type="button" className="tp-button tp-ghost tp-small" onClick={open}><Tags/>管理标签</button></div>{editing&&<ModeDialog title="任务标签" closeOnBackdrop={false} closeOnEscape={!busy} onClose={()=>{if(!busy)setEditing(false);}}><TaskTagPicker project={task.project} value={draft} onChange={setDraft} disabled={busy}/>{error&&<p className="tm-error" role="alert">{error}</p>}<div className="tp-row"><button className="tp-button" disabled={busy} onClick={()=>setEditing(false)}>取消</button><button className="tp-button tp-primary" disabled={busy} onClick={()=>void save()}><Save/>保存标签</button></div></ModeDialog>}</>;
}
