/** Set up or revoke the isolated repository used by the Air hire pilot. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { CapabilityClient } from "../../src/protocol/client.ts";
import { RelayConnection } from "../../src/protocol/relay.ts";
import { getKey } from "../../src/identity/keys.ts";
import { makeChannels } from "../../src/protocol/channels.ts";
import type { NostrAccess } from "../../src/extensions/extensions.ts";
import type { Filter } from "nostr-tools";
import { withGrant, withoutGrant } from "../../packages/fez-git/src/policy.ts";
import { nip98Header } from "../../../fez-bazaar/src/miner/repo-work.ts";

const out = (process.env.BAZAAR_PILOT_OUT ?? "docs/experiments/2026-09-09-bazaar-lebron-repo").replace(/\/$/, "") + "/";
const fixture = JSON.parse(fs.readFileSync(out + "fixture.json", "utf8"));
const info = await (await fetch("http://127.0.0.1:8793", {headers:{Accept:"application/nostr+json"}})).json();
const key = getKey("default");
assert(key, "existing workspace owner key required");
const client = new CapabilityClient({relay:"ws://127.0.0.1:8793",privateKey:key});
assert.equal(client.getPubkey(), info.pubkey);
assert.equal(info.fez_git.clone_base, "https://kens-macbook-pro.tail93459d.ts.net:8443/git");
const url = `${info.fez_git.clone_base}/${fixture.repoName}.git`;
const relay = new RelayConnection({urls:["ws://127.0.0.1:8793"],authSigner:client.authSigner});
await relay.connect();
const nostr: NostrAccess = {
  pubkey: client.getPubkey(),
  publish: async template => {const event=client.signEvent(template);await relay.publish(event);return event;},
  query: filters => relay.query(filters as Filter[]),
};
const channels=makeChannels(nostr,info.pubkey);
const git=(args:string[])=>execFileSync("git",args,{cwd:fixture.seedPath,encoding:"utf8",env:{...process.env,GIT_TERMINAL_PROMPT:"0"},stdio:["ignore","pipe","pipe"]}).trim();
try {
  const existing=(await channels.list()).find(c=>c.name===fixture.repoName);
  const mode=process.argv[2]??"setup";
  if(mode==="grant") {
    assert(existing?.meta?.repo===fixture.repoName);
    const now=Math.floor(Date.now()/1000);
    const meta={...existing.meta,grants:withGrant(existing.meta.grants,fixture.target,now+600,now)};
    await channels.ensure({name:fixture.repoName,source:"fez-git",meta});
    fs.writeFileSync(out+"delivery-retry-grant.json",JSON.stringify({at:new Date().toISOString(),channelId:existing.id,meta},null,2)+"\n");
    console.log("Ten-minute grant reopened for delivery of the saved work.");
  } else if(mode==="revoke" || mode==="revoke-retry") {
    assert(existing?.meta?.repo===fixture.repoName);
    const meta={...existing.meta};
    const grants=withoutGrant(meta.grants,fixture.target,Math.floor(Date.now()/1000));
    if(grants)meta.grants=grants;else delete meta.grants;
    await channels.ensure({name:fixture.repoName,source:"fez-git",meta});
    fs.writeFileSync(out+(mode==="revoke-retry" ? "delivery-retry-grant-revoked.json" : "grant-revoked.json"),JSON.stringify({at:new Date().toISOString(),channelId:existing.id,meta},null,2)+"\n");
    console.log("Temporary repository grant revoked.");
  } else if(mode==="fetch") {
    git(["-c",`http.extraHeader=Authorization: ${nip98Header(key,url)}`,"fetch",url,"+refs/heads/*:refs/remotes/pilot/*"]);
    console.log(git(["for-each-ref","--format=%(refname:short) %(objectname)","refs/remotes/pilot"]));
  } else {
    assert.equal(mode,"setup");
    assert(!fs.existsSync(out+"repository.json"),"repository already set up; do not duplicate setup");
    assert(!existing,"pilot repository name already exists");
    const now=Math.floor(Date.now()/1000);
    const meta={repo:fixture.repoName,clone:url,protect:"main",grants:withGrant(undefined,fixture.target,now+3600,now)};
    const channelId=await channels.ensure({name:fixture.repoName,source:"fez-git",meta});
    assert(channelId);
    const head=git(["rev-parse","HEAD"]);
    fs.writeFileSync(out+"repository.json",JSON.stringify({at:new Date().toISOString(),channelId,url,head,owner:client.getPubkey(),meta},null,2)+"\n");
    console.log("Repository channel created with protected main and a one-hour grant to LeBron.");
    git(["-c",`http.extraHeader=Authorization: ${nip98Header(key,url)}`,"push",url,"main"]);
    console.log(`Seed pushed: ${url} @ ${head}`);
  }
} catch(error) {
  const stderr=(error as {stderr?:Buffer|string}).stderr;
  if(stderr)console.error(String(stderr).slice(0,1500));
  // eslint-disable-next-line preserve-caught-error -- Raw errors may expose private response or process data.
  throw new Error("Repository pilot operation failed; inspect saved evidence before retrying.");
} finally {relay.disconnect();}
