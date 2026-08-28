import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewportSize: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
const dir = process.argv[2];
const go = async (q = "") => { await p.goto("http://127.0.0.1:5199/design.html" + q, { waitUntil: "networkidle" }); await p.waitForTimeout(500); };
const shot = async (n) => { const el = await p.$(".pane"); await (el ?? p).screenshot({ path: `${dir}/${n}.png` }); };
const toSkills = () => p.evaluate(() => document.querySelector(".skill-picker")?.scrollIntoView({ block: "center" }));

await go(); await shot("default");
await p.click("details.skill-pick-more > summary"); await p.waitForTimeout(200);
await toSkills(); await p.waitForTimeout(200); await shot("drawer");

await go();
await p.fill(".settings-field input.manage-input", "drift-two"); await p.waitForTimeout(200);
await shot("dirty");

await go("?state=empty"); await toSkills(); await p.waitForTimeout(200); await shot("empty");
await go("?state=broken"); await toSkills(); await p.waitForTimeout(200); await shot("broken");

await go();
await p.selectOption(".manage-select >> nth=1", "allowlist"); await p.waitForTimeout(250);
await p.evaluate(() => document.querySelector(".access-picker")?.scrollIntoView({ block: "center" }));
await p.waitForTimeout(200); await shot("allowlist");

await go("?theme=light"); await shot("light-top");
await p.click("details.skill-pick-more > summary"); await p.waitForTimeout(200);
await toSkills(); await p.waitForTimeout(200); await shot("light-skills");
await go("?theme=light&state=broken"); await toSkills(); await p.waitForTimeout(200); await shot("light-broken");

if (errs.length) console.log("ERRORS:\n" + errs.join("\n"));
await b.close();
