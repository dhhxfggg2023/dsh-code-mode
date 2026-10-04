const z = require('node:zlib'); const fs = require('node:fs');
const src = process.argv[2], out = process.argv[3];
const b = fs.readFileSync(src);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = []; let i = 0;
while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
const parts = []; let bad = 0;
for (let k = 0; k < offs.length; k += 1) {
  const slice = b.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : b.length);
  try { parts.push(z.zstdDecompressSync(slice)); } catch (e) { bad += 1; }
}
const d = Buffer.concat(parts);
fs.writeFileSync(out, d);
console.log('frames', offs.length, 'decoded', parts.length, 'failed', bad, 'bytes', d.length);
