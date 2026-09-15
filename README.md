# questail-postie

게임 라이브러리 기반 개인화 뉴스레터 에이전트.
Steam 위시리스트·최근 플레이 게임의 소식을 수집·선별·요약·검수해 Discord로 매일 발행한다.
TypeScript + LangGraph.js + pnpm.

## 사전 요구사항

- Node.js — `package.json`에 engines 지정 없음. `@types/node` 22 기준, 실측 동작 환경 `v24.18.0`.
  LTS 최신이면 된다.
- pnpm — 없으면 `npm install -g pnpm` 한 줄로 설치한다 (실측 환경 `10.28.2`).

## 설치부터 첫 실행까지

```sh
git clone <저장소> && cd questail-postie
pnpm install                       # 의존성 설치
cp audience.sample.yaml audience.yaml   # 개인 설정 파일 준비 (아래 "설정 파일" 참조)
pnpm sniff                         # 대화형 설정: LLM → Steam → Discord → 저장/실행
pnpm start --dry-run               # 맛보기: 수집·선별까지만, 파일 기록·발행 없음
pnpm start                         # 정식 실행: 9단계 전체 + 발행
```

각 단계에서 일어나는 일:

1. `pnpm install` — `node_modules` 설치. 네트워크만 되면 된다.
2. `audience.yaml` 복사 — 관심 플랫폼·장르·제외어·선별 가중치를 담는 개인 파일.
   없으면 `pnpm sniff`의 저장 후 실행과 `pnpm start`가 sample로 폴백한다.
   appId는 적지 않는다 (SteamID로 런타임 자동 확정).
3. `pnpm sniff` — 아래 "sniff 질문 순서"대로 묻고 `.env`(LLM·Discord)와
   전역 `~/.config/questail/.env`(Steam 키)에 저장한다.
4. `pnpm start --dry-run` — 수집→예선→본선까지만 돌리고 선정 목록을 터미널에 찍는다.
   `seen.json` 저장·요약·번역·발행은 하지 않으므로 안전하게 구경용으로 쓴다.
5. `pnpm start` — 전체 9단계를 돌리고 `output/latest.md` 저장 + 웹훅이 있으면 Discord 발행한다.

## Steam 연동 준비

리뷰어가 가장 막히는 지점이다. Steam 프로필이 있어야 한다.

1. API 키 발급 — `https://steamcommunity.com/dev/apikey`에서 도메인 아무거나 적고 발급받는다.
   무료다.
2. SteamID 입력 — 세 가지 형태를 다 받는다 (`src/steamid.ts`).
   17자리 숫자 그대로, `steamcommunity.com/profiles/숫자` URL,
   `steamcommunity.com/id/이름` URL 또는 vanity 이름 (자동 변환).
3. 입력 즉시 보유 게임 목록을 조회해서 "보유 N건 확인"으로 보여준다.
   숫자가 0건이면 프로필이 **비공개**인 경우가 많다.
   비공개면 `games`가 비어 와서 빈 목록으로 처리된다 (에러가 아니라 조용히 스킵).
   Steam 프로필 설정 → "내 프로필"과 "게임 세부 정보"를 공개로 바꿔야 한다.
   위시리스트는 공개 API에서 제거된 상태라 audience 설정값을 쓴다.
4. 키(`STEAM_API_KEY`·`STEAM_ID`)는 전역 `~/.config/questail/.env`에만 저장되고
   저장소·`.env`에는 들어가지 않는다 (`XDG_CONFIG_HOME`이 있으면 그 아래).
   수집 자체(Steam AppNews 공개 API·RSS)에는 키가 필요 없다.

## LLM 설정 두 갈래

실제 `.env` 키 이름과 값 예시 그대로다.

```sh
# 로컬 (Ollama)
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=
MODEL=qwen3:8b

# OpenAI 유료 API
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=<키>
MODEL=gpt-4o-mini
```

- 로컬: Ollama 설치 후 `ollama pull qwen3:8b`, 위 세 줄대로 둔다. **키는 빈 값.**
  키가 없어도 로컬 엔드포인트면 호출한다 (`src/llmLocal.ts`).
  **로컬은 느리다** — 실측으로 8건 요약+번역에 약 10분 걸렸다 (아래 로그 예시 런 기준).
