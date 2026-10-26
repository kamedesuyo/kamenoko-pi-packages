// テストが使う pi 本体の場所。PI_ROOT があれば優先し、なければグローバルの npm から探す。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const name = '@earendil-works/pi-coding-agent';

export function piRoot() {
  const candidates = [process.env.PI_ROOT];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm/node_modules', name));
  try {
    candidates.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true }).trim(), name));
  } catch {}
  const found = candidates.find(candidate => candidate && existsSync(join(candidate, 'package.json')));
  if (!found) throw new Error('pi 本体が見つからない。PI_ROOT で場所を指定する');
  return found;
}
