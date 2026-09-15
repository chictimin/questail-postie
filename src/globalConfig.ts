/**
 * questail 공용 전역 설정 — ~/.config/questail/.env (읽기 전용)
 * questail packages/core/src/cli.ts 패턴 그대로:
 * 전역 먼저 로드 후 로컬 .env 로드(로컬 우선, 미설정 키만 채움).
 * 전역 파일에는 쓰지 않는다 (STEAM 키는 questail CLI가 관리).
 * XDG_CONFIG_HOME이 있으면 그 아래 questail 디렉토리를 쓴다.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return resolve(xdg.trim(), "questail");
  return resolve(homedir(), ".config", "questail");
}

export function globalConfigFile(): string {
  return join(globalConfigDir(), ".env");
}

const KEY_ALIASES: Record<string, string> = {
  "steam-api-key": "STEAM_API_KEY",
  "steam-id": "STEAM_ID",
  language: "LANGUAGE",
};

export function loadEnvFile(filepath: string): void {
  if (!existsSync(filepath)) return;
  const content = readFileSync(filepath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    const envKey = KEY_ALIASES[key] ?? key;
    if (!process.env[envKey]) process.env[envKey] = val;
  }
}

/** 전역 로드 후 로컬 로드 (questail initEnv와 동일. 코드 기준 먼저 로드된 전역이 동점시 이긴다) */
export function initEnv(localEnvFile: string): void {
  loadEnvFile(globalConfigFile());
  loadEnvFile(localEnvFile);
}

const GLOBAL_WRITABLE_KEYS = ["STEAM_API_KEY", "STEAM_ID"] as const;

const KEY_LINE_ALIASES: Record<string, string[]> = {
  STEAM_API_KEY: ["STEAM_API_KEY", "steam-api-key"],
  STEAM_ID: ["STEAM_ID", "steam-id"],
};

/**
 * 전역 파일에 STEAM 키만 upsert 저장.
 * 공용 파일 규칙: STEAM 키 전용. 다른 키 행은 건드리지 않는다.
 * kebab 별칭(questail CLI 표기) 행도 함께 정리해 중복을 막는다.
 */
export async function saveSteamKeys(
  entries: Partial<Record<(typeof GLOBAL_WRITABLE_KEYS)[number], string>>,
): Promise<void> {
  const file = globalConfigFile();
  await mkdir(globalConfigDir(), { recursive: true });
  let lines: string[] = [];
  if (existsSync(file)) {
    lines = (await readFile(file, "utf-8")).split("\n");
  }
  for (const key of GLOBAL_WRITABLE_KEYS) {
    const value = entries[key];
    if (value === undefined) continue;
    const entry = `${key}=${value}`;
    const aliases = KEY_LINE_ALIASES[key];
    const hits: number[] = [];
    lines.forEach((l, i) => {
      if (aliases.some((a) => l.trim().startsWith(`${a}=`))) hits.push(i);
    });
    if (hits.length === 0) {
      lines.push(entry);
    } else {
      lines[hits[0]] = entry;
      for (const i of hits.slice(1).reverse()) lines.splice(i, 1);
    }
    process.env[key] = value;
  }
  await writeFile(file, `${lines.join("\n").trim()}\n`, "utf-8");
}
