/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·c0b76a5f @license @preserve */
package app.hilit.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 따라가기 카메라가 겨눌 상자를 사람 검출로 다듬는다 — 2026-09-28, 웹 정본
 * packages/tracking-core/src/follow-refine.ts 를 그대로 옮긴 것(상수·규칙 같음, FollowRefineTest 가 숫자로 대조).
 *
 * 추적 상자가 몸 일부만 잡거나 옆으로 밀린 순간, 0.5초마다 찾은 사람 상자(NativePersonDetector,
 * EfficientDet-Lite0 · LiteRT, 둘 다 Apache-2.0) 쪽으로 카메라용 상자만 옮긴다.
 *
 * 재획득·신원 판정이 아니다.
 *  - 그 시각 추적 상자와 IoU ≥ iouMin 으로 겹치는 사람만 본다. 겹치지 않는 사람으로는 옮기지 않는다.
 *  - 가장 잘 겹치는 상자가 두 번째보다 ambiguity 이상 분명할 때만 받는다.
 *  - 받은 차이를 앞뒤 reachSec 안에서 이어 붙이고, 멀어질수록 0 으로 줄인다. 중심 이동은 몸 높이의 maxShiftBodies 배까지.
 *  - 놓침·재획득·사용자 확인 대기·빈 상자는 건드리지 않는다.
 * 결과는 카메라(미리보기·저장본)에만 쓴다. 추적 결과는 그대로다. JVM 에서 시험한다(안드로이드 의존 없음).
 */
final class FollowRefine {
    private FollowRefine() {}

    static final double IOU_MIN = 0.35, SCORE_MIN = 0.3, AMBIGUITY = 0.15, REACH_SEC = 0.75,
            BLEND = 0.8, MAX_SHIFT_BODIES = 0.6, PAIR_SEC = 0.3;
    /** 사람 상자를 찾을 간격(초). 웹의 presence-check 와 같다. */
    static final double INTERVAL_SEC = 0.5;

    static final class Person {
        final float x, y, w, h, score;
        Person(float x, float y, float w, float h, float score) { this.x = x; this.y = y; this.w = w; this.h = h; this.score = score; }
    }

    static final class Sample {
        final double time;
        /** 그 프레임의 사람 상자(정규화). 검출기를 못 쓴 프레임은 null. */
        final List<Person> people;
        Sample(double time, List<Person> people) { this.time = time; this.people = people; }
    }

    static final class Correction {
        final double time, dx, dy, lw, lh;
        Correction(double time, double dx, double dy, double lw, double lh) {
            this.time = time; this.dx = dx; this.dy = dy; this.lw = lw; this.lh = lh;
        }
    }

    static boolean usable(NativeTrackingEngine.Point p) {
        String s = p.state == null ? "" : p.state;
        return !"TARGET_LOST".equals(s) && !"REACQUIRING".equals(s) && NativeFollowCamera.isReliable(p)
                && p.box.w > 0.002f && p.box.h > 0.002f;
    }

    private static double iou(NativeTrackingEngine.Box a, Person b) {
        double w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        double h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        double inter = w * h;
        double union = (double) a.w * a.h + (double) b.w * b.h - inter;
        return union > 0 ? inter / union : 0;
    }

