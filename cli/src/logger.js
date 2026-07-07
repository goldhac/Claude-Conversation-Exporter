// Minimal logger that writes human-facing output to stderr (so stdout stays
// clean for data like `list --json`) and redacts session keys everywhere.

function redact(value) {
  if (typeof value !== 'string') return value;
  // sk-ant-... session keys and any long token-looking secret.
  return value.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, (m) => m.slice(0, 12) + '…' + m.slice(-4));
}

function fmt(args) {
  return args.map(redact);
}

const logger = {
  info(...args) { console.error(...fmt(args)); },
  step(...args) { console.error(...fmt(args)); },
  warn(...args) { console.error('⚠ ', ...fmt(args)); },
  error(...args) { console.error('✖ ', ...fmt(args)); },
  // Data goes to stdout (unredacted — the user asked for it).
  out(text) { process.stdout.write(text); },
};

module.exports = { logger, redact };
