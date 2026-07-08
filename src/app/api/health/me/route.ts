// 本人の健康管理ステータス取得（STEP3）。
// healthRecords はクライアント直読み不可（Rules全面deny）のため、本人分もこのAPI経由で返す。
import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { getHealthLink, isHealthFeatureEnabled } from "@/lib/health";
import type { HealthRecord } from "@/lib/types";

function toIso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const uid = authResult.value.uid;
  const db = getAdminDb();

  try {
    const [featureEnabled, link] = await Promise.all([
      isHealthFeatureEnabled(db),
      getHealthLink(db, uid),
    ]);

    if (!link || !link.optIn) {
      return NextResponse.json({
        featureEnabled,
        optIn: false,
        record: null,
        hasReceipt: false,
      });
    }

    const [recordSnap, receiptSnap] = await Promise.all([
      db.collection("healthRecords").doc(link.healthId).get(),
      db.collection("receipts").doc(link.healthId).get(),
    ]);
    const record = recordSnap.exists ? (recordSnap.data() as HealthRecord) : null;

    return NextResponse.json({
      featureEnabled,
      optIn: true,
      record: record
        ? {
            reexamRequired: record.reexamRequired,
            notes: record.notes,
            examDate: record.examDate,
            templateId: record.templateId,
            reexamStatus: record.reexamStatus,
            visitDate: record.visitDate,
            returnComment: record.returnComment ?? "",
            submittedAt: toIso(record.submittedAt),
            approvedAt: toIso(record.approvedAt),
          }
        : null,
      hasReceipt: receiptSnap.exists,
    });
  } catch (err) {
    console.error("健康管理ステータスの取得に失敗:", err);
    return NextResponse.json(
      { error: "取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