    static List<Correction> corrections(List<NativeTrackingEngine.Point> points, List<Sample> samples) {
        List<Correction> out = new ArrayList<>();
        for (Sample s : samples) {
            if (s.people == null || s.people.isEmpty()) continue;
            NativeTrackingEngine.Point near = null;
            double gap = Double.POSITIVE_INFINITY;
            for (NativeTrackingEngine.Point p : points) {
                double d = Math.abs(p.timestamp - s.time);
                if (d < gap) { gap = d; near = p; }
            }
            if (near == null || gap > PAIR_SEC || !usable(near)) continue;
            double best = -1, second = -1;
            Person bestPerson = null;
            for (Person person : s.people) {
                if (person.score < SCORE_MIN) continue;
                double o = iou(near.box, person);
                if (o > best) { second = best; best = o; bestPerson = person; }
                else if (o > second) second = o;
            }
            if (bestPerson == null || best < IOU_MIN) continue;
            if (second >= 0 && best - second < AMBIGUITY) continue;
            NativeTrackingEngine.Box t = near.box;
            double dx = (bestPerson.x + bestPerson.w / 2.0) - (t.x + t.w / 2.0);
            double dy = (bestPerson.y + bestPerson.h / 2.0) - (t.y + t.h / 2.0);
            if (Math.hypot(dx, dy) > MAX_SHIFT_BODIES * t.h) continue;
            out.add(new Correction(s.time, dx, dy, Math.log((double) bestPerson.w / t.w), Math.log((double) bestPerson.h / t.h)));
        }
        Collections.sort(out, (a, b) -> Double.compare(a.time, b.time));
        return out;
    }

    /** 카메라용 경로. 받아들인 차이가 없으면 같은 목록을 그대로 돌려준다. */
    static List<NativeTrackingEngine.Point> refine(List<NativeTrackingEngine.Point> points, List<Sample> samples) {
        List<Correction> fixes = corrections(points, samples);
        if (fixes.isEmpty()) return points;
        List<NativeTrackingEngine.Point> out = new ArrayList<>(points.size());
        for (NativeTrackingEngine.Point p : points) {
            if (!usable(p)) { out.add(p); continue; }
            Correction prev = null, next = null;
            for (Correction f : fixes) {
                if (f.time <= p.timestamp) prev = f;
                else { next = f; break; }
            }
            Correction a = prev != null && Math.abs(prev.time - p.timestamp) <= REACH_SEC ? prev : null;
            Correction b = next != null && Math.abs(next.time - p.timestamp) <= REACH_SEC ? next : null;
            if (a == null && b == null) { out.add(p); continue; }
            double dx, dy, lw, lh, weight;
            if (a != null && b != null) {
                double k = (p.timestamp - a.time) / Math.max(1e-6, b.time - a.time);
                dx = a.dx + (b.dx - a.dx) * k; dy = a.dy + (b.dy - a.dy) * k;
                lw = a.lw + (b.lw - a.lw) * k; lh = a.lh + (b.lh - a.lh) * k;
                weight = 1;
            } else {
                Correction f = a != null ? a : b;
                dx = f.dx; dy = f.dy; lw = f.lw; lh = f.lh;
                weight = 1 - Math.abs(f.time - p.timestamp) / REACH_SEC;
            }
            double g = BLEND * Math.max(0, Math.min(1, weight));
            double w = p.box.w * Math.exp(g * lw);
            double h = p.box.h * Math.exp(g * lh);
            double cx = p.box.x + p.box.w / 2.0 + g * dx;
            double cy = p.box.y + p.box.h / 2.0 + g * dy;
            double x = Math.max(0, Math.min(1 - w, cx - w / 2));
            double y = Math.max(0, Math.min(1 - h, cy - h / 2));
            NativeTrackingEngine.Box box = new NativeTrackingEngine.Box((float) x, (float) y, (float) Math.min(1, w), (float) Math.min(1, h));
            out.add(new NativeTrackingEngine.Point(p.timestamp, box, p.health, p.reid, p.confidence, p.state, p.identityLifecycle));
        }
        return out;
    }

    /** 사람 상자를 찾을 시각들 — 궤적 처음부터 끝까지 INTERVAL_SEC 간격. */
    static List<Double> sampleTimes(List<NativeTrackingEngine.Point> points) {
        List<Double> out = new ArrayList<>();
        if (points.isEmpty()) return out;
        double start = points.get(0).timestamp, end = points.get(points.size() - 1).timestamp;
        for (double t = start; t <= end + 1e-6; t += INTERVAL_SEC) out.add(t);
        return out;
    }
}
