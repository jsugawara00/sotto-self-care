// ストレスチェック周期 → 現在の対象期間の開始時刻（JST基準）を求める。
// クライアント（本人トップの実施済み判定）とサーバー（実施状況集計API）の両方で使う。
// ※ functions/src/ 側にはこのロジックは不要（集計はAPI Route側で行う）。
import type { CheckCycle } from "./types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 現在の周期の開始時刻を UTC の Date で返す（内部計算は JST の暦で行う）
export function currentPeriodStart(cycle: CheckCycle, now: Date = new Date()): Date {
  // JST の暦日を得るため、UTC時刻に+9hしたものを「JSTの壁時計」として扱う
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();

  let startJst: Date;
  switch (cycle) {
    case "daily":
      startJst = new Date(Date.UTC(y, m, d));
      break;
    case "weekly": {
      // 週の起点は月曜（仮決め）
      const dow = jst.getUTCDay(); // 0=日
      const diff = (dow + 6) % 7; // 月曜からの経過日数
      startJst = new Date(Date.UTC(y, m, d - diff));
      break;
    }
    case "monthly":
      startJst = new Date(Date.UTC(y, m, 1));
      break;
    case "yearly":
      startJst = new Date(Date.UTC(y, 0, 1));
      break;
  }
  // JSTの壁時計 → 実際のUTC時刻に戻す
  return new Date(startJst.getTime() - JST_OFFSET_MS);
}
