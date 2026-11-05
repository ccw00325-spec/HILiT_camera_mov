// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 실험: 오디오 박자 찾기와 숏 전환 시점 맞추기. 외부 라이브러리와 모델이 필요 없습니다. 제품에 적용되어 있지 않습니다.
const HOP = 512;
const FRAME = 1024;

/** 소리 세기가 갑자기 커지는 정도(온셋). 기기 안에서 계산하며 음성을 저장하지 않습니다. */
export function onsetEnvelope(samples, sampleRate) {
  const n = Math.floor((samples.length - FRAME) / HOP);
  const env = new Float64Array(Math.max(0, n));
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    let e = 0;
    for (let j = 0; j < FRAME; j += 1) { const s = samples[i * HOP + j]; e += s * s; }
    const log = Math.log1p(e * 100);
    env[i] = Math.max(0, log - prev);
    prev = log;
  }
  return { env, rate: sampleRate / HOP };
}

/**
 * 박자 찾기. confidence 가 낮으면 박자가 뚜렷하지 않다는 뜻이므로 맞추지 않습니다.
 * 돌려주는 것: { bpm, beats: [초], confidence: 0~1 }
 */
export function detectBeats(samples, sampleRate, { minBpm = 70, maxBpm = 180 } = {}) {
  const { env, rate } = onsetEnvelope(samples, sampleRate);
  if (env.length < rate * 4) return { bpm: null, beats: [], confidence: 0 };
  const mean = env.reduce((s, v) => s + v, 0) / env.length;
  const x = env.map((v) => v - mean);
  let zero = 0;
  for (const v of x) zero += v * v;
  if (zero <= 1e-9) return { bpm: null, beats: [], confidence: 0 };
  const minLag = Math.round(rate * 60 / maxBpm), maxLag = Math.round(rate * 60 / minBpm);
  const scoreAt = (lag) => { let s = 0; for (let i = 0; i + lag < x.length; i += 1) s += x[i] * x[i + lag]; return s / zero; };
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    // 사람이 느끼는 빠르기 근처(약 120 BPM)를 조금 더 믿어 두 배·절반 오류를 줄입니다.
    const bpm = 60 * rate / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const s = scoreAt(lag) * weight;
    if (s > best) { best = s; bestLag = lag; }
  }
  // 주기를 소수 단위로 다듬고 위상을 찾습니다. 정수 주기를 그대로 쓰면 박자가 쌓일수록 어긋납니다.
  let period = bestLag, bestPhase = 0, phaseScore = -Infinity;
  for (let lag = bestLag - 1; lag <= bestLag + 1 + 1e-9; lag += 0.02) {
    for (let p = 0; p < lag; p += 1) {
      let s = 0;
      for (let i = p; i < env.length; i += lag) s += env[Math.round(i)] ?? 0;
      if (s > phaseScore) { phaseScore = s; bestPhase = p; period = lag; }
    }
  }
  const beats = [];
  for (let i = bestPhase; i < env.length; i += period) beats.push((i * HOP + FRAME / 2) / sampleRate);
  return { bpm: 60 * rate / period, beats, confidence: Math.max(0, Math.min(1, scoreAt(bestLag))) };
}

/** 후보 시점을 가까운 박자로 옮깁니다. 멀면 옮기지 않습니다. */
export function snapToBeats(times, beats, { maxShiftSec = 0.25 } = {}) {
  return times.map((t) => {
    let best = null;
    for (const b of beats) if (best === null || Math.abs(b - t) < Math.abs(best - t)) best = b;
    return best !== null && Math.abs(best - t) <= maxShiftSec ? best : t;
  });
}
