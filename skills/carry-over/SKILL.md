---
name: carry-over
description: Carry Claude Desktop Code sessions and claude.ai chats over to a new Claude account in one command — backup, session snapshot, chat export/import, and session restore. Use when the user runs /carry-over, is switching accounts, their subscription is ending, their old sessions disappeared from the sidebar after signing in with a different account, or they want to back up, restore, or import past sessions/chats ("bring my sessions over", "restore my sessions", "import my claude chats").
---

# Carry over sessions & chats — one command

Everything runs through `~/.claude/skills/carry-over/carry_over.py` (Python 3 stdlib). The `run`
subcommand does every step in order and skips whatever is already done, so it is safe to run
before switching, after switching, and again any time.

| Step | What it does | Skips when |
|---|---|---|
| 1. Backup | `~/.claude` + the desktop session list → `~/ClaudeArchive/backups/<date>/` | a backup exists from the last 24 h |
| 2. Snapshot | every session, folder and transcript status → `~/Documents/Vault/Claude-Migration/sessions.md` | — |
| 3. Refresh chats | `claudex export` of the **currently signed-in** account's claude.ai chats → `~/ClaudeArchive/chats-raw/` | claudex not installed, or `--no-claudex` |
| 4. Import chats | claudex output + any **official export ZIP in ~/Downloads** → Markdown notes in `~/ClaudeArchive/chats/` with a cumulative `INDEX.md` | ZIPs already imported (tracked in `~/ClaudeArchive/state.json`) |
| 5. Restore sessions | copies Code sessions from other account folders into this account's folder (strips old-account connector settings, points them at their current folders) | sessions already present, or with no transcript left |

Chats and backups live in `~/ClaudeArchive/`, outside `~/Documents`, because Documents is often
cloud-synced and these contain private data. Override with `CARRY_OVER_ARCHIVE` / `CARRY_OVER_VAULT`.

## When the user runs /carry-over

1. Get this session's id with the `get_session` tool (`session_id: "self"`). Its account folder is the restore target.
2. Dry run and show the user the plan (summarize; don't paste all 50+ session lines):
   `python3 ~/.claude/skills/carry-over/carry_over.py run --target-session <local_id>`
3. Ask one question: "Run all of it?" Mention that step 3 may trigger a macOS Keychain prompt
   ("Claude Safe Storage") which they should Allow, and that it exports whichever account is signed in right now.
4. On yes: the same command with `--apply` (run it in the background — claudex over hundreds of chats takes minutes).
   Add `--include-archived` only if they asked for archived sessions; `--no-claudex` if they declined the Keychain step.
5. Report: backup location, chats imported (total in `INDEX.md`), sessions restored. If any were restored,
   tell them to quit Claude completely (Cmd+Q) and reopen it; opening a restored session continues it.

If a restored session will not open, the CLI resumes it from the local transcript under any account:
`cd <folder> && claude --resume <cliSessionId>` (the id is in the session JSON).

## Individual steps (only if the user asks for one)

- `snapshot` — step 2 only.
- `restore --target-session <id> [--apply] [--include-archived]` — step 5 only.
- `import-chats <zip-or-folder> [--apply]` — step 4 for a specific export.

To continue an old chat: open a session and say "Read `~/ClaudeArchive/chats/<month>/<file>.md` and continue from where it ends."

## Rules

- Always dry-run first; `--apply` only after the user says yes.
- Never delete an account's session folder, the archive, or backups — every step copies.
- Only the **official export** includes claude.ai Projects (instructions + files). If `~/ClaudeArchive/chats/_projects/` is empty, remind the user to request it: claude.ai → Settings → Privacy → Export data, then leave the ZIP in ~/Downloads and run /carry-over again.
