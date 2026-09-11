/** Operator-initiated delivery of the saved Air patch. No model or payment calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";
import { resolveMinerSecret } from "../../../fez-bazaar/src/miner/keys.ts";
import { nip98Header } from "../../../fez-bazaar/src/miner/repo-work.ts";
import { resultTemplate } from "../../../fez-bazaar/src/protocol/kinds.ts";
import { deliverHire } from "../../packages/fez-acp/src/hire-delivery.ts";

const out=path.join(os.homedir(),".fez/bazaar");
const save=(name:string,value:unknown)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+"\n");
assert(!fs.existsSync(path.join(out,"delivery-retry-attempt.json")),"Retry already attempted; inspect its saved result.");
const secret=resolveMinerSecret("lebron",{});
assert(secret,"LeBron's existing identity must be available in the logged-in session");
const key=Uint8Array.from(Buffer.from(secret,"hex"));
assert.equal(getPublicKey(key),"d3a6ff789661f7d048798450568688b05a3c9064e41cfc34ccbe1834271a59a0");
const repoUrl="https://kens-macbook-pro.tail93459d.ts.net:8443/git/lebron-invoice-pilot-20260910.git";
const branch="lebron/hire-delivery-retry";
const taskId="db0d783276ec26ec7fe17613fa1b76c11d71d711b02bc8dd89b412cbe3df513b";
const posterPk="374c5f94762475209b2e4b591689b66625796215e4ab561a008c580d2b2b0e52";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fez-delivery-retry-"));
const git=(args:string[])=>execFileSync("git",args,{cwd:dir,encoding:"utf8",stdio:"pipe",env:{...process.env,GIT_TERMINAL_PROMPT:"0"}}).trim();
save("delivery-retry-attempt.json",{at:new Date().toISOString(),taskId,branch,dir,operatorInitiated:true,modelCalls:0,payments:0});
try {
  git(["clone",path.join(out,"lebron-repo-result.bundle"),"."]);
  git(["checkout","--detach","e7445ed934ad33acb6e808f864f8876a670c0321"]);
  git(["checkout","-b",branch]);
  git(["apply",path.join(out,"lebron.patch")]);
  assert.deepEqual(git(["diff","--name-only"]).split("\n"),["invoice.mjs","invoice.test.mjs"]);
  git(["remote","set-url","origin",repoUrl]);
  const globalSigning=git(["config","--global","--get","commit.gpgsign"]);
  assert.equal(globalSigning,"true","reproduce the Air's original setting");
  deliverHire({dir,branch,personaId:"lebron",message:"Fix duplicate invoice payments",authHeader:()=>`Authorization: ${nip98Header(secret,repoUrl)}`});
  const result=`Pushed \`${branch}\` — invoice fix recovered from the original paid hire. Operator-initiated delivery retry; no new model call or payment.`;
  const event=finalizeEvent({...resultTemplate({taskId,posterPk,status:"success",result}),created_at:Math.floor(Date.now()/1000)},key);
  key.fill(0);
  save("delivery-retry-event.json",event);
  useWebSocketImplementation(WebSocket);
  const relay=await Relay.connect("wss://bazaar.fez.chat");
  try {await relay.publish(event);}finally{relay.close();}
  save("delivery-retry-result.json",{at:new Date().toISOString(),taskId,branch,eventId:event.id,status:"delivered",operatorInitiated:true,modelCalls:0,payments:0,globalSigning,temporaryCheckoutRemoved:!fs.existsSync(dir)});
  console.log("Saved work delivered and its signed result published; no model call or payment.");
}catch(error){
  key.fill(0);
  save("delivery-retry-result.json",{at:new Date().toISOString(),status:"failed",error:(error as Error).message,dir});
  throw error;
}
