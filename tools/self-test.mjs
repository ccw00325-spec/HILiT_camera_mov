#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 기본 검사. 네트워크와 비공개 정본 없이 돈다.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBeats, snapToBeats } from '../lab/beats.mjs';
import { anticipateTrack, detectEvents } from '../lab/lookahead.mjs';
import { blendCrop, peakChange, proposeShotChanges, transitionFrames } from '../lab/shot-rhythm.mjs';
import { leadLagSec, measurePath } from '../eval/lib/camera-metrics.mjs';
import { buildTrack } from '../eval/lib/trajectories.mjs';
import { scan } from './detect-copy.mjs';
import { fileFingerprint, isStampable } from './lib/stamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const test = (name, fn) => Promise.resolve().then(fn).then((n) => console.log(`통과 ${name}${n ? ` — ${n}` : ''}`), (e) => { failures.push(name); console.log(`실패 ${name}: ${e.message}`); });
const assert = (ok, m) => { if (!ok) throw new Error(m); };
const walk = (d, b = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name), `${b}${e.name}/`) : [`${b}${e.name}`]));
const all = walk(ROOT);

await test('모든 코드 파일에 표시와 고유 지문이 있다', () => {
  const code = all.filter((p) => p.startsWith('runtime/') && isStampable(p));
  assert(code.length > 10, '파일 수');
  for (const p of code) {
    const head = readFileSync(path.join(ROOT, p), 'utf8').slice(0, 700);
    assert(head.includes(fileFingerprint(p)) && head.includes('ccw00325@gmail.com'), `표시 없음 ${p}`);
  }
  return `${code.length}개`;
});

await test('공개하면 안 되는 것이 없다', () => {
  const NAMES = new RegExp(['HILiT_(?:Research|Editor|Edit_APK|Docs|Admin)', 'hilit_(?:loss|admin|lp)'].join('|'));
  const SECRET = /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk-(?:ant-)?[A-Za-z0-9_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z0-9]{20}\.supabase\.co/;
  const PC = /\b[A-Za-z]:[\\/](?:GPT|Users|기술결정등)/;
  const FP = new RegExp(['d3f1a7c0', 'e9b24f85'].join(''));
  for (const p of all) {
    assert(!/\.(onnx|tflite|task|pth|pt|ckpt|bin|safetensors|wasm|apk|aab|mp4|mov|keystore|jks|pem|p12)$/i.test(p), `이진 ${p}`);
    assert(statSync(path.join(ROOT, p)).size < 1024 * 1024, `큰 파일 ${p}`);
    if (p.endsWith('.jpg')) { assert(p === 'assets/hilit-tec-banner.jpg', `사진 ${p}`); continue; }
    const t = readFileSync(path.join(ROOT, p), 'utf8');
    assert(!NAMES.test(t), `비공개 이름 ${p}`);
    assert(!SECRET.test(t), `비밀값 ${p}`);
    assert(!PC.test(t), `내 PC 경로 ${p}`);
    assert(!FP.test(t), `제품 지문 ${p}`);
  }
  return `${all.length}개`;
});

await test('궤적 다듬기가 순간 튐을 지우고 크기를 유지한다', () => {
  const { pts } = buildTrack('stage_noise', { seed: 2 });
  const after = anticipateTrack(pts, { leadSec: 0.1, sigmaSec: 0.1 });
  const jump = (a) => Math.max(...a.slice(1).map((p, i) => Math.abs(p.bbox.x - a[i].bbox.x)));
  assert(jump(after) < jump(pts) * 0.5, `튐 ${jump(pts)}→${jump(after)}`);
  assert(after.length === pts.length && after.every((p) => p.bbox.width > 0), '점 수');
});

await test('궤적 다듬기가 놓친 구간을 넘어 섞지 않는다', () => {
  const { pts } = buildTrack('loss_recovery', { seed: 1 });
  const after = anticipateTrack(pts, { leadSec: 0.2, sigmaSec: 0.2 });
  const before = pts.findIndex((p) => p.state === 'TARGET_LOST') - 1;
  const diff = Math.abs(after[before].bbox.x - pts[before].bbox.x);
  assert(diff < 0.03, `놓치기 직전 점이 다시 잡은 자리로 끌림 ${diff}`);
  assert(after.filter((p) => p.state === 'TARGET_LOST').length === pts.filter((p) => p.state === 'TARGET_LOST').length, '상태가 바뀜');
});

await test('멈춤과 방향 전환을 찾는다', () => {
  const stop = detectEvents(buildTrack('stop_go', { seed: 1 }).pts);
  const turn = detectEvents(buildTrack('direction_change', { seed: 1 }).pts);
  assert(stop.some((e) => e.kind === 'stop'), '멈춤');
  assert(turn.some((e) => e.kind === 'turn'), '전환');
  return `멈춤 ${stop.length}, 전환 ${turn.length}`;
});

function clickTrack(bpm, seconds, noise, sr = 22050) {
  const x = new Float32Array(sr * seconds);
  let seed = 7;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < x.length; i += 1) x[i] = r() * noise;
  const step = Math.round(sr * 60 / bpm);
  for (let b = 0; b < x.length; b += step) for (let i = 0; i < 400 && b + i < x.length; i += 1) x[b + i] += Math.sin(i * 0.4) * (1 - i / 400);
  return { x, sr };
}

