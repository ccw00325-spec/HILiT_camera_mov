// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 실험: 숏 전환 시점 제안과 부드러운 전환. 제품에 적용되어 있지 않습니다.
import { snapToBeats } from './beats.mjs';

const smooth = (u) => { const x = Math.max(0, Math.min(1, u)); return x * x * x * (x * (6 * x - 15) + 10); };

/**
 * 숏 전환 시점을 제안합니다. 멈춤과 방향 전환에서만 바꾸고, 너무 자주 바꾸지 않습니다.
 * 박자가 뚜렷할 때만 가까운 박자에 맞춥니다. 사람이 고칠 수 있는 제안이며 자동 확정이 아닙니다.
 */
export function proposeShotChanges({ events, beats = [], confidence = 0, duration, minHoldSec = 2.5, minBeatConfidence = 0.3, preRollSec = 0.2 }) {
  const useBeats = beats.length > 0 && confidence >= minBeatConfidence;
  const raw = events.filter((e) => e.kind === 'stop' || e.kind === 'turn').map((e) => e.t);
  const timed = useBeats ? snapToBeats(raw, beats) : raw;
  const out = [];
  let last = -Infinity;
  for (const t of timed) {
    if (t - last < minHoldSec || t < preRollSec || t > duration - minHoldSec / 2) continue;
    out.push({ at: t, startAt: Math.max(0, t - preRollSec), onBeat: useBeats && beats.includes(t) });
    last = t;
  }
  return out;
}

/** 두 크롭 사이를 부드럽게 잇습니다. 줌은 비율로 섞어 체감 속도를 고르게 합니다. */
export function blendCrop(a, b, u) {
  const k = smooth(u);
  const sw = Math.exp(Math.log(a.sw) * (1 - k) + Math.log(b.sw) * k);
  const sh = Math.exp(Math.log(a.sh) * (1 - k) + Math.log(b.sh) * k);
  const cx = a.sx + a.sw / 2 + (b.sx + b.sw / 2 - a.sx - a.sw / 2) * k;
  const cy = a.sy + a.sh / 2 + (b.sy + b.sh / 2 - a.sy - a.sh / 2) * k;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** 프레임마다 크롭 경로와 번짐 정도(0~1)를 만듭니다. 번짐은 움직임이 가장 빠른 가운데서 가장 큽니다. */
export function transitionFrames(a, b, { durationSec = 0.45, fps = 30, maxBlur = 0.6 } = {}) {
  const n = Math.max(1, Math.round(durationSec * fps));
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n;
    return { u, crop: blendCrop(a, b, u), blur: maxBlur * Math.sin(Math.PI * u) ** 2 };
  });
}

/** 한 프레임 사이 화면이 얼마나 크게 바뀌는지의 최댓값(크롭 폭 대비). 값이 작을수록 충격이 적습니다. */
export function peakChange(frames) {
  let peak = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const p = frames[i - 1], q = frames[i];
    const d = Math.abs(q.sx + q.sw / 2 - p.sx - p.sw / 2) / q.sw + Math.abs(Math.log(q.sw / p.sw));
    peak = Math.max(peak, d);
  }
  return peak;
}
