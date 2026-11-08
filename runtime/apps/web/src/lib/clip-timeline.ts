/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·8855d65c @license @preserve */
import {
  EXPRESSION_ZOOM_MAX, EXPRESSION_ZOOM_MIN, FACE_FX_ALGO, continueManualFace, emptyFaceFx, expressionWeight, faceFxActive, faceMasksAt,
  faceUncertainSegments, fingerprintOf, linkFaceTracks, protagonistFaceAt, readFaceFx, recenterOnFace,
  reviewCovers, trackAt,
  type ClipFaceFx, type FaceAnalysis, type FaceDetection, type FaceMask, type FaceResolution,
  type FaceResolutionKind, type FaceScene, type FaceTrack, type FaceUncertainSegment, type ManualFaceKey,
  type ManualPath,
} from '@/lib/face-fx';
import {
  OBSERVED_EXPORT_FPS, ZOOM_RHYTHM_ALGO, fitZoomRepeats, gridReport, lastOutputFrameTime, maxEvenCount,
  midpointStrength, phaseSeconds, readZoomRhythm, resolveMotion, zoomConfirmKey, zoomMultiplierAt, zoomSourceRect,
  type ClipZoomRhythm, type ZoomAnchor, type ZoomMotion, type ZoomProposal, type ZoomRequest,
  type ZoomRhythmPlan, type ZoomWindow,
} from '@/lib/zoom-rhythm';
import {
  SKIN_FX_ALGO, isNeutralSkin, proposeSkinFromStats, readSkinAdjust, skinInRange, skinKey,
  type FaceBox, type SkinAdjust, type SkinMask, type SkinStats,
} from '@/lib/skin-fx';

/**
 * FollowCamera 생성자에 있는 zoomOutTau 0.4 · zoomInTau 1.0 과 같은 초.
 * 그 파일은 고정 해시 검사라 여기서 값을 다시 적는다. 새 정책 계수가 아니다.
 */
const FOLLOW_ZOOM_OUT_TAU_SEC = 0.4;

/**
 * 여러 원본을 한 줄로 잇는 편집 시간.
 *
 * 미리보기·타임라인·원본 소리·자막·내보내기가 이 계산만 쓴다.
 * 클립은 반열림 [sourceStart, sourceEnd) 이다.
 * 겹침 전환만 전체 길이를 줄이고, 카메라 이동은 길이를 바꾸지 않는다.
 */

export type OutputAspectChoice = 'source' | '9:16' | '16:9' | '1:1';
export type TransitionKind = 'dissolve' | 'fade-black' | 'slide-left' | 'slide-right';

/** 추적 상자를 전신으로 볼 때 상자 밖에 두는 여유. 손발을 측정하지 않았으므로 포함을 보장하지 않는다. */
export const BODY_BOX_MARGIN = 0.18;
/** 사용자가 넣는 전환의 처음 길이. FollowCamera zoomOutTau 와 같은 초이며 시안 숫자가 아니다. */
export const DEFAULT_TEMPLATE_SEC = FOLLOW_ZOOM_OUT_TAU_SEC;
const MIN_LINK_SEC = 0.12;
const MAX_LINK_SEC = FOLLOW_ZOOM_OUT_TAU_SEC * 3;
const MIN_CLIP_SEC = 1 / 60;
/** trackingStartsAtSeed 의 기본 maxGapSec 과 같다. 이보다 긴 구멍은 궤적이 클립을 덮지 못한 것이다. */
export const UNCOVERED_HOLE_SEC = 0.5;
/** face-fx.test.ts 가 face-fx.ts 의 같은 값과 비교한다. */
export const FOLLOW_TAU_SEC_FOR_TEST = FOLLOW_ZOOM_OUT_TAU_SEC;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export interface NormBox { x: number; y: number; width: number; height: number }
export interface NormRect { x: number; y: number; w: number; h: number }

export interface TimelineSource {
  id: string;
  label: string;
  durationSec: number;
  width: number;
  height: number;
  /** 0·90·180·270. 브라우저가 이미 돌려 videoWidth 를 준 경우에는 0. */
  rotationDeg: number;
  frameRate: number;
  hasAudio: boolean;
  sampleRate: number;
  /** 다시 연결할 때 같은 파일인지 본다. 없으면 검사하지 않는다. */
  fileName?: string;
  fileSize?: number;
  fileModified?: number;
}

export interface ClipTracking {
  status: 'running' | 'ready' | 'uncertain' | 'stale' | 'failed';
  jobId: string;
  seed: { sourceTimeSec: number; box: NormBox };
  points: Array<{ t: number; box: NormBox; uncertain: boolean }>;
  zoom: number;
  posX: number;
  posY: number;
  entryMode: 'auto' | 'manual';
  exitMode: 'auto' | 'manual';
  entrySec: number | null;
  exitSec: number | null;
  analyzedStart: number;
  analyzedEnd: number;
}

export interface TimelineClip {
  id: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  tracking: ClipTracking | null;
  /** 2단계 얼굴 효과. 없거나 null 이면 효과 없음(2단계 이전 저장본과 같음). */
  faceFx?: ClipFaceFx | null;
  /** 3단계 줌 리듬. 없거나 null 이면 효과 없음. 제안만으로는 생기지 않는다. */
  zoomRhythm?: ClipZoomRhythm | null;
  /** 4단계 피부 보정. 없거나 null 이면 효과 없음. 제안만으로는 생기지 않는다. */
  skin?: ClipSkin | null;
}

export interface SkinSampleRecord {
  t: number;
  mask: SkinMask;
  face: FaceBox | null;
  stats: SkinStats | null;
}

export interface ClipSkin {
  status: 'off' | 'applied';
  adjust: SkinAdjust | null;
  confirmKey: string;
  samples: SkinSampleRecord[];
}

export interface TimelineTransition {
  id: string;
  leftClipId: string;
  rightClipId: string;
  kind: TransitionKind;
  /** 사용자가 요청한 겹침(초). */
  requestedSec: number;
  audioCrossfade: boolean;
}

export interface TimelineCaption {
  id: string;
  clipId: string | null;
  localStart: number;
  localEnd: number;
  text: string;
  placement: 'placed' | 'needs-placement';
  /** 분할 전 소속. 다시 배치하기 전까지 출력하지 않는다. */
  heldClipId: string | null;
  style: {
    font?: string;
    look?: string;
    color?: string;
    scale?: number;
    rotate?: number;
    pos?: { x: number; y: number } | null;
  };
}

export interface TimelineMusic {
  key: string;
  fromSec: number;
  toSec: number | null;
  startSec: number;
  volume: number;
}

export interface TimelineProject {
  version: 1;
  aspect: OutputAspectChoice;
  /** 첫 원본의 표시 비율(가로/세로). 클립을 지워도 바꾸지 않는다. */
  lockedSourceAspect: number;
  sources: TimelineSource[];
  clips: TimelineClip[];
  transitions: TimelineTransition[];
  captions: TimelineCaption[];
  music: TimelineMusic | null;
}

export interface EditHistory<T> {
  past: T[];
  present: T;
  future: T[];
}

const FULL: NormRect = { x: 0, y: 0, w: 1, h: 1 };

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function smoothstep(u: number): number {
  const t = clamp(u, 0, 1);
  return t * t * (3 - 2 * t);
}

function lerpRect(a: NormRect, b: NormRect, u: number): NormRect {
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    w: a.w + (b.w - a.w) * u,
    h: a.h + (b.h - a.h) * u,
  };
}

export function displaySize(source: TimelineSource): { width: number; height: number } {
  const rot = ((source.rotationDeg % 360) + 360) % 360;
  if (rot === 90 || rot === 270) return { width: source.height, height: source.width };
  return { width: source.width, height: source.height };
}

function aspectOf(source: TimelineSource): number {
  const d = displaySize(source);
  return d.width / Math.max(1, d.height);
}

function fpsOf(source: TimelineSource | undefined): number {
  const n = source?.frameRate ?? 30;
  return Number.isFinite(n) && n > 1 ? n : 30;
}

export function createProject(source: TimelineSource, clipId: string): TimelineProject {
  const duration = Math.max(MIN_CLIP_SEC, source.durationSec);
  return {
    version: 1,
    aspect: 'source',
    lockedSourceAspect: aspectOf({ ...source, durationSec: duration }),
    sources: [{ ...source, durationSec: duration }],
    clips: [{
      id: clipId,
      sourceId: source.id,
      sourceStart: 0,
      sourceEnd: duration,
      tracking: null,
    }],
    transitions: [],
    captions: [],
    music: null,
  };
}

export function outputPixelSize(project: TimelineProject): { width: number; height: number } {
  if (project.aspect === '9:16') return { width: 1080, height: 1920 };
  if (project.aspect === '16:9') return { width: 1920, height: 1080 };
  if (project.aspect === '1:1') return { width: 1080, height: 1080 };
  const r = project.lockedSourceAspect > 0 ? project.lockedSourceAspect : 16 / 9;
  if (r >= 1) {
    const height = Math.max(2, Math.round(1920 / r / 2) * 2);
    return { width: 1920, height };
  }
  const width = Math.max(2, Math.round(1920 * r / 2) * 2);
  return { width, height: 1920 };
}

function outputRatio(project: TimelineProject): number {
  const s = outputPixelSize(project);
  return s.width / s.height;
}

export function setAspect(project: TimelineProject, aspect: OutputAspectChoice): TimelineProject {
  return { ...project, aspect };
}

export function addSourceClip(project: TimelineProject, source: TimelineSource, clipId: string): TimelineProject {
  const duration = Math.max(MIN_CLIP_SEC, source.durationSec);
  const nextSource = { ...source, durationSec: duration };
  return {
    ...project,
    sources: [...project.sources, nextSource],
    clips: [...project.clips, {
      id: clipId,
      sourceId: source.id,
      sourceStart: 0,
      sourceEnd: duration,
      tracking: null,
    }],
  };
}

export function removeSource(project: TimelineProject, sourceId: string): TimelineProject {
  const gone = new Set(project.clips.filter((c) => c.sourceId === sourceId).map((c) => c.id));
  return {
    ...project,
    sources: project.sources.filter((s) => s.id !== sourceId),
    clips: project.clips.filter((c) => c.sourceId !== sourceId),
    transitions: project.transitions.filter((t) => !gone.has(t.leftClipId) && !gone.has(t.rightClipId)),
    captions: project.captions.filter((c) => (c.clipId == null || !gone.has(c.clipId)) && (c.heldClipId == null || !gone.has(c.heldClipId))),
  };
}

function sourceById(project: TimelineProject, id: string): TimelineSource | undefined {
  return project.sources.find((s) => s.id === id);
}

function clipDur(clip: TimelineClip): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

/** 구간이 바뀌면 진행 중이거나 범위를 벗어난 궤적은 쓰지 않는다. 작업 id 도 갈아 늦은 결과가 덮지 못하게 한다. */
function retargetTracking(tracking: ClipTracking | null, start: number, end: number): ClipTracking | null {
  if (!tracking) return null;
  const covered = tracking.status !== 'running'
    && tracking.analyzedStart <= start + 1e-4
    && tracking.analyzedEnd >= end - 1e-4;
  if (covered) return tracking;
  return { ...tracking, status: 'stale', jobId: `${tracking.jobId}:stale` };
}

function neighborTransition(project: TimelineProject, leftId: string, rightId: string): TimelineTransition | undefined {
  return project.transitions.find((t) => t.leftClipId === leftId && t.rightClipId === rightId);
}

