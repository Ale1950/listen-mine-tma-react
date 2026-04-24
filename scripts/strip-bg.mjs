// Strip white / light-gray checker background from mascot PNGs.
//
// For every group*_*.png directly in public/mascot/:
//   - Pixels with R>240 && G>240 && B>240         → alpha = 0 (near-white)
//   - Near-neutral light pixels (R≈G≈B, >170)     → alpha = 0 (fake-transparency
//                                                               checker pattern)
// Overwrites the file in place, then re-reads metadata to confirm hasAlpha.
//
// Usage: node scripts/strip-bg.mjs

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const MASCOT_DIR = path.resolve('public/mascot');
const FILE_RE = /^group\d+_\d+\.png$/i;

const WHITE_MIN = 240;
const GRAY_MIN = 170;
const GRAY_SPREAD = 10; // max channel spread for "neutral"

async function listFiles() {
  const entries = await fs.readdir(MASCOT_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && FILE_RE.test(e.name))
    .map((e) => path.join(MASCOT_DIR, e.name))
    .sort();
}

function isBackground(r, g, b) {
  if (r > WHITE_MIN && g > WHITE_MIN && b > WHITE_MIN) return true;
  if (r > GRAY_MIN && g > GRAY_MIN && b > GRAY_MIN) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min <= GRAY_SPREAD) return true;
  }
  return false;
}

async function strip(file) {
  const raw = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const { width, height, channels } = info; // channels = 4 after ensureAlpha
  const total = width * height;
  let stripped = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (isBackground(r, g, b)) {
      data[i + 3] = 0;
      stripped++;
    }
  }

  const tmp = file + '.tmp';
  await sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 9 })
    .toFile(tmp);
  await fs.rename(tmp, file);

  const meta = await sharp(file).metadata();
  return { width, height, total, stripped, hasAlpha: !!meta.hasAlpha };
}

const files = await listFiles();
if (files.length === 0) {
  console.error(`No ${FILE_RE} files found under ${MASCOT_DIR}`);
  process.exit(1);
}

console.log(`Stripping background on ${files.length} file(s) in ${MASCOT_DIR}\n`);

let okCount = 0;
for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  try {
    const r = await strip(file);
    const pct = ((r.stripped / r.total) * 100).toFixed(1);
    const tag = r.hasAlpha ? 'OK  ' : 'FAIL';
    console.log(`  ${tag}  ${rel}  ${r.width}x${r.height}  stripped=${pct}%  hasAlpha=${r.hasAlpha}`);
    if (r.hasAlpha) okCount++;
  } catch (err) {
    console.error(`  FAIL  ${rel}  ${err.message}`);
  }
}

console.log(`\n${okCount}/${files.length} files have alpha channel`);
if (okCount !== files.length) process.exit(1);
