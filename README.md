<p align="center">
  <img src="assets/hilit-tec-banner.jpg" alt="AI Tec — Built for Real Work, Not Just Demos" width="100%">
</p>

# HILiT Camera Mov

**영상 속 한 사람을 따라가는 세로 크롭 카메라 기술입니다.** 사람이 직접 찍은 직캠처럼 대상을 화면 안에 두면서, 흔들림과 튐이 적은 카메라 경로를 만듭니다. 웹과 Android 코드, 카메라워크를 수치로 재는 도구, 박자에 맞춘 숏 전환 실험을 담았습니다.

> **비상업적 이용만 무료입니다.** 상업적으로 쓰려면 먼저 저작자의 서면 승인을 받아야 합니다: **ccw00325@gmail.com**
>
> 사용하거나 공개할 때는 **HILiT Camera Mov**, **조찬우 (Chanwoo Cho)**, **https://github.com/ccw00325-spec/HILiT_camera_mov** 를 꼭 표시해 주세요. 자세한 조건은 [`LICENSE`](LICENSE) 에 있습니다.

## 어떤 기술인가

| 기술 | 하는 일 | 코드 |
|---|---|---|
| 따라가기 카메라 | 추적 궤적을 받아 프레임마다 크롭 창을 정합니다 | `runtime/packages/tracking-core/src/follow-camera.ts`, `follow-plan.ts` |
| 놓침 붙잡기 | 대상을 놓친 동안 화면이 튀지 않게 카메라를 붙잡습니다 | `trajectory.ts`, `follow-camera.ts` |
| 경로 평활 | 저장할 때는 궤적 전체를 미리 보고 앞뒤 대칭으로 다듬어 늦게 따라가지 않습니다 | `follow-camera.ts`, `one-euro.ts` |
| 줌 리듬 | 반복 줌의 시간과 강도를 계산합니다 | `runtime/apps/web/src/lib/zoom-rhythm.ts` |
| 화질 보정 | 확대 샤프닝과 HDR 톤매핑 | `enhance.ts`, `hdr-tonemap.ts` |
| Android 내보내기 | 같은 카메라 규칙을 Android에서 씁니다 | `runtime/apps/android/` |
| **실험(제품 미적용)** | 움직임 앞서 다듬기, 박자 찾기, 숏 전환 제안과 부드러운 전환 | `lab/` |
| 측정 | 가속, 저크, 튐, 포함률, 시차와 A/B 비교, 값 찾기 | `eval/` |

사람 검색이나 신원 확인 기술이 아닙니다. 대상을 몰래 추적하거나 식별하는 데 쓸 수 없습니다.

## 바로 해 보기

Node.js 24 이상이면 설치할 것이 없습니다.

```bash
npm test                    # 표시, 공개 안전, 실험 코드, 측정 도구, 기준값 검사
npm run ab                  # 제품 카메라(A)와 앞서 다듬기(B)를 비교
npm run tune                # 대상 포함률을 지키는 값 찾기
```

## 측정 결과 (합성 궤적)

아래는 도형 궤적으로 잰 값입니다. **실제 영상의 품질이나 시청감이 아닙니다.** 값이 작을수록 부드럽습니다. B는 제품에 넣지 않았습니다.

| 장면 | 가속 P95 (A→B) | 저크 P95 (A→B) | 포함률 % (A→B) |
|---|---:|---:|---:|
| 걷다 멈추기 | 0.648 → 0.247 | 20.2 → 5.8 | 100 → 100 |
| 무대 조명 잡음 | 1.704 → 1.521 | 55.7 → 49.6 | 100 → 100 |
| 놓친 뒤 다시 잡기 | 0.295 → 0.195 | 11.6 → 5.3 | 79.0 → 79.0 |
| 갑작스러운 방향 전환 | 6.642 → 6.680 | 181.8 → 178.2 | 100 → 100 |
| 박자 안무 | 36.02 → 36.71 | 1071 → 1100 | 99.8 → 100 |
| 질주 | 5.159 → 5.454 | 155.0 → 158.8 | 98.8 → 98.8 |

