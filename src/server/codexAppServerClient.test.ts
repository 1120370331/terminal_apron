import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./codexAppServerClient.js";

test("correlates out-of-order JSONL responses and initializes once", async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"codex-fake-")); const script=path.join(directory,"fake.mjs");
  fs.writeFileSync(script,`import readline from 'node:readline';const rl=readline.createInterface({input:process.stdin});const pending=[];rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.id){pending.push(m);if(pending.length===2){console.log(JSON.stringify({id:pending[1].id,result:pending[1].method}));console.log(JSON.stringify({id:pending[0].id,result:pending[0].method}));}}});`);
  const client=new CodexAppServerClient({command:process.execPath,args:[script],requestTimeoutMs:2_000});
  try{const [a,b]=await Promise.all([client.request<string>("first",{}),client.request<string>("second",{})]);assert.equal(a,"first");assert.equal(b,"second");}finally{client.close();fs.rmSync(directory,{recursive:true,force:true});}
});
