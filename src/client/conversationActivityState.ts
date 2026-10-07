import type { TaskConversationDetail } from "../shared/taskConversationTypes";

export const isConversationItemRunning = (status:string) => /^(inProgress|in_progress|running|started)$/i.test(status);
export function conversationActivity(detail?:TaskConversationDetail|null,fallbackRunning=false) {
  const turn=[...(detail?.turns??[])].reverse().find(turn=>turn.status==="in_progress");
  const running=detail?Boolean(turn||detail.conversation.activeTurnId||detail.conversation.status==="active"):fallbackRunning;
  const compacting=turn?.items.some(item=>item.kind==="activity"&&item.activityType==="contextCompaction"&&item.status==="in_progress");
  const item=[...(turn?.items??[])].reverse().find(item=>(item.kind==="command"||item.kind==="tool"||item.kind==="file_change")&&isConversationItemRunning(item.status))??turn?.items.at(-1);
  const mode=compacting?"compacting":item?.kind==="command"&&isConversationItemRunning(item.status)?"command":item?.kind==="tool"&&isConversationItemRunning(item.status)?"tool":item?.kind==="file_change"&&isConversationItemRunning(item.status)?"editing":item?.kind==="assistant"&&item.phase!=="final"?"responding":"thinking";
  const label=({compacting:"Codex 正在压缩上下文，随后自动继续",command:"正在执行命令",tool:"正在调用工具",editing:"正在修改文件",responding:"正在生成回复",thinking:"正在思考和推进任务"})[mode];
  return {running,mode,label,startedAt:turn?.startedAt};
}