/** 요청 겹침을 클립 길이에 맞춰 줄인다. 한 클립의 앞·뒤가 같은 프레임을 쓰지 않게 한다. */
function fitOverlaps(project: TimelineProject): number[] {
  const n = project.clips.length;
  const req = new Array<number>(Math.max(0, n - 1)).fill(0);
  for (let i = 0; i < n - 1; i += 1) {
    const hit = neighborTransition(project, project.clips[i].id, project.clips[i + 1].id);
    req[i] = hit ? Math.max(0, hit.requestedSec) : 0;
  }
  for (let iter = 0; iter < 12; iter += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      const head = i === 0 ? 0 : req[i - 1];
      const tail = i === n - 1 ? 0 : req[i];
      const dur = clipDur(project.clips[i]);
      if (head + tail > dur + 1e-9) {
        const scale = dur <= 0 ? 0 : dur / (head + tail);
        if (i > 0) req[i - 1] *= scale;
        if (i < n - 1) req[i] *= scale;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < req.length; i += 1) {
    const left = project.clips[i];
    const right = project.clips[i + 1];
    const leftFps = fpsOf(sourceById(project, left.sourceId));
    const rightFps = fpsOf(sourceById(project, right.sourceId));
    const leftFrames = req[i] * leftFps;
    const rightFrames = req[i] * rightFps;
    if (leftFrames < 1 || rightFrames < 1) req[i] = 0;
  }
  return req;
}

function continuous(project: TimelineProject, left: TimelineClip, right: TimelineClip): boolean {
  if (left.sourceId !== right.sourceId) return false;
  const fps = fpsOf(sourceById(project, left.sourceId));
  return Math.abs(right.sourceStart - left.sourceEnd) <= 1.5 / fps;
}

function trackingUsable(clip: TimelineClip): ClipTracking | null {
  const t = clip.tracking;
  if (!t || t.status === 'failed' || t.status === 'stale' || t.status === 'running') return null;
  if (t.status !== 'ready' && t.status !== 'uncertain') return null;
  if (t.analyzedStart > clip.sourceStart + 1e-4 || t.analyzedEnd < clip.sourceEnd - 1e-4) return null;
  return t;
}

/** 기존 카메라 연결 길이. 줌 리듬의 부드러운 구간 제안이 이 값을 재사용한다. */
export function cameraLinkSeconds(a: NormBox, b: NormBox, zoomA: number, zoomB: number): number {
  return autoLinkSec(a, b, zoomA, zoomB);
}

function autoLinkSec(a: NormBox, b: NormBox, zoomA: number, zoomB: number): number {
  const dx = (a.x + a.width / 2) - (b.x + b.width / 2);
  const dy = (a.y + a.height / 2) - (b.y + b.height / 2);
  const dist = Math.hypot(dx, dy);
  const scale = Math.abs(Math.log(Math.max(1e-3, zoomB) / Math.max(1e-3, zoomA)));
  const sec = FOLLOW_ZOOM_OUT_TAU_SEC * (1 + (dist + scale) * 2);
  return clamp(sec, MIN_LINK_SEC, MAX_LINK_SEC);
}

export interface ResolvedBoundary {
  index: number;
  leftClipId: string;
  rightClipId: string;
  overlapSec: number;
  overlapRequested: number;
  overlapAdjusted: boolean;
  overlapDropped: boolean;
  overlapReason: string | null;
  template: TimelineTransition | null;
  cameraKind: 'none' | 'bridge' | 'cut' | 'return-left' | 'enter-right' | 'template';
  cameraRequested: number;
  cameraApplied: number;
  cameraMode: 'auto' | 'manual';
  cameraAdjusted: boolean;
  cameraReason: string | null;
  /** 왼쪽 클립 끝에서 카메라 창이 차지하는 초(길이에는 영향 없음). */
  cameraTail: number;
  /** 오른쪽 클립 앞에서 카메라 창이 차지하는 초. */
  cameraHead: number;
}

function resolveBoundaries(project: TimelineProject, overlaps: number[]): ResolvedBoundary[] {
  const out: ResolvedBoundary[] = [];
  for (let i = 0; i < project.clips.length - 1; i += 1) {
    const left = project.clips[i];
    const right = project.clips[i + 1];
    const template = neighborTransition(project, left.id, right.id) ?? null;
    const requested = template?.requestedSec ?? 0;
    const applied = overlaps[i] ?? 0;
    const dropped = Boolean(template) && applied <= 0;
    const overlapAdjusted = Boolean(template) && applied > 0 && applied + 1e-4 < requested;
    let overlapReason: string | null = null;
    if (dropped) overlapReason = '겹칠 프레임이 부족해 이 전환은 적용하지 않습니다.';
    else if (overlapAdjusted) overlapReason = '클립이 짧아 전환 길이를 줄였습니다.';

    const row: ResolvedBoundary = {
      index: i,
      leftClipId: left.id,
      rightClipId: right.id,
      overlapSec: applied,
      overlapRequested: requested,
      overlapAdjusted,
      overlapDropped: dropped,
      overlapReason,
      template: applied > 0 ? template : null,
      cameraKind: 'none',
      cameraRequested: 0,
      cameraApplied: 0,
      cameraMode: 'auto',
      cameraAdjusted: false,
      cameraReason: null,
      cameraTail: 0,
      cameraHead: 0,
    };

    if (applied > 0 && template) {
      row.cameraKind = 'template';
      row.cameraReason = '넣은 전환이 자동 카메라 연결보다 우선합니다.';
      out.push(row);
      continue;
    }

    const leftTrack = trackingUsable(left);
    const rightTrack = trackingUsable(right);
    const joined = continuous(project, left, right);
    if (leftTrack && rightTrack && joined) {
      const manuals: number[] = [];
      if (leftTrack.exitMode === 'manual' && leftTrack.exitSec != null) manuals.push(leftTrack.exitSec);
      if (rightTrack.entryMode === 'manual' && rightTrack.entrySec != null) manuals.push(rightTrack.entrySec);
      const mode = manuals.length ? 'manual' as const : 'auto' as const;
      const boxA = boxAt(leftTrack, Math.max(left.sourceStart, left.sourceEnd - 1e-3));
      const boxB = boxAt(rightTrack, right.sourceStart);
      const requestedSec = mode === 'manual'
        ? clamp(Math.min(...manuals), MIN_LINK_SEC, MAX_LINK_SEC)
        : autoLinkSec(boxA, boxB, leftTrack.zoom, rightTrack.zoom);
      const leftFree = Math.max(0, clipDur(left) - applied);
      const rightFree = Math.max(0, clipDur(right) - (overlaps[i + 1] ?? 0));
      const span = Math.min(requestedSec, leftFree + rightFree);
      let tail = Math.min(span / 2, leftFree);
      const head = Math.min(span - tail, rightFree);
      tail = Math.min(tail, span - head);
      const leftFps = fpsOf(sourceById(project, left.sourceId));
      if (tail * leftFps < 1 && head * fpsOf(sourceById(project, right.sourceId)) < 1) {
        row.cameraKind = 'cut';
        row.cameraRequested = requestedSec;
        row.cameraMode = mode;
        row.cameraReason = '이어 붙일 프레임이 부족해 컷으로 둡니다.';
      } else {
        row.cameraKind = 'bridge';
        row.cameraRequested = requestedSec;
        row.cameraApplied = tail + head;
        row.cameraMode = mode;
        row.cameraAdjusted = row.cameraApplied + 1e-4 < requestedSec;
        row.cameraTail = tail;
        row.cameraHead = head;
        if (row.cameraAdjusted) row.cameraReason = '클립이 짧아 연결 길이를 줄였습니다.';
      }
      out.push(row);
      continue;
    }

    if (!joined && (leftTrack || rightTrack)) {
      row.cameraKind = 'cut';
      row.cameraReason = left.sourceId !== right.sourceId
        ? '다른 촬영본이라 구도를 유지한 채 컷으로 잇습니다.'
        : '원본 시간이 이어지지 않아 컷으로 잇습니다.';
      out.push(row);
      continue;
    }

    if (leftTrack && !rightTrack) {
      const mode = leftTrack.exitMode;
      const box = boxAt(leftTrack, Math.max(left.sourceStart, left.sourceEnd - 1e-3));
      const full = { x: 0.3, y: 0.15, width: 0.4, height: 0.7 };
      const requestedSec = mode === 'manual' && leftTrack.exitSec != null
        ? clamp(leftTrack.exitSec, MIN_LINK_SEC, MAX_LINK_SEC)
        : autoLinkSec(box, full, leftTrack.zoom, 1);
      const free = Math.max(0, clipDur(left) - applied);
      const tail = Math.min(requestedSec, free);
      const frames = tail * fpsOf(sourceById(project, left.sourceId));
      row.cameraMode = mode;
      row.cameraRequested = requestedSec;
      if (frames < 1) {
        row.cameraKind = 'cut';
        row.cameraReason = '해제할 프레임이 부족해 바로 전체 구도로 둡니다.';
      } else {
        row.cameraKind = 'return-left';
        row.cameraApplied = tail;
        row.cameraTail = tail;
        row.cameraAdjusted = tail + 1e-4 < requestedSec;
        if (row.cameraAdjusted) row.cameraReason = '클립이 짧아 해제 길이를 줄였습니다.';
      }
      out.push(row);
      continue;
    }

    if (!leftTrack && rightTrack) {
      const mode = rightTrack.entryMode;
      const box = boxAt(rightTrack, right.sourceStart);
      const full = { x: 0.3, y: 0.15, width: 0.4, height: 0.7 };
      const requestedSec = mode === 'manual' && rightTrack.entrySec != null
        ? clamp(rightTrack.entrySec, MIN_LINK_SEC, MAX_LINK_SEC)
        : autoLinkSec(full, box, 1, rightTrack.zoom);
      const free = Math.max(0, clipDur(right) - (overlaps[i + 1] ?? 0));
      const head = Math.min(requestedSec, free);
      const frames = head * fpsOf(sourceById(project, right.sourceId));
      row.cameraMode = mode;
      row.cameraRequested = requestedSec;
      if (frames < 1) {
        row.cameraKind = 'cut';
        row.cameraReason = '진입할 프레임이 부족해 바로 추적 구도로 둡니다.';
      } else {
        row.cameraKind = 'enter-right';
        row.cameraApplied = head;
        row.cameraHead = head;
        row.cameraAdjusted = head + 1e-4 < requestedSec;
        if (row.cameraAdjusted) row.cameraReason = '클립이 짧아 진입 길이를 줄였습니다.';
      }
      out.push(row);
      continue;
    }

    out.push(row);
  }
  separateCameraEnds(project, out);
  return out;
}

/** 한 클립 안에서 진입·해제가 같은 프레임을 쓰지 않게 줄인다. */
function separateCameraEnds(project: TimelineProject, rows: ResolvedBoundary[]): void {
  const heads = rows.map((row) => row.cameraHead);
  const tails = rows.map((row) => row.cameraTail);
  for (let iter = 0; iter < 8; iter += 1) {
    let changed = false;
    for (let i = 0; i < project.clips.length; i += 1) {
      const head = i === 0 ? 0 : heads[i - 1];
      const tail = i >= rows.length ? 0 : tails[i];
      const dur = clipDur(project.clips[i]);
      if (head + tail > dur + 1e-9 && head + tail > 0) {
        const scale = dur <= 0 ? 0 : dur / (head + tail);
        if (i > 0) heads[i - 1] *= scale;
        if (i < rows.length) tails[i] *= scale;
        changed = true;
      }
    }
    if (!changed) break;
  }
  rows.forEach((row, i) => {
    const left = project.clips[i];
    const right = project.clips[i + 1];
    const leftFps = fpsOf(sourceById(project, left.sourceId));
    const rightFps = fpsOf(sourceById(project, right.sourceId));
    if (tails[i] * leftFps < 1) tails[i] = 0;
    if (heads[i] * rightFps < 1) heads[i] = 0;
    row.cameraTail = tails[i];
    row.cameraHead = heads[i];
    row.cameraApplied = tails[i] + heads[i];
    if ((row.cameraKind === 'bridge' || row.cameraKind === 'return-left' || row.cameraKind === 'enter-right') && row.cameraApplied <= 0) {
      row.cameraKind = 'cut';
      row.cameraReason = '이어 붙일 프레임이 부족해 컷으로 둡니다.';
    } else if (row.cameraApplied + 1e-4 < row.cameraRequested && row.cameraRequested > 0) {
      row.cameraAdjusted = true;
      if (!row.cameraReason) row.cameraReason = '클립이 짧아 연결 길이를 줄였습니다.';
    }
  });
}

export interface ClipPlacement {
  clip: TimelineClip;
  outputStart: number;
  durationSec: number;
  headOverlap: number;
  tailOverlap: number;
}

export interface TimelineLayout {
  totalSec: number;
  overlapSec: number;
  clips: ClipPlacement[];
  boundaries: ResolvedBoundary[];
}

export function layoutProject(project: TimelineProject): TimelineLayout {
  const overlaps = fitOverlaps(project);
  const boundaries = resolveBoundaries(project, overlaps);
  const clips: ClipPlacement[] = [];
  let cursor = 0;
  let overlapSum = 0;
  for (let i = 0; i < project.clips.length; i += 1) {
    const clip = project.clips[i];
    const durationSec = clipDur(clip);
    const headOverlap = i === 0 ? 0 : overlaps[i - 1];
    const tailOverlap = i === project.clips.length - 1 ? 0 : overlaps[i];
    const outputStart = i === 0 ? 0 : cursor - headOverlap;
    clips.push({ clip, outputStart, durationSec, headOverlap, tailOverlap });
    cursor = outputStart + durationSec;
    overlapSum += tailOverlap;
  }
  const totalSec = project.clips.length ? cursor : 0;
  return { totalSec, overlapSec: overlapSum, clips, boundaries };
}

function boxAt(track: ClipTracking, sourceTime: number): NormBox {
  const pts = track.points;
  if (!pts.length) return track.seed.box;
  if (sourceTime <= pts[0].t) return pts[0].box;
  const last = pts[pts.length - 1];
  if (sourceTime >= last.t) return last.box;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= sourceTime) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const k = clamp((sourceTime - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  return {
    x: a.box.x + (b.box.x - a.box.x) * k,
    y: a.box.y + (b.box.y - a.box.y) * k,
    width: a.box.width + (b.box.width - a.box.width) * k,
    height: a.box.height + (b.box.height - a.box.height) * k,
  };
}

export function trackedSourceRect(
  box: NormBox,
  zoom: number,
  posX: number,
  posY: number,
  sourceW: number,
  sourceH: number,
  outRatio: number,
): NormRect {
  const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  const margin = 1 + BODY_BOX_MARGIN * 2;
  let pixelH = (box.height * sourceH * margin) / z;
  let pixelW = pixelH * outRatio;
  const bodyW = (box.width * sourceW * margin) / z;
  if (bodyW > pixelW) {
    pixelW = bodyW;
    pixelH = pixelW / Math.max(1e-6, outRatio);
  }
  const fit = Math.min(1, sourceW / Math.max(1, pixelW), sourceH / Math.max(1, pixelH));
  pixelW *= fit;
  pixelH *= fit;
  const cx = (box.x + box.width / 2) * sourceW;
  const cy = (box.y + box.height / 2) * sourceH;
  const anchorX = 0.5 + clamp(posX, -1, 1) * 0.25;
  const anchorY = 0.5 + clamp(posY, -1, 1) * 0.25;
  let left = cx - anchorX * pixelW;
  let top = cy - anchorY * pixelH;
  left = clamp(left, 0, Math.max(0, sourceW - pixelW));
  top = clamp(top, 0, Math.max(0, sourceH - pixelH));
  return { x: left / sourceW, y: top / sourceH, w: pixelW / sourceW, h: pixelH / sourceH };
}

export function containDest(sourceW: number, sourceH: number, outW: number, outH: number): NormRect {
  const s = Math.min(outW / Math.max(1, sourceW), outH / Math.max(1, sourceH));
  const w = sourceW * s;
  const h = sourceH * s;
  return { x: (outW - w) / 2 / outW, y: (outH - h) / 2 / outH, w: w / outW, h: h / outH };
}

export interface DrawLayer {
  sourceId: string;
  /**
   * 이 레이어를 그릴 디코더(video 원소)의 열쇠. 보통 sourceId 와 같고, 같은 원본의 서로 다른 시각이
   * 겹침 전환으로 동시에 보이면 두 번째 레이어는 `${sourceId}#2` 다. 한 원소로 두 시각을 동시에 맞출 수 없어서다.
   */
  decoderKey: string;
  clipId: string;
  sourceTime: number;
  sourceRect: NormRect;
  destRect: NormRect;
  opacity: number;
  uncertain: boolean;
  /**
   * 이 레이어(원본)에 먼저 가릴 얼굴. 원본 표시 정규 좌표다. 그리는 쪽은 원본 화소에서 이 영역을 흐린 뒤
   * 크롭·구도·전환을 적용한다(겹침에서는 앞뒤 레이어가 각자 자기 얼굴을 가린다).
   */
  faceMasks: FaceMask[];
  /** 확정된 줌 리듬이 있을 때만. 1이면 이 시각의 추가 줌은 항등값이다. */
  zoomRhythm?: { multiplier: number; limited: boolean } | null;
  /** 확정된 피부 보정. 이 시각에 쓸 마스크가 없으면 null(원본 피부). */
  skin?: { adjust: SkinAdjust; mask: SkinMask; face: FaceBox | null } | null;
}

export interface AudioLayer {
  sourceId: string;
  decoderKey: string;
  clipId: string;
  sourceTime: number;
  gain: number;
}

export interface TimelineSample {
  outputTime: number;
  layers: DrawLayer[];
  audio: AudioLayer[];
  captions: Array<{ id: string; text: string; opacity: number; clipId: string; style: TimelineCaption['style'] }>;
  letterbox: boolean;
  transition: null | { id: string; kind: TransitionKind; u: number };
}

// ───────────────────────── 얼굴 효과 연결(face-fx.ts) ─────────────────────────

/** 분석이 이 클립의 원본·구간·알고리즘을 그대로 덮는지. */
function faceAnalysisUsable(clip: TimelineClip): FaceAnalysis | null {
  const a = clip.faceFx?.analysis;
  if (!a || a.status !== 'ready' || a.algo !== FACE_FX_ALGO || a.sourceId !== clip.sourceId) return null;
  if (a.analyzedStart > clip.sourceStart + 1e-4 || a.analyzedEnd < clip.sourceEnd - 1e-4) return null;
  return a;
}

function bodyUncertainAt(track: ClipTracking, t: number): boolean {
  return track.points.some((p) => p.uncertain && Math.abs(p.t - t) <= UNCOVERED_HOLE_SEC);
}

const manualCache = new WeakMap<object, Map<FaceAnalysis | 'none', ManualPath>>();

/** 클립의 얼굴 장면(궤적·수동 얼굴). 분석이 없거나 이 클립을 덮지 못하면 null. */
export function faceSceneOf(clip: TimelineClip): FaceScene | null {
  const fx = clip.faceFx;
  if (!fx) return null;
  const analysis = faceAnalysisUsable(clip);
  const track = trackingUsable(clip);
  let tracks: FaceTrack[] = [];
  if (analysis) {
    const bodyKey = track ? `${track.jobId}|${track.points.length}|${track.seed.sourceTimeSec}` : 'no-body';
    tracks = linkFaceTracks(analysis, (t) => (track ? { box: boxAt(track, t), uncertain: bodyUncertainAt(track, t) } : null), bodyKey);
  }
  const manual = fx.blur.manual.map((face) => {
    let byAnalysis = manualCache.get(face);
    if (!byAnalysis) { byAnalysis = new Map(); manualCache.set(face, byAnalysis); }
    const key = analysis ?? 'none';
    let path = byAnalysis.get(key);
    if (!path) { path = continueManualFace(face, analysis); byAnalysis.set(key, path); }
    return path;
  });
  return {
    fx,
    tracks,
    manual,
    sampleTimes: analysis?.sampleTimes ?? [],
    bodyUncertain: (t) => (track ? bodyUncertainAt(track, t) : true),
  };
}

/** 보정 기록이 가리키는 "불확실 상황"의 요약. 궤적·역할·몸 상자가 바뀌면 달라진다. */
function resolutionFingerprintFor(clip: TimelineClip, scene: FaceScene): (r: FaceResolution) => string {
  const track = trackingUsable(clip);
  return (r) => {
    const times = scene.sampleTimes.filter((t) => t >= r.start - 1e-9 && t < r.end - 1e-9);
    const rows = times.map((t) => ({
      t,
      body: track ? boxAt(track, t) : null,
      faces: scene.tracks
        .filter((tr) => r.trackId == null || tr.id === r.trackId)
        .map((tr) => ({ id: tr.id, at: trackAt(tr, t, scene.sampleTimes) }))
        .filter((row) => row.at),
      manual: scene.manual.filter((m) => r.trackId == null || m.id === r.trackId).map((m) => m.points.filter((p) => Math.abs(p.t - t) < 1e-6)),
    }));
    return fingerprintOf({ algo: FACE_FX_ALGO, src: clip.sourceId, kind: r.kind, ref: r.trackId, rows });
  };
}

/**
 * 실제로 그려진 프레임 시각(원본 시각)의 가림 영역. 편집 미리보기·내보내기 그리기에 쓴다.
 * 가리기가 켜졌는데 그 시각을 분석이 덮지 못하면 null(모름) — 그리는 쪽이 실패로 처리한다.
 */
export function faceMasksForClip(project: TimelineProject, clipId: string, sourceTime: number): FaceMask[] | null {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.faceFx?.blur.enabled) return [];
  const a = faceAnalysisUsable(clip);
  if (!a) return null;
  const fps = fpsOf(sourceById(project, clip.sourceId));
  if (sourceTime < a.analyzedStart - 1 / fps || sourceTime > a.analyzedEnd + 1 / fps) return null;
  return masksForClip(clip, sourceTime);
}

function masksForClip(clip: TimelineClip, sourceTime: number): FaceMask[] {
  if (!clip.faceFx?.blur.enabled) return [];
  const scene = faceSceneOf(clip);
  if (!scene) return [];
  return faceMasksAt(scene, sourceTime, resolutionFingerprintFor(clip, scene));
}

interface FaceCamera { weight: number; visibility: number; framingOn: boolean; expressionOn: boolean }

function expressionUsable(clip: TimelineClip | undefined): boolean {
  return Boolean(clip?.faceFx?.expression.enabled && trackingUsable(clip) && faceAnalysisUsable(clip));
}

function expressionLinkSec(clip: TimelineClip, edge: 'entry' | 'exit', track: ClipTracking, face: NormBox | null): number {
  const ex = clip.faceFx!.expression;
  const mode = edge === 'entry' ? ex.entryMode : ex.exitMode;
  const sec = edge === 'entry' ? ex.entrySec : ex.exitSec;
  if (mode === 'manual' && sec != null) return clamp(sec, MIN_LINK_SEC, MAX_LINK_SEC);
  const at = edge === 'entry' ? clip.sourceStart : Math.max(clip.sourceStart, clip.sourceEnd - 1e-3);
  const body = boxAt(track, at);
  if (!face) return autoLinkSec(body, body, track.zoom, track.zoom);
  // 몸 상자에서 얼굴 상자로 가는 기존 자동 연결 길이 계산을 그대로 쓴다(새 시간 정책이 아니다).
  const ratio = body.height / Math.max(1e-3, face.height);
  return autoLinkSec(body, face, track.zoom, track.zoom * ratio);
}

function faceCameraFor(
  project: TimelineProject,
  layout: TimelineLayout | null,
  index: number,
  sourceTime: number,
): FaceCamera {
  const clip = project.clips[index];
  const fx = clip?.faceFx;
  const none = { weight: 0, visibility: 0, framingOn: false, expressionOn: false };
  if (!fx || (!fx.framing.enabled && !fx.expression.enabled)) return none;
  const track = trackingUsable(clip);
  const scene = faceSceneOf(clip);
  if (!track || !scene || !faceAnalysisUsable(clip)) return none;
  const face = protagonistFaceAt(scene.tracks, sourceTime);
  let weight = 0;
  if (fx.expression.enabled) {
    const prevB = layout && index > 0 ? layout.boundaries[index - 1] : undefined;
    const nextB = layout && index < (layout?.boundaries.length ?? 0) ? layout!.boundaries[index] : undefined;
    const startFace = protagonistFaceAt(scene.tracks, clip.sourceStart).box;
    const endFace = protagonistFaceAt(scene.tracks, clip.sourceEnd).box;
    weight = expressionWeight({
      local: sourceTime - clip.sourceStart,
      duration: clipDur(clip),
      entrySec: expressionLinkSec(clip, 'entry', track, startFace),
      exitSec: expressionLinkSec(clip, 'exit', track, endFace),
      holdFromPrev: index > 0 && expressionUsable(project.clips[index - 1]),
      holdIntoNext: index < project.clips.length - 1 && expressionUsable(project.clips[index + 1]),
      reserveHead: prevB ? prevB.cameraHead : 0,
      reserveTail: nextB ? nextB.cameraTail : 0,
    });
  }
  return { weight, visibility: face.visibility, framingOn: fx.framing.enabled, expressionOn: fx.expression.enabled };
}

function framingOf(
  project: TimelineProject,
  clip: TimelineClip,
  sourceTime: number,
  contain: NormRect,
  layout: TimelineLayout | null = null,
): { sourceRect: NormRect; destRect: NormRect; uncertain: boolean } {
  const track = trackingUsable(clip);
  const source = sourceById(project, clip.sourceId);
  const size = source ? displaySize(source) : { width: 1, height: 1 };
  if (!track) {
    return { sourceRect: FULL, destRect: contain, uncertain: clip.tracking?.status === 'uncertain' || clip.tracking?.status === 'stale' };
  }
  let crop = trackedSourceRect(boxAt(track, sourceTime), track.zoom, track.posX, track.posY, size.width, size.height, outputRatio(project));
  const index = project.clips.findIndex((row) => row.id === clip.id);
  const cam = index >= 0 ? faceCameraFor(project, layout, index, sourceTime) : null;
  if (cam && (cam.framingOn || cam.expressionOn)) {
    const scene = faceSceneOf(clip);
    const face = scene ? protagonistFaceAt(scene.tracks, sourceTime).box : null;
    if (face) {
      // 얼굴 기준 구도: 크기는 몸 구도 그대로, 위치만 얼굴로. 얼굴이 안 보이면 몸 구도로 부드럽게 돌아간다.
      if (cam.framingOn) crop = lerpRect(crop, recenterOnFace(crop, face), cam.visibility);
      // 표정 확대: 얼굴 상자에 기존 추적 구도 계산을 쓴다. 위치(얼굴 기준 구도)와 줌을 따로 섞는다.
      if (cam.expressionOn && cam.weight > 0) {
        const zoom = clip.faceFx!.expression.zoom;
        let target = trackedSourceRect(face, zoom, track.posX, track.posY, size.width, size.height, outputRatio(project));
        if (cam.framingOn) target = recenterOnFace(target, face);
        crop = lerpRect(crop, target, cam.weight * cam.visibility);
      }
    }
  }
  const uncertain = clip.tracking?.status === 'uncertain'
    || track.points.some((p) => p.uncertain && Math.abs(p.t - sourceTime) <= UNCOVERED_HOLE_SEC);
  return { sourceRect: crop, destRect: { x: 0, y: 0, w: 1, h: 1 }, uncertain };
}

function blendToward(
  from: { sourceRect: NormRect; destRect: NormRect },
  to: { sourceRect: NormRect; destRect: NormRect },
  u: number,
): { sourceRect: NormRect; destRect: NormRect } {
  const k = smoothstep(u);
  return { sourceRect: lerpRect(from.sourceRect, to.sourceRect, k), destRect: lerpRect(from.destRect, to.destRect, k) };
}

export function sampleProject(project: TimelineProject, outputTime: number): TimelineSample {
  const layout = layoutProject(project);
  const outSize = outputPixelSize(project);
  const t = clamp(outputTime, 0, Math.max(0, layout.totalSec - 1e-6));
  const layers: DrawLayer[] = [];
  const audio: AudioLayer[] = [];
  const captions: TimelineSample['captions'] = [];
  let transition: TimelineSample['transition'] = null;
  let letterbox = false;

  layout.clips.forEach((place, index) => {
    const local = t - place.outputStart;
    if (local < -1e-6 || local >= place.durationSec - 1e-9) return;
    const clip = place.clip;
    const source = sourceById(project, clip.sourceId);
    const size = source ? displaySize(source) : { width: 1, height: 1 };
    const contain = containDest(size.width, size.height, outSize.width, outSize.height);
    const sourceTime = clip.sourceStart + local;
    let framed = framingOf(project, clip, sourceTime, contain, layout);
    const prev = index > 0 ? layout.boundaries[index - 1] : undefined;
    const next = index < layout.boundaries.length ? layout.boundaries[index] : undefined;

    if (prev && prev.cameraKind === 'bridge' && local < prev.cameraHead - 1e-9 && prev.cameraApplied > 0) {
      const u = (prev.cameraTail + local) / prev.cameraApplied;
      const leftClip = project.clips[index - 1];
      const leftFrame = framingOf(project, leftClip, sourceTime, contain, layout);
      framed = { ...blendToward(leftFrame, framed, u), uncertain: framed.uncertain || leftFrame.uncertain };
    } else if (prev && prev.cameraKind === 'enter-right' && local < prev.cameraHead - 1e-9) {
      const u = prev.cameraHead <= 0 ? 1 : local / prev.cameraHead;
      framed = { ...blendToward({ sourceRect: FULL, destRect: contain }, framed, u), uncertain: framed.uncertain };
    }

    if (next && next.cameraKind === 'bridge' && place.durationSec - local < next.cameraTail + 1e-9 && next.cameraApplied > 0) {
      const elapsed = next.cameraTail - (place.durationSec - local);
      const u = elapsed / next.cameraApplied;
      const rightClip = project.clips[index + 1];
      const rightFrame = framingOf(project, rightClip, sourceTime, contain, layout);
      framed = { ...blendToward(framed, rightFrame, u), uncertain: framed.uncertain || rightFrame.uncertain };
    } else if (next && next.cameraKind === 'return-left' && place.durationSec - local < next.cameraTail + 1e-9) {
      const into = place.durationSec - local;
      const u = next.cameraTail <= 0 ? 1 : 1 - into / next.cameraTail;
      framed = { ...blendToward(framed, { sourceRect: FULL, destRect: contain }, u), uncertain: framed.uncertain };
    }

    let opacity = 1;
    let dest = framed.destRect;
    if (prev && prev.template && local < prev.overlapSec - 1e-9) {
      const u = prev.overlapSec <= 0 ? 1 : local / prev.overlapSec;
      transition = { id: prev.template.id, kind: prev.template.kind, u };
      if (prev.template.kind === 'dissolve') opacity = u;
      else if (prev.template.kind === 'fade-black') opacity = u < 0.5 ? 0 : (u - 0.5) * 2;
      else if (prev.template.kind === 'slide-left') dest = { ...dest, x: dest.x + (1 - u) };
      else if (prev.template.kind === 'slide-right') dest = { ...dest, x: dest.x - (1 - u) };
    }
    if (next && next.template && place.durationSec - local < next.overlapSec + 1e-9) {
      const leftU = next.overlapSec <= 0 ? 1 : (place.durationSec - local) / next.overlapSec;
      const u = 1 - leftU;
      transition = { id: next.template.id, kind: next.template.kind, u };
      if (next.template.kind === 'dissolve') opacity = 1 - u;
      else if (next.template.kind === 'fade-black') opacity = u < 0.5 ? 1 - u * 2 : 0;
      else if (next.template.kind === 'slide-left') dest = { ...dest, x: dest.x - u };
      else if (next.template.kind === 'slide-right') dest = { ...dest, x: dest.x + u };
    }

    if (framed.destRect.w < 0.999 || framed.destRect.h < 0.999 || dest.w < 0.999 || dest.h < 0.999) letterbox = true;
    if (Math.abs(framed.sourceRect.w - 1) < 1e-3 && Math.abs(framed.destRect.w - 1) > 1e-3) letterbox = true;

    const sameSource = layers.filter((row) => row.sourceId === clip.sourceId).length;
    const decoderKey = sameSource === 0 ? clip.sourceId : `${clip.sourceId}#${sameSource + 1}`;
    const zoomed = applyConfirmedZoom(project, clip, local, framed.sourceRect, size, prev, next);
    layers.push({
      sourceId: clip.sourceId,
      decoderKey,
      clipId: clip.id,
      sourceTime,
      sourceRect: zoomed.rect,
      destRect: dest,
      opacity,
      uncertain: framed.uncertain,
      faceMasks: masksForClip(clip, sourceTime),
      zoomRhythm: zoomed.marker,
      skin: skinForClip(clip, sourceTime),
    });

    let gain = opacity;
    if (prev?.template && local < prev.overlapSec && prev.template.audioCrossfade) {
      gain = local / Math.max(1e-6, prev.overlapSec);
    } else if (next?.template && place.durationSec - local < next.overlapSec && next.template.audioCrossfade) {
      gain = (place.durationSec - local) / Math.max(1e-6, next.overlapSec);
    } else if (prev?.template && local < prev.overlapSec && !prev.template.audioCrossfade) {
      gain = 0;
    }
    audio.push({ sourceId: clip.sourceId, decoderKey, clipId: clip.id, sourceTime, gain: clamp(gain, 0, 1) });

    for (const cap of project.captions) {
      if (cap.placement !== 'placed' || cap.clipId !== clip.id) continue;
      const rel = sourceTime - clip.sourceStart;
      if (rel < cap.localStart - 1e-9 || rel >= cap.localEnd - 1e-9) continue;
      if (!cap.text.trim()) continue;
      captions.push({ id: cap.id, text: cap.text, opacity, clipId: clip.id, style: cap.style });
    }
  });

  if (!layers.length) letterbox = true;
  return { outputTime: t, layers, audio, captions, letterbox, transition };
}

/**
 * 원본마다 하나인 디코더 말고 더 필요한 디코더 열쇠. 같은 원본의 두 클립이 겹침 전환으로 맞닿으면 `${sourceId}#2`.
 * 미리보기·내보내기가 이 목록대로 video 원소를 하나 더 만든다.
 */
export function extraDecoderKeys(project: TimelineProject): string[] {
  const out = new Set<string>();
  for (const row of layoutProject(project).boundaries) {
    if (row.overlapSec <= 1e-9) continue;
    const left = project.clips[row.index];
    const right = project.clips[row.index + 1];
    if (left && right && left.sourceId === right.sourceId) out.add(`${left.sourceId}#2`);
  }
  return [...out].sort();
}

/** 디코더 열쇠의 원본 id. */
export function decoderSourceId(key: string): string {
  const at = key.lastIndexOf('#');
  return at > 0 ? key.slice(0, at) : key;
}

export function framesForExport(project: TimelineProject, fps = 30): number {
  const total = layoutProject(project).totalSec;
  return Math.max(1, Math.round(total * fps));
}

function zoomReserves(prev?: ResolvedBoundary, next?: ResolvedBoundary): { head: number; tail: number } {
  const head = prev && (prev.cameraKind === 'bridge' || prev.cameraKind === 'enter-right') ? prev.cameraHead : 0;
  const tail = next && (next.cameraKind === 'bridge' || next.cameraKind === 'return-left') ? next.cameraTail : 0;
  return { head, tail };
}

function zoomWindowOf(duration: number, fps: number, head: number, tail: number): ZoomWindow {
  const last = lastOutputFrameTime(duration, fps);
  const end = Math.min(last, Math.max(0, duration - Math.max(0, tail)));
  const start = Math.min(Math.max(0, head), Math.max(0, end));
  return { start, end, duration, outputFps: fps };
}

function clipZoomWindow(project: TimelineProject, index: number, duration: number): ZoomWindow {
  const layout = layoutProject(project);
  const prev = index > 0 ? layout.boundaries[index - 1] : undefined;
  const next = index < layout.boundaries.length ? layout.boundaries[index] : undefined;
  const reserve = zoomReserves(prev, next);
  return zoomWindowOf(duration, OBSERVED_EXPORT_FPS, reserve.head, reserve.tail);
}

function applyConfirmedZoom(
  project: TimelineProject,
  clip: TimelineClip,
  local: number,
  base: NormRect,
  size: { width: number; height: number },
  prev: ResolvedBoundary | undefined,
  next: ResolvedBoundary | undefined,
): { rect: NormRect; marker: DrawLayer['zoomRhythm'] } {
  const plan = clip.zoomRhythm?.status === 'applied' ? clip.zoomRhythm.plan : null;
  if (!plan) return { rect: base, marker: undefined };
  const reserve = zoomReserves(prev, next);
  const window = zoomWindowOf(clipDur(clip), plan.outputFps || OBSERVED_EXPORT_FPS, reserve.head, reserve.tail);
  const outside = local < window.start - 1e-9 || local >= window.end - 1e-9;
  const anchor = zoomAnchorPoint(project, clip, clip.sourceStart + local, plan.anchor);
  if (!anchor || outside) return { rect: base, marker: { multiplier: 1, limited: false } };
  const mult = zoomMultiplierAt(local, plan.common, plan.repeats);
  const zoomed = zoomSourceRect(base, anchor.x, anchor.y, mult, size);
  return { rect: zoomed.rect, marker: { multiplier: zoomed.multiplier, limited: zoomed.limited } };
}

function zoomAnchorPoint(
  project: TimelineProject,
  clip: TimelineClip,
  sourceTime: number,
  anchor: ZoomAnchor,
): { x: number; y: number } | null {
  if (anchor.kind === 'user') {
    if (anchor.x == null || anchor.y == null) return null;
    if (anchor.x < 0 || anchor.y < 0 || anchor.x > 1 || anchor.y > 1) return null;
    return { x: anchor.x, y: anchor.y };
  }
  const track = trackingUsable(clip);
  if (!track) return null;
  const box = boxAt(track, sourceTime);
  // 세로는 상자 한가운데(허리)가 아니라 얼굴 높이를 기준으로 잡는다. 확대 중심은 화면에서 같은 자리에 남으므로
  // 허리를 잡으면 2배 확대 때 머리가 화면 위로 잘렸다(2026-11-09 운영 시험, 16:9·전신 구도). 얼굴이 남고 아래쪽이 잘린다.
  return { x: box.x + box.width / 2, y: box.y + box.height * ZOOM_FACE_ANCHOR_Y };
}

/** 사람 상자 위에서부터 머리 가운데까지의 비율. 서 있는 전신 상자에서 머리는 키의 약 1/8 이라 그 절반쯤이다. 3배 확대까지 머리 꼭대기가 남는다. */
const ZOOM_FACE_ANCHOR_Y = 0.06;

function zoomKeyFor(project: TimelineProject, clip: TimelineClip, anchor: ZoomAnchor): string {
  const index = project.clips.findIndex((row) => row.id === clip.id);
  const window = clipZoomWindow(project, Math.max(0, index), clipDur(clip));
  const track = clip.tracking;
  return zoomConfirmKey({
    algo: ZOOM_RHYTHM_ALGO,
    source: clip.sourceId,
    start: clip.sourceStart,
    end: clip.sourceEnd,
    fps: OBSERVED_EXPORT_FPS,
    aspect: project.aspect,
    window,
    track: track ? { status: track.status, job: track.jobId, zoom: track.zoom, seed: track.seed.sourceTimeSec, points: track.points.length } : null,
    face: clip.faceFx ? {
      blur: clip.faceFx.blur.enabled,
      framing: clip.faceFx.framing.enabled,
      expression: clip.faceFx.expression.enabled,
      zoom: clip.faceFx.expression.zoom,
    } : null,
    anchor,
  });
}

function planStillFits(project: TimelineProject, clip: TimelineClip, plan: ZoomRhythmPlan): boolean {
  const index = project.clips.findIndex((row) => row.id === clip.id);
  const window = clipZoomWindow(project, Math.max(0, index), clipDur(clip));
  if (plan.anchor.kind === 'tracking' && !trackingUsable(clip)) return false;
  if (plan.anchor.kind === 'user' && !zoomAnchorPoint(project, clip, clip.sourceStart, plan.anchor)) return false;
  const repeats = plan.repeats;
  for (const repeat of repeats) {
    const motion = resolveMotion(plan.common, repeat.override);
    const total = phaseSeconds(motion).total;
    if (repeat.start < window.start - 1e-4 || repeat.start + total > window.end + 1e-4) return false;
  }
  const report = gridReport(plan.common, repeats, window.duration, window.outputFps);
  return report.visible && report.lastIsBase;
}

function revalidateZoom(project: TimelineProject): TimelineProject {
  let changed = false;
  const clips = project.clips.map((clip) => {
    if (!clip.zoomRhythm?.plan || clip.zoomRhythm.status === 'off') return clip;
    const ok = planStillFits(project, clip, clip.zoomRhythm.plan);
    const status = ok ? 'applied' as const : 'stale' as const;
    if (status === clip.zoomRhythm.status) return clip;
    changed = true;
    return { ...clip, zoomRhythm: { ...clip.zoomRhythm, status } };
  });
  return changed ? { ...project, clips } : project;
}

function retargetZoom(zoom: ClipZoomRhythm | null | undefined, oldStart: number, newStart: number, newDur: number): ClipZoomRhythm | null {
  if (!zoom?.plan) return zoom ?? null;
  const repeats = zoom.plan.repeats.map((repeat) => ({ ...repeat, start: (oldStart + repeat.start) - newStart }))
    .filter((repeat) => repeat.start >= -1e-6 && repeat.start < newDur - 1e-6);
  if (!repeats.length) return { status: 'stale', plan: zoom.plan };
  return { ...zoom, plan: { ...zoom.plan, repeats } };
}

const UNIT_BOX: NormBox = { x: 0, y: 0, width: 1, height: 1 };

function heuristicMotion(baseZoom: number): { motion: ZoomMotion; basis: ZoomProposal['basis']; maxStrength: number; room: boolean } {
  const mid = midpointStrength(baseZoom, ZOOM_MAX);
  const link = cameraLinkSeconds(UNIT_BOX, UNIT_BOX, 1, Math.max(mid.strength, 1.01));
  const motion: ZoomMotion = {
    inEase: 'smooth',
    outEase: 'smooth',
    inSec: link,
    holdSec: 1 / OBSERVED_EXPORT_FPS,
    outSec: link,
    strength: mid.strength,
  };
  return {
    motion,
    maxStrength: mid.maxStrength,
    room: mid.room,
    basis: {
      geometry: [
        'cameraLinkSeconds: 같은 상자에서 배율 로그만 사용한 기존 연결 길이',
        'ZOOM_MAX: 기존 추적 줌 상한',
        'OBSERVED_EXPORT_FPS: 내보내기 captureStream 과 같은 30',
        '경계 카메라 창과 마지막 출력 프레임을 뺀 사용 가능 구간',
      ],
      heuristic: [
        'midpoint-of-existing-zoom-cap: 추가 배율은 1과 기존 상한 사이의 가운데',
        'max-even-cycles-in-usable-span: 횟수는 그 구간을 반복 길이로 나눈 최대값',
        'hold-one-output-frame: 유지는 출력 한 프레임. 사용자 확정 길이가 아니다',
      ],
    },
  };
}

export function proposeZoomRhythm(project: TimelineProject, clipId: string, request: ZoomRequest = {}): ZoomProposal {
  const clip = project.clips.find((row) => row.id === clipId);
  const anchorForEmpty: ZoomAnchor = request.anchor ?? { kind: 'tracking', x: null, y: null };
  const empty = (status: ZoomProposal['status'], impossible: string[] | null, motion: ZoomMotion): ZoomProposal => ({
    algo: ZOOM_RHYTHM_ALGO,
    clipId,
    confirmKey: clip ? zoomKeyFor(project, clip, anchorForEmpty) : '',
    outputFps: OBSERVED_EXPORT_FPS,
    status,
    anchor: anchorForEmpty,
    requested: { count: request.count ?? null, motion },
    adjusted: null,
    basis: { geometry: [], heuristic: [] },
    impossible,
    droppedOverrideIds: [],
  });
  if (!clip) return empty('impossible', ['클립이 없습니다.'], heuristicMotion(1).motion);
  const index = project.clips.findIndex((row) => row.id === clip.id);
  const window = clipZoomWindow(project, index, clipDur(clip));
  const track = trackingUsable(clip);
  const hinted = heuristicMotion(track?.zoom ?? 1);
  let motion = resolveMotion(hinted.motion, request.motion ?? null);
  const reasons: string[] = [];
  if (!hinted.room && !(request.motion?.strength && request.motion.strength > 1)) {
    return { ...empty('impossible', ['기존 추적 줌 상한 때문에 더 확대할 여유가 없습니다.'], motion), basis: hinted.basis };
  }
  if (motion.strength > hinted.maxStrength) {
    motion = { ...motion, strength: hinted.maxStrength };
    reasons.push('요청 강도가 기존 추적 줌 상한으로 가능한 추가 배율보다 커서, 그 상한으로 줄인 조정안입니다.');
  }
  const anchor: ZoomAnchor = request.anchor ?? (track ? { kind: 'tracking', x: null, y: null } : { kind: 'user', x: null, y: null });
  if (anchor.kind === 'tracking' && !track) {
    return { ...empty('needs-anchor', ['추적 대상이 없습니다. 확대 중심을 지정해야 합니다. 화면 중앙으로 대신 고르지 않습니다.'], motion), basis: hinted.basis, anchor, confirmKey: zoomKeyFor(project, clip, anchor) };
  }
  if (anchor.kind === 'user' && (anchor.x == null || anchor.y == null || anchor.x < 0 || anchor.y < 0 || anchor.x > 1 || anchor.y > 1)) {
    return { ...empty('needs-anchor', ['확대 중심점이 없거나 원본 밖입니다.'], motion), basis: hinted.basis, anchor, confirmKey: zoomKeyFor(project, clip, anchor) };
  }
  const cycle = phaseSeconds(motion).total;
  const span = window.end - window.start;
  const count = request.count ?? Math.max(1, maxEvenCount(cycle, span));
  const fit = fitZoomRepeats({ count, motion, window });
  const previous = clip.zoomRhythm?.plan?.repeats.filter((repeat) => repeat.override) ?? [];
  const droppedOverrideIds = fit.repeats.length
    ? previous.filter((repeat) => !fit.repeats.some((next) => next.id === repeat.id)).map((repeat) => repeat.id)
    : previous.map((repeat) => repeat.id);
  if (fit.status === 'impossible') {
    return {
      ...empty('impossible', fit.impossible, motion),
      basis: hinted.basis,
      confirmKey: zoomKeyFor(project, clip, anchor),
      droppedOverrideIds,
    };
  }
  return {
    algo: ZOOM_RHYTHM_ALGO,
    clipId,
    confirmKey: zoomKeyFor(project, clip, anchor),
    outputFps: OBSERVED_EXPORT_FPS,
    status: 'preview',
    anchor,
    requested: { count: request.count ?? null, motion },
    adjusted: { count: fit.repeats.length, motion: fit.motion, repeats: fit.repeats, reasons: [...reasons, ...fit.reasons] },
    basis: hinted.basis,
    impossible: null,
    droppedOverrideIds,
  };
}

export function confirmZoomRhythm(
  project: TimelineProject,
  proposal: ZoomProposal,
  options: { acceptDrops?: boolean } = {},
): { project: TimelineProject; status: 'applied' | 'rejected'; reason: string | null; droppedOverrideIds: string[] } {
  const clip = project.clips.find((row) => row.id === proposal.clipId);
  if (!clip || proposal.status !== 'preview' || !proposal.adjusted) {
    return { project, status: 'rejected', reason: proposal.impossible?.[0] ?? '확인할 수 있는 제안이 아닙니다.', droppedOverrideIds: proposal.droppedOverrideIds };
  }
  if (proposal.confirmKey !== zoomKeyFor(project, clip, proposal.anchor)) {
    return { project, status: 'rejected', reason: '클립이나 기본 구도가 바뀌어 이전 제안을 적용할 수 없습니다. 다시 제안해 주세요.', droppedOverrideIds: [] };
  }
  if (proposal.droppedOverrideIds.length && !options.acceptDrops) {
    return { project, status: 'rejected', reason: '횟수가 바뀌며 빠지는 개별 수정이 있습니다. 내용을 확인한 뒤 적용해 주세요.', droppedOverrideIds: proposal.droppedOverrideIds };
  }
  const previous = new Map((clip.zoomRhythm?.plan?.repeats ?? []).map((repeat) => [repeat.id, repeat.override]));
  const repeats = proposal.adjusted.repeats.map((repeat) => ({ ...repeat, override: previous.get(repeat.id) ?? null }));
  const plan: ZoomRhythmPlan = {
    algo: ZOOM_RHYTHM_ALGO,
    anchor: proposal.anchor,
    common: proposal.adjusted.motion,
    repeats,
    confirmKey: proposal.confirmKey,
    outputFps: proposal.outputFps,
  };
  if (!planStillFits(project, clip, plan)) {
    return { project, status: 'rejected', reason: '조정안이 현재 클립의 마지막 프레임 복귀 조건을 만족하지 않습니다.', droppedOverrideIds: [] };
  }
  return {
    project: withClip(project, clip.id, (row) => ({ ...row, zoomRhythm: { status: 'applied', plan } })),
    status: 'applied',
    reason: null,
    droppedOverrideIds: proposal.droppedOverrideIds,
  };
}

export function clearZoomRhythm(project: TimelineProject, clipId: string): TimelineProject {
  return withClip(project, clipId, (clip) => ({ ...clip, zoomRhythm: null }));
}

export function setZoomRepeatOverride(
  project: TimelineProject,
  clipId: string,
  repeatId: string,
  override: Partial<ZoomMotion> | null,
): TimelineProject {
  const clip = project.clips.find((row) => row.id === clipId);
  if (!clip?.zoomRhythm?.plan || clip.zoomRhythm.status !== 'applied') return project;
  const repeats = clip.zoomRhythm.plan.repeats.map((repeat) => (repeat.id === repeatId ? { ...repeat, override } : repeat));
  if (!repeats.some((repeat) => repeat.id === repeatId)) return project;
  const plan = { ...clip.zoomRhythm.plan, repeats };
  const next = withClip(project, clipId, (row) => ({ ...row, zoomRhythm: { status: 'applied' as const, plan } }));
  return revalidateZoom(next);
}

export interface ZoomClipState {
  status: 'none' | 'applied' | 'stale';
  multiplier: number;
  limited: boolean;
  anchor: { kind: 'tracking' | 'user' | 'missing'; x: number | null; y: number | null; uncertain: boolean };
  repeats: Array<{ id: string; start: number; motion: ZoomMotion; hasOverride: boolean }>;
  common: ZoomMotion | null;
  window: ZoomWindow | null;
}

export function zoomClipState(project: TimelineProject, clipId: string, sourceTime: number): ZoomClipState | null {
  const clip = project.clips.find((row) => row.id === clipId);
  if (!clip) return null;
  const index = project.clips.findIndex((row) => row.id === clipId);
  const window = clipZoomWindow(project, index, clipDur(clip));
  const plan = clip.zoomRhythm?.plan ?? null;
  const local = sourceTime - clip.sourceStart;
  const point = plan ? zoomAnchorPoint(project, clip, sourceTime, plan.anchor) : null;
  const track = clip.tracking;
  const uncertain = Boolean(track && (track.status === 'uncertain' || track.points.some((p) => p.uncertain && Math.abs(p.t - sourceTime) <= UNCOVERED_HOLE_SEC)));
  const layer = sampleProject(project, layoutProject(project).clips[index]?.outputStart + Math.max(0, local) || 0).layers.find((row) => row.clipId === clipId);
  return {
    status: clip.zoomRhythm?.status === 'stale' ? 'stale' : plan && clip.zoomRhythm?.status === 'applied' ? 'applied' : 'none',
    multiplier: layer?.zoomRhythm?.multiplier ?? 1,
    limited: layer?.zoomRhythm?.limited ?? false,
    anchor: {
      kind: !plan ? 'missing' : plan.anchor.kind === 'user' ? 'user' : point ? 'tracking' : 'missing',
      x: point?.x ?? plan?.anchor.x ?? null,
      y: point?.y ?? plan?.anchor.y ?? null,
      uncertain,
    },
    repeats: (plan?.repeats ?? []).map((repeat) => ({
      id: repeat.id,
      start: repeat.start,
      motion: resolveMotion(plan!.common, repeat.override),
      hasOverride: Boolean(repeat.override),
    })),
    common: plan?.common ?? null,
    window,
  };
}

function nearestSkinSample(samples: SkinSampleRecord[], sourceTime: number): SkinSampleRecord | null {
  let best: SkinSampleRecord | null = null;
  let dist = Infinity;
  for (const sample of samples) {
    const d = Math.abs(sample.t - sourceTime);
    if (d < dist) { dist = d; best = sample; }
  }
  if (!best || dist > UNCOVERED_HOLE_SEC) return null;
  return best;
}

function retargetSkin(skin: ClipSkin, start: number, end: number): ClipSkin {
  return { ...skin, samples: skin.samples.filter((sample) => sample.t >= start - 1e-6 && sample.t < end - 1e-6) };
}

function readClipSkin(raw: unknown): ClipSkin | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const adjust = readSkinAdjust(row.adjust);
  if (row.status !== 'applied' || !adjust) return null;
  const samples = Array.isArray(row.samples) ? row.samples.flatMap((sample) => {
    if (!sample || typeof sample !== 'object') return [];
    const item = sample as SkinSampleRecord;
    if (!Number.isFinite(item.t) || !item.mask || !Array.isArray(item.mask.alpha)) return [];
    return [item];
  }) : [];
  return { status: 'applied', adjust, confirmKey: typeof row.confirmKey === 'string' ? row.confirmKey : '', samples };
}

