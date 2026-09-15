#!/usr/bin/env node

/**
 * questail-postie sniff — BYOK 대화형 설정 (미니 TUI)
 *
 *   pnpm sniff
 *
 * 방향키(↑↓)+Enter 또는 숫자키로 메뉴를 고르고, 키 입력은 마스킹한다.
 * 결과는 프로젝트 루트의 .env에 저장한다 (.env는 gitignore).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { initEnv, saveSteamKeys } from "./globalConfig.js";
import { fetchOwnedAppIds, resolveToSteamId } from "./steamid.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = resolve(ROOT, ".env");

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

// ─── 키 입력 ────────────────────────────────────────────────────

type Key = { kind: "up" } | { kind: "down" } | { kind: "enter" } | { kind: "backspace" } | { kind: "char"; ch: string } | { kind: "esc" } | { kind: "eof" };

class SniffCancel extends Error {}

const ESC_WAIT_MS = 50;

function createKeyStream(): { nextKey: () => Promise<Key>; close: () => void } {
  let buffer = Buffer.alloc(0);
  let ended = false;
  const keyQueue: Key[] = [];
  const waiters: Array<(k: Key) => void> = [];
  let escTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(key: Key): void {
    const waiter = waiters.shift();
    if (waiter) waiter(key);
    else keyQueue.push(key);
  }

  function clearEscTimer(): void {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  }

  function tryEmit(): Key | null {
    if (buffer.length === 0) return null;
    if (buffer[0] === 0x1b && buffer.length >= 3 && buffer[1] === 0x5b) {
      const code = buffer[2];
      buffer = buffer.subarray(3);
      if (code === 0x41) return { kind: "up" };
      if (code === 0x42) return { kind: "down" };
      return tryEmit();
    }
    if (buffer[0] === 0x1b && buffer.length === 1 && !ended) return null;
    if (buffer[0] === 0x1b && buffer.length === 1 && ended) {
      buffer = buffer.subarray(1);
      return { kind: "esc" };
    }
    if (buffer[0] === 0x1b) return null;
    const byte = buffer[0];
    buffer = buffer.subarray(1);
    if (byte === 0x0d || byte === 0x0a) return { kind: "enter" };
    if (byte === 0x7f || byte === 0x08) return { kind: "backspace" };
    if (byte < 0x20) return tryEmit();
    return { kind: "char", ch: String.fromCharCode(byte) };
  }

  function pump(): void {
    if (buffer.length === 1 && buffer[0] === 0x1b && !ended && escTimer === null) {
      escTimer = setTimeout(() => {
        escTimer = null;
        if (buffer.length === 1 && buffer[0] === 0x1b && !ended) {
          buffer = buffer.subarray(1);
          emit({ kind: "esc" });
        }
        pump();
      }, ESC_WAIT_MS);
      return;
    }
    let key: Key | null;
    while ((key = tryEmit()) !== null) {
      emit(key);
    }
    if (ended) {
      let waiter: ((k: Key) => void) | undefined;
      while ((waiter = waiters.shift())) waiter({ kind: "eof" });
    }
  }

  process.stdin.on("data", (chunk: Buffer) => {
    clearEscTimer();
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  process.stdin.on("end", () => {
    clearEscTimer();
    ended = true;
    pump();
  });
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // raw 모드 실패 시 일반 모드로 동작
    }
  }
  process.stdin.resume();

  return {
    nextKey: () => new Promise<Key>((resolve) => {
      const queued = keyQueue.shift();
      if (queued) {
        resolve(queued);
        return;
      }
      const pending = tryEmit();
      if (pending) {
        resolve(pending);
        return;
      }
      if (ended) {
        resolve({ kind: "eof" });
        return;
      }
      waiters.push(resolve);
    }),
    close: () => {
      clearEscTimer();
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // 무시
        }
      }
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.pause();
    },
  };
}

type KeyStream = ReturnType<typeof createKeyStream>;

// ─── 화면 ───────────────────────────────────────────────────────

function header(title: string): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`┌─ questail-postie · ${title}\n`);
}

function maskValue(value: string): string {
  if (!value) return "(미설정)";
  if (value.length <= 4) return value.slice(0, 1) + "*".repeat(Math.max(0, value.length - 1));
  const keep = Math.min(4, Math.floor(value.length / 3));
  return value.slice(0, keep) + "*".repeat(value.length - keep * 2) + value.slice(-keep);
}

async function menu(ks: KeyStream, message: string, choices: string[]): Promise<number> {
  let index = 0;
  const render = () => {
    process.stdout.write(`${message} (↑↓/숫자+Enter)\n`);
    choices.forEach((choice, i) => {
      process.stdout.write(`${i === index ? "❯" : " "} ${i + 1}. ${choice}\n`);
    });
  };
  render();
  for (;;) {
    const key = await ks.nextKey();
    if (key.kind === "esc") throw new SniffCancel();
    if (key.kind === "enter" || key.kind === "eof") return index;
    if (key.kind === "up") index = (index + choices.length - 1) % choices.length;
    else if (key.kind === "down") index = (index + 1) % choices.length;
    else if (key.kind === "char") {
      const n = Number.parseInt(key.ch, 10);
      if (n >= 1 && n <= choices.length) return n - 1;
      continue;
    } else continue;
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b[${choices.length + 1}A`);
      render();
    }
  }
}

async function textInput(ks: KeyStream, message: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` (기본값: ${defaultValue})` : "";
  process.stdout.write(`${message}${hint}: `);
  let value = "";
  for (;;) {
    const key = await ks.nextKey();
    if (key.kind === "esc") throw new SniffCancel();
    if (key.kind === "enter" || key.kind === "eof") {
      process.stdout.write("\n");
      return value || defaultValue;
    }
    if (key.kind === "backspace") {
      if (value.length > 0) {
        value = value.slice(0, -1);
        if (process.stdout.isTTY) process.stdout.write("\b \b");
      }
      continue;
    }
    if (key.kind === "char") {
      value += key.ch;
      if (process.stdout.isTTY) process.stdout.write(key.ch);
    }
  }
}

async function secretInput(ks: KeyStream, message: string): Promise<string> {
  process.stdout.write(`${message} (Enter=건너뛰기): `);
  let value = "";
  for (;;) {
    const key = await ks.nextKey();
    if (key.kind === "esc") throw new SniffCancel();
    if (key.kind === "enter" || key.kind === "eof") {
      process.stdout.write("\n");
      return value;
    }
    if (key.kind === "backspace") {
      if (value.length > 0) {
        value = value.slice(0, -1);
        if (process.stdout.isTTY) process.stdout.write("\b \b");
      }
      continue;
    }
    if (key.kind === "char") {
      value += key.ch;
      if (process.stdout.isTTY) process.stdout.write("*");
    }
  }
}

// ─── env 저장 (로컬 .env 전용 — 전역 파일에는 쓰지 않는다) ───

async function saveEnv(entries: Record<string, string>): Promise<void> {
  let lines: string[] = [];
  if (existsSync(ENV_FILE)) {
    lines = (await readFile(ENV_FILE, "utf-8")).split("\n");
  }
  for (const [key, value] of Object.entries(entries)) {
    const entry = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx !== -1) lines[idx] = entry;
    else lines.push(entry);
  }
  await writeFile(ENV_FILE, `${lines.join("\n").trim()}\n`, "utf-8");
  for (const [key, value] of Object.entries(entries)) process.env[key] = value;
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  initEnv(ENV_FILE);
  const ks = createKeyStream();

  header("BYOK 설정");
  const provider = await menu(ks, "LLM 프로바이더", [
    "OpenAI",
    "로컬 호환 (Ollama·LM Studio)",
    "건너뛰기 (요약 폴백 모드)",
  ]);

  let baseURL = "https://api.openai.com/v1";
  let model = "gpt-4o-mini";
  let apiKey = "";
  if (provider === 0) {
    header("OpenAI 설정");
    if (process.env.OPENAI_API_KEY) {
      process.stdout.write(`현재 키: ${maskValue(process.env.OPENAI_API_KEY)}\n`);
    }
    apiKey = await secretInput(ks, "API 키");
    if (!apiKey && process.env.OPENAI_API_KEY) apiKey = process.env.OPENAI_API_KEY;
    process.stdout.write("예: gpt-4o-mini, gpt-4o\n");
    model = await textInput(ks, "모델명", process.env.MODEL || "gpt-4o-mini");
  } else if (provider === 1) {
    header("로컬 모델 설정");
    const existingBase = process.env.OPENAI_BASE_URL ?? "";
    const localDefault = isLocalhostUrl(existingBase) ? existingBase : "http://localhost:11434/v1";
    baseURL = await textInput(ks, "베이스 URL", localDefault);
    apiKey = await secretInput(ks, "API 키 (없으면 Enter)");
    process.stdout.write("예: qwen3:8b, llama3.1\n");
    model = await textInput(ks, "모델명", process.env.MODEL || "llama3.1");
  }

  header("Steam 등록");
  let steamKey = process.env.STEAM_API_KEY || "";
  let steamId64 = process.env.STEAM_ID || "";
  process.stdout.write(`현재: ${steamKey && steamId64 ? "전역 설정에 등록됨" : "(미등록)"}\n`);
  process.stdout.write("계정이 없어도 Enter로 건너뛰면 데모 4종(공개 공지로 개인화 맛보기)으로 실행됩니다.\n");
  const steamInput = await textInput(
    ks,
    "SteamID (17자리 숫자·프로필 URL·vanity, Enter=건너뛰기)",
    steamId64,
  );
  if (steamInput.trim()) {
    if (!steamKey) steamKey = await secretInput(ks, "Steam API 키 (없으면 Enter)");
    if (!steamKey) {
      process.stdout.write("키가 없어 Steam 등록을 건너뜁니다.\n");
      steamId64 = "";
    } else {
      try {
        steamId64 = await resolveToSteamId(steamInput, steamKey);
        const owned = await fetchOwnedAppIds(steamKey, steamId64);
        await saveSteamKeys({ STEAM_API_KEY: steamKey, STEAM_ID: steamId64 });
        process.stdout.write(
          `SteamID ${steamId64} (보유 ${owned.length}건 확인)를 전역 설정에 저장했습니다. appID는 묻지 않습니다.\n`,
        );
      } catch (err) {
        process.stdout.write(`Steam 등록 실패: ${err instanceof Error ? err.message : String(err)}\n`);
        steamId64 = "";
      }
    }
  } else {
    process.stdout.write("Steam 등록을 건너뜁니다. 데모 4종으로 실행됩니다.\n");
    steamId64 = "";
  }

  header("발행 설정");
  if (process.env.DISCORD_WEBHOOK_URL) {
    process.stdout.write(`현재 웹훅: ${maskValue(process.env.DISCORD_WEBHOOK_URL)}\n`);
  }
  const webhook = await secretInput(ks, "Discord 웹훅 URL");
  const finalWebhook = webhook || process.env.DISCORD_WEBHOOK_URL || "";

  header("확인");
  process.stdout.write(`프로바이더: ${["OpenAI", "로컬 호환", "건너뛰기"][provider]}\n`);
  process.stdout.write(`베이스 URL: ${provider === 2 ? "(미사용)" : baseURL}\n`);
  process.stdout.write(`모델: ${provider === 2 ? "(미사용)" : model}\n`);
  process.stdout.write(`API 키: ${maskValue(provider === 2 ? "" : apiKey)}\n`);
  process.stdout.write(`Discord 웹훅: ${maskValue(finalWebhook)}\n`);
  process.stdout.write(`Steam: ${steamId64 ? `등록 (${steamId64})` : "미등록 (데모 목록 4종 사용)"}\n`);
  const action = await menu(ks, "어떻게 할까요", ["저장 후 실행", "저장만", "취소"]);
  ks.close();

  if (action === 2) {
    console.log("취소했습니다.");
    return;
  }
  await saveEnv({
    OPENAI_BASE_URL: baseURL,
    OPENAI_API_KEY: provider === 2 ? "" : apiKey,
    MODEL: model,
    DISCORD_WEBHOOK_URL: finalWebhook,
  });
  // appID는 audience.yaml에 쓰지 않는다. 티어는 런타임에 SteamID로 확정한다.
  console.log(`저장 완료: ${ENV_FILE}`);

  if (action === 0) {
    const { runPipeline } = await import("./graph.js");
    const { parse: parseYaml } = await import("yaml");
    const { appendFile, mkdir } = await import("node:fs/promises");
    // audience.yaml(개인 설정) 우선, 없으면 audience.sample.yaml(샘플) 폴백.
    // run.ts는 main()을 무조건 실행하므로 import하지 않고 여기서 직접 읽는다.
    let audienceRaw: string | null = null;
    for (const name of ["audience.yaml", "audience.sample.yaml"]) {
      const candidate = resolve(ROOT, name);
      if (existsSync(candidate)) {
        audienceRaw = await readFile(candidate, "utf-8");
        break;
      }
    }
    if (audienceRaw === null) throw new Error("audience.yaml 또는 audience.sample.yaml이 필요합니다.");
    const aud = parseYaml(audienceRaw);
    const outPath = resolve(ROOT, "output/latest.md");
    const metricsPath = resolve(ROOT, "store/metrics.jsonl");
    const { passed, verdicts, metrics } = await runPipeline(aud, {
      baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY || undefined,
      model: process.env.MODEL ?? "gpt-4o-mini",
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
      outPath,
      metricsPath,
    });
    await mkdir(dirname(metricsPath), { recursive: true });
    for (const record of metrics) {
      await appendFile(metricsPath, `${JSON.stringify(record)}\n`, "utf-8");
    }
    console.log(`선정 ${passed.length}건, 검수 실패 ${verdicts.filter((v) => !v.pass).length}건`);
  }
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    if (err instanceof SniffCancel) {
      console.log("취소했습니다. 저장하지 않았습니다.");
      process.exit(0);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
