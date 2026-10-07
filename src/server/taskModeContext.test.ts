import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import test from "node:test";
import { DEFAULT_TASK_MODE_SETTINGS,type TaskExecutionJob,type TaskExecutionRun,type TaskModeState } from "../shared/taskModeTypes.js";
import { prepareTaskModeInput,TASK_MODE_INLINE_CHAR_LIMIT } from "./tasks/taskModeContext.js";

test("large quick context retains direct evidence without introducing dispatch instructions",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-quick-context-"));
  try{
    const job:TaskExecutionJob={id:"direct",role:"execute",name:"消息代理",objective:"",ownedPaths:[],text:"完整快速要求\n"+"保留材料".repeat(20000),status:"pending",attempt:0,model:"gpt-6.1-sol",items:[]};
    const previous={...job,id:"previous",status:"completed" as const,output:{summary:"已有直接执行结果"}};
    const settings={...DEFAULT_TASK_MODE_SETTINGS,executionMode:"quick" as const};
    const run:TaskExecutionRun={id:"quick",instructionIds:[],createdAt:"",settings,jobs:[previous,job],reviewAttempt:0};
    const state:TaskModeState={taskId:"task",phase:"working",settings,instructions:[],runs:[run],events:[],heartbeat:{status:"healthy",recoveryAttempts:0},revision:0,updatedAt:""};
    const result=prepareTaskModeInput(directory,state,run,job);assert.ok(result.packet);
    const evidence=JSON.parse(fs.readFileSync(result.packet.evidencePath,"utf8"));assert.equal(evidence.executionMode,"quick");assert.equal(evidence.workers.length,0);assert.equal(evidence.directExecutions[0].result.summary,"已有直接执行结果");assert.match(result.text,/直接完成剩余实施/);assert.doesNotMatch(result.text,/需要修复或补验时交回原负责人/);assert.equal(fs.readFileSync(result.packet.path,"utf8"),job.text);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test("large generated task input is delivered by reference with its full original and structured evidence retained",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-context-packet-"));
  try{
    const original="用户原文完整保留。\n"+"代码改动与证据。".repeat(40000);
    const job:TaskExecutionJob={id:"review",role:"review",name:"代理检查",objective:"",ownedPaths:[],text:original,status:"pending",attempt:0,model:"gpt-6.1-sol",items:[]};
    const worker={...job,id:"worker",role:"worker" as const,status:"completed" as const,text:"已完成实现",output:{summary:"三个 Worker 的结果沿用",verification:[{command:"npm test",result:"passed"}]}};
    const run:TaskExecutionRun={id:"run",instructionIds:[],createdAt:"",settings:DEFAULT_TASK_MODE_SETTINGS,jobs:[worker,job],reviewAttempt:0};
    const state:TaskModeState={taskId:"task",phase:"reviewing",settings:DEFAULT_TASK_MODE_SETTINGS,instructions:[],runs:[run],events:[],heartbeat:{status:"healthy",recoveryAttempts:0},revision:0,updatedAt:""};
    const result=prepareTaskModeInput(directory,state,run,job);assert.ok(result.packet);
    assert.ok(result.text.length<TASK_MODE_INLINE_CHAR_LIMIT);assert.equal(fs.readFileSync(result.packet.path,"utf8"),original);
    assert.equal(result.packet.sha256,crypto.createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.packet.evidencePath,"utf8")).workers[0].result,worker.output);
    assert.equal(job.text,original);assert.equal(worker.status,"completed");assert.match(result.text,/不重做已通过的内容/);
    assert.equal(prepareTaskModeInput(directory,state,run,{...job,text:"正常的短指示"}).text,"正常的短指示");
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
