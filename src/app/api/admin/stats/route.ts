// 実施状況の可視化（指示書STEP2-2）＋再検査完了率（STEP4・企画書8-5①）。admin / owner のみ。
// 管理者には「実施済み／未実施の人数」「要再検査／完了の件数」という集計値だけを返し、
// 個別の回答内容・スコア・健診の中身は一切返さない（Security Rules でも直接読めない）。
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { getCheckTargets } from "@/lib/orgStats";
import { isHealthFeatureEnabled } from "@/lib/health";
import type { HealthRecord } from "@/lib/types";

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["admin", "owner"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  const db = getAdminDb();

  try {
    const { cycle, periodStart, targets, doneIds } = await getCheckTargets(db);
    const total = targets.size;
    const done = doneIds.size;

    // 再検査完了率（企画書8-5①：完了有無・検査率のみ。中身は見せない）。
    // healthRecords は仮名IDキーで件数を数えるだけ＝個人には結びつかない。
    // 分母＝reexamRequired=true の記録数（オプトイン解除時は記録ごと消えるため常に現況）。
    let reexam: { required: number; done: number } | null = null;
    if (await isHealthFeatureEnabled(db)) {
      const recordsSnap = await db
        .collection("healthRecords")
        .where("reexamRequired", "==", true)
        .select("reexamStatus")
        .get();
      const required = recordsSnap.size;
      const reexamDone = recordsSnap.docs.filter(
        (d) => (d.data() as Pick<HealthRecord, "reexamStatus">).reexamStatus === "done"
      ).length;
      reexam = { required, done: reexamDone };
    }

    return NextResponse.json({
      cycle,
      periodStart: periodStart.toISOString(),
      total,
      done,
      notDone: total - done,
      reexam,
    });
  } catch (err) {
    console.error("実施状況の集計に失敗:", err);
    return NextResponse.json(
      { error: "集計中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
