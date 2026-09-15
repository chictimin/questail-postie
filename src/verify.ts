import type { NewsItem, Summary, Verdict } from "./types.js";
import { MAX_LINE_CHARS_SRC } from "./summarize.js";

export type SourceLookup = (id: string) => NewsItem | undefined;
export type Resummarize = (s: Summary) => Promise<Summary>;

/**
 * 원문 대조용: 요약에 등장하는 연도·날짜 표현을 뽑는다.
 * 연도·날짜에만 한정한다 (다른 수치·고유명사는 건드리지 않는다).
 */
function extractDateExprs(text: string): string[] {
  const found = new Set<string>();
  const patterns: RegExp[] = [
    /\b(?:19|20)\d{2}\b/g, // 4자리 연도
    /\d{1,2}월(?:\s*\d{1,2}일)?/g, // 9월, 9월 15일
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}\b/gi, // October 11
    /\b\d{1,2}\/\d{1,2}\b/g, // 10/11
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

function extractKeyTokens(title: string): string[] {
  return title
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length >= 3);
}

/**
 * 원어끼리 대조한다. summarize가 원어 요약을 내므로 제목 토큰 검사가 실제로 작동한다.
 * 날짜·연도 환각 검사는 원문(제목+본문) 대조로 한 겹 더 건다.
 */
function checkSummary(
  s: Summary,
  sourceOf: SourceLookup,
  contentOf: (id: string) => string | undefined,
): string[] {
  const reasons: string[] = [];

  const tokens = extractKeyTokens(s.title);
  if (tokens.length > 0) {
    const combined = s.bullets.join(" ").toLowerCase();
    const hit = tokens.some((t) => combined.includes(t.toLowerCase()));
    if (!hit) reasons.push("제목 핵심 토큰이 요약에 없음");
  }

  if (!s.url.startsWith("http") || sourceOf(s.id) === undefined) {
    reasons.push("url이 http로 시작하지 않거나 원문 매핑이 없음");
  }

  const tooLong = s.bullets.some((b) => b.length > MAX_LINE_CHARS_SRC);
  if (tooLong) reasons.push(`bullets 중 원어 상한(${MAX_LINE_CHARS_SRC}자) 초과 항목이 있음`);

  const content = contentOf(s.id) ?? "";
  if (content) {
    const summaryText = s.bullets.join(" ");
    const phantom = extractDateExprs(summaryText).filter((d) => !content.includes(d));
    if (phantom.length > 0) reasons.push(`원문에 없는 연도·날짜 표현: ${phantom.join(", ")}`);
  }

  return reasons;
}

export async function verifySummaries(
  summaries: Summary[],
  sourceOf: SourceLookup,
  resummarize: Resummarize,
  contentOf?: (id: string) => string | undefined,
): Promise<{ passed: Summary[]; verdicts: Verdict[] }> {
  const passed: Summary[] = [];
  const verdicts: Verdict[] = [];
  // 연도·날짜 대조 범위는 제목+본문. 제목에만 있는 연도의 오탐 방지 (nano 교차 검증 지적).
  const lookupContent = contentOf ?? ((id) => {
    const n = sourceOf(id);
    return n ? `${n.title}\n${n.content}` : undefined;
  });

  for (const summary of summaries) {
    const firstReasons = checkSummary(summary, sourceOf, lookupContent);
    if (firstReasons.length === 0) {
      passed.push(summary);
      verdicts.push({ id: summary.id, pass: true, reason: "", regenerated: false });
      continue;
    }

    let retried: Summary | null = null;
    let retryError: string | null = null;
    try {
      retried = await resummarize(summary);
    } catch (err) {
      retryError = err instanceof Error ? err.message : String(err);
    }

    if (retried === null) {
      verdicts.push({
        id: summary.id,
        pass: false,
        reason: `${firstReasons.join("; ")} (재생성 실패: ${retryError ?? "알 수 없음"})`,
        regenerated: true,
      });
      continue;
    }

    const secondReasons = checkSummary(retried, sourceOf, lookupContent);
    if (secondReasons.length === 0) {
      passed.push(retried);
      verdicts.push({
        id: summary.id,
        pass: true,
        reason: `재생성 후 통과 (기존 실패: ${firstReasons.join("; ")})`,
        regenerated: true,
      });
    } else {
      verdicts.push({
        id: summary.id,
        pass: false,
        reason: `재생성 후에도 실패: ${secondReasons.join("; ")} (기존 실패: ${firstReasons.join("; ")})`,
        regenerated: true,
      });
    }
  }

  return { passed, verdicts };
}
