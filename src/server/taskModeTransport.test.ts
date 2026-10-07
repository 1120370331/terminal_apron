import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient, resolveCodexSpawnCommand } from "./codexAppServerClient.js";

test("missing Codex executable rejects its RPC rather than crashing the Apron process",async()=>{
  const client=new CodexAppServerClient({command:path.join(os.tmpdir(),"apron-no-such-codex-executable.exe"),requestTimeoutMs:500});
  try{await assert.rejects(()=>client.request("model/list",{}),/无法启动 Codex|ENOENT|closed|pipe/i);}finally{client.close();}
});
test("finds Codex in a custom Windows npm prefix without a shell wrapper",{skip:process.platform!=="win32"},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-codex-prefix-"));
  try{const script=path.join(directory,"node_modules","@openai","codex","bin","codex.js");fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,"");const resolved=resolveCodexSpawnCommand({env:{Path:directory}});assert.equal(resolved.command,process.execPath);assert.deepEqual(resolved.args,[script,"app-server"]);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
