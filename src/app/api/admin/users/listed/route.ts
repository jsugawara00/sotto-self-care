// 「一覧に載せる／載せない」トグル（指示書STEP1-5）。admin または owner が変更できる。
// ロール変更と同様に auditLogs へ記録する。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import type { UserProfile } from "@/lib/types";

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["admin", "owner"]);
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

  const { targetUserId, listed } = body as {
    targetUserId?: unknown;
    listed?: unknown;
  };
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return NextResponse.json({ error: "対象ユーザーが不正です。" }, { status: 400 });
  }
  if (typeof listed !== "boolean") {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();
  const targetRef = db.collection("users").doc(targetUserId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { ok: false as const, status: 404, error: "対象ユーザーが見つかりません。" };
      }
      const target = targetSnap.data() as UserProfile;
      if (target.listed === listed) {
        return { ok: false as const, status: 400, error: "変更がありません。" };
      }

      tx.update(targetRef, {
        listed,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("auditLogs").doc(), {
        action: "listed_change",
        actorId: actor.uid,
        targetUserId,
        before: { listed: target.listed },
        after: { listed },
        timestamp: FieldValue.serverTimestamp(),
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("一覧表示の変更に失敗:", err);
    return NextResponse.json(
      { error: "変更中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
