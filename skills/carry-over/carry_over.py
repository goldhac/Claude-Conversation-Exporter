#!/usr/bin/env python3
"""Carry Claude Desktop sessions (and claude.ai chats) over to a new account.

The desktop app keeps one small JSON per Code session under
  ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json
The transcript it points to (cliSessionId) lives in ~/.claude/projects and is
not tied to an account, so copying the JSON into the new account's folder
brings the session back — same title, same folder, fully resumable.

Commands
  snapshot                 write a manifest of every session to the Vault
  restore --target-session local_<id> [--apply]
                           copy sessions from the old account folder into the
                           folder that holds <id> (a session in the NEW account).
                           Dry run unless --apply.
  import-chats <export.zip|dir> [--apply]
                           turn a claude.ai export (the official data export, or
                           claudex output from `claudex export --all --format all`)
                           into Markdown notes under Vault/Claude-Chats/.
                           Dry run unless --apply.
"""
import argparse, datetime, glob, json, os, re, shutil, sys, zipfile

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions')
# Where chat notes and the session snapshot go. Override with CARRY_OVER_VAULT.
VAULT = os.path.expanduser(os.environ.get('CARRY_OVER_VAULT', '~/Documents/Vault'))
MIGRATION = os.path.join(VAULT, 'Claude-Migration')
CHATS = os.path.join(VAULT, 'Claude-Chats')

# Fields that reference the old account's connectors, artifacts or remote state.
# The new account rebuilds them on first open.
ACCOUNT_FIELDS = ['enabledMcpTools', 'remoteMcpServersConfig', 'bridgeSessionIds',
                  'publishedArtifacts', 'chromeTabGroupId', 'toolSurfaceSnapshot',
                  'promptAppendSnapshot', 'postTurnSummary', 'postTurnSummaryFor',
                  'remoteControlAutoEligible', 'steeredByRemoteClient']


def ms_date(ms):
    return datetime.datetime.fromtimestamp((ms or 0) / 1000).strftime('%Y-%m-%d')


def account_dirs():
    """[(dir, [session files])] for every <account>/<org> folder, biggest first."""
    out = []
    for d in glob.glob(os.path.join(SESSIONS, '*', '*')):
        files = glob.glob(os.path.join(d, 'local_*.json'))
        if files:
            out.append((d, files))
    return sorted(out, key=lambda x: -len(x[1]))


def load(path):
    with open(path) as f:
        return json.load(f)


def transcript_path(s):
    """Where Claude Code keeps this session's transcript (cwd with / -> -)."""
    cid = s.get('cliSessionId')
    if not cid:
        return ''
    key = re.sub(r'[^A-Za-z0-9]', '-', s.get('originCwd') or s.get('cwd') or '')
    path = os.path.join(HOME, '.claude/projects', key, cid + '.jsonl')
    if not os.path.exists(os.path.realpath(path)):  # e.g. sessions that ran in a worktree
        hits = glob.glob(os.path.join(HOME, '.claude/projects', '*', cid + '.jsonl'))
        if hits:
            return hits[0]
    return path


def has_transcript(s):
    t = transcript_path(s)
    return bool(t) and os.path.exists(os.path.realpath(t))


