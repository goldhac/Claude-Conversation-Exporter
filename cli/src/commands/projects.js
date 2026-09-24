// `claude-export projects` — list projects with conversation counts.
const { resolveSession } = require('../session');
const { resolveConfig } = require('../config');
const { ClaudeApiClient } = require('../api');
const { logger } = require('../logger');

module.exports = async function projects(opts) {
  const cfg = resolveConfig(opts);
  const session = resolveSession(opts);
  const client = new ClaudeApiClient({ cookies: session.cookies, userAgent: cfg.userAgent, org: session.org });

  const projects = await client.listProjects();
  const convos = await client.listConversations();
  const counts = {};
  for (const c of convos) if (c.project_uuid) counts[c.project_uuid] = (counts[c.project_uuid] || 0) + 1;

  projects.sort((a, b) => (counts[b.uuid] || 0) - (counts[a.uuid] || 0) || String(a.name).localeCompare(String(b.name)));

  if (opts.json) {
    logger.out(JSON.stringify(projects.map((p) => Object.assign({ conversation_count: counts[p.uuid] || 0 }, p)), null, 2) + '\n');
    return;
  }

  for (const p of projects) {
    logger.out(String(counts[p.uuid] || 0).padStart(4) + '  ' + p.uuid + '  ' + (p.name || '(unnamed)') + '\n');
  }
  logger.info('\n' + projects.length + ' project(s). Export one with:  claudex export --project "<name>"');
};
