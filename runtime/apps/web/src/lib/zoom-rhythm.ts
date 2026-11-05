/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·38f26cab @license @preserve */
/**
 * 3단계 줌 리듬 — 순수 시간·기하.
 *
 * 추가 줌 1은 변환 항등값이다(기본 구도를 그대로 둔다). 기본 구도보다 넓히지 않는다.
 * 횟수·강도의 ‘가운데 값’과 ‘들어갈 수 있는 최대 횟수’는 제안 휴리스틱이다.
 * 사용자가 승인한 제품 기본값이 아니다.
 *
 * 즉시 구간의 길이는 0이다. 이것은 새 효과 길이 기본값이 아니라, 그 구간에 시간이 없다는 뜻이다.
 * 부드러운 보간은 clip-timeline 카메라 연결과 같은 Hermite(smoothstep)만 쓴다.
 * 경로 전체에 저역통과를 걸지 않는다.
 */
import { fingerprintOf } from '@/lib/face-fx';

export interface ZoomRect { x: number; y: number; w: number; h: number }

export const ZOOM_RHYTHM_ALGO = 'zoom-rhythm-v1';

/** timeline-export 의 captureStream 과 같은 출력 격자. 새 프레임레이트가 아니다. */
export const OBSERVED_EXPORT_FPS = 30;

export type ZoomEase = 'instant' | 'smooth';

export interface ZoomMotion {
  inEase: ZoomEase;
  outEase: ZoomEase;
  inSec: number;
  holdSec: number;
  outSec: number;
  /** 1이면 추가 줌 없음. 1보다 크면 기본 구도 안으로 확대한다. */
  strength: number;
}

export interface ZoomRepeat {
  id: string;
  /** 클립 로컬 시간(초). 출력 시각이 아니다. */
  start: number;
  override: Partial<ZoomMotion> | null;
}

export interface ZoomAnchor {
  kind: 'tracking' | 'user';
  x: number | null;
  y: number | null;
}

export interface ZoomRhythmPlan {
  algo: string;
  anchor: ZoomAnchor;
  common: ZoomMotion;
  repeats: ZoomRepeat[];
  confirmKey: string;
  outputFps: number;
}

export type ZoomRhythmStatus = 'off' | 'applied' | 'stale';

export interface ClipZoomRhythm {
  status: ZoomRhythmStatus;
  plan: ZoomRhythmPlan | null;
}

export interface ZoomWindow {
  /** 리듬을 둘 수 있는 클립 로컬 시작(카메라 진입 창 뒤). */
  start: number;
  /** 이 시각부터는 기본 구도여야 한다. 마지막 출력 프레임과 경계 연결 중 더 이른 쪽. */
  end: number;
  duration: number;
  outputFps: number;
}

export interface ZoomRequest {
  count?: number;
  motion?: Partial<ZoomMotion>;
  anchor?: ZoomAnchor;
}

export interface ZoomAdjusted {
  count: number;
  motion: ZoomMotion;
  repeats: ZoomRepeat[];
  reasons: string[];
}

export interface ZoomProposal {
  algo: string;
  clipId: string;
  confirmKey: string;
  outputFps: number;
  status: 'preview' | 'needs-anchor' | 'impossible';
  anchor: ZoomAnchor;
  requested: { count: number | null; motion: ZoomMotion };
  adjusted: ZoomAdjusted | null;
  basis: { geometry: string[]; heuristic: string[] };
  impossible: string[] | null;
  droppedOverrideIds: string[];
}

export function smoothstep01(u: number): number {
  const t = Math.max(0, Math.min(1, u));
  return t * t * (3 - 2 * t);
}

export function zoomConfirmKey(value: unknown): string {
  return fingerprintOf(value);
}

export function phaseSeconds(motion: ZoomMotion): { inSec: number; holdSec: number; outSec: number; total: number } {
  const inSec = motion.inEase === 'instant' ? 0 : Math.max(0, motion.inSec);
  const outSec = motion.outEase === 'instant' ? 0 : Math.max(0, motion.outSec);
  const holdSec = Math.max(0, motion.holdSec);
  return { inSec, holdSec, outSec, total: inSec + holdSec + outSec };
}

