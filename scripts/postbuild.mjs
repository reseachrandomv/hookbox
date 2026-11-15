// Ensures the CLI entry keeps its shebang and is executable after tsc.
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const file = new URL('../dist/cli.js', import.meta.url);
let src = readFileSync(file, 'utf8');
if (!src.startsWith('#!')) {
  src = '#!/usr/bin/env node\n' + src;
  writeFileSync(file, src);
}
chmodSync(file, 0o755);
console.log('postbuild: dist/cli.js is executable');