- 느린 움직임과 잡음에서는 효과가 큽니다. 빠른 안무와 질주에서는 대상을 놓치지 않으려고 일부러 거의 손대지 않아 이득이 없습니다.
- 고정 강도로 다듬으면 질주 장면의 포함률이 98.8%에서 88.8%로 떨어졌습니다. 그래서 속도에 따라 강도를 줄입니다.
- 제품 카메라는 저장 때 궤적 전체를 미리 보기 때문에 합성 궤적에서 대상과의 시차가 거의 0초였습니다. 값 찾기에서도 앞당기기(lead)를 더해 얻는 이득은 확인되지 않았습니다.

## 실험 도구

| 도구 | 내용 | 한계 |
|---|---|---|
| `lab/lookahead.mjs` | 순간 튐 제거, 멈춤과 전환 찾기, 속도에 맞춘 시차 없는 평활 | 제품 미적용 |
| `lab/beats.mjs` | 오디오에서 빠르기와 박자를 찾습니다. 박자가 뚜렷하지 않으면 맞추지 않습니다 | 합성 클릭음으로만 시험했습니다. 실제 음악 정확도는 재지 않았습니다 |
| `lab/shot-rhythm.mjs` | 멈춤과 박자에 맞춘 전환 제안, 부드러운 크롭 전환과 번짐 정도 | 합성 예에서 프레임당 최대 변화 1.51 → 0.18. 시청 피로는 재지 않았습니다 |
| `eval/measure-path.mjs` | 사람이 편집한 크롭 경로를 같은 기준으로 잽니다 | 아직 사람 편집 기준값이 없습니다 |
| `eval/tune.mjs --reference` | 사람이 편집한 수치 범위에 가까운 값을 찾습니다 | 기준값을 넣어야 합니다 |

내 궤적으로 재려면 `eval/camera-smoothness.mjs` 를 씁니다. 지표는 추적 상자 기준이라 추적 정확도를 뜻하지 않습니다.

## 이용 조건 요약

| 이용 | 가능 여부 |
|---|---|
| 개인 학습, 취미, 교육, 비영리 연구, 비상업적 평가 | 가능. 출처 표시 필수 |
| 유료 제품, 수익 서비스, 영리 조직의 내부 사용, 고객 용역 | 사전 서면 승인 필수 |
| 이 기술로 만든 영상의 판매나 수익 활동, 이 코드를 참고한 상업 제품 개발 | 사전 서면 승인 필수 |
| 모델 학습 자료로 사용 | 사전 서면 승인 필수 |
| 지문, 저작권 표시, `NOTICE` 삭제, 몰래 추적, 신원 식별 | 금지 |

소스 공개 라이선스이며, OSI가 정의한 오픈소스 라이선스는 아닙니다. 신청 방법은 [상업적 이용 신청](docs/COMMERCIAL_LICENSING.md) 에 있고, [기술 보호](docs/PROTECTION.md) 와 [제3자 고지](THIRD_PARTY_NOTICES.md) 도 함께 봐 주세요.

## 구성과 한계

`runtime/` 은 비공개 제품 정본에서 뽑은 사본이라 직접 고치지 않습니다. 제품 화면과 저장 흐름, 추적 코드, 시험 영상은 없어서 이 저장소만으로 완성된 앱이 되지는 않습니다. 추적 코드는 [HILiT Tracking Tec](https://github.com/ccw00325-spec/HILiT_Tracking_Tec) 에 있습니다.

## English

HILiT Camera Mov computes a smooth portrait crop path that follows one selected person through a video, with web and Android code, camera-motion metrics, and experiments for beat-aligned shot changes. **Free for noncommercial use only. Commercial use requires prior written approval from the author: ccw00325@gmail.com.** You must credit **HILiT Camera Mov**, **조찬우 (Chanwoo Cho)**, and **https://github.com/ccw00325-spec/HILiT_camera_mov** whenever you use or publish it. See [`LICENSE`](LICENSE). This is a source-available license, not an OSI open source license. Results above are from synthetic trajectories, not real footage.