function skinForClip(clip: TimelineClip, sourceTime: number): DrawLayer['skin'] {
  if (clip.skin?.status !== 'applied' || !clip.skin.adjust || isNeutralSkin(clip.skin.adjust)) return undefined;
  const sample = nearestSkinSample(clip.skin.samples, sourceTime);
  if (!sample || !(sample.mask.confidence > 0)) return null;
  return { adjust: clip.skin.adjust, mask: sample.mask, face: sample.face };
}

function skinConfirmValue(project: TimelineProject, clip: TimelineClip): string {
  const track = trackingUsable(clip);
  return skinKey({
    algo: SKIN_FX_ALGO,
    source: clip.sourceId,
    start: clip.sourceStart,
    end: clip.sourceEnd,
    track: track ? { job: track.jobId, seed: track.seed.sourceTimeSec } : null,
    samples: clip.skin?.samples.length ?? 0,
  });
}

/** 측정이 붙기 전의 주인공·구간. 분석이 끝나는 동안 클립이 바뀌었는지 비교한다. */
export function skinSubjectKey(project: TimelineProject, clipId: string): string | null {
  const clip = project.clips.find((row) => row.id === clipId);
  const track = clip ? trackingUsable(clip) : null;
  if (!clip || !track) return null;
  return skinKey({
    algo: SKIN_FX_ALGO,
    source: clip.sourceId,
    start: clip.sourceStart,
    end: clip.sourceEnd,
    track: { job: track.jobId, seed: track.seed.sourceTimeSec },
  });
}

