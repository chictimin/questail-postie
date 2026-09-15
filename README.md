# questail-postie

게임 라이브러리 기반 개인화 뉴스레터 에이전트. TypeScript + LangGraph.js + pnpm.

## 실행

```sh
pnpm install
pnpm sniff   # BYOK 대화형 설정 (키·웹훅을 .env에 저장)
pnpm start
```

## 구조

- `src/graph.ts` — LangGraph 워크플로우 (collect → filter → rank → summarize → verify → publish)
- `src/run.ts` — 실행 스크립트
- `src/collect/` — 수집 (Steam AppNews 공개 API + RSS)
- `src/select.ts` — 예선/본선 2단계 선별
- `src/summarize.ts` — LLM 한국어 요약·번역
- `src/verify.ts` — 자동 검수 및 예외 처리
- `src/publish.ts` — 디스코드 웹훅 + md 백업
- `audience.yaml` — 독자·가중치·제외조건 설정
- `store/metrics.jsonl` — 실행·검수 기록