- OpenAI: 위 값 + 키. 8건 기준 수십 초면 끝난다 (사용자 지시 기준 수치 — 직접 실측 아님).
- 키 없이 원격 엔드포인트면 **절취 폴백**으로 돌아간다.
  원문 앞문장을 그대로 요약 칸에 넣고 번역 없이 원어로 발행하며,
  발행물에 `(원문 요약)` 표기가 붙는다. 파이프라인은 멈추지 않는다.

## Discord 웹훅 만드는 법

채널 오른쪽 편집(톱니) → 연동 → 웹훅 → "새 웹훅" → URL 복사.
`DISCORD_WEBHOOK_URL`에 넣는다. 없으면 `output/latest.md` 파일 저장만 하고 끝난다.

## `pnpm sniff` 질문 순서

방향키(↑↓)+Enter 또는 숫자키로 고르고, 키 입력은 마스킹(`*`)된다.
`textInput`에서 Enter는 **기본값 유지**, `secretInput`에서 Enter는 **건너뛰기(빈 값)**,
어느 단계에서든 Esc는 **전체 취소**(저장 안 함)다.

1. **LLM 프로바이더** — `OpenAI` / `로컬 호환 (Ollama·LM Studio)` / `건너뛰기 (요약 폴백 모드)`.
2. **OpenAI** 선택 시 — `API 키` (이미 있으면 마스킹 표시, Enter면 기존 유지),
   `모델명` (기본값 `gpt-4o-mini`).
   **로컬** 선택 시 — `베이스 URL` (기본값 `http://localhost:11434/v1`),
   `API 키 (없으면 Enter)`, `모델명` (기본값 `llama3.1`, 예시 `qwen3:8b`).
   **건너뛰기**면 아래 5번 확인에서 URL·모델이 `(미사용)`으로 뜬다.
3. **Steam 등록** — 현재 등록 상태 표시 후
   `SteamID (17자리 숫자·프로필 URL·vanity, Enter=건너뛰기)`.
   값을 넣으면 `Steam API 키`를 묻고, 보유 게임 조회가 성공해야 전역 저장한다.
   실패하면 "Steam 등록 실패: ..." 한 줄 + 미등록으로 계속된다.
4. **발행 설정** — `Discord 웹훅 URL` (이미 있으면 마스킹 표시, Enter면 기존 유지).
5. **확인** — 프로바이더·URL·모델·키·웹훅·Steam을 마스킹 요약으로 보여주고
   `어떻게 할까요` → `저장 후 실행` / `저장만` / `취소`.
   **`저장 후 실행`을 고르면 그 자리에서 `pnpm start`와 같은 정식 실행이 돌고
   실제 발행된다.** 구경만 할 거면 `저장만` 후 `pnpm start --dry-run`.

## `.env` 직접 편집

sniff 없이 설정할 수도 있다.

```sh
cp .env.example .env   # 키 이름 틀이 들어 있다
```

편집기로 위 "LLM 설정 두 갈래" 값 + `DISCORD_WEBHOOK_URL`을 채운다.
Steam 키는 여기 적지 않는다 (전역 파일 전용).

## 실행과 결과 확인

`pnpm start --dry-run` — `[1/4] 수집 → [2/4] 개인화 → [3/4] 예선 → [4/4] 본선` 4줄 로그 후
`-- 내 게임 소식 (N)` / `-- 그 외 오늘의 소식 (N)` / `-- 할인 중인 위시리스트 (N)` 섹션별로
`- score=.. [라벨] 제목` 목록을 찍는다. 파일 기록·요약·번역·발행 없음.

`pnpm start` — `[1/9] 수집 … [9/9] 발행` 9단계 진행 로그가 흐른다.
실제 로그 예시 (`docs/run-terminal.jpeg` 실물 기준, gpt-4o-mini 런):

