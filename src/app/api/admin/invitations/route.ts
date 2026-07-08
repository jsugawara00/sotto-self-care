// 招待の発行（指示書STEP1-2）。全権(owner)または管理者(admin)のみ。
// 発行は必ず auditLogs に記録する（指示書STEP1 厳守事項）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import type { Role } from "@/lib/types";

// 招待時に指定できる role初期値（owner は招待では付与しない＝仮決め。TODO.md参照）
const INVITABLE_ROLES: Role[] = ["member", "hr", "admin"];

// 最小限の形式チェック（@を1つ含み、ドメインに.を含む）
function isValidEmail(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  );
}

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

  const { email, role } = body as { email?: unknown; role?: unknown };
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { error: "メールアドレスの形式が正しくありません。" },
      { status: 400 }
    );
  }
  if (typeof role !== "string" || !INVITABLE_ROLES.includes(role as Role)) {
    return NextResponse.json(
      { error: "指定できないロールです。" },
      { status: 400 }
    );
  }

  const emailLower = email.toLowerCase();
  const db = getAdminDb();
  const inviteRef = db.collection("invitations").doc(emailLower);

  try {
    // 既存招待・既存ユーザーの重複チェック
    const [inviteSnap, userSnap] = await Promise.all([
      inviteRef.get(),
      db.collection("users").where("email", "==", emailLower).limit(1).get(),
    ]);
    if (!userSnap.empty) {
      return NextResponse.json(
        { error: "このメールアドレスは既に所属しています。" },
        { status: 409 }
      );
    }
    if (inviteSnap.exists) {
      return NextResponse.json(
        { error: "このメールアドレスには既に招待が発行されています。" },
        { status: 409 }
      );
    }

    const batch = db.batch();
    batch.set(inviteRef, {
      email: emailLower,
      role,
      status: "pending",
      invitedBy: actor.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    // 監査ログ（招待発行）
    batch.set(db.collection("auditLogs").doc(), {
      action: "invitation_created",
      actorId: actor.uid,
      targetUserId: emailLower, // まだ uid が無いためメールアドレスで記録
      before: null,
      after: { email: emailLower, role, status: "pending" },
      timestamp: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("招待の発行に失敗:", err);
    return NextResponse.json(
      { error: "招待の発行中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
