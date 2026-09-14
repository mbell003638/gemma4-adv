import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'lab-baseline.json'), 'utf8'));
const git = (...args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) throw r.error ?? new Error(r.stderr);
  return r.stdout.trim();
};
assert(fs.lstatSync(path.join(root, '.git')).isDirectory(), 'Must have an independent .git directory.');
assert(!fs.existsSync(path.join(root, '.git/commondir')), 'Shared Git directory is forbidden.');
assert(!fs.existsSync(path.join(root, '.git/objects/info/alternates')), 'Shared Git object store is forbidden.');
assert.equal(git('branch', '--show-current'), baseline.experimentBranch, 'Wrong experiment branch.');
assert.equal(git('rev-parse', 'HEAD'), baseline.baselineCommit, 'A commit was made; owner review required.');
assert.equal(git('remote'), '', 'Remotes must remain absent until owner authorizes Git publication.');
const digest = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(path.join(root, baseline.needlePath))) digest.update(chunk);
assert.equal(digest.digest('hex'), baseline.needleSha256, 'Trained Needle weights changed.');
const dependencies = path.join(root, 'frontend/node_modules');
if (fs.existsSync(dependencies)) assert(!fs.lstatSync(dependencies).isSymbolicLink(), 'Do not share a mutable dependency junction.');
console.log(JSON.stringify({ product: baseline.product, branch: baseline.experimentBranch,
  isolation: 'passed', needle: 'unchanged', remotes: 'none', commitsSinceBaseline: 0 }, null, 2));