/** 피부 측정 시각. 몸 추적과 같은 시각만 쓴다. 새 표본 간격을 정하지 않는다. */
export function skinAnalysisPlan(project: TimelineProject, clipId: string): {
  sourceId: string;
  stamp: string;
  frames: Array<{ t: number; face: { x: number; y: number; width: number; height: number }; uncertain: boolean }>;
} | null {
  const clip = project.clips.find((row) => row.id === clipId);
  const track = clip ? trackingUsable(clip) : null;
  const stamp = skinSubjectKey(project, clipId);
  if (!clip || !track || !stamp) return null;
  const times = [...new Set([clip.sourceStart, ...track.points.map((point) => point.t)])]
    .filter((t) => t >= clip.sourceStart - 1e-9 && t < clip.sourceEnd - 1e-9)
    .sort((a, b) => a - b);
  return {
    sourceId: clip.sourceId,
    stamp,
    frames: times.map((t) => {
      const point = track.points.find((row) => Math.abs(row.t - t) < 1e-6);
      return { t, face: point?.box ?? boxAt(track, t), uncertain: point ? point.uncertain : bodyUncertainAt(track, t) };
    }),
  };
}

export interface SkinProposal {
  algo: string;
  clipId: string;
  confirmKey: string;
  status: 'preview' | 'needs-protagonist' | 'needs-analysis' | 'impossible';
  suggested: SkinAdjust | null;
  basis: { geometry: string[]; heuristic: string[] };
  impossible: string[] | null;
}

