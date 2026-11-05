// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 사람이 편집했거나 다른 도구가 만든 크롭 경로를 같은 기준으로 잽니다. 값 찾기의 목표 범위를 만들 때 씁니다.
//   node eval/measure-path.mjs 경로.json [대상.json]
// 경로.json: 30fps 간격의 [{ "t": 0, "sx": 0, "sy": 0, "sw": 608, "sh": 1080 }, ...]
// 대상.json: 같은 길이의 [{ "x":0, "y":0, "width":10, "height":20 } 또는 null, ...]
import { readFileSync } from 'node:fs';
import { measurePath } from './lib/camera-metrics.mjs';

const [pathFile, targetFile] = process.argv.slice(2);
if (!pathFile) {
  console.error('사용법: node eval/measure-path.mjs 경로.json [대상.json]');
  process.exit(2);
}
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
console.log(JSON.stringify(measurePath(read(pathFile), targetFile ? read(targetFile) : []), null, 2));
