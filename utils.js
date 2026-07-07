// Shared conversion core for Claude Conversation Exporter.
//
// This file is a UMD module: it assigns functions to the global scope when
// loaded as a plain <script> / content script (browser extension), and sets
// module.exports when required from Node (the `cli/` tool). Keep every function
// in here DOM-free and side-effect-free so both environments can use it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;            // Node (CLI)
  } else {
    Object.assign(root, api);        // Browser globals (extension pages + content script)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Messages whose parent is missing or this sentinel are treated as roots.
  const ROOT_SENTINEL = '00000000-0000-4000-8000-000000000000';

  // ---------------------------------------------------------------------------
  // Model helpers
  // ---------------------------------------------------------------------------

  const MODEL_DISPLAY_NAMES = {
    'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
    'claude-3-opus-20240229': 'Claude 3 Opus',
    'claude-3-haiku-20240307': 'Claude 3 Haiku',
    'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet',
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
    'claude-3-5-sonnet-20241022': 'Claude 3.6 Sonnet',
    'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
    'claude-sonnet-4-20250514': 'Claude Sonnet 4',
    'claude-opus-4-20250514': 'Claude Opus 4',
    'claude-opus-4-1-20250805': 'Claude Opus 4.1',
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-opus-4-6': 'Claude Opus 4.6'
  };

  // Canonical timeline of when each model became the web default. Used only to
  // label conversations whose `model` field is null (older chats). Consolidated
  // from the two drifted copies that previously lived in content.js/browse.js
  // (content.js had an invalid 2025-02-29 date).
  const DEFAULT_MODEL_TIMELINE = [
    { date: new Date('2024-01-01'), model: 'claude-3-sonnet-20240229' },
    { date: new Date('2024-06-20'), model: 'claude-3-5-sonnet-20240620' },
    { date: new Date('2024-10-22'), model: 'claude-3-5-sonnet-20241022' },
    { date: new Date('2025-02-24'), model: 'claude-3-7-sonnet-20250219' },
    { date: new Date('2025-05-22'), model: 'claude-sonnet-4-20250514' },
    { date: new Date('2025-09-29'), model: 'claude-sonnet-4-5-20250929' },
    { date: new Date('2026-02-17'), model: 'claude-sonnet-4-6' }
  ];

  function inferModel(conversation) {
    if (conversation.model) return conversation.model;
    const when = new Date(conversation.created_at);
    for (let i = DEFAULT_MODEL_TIMELINE.length - 1; i >= 0; i--) {
      if (when >= DEFAULT_MODEL_TIMELINE[i].date) return DEFAULT_MODEL_TIMELINE[i].model;
    }
    return DEFAULT_MODEL_TIMELINE[0].model;
  }

  function formatModelName(model) {
    return MODEL_DISPLAY_NAMES[model] || model;
  }

  // ---------------------------------------------------------------------------
  // Tree reconstruction
  // ---------------------------------------------------------------------------

  // Legacy/active-branch walk: trace parent links back from the current leaf.
  function getCurrentBranch(data) {
    if (!data.chat_messages || !data.current_leaf_message_uuid) return [];
    const messageMap = new Map();
    data.chat_messages.forEach(function (msg) { messageMap.set(msg.uuid, msg); });

    const branch = [];
    let currentUuid = data.current_leaf_message_uuid;
    while (currentUuid && messageMap.has(currentUuid)) {
      const message = messageMap.get(currentUuid);
      branch.unshift(message);
      currentUuid = message.parent_message_uuid;
      if (!messageMap.has(currentUuid)) break;
    }
    return branch;
  }

  // Build parent -> children map and the list of roots.
  function buildTree(data) {
    const messages = data.chat_messages || [];
    const messageMap = new Map();
    messages.forEach(function (m) { messageMap.set(m.uuid, m); });

    const childrenMap = new Map();
    const roots = [];
    messages.forEach(function (m) {
      const parent = m.parent_message_uuid;
      if (!parent || parent === ROOT_SENTINEL || !messageMap.has(parent)) {
        roots.push(m);
      } else {
        if (!childrenMap.has(parent)) childrenMap.set(parent, []);
        childrenMap.get(parent).push(m);
      }
    });
    // Deterministic ordering of siblings by creation time.
    childrenMap.forEach(function (arr) {
      arr.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    });
    roots.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    return { messageMap: messageMap, childrenMap: childrenMap, roots: roots };
  }

  // Every root -> leaf path through the message DAG (cycle-guarded).
  function getAllPaths(data) {
    const tree = buildTree(data);
    const paths = [];
    function dfs(node, acc, seen) {
      if (seen.has(node.uuid)) { paths.push(acc.slice()); return; } // defensive: cycle
      seen.add(node.uuid);
      acc.push(node);
      const kids = tree.childrenMap.get(node.uuid) || [];
      if (kids.length === 0) {
        paths.push(acc.slice());
      } else {
        kids.forEach(function (k) { dfs(k, acc, seen); });
      }
      acc.pop();
      seen.delete(node.uuid);
    }
    tree.roots.forEach(function (r) { dfs(r, [], new Set()); });
    return paths;
  }

  // Active branch with a fallback for stale/empty current_leaf: longest path,
  // tie-broken by most-recent leaf.
  function getActiveBranch(data) {
    const branch = getCurrentBranch(data);
    if (branch.length) return branch;
    const paths = getAllPaths(data);
    if (!paths.length) return [];
    paths.sort(function (a, b) {
      return (b.length - a.length) ||
        (new Date(leafOf(b).created_at) - new Date(leafOf(a).created_at));
    });
    return paths[0];
  }

  // All paths ordered with the active branch first.
  function getOrderedPaths(data) {
    const paths = getAllPaths(data);
    if (!paths.length) return [];
    const leaf = data.current_leaf_message_uuid;
    let activeIdx = leaf ? paths.findIndex(function (p) { return leafOf(p).uuid === leaf; }) : -1;
    if (activeIdx < 0) {
      activeIdx = 0;
      for (let i = 1; i < paths.length; i++) {
        if (paths[i].length > paths[activeIdx].length) activeIdx = i;
      }
    }
    const active = paths[activeIdx];
    const rest = paths.filter(function (_, i) { return i !== activeIdx; });
    return [active].concat(rest);
  }

  function leafOf(path) { return path[path.length - 1]; }

  function firstDivergenceIndex(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i].uuid === b[i].uuid) i++;
    return i;
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------

  function normalizeOptions(options) {
    if (options === undefined || options === null) options = {};
    if (typeof options === 'boolean') options = { includeMetadata: options };
    return {
      includeMetadata: options.includeMetadata != null ? options.includeMetadata : false,
      thinking: options.thinking != null ? options.thinking : true,
      tools: options.tools != null ? options.tools : true,
      attachments: options.attachments != null ? options.attachments : true,
      allBranches: options.allBranches != null ? options.allBranches : false,
      timestampStyle: options.timestampStyle || 'locale' // 'locale' | 'iso'
    };
  }

  function formatDate(value, style) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return style === 'iso' ? d.toISOString() : d.toLocaleString();
  }

  // A fenced code block that is safe even if `content` itself contains backtick
  // runs (picks a fence longer than the longest run inside).
  function codeFence(content, lang) {
    content = String(content == null ? '' : content);
    let longest = 0, run = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '`') { run++; if (run > longest) longest = run; } else run = 0;
    }
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return fence + (lang || '') + '\n' + content + '\n' + fence;
  }

  function artifactLang(type) {
    if (!type) return '';
    if (type.indexOf('html') !== -1) return 'html';
    if (type.indexOf('react') !== -1 || type.indexOf('jsx') !== -1) return 'jsx';
    if (type.indexOf('svg') !== -1) return 'svg';
    if (type.indexOf('mermaid') !== -1) return 'mermaid';
    if (type.indexOf('python') !== -1) return 'python';
    if (type.indexOf('markdown') !== -1) return 'markdown';
    if (type.indexOf('code') !== -1) return '';
    return '';
  }

  function renderToolUse(block) {
    const name = block.name || 'tool';
    const input = block.input || block.parameters || {};
    if (name === 'artifacts') {
      const title = input.title || input.id || 'Artifact';
      if (input.content != null) {
        const lang = input.language || artifactLang(input.type);
        return '**📄 Artifact: ' + title + '**\n\n' + codeFence(String(input.content), lang) + '\n\n';
      }
      // update / rewrite without full content — preserve the raw command.
      return '**📄 Artifact (' + (input.command || 'update') + '): ' + title + '**\n\n' +
        codeFence(JSON.stringify(input, null, 2), 'json') + '\n\n';
    }
    return '**🔧 Tool call: ' + name + '**\n\n' + codeFence(JSON.stringify(input, null, 2), 'json') + '\n\n';
  }

  function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (b) {
        if (typeof b === 'string') return b;
        if (b && b.text != null) return b.text;
        return JSON.stringify(b);
      }).join('\n');
    }
    if (content != null) return JSON.stringify(content, null, 2);
    return '';
  }

  function renderToolResult(block) {
    const err = block.is_error ? ' (error)' : '';
    const body = toolResultText(block.content);
    if (body.length > 1200) {
      return '<details>\n<summary>📤 Tool result' + err + ' (' + body.length + ' chars)</summary>\n\n' +
        codeFence(body) + '\n\n</details>\n\n';
    }
    return '**📤 Tool result' + err + '**\n\n' + codeFence(body) + '\n\n';
  }

  // Render a single message's content blocks to Markdown. Unknown block types
  // are dumped as fenced JSON so nothing is ever silently dropped.
  function renderBlocks(message, opts) {
    opts = normalizeOptions(opts);
    let out = '';
    const blocks = Array.isArray(message.content) ? message.content : null;
    if (!blocks) {
      if (message.text) out += message.text + '\n\n';
      return out;
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const type = block.type;
      if (type === 'text' || (!type && block.text != null)) {
        if (block.text) out += block.text + '\n\n';
      } else if (type === 'thinking') {
        if (!opts.thinking) continue;
        const t = block.thinking != null ? block.thinking : (block.text || '');
        if (t) out += '<details>\n<summary>🧠 Extended thinking</summary>\n\n' + codeFence(t) + '\n\n</details>\n\n';
      } else if (type === 'tool_use') {
        if (!opts.tools) continue;
        out += renderToolUse(block);
      } else if (type === 'tool_result') {
        if (!opts.tools) continue;
        out += renderToolResult(block);
      } else if (type === 'image') {
        out += '*[image]*\n\n';
      } else {
        out += codeFence(JSON.stringify(block, null, 2), 'json') + '\n\n';
      }
    }
    return out;
  }

  function renderAttachmentsMarkdown(attachments) {
    let md = '';
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      md += '> **Attachment:** ' + (attachment.file_name || '(unnamed)');
      if (attachment.file_size) md += ' (' + (attachment.file_size / 1024).toFixed(1) + ' KB)';
      if (attachment.file_type) md += ' [' + attachment.file_type + ']';
      md += '\n';
      if (attachment.extracted_content) {
        md += '>\n> <details><summary>Extracted content</summary>\n>\n> ```\n> ' +
          attachment.extracted_content.replace(/\n/g, '\n> ') + '\n> ```\n>\n> </details>\n';
      }
    }
    return md + '\n';
  }

  function renderMessageMarkdown(message, opts) {
    const sender = message.sender === 'human' ? '**You**' : '**Claude**';
    let md = sender + ':\n\n';
    if (opts.attachments && Array.isArray(message.attachments) && message.attachments.length > 0) {
      md += renderAttachmentsMarkdown(message.attachments);
    }
    md += renderBlocks(message, opts);
    if (opts.includeMetadata && message.created_at) {
      md += '*' + formatDate(message.created_at, opts.timestampStyle) + '*\n\n';
    }
    md += '---\n\n';
    return md;
  }

  // ---------------------------------------------------------------------------
  // Public converters
  // ---------------------------------------------------------------------------

  function convertToMarkdown(data, options) {
    const opts = normalizeOptions(options);
    let markdown = '# ' + (data.name || 'Untitled Conversation') + '\n\n';

    if (opts.includeMetadata) {
      markdown += '**Created:** ' + formatDate(data.created_at, opts.timestampStyle) + '\n';
      markdown += '**Updated:** ' + formatDate(data.updated_at, opts.timestampStyle) + '\n';
      markdown += '**Model:** ' + formatModelName(inferModel(data)) + '\n';
      if (data.truncated !== undefined) markdown += '**Truncated:** ' + data.truncated + '\n';
      markdown += '\n---\n\n';
    }

    const orderedPaths = opts.allBranches ? getOrderedPaths(data) : [getActiveBranch(data)];
    const active = orderedPaths[0] || [];

    for (let i = 0; i < active.length; i++) markdown += renderMessageMarkdown(active[i], opts);

    if (opts.allBranches && orderedPaths.length > 1) {
      markdown += '\n## Alternate branches\n\n';
      markdown += '*This conversation has ' + orderedPaths.length + ' branches from edits or regenerations. ' +
        'The transcript above is the active branch; each alternate below is shown from the point where it diverges.*\n\n';
      for (let p = 1; p < orderedPaths.length; p++) {
        const path = orderedPaths[p];
        const div = firstDivergenceIndex(active, path);
        markdown += '### Alternate branch ' + p + ' — diverges after ' + div + ' shared message' + (div === 1 ? '' : 's') + '\n\n';
        for (let j = div; j < path.length; j++) markdown += renderMessageMarkdown(path[j], opts);
      }
    }

    return markdown;
  }

  function extractPlainText(message, opts) {
    const parts = [];
    const blocks = Array.isArray(message.content) ? message.content : null;
    if (!blocks) {
      if (message.text) parts.push(message.text);
      return parts.join('');
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const type = block.type;
      if (type === 'text' || (!type && block.text != null)) {
        if (block.text) parts.push(block.text);
      } else if (type === 'thinking' && opts.thinking) {
        const t = block.thinking != null ? block.thinking : (block.text || '');
        if (t) parts.push('[thinking]\n' + t);
      } else if (type === 'tool_use' && opts.tools) {
        const input = block.input || block.parameters || {};
        parts.push('[tool: ' + (block.name || 'tool') + ']\n' + JSON.stringify(input));
      } else if (type === 'tool_result' && opts.tools) {
        parts.push('[tool result' + (block.is_error ? ' (error)' : '') + ']\n' + toolResultText(block.content));
      }
    }
    return parts.join('\n\n');
  }

  function renderBranchText(messages, opts) {
    let text = '';
    let humanSeen = false, assistantSeen = false;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const body = extractPlainText(message, opts);
      let label;
      if (message.sender === 'human') { label = humanSeen ? 'H' : 'Human'; humanSeen = true; }
      else { label = assistantSeen ? 'A' : 'Assistant'; assistantSeen = true; }
      text += label + ': ' + body + '\n\n';
    }
    return text;
  }

  function convertToText(data, options) {
    const opts = normalizeOptions(options);
    let text = '';

    if (opts.includeMetadata) {
      text += (data.name || 'Untitled Conversation') + '\n';
      text += 'Created: ' + formatDate(data.created_at, opts.timestampStyle) + '\n';
      text += 'Updated: ' + formatDate(data.updated_at, opts.timestampStyle) + '\n';
      text += 'Model: ' + formatModelName(inferModel(data)) + '\n\n';
      text += '---\n\n';
    }

    const orderedPaths = opts.allBranches ? getOrderedPaths(data) : [getActiveBranch(data)];
    const active = orderedPaths[0] || [];
    text += renderBranchText(active, opts);

    if (opts.allBranches && orderedPaths.length > 1) {
      for (let p = 1; p < orderedPaths.length; p++) {
        const path = orderedPaths[p];
        const div = firstDivergenceIndex(active, path);
        text += '\n=== Alternate branch ' + p + ' (diverges after ' + div + ' shared messages) ===\n\n';
        text += renderBranchText(path.slice(div), opts);
      }
    }

    return text.trim();
  }

  // Make a conversation name safe as a filesystem name (no path/dir semantics).
  function sanitizeFilename(name, fallback) {
    fallback = fallback || 'conversation';
    let s = String(name == null ? '' : name)
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.+$/, '');
    if (!s) s = fallback;
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s;
  }

  return {
    ROOT_SENTINEL: ROOT_SENTINEL,
    MODEL_DISPLAY_NAMES: MODEL_DISPLAY_NAMES,
    DEFAULT_MODEL_TIMELINE: DEFAULT_MODEL_TIMELINE,
    inferModel: inferModel,
    formatModelName: formatModelName,
    getCurrentBranch: getCurrentBranch,
    buildTree: buildTree,
    getAllPaths: getAllPaths,
    getActiveBranch: getActiveBranch,
    getOrderedPaths: getOrderedPaths,
    renderBlocks: renderBlocks,
    convertToMarkdown: convertToMarkdown,
    convertToText: convertToText,
    sanitizeFilename: sanitizeFilename
  };
});
