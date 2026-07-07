// Defaults + optional user config file (~/.config/claude-export/config.json).
const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-export');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// A realistic macOS desktop User-Agent. Claude Desktop is Electron/Chromium, so
// presenting a Chrome-like UA helps avoid Cloudflare challenges. Overridable via
// --user-agent or the config file.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function loadFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Merge precedence: explicit CLI flags > config file > built-in defaults.
function resolveConfig(flags) {
  flags = flags || {};
  const file = loadFileConfig();
  return {
    userAgent: flags.userAgent || file.userAgent || DEFAULT_USER_AGENT,
    out: flags.out || file.out || './claudex',
    concurrency: Number(flags.concurrency || file.concurrency || 3) || 3,
  };
}

module.exports = { resolveConfig, loadFileConfig, DEFAULT_USER_AGENT, CONFIG_PATH, CONFIG_DIR };
