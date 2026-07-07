// `claude-export export [id] [--all]` — export one or many conversations.
const { resolveSession } = require('../session');
const { resolveConfig } = require('../config');
const { ClaudeApiClient } = require('../api');
const { logger } = require('../logger');
const { exportConversations } = require('../exporter');

function applySince(list, since) {
  if (!since) return list;
  const t = new Date(since).getTime();
  if (isNaN(t)) throw new Error('Invalid --since date: ' + since);
  return list.filter((c) => new Date(c.updated_at).getTime() >= t);
}

module.exports = async function exportCmd(conversationId, opts) {
  if (!conversationId && !opts.all) {
    throw new Error('Provide a conversationId, or use --all. See `claude-export export --help`.');
  }

  const cfg = resolveConfig(opts);
  const session = resolveSession(opts);
  const client = new ClaudeApiClient({ cookies: session.cookies, userAgent: cfg.userAgent, org: session.org });

  let convos;
  if (opts.all) {
    logger.info('Fetching conversation list…');
    convos = await client.listConversations();
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
