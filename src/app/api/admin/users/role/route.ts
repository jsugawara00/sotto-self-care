// ロール変更（指示書STEP1-5）。ロールの付与／剥奪は全権(owner)のみ（企画書7章）。
// ガードレール：
//   - 管理者(admin/owner)が0人になる変更を禁止
//   - 全権(owner)が0人になる変更を禁止（誰もロールを直せなくなるため＝仮決め）
//   - 自分自身のロールを自分で昇格させることを禁止
// 変更確定と同時に auditLogs へ {actorId, targetUserId, before, after, timestamp} を記録する。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { ROLES, ROLE_RANK, type Role, type UserProfile } from "@/lib/types";

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["owner"]);
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

  const { targetUserId, role } = body as {
    targetUserId?: unknown;
    role?: unknown;
  };
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return NextResponse.json({ error: "対象ユーザーが不正です。" }, { status: 400 });
  }
  if (typeof role !== "string" || !ROLES.includes(role as Role)) {
    return NextResponse.json({ error: "指定できないロールです。" }, { status: 400 });
  }
  const newRole = role as Role;

  const db = getAdminDb();
  const targetRef = db.collection("users").doc(targetUserId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { ok: false as const, status: 404, error: "対象ユーザーが見つかりません。" };
      }
      const target = targetSnap.data() as UserProfile;
      const before = target.role;
      if (before === newRole) {
        return { ok: false as const, status: 400, error: "ロールに変更がありません。" };
      }

      // ガードレール1：自己昇格禁止
      if (
        targetUserId === actor.uid &&
        ROLE_RANK[newRole] > ROLE_RANK[before]
      ) {
        return {
          ok: false as const,
          status: 403,
          error: "自分自身のロールを昇格させることはできません。",
        };
      }

      // ガードレール2：管理者(admin/owner)ゼロ禁止・全権(owner)ゼロ禁止
      const adminsSnap = await tx.get(
        db.collection("users").where("role", "in", ["admin", "owner"])
      );
      const admins = adminsSnap.docs;
      const isTargetAdminish = before === "admin" || before === "owner";
      const willBeAdminish = newRole === "admin" || newRole === "owner";
      if (isTargetAdminish && !willBeAdminish && admins.length <= 1) {
        return {
          ok: false as const,
          status: 403,
          error: "管理者（admin/owner）が0人になる変更はできません。",
        };
      }
      const owners = admins.filter(
        (d) => (d.data() as UserProfile).role === "owner"
      );
      if (before === "owner" && newRole !== "owner" && owners.length <= 1) {
        return {
          ok: false as const,
          status: 403,
          error: "全権（owner）が0人になる変更はできません。",
        };
      }

      tx.update(targetRef, {
        role: newRole,
        updatedAt: FieldValue.serverTimestamp(),
      });
      // 監査ログ（指示書STEP1-5）
      tx.set(db.collection("auditLogs").doc(), {
        action: "role_change",
        actorId: actor.uid,
        targetUserId,
        before: { role: before },
        after: { role: newRole },
        timestamp: FieldValue.serverTimestamp(),
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("ロール変更に失敗:", err);
    return NextResponse.json(
      { error: "ロール変更中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
