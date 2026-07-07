// Single import point for the shared conversion core.
//
// When the package is published/packed, `prepack` copies the extension's
// utils.js to ./convert-core.js so the npm package is self-contained. During
// local development that copy doesn't exist, so we fall back to the repo's
// top-level utils.js. Both are the same UMD module.
let core;
try {
  core = require('./convert-core.js');
} catch (err) {
  core = require('../../utils.js');
}
module.exports = core;
