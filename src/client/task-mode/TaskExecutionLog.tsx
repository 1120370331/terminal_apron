import { useEffect, useRef, useState } from "react";
import { Code2 } from "lucide-react";
import type { TaskExecutionJob } from "../../shared/taskModeTypes";
import { MarkdownContent } from "../task-monitor/MarkdownContent";
import { taskModeApi } from "./taskModeApi";

const ACTIVE_LOG_REFRESH_MS = 2000;

export function TaskExecutionLog({taskId,runId,job}:{taskId:string;runId:string;job:TaskExecutionJob}) {
  const key=JSON.stringify([taskId,runId,job.id]);
  const [open,setOpen]=useState(false),[refresh,setRefresh]=useState(0);
  const [snapshot,setSnapshot]=useState<{key:string;items?:TaskExecutionJob["items"];loading:boolean;error:string}>({key,loading:false,error:""});
  const inFlight=useRef<Promise<void>>();
  useEffect(()=>{
    if(!open||!job.itemsDeferred)return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const load=()=>{
      // Status changes, manual refresh and reopening share the outstanding read.
      // An obsolete response settles before the current generation can read again.
      const previous=inFlight.current;
      const request=(async()=>{
        await previous;
        if(!alive)return;
        setSnapshot(current=>({key,items:current.key===key?current.items:undefined,loading:true,error:""}));
        try {
          const value=await taskModeApi.executionItems(taskId,runId,job.id);
          if(alive)setSnapshot({key,items:value.items,loading:false,error:""});
        } catch(error) {
          if(alive)setSnapshot(current=>({...current,loading:false,error:error instanceof Error?error.message:"执行记录读取失败"}));
        } finally {
          // Schedule after settlement: no interval backlog or overlapping requests.
          if(alive&&job.status==="active")timer=setTimeout(load,ACTIVE_LOG_REFRESH_MS);
        }
      })();
      inFlight.current=request;
    };
    load();
    return()=>{alive=false;clearTimeout(timer);};
  },[open,taskId,runId,job.id,job.status,job.itemsDeferred,refresh]);
  // Hide the previous identity immediately, even before effect cleanup runs.
  const current=snapshot.key===key?snapshot:undefined;
  return <details onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}><summary>{job.name} · 执行记录</summary>{open&&<>
    {current?.loading&&<p role="status">正在读取执行记录…</p>}{current?.error&&<p className="tm-error" role="alert">{current.error}</p>}
    {job.itemsDeferred&&<button className="tp-button tp-small" disabled={current?.loading} onClick={()=>setRefresh(value=>value+1)}>刷新记录</button>}
    {(job.itemsDeferred?current?.items??[]:job.items).map(item=><div key={item.id} className="tm-runtime-item">{item.kind==="command"?<details><summary><Code2/>{item.command} · {item.status}</summary><pre className="tp-diff">{item.output}</pre></details>:item.kind==="assistant"?<MarkdownContent source={item.text}/>:item.kind==="file_change"?<p>修改文件：{item.paths.join(", ")}</p>:null}</div>)}
  </>}</details>;
}
