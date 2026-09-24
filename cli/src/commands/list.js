// `claude-export list` — list conversations (human table or --json).
const { resolveSession } = require('../session');
const { resolveConfig } = require('../config');
const { ClaudeApiClient } = require('../api');
const { logger } = require('../logger');
const { resolveProject } = require('../projects');
const convert = require('../convert');

function applySince(list, since) {
  if (!since) return list;
  const t = new Date(since).getTime();
  if (isNaN(t)) throw new Error('Invalid --since date: ' + since);
  return list.filter((c) => new Date(c.updated_at).getTime() >= t);
}

module.exports = async function list(opts) {
  const cfg = resolveConfig(opts);
  const session = resolveSession(opts);
  const client = new ClaudeApiClient({ cookies: session.cookies, userAgent: cfg.userAgent, org: session.org });

  let convos = await client.listConversations();
  if (opts.project) {
    const proj = resolveProject(await client.listProjects(), opts.project);
    convos = convos.filter((c) => c.project_uuid === proj.uuid);
    logger.info('project: ' + (proj.name || '(unnamed)') + ' (' + proj.uuid + ')');
  }
  convos = applySince(convos, opts.since);
  convos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (opts.limit) convos = convos.slice(0, Math.max(0, Number(opts.limit) || 0));

  if (opts.json) {
    logger.out(JSON.stringify(convos, null, 2) + '\n');
    return;
  }

  for (const c of convos) {
    const date = new Date(c.updated_at).toISOString().slice(0, 10);
    const model = convert.formatModelName(convert.inferModel(c));
    logger.out(date + '  ' + c.uuid + '  ' + String(model).padEnd(18) + '  ' + (c.name || '(untitled)') + '\n');
  }
  logger.info('\n' + convos.length + ' conversation(s).');
};
