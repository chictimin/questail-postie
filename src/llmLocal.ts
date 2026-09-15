/**
 * 로컬 LLM 엔드포인트 판정 + 응답 전처리 (summarize.ts·digest.ts 공유)
 * sniff.ts의 isLocalhostUrl과 동일 규칙. sniff는 타 담당 영역이라 여기서 정의한다.
 */

/** 로컬호스트 baseURL 판정 (Ollama·LM Studio 등 로컬 추론 서버). */
export function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

/**
 * LLM 호출 가능 여부. "키가 있는가"가 아니라 "호출할 엔드포인트가 있는가"로 판정한다.
 * 키가 있으면 원격·로컬 모두 호출, 키가 없어도 로컬 엔드포인트면 호출한다.
 * 원격 baseURL + 키 없음은 폴백한다.
 */
export function canCallLlm(baseURL: string, apiKey?: string): boolean {
  if (apiKey && apiKey.trim()) return true;
  return isLocalhostUrl(baseURL);
}

/** OpenAI SDK는 빈 키에 throw하므로 로컬 경로용 더미 키를 채운다 (인증용이 아님). */
export function effectiveApiKey(apiKey?: string): string {
  return apiKey && apiKey.trim() ? apiKey : "local";
}

/** thinking 모델의 <think> 블록과 코드펜스를 제거한다. */
export function stripLlmNoise(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/```(?:\w+)?\n?/g, "");
}

/** 요약 응답에서 JSON 페이로드를 꺼낸다. 없으면 노이즈 제거된 원문을 돌려준다. */
export function extractJsonPayload(raw: string): string {
  const cleaned = stripLlmNoise(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

/** 폴백으로 내려갈 때 이유를 stderr에 한 줄 남긴다 (무음 catch 방지). */
export function warnFallback(stage: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`[${stage}] LLM 호출 실패, 폴백 사용: ${reason}`);
}
