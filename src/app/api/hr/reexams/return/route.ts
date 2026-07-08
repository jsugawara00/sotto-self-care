// 総務（hr）向け：提出内容の差し戻し（STEP4・構想メモ「再検査の差し戻し」）。
// 承認できない提出（受診日の誤り・領収書の不備等）を、理由の一言を添えて本人に戻す。
// 汎用チャットは作らない：コメントは1回だけ・200字まで（確認チャットと同じ「1回だけ」の型）。
// 領収書は差し戻しと同時に削除する（最小保持。再提出時に新しい領収書が必須のため支障なし）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { findUidByHealthId, writeAudit } from "@/lib/health";
import type { HealthRecord } from "@/lib/types";

const MAX_COMMENT_LENGTH = 200;

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
  const { healthId, comment } = body as {
    healthId?: unknown;
    comment?: unknown;
  };
  if (typeof healthId !== "string" || !/^[0-9a-f]{32}$/.test(healthId)) {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }
  // 理由は必須（本人が何を直せばよいか分からない差し戻しを作らない）
  const trimmedComment = typeof comment === "string" ? comment.trim() : "";
  if (trimmedComment.length === 0) {
    return NextResponse.json(
      { error: "差し戻しの理由を入力してください。" },
      { status: 400 }
    );
  }
  if (trimmedComment.length > MAX_COMMENT_LENGTH) {
    return NextResponse.json(
      { error: `理由は${MAX_COMMENT_LENGTH}文字以内で入力してください。` },
      { status: 400 }
    );
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

    // 差し戻し確定＋領収書の即削除（不備のある領収書を保持し続けない）
    await Promise.all([
      recordRef.update({
        reexamStatus: "returned",
        returnComment: trimmedComment,
        returnedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
      db.collection("receipts").doc(healthId).delete(),
    ]);

    // 監査ログ（差し戻しの証跡。理由コメントは機微になりうるため入れない＝notes と同じ扱い。
    // コメント本文は healthRecords 内にのみ保持し、本人と総務だけがAPI経由で読める）
    const targetUid = await findUidByHealthId(db, healthId);
    await writeAudit(db, {
      action: "reexam_returned",
      actorId: actor.uid,
      targetUserId: targetUid ?? "(unknown)",
      before: { reexamStatus: "submitted" },
      after: { reexamStatus: "returned", receiptDeleted: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("再検査の差し戻しに失敗:", err);
    return NextResponse.json(
      { error: "差し戻し中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
