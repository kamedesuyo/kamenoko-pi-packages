// テストで使う画像と拡張の場所。個人の生成画像に頼らず、その場で合成した PNG を使う。
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 乱数の色で埋めて圧縮されにくくし、実際の生成画像のように数KB以上の大きさにする。
export function png(width, height, seed = 1) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let state = seed;
  for (let i = 0; i < raw.length; i++) {
    if (i % stride === 0) continue;
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (state >> 16) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const workDir = mkdtempSync(join(tmpdir(), 'pi-imagegen-test-'));

export function writePng(name, width = 96, height = 96, seed = 1) {
  const path = join(workDir, name);
  writeFileSync(path, png(width, height, seed));
  return path;
}

export const extension = name => fileURLToPath(new URL(`../extensions/${name}`, import.meta.url));

// 併用する別パッケージの拡張。このリポジトリでは隣のフォルダ、単体で取り出した時は環境変数で渡す。
export const imagePaneSource = process.env.IMAGE_PANE_EXTENSION
  ?? fileURLToPath(new URL('../../imgpane/pi/image-pane.ts', import.meta.url));
export const strataIntegrationSource = process.env.STRATA_INTEGRATION_EXTENSION
  ?? [fileURLToPath(new URL('../../pi-strata/extensions/strata-integration.ts', import.meta.url)),
    join(homedir(), '.pi', 'agent', 'extensions', 'strata-integration.ts')].find(path => existsSync(path));
