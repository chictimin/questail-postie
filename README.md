# questail-postie

게임 라이브러리 기반 개인화 뉴스레터 에이전트.
Steam 위시리스트·최근 플레이 게임의 소식을 수집·선별·요약·검수해 Discord로 매일 발행한다.
TypeScript + LangGraph.js + pnpm.

## 빠른 시작

```sh
pnpm install
cp audience.sample.yaml audience.yaml   # 개인 설정 (git 추적 제외)
pnpm sniff               # 대화형 설정: LLM 프로바이더 + SteamID + Discord 웹훅
pnpm start --dry-run     # 수집·선별까지만 확인 (파일 기록·발행 없음)
pnpm start               # 전체 실행
```

점검용:

```sh
pnpm typecheck      # tsc --noEmit
pnpm check:select    # 선별 로직 픽스처 검증
pnpm check:tiers     # 티어·증분·할인 기준 픽스처 + 실환경 티어 확정 검증
```

## LLM 프로바이더 전환

이 프로젝트의 설계 포인트다. 요약·브리핑·번역은 전부 OpenAI 호환 엔드포인트로 나가며,
`pnpm sniff`에서 고르면 `.env`에 저장된다.

- 로컬(Ollama·LM Studio): `OPENAI_BASE_URL=http://localhost:11434/v1`, `MODEL=qwen3:8b`,
  **API 키 불필요** — 빈 값으로 둔다. 키가 없어도 로컬 엔드포인트면 호출한다.
- 유료 API: `OPENAI_BASE_URL=https://api.openai.com/v1` + `OPENAI_API_KEY`에 키.
- 키가 없고 원격 엔드포인트면 **절취 폴백**(원문 앞문장 그대로)으로 파이프라인이 멈추지 않고
  끝까지 돈다. 번역 없이 원어로 발행되고, 발행물에 `(원문 요약)` 표기가 붙는다.

## Steam 연동

SteamID 하나만 등록하면 보유 게임·위시리스트·최근 30일 플레이를 자동으로 가져온다.
appId를 손으로 넣지 않는다. Steam 키(`STEAM_API_KEY`·`STEAM_ID`)는
전역 `~/.config/questail/.env`에 저장되고 저장소에는 들어가지 않는다
(`XDG_CONFIG_HOME`이 있으면 그 아래). 수집 자체(Steam AppNews 공개 API·RSS)에는 키가 필요 없다.

## 설정 파일

- `audience.sample.yaml` — 저장소 커밋용 샘플. 처음 클론했으면 `audience.yaml`로 복사해서 쓴다.
- `audience.yaml` — 개인 설정이라 gitignore 대상. 플랫폼·장르·제외어·선별 가중치·배치 크기를 둔다.
  라이브러리·위시리스트 appId는 적지 않는다(런타임에 SteamID로 자동 확정).
- `.env` — LLM·Discord 설정. 역시 gitignore 대상.

## 구조 한눈에

| 파일 | 한 줄 |
| --- | --- |
| `src/graph.ts` | LangGraph 파이프라인 배선 (아래 흐름) |
| `src/run.ts` | 실행 스크립트 (`--dry-run`·`--help`) |
| `src/collect/tiers.ts` | Steam 티어 수집 (위시 전수·최근 플레이·seen 증분·할인 감시) |
| `src/collect/steam.ts` | Steam AppNews·Store 메타 조회 |
| `src/collect/rss.ts` | RSS 수집 |
| `src/steamid.ts` | SteamID → 보유 게임·최근 플레이 확정 |
| `src/personalize.ts` | 게임명 인덱스 구축 (한글명 포함) |
| `src/select.ts` | 예선·본선 2단계 선별 |
| `src/summarize.ts` | 원어 요약 (영어 원문은 영어로) |
| `src/verify.ts` | 검수·환각 대조 (제목 토큰·연도/날짜·길이, 실패 시 1회 재생성) |
| `src/digest.ts` | 브리핑 (원어, 평문) |
| `src/translate.ts` | 발행 직전 한국어 번역 (항목별 호출, 실패분은 원어 발행) |
| `src/publish.ts` | md 저장 + Discord 발행 |
| `src/llmLocal.ts` | 로컬/원격 판정·`<think>` 전처리·폴백 로그 (summarize·digest·translate 공유) |
| `src/sniff.ts` | 대화형 설정 (LLM·Steam·웹훅) |
| `src/types.ts` | 공유 타입 계약 |
| `src/globalConfig.ts` | 전역 설정 읽기·쓰기 |
| `scripts/check-select.ts` | 선별 로직 검증 |
| `scripts/check-tiers.ts` | 티어·증분·할인 검증 |
| `store/metrics.jsonl` | 실행·검수 기록 (커밋 대상. 명세의 실행 기록 제출용 샘플 1회분) |
| `output/latest.md` | 최신 발행물 (커밋 대상, 매 실행 덮어씀) |
| `REPORT.md` | 설계 근거·실행 기록 보고서 |

## 파이프라인 흐름

```text
collect → personalize → filter → rank → summarize → verify → briefing → translate → publish
```

원어로 요약·검수까지 마친 뒤 발행 직전에 한국어로 번역한다.
자세한 설계 근거(소스 채택표·선별 로직·실행 기록·회고)는 `REPORT.md`를 본다.

## 주의

- `pnpm start`는 `output/latest.md`를 **덮어쓰고** `DISCORD_WEBHOOK_URL`이 있으면
  Discord로 **실제 발행**한다. 확인만 할 거면 `pnpm start --dry-run`.
