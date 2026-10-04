import fs from 'node:fs';
import { ASAR, INSTALL_DIR } from './paths.mjs';

console.log('argv', process.argv.slice(2));
console.log('execPath', process.execPath);
console.log('electron', process.versions.electron, 'node', process.versions.node);
console.log('INSTALL_DIR', INSTALL_DIR);
console.log('ASAR', ASAR, fs.existsSync(ASAR));
for (const p of [
  ASAR,
  ASAR + '/dsh',
  ASAR + '/dsh/package.json',
  ASAR + '\\dsh',
  ASAR + '\\dsh\\package.json',
]) {
  let note = 'no';
  try {
    const st = fs.statSync(p);
    note = `ok dir=${st.isDirectory()} size=${st.size}`;
  } catch (e) {
    note = `ERR ${e.code}`;
  }
  console.log(`exists=${fs.existsSync(p)} ${note}  ${p}`);
}
try {
  const names = fs.readdirSync(ASAR);
  console.log('readdir(asar)', names.slice(0, 20), names.length);
} catch (e) {
  console.log('readdir(asar) ERR', e.code, e.message.slice(0, 200));
}
