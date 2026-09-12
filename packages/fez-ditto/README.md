# Ditto Memory for Fez

Connect selected agents to an existing Ditto account. The extension adds three
tools: `ditto_search`, `ditto_fetch`, and `ditto_save`.

## Connect

1. Run `fez install @fezchat/ditto`, or choose **Ditto Memory** if your
   desktop version lists it in the extension gallery.
2. Create a key for the intended account or dedicated graph at
   [Ditto's key page](https://app.heyditto.ai/mcp/newkey).
3. Save it as `DITTO_API_KEY` under **Settings → secrets → ditto**. On macOS,
   Fez holds it in the keychain; the extension does not save a second copy.
4. Open the desired agent's editor, select **ditto** in its tools, and restart
   that agent. Installing the extension does not grant it to every agent.

The persona declaration is `mcpServers: [ditto=npm:@fezchat/ditto]`. Fez's
existing tool assignment and removal controls manage access.

## Try it

Ask the assigned agent: “Search Ditto for our login decision and show the
original memory.” Then explicitly request a note: “Save this to Ditto:
We decided to keep the login flow simple.”

Search returns the upstream memory IDs and attribution. Fetch retrieves full
content for those IDs. Save sends only the provided note, tagged `source: fez`,
with an optional origin description. Fez's signed team memories remain in Fez;
the extension has no relay subscription or automatic export.

## Account and workspace boundaries

The key determines which Ditto memories an assigned agent can access. This is
account access, not a Fez channel permission: switching Fez workspaces does not
change the connected Ditto account. Use a dedicated Ditto graph/key for work
that needs a separate boundary, and attach it only to appropriate agents.
Retrieved Ditto content is external information, not workspace governance.

There is no public publishing, deletion, update, background synchronization,
or account creation tool. Search does not enable Ditto's global public search.
Saving requires an explicit user request; that is an agent instruction, not
a separate human-approval dialog. Writes are disabled during Fez evaluations.

Requests use Ditto's existing HTTPS MCP endpoint with bounded timeouts.
Failed saves are not automatically retried because the first write may have
succeeded; search for the note before submitting it again.

## Development

`npm install`, `npm run check`, and `npm run build` in this package.
`fez link packages/fez-ditto` installs a local build under the name `ditto`.
Run `npx vitest --run tests/ditto-memory.test.ts` in `packages/fez-evals` for
the MCP boundary tests. Builds bundle dependencies for Fez's desktop installer.

[Ditto CLI and API contract](https://github.com/ditto-assistant/ditto-cli)
