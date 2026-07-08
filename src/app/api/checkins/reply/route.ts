// 確認チャットへの返答保存（指示書STEP2-5）。
// このSTEPでは「表示・保存できれば十分」のため、本人の checkin に checkAnswer を
// 1回だけ書き込む最小実装。複雑な会話継続ロジックは作らない。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";

// 自由入力は必要最小限に絞る方針のため、長さを制限する
const MAX_ANSWER_LENGTH = 300;

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const userId = authResult.value.uid;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }

  const { checkinId, answer } = body as { checkinId?: unknown; answer?: unknown };
  if (typeof checkinId !== "string" || checkinId.length === 0) {
    return NextResponse.json({ error: "対象が不正です。" }, { status: 400 });
  }
  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    answer.length > MAX_ANSWER_LENGTH
  ) {
    return NextResponse.json(
      { error: `返答は1〜${MAX_ANSWER_LENGTH}文字で入力してください。` },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const ref = db.collection("checkins").doc(checkinId);

  try {
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "対象が見つかりません。" }, { status: 404 });
    }
    const data = snap.data() as {
      userId?: string;
      checkQuestion?: string;
      checkAnswer?: string;
    };
    if (data.userId !== userId) {
      return NextResponse.json({ error: "権限がありません。" }, { status: 403 });
    }
    if (!data.checkQuestion) {
      return NextResponse.json(
        { error: "確認の質問がないため返答できません。" },
        { status: 400 }
      );
    }
    if (data.checkAnswer) {
      return NextResponse.json(
        { error: "既に返答済みです。" },
        { status: 409 }
      );
    }

    await ref.update({
      checkAnswer: answer.trim(),
      checkAnsweredAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("返答の保存に失敗:", err);
    return NextResponse.json(
      { error: "保存中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
