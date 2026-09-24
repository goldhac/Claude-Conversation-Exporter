#!/usr/bin/env python3
"""Carry Claude Desktop sessions (and claude.ai chats) over to a new account.

The desktop app keeps one small JSON per Code session under
  ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json
The transcript it points to (cliSessionId) lives in ~/.claude/projects and is
not tied to an account, so copying the JSON into the new account's folder
brings the session back — same title, same folder, fully resumable.

Commands
  run --target-session local_<id> [--apply]
                           everything, in order, skipping what is already done:
                           backup -> snapshot -> refresh chats (claudex) ->
                           import chats (claudex output + any official export ZIP
                           in ~/Downloads) -> restore sessions. Dry run unless --apply.
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
import argparse, datetime, glob, json, os, re, shutil, subprocess, sys, time, zipfile

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions')
# Where chat notes and the session snapshot go. Override with CARRY_OVER_VAULT.
VAULT = os.path.expanduser(os.environ.get('CARRY_OVER_VAULT', '~/Documents/Vault'))
MIGRATION = os.path.join(VAULT, 'Claude-Migration')
# Chats and backups hold private data, so they live outside ~/Documents (which is
# often cloud-synced). Override with CARRY_OVER_ARCHIVE.
ARCHIVE = os.path.expanduser(os.environ.get('CARRY_OVER_ARCHIVE', '~/ClaudeArchive'))
CHATS = os.path.join(ARCHIVE, 'chats')
RAW = os.path.join(ARCHIVE, 'chats-raw')
BACKUPS = os.path.join(ARCHIVE, 'backups')
STATE = os.path.join(ARCHIVE, 'state.json')

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
    index, written = {}, {}
    for c in convs:
        day = (c.get('created_at') or '0000-00-00')[:10]
        rel = os.path.join(day[:7], '%s %s.md' % (day, slug(c.get('name'))))
        taken = written.get(rel) or note_uuid(os.path.join(CHATS, rel))
        if taken and taken != c.get('uuid'):  # same title, same day, different chat
            rel = rel[:-3] + ' ' + (c.get('uuid') or '')[:8] + '.md'
        written[rel] = c.get('uuid')
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
    total = rebuild_index()
    print('Wrote %d chats + %d projects to %s (index: INDEX.md, %d chats total)' % (
        len(convs), len(projects), CHATS, total))


def note_uuid(path):
    try:
        with open(path) as f:
            for line in f.readlines()[:8]:
                if line.startswith('uuid: '):
                    return line[6:].strip()
    except OSError:
        pass
    return None


def rebuild_index():
    """INDEX.md from every note on disk, so repeated imports accumulate."""
    index = {}
    for path in glob.glob(os.path.join(CHATS, '[0-9][0-9][0-9][0-9]-[0-9][0-9]', '*.md')):
        rel = os.path.relpath(path, CHATS)
        name = os.path.basename(path)[11:-3]
        with open(path) as f:
            for line in f.readlines()[:12]:
                if line.startswith('# '):
                    name = line[2:].strip()
                    break
        day = os.path.basename(path)[:10]
        index.setdefault(day[:7], []).append((day, name, rel))
    projects = sorted(glob.glob(os.path.join(CHATS, '_projects', '*.md')))
    total = sum(len(v) for v in index.values())
    idx = ['# Claude.ai chats', '', 'Updated %s. %d chats%s.' % (
        datetime.date.today().isoformat(), total,
        ', %d projects in `_projects/`' % len(projects) if projects else ''), '']
    for month in sorted(index, reverse=True):
        idx += ['## ' + month, '']
        for day, name, rel in sorted(index[month], reverse=True):
            idx.append('- %s — [%s](%s)' % (day, name.replace('[', '(').replace(']', ')'), rel.replace(' ', '%20')))
        idx.append('')
    os.makedirs(CHATS, exist_ok=True)
    with open(os.path.join(CHATS, 'INDEX.md'), 'w') as f:
        f.write('\n'.join(idx))
    return total


# --------------------------------------------------------------------- run
def load_state():
    try:
        return load(STATE)
    except (OSError, ValueError):
        return {}


def save_state(st):
    os.makedirs(ARCHIVE, exist_ok=True)
    with open(STATE, 'w') as f:
        json.dump(st, f, indent=2)


def recent_backup(hours=24):
    for b in glob.glob(os.path.join(BACKUPS, '*')) + glob.glob(os.path.join(HOME, 'claude-migration-backup-*')):
        if time.time() - os.path.getmtime(b) < hours * 3600:
            return b
    return None


def official_exports():
    """Official claude.ai export ZIPs in ~/Downloads (they contain conversations.json)."""
    out = []
    for z in glob.glob(os.path.join(HOME, 'Downloads', '*.zip')):
        try:
            if any(n.endswith('conversations.json') for n in zipfile.ZipFile(z).namelist()):
                out.append(z)
        except (zipfile.BadZipFile, OSError):
            pass
    return sorted(out, key=os.path.getmtime)


def cmd_run(a):
    st = load_state()
    mode = 'APPLYING' if a.apply else 'DRY RUN — nothing is written'
    print('== carry-over run (%s)\n' % mode)

    # 1. backup
    b = recent_backup()
    print('1. Backup: ' + ('recent backup exists (%s) — skip' % b if b else 'will back up ~/.claude and the desktop session list to ' + BACKUPS))
    if a.apply and not b:
        dest = os.path.join(BACKUPS, datetime.datetime.now().strftime('%Y-%m-%d-%H%M'))
        os.makedirs(dest)
        subprocess.run(['tar', '-czf', os.path.join(dest, 'dot-claude.tgz'), '-C', HOME, '.claude'], check=True)
        subprocess.run(['tar', '-czf', os.path.join(dest, 'desktop-sessions.tgz'), '-C',
                        os.path.dirname(SESSIONS), os.path.basename(SESSIONS)], check=True)
        print('   backed up to ' + dest)

    # 2. snapshot
    print('2. Snapshot: session list -> ' + os.path.join(MIGRATION, 'sessions.md'))
    if a.apply:
        cmd_snapshot(a)

    # 3. refresh chats with claudex (reads the Desktop app's current login)
    claudex = shutil.which('claudex')
    if a.no_claudex or not claudex:
        print('3. Refresh chats (claudex): ' + ('skipped (--no-claudex)' if claudex else 'claudex not installed — skip'))
    else:
        print('3. Refresh chats (claudex): export this account\'s claude.ai chats to ' + RAW +
              ' (macOS may ask for Keychain access once)')
        if a.apply:
            r = subprocess.run([claudex, 'export', '--all', '--format', 'all', '--out', RAW])
            if r.returncode == 0:
                st['claudex_at'] = datetime.datetime.now().isoformat(timespec='seconds')
            else:
                print('   claudex failed (exit %d) — continuing with what is already on disk' % r.returncode)

    # 4. import chats
    imported = set(st.get('imported_zips', []))
    zips = [z for z in official_exports() if z not in imported]
    have_raw = os.path.isdir(RAW) and glob.glob(os.path.join(RAW, '*.json'))
    print('4. Import chats -> %s: %s%s' % (CHATS, 'claudex output' if (have_raw or (claudex and not a.no_claudex)) else 'no claudex output',
          '; official export ZIP(s): ' + ', '.join(os.path.basename(z) for z in zips) if zips else '; no new official export ZIP in ~/Downloads'))
    if a.apply:
        class I: apply = True
        if glob.glob(os.path.join(RAW, '*.json')):
            I.source = RAW
            cmd_import(I)
        for z in zips:
            I.source = z
            cmd_import(I)
            imported.add(z)
        st['imported_zips'] = sorted(imported)

    # 5. restore sessions into this account
    print('5. Restore Code sessions:')
    if a.target_session:
        class R: target_session = a.target_session; source = None
        R.include_archived = a.include_archived
        R.apply = a.apply
        try:
            cmd_restore(R)
        except SystemExit as e:  # e.g. only one account folder yet
            print('   ' + str(e))
    else:
        print('   skipped (no --target-session)')

    if a.apply:
        st['last_run'] = datetime.datetime.now().isoformat(timespec='seconds')
        save_state(st)
        print('\nDone. If sessions were restored: quit Claude (Cmd+Q) and reopen it.')
    else:
        print('\nDry run only. Re-run with --apply to do all of the above.')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    run = sub.add_parser('run')
    run.add_argument('--target-session', help='local_<id> of the session running this (its account is the target)')
    run.add_argument('--include-archived', action='store_true')
    run.add_argument('--no-claudex', action='store_true', help='do not refresh chats with claudex')
    run.add_argument('--apply', action='store_true')
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
    {'run': cmd_run, 'snapshot': cmd_snapshot, 'restore': cmd_restore, 'import-chats': cmd_import}[a.cmd](a)


if __name__ == '__main__':
    main()
