import OpenAI from "openai";
import type { Digest, Summary } from "./types.js";
import { canCallLlm, effectiveApiKey, extractJsonPayload, warnFallback } from "./llmLocal.js";

export interface TranslateOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
}

/** 한국어 번역 상한 (기존 한국어 200자 기준 유지). */
export const MAX_LINE_CHARS_KO = 200;
/** digest 평문 상한 (digest 원문 상한과 동일). */
export const MAX_DIGEST_CHARS_KO = 1200;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function hasUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}

interface TranslationResult {
  titleKo: string;
  bulletsKo: string[];
}

/**
 * 항목 1건을 한국어로 번역한다. 가벼운 검사만 한다:
 * 불릿 2~3개 유지(원문 개수와 일치) / 각 200자 이하 / URL 문자열 미포함.
 * 실패하면 null — 호출자가 Ko를 비운 채 둔다 (원어 발행).
 */
async function translateOne(
  client: OpenAI,
  model: string,
  s: Summary,
): Promise<TranslationResult | null> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You translate game news summaries into Korean. " +
          "Reply with JSON only: {\"titleKo\": \"제목 번역\", \"bulletsKo\": [\"번역 2~3개\"]}. " +
          "Each item max 200 chars. Translate faithfully; do not add facts. " +
          "Keep game titles and proper nouns in their original form. " +
          "Answer in Korean only. Never return the English sentences as-is.",
      },
      {
        role: "user",
        content: [
          `Title: ${s.title}`,
          "Bullets:",
          ...s.bullets.map((b, i) => `${i + 1}. ${b}`),
        ].join("\n"),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? "";
  let parsed: { titleKo?: unknown; bulletsKo?: unknown };
  try {
    parsed = JSON.parse(extractJsonPayload(raw)) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.titleKo !== "string" || !parsed.titleKo.trim()) return null;
  if (!Array.isArray(parsed.bulletsKo)) return null;
  const ko = (parsed.bulletsKo as unknown[]).filter(
    (b): b is string => typeof b === "string" && b.trim().length > 0,
  );
  // 2~3개 허용, 1개 이하·4개 이상은 실패. 원문 개수와 일치해야 한다.
  if (ko.length < 2 || ko.length > 3 || ko.length !== s.bullets.length) return null;
  // 200자 초과는 버리지 말고 잘라서 수용한다. URL 포함·개수 불일치는 실패로 둔다.
  const parts = [parsed.titleKo, ...ko];
  if (parts.some((p) => hasUrl(p))) return null;
  // 영어를 그대로 돌려주면 실패 — 한국어 판정 후 재시도 대상이 된다.
  if (!parts.some((p) => /[가-힣]/.test(p))) return null;
  return {
    titleKo: truncate(parsed.titleKo, MAX_LINE_CHARS_KO),
    bulletsKo: ko.map((b) => truncate(b, MAX_LINE_CHARS_KO)),
  };
}

export interface TranslateReport {
  summaries: Summary[];
  digestKo: string;
  ok: number;
  ko: number;
  failed: number;
  skipped: number;
  sourceKo: number;
}

/**
 * verify 통과분 + Digest를 한국어로 번역한다. 항목별 호출 (일괄 1회 금지).
 * - sourceLang === "ko": 호출 없이 원어를 Ko에 복사, translated=true.
 * - LLM 없음: 전건 skipped, Ko 비움, translated=false (원어 발행).
 * - 번역 실패: 해당 항목만 Ko 비움, translated=false. 나머지는 산다.
 */
export type TranslateProgress = (done: number, total: number, title: string) => void;

export async function translateToKorean(
  summaries: Summary[],
  digest: Digest,
  opts: TranslateOptions,
  onProgress?: TranslateProgress,
): Promise<TranslateReport> {
  const report: TranslateReport = {
    summaries: [], digestKo: "", ok: 0, ko: 0, failed: 0, skipped: 0, sourceKo: 0,
  };
  const llmReady = canCallLlm(opts.baseURL, opts.apiKey);
  const client = llmReady
    ? new OpenAI({ baseURL: opts.baseURL, apiKey: effectiveApiKey(opts.apiKey) })
    : null;

  for (const [i, s] of summaries.entries()) {
    if (s.sourceLang === "ko") {
      report.summaries.push({
        ...s,
        titleKo: s.title,
        bulletsKo: [...s.bullets],
        translated: true,
      });
      report.ko += 1;
      report.sourceKo += 1;
      onProgress?.(i + 1, summaries.length, s.title);
      continue;
    }
    if (!client) {
      report.summaries.push({ ...s, translated: false });
      report.skipped += 1;
      onProgress?.(i + 1, summaries.length, s.title);
      continue;
    }
    // 번역 실패 시 1회 재시도 (summarize/verify 재생성 패턴과 동일). 둘 다 실패해야 원어 발행.
    let t = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2 && !t; attempt++) {
      try {
        t = await translateOne(client, opts.model, s);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!t) {
      if (lastErr) warnFallback("translate", lastErr);
      else console.error(`[translate] 번역 검증 실패(2회), 원어 발행: ${s.title}`);
      report.summaries.push({ ...s, translated: false });
      report.failed += 1;
      onProgress?.(i + 1, summaries.length, s.title);
      continue;
    }
    report.summaries.push({ ...s, ...t, translated: true });
    report.ok += 1;
    onProgress?.(i + 1, summaries.length, s.title);
  }

  // Digest 번역: 문단 통째로 1회 호출. 실패·LLM없음·ko원문은 원어 유지.
  if (!digest.text) {
    report.digestKo = "";
  } else if (/[가-힣]/.test(digest.text)) {
    report.digestKo = digest.text;
  } else if (client) {
    try {
      const response = await client.chat.completions.create({
        model: opts.model,
        messages: [
          {
            role: "system",
            content:
              "You translate a game news briefing paragraph into Korean. " +
              "Reply with JSON only: {\"text\": \"번역된 문단\"}. " +
              "Keep it one paragraph, 2-4 sentences, no line breaks or bullets. " +
              "Translate faithfully; do not add facts.",
          },
          { role: "user", content: digest.text },
        ],
      });
      const raw = response.choices[0]?.message?.content ?? "";
      const parsed = JSON.parse(extractJsonPayload(raw)) as { text?: unknown };
      if (
        typeof parsed.text === "string" &&
        parsed.text.trim() &&
        parsed.text.length <= MAX_DIGEST_CHARS_KO &&
        !hasUrl(parsed.text)
      ) {
        report.digestKo = truncate(parsed.text.trim(), MAX_DIGEST_CHARS_KO);
      } else {
        report.digestKo = digest.text;
      }
    } catch (err) {
      warnFallback("translate-digest", err);
      report.digestKo = digest.text;
    }
  } else {
    report.digestKo = digest.text;
  }

  return report;
}
