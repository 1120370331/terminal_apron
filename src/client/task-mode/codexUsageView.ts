import type { CodexDailyUsage } from "../../shared/codexInfoTypes.js";

export function tokenText(value: number | null): string {
  if (value === null) return "—";
  for (const [base, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (value >= base) return `${(value / base).toFixed(value >= base * 100 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
  return value.toLocaleString();
}
export function todayKey(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function shiftDay(key: string, amount: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function monthDays(month: string): Array<string | null> {
  const [year, number] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return [...Array.from({ length: (first.getUTCDay() + 6) % 7 }, () => null), ...Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`)];
}
export function shiftMonth(month: string, amount: number): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + amount, 1)).toISOString().slice(0, 7);
}
export function dailyTokens(daily: CodexDailyUsage[] | null, date: string): number | null {
  return daily?.find(day => day.date === date)?.tokens ?? null;
}
export function windowLabel(minutes: number | null): string {
  if (minutes === null) return "当前额度";
  if (minutes === 1440) return "每日额度";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}