# ---------------------------------------------------------------- snapshot
def cmd_snapshot(_):
    dirs = account_dirs()
    if not dirs:
        sys.exit('No desktop sessions found under ' + SESSIONS)
    os.makedirs(MIGRATION, exist_ok=True)
    rows = []
    for d, files in dirs:
        for f in files:
            s = load(f)
            rows.append((s.get('lastActivityAt') or 0, s, d))
    rows.sort(key=lambda r: -r[0])
    lines = ['# Claude sessions snapshot', '',
             'Taken ' + datetime.date.today().isoformat() + '. Restore with `/carry-over` in the new account.', '',
             '| Last active | Title | Folder | Archived | Transcript |', '|---|---|---|---|---|']
    for ts, s, d in rows:
        lines.append('| %s | %s | `%s` | %s | %s |' % (
            ms_date(ts), (s.get('title') or '(untitled)').replace('|', '/'),
            os.path.realpath(s.get('cwd') or ''), 'yes' if s.get('isArchived') else '',
            'ok' if has_transcript(s) else 'MISSING'))
    out = os.path.join(MIGRATION, 'sessions.md')
    with open(out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    missing = sum(1 for l in lines if l.endswith('MISSING |'))
    print('Snapshot: %d sessions across %d account folder(s) -> %s' % (len(rows), len(dirs), out))
    for d, files in dirs:
        print('  %3d  %s' % (len(files), os.path.relpath(d, SESSIONS)))
    if missing:
        print('  %d session(s) have no transcript on disk (already empty); restore skips them.' % missing)


# ----------------------------------------------------------------- restore
def cmd_restore(a):
    hits = glob.glob(os.path.join(SESSIONS, '*', '*', a.target_session + '.json'))
    if not hits:
        sys.exit('Could not find %s.json under %s' % (a.target_session, SESSIONS))
    target = os.path.dirname(hits[0])
    sources = [(d, f) for d, f in account_dirs() if d != target]
    if a.source:
        sources = [(d, f) for d, f in sources if a.source in d]
    if not sources:
        sys.exit('No other account folders to restore from.')
    existing = {os.path.basename(p) for p in glob.glob(os.path.join(target, 'local_*.json'))}
    plan, empty = [], 0
    for d, files in sources:
        for f in files:
            name = os.path.basename(f)
            if name in existing:
                continue
            s = load(f)
            if s.get('isArchived') and not a.include_archived:
                continue
            if not has_transcript(s):
                empty += 1
                continue
            plan.append((f, s))
    print('Target (new account): ' + os.path.relpath(target, SESSIONS))
    print('Sources: ' + ', '.join('%s (%d)' % (os.path.relpath(d, SESSIONS), len(f)) for d, f in sources))
    print('%d session(s) to restore%s; %d skipped (no transcript left on disk):' % (
        len(plan), '' if a.apply else ' (dry run)', empty))
    for f, s in sorted(plan, key=lambda p: -(p[1].get('lastActivityAt') or 0)):
        cwd = os.path.realpath(s.get('cwd') or '')
        print('  %s  %-45s %s' % (ms_date(s.get('lastActivityAt')), (s.get('title') or '')[:45], cwd))
    if not a.apply:
        print('\nNothing written. Re-run with --apply, then quit and reopen Claude.')
        return
    for f, s in plan:
        for k in ACCOUNT_FIELDS:
            s.pop(k, None)
        # Point at the real (post-reorganisation) folder; keep originCwd so the
        # transcript lookup key still matches.
        if s.get('cwd'):
            s['cwd'] = os.path.realpath(s['cwd'])
        with open(os.path.join(target, os.path.basename(f)), 'w') as out:
            json.dump(s, out, indent=2)
    print('\nRestored %d session(s). Quit Claude completely (Cmd+Q) and reopen it to see them.' % len(plan))


# ------------------------------------------------------------ import-chats
def slug(s, n=70):
    s = re.sub(r'[\\/:*?"<>|#\[\]^]', '', s or 'Untitled').strip()
    return (s[:n].rstrip() or 'Untitled')


def msg_text(m):
    parts = []
    for c in m.get('content') or []:
        if c.get('type') == 'text' and c.get('text'):
            parts.append(c['text'])
        elif c.get('type') == 'thinking' and c.get('thinking'):
            parts.append('<details><summary>Thinking</summary>\n\n' + c['thinking'] + '\n\n</details>')
        elif c.get('type') == 'tool_use':
            parts.append('> 🔧 tool: `%s`' % c.get('name'))
    if not parts and m.get('text'):
        parts.append(m['text'])
    for att in m.get('attachments') or []:
        parts.append('> 📎 %s' % (att.get('file_name') or 'attachment'))
    for fl in m.get('files') or []:
        parts.append('> 📎 %s' % (fl.get('file_name') or 'file'))
    return '\n\n'.join(parts).strip()


def read_export(src):
    """Official export (conversations.json + projects.json) or claudex output
    (one <name>.json per conversation, plus <name>.md with --format all)."""
    def pick(names, get):
        conv = next((n for n in names if n.endswith('conversations.json')), None)
        proj = next((n for n in names if n.endswith('projects.json')), None)
        if conv:
            return json.loads(get(conv)), (json.loads(get(proj)) if proj else [])
        convs = []
        for n in names:
            if not n.endswith('.json') or os.path.basename(n) == 'export_summary.json':
                continue
            c = json.loads(get(n))
            if isinstance(c, dict) and 'chat_messages' in c:
                md = n[:-5] + '.md'
                if md in names:  # claudex's own branch-aware rendering
                    text = get(md).decode('utf-8', 'replace').lstrip()
                    if text.startswith('# '):  # we write our own title
                        text = text.split('\n', 1)[1] if '\n' in text else ''
                    c['_rendered_md'] = text.strip()
                convs.append(c)
        if not convs:
            sys.exit('No conversations found: expected conversations.json (official export) '
                     'or claudex JSON files (export with --format json or all).')
        return convs, []
    if zipfile.is_zipfile(src):
        z = zipfile.ZipFile(src)
        return pick(z.namelist(), lambda n: z.read(n))
    names = [os.path.join(r, f) for r, _, fs in os.walk(src) for f in fs]
    return pick(names, lambda n: open(n, 'rb').read())


def cmd_import(a):
    convs, projects = read_export(a.source)
    convs = [c for c in convs if c.get('chat_messages')]
    print('%d conversations with messages, %d projects%s' % (len(convs), len(projects), '' if a.apply else ' (dry run)'))
    if not a.apply:
        for c in sorted(convs, key=lambda c: c.get('updated_at') or '', reverse=True)[:15]:
            print('  %s  %s' % ((c.get('created_at') or '')[:10], c.get('name') or 'Untitled'))
        print('  …\nNothing written. Re-run with --apply.')
        return
    index = {}
    for c in convs:
        day = (c.get('created_at') or '0000-00-00')[:10]
        rel = os.path.join(day[:7], '%s %s.md' % (day, slug(c.get('name'))))
        path = os.path.join(CHATS, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        body = ['---', 'type: claude-chat', 'uuid: ' + c.get('uuid', ''),
                'created: ' + (c.get('created_at') or ''), 'updated: ' + (c.get('updated_at') or ''),
                'messages: %d' % len(c['chat_messages']), '---', '',
                '# ' + (c.get('name') or 'Untitled'), '']
        if c.get('summary'):
            body += ['> ' + c['summary'].replace('\n', '\n> '), '']
        if c.get('_rendered_md'):
            body += [c['_rendered_md']]
        else:
            for m in c['chat_messages']:
                who = '🧑 You' if m.get('sender') == 'human' else '🤖 Claude'
                body += ['## %s · %s' % (who, (m.get('created_at') or '')[:16].replace('T', ' ')), '', msg_text(m), '']
        with open(path, 'w') as f:
            f.write('\n'.join(body))
        index.setdefault(day[:7], []).append((day, c.get('name') or 'Untitled', rel))
    for p in projects:
        pdir = os.path.join(CHATS, '_projects')
        os.makedirs(pdir, exist_ok=True)
        lines = ['# ' + (p.get('name') or 'Project'), '', p.get('description') or '', '']
        if p.get('prompt_template'):
            lines += ['## Project instructions', '', p['prompt_template'], '']
        for d in p.get('docs') or []:
            lines += ['## 📄 ' + (d.get('filename') or 'doc'), '', d.get('content') or '', '']
        with open(os.path.join(pdir, slug(p.get('name')) + '.md'), 'w') as f:
            f.write('\n'.join(lines))
    idx = ['# Claude.ai chats', '', 'Imported %s from the official export. %d chats, %d projects (see `_projects/`).' %
           (datetime.date.today().isoformat(), len(convs), len(projects)), '']
    for month in sorted(index, reverse=True):
        idx += ['## ' + month, '']
        for day, name, rel in sorted(index[month], reverse=True):
            idx.append('- %s — [%s](%s)' % (day, name.replace('[', '(').replace(']', ')'), rel.replace(' ', '%20')))
        idx.append('')
    with open(os.path.join(CHATS, 'INDEX.md'), 'w') as f:
        f.write('\n'.join(idx))
    print('Wrote %d chats + %d projects to %s (index: INDEX.md)' % (len(convs), len(projects), CHATS))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('snapshot')
    r = sub.add_parser('restore')
    r.add_argument('--target-session', required=True, help='local_<id> of a session in the NEW account')
    r.add_argument('--source', help='only restore from account folders containing this text')
    r.add_argument('--include-archived', action='store_true')
    r.add_argument('--apply', action='store_true')
    i = sub.add_parser('import-chats')
    i.add_argument('source', help='the export .zip or its unzipped folder')
    i.add_argument('--apply', action='store_true')
    a = p.parse_args()
    {'snapshot': cmd_snapshot, 'restore': cmd_restore, 'import-chats': cmd_import}[a.cmd](a)


if __name__ == '__main__':
    main()