export function resolveMotion(common: ZoomMotion, override: Partial<ZoomMotion> | null | undefined): ZoomMotion {
  if (!override) return { ...common };
  const next = { ...common };
  (Object.keys(override) as Array<keyof ZoomMotion>).forEach((key) => {
    const value = override[key];
    if (value !== undefined && value !== null) (next as unknown as Record<string, unknown>)[key] = value;
  });
  if (next.inEase === 'instant') next.inSec = 0;
  if (next.outEase === 'instant') next.outSec = 0;
  return next;
}

/** 출력 격자에서 실제로 찍히는 마지막 시각. 반열림 끝(duration) 자체는 프레임이 아니다. */
export function lastOutputFrameTime(duration: number, fps: number): number {
  const step = 1 / Math.max(1, fps);
  const n = Math.floor((duration - 1e-9) / step);
  return Math.max(0, n * step);
}

export function frameTimes(duration: number, fps: number): number[] {
  const step = 1 / Math.max(1, fps);
  const out: number[] = [];
  for (let t = 0; t < duration - 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out.length ? out : [0];
}

/** 시각 t의 추가 배율. 반복 밖과 끝난 뒤에는 1이다. 즉시 구간은 계단이고, 부드러운 구간만 smoothstep이다. */
export function zoomMultiplierAt(local: number, common: ZoomMotion, repeats: readonly ZoomRepeat[]): number {
  let best = 1;
  for (const repeat of repeats) {
    const motion = resolveMotion(common, repeat.override);
    const phase = phaseSeconds(motion);
    if (!(phase.total > 0) || !(motion.strength > 1)) continue;
    const t = local - repeat.start;
    if (t < -1e-9 || t >= phase.total - 1e-9) continue;
    let u = 1;
    if (t < phase.inSec) u = phase.inSec <= 0 ? 1 : smoothstep01(t / phase.inSec);
    else if (t >= phase.inSec + phase.holdSec && phase.outSec > 0) {
      const into = t - (phase.inSec + phase.holdSec);
      u = smoothstep01(1 - into / phase.outSec);
    }
    const mult = 1 + (motion.strength - 1) * u;
    if (mult > best) best = mult;
  }
  return best;
}

export function gridReport(common: ZoomMotion, repeats: readonly ZoomRepeat[], duration: number, fps: number): {
  visible: boolean;
  lastIsBase: boolean;
  maxMultiplier: number;
  lastTime: number;
} {
  const times = frameTimes(duration, fps);
  const lastTime = times[times.length - 1];
  let maxMultiplier = 1;
  for (const t of times) maxMultiplier = Math.max(maxMultiplier, zoomMultiplierAt(t, common, repeats));
  const last = zoomMultiplierAt(lastTime, common, repeats);
  return { visible: maxMultiplier > 1.001, lastIsBase: last <= 1.001, maxMultiplier, lastTime };
}

function finiteMotion(motion: ZoomMotion): boolean {
  return [motion.inSec, motion.holdSec, motion.outSec, motion.strength].every((n) => Number.isFinite(n))
    && motion.strength > 0
    && motion.inSec >= 0 && motion.holdSec >= 0 && motion.outSec >= 0;
}

export interface FitResult {
  status: 'ok' | 'impossible';
  motion: ZoomMotion;
  repeats: ZoomRepeat[];
  reasons: string[];
  impossible: string[];
}

/**
 * 요청한 횟수와 움직임이 창 안에 들어가면 그대로 두고, 넘치면 시간만 같은 비율로 줄인 조정안을 만든다.
 * 조정안을 프로젝트에 넣지 않는다. 줄여도 어느 출력 프레임에도 안 보이거나 마지막 프레임이 기본 구도가 아니면 impossible.
 */
export function fitZoomRepeats(input: {
  count: number;
  motion: ZoomMotion;
  window: ZoomWindow;
  idPrefix?: string;
}): FitResult {
  const reasons: string[] = [];
  const impossible: string[] = [];
  const count = Math.round(input.count);
  if (!Number.isFinite(count) || count < 1) {
    return { status: 'impossible', motion: input.motion, repeats: [], reasons, impossible: ['반복 횟수는 1 이상의 유한한 정수여야 합니다.'] };
  }
  if (!finiteMotion(input.motion)) {
    return { status: 'impossible', motion: input.motion, repeats: [], reasons, impossible: ['확대 강도나 시간에 유한하지 않은 값이 있습니다.'] };
  }
  if (!(input.motion.strength > 1)) {
    return {
      status: 'impossible', motion: input.motion, repeats: [], reasons,
      impossible: ['추가 줌 강도 1은 기본 구도 그대로라 확대가 없습니다. 1보다 큰 강도가 필요합니다.'],
    };
  }
  const phase = phaseSeconds(input.motion);
  if (!(phase.total > 0)) {
    return {
      status: 'impossible', motion: input.motion, repeats: [], reasons,
      impossible: ['즉시 확대, 즉시 축소, 유지 0초는 어느 출력 프레임에도 나타나지 않습니다. 유지 또는 부드러운 구간이 필요합니다.'],
    };
  }
  const span = input.window.end - input.window.start;
  if (!(span > 0)) {
    return {
      status: 'impossible', motion: input.motion, repeats: [], reasons,
      impossible: ['경계 연결과 마지막 프레임을 빼고 나면 줌 리듬을 둘 구간이 없습니다.'],
    };
  }
  let motion = { ...input.motion, inSec: phase.inSec, outSec: phase.outSec, holdSec: phase.holdSec };
  let cycle = phase.total;
  if (count * cycle > span + 1e-6) {
    const scale = span / (count * cycle);
    motion = {
      ...motion,
      inSec: motion.inEase === 'instant' ? 0 : motion.inSec * scale,
      outSec: motion.outEase === 'instant' ? 0 : motion.outSec * scale,
      holdSec: motion.holdSec * scale,
    };
    cycle = phaseSeconds(motion).total;
    reasons.push('요청한 반복이 클립의 사용 가능 구간보다 길어, 확대·유지·축소 시간을 같은 비율로 줄인 조정안입니다. 확인 전에는 적용하지 않습니다.');
  }
  if (!(cycle > 0) || count * cycle > span + 1e-4) {
    return {
      status: 'impossible', motion, repeats: [], reasons,
      impossible: ['시간을 줄여도 요청한 횟수가 마지막 프레임의 기본 구도 복귀 안에 들어가지 않습니다. 횟수 또는 시간을 줄여 주세요.'],
    };
  }
  const prefix = input.idPrefix ?? 'zr';
  const repeats: ZoomRepeat[] = [];
  const room = span - cycle;
  for (let i = 0; i < count; i += 1) {
    const start = count === 1 ? input.window.start : input.window.start + (room * i) / (count - 1);
    repeats.push({ id: `${prefix}-${i}`, start, override: null });
  }
  const report = gridReport(motion, repeats, input.window.duration, input.window.outputFps);
  if (!report.visible) {
    impossible.push('조정 뒤에도 출력 프레임 격자에서 확대가 보이지 않습니다. 유지 시간 또는 부드러운 구간을 늘려 주세요.');
  }
  if (!report.lastIsBase) {
    impossible.push('마지막 출력 프레임이 기본 구도로 돌아오지 않습니다. 반복의 끝 시각을 앞으로 당겨 주세요.');
  }
  if (impossible.length) return { status: 'impossible', motion, repeats: [], reasons, impossible };
  return { status: 'ok', motion, repeats, reasons, impossible: [] };
}

/** 기본 크롭을 앵커가 화면에서 같은 자리에 남도록 1/strength 로 줄인다. 비율은 유지하고 화면 밖으로 나가지 않는다. */
export function zoomSourceRect(base: ZoomRect, anchorX: number, anchorY: number, strength: number, sourcePixels?: { width: number; height: number }): {
  rect: ZoomRect;
  multiplier: number;
  limited: boolean;
} {
  if (!(strength > 1) || ![base.x, base.y, base.w, base.h, anchorX, anchorY, strength].every(Number.isFinite)) {
    return { rect: base, multiplier: 1, limited: false };
  }
  let mult = strength;
  let limited = false;
  if (sourcePixels && sourcePixels.width > 1 && sourcePixels.height > 1) {
    const minW = 1 / sourcePixels.width;
    const minH = 1 / sourcePixels.height;
    const floor = Math.max(minW / Math.max(1e-6, base.w), minH / Math.max(1e-6, base.h));
    const maxMult = 1 / Math.max(floor, 1e-6);
    if (mult > maxMult) { mult = Math.max(1, maxMult); limited = true; }
  }
  if (!(mult > 1.001)) return { rect: base, multiplier: 1, limited: true };
  const newW = base.w / mult;
  const newH = base.h / mult;
  const u = base.w > 1e-6 ? Math.max(0, Math.min(1, (anchorX - base.x) / base.w)) : 0.5;
  const v = base.h > 1e-6 ? Math.max(0, Math.min(1, (anchorY - base.y) / base.h)) : 0.5;
  let x = anchorX - u * newW;
  let y = anchorY - v * newH;
  x = Math.max(0, Math.min(1 - newW, x));
  y = Math.max(0, Math.min(1 - newH, y));
  return { rect: { x, y, w: newW, h: newH }, multiplier: mult, limited };
}

export function readZoomRhythm(raw: unknown): ClipZoomRhythm | null {
  if (raw == null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const status = row.status === 'applied' || row.status === 'stale' ? row.status : 'off';
  if (status === 'off' || !row.plan || typeof row.plan !== 'object') return null;
  const plan = row.plan as Record<string, unknown>;
  const common = readMotion(plan.common);
  const anchor = readAnchor(plan.anchor);
  const repeats = Array.isArray(plan.repeats) ? plan.repeats.map(readRepeat).filter((r): r is ZoomRepeat => r != null) : [];
  if (!common || !anchor || !repeats.length) return null;
  if (plan.algo !== ZOOM_RHYTHM_ALGO) return { status: 'stale', plan: null };
  return {
    status,
    plan: {
      algo: ZOOM_RHYTHM_ALGO,
      anchor,
      common,
      repeats,
      confirmKey: typeof plan.confirmKey === 'string' ? plan.confirmKey : '',
      outputFps: typeof plan.outputFps === 'number' && Number.isFinite(plan.outputFps) ? plan.outputFps : OBSERVED_EXPORT_FPS,
    },
  };
}

function readMotion(raw: unknown): ZoomMotion | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const motion: ZoomMotion = {
    inEase: m.inEase === 'instant' ? 'instant' : 'smooth',
    outEase: m.outEase === 'instant' ? 'instant' : 'smooth',
    inSec: num(m.inSec),
    holdSec: num(m.holdSec),
    outSec: num(m.outSec),
    strength: num(m.strength),
  };
  if (!finiteMotion(motion)) return null;
  return resolveMotion(motion, null);
}

function readAnchor(raw: unknown): ZoomAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.kind === 'tracking') return { kind: 'tracking', x: null, y: null };
  if (a.kind !== 'user') return null;
  const x = num(a.x);
  const y = num(a.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { kind: 'user', x, y };
}

