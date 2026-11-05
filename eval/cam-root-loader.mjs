// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// runtime/ 의 TypeScript 사본을 빌드 없이 Node 에서 불러오게 하는 로더입니다.
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME = process.env.CAM_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
const ROOT_URL = `${pathToFileURL(RUNTIME).href}/`;
const hook = `
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = ${JSON.stringify(ROOT_URL)};
const PKG = { '@hilit/shared-types': 'packages/shared-types/src/index.ts' };
export async function resolve(spec, ctx, next) {
  if (PKG[spec]) return { url: new URL(PKG[spec], ROOT).href, shortCircuit: true };
  if ((spec.startsWith('./') || spec.startsWith('../')) && !path.extname(spec) && ctx.parentURL?.startsWith('file:')) {
    const base = fileURLToPath(new URL(spec, ctx.parentURL));
    for (const cand of [base + '.ts', path.join(base, 'index.ts')]) if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
  }
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
