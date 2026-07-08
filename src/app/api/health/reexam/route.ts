// 再検査の受診報告（STEP3・企画書8-3）：本人が受診日＋領収書を提出する。
// 領収書は receipts/{healthId} に一時保持し、総務の承認と同時に削除される。
// 閲覧は総務（hr）のみ。admin/owner には見せない。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { getHealthLink, isHealthFeatureEnabled, writeAudit } from "@/lib/health";
import type { HealthRecord } from "@/lib/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Firestoreドキュメント上限(1MiB)に収める（画像はクライアント側で圧縮・PDFはそのまま上限チェック）
const MAX_RECEIPT_BASE64_CHARS = 900_000;
const ALLOWED_RECEIPT_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf", // 電子領収書・スキャン対応（サイズ上限内のみ）
];

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
  const { visitDate, receiptBase64, mimeType } = body as {
    visitDate?: unknown;
    receiptBase64?: unknown;
    mimeType?: unknown;
  };
  if (typeof visitDate !== "string" || !DATE_RE.test(visitDate)) {
    return NextResponse.json(
      { error: "受診日を入力してください。" },
      { status: 400 }
    );
  }
  if (
    typeof receiptBase64 !== "string" ||
    receiptBase64.length === 0 ||
    receiptBase64.length > MAX_RECEIPT_BASE64_CHARS
  ) {
    return NextResponse.json(
      { error: "領収書のファイルが空か、サイズが大きすぎます。" },
      { status: 400 }
    );
  }
  if (typeof mimeType !== "string" || !ALLOWED_RECEIPT_MIME.includes(mimeType)) {
    return NextResponse.json(
      { error: "領収書は画像（JPEG/PNG/WebP）またはPDFで添付してください。" },
      { status: 400 }
    );
  }

  const db = getAdminDb();

  try {
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

    const recordRef = db.collection("healthRecords").doc(link.healthId);
    const recordSnap = await recordRef.get();
    const record = recordSnap.exists ? (recordSnap.data() as HealthRecord) : null;
    if (!record || !record.reexamRequired) {
      return NextResponse.json(
        { error: "再検査の対象となる記録がありません。" },
        { status: 400 }
      );
    }
    // pending＝初回提出／submitted＝差し替え再提出／returned＝差し戻し後の再提出。
    // done後の提出は受け付けない
    if (
      record.reexamStatus !== "pending" &&
      record.reexamStatus !== "submitted" &&
      record.reexamStatus !== "returned"
    ) {
      return NextResponse.json(
        { error: "この再検査はすでに完了しています。" },
        { status: 400 }
      );
    }

    const receiptBytes = Math.floor(receiptBase64.length * 0.75);
    await Promise.all([
      db.collection("receipts").doc(link.healthId).set({
        data: receiptBase64,
        mimeType,
        size: receiptBytes,
        uploadedAt: FieldValue.serverTimestamp(),
      }),
      recordRef.update({
        reexamStatus: "submitted",
        visitDate,
        // 差し戻し理由は再提出で役目を終える（古い指摘を残して混乱させない）
        returnComment: FieldValue.delete(),
        returnedAt: FieldValue.delete(),
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    ]);

    // 監査ログ（提出の証跡。領収書の中身・受診先などは残さない）
    await writeAudit(db, {
      action: "reexam_submitted",
      actorId: uid,
      targetUserId: uid,
      before: { reexamStatus: record.reexamStatus },
      after: { reexamStatus: "submitted" },
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("再検査の提出に失敗:", err);
    return NextResponse.json(
      { error: "提出中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
