// 抽出結果の確定保存（STEP3）。
// Functions(parseHealthDocument) は読取りだけ・保存はしない。本人が画面で内容を
// 確認してからこのAPIで保存する（Toika＝確かめる思想／誤読の混入防止）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { getHealthLink, isHealthFeatureEnabled, writeAudit } from "@/lib/health";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const uid = authResult.value.uid;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const { reexamRequired, notes, examDate, templateId } = body as {
    reexamRequired?: unknown;
    notes?: unknown;
    examDate?: unknown;
    templateId?: unknown;
  };
  if (
    typeof reexamRequired !== "boolean" ||
    typeof notes !== "string" ||
    notes.length > 500 ||
    typeof examDate !== "string" ||
    (examDate !== "" && !DATE_RE.test(examDate)) ||
    typeof templateId !== "string" ||
    !/^[a-z0-9-]+$/.test(templateId)
  ) {
    return NextResponse.json({ error: "保存内容が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();

  try {
    // 二重オプトインの確認
    if (!(await isHealthFeatureEnabled(db))) {
      return NextResponse.json(
        { error: "健康管理機能は現在有効になっていません。" },
        { status: 403 }
      );
    }
    const link = await getHealthLink(db, uid);
    if (!link || !link.optIn) {
      return NextResponse.json(
        { error: "健康管理機能の利用を開始してください。" },
        { status: 403 }
      );
    }

    // 新しい書類の保存＝再検査フローも新しいサイクルとして上書き
    // （進行中の提出があった場合も、古い領収書は残さない）
    await Promise.all([
      db.collection("healthRecords").doc(link.healthId).set({
        reexamRequired,
        notes: notes.trim(),
        examDate,
        templateId,
        reexamStatus: reexamRequired ? "pending" : "none",
        visitDate: "",
        submittedAt: null,
        approvedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
      db.collection("receipts").doc(link.healthId).delete(),
    ]);

    // 監査ログ（書類受領の証跡。機微な内容＝notesは残さない）
    await writeAudit(db, {
      action: "health_record_saved",
      actorId: uid,
      targetUserId: uid,
      before: null,
      after: { reexamRequired },
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("健康記録の保存に失敗:", err);
    return NextResponse.json(
      { error: "保存中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
