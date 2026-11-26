#!/usr/bin/env node
'use strict';

// Offline Kekborn portrait renderer.
// Usage: node bin/render.cjs [--root DIR] input.json output.png
// Writes output.png and the layer record output.json beside it. See docs/render.md.

const fs = require('node:fs');
const path = require('node:path');
const { renderPortrait, recordPath, stableJson, RenderError } = require('../src/compositor/index.cjs');

const USAGE = 'Usage: node bin/render.cjs [--root DIR] input.json output.png';

function main(argv) {
  const args = [...argv];
  let root;
  const at = args.indexOf('--root');
  if (at !== -1) {
    root = args[at + 1];
    if (!root) throw new RenderError('E_USAGE', USAGE);
    args.splice(at, 2);
  } else if (process.env.KEKBORN_ROOT) {
    root = process.env.KEKBORN_ROOT;
  }
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.length !== 2) throw new RenderError('E_USAGE', USAGE);
  const [inputFile, output] = args;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (error) {
    throw new RenderError('E_INPUT', `Cannot read input ${inputFile}: ${error.message}`);
  }
  const { png, record } = renderPortrait(input, { root });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, png);
  fs.writeFileSync(recordPath(output), stableJson(record));
  process.stdout.write(`${output} ${record.pngSha256}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof RenderError) {
    process.stderr.write(`render: ${error.code}: ${error.message}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 64 : 2;
  } else {
    process.stderr.write(`render: ${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
