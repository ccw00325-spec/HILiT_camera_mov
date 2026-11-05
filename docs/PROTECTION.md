# 기술 보호와 도용 탐지

공개 코드는 기술적으로 복사를 막을 수 없습니다. 그래서 **허락 범위를 정하고, 복사되면 찾아내는** 구조를 씁니다.

| 층 | 방식 | 할 수 있는 것 | 할 수 없는 것 |
|---|---|---|---|
| 라이선스 | 비상업 허락, 상업 사전 승인, 출처 표시, 표시 삭제와 우회 금지, 파생물 동일 조건 | 위반 시 법적 근거 | 위반 자체를 막지는 못함 |
| 파일 지문 | 파일마다 다른 `HILiT-PUB-2026·CW·…` | 어느 파일에서 왔는지 특정 | 지우면 사라짐. 삭제 자체가 라이선스 위반 |
| 코드 지문 | 주석, 공백, 지역 이름과 무관한 조각 비교 | 표시를 지운 사본의 단서를 찾음 | 다른 언어로 옮기거나 새로 구현한 코드는 못 찾음 |
| 학습 권리 유보 | `LICENSE` 9항, `ai.txt` | 유보 의사를 표시 | 법적 효과는 나라마다 다르고, 플랫폼 약관이 허용한 범위는 막지 못함 |
| 감시 | `watch-copies` 워크플로, `tools/watch-github.mjs` | 지문이 든 공개 코드와 새 포크 발견 | GitHub 밖이나 서버 안에서만 도는 코드는 못 봄 |

의심되는 사이트나 파일은 직접 검사합니다.

```bash
node tools/detect-copy.mjs https://의심되는-사이트.example
node tools/detect-copy.mjs <받아 둔 폴더>
```

실행될 때 저작자 서버로 위치를 몰래 알리는 코드는 넣지 않았습니다. 이용자 개인정보를 동의 없이 보내게 되고, 공개 코드라 쉽게 지울 수도 있기 때문입니다.

코드 지문의 일치 비율은 단서입니다. 일치한다는 사실만으로 침해가 확정되지는 않습니다. 위반을 발견하면 주소와 탐지 결과를 저장하고 `LICENSE` 15항에 따라 통지합니다. GitHub 게시물은 DMCA 절차로 삭제를 요청할 수 있습니다.

## English

Public code cannot be technically copy-proof. Protection relies on license terms, per-file fingerprints, a code-similarity index, and scheduled monitoring. There is no hidden phone-home. Similarity results are leads, not proof of infringement.
