# claudex (CLI)

Export your Claude.ai conversations from the command line — **including from the
native Claude Desktop app on macOS**, with no browser required.

Your conversations aren't stored inside the desktop app; they live on Anthropic's
servers and the app fetches them live. This tool reads the desktop app's own
logged-in session (the `sessionKey` cookie, decrypted locally from your Keychain)
and calls the same `claude.ai` API the web UI uses — then writes the results as
JSON, Markdown, or plain text (individually or bundled into a `.zip`).

It shares its conversion code with the browser extension in the parent folder, and
exports at **full fidelity**: extended thinking, tool calls, tool results,
artifacts, attachments, and every edit/regenerate **branch** — not just the
visible text of the active branch.

## Requirements

- **macOS** (for auto-reading the Desktop session). The `--session-key` fallback
  works anywhere.
- **Node.js ≥ 20.** `node:sqlite` (Node ≥ 22.5) is used to read the cookie DB,
  with a `/usr/bin/sqlite3` fallback for older Node.
- The **Claude Desktop app** installed and signed in at least once (for auto mode).

## Install

```bash
cd cli
npm install
node bin/claudex.js --help          # run directly, no install
```

To get a one-word global `claudex` command that works anywhere:

```bash
npm link                                        # if your npm global dir is user-writable
# …or, sudo-free, symlink into a dir already on your PATH (e.g. ~/.local/bin):
ln -sf "$PWD/bin/claudex.js" ~/.local/bin/claudex
```

## Quick start

```bash
claudex auth                 # verify it can read + use your session
claudex list                 # list all your conversations
claudex export --all --zip   # export everything into one .zip
```

The first run reads your macOS Keychain, so you'll see a prompt:
*"security wants to use the 'Claude Safe Storage' item."* Click **Always Allow**
so it won't ask again.

## Commands

### `auth [--offline]`
Check that the session can be read and (online) accepted by the API. `--offline`
only decrypts the local session and skips the network.

### `list [--json] [--since <date>] [--limit <n>]`
List conversations (most-recently-updated first). `--json` prints the raw API
objects to stdout; the human table prints `date  id  model  title`.

### `export [conversationId] [options]`
Export one conversation by id, or `--all` of them.

| Option | Description |
| --- | --- |
| `--all` | Export every conversation |
| `--format json\|markdown\|text\|all` | Output format(s). Default `markdown` |
| `--out <dir>` | Output directory. Default `./claudex` |
| `--zip` | Bundle everything into one `.zip` (+ `export_summary.json`) |
| `--active-branch-only` | Only the active branch (default: all branches) |
| `--no-thinking` | Omit extended-thinking blocks |
| `--no-tools` | Omit tool calls, results, and artifacts |
| `--no-attachments` | Omit attachments |
| `--no-metadata` | Omit the metadata header and per-message timestamps |
| `--since <date>` | With `--all`: only conversations updated on/after this date |
| `--limit <n>` | With `--all`: at most N most-recent conversations |
| `--concurrency <n>` | Parallel fetches (default 3) |

### Auth options (all commands)
| Option | Description |
| --- | --- |
| `--session-key <key>` | Use this `sessionKey` instead of reading the Desktop app |
| `--org <uuid>` | Organization id (auto-resolved if omitted) |
| `--user-agent <ua>` | Override the `User-Agent` header |

## Examples

```bash
# One conversation, every format, into ./out
claudex export 0b180131-… --format all --out ./out

# Everything as Markdown, into a zip
claudex export --all --zip --format markdown

# Just your 20 most recent, as JSON files
claudex export --all --format json --limit 20

# Only conversations touched since a date
claudex export --all --since 2026-01-01 --zip

# Manual session (any OS): copy sessionKey from DevTools → Application → Cookies
claudex export --all --session-key "sk-ant-sid02-…" --org "<org-uuid>"
```

## How auth works

- **Auto (macOS):** reads `~/Library/Application Support/Claude/Cookies`, decrypts
  the `sessionKey` with the key from your login Keychain (`Claude Safe Storage` /
  `Claude Key`), and reuses your live Desktop session. Cloudflare cookies
  (`__cf_bm`, `cf_clearance`) and a realistic User-Agent are sent along to avoid
  challenges.
- **Manual:** pass `--session-key`. Get it from any signed-in browser:
  DevTools → Application → Cookies → `claude.ai` → copy `sessionKey`.

## Troubleshooting

- **Keychain prompt every run** → click **Always Allow** (not just Allow).
- **`Session expired or invalid (401)`** → the `sessionKey` rotates (~30 days,
  no refresh from a static copy). Open Claude Desktop / sign in again, then retry;
  or pass a fresh `--session-key`.
- **`Blocked by a Cloudflare challenge (403)`** → open Claude Desktop once to
  refresh `cf_clearance`, or pass `--user-agent` matching the app. Auto mode
  usually avoids this by reusing the app's Cloudflare cookies.
- **`app-bound cookie encryption`** → a future Claude Desktop could adopt it;
  until then, use `--session-key`.

## Notes

- Uses the **unofficial first-party** `claude.ai` API with **your own**
  credentials to export **your own** data. Fine for personal use; don't use it to
  redistribute or scrape others' data. The API is undocumented and may change.
- Nothing is uploaded anywhere; your `sessionKey` never leaves your machine and is
  redacted in all logs.

## Tests

```bash
npm test   # converter unit tests (no network, no session needed)
```
