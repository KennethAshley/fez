import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, CapabilityClient } from "../../../../dist/index.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("Mining links native chat, retains fleet history, and manages through one pane",async({page})=>{
  test.setTimeout(90_000);
  const ownerSecret=generateSecretKey(),agentSecret=generateSecretKey();
  const owner=getPublicKey(ownerSecret),agent=getPublicKey(agentSecret);
  const socket=createServer();await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r));
  const port=(socket.address() as import("node:net").AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
  const relay=await spawnRelay(port,{owner});
  const connection=new RelayConnection({urls:[relay.url]});
  const human=new CapabilityClient({relay:relay.url,privateKey:Buffer.from(ownerSecret).toString("hex")});
  const quill=new CapabilityClient({relay:relay.url,privateKey:Buffer.from(agentSecret).toString("hex")});
  const calls:string[][]=[];let installed=true;let markdown="---\nharness: pi\n---\nQuill";
  const gui=await readFile(new URL("../../../fez-mining/dist/gui.js",import.meta.url),"utf8");
  const grants=["ui","processes","personas","read:channels","publish"];
  try {
    await connection.connect();
    await connection.publish(human.signEvent({kind:47102,tags:[["d","roster"],["p",owner,"owner"],["p",agent,"bot"]],content:""}));
    await connection.publish(human.signEvent({kind:47101,tags:[["d","existing-mining"]],content:JSON.stringify({name:"mining",visibility:"closed",meta:{purpose:"existing history"}})}));
    await connection.publish(human.signEvent({kind:47101,tags:[["d","general"]],content:JSON.stringify({name:"general"})}));
    await connection.publish(quill.signEvent({kind:47000,tags:[],content:JSON.stringify({name:"quill"})}));
    const root=quill.signEvent({kind:47103,tags:[["h","existing-mining"]],content:"⛏ mining · netuid 551 · persona quill"});
    await connection.publish(root);
    await connection.publish(quill.signEvent({kind:47103,tags:[["h","existing-mining"],["e",root.id,"","root"]],content:"Miner stopped. Your history is retained."}));
    const miners=[{netuid:551,persona:"quill",hotkey:"public",desired:"stopped",alive:false,threadRootId:root.id,threadChannelId:"existing-mining"}];
    const catalog={subnets:[{netuid:551,name:"Fixture compute"},{netuid:777,name:"Forecast fixture"}],covered:[551,777],submissionNetuids:[777]};
    await installMockBridge(page,{"plugin:event|listen":()=>1,"plugin:event|unlisten":()=>null,get_pubkey:()=>owner,provider_key_present:()=>true,ensure_local_relay:()=>relay.url,list_personas:()=>["fez","quill"],list_installed_skills:()=>"[]",read_keymap:()=>"{}",read_media_server:()=>"",spawned_agents:()=>[],read_skills:()=>"{}",latest_version:()=>"0.1.1",package_info:()=>"{}"},{identities:{default:Buffer.from(ownerSecret).toString("hex"),"agent:quill":Buffer.from(agentSecret).toString("hex")}});
    const commands=["list_gui_extensions","read_extension_grants","extension_storage_read","run_extension_bin","read_persona","update_persona","list_local_extensions","read_extension_versions","remove_extension"];
    await page.exposeFunction("miningNative",async(cmd:string,args:Record<string,unknown>)=>{
      if(cmd==="list_gui_extensions") return installed ? [["mining",gui,""]] : [];
      if(cmd==="read_extension_grants") return JSON.stringify({mining:grants});
      if(cmd==="list_local_extensions") return installed ? [["mining",["gui","headless","skill"]]] : [];
      if(cmd==="read_extension_versions") return JSON.stringify({mining:"0.1.1"});
      if(cmd==="remove_extension") {installed=false;return "removed";}
      if(cmd==="extension_storage_read") return JSON.stringify({...catalog,miners});
      if(cmd==="read_persona") return markdown;
      if(cmd==="update_persona") {markdown=String(args.content);return null;}
      if(cmd==="run_extension_bin") {
        const a=args.args as string[];calls.push(a);let result:unknown={};
        if(a[0]==="status") result=miners;
        else if(a[0]==="subnets") result=catalog;
        else if(a[0]==="do-token-status") result={present:false};
        else if(a[0]==="describe") result={netuid:Number(a[a.indexOf("--netuid")+1]),mode:a.includes("777")?"submission":"process",network:"test",config:[]};
        else if(a[0]==="metagraph") result={};
        else if(a[0]==="config") result={};
        else if(a[0]==="logs") return {code:0,stdout:"Stopped cleanly",stderr:""};
        else if(a[0]==="thread") result={rootId:root.id};
        else if(a[0]==="submission" && a[1]==="status") result={phase:"unregistered",checkedAt:"2026-09-10T10:00:00Z",hotkey:"public",versions:[]};
        else throw Error("Unexpected mining action: "+a.join(" "));
        return {code:0,stdout:JSON.stringify(result),stderr:""};
      }
      throw Error("Unexpected native command: "+cmd);
    });
    await page.addInitScript(({commands,url})=>{
      localStorage.setItem("fez-relay",url);
      const w=window as unknown as {__TAURI_INTERNALS__:{invoke:(cmd:string,args:unknown)=>Promise<unknown>};miningNative:(cmd:string,args:unknown)=>Promise<unknown>};
      const original=w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke=(cmd,args)=>commands.includes(cmd)?w.miningNative(cmd,args):original(cmd,args);
    },{commands,url:relay.url});
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible();
    const miningNav=page.locator(".rail").getByRole("button",{name:"⛏ Mining",exact:true});
    await miningNav.click();
    await expect(page.getByRole("button",{name:"Use this channel",exact:true})).toBeVisible();
    await page.screenshot({animations:"disabled",path:test.info().outputPath("mining-workspace-setup.png")});
    await page.getByRole("button",{name:"Use this channel",exact:true}).click();
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toBeVisible();
    await expect(page.locator("main .timeline")).toContainText(root.content);
    const composer=page.locator("main textarea").last();
    await composer.fill("@quill show my mining status");
    await page.getByRole("tab",{name:"Miners",exact:true}).click();
    await expect(page.getByText("Stopped. History and settings are retained.")).toBeVisible();
    await page.getByRole("button",{name:"Manage",exact:true}).click();
    await expect(page.locator(".extension-pane")).toContainText("Stopped cleanly");
    await page.screenshot({animations:"disabled",path:test.info().outputPath("mining-workspace-fleet.png")});
    await page.getByRole("button",{name:"History",exact:true}).click();
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toHaveAttribute("aria-selected","true");
    await expect(page.locator("main .timeline")).toContainText("Miner stopped. Your history is retained.");
    await expect(page.getByRole("button",{name:"Manage miner",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"← back to channel"}).click();
    await expect(composer).toHaveValue("@quill show my mining status");
    await page.getByRole("button",{name:"New miner",exact:true}).click();
    await expect(page.getByRole("tab",{name:"Subnets",exact:true})).toHaveAttribute("aria-selected","true");
    await expect(page.getByRole("button",{name:"Launch",exact:true}).last()).toBeVisible();
    await page.screenshot({animations:"disabled",path:test.info().outputPath("mining-workspace-subnets.png")});
    await page.getByRole("button",{name:"Launch",exact:true}).last().click();
    await expect(page.getByText("Choose an agent · SN777")).toBeVisible();
    await page.getByLabel("Use an existing agent").check();
    await page.getByLabel("Mining agent",{exact:true}).selectOption("quill");
    await page.getByRole("button",{name:"Enable mining & continue"}).click();
    const miningStatus=page.getByRole("status").filter({hasText:"Mining tools saved for @quill"});
    await expect(miningStatus).toBeVisible();
    await expect(miningStatus).toContainText("restart");
    await expect(page.getByRole("button",{name:/Register/})).toHaveCount(0);
    await page.getByRole("button",{name:"Continue to miner setup"}).click();
    await expect(page.getByText("Awaiting validator activation")).toHaveCount(0);
    await expect(page.getByRole("button",{name:/Register/}).first()).toBeVisible();
    expect(markdown).toContain("mining=npm:@fezchat/mining");
    expect(calls.filter(a=>["start","stop"].includes(a[0]) || (a[0]==="submission" && a[1]!=="status"))).toEqual([]);
    // Rename the owner-signed channel while retaining its metadata binding.
    await connection.publish(human.signEvent({kind:47101,created_at:Math.floor(Date.now()/1000)+5,tags:[["d","existing-mining"]],content:JSON.stringify({name:"operations",visibility:"closed",source:"mining",meta:{purpose:"existing history",miningWorkspace:"true"}})}));
    await miningNav.click();
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toBeVisible();
    await expect(page.locator("main .topbar")).toContainText("operations");
    await expect(page.locator("main .timeline")).toContainText(root.content);
    const channelEvents=await connection.query([{kinds:[47101],authors:[owner]}]);
    expect(new Set(channelEvents.map(e=>e.tags.find(t=>t[0]==="d")?.[1]))).toEqual(new Set(["general","existing-mining"]));
    await connection.publish(human.signEvent({kind:47101,created_at:Math.floor(Date.now()/1000)+10,tags:[["d","existing-mining"]],content:JSON.stringify({name:"operations",archived:true,source:"mining",meta:{miningWorkspace:"true"}})}));
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toHaveCount(0);
    await miningNav.click();
    await page.getByLabel("Channel name",{exact:true}).fill("mining-lab");
    await page.getByRole("button",{name:"Create mining channel",exact:true}).click();
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toBeVisible();
    await expect(page.locator("main .topbar")).toContainText("mining-lab");
    expect(await connection.query([{ids:[root.id]}])).toHaveLength(1);
    const retired=(await connection.query([{kinds:[47101],authors:[owner],"#d":["existing-mining"]}]))
      .sort((a,b)=>b.created_at-a.created_at)[0];
    const retiredMeta=JSON.parse(retired.content);
    expect(retiredMeta.meta.miningWorkspace).toBe("false");
    expect(retiredMeta.archived).toBe(true);
    await connection.publish(human.signEvent({kind:47101,created_at:retired.created_at+1,
      tags:[["d","existing-mining"]],content:JSON.stringify({...retiredMeta,archived:false})}));
    await miningNav.click();
    await expect(page.locator("main .topbar")).toContainText("mining-lab");

  } finally {connection.disconnect();human.disconnect();quill.disconnect();relay.kill();}
});
