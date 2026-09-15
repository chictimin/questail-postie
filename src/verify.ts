import type { NewsItem, Summary, Verdict } from "./types.js";

export type SourceLookup = (id: string) => NewsItem | undefined;
export type Resummarize = (s: Summary) => Promise<Summary>;

const MAX_LINE_CHARS = 200;

function extractKeyTokens(title: string): string[] {
  return title
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length >= 3);
}

function checkSummary(s: Summary, sourceOf: SourceLookup): string[] {
  const reasons: string[] = [];

  const tokens = extractKeyTokens(s.title);
  if (tokens.length > 0) {
    const combined = [...s.bulletsKo, s.insightKo].join(" ").toLowerCase();
    const hit = tokens.some((t) => combined.includes(t.toLowerCase()));
    if (!hit) reasons.push("제목 핵심 토큰이 요약·인사이트에 없음");
  }

  if (!s.url.startsWith("http") || sourceOf(s.id) === undefined) {
    reasons.push("url이 http로 시작하지 않거나 원문 매핑이 없음");
  }

  const tooLong =
    s.bulletsKo.some((b) => b.length > MAX_LINE_CHARS) ||
    s.insightKo.length > MAX_LINE_CHARS;
  if (tooLong) reasons.push("bullets/insight 중 200자 초과 항목이 있음");

  return reasons;
}

export async function verifySummaries(
  summaries: Summary[],
  sourceOf: SourceLookup,
  resummarize: Resummarize,
): Promise<{ passed: Summary[]; verdicts: Verdict[] }> {
  const passed: Summary[] = [];
  const verdicts: Verdict[] = [];

  for (const summary of summaries) {
    const firstReasons = checkSummary(summary, sourceOf);
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

    const secondReasons = checkSummary(retried, sourceOf);
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
