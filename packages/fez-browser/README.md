# @fezchat/browser

Open visible browser panes beside your Fez chat with `/browser [url]`. The native
desktop build introduced in **Fez 0.4.40** includes CEF; no separate browser download
is needed for these panes. **New browser** opens another pane (up to four).
Attach **Browser Use** (`@fezchat/browser-use`) to agents for visible clicking,
typing, scrolling, per-pane queues, and owner takeover.

This package also gives agents an anonymous browser reading backend through
Camofox. Setup, testing,
and agent attachment are available in the desktop GUI. Once set up, the
browser starts when an agent first opens a page and stops with its connection.
No login service or terminal command is needed after a reboot.

Reading-backend settings are declared in `src/gui.json` and rendered by Fez.
The GUI also mounts native browser panes; its process actions require the recorded `processes` grant
and run this package's own `fez-browser` binary.

## Set up anonymous reading tools

1. Open **Extensions → Browser → review & install**, then grant the listed permissions.
2. Open **Settings → extensions → Browser → Set up browser**. The first setup
   downloads about 313 MB on macOS arm64. You can leave the panel while it runs.
3. Select **Test browser**. A successful check opens and closes a blank page.
   Failed setup shows an error and a retry button.
4. Give Browser to your agent through the installed extension's **give to…**
   button, or the agent editor's tools picker. If it is already running,
   open **Agents → your agent → restart** to load the new tools.
5. Ask the agent: “Open The Verge and tell me the title and link of the lead article.”

The tools become available when that agent next starts. Browser does not
attach itself to other agents or change their existing tools.

The gallery card requires a desktop release containing Browser. On an older
app whose catalog does not list it yet, install the npm package with
`fez install @fezchat/browser`, then reopen Fez to load its settings panel.

For extension development in a checkout:

```sh
npm install --prefix packages/fez-browser
node dist/cli.js link packages/fez-browser
```

Checkout links and npm installations use the package name `browser`.
Older development installs may still appear as `fez-browser`.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `browser_open` | `url` | A `tab_id` and the browser's resulting URL |
| `browser_read` | `tab_id`, optional `offset` | Page snapshot and `next_offset` for long pages |
| `browser_close` | `tab_id` | Closes that tab |

Snapshots include page structure and links; the agent identifies the lead
article. Website content is marked as untrusted data.

## Local runtime

The GUI setup program installs `@askjo/camofox-browser@1.14.0` and its locked
npm dependencies into `~/.fez/camofox` without npm lifecycle scripts. It then
uses the pinned package's browser downloader. The downloader selects its
supported Camoufox release; the live macOS arm64 check used 152.0.4 beta.30.
Setup requires network access and Node 22+. Fez's native extension runner
provisions its managed Node runtime when needed.

The first valid `browser_open` starts a private Camofox process bound to
loopback on an automatically selected port. Each MCP connection has fresh
access keys and temporary profile, cookie, upload, and trace directories.
Persistence, interactive mode, VNC, YouTube integration, default add-ons,
and crash reporting are disabled. The child does not inherit agent secrets.
Closing the connection stops the server and removes its temporary directory;
a killed MCP parent also closes the child's stdin and triggers cleanup.
A killed browser child or machine crash can leave temporary files on disk.

Setup runs only from the owner's setup action. Listing tools or starting an
agent never downloads a browser. A missing runtime produces a tool error
pointing to the Browser settings panel. The GUI uses existing `ui` and
`processes` permissions; browsing declares `network:*`.

## Optional external server

An explicit `CAMOFOX_BASE_URL` uses an operator-managed Camofox server
instead of automatic local startup. Configure it through Fez's existing
Skills & Secrets surface:

| Setting | Meaning |
| --- | --- |
| `CAMOFOX_BASE_URL` | Blank starts a private local browser; a URL selects an external server |
| `CAMOFOX_ACCESS_KEY` | External server's access key, stored in the Fez keychain |

Remote endpoints require HTTPS and an access key. Loopback HTTP is allowed.
Endpoints cannot contain embedded credentials, a query string, or a fragment.
REST redirects are refused. Browser page redirects are handled by Camofox.
Disable persistence on external servers. GUI setup and Test browser check
the local installation; they do not administer an external server.

Each MCP process owns a random session and its tab IDs. Graceful shutdown
deletes that whole external session, including popups. An unreachable server
or forced MCP kill can leave an external session until upstream expiry.

## Scope and limits

At most four tabs can be explicitly opened. Each request has a 55-second
timeout and a 2 MiB response limit. Snapshots use Camofox's native windows
of at most 80,000 characters; pass `next_offset` to continue. Requests are
serialized within a session and browser actions are not retried.

This version supports anonymous reading. It exposes no typing, clicking,
cookie import, storage export, arbitrary JavaScript, or account grants.
It is not a network sandbox: pages, redirects, and subresources can reach
addresses available from the browser host, including private networks.
Session separation does not protect against a malicious browser operator
or arbitrary code running as the same OS user.

## Checks

```sh
npm run check --prefix packages/fez-browser
npm run build --prefix packages/fez-browser
npm test --prefix packages/fez-evals -- tests/browser.test.ts tests/browser-runtime.test.ts tests/browser-gui.test.ts
npm run test:e2e --prefix packages/fez-desktop -- tests/e2e/browser-extension.spec.ts
```

The evals exercise MCP boundaries, actual subprocess startup and cleanup,
parent death, and GUI error handling without a public network or download.
The desktop walkthrough uses the real webview UI, a local relay, and a
fixture at the native installer boundary. Setup and test actions run real
runtime code against a local Camofox fixture. Separate live checks verify
clean installation, the actual browser binary, and compiled stdio MCP
against The Verge. The automated walkthrough does not run a model turn; the owner also
verified the complete flow in a real Quill DM after restarting the agent.
