---
name: carry-over
description: Carry Claude Desktop Code sessions and claude.ai chats over to a new Claude account. Use when the user is switching accounts, their subscription is ending, their old sessions disappeared from the sidebar after signing in with a different account, or they want to snapshot, restore, or import past sessions/chats ("bring my sessions over", "restore my sessions", "import my claude chats").
---

# Carry over sessions & chats

Everything runs through `~/.claude/skills/carry-over/carry_over.py` (Python 3, stdlib only).

## How it works (tell the user this in one line if they ask)

- **Code sessions** — the desktop app keeps one small JSON per session in
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/`. The transcript
  it points to lives in `~/.claude/projects` and is not tied to any account. Copying the JSON
  into the new account's folder brings the session back: same title, same project folder, and
  it continues exactly where it left off. Old-account connector settings are stripped; the new
  account's connectors load on first open.
- **claude.ai chats** — live on Anthropic's servers and cannot be imported into another
  account. `import-chats` turns the official data export into Markdown notes in
  `~/Documents/Vault/Claude-Chats/` (with `INDEX.md`; set `CARRY_OVER_VAULT` to use another vault) so any session can search or continue from them.

## Before switching (old account)

1. `python3 ~/.claude/skills/carry-over/carry_over.py snapshot` → writes
   `~/Documents/Vault/Claude-Migration/sessions.md` (every session, folder, transcript status).
2. Remind the user to request the official export: claude.ai → Settings → Privacy → **Export data**.
3. Make sure a backup exists (e.g. `~/claude-migration-backup-*/`). If not, create one:
   `tar -czf` of `~/.claude` and of the `claude-code-sessions` folder, stored **outside** `~/Documents`
   (Documents may sync to the cloud and transcripts can contain secrets).

## After signing in with the new account

1. Get this session's id with the `get_session` tool (`session_id: "self"`) — this session lives in the new account's folder, which is the restore target.
2. Dry run and show the user the list:
   `python3 ~/.claude/skills/carry-over/carry_over.py restore --target-session <local_id>`
   Add `--include-archived` only if they want archived sessions too.
3. On a clear yes, re-run with `--apply`.
4. Tell the user: quit Claude completely (Cmd+Q) and reopen it — the sessions then appear in the sidebar.
   Opening one continues it; nothing needs re-reading.

If a restored session will not open, fall back to the CLI, which resumes from the local
transcript under any account: `cd <folder> && claude --resume <cliSessionId>` (the id is in the session JSON).

## Importing claude.ai chats

Two sources work, and can be combined (the same chat is simply overwritten):
- **claudex** (instant, full fidelity: thinking, tools, artifacts, all branches). The user must run it
  **before** signing out of the old account, since it reads the Desktop app's current login:
  `claudex export --all --format all --out ~/Documents/Vault/Claude-Chats-raw`
  Never run claudex yourself; it reads the user's login from the Keychain — give the user the command.
- **Official export** — claude.ai → Settings → Privacy → Export data (arrives by email as a ZIP; includes Projects).

Then:
1. `python3 ~/.claude/skills/carry-over/carry_over.py import-chats <zip-or-folder>` (dry run, shows counts + recent titles).
2. On yes, re-run with `--apply`.
3. To continue an old chat, open a new session and point it at the note: "Read `Vault/Claude-Chats/<file>.md` and continue from where it ends."

## Rules

- Always dry-run first; only `--apply` after the user confirms.
- Never delete the old account's session folder — restore copies, it doesn't move.
- The script is idempotent: sessions already in the target are skipped, so re-running is safe.
