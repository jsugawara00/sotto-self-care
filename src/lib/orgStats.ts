// 実施状況の集計ロジック（サーバー専用）。
// 実施状況API（/api/admin/stats）と一括案内の宛先確定（「未実施者のみ」）で共用する。
// 個別の回答内容・スコアには触れない（userId と source しか読まない）。
import type { Firestore } from "firebase-admin/firestore";
import { currentPeriodStart } from "./cycle";
import type { CheckCycle, OrgSettings, UserProfile } from "./types";

// 集計対象のロール（仮決め：チェックを受ける側＝member/hr。TODO.md参照）
export const TARGET_ROLES = ["member", "hr"];

export type CheckTargets = {
  cycle: CheckCycle;
  periodStart: Date;
  // 集計対象（listed=true の担当者・総務）の uid → 表示名
  targets: Map<string, UserProfile>;
  // 今周期にセルフチェックを実施済みの uid（取込データは含めない）
  doneIds: Set<string>;
};

export async function getCheckTargets(db: Firestore): Promise<CheckTargets> {
  // 周期設定（未設定時は weekly＝仮決め）
  const settingsSnap = await db.collection("orgSettings").doc("default").get();
  const cycle: CheckCycle = settingsSnap.exists
    ? ((settingsSnap.data() as OrgSettings).checkCycle ?? "weekly")
    : "weekly";
  const periodStart = currentPeriodStart(cycle);

  // 集計対象ユーザー（listed=true の担当者・総務）
  const usersSnap = await db
    .collection("users")
    .where("listed", "==", true)
    .get();
  const targets = new Map<string, UserProfile>();
  usersSnap.docs.forEach((d) => {
    const profile = d.data() as UserProfile;
    if (TARGET_ROLES.includes(profile.role)) targets.set(d.id, profile);
  });

  // 今周期の checkins から「実施済みユーザー」を数える（回答内容は見ない）。
  // 過去のストレスチェック取込（source: "imported"）は実施にカウントしない。
  const checkinsSnap = await db
    .collection("checkins")
    .where("answeredAt", ">=", periodStart)
    .select("userId", "source")
    .get();
  const doneIds = new Set<string>();
  checkinsSnap.docs.forEach((d) => {
    const data = d.data() as { userId?: string; source?: string };
    if (data.source === "imported") return;
    if (data.userId && targets.has(data.userId)) doneIds.add(data.userId);
  });

  return { cycle, periodStart, targets, doneIds };
}
