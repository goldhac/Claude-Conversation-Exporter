// Fetch conversations and write them to disk (or a ZIP) in the chosen format(s).
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const convert = require('./convert');
const { mapLimit, sleep } = require('./concurrency');
const { logger } = require('./logger');

const VALID_FORMATS = ['json', 'markdown', 'text', 'all'];

function formatsFor(format) {
  return format === 'all' ? ['json', 'markdown', 'text'] : [format];
}

const EXT = { json: 'json', markdown: 'md', text: 'txt' };

function buildConvertOptions(opts) {
  return {
    includeMetadata: opts.metadata !== false,
    thinking: opts.thinking !== false,
    tools: opts.tools !== false,
    attachments: opts.attachments !== false,
    allBranches: !opts.activeBranchOnly,
    timestampStyle: 'locale',
  };
}

function renderOne(full, format, convertOpts) {
  if (format === 'markdown') return convert.convertToMarkdown(full, convertOpts);
  if (format === 'text') return convert.convertToText(full, convertOpts);
  return JSON.stringify(full, null, 2); // json
}

// Unique, filesystem-safe base name for a conversation.
function uniqueName(title, uuid, used) {
  const base = convert.sanitizeFilename(title || uuid || 'conversation');
  let name = base;
  if (used.has(name.toLowerCase())) name = base + '-' + String(uuid || '').slice(0, 8);
  let n = 2;
  while (used.has(name.toLowerCase())) name = base + '-' + String(uuid || '').slice(0, 8) + '-' + n++;
  used.add(name.toLowerCase());
  return name;
}

// convos: array of {uuid, name}. Returns a summary object.
async function exportConversations(client, convos, opts, cfg) {
  if (VALID_FORMATS.indexOf(opts.format) === -1) {
    throw new Error('Invalid --format "' + opts.format + '". Use one of: ' + VALID_FORMATS.join(', '));
  }
  const formats = formatsFor(opts.format);
  const convertOpts = buildConvertOptions(opts);
  const outDir = path.resolve(opts.out || cfg.out);
  const used = new Set();
  const tolerateFailures = !!opts.all; // single-id export should surface errors
  const zip = opts.zip ? new JSZip() : null;

  fs.mkdirSync(outDir, { recursive: true });

  let exported = 0;
  let failed = 0;
  const failures = [];

  await mapLimit(convos, cfg.concurrency, async (conv, i) => {
    try {
      const full = await client.getConversation(conv.uuid);
      full.model = convert.inferModel(full);
      const base = uniqueName(full.name || conv.name, conv.uuid, used);

      for (const fmt of formats) {
        const content = renderOne(full, fmt, convertOpts);
        const filename = base + '.' + EXT[fmt];
        if (zip) {
          zip.file(filename, content);
        } else {
          await fs.promises.writeFile(path.join(outDir, filename), content);
        }
      }
      exported++;
      logger.step('  [' + (i + 1) + '/' + convos.length + '] ' + (full.name || conv.uuid));
      await sleep(150); // be polite to the API
    } catch (err) {
      if (!tolerateFailures) throw err;
      failed++;
      failures.push({ uuid: conv.uuid, name: conv.name, error: err.message });
      logger.warn('failed: ' + (conv.name || conv.uuid) + ': ' + err.message);
    }
  });

  const summary = {
    export_date: new Date().toISOString(),
    total: convos.length,
    exported,
    failed,
    failures,
    formats,
    options: {
      allBranches: convertOpts.allBranches,
      thinking: convertOpts.thinking,
      tools: convertOpts.tools,
      attachments: convertOpts.attachments,
      includeMetadata: convertOpts.includeMetadata,
    },
  };

  if (zip) {
    zip.file('export_summary.json', JSON.stringify(summary, null, 2));
    const zipBase = opts.zipLabel
      ? convert.sanitizeFilename(opts.zipLabel)
      : 'claude-conversations-' + new Date().toISOString().slice(0, 10);
    const zipPath = path.join(outDir, zipBase + '.zip');
    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fs.promises.writeFile(zipPath, buf);
    logger.info('\n✓ Wrote ' + exported + ' conversation(s) to ' + zipPath + (failed ? ' (' + failed + ' failed)' : ''));
  } else {
    if (convos.length > 1 || failed) {
      await fs.promises.writeFile(path.join(outDir, 'export_summary.json'), JSON.stringify(summary, null, 2));
    }
    logger.info('\n✓ Exported ' + exported + ' conversation(s) to ' + outDir + (failed ? ' (' + failed + ' failed)' : ''));
  }

  return summary;
}

module.exports = { exportConversations, buildConvertOptions, formatsFor, VALID_FORMATS };
