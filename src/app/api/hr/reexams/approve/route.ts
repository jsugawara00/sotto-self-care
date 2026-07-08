// 総務（hr）向け：受領確認→完了承認（STEP3・企画書8-3）。
// 完了確定は総務承認制（自動完了にしない＝誤送信防止・証跡）。
// 承認と同時に領収書を削除し、「完了」の事実だけを記録に残す。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { findUidByHealthId, writeAudit } from "@/lib/health";
import type { HealthRecord } from "@/lib/types";

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["hr"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const actor = authResult.value;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const healthId = (body as { healthId?: unknown })?.healthId;
  if (typeof healthId !== "string" || !/^[0-9a-f]{32}$/.test(healthId)) {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();

  try {
    const recordRef = db.collection("healthRecords").doc(healthId);
    const recordSnap = await recordRef.get();
    if (!recordSnap.exists) {
      return NextResponse.json(
        { error: "対象の記録が見つかりません。" },
        { status: 404 }
      );
    }
    const record = recordSnap.data() as HealthRecord;
    if (record.reexamStatus !== "submitted") {
      return NextResponse.json(
        { error: "この記録は確認待ちの状態ではありません。" },
        { status: 400 }
      );
    }

    // 完了確定＋領収書の即削除（企画書8-3：完了確認後すぐ削除）
    await Promise.all([
      recordRef.update({
        reexamStatus: "done",
        approvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
      db.collection("receipts").doc(healthId).delete(),
    ]);

    // 監査ログ（完了承認の証跡。対象者は uid で記録＝完了有無は管理者にも見えてよい範囲）
    const targetUid = await findUidByHealthId(db, healthId);
    await writeAudit(db, {
      action: "reexam_approved",
      actorId: actor.uid,
      targetUserId: targetUid ?? "(unknown)",
      before: { reexamStatus: "submitted" },
      after: { reexamStatus: "done", receiptDeleted: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("再検査の承認に失敗:", err);
    return NextResponse.json(
      { error: "承認中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
