// `claude-export auth [--offline]` — verify the session can be read and used.
const { resolveSession } = require('../session');
const { resolveConfig } = require('../config');
const { ClaudeApiClient } = require('../api');
const { logger } = require('../logger');

module.exports = async function auth(opts) {
  const cfg = resolveConfig(opts);

  logger.info('Resolving session…');
  if (!opts.sessionKey) {
    logger.info('  (reading the Claude Desktop app — macOS may ask for Keychain access; click "Always Allow")');
  }
  const session = resolveSession(opts);
  const sk = session.sessionKey;

  logger.info('  source     : ' + (session.source === 'manual' ? '--session-key (manual)' : 'Claude Desktop app'));
  logger.info('  sessionKey : ' + sk.slice(0, 12) + '…' + sk.slice(-4) + ' (len ' + sk.length + ')');
  if (session.cookieDbVersion) logger.info('  cookie DB  : v' + session.cookieDbVersion);
  logger.info('  org        : ' + (session.org || '(will resolve via API)'));
  const cf = ['__cf_bm', 'cf_clearance'].filter((n) => session.cookies[n]);
  logger.info('  cloudflare : ' + (cf.length ? cf.join(', ') : 'none (may be needed if challenged)'));

  if (opts.offline) {
    logger.info('\n✓ Offline check OK — session decrypted successfully (no network contacted).');
    return;
  }

  logger.info('Contacting claude.ai…');
  const client = new ClaudeApiClient({ cookies: session.cookies, userAgent: cfg.userAgent, org: session.org });
  const org = await client.resolveOrg();
  // A minimal request that proves the session is accepted.
  const firstPage = await client.request('/organizations/' + org + '/chat_conversations?limit=1&offset=0');
  const n = Array.isArray(firstPage) ? firstPage.length : 0;

  logger.info('  org        : ' + org);
  logger.info('  reachable  : yes — session is valid' + (n ? ' (conversations visible)' : ''));
  logger.info('\n✓ Auth OK. Try `claude-export list`, or `claude-export export --all`.');
};