function readRepeat(raw: unknown): ZoomRepeat | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !Number.isFinite(num(r.start))) return null;
  const partial = r.override && typeof r.override === 'object' ? partialMotion(r.override as Record<string, unknown>) : null;
  return { id: r.id, start: num(r.start), override: partial };
}

function partialMotion(raw: Record<string, unknown>): Partial<ZoomMotion> | null {
  const out: Partial<ZoomMotion> = {};
  if (raw.inEase === 'instant' || raw.inEase === 'smooth') out.inEase = raw.inEase;
  if (raw.outEase === 'instant' || raw.outEase === 'smooth') out.outEase = raw.outEase;
  if (typeof raw.inSec === 'number' && Number.isFinite(raw.inSec)) out.inSec = raw.inSec;
  if (typeof raw.holdSec === 'number' && Number.isFinite(raw.holdSec)) out.holdSec = raw.holdSec;
  if (typeof raw.outSec === 'number' && Number.isFinite(raw.outSec)) out.outSec = raw.outSec;
  if (typeof raw.strength === 'number' && Number.isFinite(raw.strength)) out.strength = raw.strength;
  return Object.keys(out).length ? out : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

/** 최대 횟수: 창을 반복 길이로 나눈 값. 휴리스틱이며 사용자 확정 횟수가 아니다. */
export function maxEvenCount(cycle: number, span: number): number {
  if (!(cycle > 0) || !(span > 0)) return 0;
  return Math.max(0, Math.floor((span + 1e-9) / cycle));
}

/**
 * 기존 추적 줌 상한(ZOOM_MAX) 안에서 기본 줌과 상한의 가운데.
 * 제안 휴리스틱이다. 사용자 확정 강도가 아니다.
 */
export function midpointStrength(baseZoom: number, zoomCap: number): { strength: number; maxStrength: number; room: boolean } {
  const maxStrength = zoomCap / Math.max(1e-3, baseZoom);
  if (!(maxStrength > 1.001)) return { strength: 1, maxStrength, room: false };
  return { strength: (1 + maxStrength) / 2, maxStrength, room: true };
}