export function proposeSkin(project: TimelineProject, clipId: string): SkinProposal {
  const clip = project.clips.find((row) => row.id === clipId);
  const blank = (status: SkinProposal['status'], impossible: string[] | null): SkinProposal => ({
    algo: SKIN_FX_ALGO,
    clipId,
    confirmKey: clip ? skinConfirmValue(project, clip) : '',
    status,
    suggested: null,
    basis: { geometry: [], heuristic: [] },
    impossible,
  });
  if (!clip) return blank('impossible', ['클립이 없습니다.']);
  if (!trackingUsable(clip)) return blank('needs-protagonist', ['주인공을 먼저 선택해 주세요. 다른 얼굴이나 화면 전체에 적용하지 않습니다.']);
  const stats = clip.skin?.samples.find((sample) => sample.stats)?.stats ?? null;
  const hinted = proposeSkinFromStats(stats);
  if (!hinted) return blank('needs-analysis', ['이 클립의 피부 측정이 없습니다. 분석을 실행한 뒤 제안할 수 있습니다.']);
  return {
    algo: SKIN_FX_ALGO,
    clipId,
    confirmKey: skinConfirmValue(project, clip),
    status: 'preview',
    suggested: hinted.adjust,
    basis: { geometry: hinted.geometry, heuristic: hinted.heuristic },
    impossible: null,
  };
}

export function confirmSkin(
  project: TimelineProject,
  proposal: SkinProposal,
  adjust: SkinAdjust,
): { project: TimelineProject; status: 'applied' | 'rejected'; reason: string | null } {
  const clip = project.clips.find((row) => row.id === proposal.clipId);
  if (!clip || proposal.status !== 'preview' || !proposal.suggested) {
    return { project, status: 'rejected', reason: proposal.impossible?.[0] ?? '확인할 수 있는 제안이 아닙니다.' };
  }
  if (proposal.confirmKey !== skinConfirmValue(project, clip)) {
    return { project, status: 'rejected', reason: '클립이나 주인공이 바뀌어 이전 제안을 적용할 수 없습니다.' };
  }
  if (!skinInRange(adjust) || !Number.isFinite(adjust.texture)) {
    return { project, status: 'rejected', reason: '피부 결·밝기·색조가 표현 범위를 벗어납니다.' };
  }
  return {
    project: withClip(project, clip.id, (row) => ({
      ...row,
      skin: { status: 'applied', adjust, confirmKey: proposal.confirmKey, samples: row.skin?.samples ?? [] },
    })),
    status: 'applied',
    reason: null,
  };
}

export function clearSkin(project: TimelineProject, clipId: string): TimelineProject {
  return withClip(project, clipId, (clip) => ({ ...clip, skin: null }));
}

/** 분석 결과만 붙인다. 보정 설정을 켜지 않는다. */
export function applySkinSamples(project: TimelineProject, clipId: string, samples: SkinSampleRecord[]): TimelineProject {
  return withClip(project, clipId, (clip) => ({
    ...clip,
    skin: {
      status: clip.skin?.status === 'applied' ? 'applied' : 'off',
      adjust: clip.skin?.adjust ?? null,
      confirmKey: clip.skin?.confirmKey ?? '',
      samples,
    },
  }));
}

