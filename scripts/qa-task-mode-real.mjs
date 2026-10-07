// Opt-in smoke against the installed, authenticated Codex; isolated files and database.
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from '../src/server/tasks/taskStore.ts';
import { CodexConversationManager } from '../src/server/codexConversationManager.ts';
import { TaskConversationService } from '../src/server/tasks/taskConversationService.ts';
import { TaskModeService } from '../src/server/tasks/taskModeService.ts';
const output=path.resolve('output/task-mode-real-codex');await fs.mkdir(output,{recursive:true});
const data=await fs.mkdtemp(path.join(output,'data-'));const workspace=path.join(data,'project');await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace,'README.md'),'Isolated Task Mode smoke workspace. Only proof.txt may be created.\n');
const store=new TaskStore(data),manager=new CodexConversationManager(),conversations=new TaskConversationService(store,manager),mode=new TaskModeService(conversations,{pollMs:1000});
conversations.ensureRuntimeOwnership();
const task=store.create({title:'Task Mode real Codex smoke',repositoryPath:workspace,descriptionMd:'在当前工作目录创建 proof.txt，内容必须为 TASK_MODE_REAL_OK。只允许修改这一个文件。用命令读取文件并核对内容，不访问网络。',acceptanceCriteriaMd:'proof.txt 的 UTF-8 内容去掉末尾换行后等于 TASK_MODE_REAL_OK。'});
try {
  const defaults=mode.data.settings();await mode.settings({...defaults,workerPolicy:'single',maxWorkers:1,reviewPolicy:'agent',agentPrompt:defaults.agentPrompt+' 这是一个极小的隔离联调任务，安排一个 Worker，直接围绕用户要求检查结果，避免无关探索。'},task.id);
  await mode.submit(task.id,{clientMessageId:crypto.randomUUID(),text:'执行需求并返回文件内容核对结果。',timing:'now'});
  let phase='',observedHeartbeat=false;const deadline=Date.now()+300000;
  while(Date.now()<deadline){const detail=mode.detail(task.id);if(detail.state.phase!==phase){phase=detail.state.phase;console.log('phase:',phase);}
    if(['planning','working','reviewing'].includes(phase)&&detail.state.heartbeat.status==='healthy'&&detail.state.heartbeat.checkedAt)observedHeartbeat=true;
    if(detail.approvals.length)throw new Error('Real Codex requires approval; smoke stopped without approving additional operations.');
    if(phase==='blocked')throw new Error(detail.state.error||detail.state.runs.at(-1)?.result?.summary||'blocked');
    if(phase==='completed'||phase==='needs_confirmation'){
      const content=await fs.readFile(path.join(workspace,'proof.txt'),'utf8');if(content.trim()!=='TASK_MODE_REAL_OK')throw new Error('File verification failed');
      if(!observedHeartbeat)throw new Error('No confirmed heartbeat was observed during the real Codex turn');
      await fs.writeFile(path.join(output,'report.json'),JSON.stringify({result:'PASS',transport:'real installed Codex app-server',model:detail.state.settings.agentModel,taskId:task.id,workspace,phase,content:content.trim(),heartbeat:{observed:observedHeartbeat,lastCheckedAt:detail.state.heartbeat.checkedAt},roles:detail.state.runs[0].jobs.map(job=>({role:job.role,threadId:job.threadId,turnId:job.turnId,status:job.status})),summary:detail.state.runs.at(-1).result.summary},null,2));console.log('PASS: real agent → worker → review, heartbeat and verified file.');break;
    }
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  if(!['completed','needs_confirmation'].includes(phase))throw new Error('Real Codex smoke timed out');
} catch(error) {await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.message,state:mode.detail(task.id).state},null,2));throw error;}
finally {mode.close();conversations.close();store.close();}
