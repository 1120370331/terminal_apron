import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskJobOutput, TaskOutputParseError } from "./tasks/taskModeOutput.js";
import type { TaskConversationItem } from "../shared/taskConversationTypes.js";

const output = { summary: "候选已准备，等待代理检查后发布", changedFiles: ["client/package.json"], verification: [{ command: "git show --check", result: "passed", details: "通过" }], risks: [], blockers: ["等待代理检查"], artifacts: [] };
const message = (id: string, text: string, phase: "final" | "commentary" = "final"): TaskConversationItem => ({ kind: "assistant", id, text, phase });

test("progress-only replies cannot contain worker dispatch instructions and legacy steering remains readable",()=>{
  const reply={userUpdate:"已经实施局部优化，完整耗时仍待验证。",deliveryMode:"reply_only",understanding:"仅询问进度",workerIds:[],instructions:""};
  assert.deepEqual(parseTaskJobOutput([message("reply",JSON.stringify(reply))],"steer"),reply);
  assert.throws(()=>parseTaskJobOutput([message("bad",JSON.stringify({...reply,workerIds:["worker-1"]}))],"steer"),TaskOutputParseError);
  assert.throws(()=>parseTaskJobOutput([message("bad",JSON.stringify({...reply,instructions:"修改实现"}))],"steer"),TaskOutputParseError);
  assert.throws(()=>parseTaskJobOutput([message("bad",JSON.stringify({...reply,userUpdate:42}))],"steer"),TaskOutputParseError);
  const legacy={understanding:"转交新增要求",workerIds:["worker-1"],instructions:"增加输入校验"};assert.deepEqual(parseTaskJobOutput([message("old",JSON.stringify(legacy))],"steer"),legacy);
});

test("accepts the final structured Worker report after a separate human-readable final message", () => {
  const items = [message("question", "请主线程检查发布候选；检查通过后再推送。"), message("report", JSON.stringify(output))];
  assert.deepEqual(parseTaskJobOutput(items, "worker"), output);
});

test("ignores progress JSON and selects the last complete result matching the job contract", () => {
  assert.deepEqual(parseTaskJobOutput([message("progress", JSON.stringify({ ...output, summary: "进度" }), "commentary"), message("result", JSON.stringify(output)), message("extra", JSON.stringify({ summary: "附加说明" }))], "worker"), output);
});

test("reads a fenced report with surrounding explanation", () => {
  assert.deepEqual(parseTaskJobOutput([message("result", `本轮结果如下：\n\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n请代理检查。`)], "worker"), output);
});

test("rejects partial messages, scalar JSON and reports for another job role instead of manufacturing success", () => {
  assert.throws(() => parseTaskJobOutput([message("partial-1", '{"summary":"候选'), message("partial-2", '已完成"}')], "worker"), TaskOutputParseError);
  assert.throws(() => parseTaskJobOutput([message("scalar", "null")], "worker"), TaskOutputParseError);
  assert.throws(() => parseTaskJobOutput([message("review", JSON.stringify({ status: "done", summary: "通过", risks: [] }))], "worker"), TaskOutputParseError);
});

test("does not accept invalid verification results as a complete Worker report", () => {
  assert.throws(() => parseTaskJobOutput([message("result", JSON.stringify({ ...output, verification: [{ command: "test", result: "success" }] }))], "worker"), TaskOutputParseError);
});

test("accepts legacy reviews but rejects partial or empty blocked action guidance", () => {
  const legacy = {status:"blocked",summary:"需要测试权限",risks:["403"]};
  assert.deepEqual(parseTaskJobOutput([message("old",JSON.stringify(legacy))],"review"),legacy);
  const result = {...legacy,stopReason:"测试账号缺少 beta 权限",humanActions:[{action:"在应用登录具备 beta 权限的账号，再在本任务回复已登录",reason:"接口返回 403，代理无法授予账号权限",unblocks:"校验认证元数据和更新接口"}],agentNextSteps:["用独立浏览器上下文继续主题回归"]};
  assert.deepEqual(parseTaskJobOutput([message("new",JSON.stringify(result))],"review"),result);
  assert.throws(()=>parseTaskJobOutput([message("partial",JSON.stringify({...legacy,humanActions:[]}))],"review"),TaskOutputParseError);
  assert.throws(()=>parseTaskJobOutput([message("empty",JSON.stringify({...result,humanActions:[],agentNextSteps:[]}))],"review"),TaskOutputParseError);
  assert.throws(()=>parseTaskJobOutput([message("vague",JSON.stringify({...result,humanActions:[{action:"提供账号",reason:"",unblocks:"验证"}]}))],"review"),TaskOutputParseError);
});