export function skinCompare(project: TimelineProject, outputTime: number): { withSkin: TimelineSample; withoutSkin: TimelineSample } {
  const withSkin = sampleProject(project, outputTime);
  const withoutSkin: TimelineSample = { ...withSkin, layers: withSkin.layers.map((layer) => ({ ...layer, skin: undefined })) };
  return { withSkin, withoutSkin };
}

export interface SkinFrameState {
  phase: 'off' | 'active' | 'original';
  adjust: SkinAdjust | null;
  confidence: number;
  reason: string | null;
}

export function skinFrameState(project: TimelineProject, clipId: string, sourceTime: number): SkinFrameState | null {
  const clip = project.clips.find((row) => row.id === clipId);
  if (!clip) return null;
  if (clip.skin?.status !== 'applied' || !clip.skin.adjust) return { phase: 'off', adjust: null, confidence: 0, reason: null };
  const sample = nearestSkinSample(clip.skin.samples, sourceTime);
  if (!sample || !(sample.mask.confidence > 0)) {
    return { phase: 'original', adjust: clip.skin.adjust, confidence: 0, reason: '이 시각의 얼굴 피부를 구분할 수 없어 피부만 원본입니다.' };
  }
  return { phase: 'active', adjust: clip.skin.adjust, confidence: sample.mask.confidence, reason: null };
}

export interface ExportBlocker { code: string; clipId?: string; message: string }

export function exportBlockers(project: TimelineProject): ExportBlocker[] {
  const cached = blockerCache.get(project);
  if (cached) return cached.slice();
  const blocks: ExportBlocker[] = [];
  if (!project.clips.length) {
    blocks.push({ code: 'empty', message: '내보낼 클립이 없습니다.' });
  }
  for (const clip of project.clips) {
    const t = clip.tracking;
    if (!t) continue;
    if (t.status === 'running') {
      blocks.push({ code: 'running', clipId: clip.id, message: '추적이 끝나기 전에는 완성 영상을 만들 수 없습니다.' });
    } else if (t.status === 'uncertain') {
      blocks.push({ code: 'uncertain', clipId: clip.id, message: '추적 대상을 다시 지정하거나 이 클립의 트래킹을 해제해야 저장할 수 있습니다.' });
    } else if (t.status === 'stale') {
      blocks.push({ code: 'stale', clipId: clip.id, message: '클립이 바뀌어 이전 추적을 쓸 수 없습니다. 다시 지정하거나 해제해 주세요.' });
    } else if (t.status === 'failed') {
      blocks.push({ code: 'failed', clipId: clip.id, message: '추적이 실패했습니다. 다시 지정하거나 트래킹을 해제해 주세요.' });
    }
  }
  const layout = project.clips.length ? layoutProject(project) : null;
  for (const clip of project.clips) blocks.push(...faceBlockers(project, clip, layout));
  for (const clip of project.clips) {
    if (clip.zoomRhythm?.status === 'stale') {
      blocks.push({ code: 'zoom-rhythm-needs-confirm', clipId: clip.id, message: '줌 리듬이 지금 클립에 맞지 않습니다. 조정안을 확인하거나 효과를 해제해 주세요. 확인 없이 시간을 줄여 적용하지 않습니다.' });
    }
  }
  blockerCache.set(project, blocks);
  return blocks.slice();
}
const blockerCache = new WeakMap<TimelineProject, ExportBlocker[]>();

/**
 * 얼굴 효과 내보내기 차단. 임시저장·일반 편집은 막지 않는다.
 * - 효과를 켰는데 주인공(몸 추적)이 없거나 얼굴 분석이 이 클립을 덮지 못하면 차단.
 * - 다른 사람 가리기는 미해결 불확실 구간이 남았거나, 지금 결과로 검수되지 않은 구간이 있으면 차단.
 * 분석이 끝났다고 검수가 끝난 것이 아니다.
 */
export function faceBlockers(project: TimelineProject, clip: TimelineClip, layout: TimelineLayout | null = null): ExportBlocker[] {
  const fx = clip.faceFx;
  if (!faceFxActive(fx)) return [];
  const out: ExportBlocker[] = [];
  if (!clip.tracking) {
    out.push({ code: 'face-needs-protagonist', clipId: clip.id, message: '먼저 미리보기에서 주인공을 선택해 주세요. 얼굴 효과는 선택한 주인공을 기준으로 적용됩니다.' });
    return out;
  }
  const a = fx!.analysis;
  if (!a || a.status === 'idle') {
    out.push({ code: 'face-analysis-needed', clipId: clip.id, message: '얼굴 분석을 실행하거나 이 클립의 얼굴 효과를 해제해 주세요.' });
    return out;
  }
  if (a.status === 'running') {
    out.push({ code: 'face-analysis-running', clipId: clip.id, message: '얼굴 분석이 끝나기 전에는 완성 영상을 만들 수 없습니다.' });
    return out;
  }
  if (a.status === 'failed' || a.status === 'unsupported' || a.status === 'cancelled') {
    out.push({ code: `face-analysis-${a.status}`, clipId: clip.id, message: `${a.error ?? '얼굴 분석을 마치지 못했습니다.'} 다시 시도하거나 이 클립의 얼굴 효과를 해제해 주세요.` });
    return out;
  }
  if (!faceAnalysisUsable(clip)) {
    out.push({ code: 'face-analysis-stale', clipId: clip.id, message: '클립이 바뀌어 이전 얼굴 분석을 쓸 수 없습니다. 다시 분석하거나 효과를 해제해 주세요.' });
    return out;
  }
  if (!fx!.blur.enabled) return out;
  const scene = faceSceneOf(clip)!;
  const resFp = resolutionFingerprintFor(clip, scene);
  const uncertain = faceUncertainSegments(scene, clip.sourceStart, clip.sourceEnd, resFp);
  if (uncertain.length) {
    out.push({ code: 'face-uncertain', clipId: clip.id, message: '가리기가 불확실한 구간이 있습니다. 보정하거나 이 클립의 가리기를 해제해 주세요.' });
  }
  const holes = faceReviewHoles(project, clip.id, layout);
  if (holes.length) {
    out.push({ code: 'face-unreviewed', clipId: clip.id, message: '가리기 결과를 아직 검수하지 않은 구간이 있습니다. 확인한 뒤 검수 완료로 표시해 주세요.' });
  }
  return out;
}

const fingerprintCache = new WeakMap<TimelineProject, Map<string, string>>();

/**
 * 검수 조각의 경계. 원본 시각 FACE_HOLE_SEC 격자에 맞춘다(클립이 아니라 원본 기준).
 * 분할·트림 뒤에도 바뀌지 않은 조각은 같은 경계·같은 지문을 가져 다시 검수하지 않는다.
 */
export function faceReviewChunks(start: number, end: number): Array<{ start: number; end: number }> {
  const step = UNCOVERED_HOLE_SEC;
  const out: Array<{ start: number; end: number }> = [];
  let a = start;
  while (a < end - 1e-9) {
    const grid = (Math.floor(a / step + 1e-9) + 1) * step;
    const b = Math.min(end, grid);
    out.push({ start: a, end: b });
    a = b;
  }
  return out;
}

