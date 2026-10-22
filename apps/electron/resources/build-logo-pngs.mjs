#!/usr/bin/env bun
/**
 * Render the polo logo SVG variants into the PNG assets used by the app.
 *
 * Inputs  (same directory):  new-polo-logo.svg (light), polo-logo-inverted.svg,
 *                            polo-logo-dark.svg, polo-logo-black.svg
 * Outputs:                   source.png (light, 1024) - feed to generate-icons.sh
 *                            polo-ai-logos/*.png (4 branding images)
 *                            icon.ico (PNG-compressed entries; generate-icons.sh
 *                            skips .ico when ImageMagick is unavailable)
 *
 * Usage: bun build-logo-pngs.mjs
 */

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

const VARIANTS = {
  light: 'new-polo-logo.svg',
  inverted: 'polo-logo-inverted.svg',
  dark: 'polo-logo-dark.svg',
  black: 'polo-logo-black.svg',
};

const pngs = {};
for (const [name, file] of Object.entries(VARIANTS)) {
  pngs[name] = await sharp(path.join(dir, file)).resize(1024, 1024).png().toBuffer();
  console.log(`rendered ${name} <- ${file}`);
}

// App icon source consumed by generate-icons.sh (must be the light variant).
await sharp(pngs.light).toFile(path.join(dir, 'source.png'));

const logosDir = path.join(dir, 'polo-ai-logos');
await sharp(pngs.inverted).toFile(path.join(logosDir, 'polo_ai_app_icon.png'));
await sharp(pngs.inverted).toFile(path.join(logosDir, 'polo_ai_app_icon_dark.png'));
await sharp(pngs.dark).toFile(path.join(logosDir, 'polo_ai_logo_white.png'));
await sharp(pngs.black).toFile(path.join(logosDir, 'polo_ai_logo_black.png'));
console.log('wrote source.png and polo-ai-logos/*.png');

// Pack icon.ico directly (ICO entries may embed PNG data, Vista+).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const size of ICO_SIZES) {
  entries.push({ size, png: await sharp(pngs.light).resize(size, size).png().toBuffer() });
}
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
let offset = 6 + 16 * entries.length;
const dirEntries = entries.map(({ size, png }) => {
  const e = Buffer.alloc(16);
  const b = size >= 256 ? 0 : size; // 0 means 256 in ICO dir entries
  e.writeUInt8(b, 0);
  e.writeUInt8(b, 1);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
await writeFile(
  path.join(dir, 'icon.ico'),
  Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]),
);
console.log(`wrote icon.ico (${ICO_SIZES.join('/')}px)`);
