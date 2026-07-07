// Smoke test for the shared conversion core (utils.js).
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const UTILS = path.resolve(__dirname, '../../utils.js');
const core = require(UTILS);

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log('  ok -', msg); pass++; }

// Synthetic conversation with a branch (edit), thinking, tool_use, tool_result,
// artifact, attachment, and an unknown block type.
const convo = {
  name: 'Test / Conversation: "weird*name"',
  created_at: '2025-06-01T00:00:00Z',
  updated_at: '2025-06-01T01:00:00Z',
  model: null,
  current_leaf_message_uuid: 'm4',
  chat_messages: [
    { uuid: 'm1', parent_message_uuid: '00000000-0000-4000-8000-000000000000', sender: 'human',
      created_at: '2025-06-01T00:00:00Z', content: [{ type: 'text', text: 'Hello Claude' }] },
    { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', created_at: '2025-06-01T00:00:05Z',
      content: [ { type: 'thinking', thinking: 'Let me think about greeting.' }, { type: 'text', text: 'Hi there!' } ] },
    // Branch point: two human children of m2 (an edit).
    { uuid: 'm3', parent_message_uuid: 'm2', sender: 'human', created_at: '2025-06-01T00:01:00Z',
      content: [{ type: 'text', text: "What's the weather?" }],
      attachments: [{ file_name: 'city.txt', file_size: 2048, file_type: 'text/plain', extracted_content: 'San Francisco\nCA' }] },
    { uuid: 'm4', parent_message_uuid: 'm3', sender: 'assistant', created_at: '2025-06-01T00:01:10Z',
      content: [
        { type: 'tool_use', name: 'weather', input: { city: 'SF' } },
        { type: 'tool_result', content: [{ type: 'text', text: '72F sunny' }] },
        { type: 'text', text: 'It is sunny, 72F.' }
      ] },
    // Alternate branch (the edit): different question + artifact answer.
    { uuid: 'm5', parent_message_uuid: 'm2', sender: 'human', created_at: '2025-06-01T00:02:00Z',
      content: [{ type: 'text', text: 'Write a hello script' }] },
    { uuid: 'm6', parent_message_uuid: 'm5', sender: 'assistant', created_at: '2025-06-01T00:02:10Z',
      content: [
        { type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'a1', type: 'application/vnd.ant.code',
          language: 'python', title: 'hello.py', content: 'print("hi")' } },
        { type: 'text', text: 'Here is your script.' },
        { type: 'mystery_block', foo: 'bar' } // unknown -> must be dumped as JSON
      ] }
  ]
};

console.log('inferModel (null model -> by date):');
ok(core.inferModel(convo) === 'claude-sonnet-4-20250514', 'infers claude-sonnet-4 for 2025-06-01');

console.log('tree:');
const active = core.getCurrentBranch(convo).map(m => m.uuid);
ok(JSON.stringify(active) === JSON.stringify(['m1','m2','m3','m4']), 'active branch is m1..m4');
const paths = core.getAllPaths(convo);
ok(paths.length === 2, 'two root->leaf paths');
const ordered = core.getOrderedPaths(convo).map(p => p.map(m => m.uuid).join('>'));
ok(ordered[0] === 'm1>m2>m3>m4', 'active path ordered first');
ok(ordered[1] === 'm1>m2>m5>m6', 'alternate path second');

console.log('markdown (all branches, full fidelity):');
const md = core.convertToMarkdown(convo, { includeMetadata: true, allBranches: true });
ok(md.includes('# Test'), 'has title heading');
ok(md.includes('Claude Sonnet 4'), 'metadata shows inferred model display name');
ok(md.includes('Extended thinking'), 'renders thinking block');
ok(md.includes('🔧 Tool call: weather'), 'renders tool_use');
ok(md.includes('📤 Tool result'), 'renders tool_result');
ok(md.includes('It is sunny, 72F.'), 'renders active answer text');
ok(md.includes('city.txt'), 'renders attachment name');
ok(md.includes('Extracted content'), 'renders attachment extracted content');
ok(md.includes('## Alternate branches'), 'has alternate branches section');
ok(md.includes('diverges after 2 shared messages'), 'divergence note correct');
ok(md.includes('📄 Artifact: hello.py'), 'renders artifact from alternate branch');
ok(md.includes('print("hi")'), 'renders artifact content');
ok(md.includes('"mystery_block"'), 'dumps unknown block as JSON (nothing lost)');
// The alternate-only content must NOT appear before the alternates section.
ok(md.indexOf('Here is your script.') > md.indexOf('## Alternate branches'), 'alternate content only under alternates');

console.log('markdown (active branch only):');
const mdActive = core.convertToMarkdown(convo, { allBranches: false });
ok(!mdActive.includes('## Alternate branches'), 'no alternates when allBranches=false');
ok(!mdActive.includes('hello.py'), 'alternate artifact absent in active-only mode');

console.log('toggles:');
const mdNoThink = core.convertToMarkdown(convo, { allBranches: true, thinking: false, tools: false });
ok(!mdNoThink.includes('Extended thinking'), '--no-thinking hides thinking');
ok(!mdNoThink.includes('Tool call'), '--no-tools hides tool_use');

console.log('text:');
const txt = core.convertToText(convo, { includeMetadata: true, allBranches: true });
ok(txt.includes('Human: '), 'text has Human label');
ok(txt.includes('Assistant: '), 'text has Assistant label');
ok(txt.includes('Alternate branch'), 'text includes alternate branch');

console.log('sanitizeFilename:');
ok(core.sanitizeFilename('a/b:c*d?') === 'a_b_c_d_', 'strips invalid chars');
ok(core.sanitizeFilename('Keep spaces-and-hyphens') === 'Keep spaces-and-hyphens', 'keeps spaces and hyphens');
ok(core.sanitizeFilename('') === 'conversation', 'empty -> fallback');

console.log('fallback for stale current_leaf:');
const stale = Object.assign({}, convo, { current_leaf_message_uuid: 'does-not-exist' });
const staleBranch = core.getActiveBranch(stale).map(m => m.uuid);
ok(staleBranch.length === 4, 'falls back to a full-length path when leaf is stale');

console.log('code fence safety (content containing backticks):');
const fenceConvo = { name: 'f', chat_messages: [
  { uuid: 'x1', parent_message_uuid: null, sender: 'assistant', created_at: '2025-06-01T00:00:00Z',
    content: [{ type: 'tool_result', content: '```\nnested fence\n```' }] }
], current_leaf_message_uuid: 'x1' };
const fmd = core.convertToMarkdown(fenceConvo, { tools: true });
ok(fmd.includes('````'), 'uses longer fence when content has triple backticks');

console.log('UMD browser-global path (no module):');
const src = fs.readFileSync(UTILS, 'utf8');
const sandbox = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox); // module is undefined here -> should assign globals
ok(typeof sandbox.convertToMarkdown === 'function', 'assigns convertToMarkdown as a global');
ok(typeof sandbox.getCurrentBranch === 'function', 'assigns getCurrentBranch as a global');
ok(typeof sandbox.inferModel === 'function', 'assigns inferModel as a global');
ok(sandbox.module === undefined, 'no module leaked into browser sandbox');

console.log('\nALL ' + pass + ' ASSERTIONS PASSED');
