// Resolve a user-supplied --project value (uuid or name) to a project object.
// Matching order: exact uuid → exact name (case-insensitive) → unique substring.
function resolveProject(projects, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new Error('Empty --project value.');

  const byId = projects.find((p) => p.uuid === v);
  if (byId) return byId;

  const lower = v.toLowerCase();
  const exact = projects.filter((p) => (p.name || '').toLowerCase() === lower);
  if (exact.length === 1) return exact[0];

  const pool = exact.length > 1 ? exact : projects.filter((p) => (p.name || '').toLowerCase().indexOf(lower) !== -1);
  if (pool.length === 1) return pool[0];
  if (pool.length === 0) {
    throw new Error('No project matches "' + v + '". Run `claudex projects` to list them.');
  }
  const names = pool.map((p) => '  • ' + (p.name || '(unnamed)') + '  (' + p.uuid + ')').join('\n');
  throw new Error('"' + v + '" matches multiple projects — be more specific or pass the uuid:\n' + names);
}

module.exports = { resolveProject };
