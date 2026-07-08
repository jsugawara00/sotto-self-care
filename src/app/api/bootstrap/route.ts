// 招待ゲート（指示書STEP1-2）：
// Googleログイン直後に呼ばれ、招待されたメールアドレスのときだけ users/{uid} を作成する。
// 招待なしのログインは 403（所属なし）で弾く。users の新規作成はこのAPI（Admin SDK）だけが行い、
// クライアントからの作成は Security Rules で禁止している（二重の門）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearer } from "@/lib/apiAuth";
import type { Invitation } from "@/lib/types";

export async function POST(request: Request) {
  const verified = await verifyBearer(request);
  if (!verified) {
    return NextResponse.json(
      { error: "認証に失敗しました。再度ログインしてください。" },
      { status: 401 }
    );
  }

  const db = getAdminDb();
  const userRef = db.collection("users").doc(verified.uid);

  try {
    // 既に所属済みなら何もしない
    const existing = await userRef.get();
    if (existing.exists) {
      return NextResponse.json({ created: false }, { status: 200 });
    }

    const email = verified.email?.toLowerCase();
    if (!email) {
      return NextResponse.json(
        { error: "メールアドレスが取得できませんでした。" },
        { status: 403 }
      );
    }

    // 招待レコードを確認（ドキュメントIDは小文字化したメールアドレス）
    const inviteRef = db.collection("invitations").doc(email);

    const created = await db.runTransaction(async (tx) => {
      const inviteSnap = await tx.get(inviteRef);
      if (!inviteSnap.exists) return false;
      const invite = inviteSnap.data() as Invitation;
      if (invite.status !== "pending") return false;

      // Google から氏名・メールを自動取得（指示書STEP1-3）
      const userRecord = await getAdminAuth().getUser(verified.uid);

      tx.set(userRef, {
        email,
        displayName: userRecord.displayName ?? email,
        role: invite.role,
        listed: true,
        onboarded: false, // 初回ログイン→オンボーディング画面へ誘導
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(inviteRef, {
        status: "accepted",
        acceptedAt: FieldValue.serverTimestamp(),
        acceptedUid: verified.uid,
      });
      return true;
    });

    if (!created) {
      // 招待なし＝所属なしとして弾く（アプリにデータは一切作らない）
      return NextResponse.json(
        { error: "この組織に招待されていないアカウントです。" },
        { status: 403 }
      );
    }

    return NextResponse.json({ created: true }, { status: 201 });
  } catch (err) {
    console.error("bootstrap に失敗:", err);
    return NextResponse.json(
      { error: "所属確認中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
