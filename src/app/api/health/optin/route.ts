// 本人オプトインの設定（STEP3・二重オプトインの本人側）。
// 解除時は healthRecords / receipts を削除する（企画書8-2「未使用ならデータは残らない」）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import {
  getHealthLink,
  isHealthFeatureEnabled,
  newHealthId,
  writeAudit,
} from "@/lib/health";

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
  const optIn = (body as { optIn?: unknown })?.optIn;
  if (typeof optIn !== "boolean") {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }

  const db = getAdminDb();
  const linkRef = db.collection("healthLinks").doc(uid);

  try {
    if (optIn) {
      // 企業側スイッチがOFFのままでは本人オプトインできない（二重オプトイン）
      if (!(await isHealthFeatureEnabled(db))) {
        return NextResponse.json(
          { error: "健康管理機能は現在有効になっていません。" },
          { status: 403 }
        );
      }
      const link = await getHealthLink(db, uid);
      if (link) {
        await linkRef.update({
          optIn: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        await linkRef.set({
          healthId: newHealthId(),
          optIn: true,
          parseCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return NextResponse.json({ ok: true, optIn: true });
    }

    // オプトイン解除：機微データを削除し、事実だけを監査ログに残す
    const link = await getHealthLink(db, uid);
    if (link) {
      const recordRef = db.collection("healthRecords").doc(link.healthId);
      const receiptRef = db.collection("receipts").doc(link.healthId);
      const hadData = (await recordRef.get()).exists;
      await Promise.all([recordRef.delete(), receiptRef.delete()]);
      await linkRef.update({
        optIn: false,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (hadData) {
        await writeAudit(db, {
          action: "health_data_deleted",
          actorId: uid,
          targetUserId: uid,
          before: { hadRecord: true },
          after: { deleted: true },
        });
      }
    }
    return NextResponse.json({ ok: true, optIn: false });
  } catch (err) {
    console.error("オプトインの更新に失敗:", err);
    return NextResponse.json(
      { error: "更新中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
