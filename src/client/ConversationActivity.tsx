import { useEffect, useState } from "react";
import type { TaskConversationDetail } from "../shared/taskConversationTypes";
import { conversationActivity } from "./conversationActivityState";
import "./conversationActivity.css";

export function ConversationActivity({detail,fallbackRunning=false,connected,lastEventAt,approvalCount=0}:{detail?:TaskConversationDetail|null;fallbackRunning?:boolean;connected:boolean;lastEventAt?:string;approvalCount?:number}) {
  const activity=conversationActivity(detail,fallbackRunning);
  const [now,setNow]=useState(Date.now());
  const moving=activity.running&&connected&&!approvalCount;
  useEffect(()=>{if(!activity.running)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[activity.running]);
  if(!activity.running&&!approvalCount)return null;
  const seconds=activity.startedAt?Math.max(0,Math.floor((now-Date.parse(activity.startedAt))/1000)):null;
  const age=lastEventAt?Math.max(0,Math.floor((now-Date.parse(lastEventAt))/1000)):null;
  return <div className="codex-live-activity" data-moving={moving} data-mode={approvalCount?"approval":!connected?"reconnecting":activity.mode} role="status" aria-label="当前 Codex 执行状态">
    <span className="codex-live-orbit" aria-hidden="true"><i/><i/></span>
    <div className="codex-live-copy"><strong>{approvalCount?`等待你确认 ${approvalCount} 项请求`:!connected?"实时连接中断，正在同步执行状态":activity.label}</strong><span aria-hidden="true">{seconds!==null&&Number.isFinite(seconds)?`已运行 ${seconds>=60?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${seconds} 秒`}`:"持续跟进当前任务"}{age!==null&&Number.isFinite(age)?` · 最近活动 ${age<2?"刚刚":`${age} 秒前`}`:""}</span></div>
    <span className="codex-live-bars" aria-hidden="true"><i/><i/><i/><i/></span>
  </div>;
}