await test('박자를 찾는다', () => {
  for (const bpm of [90, 120, 150]) {
    const { x, sr } = clickTrack(bpm, 16, 0.02);
    const r = detectBeats(x, sr);
    assert(Math.abs(r.bpm - bpm) < 2.5, `${bpm} → ${r.bpm}`);
    assert(r.confidence > 0.3, `신뢰도 ${r.confidence}`);
    const step = 60 / bpm;
    const err = r.beats.slice(1, 12).map((b) => { const k = b / step; return Math.abs(k - Math.round(k)) * step; });
    assert(Math.max(...err) < 0.05, `박자 어긋남 ${Math.max(...err)}`);
  }
});

await test('박자가 뚜렷하지 않으면 맞추지 않는다', () => {
  const x = new Float32Array(22050 * 10);
  let seed = 3;
  for (let i = 0; i < x.length; i += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; x[i] = (seed / 4294967296 - 0.5) * 0.3; }
  const r = detectBeats(x, 22050);
  assert(r.confidence < 0.3, `신뢰도 ${r.confidence}`);
  const events = [{ t: 3.1, kind: 'stop' }];
  const shots = proposeShotChanges({ events, beats: r.beats, confidence: r.confidence, duration: 10 });
  assert(shots[0].at === 3.1 && !shots[0].onBeat, '잡음에 맞췄습니다');
  assert(snapToBeats([3.1], [3.2])[0] === 3.2 && snapToBeats([3.1], [4])[0] === 3.1, '맞추기 거리');
});

await test('숏 전환 제안이 너무 잦지 않고 박자에 맞는다', () => {
  const events = [1, 1.5, 4.1, 4.3, 8.1].map((t) => ({ t, kind: 'stop' }));
  const beats = Array.from({ length: 24 }, (_, i) => i * 0.5);
  const shots = proposeShotChanges({ events, beats, confidence: 0.8, duration: 12 });
  for (let i = 1; i < shots.length; i += 1) assert(shots[i].at - shots[i - 1].at >= 2.5, '간격');
  assert(shots.every((s) => s.onBeat && s.startAt < s.at), '박자·선행');
  return shots.map((s) => s.at).join(', ');
});

await test('전환 보간이 컷보다 화면 변화를 줄인다', () => {
  const a = { sx: 100, sy: 0, sw: 608, sh: 1080 }, b = { sx: 500, sy: 300, sw: 304, sh: 540 };
  const frames = transitionFrames(a, b).map((f) => f.crop);
  const soft = peakChange(frames), hard = peakChange([a, b]);
  assert(soft < hard * 0.3, `${hard}→${soft}`);
  const start = blendCrop(a, b, 0), end = blendCrop(a, b, 1);
  assert(Math.abs(start.sw - a.sw) < 1e-6 && Math.abs(end.sw - b.sw) < 1e-6, '양 끝');
  const blurs = transitionFrames(a, b).map((f) => f.blur);
  assert(blurs[0] === 0 && blurs.at(-1) < 1e-9, '양 끝 번짐');
  return `최대 변화 ${hard.toFixed(2)}→${soft.toFixed(2)}`;
});

await test('시차와 부드러움 지표가 맞게 잰다', () => {
  const tgt = Array.from({ length: 300 }, (_, i) => Math.sin(i / 20) * 100);
  const late = tgt.map((_, i) => tgt[Math.max(0, i - 6)]);
  assert(Math.abs(leadLagSec(late, tgt) + 0.2) < 0.04, `늦음 ${leadLagSec(late, tgt)}`);
  const early = tgt.map((_, i) => tgt[Math.min(299, i + 6)]);
  assert(Math.abs(leadLagSec(early, tgt) - 0.2) < 0.04, `앞섬 ${leadLagSec(early, tgt)}`);
  const smooth = measurePath(tgt.map((x, i) => ({ t: i / 30, sx: x, sy: 0, sw: 600, sh: 1000 })));
  const shaky = measurePath(tgt.map((x, i) => ({ t: i / 30, sx: x + (i % 2) * 6, sy: 0, sw: 600, sh: 1000 })));
  assert(shaky.jerkP95 > smooth.jerkP95 * 3, '저크');
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hilit-cam-test-'));
try {
  await test('표시를 지우고 지역 이름을 바꾼 사본도 찾고 무관한 코드는 넘긴다', async () => {
    const src = readFileSync(path.join(ROOT, 'runtime/packages/tracking-core/src/follow-camera.ts'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\b(const|let)\s+([a-zA-Z_]\w*)/g, (m, k, n) => `${k} q_${n}`);
    const f = path.join(tmp, 'x.js');
    writeFileSync(f, stripped);
    const hit = await scan([f]);
    assert(hit.marks.length === 0 && hit.code.some((c) => c.source.endsWith('follow-camera.ts')), '못 찾음');
    const clean = await scan([path.join(ROOT, 'tools/lib/winnow.mjs')]);
    assert(!clean.found, '오탐');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

await test('라이선스 문서가 맞다', () => {
  const l = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  for (const need of ['LicenseRef-HILiT-NCA-1.1', 'ccw00325@gmail.com', 'HILiT Camera Mov', 'HILiT_camera_mov', '조찬우']) assert(l.includes(need), need);
});

console.log(failures.length ? `실패 ${failures.length}건` : '전체 통과');
process.exit(failures.length ? 1 : 0);