```text
questail-postie 시작 (gpt-4o-mini) — LLM 요약 모드 · Discord 발행
[1/9] 수집 — Steam 265건(신규 256·할인 9) · RSS 30건 (총 295)
[2/9] 개인화 프로필 — 라이브러리 5종 · 위시리스트 51종
[3/9] 예선 — 295건 → 개인화 30건 · 일반 28건 · 할인 5건
[4/9] 본선 — 개인화 5건 · 그 외 3건 선정
[5/9] 요약 (1/8) Ratatan Digital Pre-orders Are Now Open!
...
[5/9] 요약 완료 — 8건
[6/9] 검수 — 8건 중 8건 통과, 0건 재생성, 0건 탈락
[7/9] 브리핑 생성 — 평문 553자
[8/9] 번역 완료 — 성공 8건 · 실패 0건 · 건너뜀 0건
[9/9] 발행 — 개인화 5 · 그 외 3 · 할인 5 — output/latest.md 저장 ·
  Discord 2개 메시지 전송 성공 · seen 발행 기록 8건
선정 8건, 검수 실패 0건
```

결과물 위치:

- `output/latest.md` — 최신 발행물. 매 실행 덮어쓴다.
- `store/metrics.jsonl` — 단계별 실행·검수 기록 (1줄 1레코드, append).
- `store/seen.json` — 발행한 항목 id 기록. 아래 "재실행" 참조.

## 재실행 시 동작

`store/seen.json`이 **발행한 항목의 id**를 기록하므로 같은 소식이 다시 안 나온다.
수집분 전체가 아니라 **발행분만** 기록한다 — 떨어진 소식은 다음 실행 후보로 남는다.
30일 지난 기록은 저장 시점에 정리된다 (`SEEN_RETENTION_DAYS`).
처음부터 다시 보려면 이 파일을 지우면 된다 (없으면 빈 상태로 시작).

## 자동 실행 등록

매일 아침 실행은 코드 내장이 아니라 OS 스케줄러에 건다.
`REPORT.md` "매일 아침 실행" 절에 그대로 쓰는 예시가 있다.
macOS `launchd` 권장 (`~/Library/LaunchAgents/com.questail.postie.plist`, 매일 07:00),
크론 대안 한 줄도 있다. 경로에 사용자명이 박혀 있으니 자기 환경에 맞게 고쳐 쓴다.

## 점검 명령

```sh
pnpm typecheck      # tsc --noEmit. 타입 깨짐 확인
pnpm check:select    # 선별 로직 픽스처 검증 (예선 탈락·본선 점수·라벨 단언)
pnpm check:tiers     # 티어 상수·seen 발행분 집합·할인 기준 픽스처 + 실환경 티어 확정 검증
```

## 자주 막히는 지점

- **보유 게임 0건** — Steam 프로필 비공개가 1순위. 프로필·게임 세부 정보 공개로 전환.
  그래도 0건이면 API 키·SteamID 확인.
- **로컬 LLM 연결 실패** — Ollama 실행 여부(`ollama list`), 베이스 URL(`/v1` 포함),
  모델명(`ollama pull` 했는지). 실패하면 `[summarize] LLM 호출 실패, 폴백 사용` 한 줄 후
  절취 폴백으로 계속된다 — 멈춘 게 아니다.
- **Discord에 안 옴** — `DISCORD_WEBHOOK_URL` 설정 여부. 없으면 파일 저장만 한다.
  2000자 초과 메시지는 항목 경계에서 분할된다.
- **수집이 0건처럼 보임** — `seen.json`이 이미 발행한 항목을 걸러서다.
  같은 소식이 반복 안 나오는 정상 동작. 처음부터 다시 보려면 파일 삭제.
- **`pnpm start` 후 output이 그대로** — `--dry-run`은 파일을 안 쓴다. 정식 실행인지 확인.

## 구조 한눈에

| 파일 | 한 줄 |
| --- | --- |
| `src/graph.ts` | LangGraph 파이프라인 배선 (아래 흐름) |
| `src/run.ts` | 실행 스크립트 (`--dry-run`·`--help`) |
| `src/collect/tiers.ts` | Steam 티어 수집 (위시 전수·최근 플레이·seen 발행분 집합·할인 감시) |
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
| `scripts/check-tiers.ts` | 티어·발행분 집합·할인 검증 |
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
