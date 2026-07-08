// 総務（hr）向け：再検査の一覧（STEP3・企画書8-3）。
// 総務の役割は「受領確認・領収書閲覧・完了承認」なので、
// 注意事項（notes）等の所見は返さない（本人のみ）。最小権限の徹底。
import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import type { HealthLink, HealthRecord, UserProfile } from "@/lib/types";

function toIso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

export async function GET(request: Request) {
  // 機微情報アクセスは総務限定（企画書7章）。admin/owner も不可。
  const authResult = await verifyBearerWithRole(request, ["hr"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  const db = getAdminDb();

  try {
    // 単一組織・小規模前提で healthLinks を全件走査（仮決め。規模が出たら要インデックス設計）
    const linksSnap = await db
      .collection("healthLinks")
      .where("optIn", "==", true)
      .get();

    const items: Array<{
      healthId: string;
      displayName: string;
      reexamStatus: string;
      examDate: string;
      visitDate: string;
      returnComment: string;
      submittedAt: string | null;
      approvedAt: string | null;
      hasReceipt: boolean;
    }> = [];

    for (const linkDoc of linksSnap.docs) {
      const link = linkDoc.data() as HealthLink;
      const [recordSnap, receiptSnap, userSnap] = await Promise.all([
        db.collection("healthRecords").doc(link.healthId).get(),
        db.collection("receipts").doc(link.healthId).get(),
        db.collection("users").doc(linkDoc.id).get(),
      ]);
      if (!recordSnap.exists) continue;
      const record = recordSnap.data() as HealthRecord;
      // 一覧に載せるのは再検査フローの対象者のみ
      if (!record.reexamRequired) continue;

      const user = userSnap.exists ? (userSnap.data() as UserProfile) : null;
      items.push({
        healthId: link.healthId,
        displayName: user?.displayName ?? "（不明なユーザー）",
        reexamStatus: record.reexamStatus,
        examDate: record.examDate,
        visitDate: record.visitDate,
        // 差し戻し理由は総務自身が書いたもの（何を伝えたか一覧で確認できるように返す）
        returnComment: record.returnComment ?? "",
        submittedAt: toIso(record.submittedAt),
        approvedAt: toIso(record.approvedAt),
        hasReceipt: receiptSnap.exists,
      });
    }

    // 確認待ち（submitted）を先頭に、差し戻し中→未完了→完了の順
    const order: Record<string, number> = {
      submitted: 0,
      returned: 1,
      pending: 2,
      done: 3,
    };
    items.sort(
      (a, b) => (order[a.reexamStatus] ?? 9) - (order[b.reexamStatus] ?? 9)
    );

    return NextResponse.json({ items });
  } catch (err) {
    console.error("再検査一覧の取得に失敗:", err);
    return NextResponse.json(
      { error: "取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
