# Fez public-site audit — September 12, 2026

Fix the getting-started and trust documentation first. Then give the five secondary marketing pages the accepted homepage's wider layout, clearer headings, and quieter presentation. Keep the docs framework: its search, mobile navigation, and article structure already work.

## Scope and checks

- Reviewed `/bazaar`, `/whitepaper`, `/judge`, `/mine`, and `/roadmap` in the local preview, including their source and current implementation claims.
- Read all 25 MDX documentation pages. Checked the published docs, search results, desktop layout, and mobile sidebar/navigation. All 25 published routes returned successfully; the local documentation links and their linked anchors resolved. The existing public-docs smoke check also passed.
- Compared claims with the Fez checkout and the adjacent Bazaar implementation. The latest verified desktop release is [v0.4.39](https://github.com/KennethAshley/fez-releases/releases/tag/v0.4.39), published September 12 at 07:16 UTC. Later checkout features must be labeled as source features until their release is verified.
- This is a content and design audit. It does not establish current chain balances, reward activation, paid-job performance, or the live testnet board's operational health. No jobs, payments, deployment, or site-source changes were made.

## 1. Correct these claims before launch

### Getting started: neither path reliably describes first use

The desktop walkthrough says a fresh machine gets a working agent with “zero config.” The actual onboarding includes **Connect your AI**, provider/model setup or CLI sign-in, and an explicit option to explore before connecting AI. Bundling the runtime does not supply provider credentials. The guide should follow the actual welcome → AI connection → workspace → profile → team flow and finish with a successful agent response and a second human joining.

The source walkthrough has a concrete identity mismatch: it tells the reader to run `fez keygen`, use that public key as the relay owner, then run `fez`. `keygen` prints a new keypair but does not save it as the default identity. Plain `fez` loads or creates a separate default key, so following the instructions does not make that client the configured workspace owner. Rewrite the walkthrough around one persisted identity and verify it on a fresh profile.

The desktop guide also says the key “never enters the UI.” Normal signing uses Rust custody, but onboarding still generates/imports key material through the webview. Qualify the claim consistently with the architecture page.

Evidence: [getting-started.mdx](/Users/ken/Projects/Fez/fez/web-docs/content/docs/getting-started.mdx:6), [onboarding AI connection](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/Onboarding.tsx:1032), [onboarding key generation](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/Onboarding.tsx:175), [keygen](/Users/ken/Projects/Fez/fez/src/cli/cmd-identity.ts:11), [TUI identity selection](/Users/ken/Projects/Fez/fez/src/cli.ts:51).

### Agent isolation: the documented default is wrong

The Agents and Tools pages promise clean-room sessions with no personal harness configuration, MCP servers, or credentials leaking in. Claude's default environment deliberately shares the user's configuration and login while disabling Claude account connector synchronization. Full configuration-directory isolation requires `FEZ_HARNESS_ISOLATE=1`; it is not the default or an unconditional guarantee.

Document the actual modes, their credential behavior, and their limits. Keep harness isolation separate from the newer native child-webview isolation for GUI extensions. The old claim is present in published docs search results.

Evidence: [Agents](/Users/ken/Projects/Fez/fez/web-docs/content/docs/concepts/agents.mdx:62), [Tools](/Users/ken/Projects/Fez/fez/web-docs/content/docs/concepts/tools.mdx:102), [Claude environment implementation](/Users/ken/Projects/Fez/fez/src/agent/harness.ts:258).

### Bridges and communities: the old membership model overstates privacy

The Bridges page says a bridge cannot see channels it was not invited into. The current model uses workspace-wide membership: membership covers every channel. Client-side admission rules alone do not make plaintext relay events private; relay read enforcement is an optional operator policy.

The bridge join example also uses the old `fez-join:<relay>#<communityId>` format. Current invitations use `#owner=<pubkey>` to pin workspace authority. Legacy fragments still parse, but do not carry that owner pin. Align Bridges and Communities with the current workspace model and the newer architecture documentation.

Evidence: [Bridges](/Users/ken/Projects/Fez/fez/web-docs/content/docs/concepts/bridges.mdx:21), [legacy invite example](/Users/ken/Projects/Fez/fez/web-docs/content/docs/concepts/bridges.mdx:88), [workspace trust and membership](/Users/ken/Projects/Fez/fez/packages/fez-client/src/workspace-state.ts:3), [invite parser](/Users/ken/Projects/Fez/fez/packages/fez-client/src/workspace-invite.ts:3).

### Judge: resolve the answer-count mismatch and link the evidence

The 12 displayed round sizes total **52 answers**, while the summary says **51**. Resolve this against the underlying dataset; do not silently assume which value is authoritative. The displayed mean correlation, 0.845, does match the listed correlations.

The 780-trajectory statistic is dated historical research, not a live counter. Keep that distinction and link the calibration dataset, methodology, and supporting records. The current coordination acceptance rules and historical rubric should have separate visual emphasis.

Evidence: [round data](/Users/ken/Projects/Fez/fez/web/app/(home)/judge/page.tsx:30), [summary statistics](/Users/ken/Projects/Fez/fez/web/app/(home)/judge/page.tsx:118).

## 2. Page-by-page content and design changes

| Page | Content change | Design change |
| --- | --- | --- |
| **Bazaar** | Explain the agent-work market before introducing miners, gauntlets, or configuration hashes. Make the current testnet participation path clear. Keep the simulation explicitly historical. | Open with a stronger introduction and visible “review your agent” / “view testnet board” actions. Replace the four boxed steps with an open workflow. Move historical illustration behind a secondary archive link. |
| **Whitepaper** | Its September 11 working draft is recent, not automatically stale. Add links to the protocol contract and rehearsal/replay evidence. Make its scope explicit: the Bazaar protocol. | Treat it as an article: clear abstract, larger headings, section anchors, table of contents, and readable prose. Remove the large introductory box and repeated ornamental separators. |
| **Judge** | Fix the count mismatch. Explain current accepted/rejected/unassessed outcomes first. Link the old calibration's evidence and preserve its historical status. | Put current acceptance rules and an evidence example first. Move the long prompts and research table into a linked research appendix; the giant correlation statistic currently dominates the page. |
| **Mine** | Add actual prerequisites: Fez installation, connected AI, working agent, and Bazaar installation/access. Explain how a reviewed agent gets an operator-authorized test job. The current “Open Bazaar in Fez” instruction assumes the setup the reader needs help with. | Make this a practical setup guide with one primary next action. Use real UI examples, concise steps, and a compact spending/testnet notice. Consider the visible title “Run your agent on Bazaar.” |
| **Roadmap** | Clarify whether this is Bazaar's roadmap or Fez's. It currently omits the broader desktop/product work. Keep earnings and mainnet as future gates until new evidence supports advancing them. | Use explicit status labels and short deliverables with evidence links. Avoid very dim future milestones and repeated prose blocks. If it remains the site-wide roadmap, separate Fez and Bazaar tracks. |
| **Docs** | Repair the launch-blocking instructions and claims above; synchronize extension overviews; document current user workflows and troubleshooting. | Keep search, sidebar, article typography, and TOC. Add a return link to Fez, remove the inert theme toggle, and put practical entry paths at the top of the landing page. |

### Shared marketing layout

All five secondary pages still use the older narrow `max-w-2xl` shell, small centered headings, predominantly 14px monospaced prose, gold heading text, and decorative separators. The accepted homepage now uses a wider outer frame, left alignment, stronger white headings, and orange for actions. Moving between them feels like entering an older site.

Use one consistent outer width and header alignment. Keep long article text at a comfortable reading measure rather than stretching paragraphs across the wider frame. Use the site's existing sans font for prose and reserve monospace for code, identifiers, and compact technical data. Whitepaper and Judge need stronger heading hierarchy and anchored navigation; add semantic `main` regions and a skip link to the marketing layout.

The pages also repeat the same speech workflow, daily allowance, testnet limits, and replay caveats. Give each page one job: Bazaar explains the product; Mine helps someone participate; Whitepaper explains the protocol; Judge explains evaluation; Roadmap shows remaining work. Keep restrictions visible where someone makes a decision, while linking detailed evidence from a single dated report.

## 3. Documentation refresh inventory

### Entry points and trust

| Document | Disposition |
| --- | --- |
| What is Fez? | Move “use Fez,” “run an agent,” and “build an extension” entry links above the long introduction. Qualify the zero-config agent claim. |
| Getting started | Rewrite against real desktop onboarding and correct the source identity sequence. Add a first-success check and second-person join flow. |
| Architecture | Keep the newer owner-pinning and background-worker explanations. Update the blanket shared-webview statement to distinguish legacy GUI extensions from isolated runtimes. |
| Communities | Replace the old creator/community terminology with the current relay/workspace owner and roster model; explain owner-pinned invitations. |
| Trust | Use this as the common reference for the other pages. Review privacy wording consistently when fixing Bridges; avoid implying that client-side membership encrypts channels. |

### Agent and user workflows

| Document | Disposition |
| --- | --- |
| Agents & personas | Correct isolation. Add periodic reflection and current persona controls with a tested release/source label. |
| Tools | Correct the default harness-isolation claim; preserve tool identity and credential guidance that still matches implementation. |
| Bridges | Correct channel-access guarantees and the invitation format. |
| Docs, boards & live blocks | Expand the actual Docs workspace workflow, navigation, sharing/history, and current Kanban controls. Explain both desktop background work and optional sentinel hosting for live refresh. Verify release availability before describing recent source additions as shipped. |
| Self-hosting | Keep current deployment and background-host guidance. Qualify redundancy promises: multiple relays reduce failure risk but do not guarantee complete history or replace backups. |

### Extension documentation

| Document | Disposition |
| --- | --- |
| Extensions concept | Refresh the overview to include current GUI runtime choices and the miner attachment point. |
| Extension API overview | Replace the “up to six attachment points” summary and legacy-only GUI host description with the current manifest contract. |
| Manifest | Document `guiRuntime`, contributions, and miner parts. Correct blanket permission-denial “no-op” language: denied operations can throw/reject; registration and unavailable UI have different behavior. |
| Development loop | Help authors choose the appropriate runtime before following the legacy GUI bundle workflow. State tested host/package versions. |
| GUI surface | Substantially current and valuable. Preserve the runtime and permission details; split or reorganize the long page around choosing a runtime, implementing it, and troubleshooting it. |

### References and substantially current guides

| Document | Disposition |
| --- | --- |
| Headless surface | Current desktop-worker and permission-error guidance is useful. Make Manifest agree with it. |
| Relay/workspace surfaces | Retain; no confirmed launch-blocking mismatch found in this pass. |
| CLI reference | Retain the existing workspace, invite, doctor, and relay commands: they are already documented. Keep paths/version details synchronized with extension changes. |
| Package reference | Refresh the catalog for current packages and capabilities. Replace the stale “700+” test description with a maintained description; the preceding verified full run had 2,428 passing tests. |
| Bazaar concept | Preserve its distinction between current testnet behavior, historical research, specialist fees, and unverified chain earnings. Make it the detailed companion to the shorter marketing pages. |

### Remaining concept pages

| Document | Disposition |
| --- | --- |
| Orchestration | Retain the routing explanation; link new reflection/background guidance where relevant. |
| Skills | Retain; no confirmed launch-blocking mismatch found in this pass. |
| Git | Retain the substantial workflow documentation; include it in future versioned verification rather than rewriting for visual consistency. |
| Artifacts | Retain; no confirmed launch-blocking mismatch found in this pass. |
| Marketplace | Retain the tool-discovery explanation; clearly distinguish this from the Bazaar work market in navigation and cross-links. |

The docs need a short troubleshooting path for provider sign-in, an agent that does not reply, workspace joining/approval, background activity, and finding diagnostic logs. This will help the first 100 users more than additional protocol prose.

The visible docs theme control currently has no effect because the root provider forces dark mode. Remove it. The docs logo returns to the docs root, and no link back to the main Fez site was present. Add that connection. Mobile sidebar navigation to Getting started worked, with no measured horizontal overflow.

Evidence: [current manifest type](/Users/ken/Projects/Fez/fez/packages/fez-extension-api/src/manifest.ts:14), [manifest permission description](/Users/ken/Projects/Fez/fez/web-docs/content/docs/extension-api/manifest.mdx:57), [headless permission behavior](/Users/ken/Projects/Fez/fez/web-docs/content/docs/extension-api/headless.mdx:72), [docs theme configuration](/Users/ken/Projects/Fez/fez/web-docs/app/layout.tsx:34).

## 4. Recommended order

1. **Accuracy:** fix onboarding, source identity setup, isolation/privacy, invitations, and Judge's inconsistent count. Validate the revised onboarding against the released app.
2. **Participation:** make Bazaar and Mine a clear explanation → prerequisites → review → test-job path. Preserve actual operator and testnet boundaries.
3. **Presentation:** apply the accepted homepage's shared layout to the five pages; give Whitepaper and Judge an article treatment; clarify Roadmap scope.
4. **Docs maintenance:** synchronize extension summaries, add missing workflows/troubleshooting, remove the inert theme control, and add the main-site link and tested-version labels.

Keep the useful work already present: the Bazaar simulation is explicitly labeled historical; the original signed unassessed result is distinguished from the later unsigned replay; reward activation is not falsely presented as complete; and the newer GUI/headless documentation describes real current implementation details.

## Implementation follow-through

The September 12 local refresh applies the shared homepage layout to Bazaar, Mine, Whitepaper, Judge, and Roadmap. Articles have anchored contents navigation; historical research is collapsed; Mine includes prerequisites and the operator-issued job path. Roadmap is explicitly scoped to Bazaar.

The docs now describe provider connection, persisted source identity setup, workspace membership, owner-pinned invitations, harness configuration, and current GUI runtimes. They include a troubleshooting page, updated workflow/package guidance, a return link to Fez, and no inert theme switch. Later source features remain labeled as such.

Validation: production builds and TypeScript checks passed; marketing lint passed; all 26 docs routes and linked anchors passed; the documented identity command reused one default key in a temporary profile. The full repository suite passed with 2,428 tests and 8 skipped. Browser checks covered the five redesigned pages on desktop/mobile, the historical disclosure, docs navigation, and troubleshooting search.

The original blinded calibration dataset was not located. The historical appendix explicitly distinguishes the table's 52 entries from the earlier narrative's 51; it does not present that discrepancy as a verified new sample count. These changes are local and have not been published.
