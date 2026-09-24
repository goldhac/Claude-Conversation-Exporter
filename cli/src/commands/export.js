// `claudex export [id] [--all] [--project <name>]` — export one or many conversations.
const path = require('path');
const { resolveSession } = require('../session');
const { resolveConfig } = require('../config');
const { ClaudeApiClient } = require('../api');
const { logger } = require('../logger');
const { resolveProject } = require('../projects');
const { exportConversations } = require('../exporter');
const convert = require('../convert');

function applySince(list, since) {
  if (!since) return list;
  const t = new Date(since).getTime();
  if (isNaN(t)) throw new Error('Invalid --since date: ' + since);
  return list.filter((c) => new Date(c.updated_at).getTime() >= t);
}

module.exports = async function exportCmd(conversationId, opts) {
  if (!conversationId && !opts.all && !opts.project) {
    throw new Error('Provide a conversationId, or use --all or --project <name>. See `claudex export --help`.');
  }

  const cfg = resolveConfig(opts);
  const session = resolveSession(opts);
  const client = new ClaudeApiClient({ cookies: session.cookies, userAgent: cfg.userAgent, org: session.org });

  let convos;
  if (opts.all || opts.project) {
    logger.info('Fetching conversation list…');
    convos = await client.listConversations();

    if (opts.project) {
      const proj = resolveProject(await client.listProjects(), opts.project);
      convos = convos.filter((c) => c.project_uuid === proj.uuid);
      // Default output into a per-project subfolder unless the user set --out.
      if (!opts.out) opts.out = path.join(cfg.out, convert.sanitizeFilename(proj.name || proj.uuid));
      // With --zip, name the archive after the project (not a generic date name).
      opts.zipLabel = proj.name || proj.uuid;
      logger.info('Project: ' + (proj.name || '(unnamed)') + ' — ' + convos.length + ' conversation(s)');
    }

    convos = applySince(convos, opts.since);
    convos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (opts.limit) convos = convos.slice(0, Math.max(0, Number(opts.limit) || 0));
    logger.info('Exporting ' + convos.length + ' conversation(s) as ' + opts.format + '…');
  } else {
    convos = [{ uuid: conversationId, name: conversationId }];
    logger.info('Exporting conversation ' + conversationId + ' as ' + opts.format + '…');
  }

  if (convos.length === 0) {
    logger.info('Nothing to export.');
    return;
  }

  await exportConversations(client, convos, opts, cfg);
};