/** 검수 지문: 그 구간의 가림 영역·화면 구도·전환이 같으면 같은 값이다. */
export function faceReviewFingerprint(project: TimelineProject, clipId: string, start: number, end: number, layout: TimelineLayout | null = null): string {
  let cache = fingerprintCache.get(project);
  if (!cache) { cache = new Map(); fingerprintCache.set(project, cache); }
  const key = `${clipId}|${start.toFixed(5)}|${end.toFixed(5)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const value = computeReviewFingerprint(project, clipId, start, end, layout);
  cache.set(key, value);
  return value;
}

function computeReviewFingerprint(project: TimelineProject, clipId: string, start: number, end: number, layout: TimelineLayout | null): string {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return 'missing';
  const scene = faceSceneOf(clip);
  const lay = layout ?? layoutProject(project);
  const place = lay.clips.find((p) => p.clip.id === clipId);
  const times = [...new Set([start, ...(scene?.sampleTimes ?? []).filter((t) => t >= start - 1e-9 && t < end - 1e-9)])].sort((a, b) => a - b);
  const rows = times.map((t) => {
    const out = place ? place.outputStart + (t - clip.sourceStart) : null;
    const layer = out == null ? null : sampleProject(project, out).layers.find((l) => l.clipId === clipId) ?? null;
    return {
      t,
      masks: layer ? layer.faceMasks.map((m) => ({ b: m.box, o: m.origin, r: m.refId })) : masksForClip(clip, t).map((m) => ({ b: m.box, o: m.origin, r: m.refId })),
      crop: layer?.sourceRect ?? null,
      dest: layer?.destRect ?? null,
      opacity: layer?.opacity ?? null,
    };
  });
  return fingerprintOf({
    algo: FACE_FX_ALGO,
    src: clip.sourceId,
    start,
    end,
    blur: clip.faceFx?.blur.enabled ?? false,
    skin: clip.skin?.status === 'applied' ? clip.skin.adjust : null,
    rows,
  });
}

/** 지금 결과로 검수되지 않은 [start, end) 조각들. */
export function faceReviewHoles(project: TimelineProject, clipId: string, layout: TimelineLayout | null = null): Array<{ start: number; end: number }> {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.faceFx?.blur.enabled) return [];
  const lay = layout ?? layoutProject(project);
  const valid = clip.faceFx.reviews.filter((r) => r.start >= clip.sourceStart - 1e-9 && r.end <= clip.sourceEnd + 1e-9
    && r.fingerprint === faceReviewFingerprint(project, clipId, r.start, r.end, lay));
  return reviewCovers(valid, clip.sourceStart, clip.sourceEnd);
}

// ───────────────────────── 얼굴 효과 편집 동작(Undo/Redo 는 historyCommit 그대로) ─────────────────────────

export type FaceFeature = 'blur' | 'framing' | 'expression';
export type FaceApplyStatus = 'ok' | 'needs-protagonist' | 'tracking-not-ready' | 'needs-analysis' | 'missing-clip';

/** 효과를 켜거나 끈다. 다른 효과는 건드리지 않는다(S14). 분석은 시작하지 않는다(S01). */
export function setFaceFeature(project: TimelineProject, clipId: string, feature: FaceFeature, on: boolean): { project: TimelineProject; status: FaceApplyStatus } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return { project, status: 'missing-clip' };
  if (on && !clip.tracking) return { project, status: 'needs-protagonist' };
  const fx = clip.faceFx ?? emptyFaceFx();
  const next: ClipFaceFx = feature === 'blur'
    ? { ...fx, blur: { ...fx.blur, enabled: on } }
    : feature === 'framing'
      ? { ...fx, framing: { enabled: on } }
      : { ...fx, expression: { ...fx.expression, enabled: on } };
  const updated = withClip(project, clipId, (row) => ({ ...row, faceFx: next }));
  if (!on) return { project: updated, status: 'ok' };
  if (!trackingUsable(clip)) return { project: updated, status: 'tracking-not-ready' };
  return { project: updated, status: faceAnalysisUsable(clip) ? 'ok' : 'needs-analysis' };
}

/** 분석할 원본 시각. 기존 몸 추적 점의 시각(같은 간격)을 쓰고 클립 처음을 넣는다. 새 표본 간격을 정하지 않는다. */
export function faceAnalysisPlan(project: TimelineProject, clipId: string): { sourceId: string; start: number; end: number; times: number[] } | null {
  const clip = project.clips.find((c) => c.id === clipId);
  const track = clip ? trackingUsable(clip) : null;
  if (!clip || !track) return null;
  const times = [...new Set([clip.sourceStart, ...track.points.map((p) => p.t)])]
    .filter((t) => t >= clip.sourceStart - 1e-9 && t < clip.sourceEnd - 1e-9)
    .sort((a, b) => a - b);
  return { sourceId: clip.sourceId, start: clip.sourceStart, end: clip.sourceEnd, times };
}

export function beginFaceAnalysis(project: TimelineProject, clipId: string, jobId: string): TimelineProject {
  return withClip(project, clipId, (clip) => {
    const fx = clip.faceFx ?? emptyFaceFx();
    return {
      ...clip,
      faceFx: {
        ...fx,
        analysis: {
          status: 'running',
          jobId,
          sourceId: clip.sourceId,
          analyzedStart: clip.sourceStart,
          analyzedEnd: clip.sourceEnd,
          sampleTimes: [],
          detections: [],
          algo: FACE_FX_ALGO,
          error: null,
        },
      },
    };
  });
}

/**
 * 분석 결과를 넣는다. 작업 id 가 다르거나(취소·새 작업) 클립이 사라졌거나 원본·구간이 바뀌었으면 버린다.
 */
export function applyFaceAnalysis(
  project: TimelineProject,
  clipId: string,
  jobId: string,
  result: { sampleTimes: number[]; detections: FaceDetection[] },
): { project: TimelineProject; ignored: boolean } {
  const clip = project.clips.find((c) => c.id === clipId);
  const a = clip?.faceFx?.analysis;
  if (!clip || !a || a.jobId !== jobId || a.status !== 'running') return { project, ignored: true };
  if (a.sourceId !== clip.sourceId || a.analyzedStart > clip.sourceStart + 1e-4 || a.analyzedEnd < clip.sourceEnd - 1e-4) {
    return { project, ignored: true };
  }
  const inRange = (t: number) => t >= a.analyzedStart - 1e-9 && t < a.analyzedEnd + 1e-9;
  const next = withClip(project, clipId, (row) => ({
    ...row,
    faceFx: {
      ...row.faceFx!,
      analysis: {
        ...a,
        status: 'ready',
        sampleTimes: result.sampleTimes.filter(inRange).sort((x, y) => x - y),
        detections: result.detections.filter((d) => inRange(d.t)),
        error: null,
      },
    },
  }));
  return { project: next, ignored: false };
}

export function endFaceAnalysis(
  project: TimelineProject,
  clipId: string,
  jobId: string,
  status: 'failed' | 'unsupported' | 'cancelled',
  message: string,
): { project: TimelineProject; ignored: boolean } {
  const clip = project.clips.find((c) => c.id === clipId);
  const a = clip?.faceFx?.analysis;
  if (!clip || !a || a.jobId !== jobId || a.status !== 'running') return { project, ignored: true };
  return {
    project: withClip(project, clipId, (row) => ({ ...row, faceFx: { ...row.faceFx!, analysis: { ...a, status, error: message } } })),
    ignored: false,
  };
}

function withFaceFx(project: TimelineProject, clipId: string, map: (fx: ClipFaceFx, clip: TimelineClip) => ClipFaceFx): TimelineProject {
  return withClip(project, clipId, (clip) => ({ ...clip, faceFx: map(clip.faceFx ?? emptyFaceFx(), clip) }));
}

/** 놓친 얼굴 추가: 사용자가 얼굴 상자와 [start, end) 를 정한다. 범위는 클립 안으로 자른다. */
export function addManualFace(project: TimelineProject, clipId: string, id: string, start: number, end: number, key: ManualFaceKey): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const a = clamp(Math.min(start, end), clip.sourceStart, clip.sourceEnd);
  const b = clamp(Math.max(start, end), clip.sourceStart, clip.sourceEnd);
  if (b - a < MIN_CLIP_SEC) return project;
  const k = { t: clamp(key.t, a, b - MIN_CLIP_SEC), box: key.box };
  return withFaceFx(project, clipId, (fx) => ({ ...fx, blur: { ...fx.blur, manual: [...fx.blur.manual.filter((m) => m.id !== id), { id, start: a, end: b, keys: [k] }] } }));
}

/** 어긋난 지점을 다시 지정한다. 같은 시각의 기존 지정은 바꾼다. 범위 밖이면 무시한다. */
export function rekeyManualFace(project: TimelineProject, clipId: string, id: string, key: ManualFaceKey): TimelineProject {
  return withFaceFx(project, clipId, (fx) => ({
    ...fx,
    blur: {
      ...fx.blur,
      manual: fx.blur.manual.map((m) => {
        if (m.id !== id || key.t < m.start - 1e-9 || key.t >= m.end - 1e-9) return m;
        return { ...m, keys: [...m.keys.filter((k) => Math.abs(k.t - key.t) > 1e-6), key].sort((x, y) => x.t - y.t) };
      }),
    },
  }));
}

export function setManualFaceRange(project: TimelineProject, clipId: string, id: string, start: number, end: number): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const a = clamp(Math.min(start, end), clip.sourceStart, clip.sourceEnd);
  const b = clamp(Math.max(start, end), clip.sourceStart, clip.sourceEnd);
  if (b - a < MIN_CLIP_SEC) return project;
  return withFaceFx(project, clipId, (fx) => ({
    ...fx,
    blur: { ...fx.blur, manual: fx.blur.manual.map((m) => (m.id === id ? { ...m, start: a, end: b, keys: m.keys.filter((k) => k.t >= a && k.t < b) } : m)).filter((m) => m.keys.length) },
  }));
}

export function removeManualFace(project: TimelineProject, clipId: string, id: string): TimelineProject {
  return withFaceFx(project, clipId, (fx) => ({ ...fx, blur: { ...fx.blur, manual: fx.blur.manual.filter((m) => m.id !== id) } }));
}

/** 자동 후보 궤적을 가리지 않음(true)/다시 가림(false). 사용자의 명시적 선택이다. */
export function setFaceTrackKept(project: TimelineProject, clipId: string, trackId: string, keepUnblurred: boolean): TimelineProject {
  return withFaceFx(project, clipId, (fx) => {
    const rest = fx.blur.keepTrackIds.filter((id) => id !== trackId);
    return { ...fx, blur: { ...fx.blur, keepTrackIds: keepUnblurred ? [...rest, trackId] : rest } };
  });
}

/** 불확실 구간 보정. 지금 상황의 지문을 함께 남겨, 상황이 바뀌면 보정이 저절로 풀린다. */
export function resolveFaceSegment(
  project: TimelineProject,
  clipId: string,
  id: string,
  segment: { start: number; end: number; refId: string | null },
  kind: FaceResolutionKind,
): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const scene = faceSceneOf(clip);
  if (!scene) return project;
  const draft: FaceResolution = { id, start: segment.start, end: segment.end, trackId: segment.refId, kind, fingerprint: '' };
  const fingerprint = resolutionFingerprintFor(clip, scene)(draft);
  return withFaceFx(project, clipId, (fx) => ({ ...fx, resolutions: [...fx.resolutions.filter((r) => r.id !== id), { ...draft, fingerprint }] }));
}

export function removeFaceResolution(project: TimelineProject, clipId: string, id: string): TimelineProject {
  return withFaceFx(project, clipId, (fx) => ({ ...fx, resolutions: fx.resolutions.filter((r) => r.id !== id) }));
}

/**
 * 사용자가 [start, end) 결과를 보고 검수 완료로 표시한다. 미해결 불확실 구간이 남아 있으면 그 부분은 표시하지 않는다.
 * 지금 결과의 지문을 조각마다 남긴다. 이후 결과가 바뀐 조각만 다시 검수 대상이 된다.
 */
export function markFaceReviewed(project: TimelineProject, clipId: string, start: number, end: number): { project: TimelineProject; skipped: FaceUncertainSegment[] } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.faceFx?.blur.enabled) return { project, skipped: [] };
  const scene = faceSceneOf(clip);
  if (!scene) return { project, skipped: [] };
  const a = clamp(Math.min(start, end), clip.sourceStart, clip.sourceEnd);
  const b = clamp(Math.max(start, end), clip.sourceStart, clip.sourceEnd);
  const uncertain = faceUncertainSegments(scene, a, b, resolutionFingerprintFor(clip, scene));
  const layout = layoutProject(project);
  const chunks = faceReviewChunks(a, b).filter((c) => !uncertain.some((u) => u.start < c.end - 1e-9 && u.end > c.start + 1e-9));
  const fresh = chunks.map((c) => ({ ...c, fingerprint: faceReviewFingerprint(project, clipId, c.start, c.end, layout) }));
  const next = withFaceFx(project, clipId, (fx) => ({
    ...fx,
    reviews: [
      ...fx.reviews.filter((r) => !fresh.some((f) => Math.abs(f.start - r.start) < 1e-6 && Math.abs(f.end - r.end) < 1e-6)),
      ...fresh,
    ],
  }));
  return { project: next, skipped: uncertain };
}

export function setExpression(
  project: TimelineProject,
  clipId: string,
  patch: Partial<Pick<ClipFaceFx['expression'], 'zoom' | 'entryMode' | 'exitMode' | 'entrySec' | 'exitSec'>>,
): TimelineProject {
  return withFaceFx(project, clipId, (fx) => {
    const ex = fx.expression;
    const sec = (mode: 'auto' | 'manual', v: number | null | undefined, old: number | null) => {
      if (mode !== 'manual') return null;
      const value = v === undefined ? old : v;
      return value == null ? null : clamp(value, MIN_LINK_SEC, MAX_LINK_SEC);
    };
    const entryMode = patch.entryMode ?? ex.entryMode;
    const exitMode = patch.exitMode ?? ex.exitMode;
    return {
      ...fx,
      expression: {
        ...ex,
        zoom: patch.zoom == null ? ex.zoom : clamp(patch.zoom, EXPRESSION_ZOOM_MIN, EXPRESSION_ZOOM_MAX),
        entryMode,
        exitMode,
        entrySec: sec(entryMode, patch.entrySec, ex.entrySec),
        exitSec: sec(exitMode, patch.exitSec, ex.exitSec),
      },
    };
  });
}

/** 분할·트림 때 얼굴 효과를 새 구간으로 옮긴다. 분석·검수·보정은 구간 안의 것만 남기고, 지문이 맞는지는 쓸 때 다시 본다. */
function retargetFaceFx(fx: ClipFaceFx | null | undefined, start: number, end: number): ClipFaceFx | null {
  if (!fx) return null;
  const within = <T extends { start: number; end: number }>(rows: T[]) => rows.filter((r) => r.start >= start - 1e-9 && r.end <= end + 1e-9);
  return {
    ...fx,
    blur: {
      ...fx.blur,
      manual: fx.blur.manual
        .map((m) => ({ ...m, start: Math.max(m.start, start), end: Math.min(m.end, end), keys: m.keys.filter((k) => k.t >= start - 1e-9 && k.t < end - 1e-9) }))
        .filter((m) => m.end - m.start >= MIN_CLIP_SEC && m.keys.length),
    },
    resolutions: within(fx.resolutions),
    reviews: within(fx.reviews),
  };
}

export interface FaceClipState {
  clipId: string;
  sourceTime: number;
  protagonist: 'none' | 'tracking' | 'ready' | 'uncertain' | 'stale' | 'failed';
  analysis: { status: FaceAnalysis['status'] | 'none'; jobId: string | null; error: string | null; covers: boolean; samples: number; detections: number };
  features: { blur: boolean; framing: boolean; expression: boolean };
  /** 이 시각의 자동 후보(가리지 않는 주인공 포함). 역할은 신원 판정이 아니라 위치 관계다. */
  candidates: Array<{ trackId: string; box: NormBox; role: FaceTrack['points'][number]['role']; blurred: boolean; kept: boolean }>;
  masks: FaceMask[];
  uncertain: FaceUncertainSegment[];
  unreviewed: Array<{ start: number; end: number }>;
  camera: { framingActive: boolean; expressionWeight: number; faceVisibility: number; returningToBody: boolean };
  blockers: ExportBlocker[];
}

/** 편집기 화면이 그대로 읽는 클립 얼굴 상태(그리기용 데이터). 원본 시각 기준. */
export function faceClipState(project: TimelineProject, clipId: string, sourceTime: number): FaceClipState | null {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const fx = clip.faceFx ?? emptyFaceFx();
  const scene = faceSceneOf(clip);
  const resFp = scene ? resolutionFingerprintFor(clip, scene) : () => '';
  const t = clamp(sourceTime, clip.sourceStart, Math.max(clip.sourceStart, clip.sourceEnd - 1e-6));
  const masks = scene ? faceMasksAt(scene, t, resFp) : [];
  const keep = new Set(fx.blur.keepTrackIds);
  const candidates = (scene?.tracks ?? []).flatMap((track) => {
    const at = trackAt(track, t, scene!.sampleTimes);
    if (!at) return [];
    return [{ trackId: track.id, box: at.box, role: at.role, blurred: masks.some((m) => m.refId === track.id), kept: keep.has(track.id) }];
  });
  const layout = layoutProject(project);
  const index = project.clips.findIndex((c) => c.id === clipId);
  const cam = faceCameraFor(project, layout, index, t);
  const a = fx.analysis;
  return {
    clipId,
    sourceTime: t,
    protagonist: !clip.tracking ? 'none' : clip.tracking.status === 'running' ? 'tracking' : clip.tracking.status,
    analysis: {
      status: a ? a.status : 'none',
      jobId: a?.jobId ?? null,
      error: a?.error ?? null,
      covers: Boolean(faceAnalysisUsable(clip)),
      samples: a?.sampleTimes.length ?? 0,
      detections: a?.detections.length ?? 0,
    },
    features: { blur: fx.blur.enabled, framing: fx.framing.enabled, expression: fx.expression.enabled },
    candidates,
    masks,
    uncertain: scene ? faceUncertainSegments(scene, clip.sourceStart, clip.sourceEnd, resFp) : [],
    unreviewed: faceReviewHoles(project, clipId, layout),
    camera: {
      framingActive: cam.framingOn && cam.visibility > 0,
      expressionWeight: cam.weight * cam.visibility,
      faceVisibility: cam.visibility,
      returningToBody: (cam.framingOn || cam.expressionOn) && cam.visibility < 1,
    },
    blockers: faceBlockers(project, clip, layout),
  };
}

/**
 * 저장본(임시저장)을 읽을 때 쓴다. version 1 그대로이며 faceFx 칸만 검사해 붙인다.
 * 형식이 깨진 클립·원본은 null 을 돌려 기존 "다시 시작" 경로로 보낸다.
 */
export function migrateTimelineProject(raw: unknown): TimelineProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as TimelineProject;
  if (p.version !== 1 || !Array.isArray(p.clips) || !Array.isArray(p.sources)) return null;
  const clips = p.clips.map((clip) => {
    // 2·3·4단계 효과 칸을 각각 검사해 붙인다. 없거나 깨졌으면 그 효과는 없음(옛 저장본과 같음).
    const rawClip = clip as TimelineClip & { faceFx?: unknown; zoomRhythm?: unknown; skin?: unknown };
    const faceFx = readFaceFx(rawClip.faceFx);
    const zoomRhythm = readZoomRhythm(rawClip.zoomRhythm);
    const skin = readClipSkin(rawClip.skin);
    const next: TimelineClip = { ...rawClip };
    if (faceFx) next.faceFx = faceFx;
    else delete next.faceFx;
    if (zoomRhythm) next.zoomRhythm = zoomRhythm;
    else delete next.zoomRhythm;
    if (skin) next.skin = skin;
    else delete next.skin;
    return next;
  });
  return {
    ...p,
    transitions: Array.isArray(p.transitions) ? p.transitions : [],
    captions: Array.isArray(p.captions) ? p.captions : [],
    music: p.music ?? null,
    clips,
  };
}

function withClip(project: TimelineProject, clipId: string, map: (clip: TimelineClip) => TimelineClip): TimelineProject {
  return { ...project, clips: project.clips.map((c) => (c.id === clipId ? map(c) : c)) };
}

export function splitClip(project: TimelineProject, clipId: string, sourceTime: number, newClipId: string): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const fps = fpsOf(sourceById(project, clip.sourceId));
  if (sourceTime <= clip.sourceStart + 1 / fps || sourceTime >= clip.sourceEnd - 1 / fps) return project;
  const left: TimelineClip = { ...clip, sourceEnd: sourceTime };
  // 오른쪽은 기존대로 추적을 비운다. 얼굴 효과 설정은 남기되 주인공이 없으므로 다시 선택해야 내보낼 수 있다(S03).
  const right: TimelineClip = { ...clip, id: newClipId, sourceStart: sourceTime, tracking: null };
  if (clip.zoomRhythm) {
    left.zoomRhythm = retargetZoom(clip.zoomRhythm, clip.sourceStart, left.sourceStart, sourceTime - clip.sourceStart);
    right.zoomRhythm = retargetZoom(clip.zoomRhythm, clip.sourceStart, right.sourceStart, clip.sourceEnd - sourceTime);
  }
  if (clip.skin) {
    left.skin = retargetSkin(clip.skin, left.sourceStart, left.sourceEnd);
    right.skin = null;
  }
  if (clip.faceFx) {
    left.faceFx = retargetFaceFx(clip.faceFx, clip.sourceStart, sourceTime);
    right.faceFx = retargetFaceFx(clip.faceFx, sourceTime, clip.sourceEnd);
    // 진행 중이던 분석 작업은 원래 클립 id 로만 돌아온다. 새 클립에서는 끝나지 않으므로 다시 분석하게 한다.
    const ra = right.faceFx?.analysis;
    if (right.faceFx && ra?.status === 'running') right.faceFx = { ...right.faceFx, analysis: { ...ra, status: 'stale', jobId: null } };
  }
  left.tracking = retargetTracking(clip.tracking, left.sourceStart, left.sourceEnd);
  if (left.tracking && left.tracking.status !== 'stale') {
    left.tracking = { ...left.tracking, points: left.tracking.points.filter((p) => p.t >= left.sourceStart && p.t < left.sourceEnd) };
  }
  const clips = project.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]));
  const captions = project.captions.map((cap) => {
    if (cap.clipId !== clipId || cap.placement !== 'placed') return cap;
    return {
      ...cap,
      placement: 'needs-placement' as const,
      clipId: null,
      heldClipId: clipId,
    };
  });
  const transitions = project.transitions.filter((t) => t.leftClipId !== clipId && t.rightClipId !== clipId);
  return revalidateZoom({ ...project, clips, captions, transitions });
}

export function trimClip(project: TimelineProject, clipId: string, sourceStart: number, sourceEnd: number): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  const source = clip ? sourceById(project, clip.sourceId) : undefined;
  if (!clip || !source) return project;
  const fps = fpsOf(source);
  const start = clamp(sourceStart, 0, source.durationSec);
  const end = clamp(sourceEnd, 0, source.durationSec);
  if (end - start < 1 / fps) return project;
  const next = withClip(project, clipId, (row) => {
    const moved: TimelineClip = { ...row, sourceStart: start, sourceEnd: end, tracking: retargetTracking(row.tracking, start, end) };
    if (row.faceFx) moved.faceFx = retargetFaceFx(row.faceFx, start, end);
    if (row.zoomRhythm) moved.zoomRhythm = retargetZoom(row.zoomRhythm, clip.sourceStart, start, end - start);
    if (row.skin) moved.skin = retargetSkin(row.skin, start, end);
    return moved;
  });
  const captions = next.captions.flatMap((cap) => {
    if (cap.clipId !== clipId || cap.placement !== 'placed') return [cap];
    const abs0 = clip.sourceStart + cap.localStart;
    const abs1 = clip.sourceStart + cap.localEnd;
    const lo = Math.max(abs0, start);
    const hi = Math.min(abs1, end);
    if (hi - lo < 1 / fps) return [];
    return [{ ...cap, localStart: lo - start, localEnd: hi - start }];
  });
  return revalidateZoom({ ...next, captions });
}

export function deleteClip(project: TimelineProject, clipId: string): TimelineProject {
  return revalidateZoom({
    ...project,
    clips: project.clips.filter((c) => c.id !== clipId),
    transitions: project.transitions.filter((t) => t.leftClipId !== clipId && t.rightClipId !== clipId),
    captions: project.captions.filter((c) => c.clipId !== clipId && c.heldClipId !== clipId),
  });
}

export function moveClip(project: TimelineProject, clipId: string, toIndex: number): TimelineProject {
  const from = project.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return project;
  const clips = project.clips.slice();
  const [row] = clips.splice(from, 1);
  const index = clamp(toIndex, 0, clips.length);
  clips.splice(index, 0, row);
  return revalidateZoom({ ...project, clips });
}

export function beginTracking(project: TimelineProject, clipId: string, jobId: string, seed: ClipTracking['seed']): TimelineProject {
  return withClip(project, clipId, (clip) => ({
    ...clip,
    tracking: {
      status: 'running',
      jobId,
      seed,
      points: [],
      zoom: 1,
      posX: 0,
      posY: 0,
      entryMode: 'auto',
      exitMode: 'auto',
      entrySec: null,
      exitSec: null,
      analyzedStart: clip.sourceStart,
      analyzedEnd: clip.sourceEnd,
    },
  }));
}

export function applyTrackResult(
  project: TimelineProject,
  clipId: string,
  jobId: string,
  points: Array<{ t: number; box: NormBox; uncertain: boolean }>,
): { project: TimelineProject; ignored: boolean } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.tracking || clip.tracking.jobId !== jobId) return { project, ignored: true };
  const sorted = points.slice().sort((a, b) => a.t - b.t);
  const inside = sorted.filter((p) => p.t >= clip.sourceStart - 1e-4 && p.t < clip.sourceEnd + 1e-4);
  let uncertain = inside.some((p) => p.uncertain);
  if (!inside.length) uncertain = true;
  else {
    if (inside[0].t - clip.sourceStart > UNCOVERED_HOLE_SEC) uncertain = true;
    if (clip.sourceEnd - inside[inside.length - 1].t > UNCOVERED_HOLE_SEC) uncertain = true;
    for (let i = 1; i < inside.length; i += 1) {
      if (inside[i].t - inside[i - 1].t > UNCOVERED_HOLE_SEC) uncertain = true;
    }
  }
  const next = withClip(project, clipId, (row) => ({
    ...row,
    tracking: row.tracking && row.tracking.jobId === jobId ? {
      ...row.tracking,
      status: uncertain ? 'uncertain' : 'ready',
      points: inside,
      analyzedStart: clip.sourceStart,
      analyzedEnd: clip.sourceEnd,
    } : row.tracking,
  }));
  return { project: revalidateZoom(next), ignored: false };
}

/** 끝내지 못한 추적을 시작 전 결과로 되돌린다. 그 사이 클립이 바뀌었으면 기존 규칙대로 다시 맞춘다. */
export function restoreTracking(project: TimelineProject, clipId: string, previous: ClipTracking | null): TimelineProject {
  return revalidateZoom(withClip(project, clipId, (clip) => ({
    ...clip,
    tracking: previous ? retargetTracking(previous, clip.sourceStart, clip.sourceEnd) : null,
  })));
}

export function clearTracking(project: TimelineProject, clipId: string): TimelineProject {
  return revalidateZoom(withClip(project, clipId, (clip) => ({ ...clip, tracking: null })));
}

export function setFraming(
  project: TimelineProject,
  clipId: string,
  patch: Partial<Pick<ClipTracking, 'zoom' | 'posX' | 'posY'>>,
): TimelineProject {
  return withClip(project, clipId, (clip) => {
    if (!clip.tracking) return clip;
    const zoom = patch.zoom == null ? clip.tracking.zoom : clamp(patch.zoom, ZOOM_MIN, ZOOM_MAX);
    const posX = patch.posX == null ? clip.tracking.posX : clamp(patch.posX, -1, 1);
    const posY = patch.posY == null ? clip.tracking.posY : clamp(patch.posY, -1, 1);
    return { ...clip, tracking: { ...clip.tracking, zoom, posX, posY } };
  });
}

export function setLinkControl(
  project: TimelineProject,
  clipId: string,
  edge: 'entry' | 'exit',
  mode: 'auto' | 'manual',
  sec: number | null,
): TimelineProject {
  return withClip(project, clipId, (clip) => {
    if (!clip.tracking) return clip;
    const value = mode === 'manual' && sec != null ? clamp(sec, MIN_LINK_SEC, MAX_LINK_SEC) : null;
    if (edge === 'entry') return { ...clip, tracking: { ...clip.tracking, entryMode: mode, entrySec: value } };
    return { ...clip, tracking: { ...clip.tracking, exitMode: mode, exitSec: value } };
  });
}

export function addTransition(
  project: TimelineProject,
  leftClipId: string,
  rightClipId: string,
  kind: TransitionKind,
  id: string,
  requestedSec = DEFAULT_TEMPLATE_SEC,
): TimelineProject {
  const index = project.clips.findIndex((c) => c.id === leftClipId);
  const right = project.clips[index + 1];
  if (!right || right.id !== rightClipId) return project;
  const rest = project.transitions.filter((t) => !(t.leftClipId === leftClipId && t.rightClipId === rightClipId));
  return {
    ...project,
    transitions: [...rest, {
      id,
      leftClipId,
      rightClipId,
      kind,
      requestedSec: Math.max(0, requestedSec),
      audioCrossfade: true,
    }],
  };
}

export function updateTransition(
  project: TimelineProject,
  id: string,
  patch: Partial<Pick<TimelineTransition, 'kind' | 'requestedSec' | 'audioCrossfade'>>,
): TimelineProject {
  return {
    ...project,
    transitions: project.transitions.map((t) => (t.id === id ? {
      ...t,
      ...patch,
      requestedSec: patch.requestedSec == null ? t.requestedSec : Math.max(0, patch.requestedSec),
    } : t)),
  };
}

export function deleteTransition(project: TimelineProject, id: string): TimelineProject {
  return { ...project, transitions: project.transitions.filter((t) => t.id !== id) };
}

function clampCaption(clip: TimelineClip, localStart: number, localEnd: number): { localStart: number; localEnd: number } | null {
  const dur = clipDur(clip);
  const start = clamp(localStart, 0, dur);
  const end = clamp(localEnd, 0, dur);
  if (end - start < MIN_CLIP_SEC) return null;
  return { localStart: start, localEnd: end };
}

export function addCaption(
  project: TimelineProject,
  clipId: string,
  id: string,
  text: string,
  localStart: number,
  localEnd: number,
): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const range = clampCaption(clip, localStart, localEnd);
  if (!range) return project;
  const cap: TimelineCaption = {
    id, clipId, text, placement: 'placed', heldClipId: null, style: {}, ...range,
  };
  return { ...project, captions: [...project.captions, cap] };
}

export function updateCaption(
  project: TimelineProject,
  id: string,
  patch: Partial<Pick<TimelineCaption, 'text' | 'localStart' | 'localEnd' | 'style'>>,
): TimelineProject {
  return {
    ...project,
    captions: project.captions.map((cap) => {
      if (cap.id !== id) return cap;
      const clip = cap.clipId ? project.clips.find((c) => c.id === cap.clipId) : undefined;
      let localStart = patch.localStart ?? cap.localStart;
      let localEnd = patch.localEnd ?? cap.localEnd;
      if (clip && cap.placement === 'placed') {
        const range = clampCaption(clip, localStart, localEnd);
        if (!range) return cap;
        localStart = range.localStart;
        localEnd = range.localEnd;
      }
      return {
        ...cap,
        text: patch.text ?? cap.text,
        localStart,
        localEnd,
        style: patch.style ? { ...cap.style, ...patch.style } : cap.style,
      };
    }),
  };
}

export function deleteCaption(project: TimelineProject, id: string): TimelineProject {
  return { ...project, captions: project.captions.filter((c) => c.id !== id) };
}

export function placeCaption(
  project: TimelineProject,
  captionId: string,
  clipId: string,
  localStart: number,
  localEnd: number,
): TimelineProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const range = clampCaption(clip, localStart, localEnd);
  if (!range) return project;
  return {
    ...project,
    captions: project.captions.map((cap) => (cap.id === captionId ? {
      ...cap,
      clipId,
      placement: 'placed' as const,
      heldClipId: null,
      ...range,
    } : cap)),
  };
}

export function waveformPeaks(samples: Float32Array, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Array<number>(n).fill(0);
  if (!samples.length) return out;
  const span = samples.length / n;
  for (let i = 0; i < n; i += 1) {
    const a = Math.floor(i * span);
    const b = Math.max(a + 1, Math.floor((i + 1) * span));
    let peak = 0;
    for (let k = a; k < b && k < samples.length; k += 1) peak = Math.max(peak, Math.abs(samples[k]));
    out[i] = peak;
  }
  return out;
}

export interface MixInput {
  project: TimelineProject;
  channels: Array<{ sourceId: string; samples: Float32Array; sampleRate: number }>;
  music?: { samples: Float32Array; sampleRate: number; startSec: number; volume: number; fromSec: number; toSec: number | null } | null;
  outRate: number;
}

export interface MixResult { samples: Float32Array; peak: number; limited: boolean; durationSec: number }

function sampleChannel(samples: Float32Array, rate: number, time: number): number {
  if (!samples.length || time < 0) return 0;
  const idx = time * rate;
  if (idx >= samples.length - 1) return 0;
  const i = Math.floor(idx);
  const f = idx - i;
  return samples[i] * (1 - f) + samples[i + 1] * f;
}

export function mixOutputAudio(input: MixInput): MixResult {
  const layout = layoutProject(input.project);
  const durationSec = layout.totalSec;
  const rate = input.outRate > 0 ? input.outRate : 48000;
  const count = Math.max(1, Math.round(durationSec * rate));
  const out = new Float32Array(count);
  const byId = new Map(input.channels.map((c) => [c.sourceId, c]));
  const step = durationSec <= 0 ? 0 : durationSec / count;
  for (let i = 0; i < count; i += 1) {
    const t = i / rate;
    const sample = sampleProject(input.project, Math.min(t, Math.max(0, durationSec - step / 2)));
    let sum = 0;
    for (const layer of sample.audio) {
      const ch = byId.get(layer.sourceId);
      if (!ch || !ch.samples.length) continue;
      sum += layer.gain * sampleChannel(ch.samples, ch.sampleRate, layer.sourceTime);
    }
    const music = input.music;
    if (music && music.volume > 0) {
      const from = music.fromSec;
      const to = music.toSec == null ? durationSec : music.toSec;
      if (t >= from && t < to) {
        const at = music.startSec + (t - from);
        sum += music.volume * sampleChannel(music.samples, music.sampleRate, at);
      }
    }
    out[i] = sum;
  }
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  let limited = false;
  if (peak > 1) {
    limited = true;
    const scale = 1 / peak;
    for (let i = 0; i < out.length; i += 1) out[i] *= scale;
    peak = 1;
  }
  return { samples: out, peak, limited, durationSec };
}

export function historyOf<T>(present: T): EditHistory<T> {
  return { past: [], present, future: [] };
}

export function historyCommit<T>(history: EditHistory<T>, next: T): EditHistory<T> {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function historyUndo<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.past.length) return history;
  const present = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] };
}

export function historyRedo<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.future.length) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present, future };
}
