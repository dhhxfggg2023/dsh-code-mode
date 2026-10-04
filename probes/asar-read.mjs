/**
 * Read source out of the DSH asar bundle.
 *
 * `E:\tools\DSH\resources\app.asar` is a packed archive, so its contents are not
 * readable as files by the editor tools; but the Electron binary resolves paths
 * *through* the archive when run in node mode (fs hooks install asar support).
 *
 * Usage (any of):
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<install>\DeepSeek Harness.exe" probes/asar-read.mjs list <dirInAsar>
 *   "<install>\DeepSeek Harness.exe" probes/asar-read.mjs read <fileInAsar>
 *   "<install>\DeepSeek Harness.exe" probes/asar-read.mjs lines <fileInAsar> <from> <count>
 *   "<install>\DeepSeek Harness.exe" probes/asar-read.mjs grep <regex> <dirOrFileInAsar> [maxHits]
 *
 * Paths are relative to `<asar>\dsh` (the bundle's package root) and may also be
 * written with a leading `dsh/`.

 * Pit this probe exists to avoid: with PowerShell, `... read <file> | Out-File x.js`
 * corrupts the bytes. Use `to <fileInAsar> <dest>` instead — the write happens in
 * node, never through a PowerShell pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASAR, PKG_DIR } from './paths.mjs';

const root = path.join(ASAR, 'dsh');
const [cmd, ...rest] = process.argv.slice(2);

/** Resolve an in-bundle path, accepting `.`, `dsh/...` and `...` forms. */
function inside(p) {
  const clean = p === undefined || p === '' || p === '.' ? '' : p.replace(/^[\\/]+/, '');
  const stripped = clean === 'dsh' ? '' : clean.replace(/^dsh[\\/]/, '');
  const full = path.resolve(root, stripped);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`refusing path outside the bundle: ${p}`);
  }
  return full;
}

const show = (full) => path.relative(root, full) || '.';

if (cmd === 'list') {
  const dir = inside(rest[0]);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    console.log(`${entry.isDirectory() ? 'd' : '-'} ${entry.name}`);
  }
} else if (cmd === 'read') {
  process.stdout.write(fs.readFileSync(inside(rest[0]), 'utf8'));
} else if (cmd === 'lines') {
  const [file, from = '1', count = '80'] = rest;
  const all = fs.readFileSync(inside(file), 'utf8').split('\n');
  const start = Math.max(1, Number(from));
  all.slice(start - 1, start - 1 + Number(count)).forEach((line, i) => {
    console.log(`${String(start + i).padStart(5)}| ${line}`);
  });
} else if (cmd === 'to') {
  const [file, dest] = rest;
  if (!path.isAbsolute(dest)) throw new Error('to: dest must be an absolute path');
  fs.writeFileSync(dest, fs.readFileSync(inside(file)));
  console.log(`wrote ${fs.statSync(dest).size} bytes to ${dest}`);
} else if (cmd === 'grep') {
  const [pattern, target, maxHits = '60'] = rest;
  const re = new RegExp(pattern);
  const cap = Number(maxHits);
  let hits = 0;
  const scan = (full) => {
    if (hits >= cap) return;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      return;
    }
    text.split('\n').forEach((line, i) => {
      if (hits < cap && re.test(line)) {
        hits += 1;
        console.log(`${show(full)}:${i + 1}: ${line.trim().slice(0, 260)}`);
      }
    });
  };
  const walk = (full) => {
    if (hits >= cap) return;
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) {
      if (/\.(js|mjs|cjs|json|ts)$/.test(full)) scan(full);
      return;
    }
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (hits >= cap) return;
      if (entry.isDirectory()) walk(path.join(full, entry.name));
      else if (/\.(js|mjs|cjs|json|ts)$/.test(entry.name)) scan(path.join(full, entry.name));
    }
  };
  walk(inside(target ?? '.'));
  console.log(`--- ${hits} hit(s) (cap ${cap})`);
} else {
  console.log(fs.readFileSync(path.join(PKG_DIR, 'probes', 'asar-read.mjs'), 'utf8').split('*/')[0]);
  process.exitCode = 2;
}
