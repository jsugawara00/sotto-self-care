// 取込記録の削除（本人の source: "imported" の checkins のみ）。
// 同一実施日の二重取込を拒否する仕様のため、誤取込をやり直す手段として必要。
// セルフチェック（daily_check）はふりかえりの履歴なので削除対象にしない。
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";

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
  const checkinId = (body as { checkinId?: unknown })?.checkinId;
  if (typeof checkinId !== "string" || checkinId.length === 0) {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();

  try {
    const ref = db.collection("checkins").doc(checkinId);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "記録が見つかりません。" }, { status: 404 });
    }
    const data = snap.data() as { userId?: string; source?: string };
    if (data.userId !== uid) {
      return NextResponse.json({ error: "この操作はできません。" }, { status: 403 });
    }
    if (data.source !== "imported") {
      return NextResponse.json(
        { error: "取込記録のみ削除できます。" },
        { status: 400 }
      );
    }
    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("取込記録の削除に失敗:", err);
    return NextResponse.json(
      { error: "削除中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
