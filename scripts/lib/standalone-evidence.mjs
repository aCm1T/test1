import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INCLUDED = ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'src', 'public'];

export function sourceHash(root = process.cwd()) {
  const hash = crypto.createHash('sha256');
  for (const relative of INCLUDED) {
    const absolute = path.join(root, relative);
    for (const file of files(absolute).sort()) {
      hash.update(path.relative(root, file));
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest('hex');
}

export function distHash(root = process.cwd()) {
  const hash = crypto.createHash('sha256');
  for (const file of files(path.join(root, 'dist')).sort()) {
    hash.update(path.relative(root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function files(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => files(path.join(target, entry.name)));
}
