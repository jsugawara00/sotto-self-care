// 案内への1タップ応答「確認しました」（STEP4・企画書8-4②「報告の仕組み化」）。
// 自由入力なし・1回だけの型（汎用チャットは作らない）。送信側には完了有無だけが見える。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import type { Announcement } from "@/lib/types";

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const { uid } = authResult.value;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const { id } = body as { id?: unknown };
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();

  try {
    const ref = db.collection("announcements").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json(
        { error: "対象の案内が見つかりません。" },
        { status: 404 }
      );
    }
    const announcement = snap.data() as Announcement;
    if (!announcement.recipientIds.includes(uid)) {
      return NextResponse.json(
        { error: "この案内の宛先ではありません。" },
        { status: 403 }
      );
    }
    // 既に確認済みなら何もしない（二重タップは成功扱い）
    if (!announcement.ackedIds.includes(uid)) {
      await ref.update({ ackedIds: FieldValue.arrayUnion(uid) });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("案内の確認応答に失敗:", err);
    return NextResponse.json(
      { error: "確認の送信中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
