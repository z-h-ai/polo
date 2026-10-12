#!/usr/bin/env node
// Deterministic immutable copy of the one maintained loader; no run resources.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw Error('Usage: node scripts/generate-owned-native-lifecycle.mjs --out <new-owned-directory>');
const proposed = path.resolve(args[1]);
const output = path.join(fs.realpathSync(path.dirname(proposed)), path.basename(proposed));
const sources = ['apps/electron/e2e/owned-native-lifecycle/loader.cjs', 'scripts/generate-owned-native-lifecycle.mjs'];
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const head = git('rev-parse','HEAD').toString().trim();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bindings = sources.map(relative => {
  const bytes = fs.readFileSync(path.join(root,relative));
  if (!bytes.equals(git('show',`${head}:${relative}`))) throw Error(`Commit the scoped source before generating: ${relative}`);
  return {path:relative,sha256:sha(bytes),bytes};
});
if (output === root || output.startsWith(root+path.sep)) {
  try { git('check-ignore',path.join(output,'native-lifecycle-loader.cjs')); }
  catch { throw Error('Generated in-repository output must be ignored; use an owned temporary directory'); }
}
fs.mkdirSync(output, {mode:0o700}); // Existing directories are never overwritten.
try {
  fs.writeFileSync(path.join(output,'native-lifecycle-loader.cjs'),bindings[0].bytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(output,'source-binding.json'),JSON.stringify({version:1,sourceHead:head,sources:bindings.map(({bytes,...binding})=>binding),output:{name:'native-lifecycle-loader.cjs',sha256:bindings[0].sha256}},null,2)+'\n',{flag:'wx',mode:0o600});
} catch (error) {
  fs.rmSync(output,{recursive:true,force:true}); // Only this newly created directory.
  throw error;
}
console.log(output);
