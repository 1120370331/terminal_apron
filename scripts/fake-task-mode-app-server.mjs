// Deterministic JSONL transport fixture for Task Mode integration tests only.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
let sequence=0;const threads=new Map();const timers=new Map();
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
const notify=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{try{const message=JSON.parse(line);void handle(message).catch(error=>process.stdout.write(JSON.stringify({id:message.id,error:{code:-32000,message:error.message}})+'\n'));}catch{}});
async function handle({id,method,params={}}){
  if(method==='initialized')return;
  if(method==='initialize'){reply(id,{});return;}
  if(method==='model/list'){reply(id,{data:[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol (integration fixture)',isDefault:true,supportedReasoningEfforts:['medium','high']}]});return;}
  if(method==='thread/list'){reply(id,{data:[...threads.values()].filter(thread=>!params.cwd||thread.cwd===params.cwd),nextCursor:null});return;}
  if(method==='thread/start'){const thread={id:'fixture-thread-'+ ++sequence,cwd:params.cwd,status:{type:'idle'},turns:[]};threads.set(thread.id,thread);reply(id,{thread});return;}
  const thread=threads.get(params.threadId);if(!thread)throw new Error('thread not found');
  if(method==='thread/read'||method==='thread/resume'){reply(id,{thread});return;}
  if(method==='thread/name/set'||method==='thread/archive'){reply(id,{});return;}
  if(method==='turn/steer'){const turn=thread.turns.find(turn=>turn.id===params.expectedTurnId);if(!turn||turn.status!=='inProgress')throw new Error('active turn conflict');turn.items.push({id:'steer-'+ ++sequence,type:'userMessage',clientId:params.clientUserMessageId,text:params.input[0].text});reply(id,{turnId:turn.id});return;}
  if(method==='turn/interrupt'){const turn=thread.turns.find(turn=>turn.id===params.turnId);clearTimeout(timers.get(turn.id));turn.status='interrupted';reply(id,{});notify('turn/completed',{threadId:thread.id,turnId:turn.id,turn});return;}
  if(method==='turn/start'){
    const turn={id:'fixture-turn-'+ ++sequence,status:'inProgress',startedAt:new Date().toISOString(),items:[{id:'input-'+sequence,type:'userMessage',clientId:params.clientUserMessageId,text:params.input[0].text}]};thread.turns.push(turn);reply(id,{turn});notify('turn/started',{threadId:thread.id,turnId:turn.id,turn});
    const properties=params.outputSchema?.properties??{};let output;
    if(properties.workers)output={understanding:'保持原文，完成指定文件改动并返回验证。',workers:[{name:'实现',objective:'在隔离测试目录中创建验证文件。',ownedPaths:['proof.txt']}]};
    else if(properties.workerIds){const ids=[...params.input[0].text.matchAll(/"id":"([^"]+)"/g)].map(match=>match[1]);output={understanding:'已理解追加说明',workerIds:ids,instructions:'纳入追加需求。'};}
    else if(properties.changedFiles){fs.writeFileSync(path.join(thread.cwd,'proof.txt'),'Task Mode integration proof\n');turn.items.push({id:'change-'+sequence,type:'fileChange',status:'completed',changes:[{path:'proof.txt',diff:'+ Task Mode integration proof'}]});output={summary:'隔离目录中的 proof.txt 已创建。',changedFiles:['proof.txt'],verification:[{command:'read proof.txt',result:'passed',details:'文件内容一致'}],risks:[],blockers:[],artifacts:[]};}
    else output={status:'needs_confirmation',summary:'实现与验证完成，请确认这轮结果。',risks:[]};
    const delay=properties.changedFiles?1500:250;
    timers.set(turn.id,setTimeout(()=>{turn.items.push({id:'answer-'+ ++sequence,type:'agentMessage',phase:'final',text:JSON.stringify(output)});turn.status='completed';turn.completedAt=new Date().toISOString();notify('turn/completed',{threadId:thread.id,turnId:turn.id,turn});},delay));return;
  }
  throw new Error('unsupported '+method);
}
