#!/usr/bin/env node
'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequest, applyHarmonisation } = require('../src/harmonise/index.cjs');

const usage = [
  'Usage: node bin/harmonise.cjs request <plain.png> <request.json>',
  '       node bin/harmonise.cjs apply <plain.png> <model.png> <out.png>',
].join('\n');

function main(args) {
  const [command, plain, third, fourth] = args;
  if (command === 'request' && args.length === 3) {
    const guide = readFileSync(resolve(__dirname, '../style-guide.md'), 'utf8');
    const request = createRequest(resolve(plain), readFileSync(plain), guide);
    writeFileSync(third, JSON.stringify(request, null, 2) + '\n');
  } else if (command === 'apply' && args.length === 4) {
    writeFileSync(fourth, applyHarmonisation(readFileSync(plain), readFileSync(third)));
  } else {
    throw new Error(usage);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
