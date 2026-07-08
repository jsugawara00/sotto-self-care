// 回答保存 API（試作の方式を継承）。
// 役割は「checkins に保存するだけ」。AI生成（縦断RAG・確認チャット）は
// Cloud Functions の onCreate に任せる。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";

// 1〜4 の整数かどうかを検証する
function isValidScore(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4;
}

// 1アカウント当たりのチェック回数の上限（暴走・課金対策のレート制限。試作から継承）。
// お試しデモ方針（2026-07-09）：一般アカウントは絞る。セルフチェックは
// お試しで数回触れる想定＝実勢と同じ 7回 とする（読取り系は別途 2回）。
// ただし demoExempt（Toika/Jump 等の運用アカウント）は従来の上限を維持する。
const CHECKIN_LIMIT_DEMO = 7;
const CHECKIN_LIMIT_FULL = 50;

export async function POST(request: Request) {
  // 所属済みユーザーのみ（招待ゲートを通っていないアカウントは 403）
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const userId = authResult.value.uid;
  // demoExempt の運用アカウントだけ従来上限。一般のお試しは縮小上限。
  const checkinLimit = authResult.value.profile.demoExempt
    ? CHECKIN_LIMIT_FULL
    : CHECKIN_LIMIT_DEMO;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }

  const answers = (body as { answers?: Record<string, unknown> })?.answers;
  if (
    !answers ||
    !isValidScore(answers.workload) ||
    !isValidScore(answers.mood) ||
    !isValidScore(answers.support)
  ) {
    return NextResponse.json(
      { error: "回答内容が不正です（各項目は1〜4で回答してください）。" },
      { status: 400 }
    );
  }

  const db = getAdminDb();

  // レート制限：累計チェック数が上限に達していたら拒否する。
  try {
    const countSnap = await db
      .collection("checkins")
      .where("userId", "==", userId)
      .count()
      .get();
    if (countSnap.data().count >= checkinLimit) {
      return NextResponse.json(
        { error: "チェック回数の上限に達しました。管理者にお問い合わせください。" },
        { status: 429 }
      );
    }
  } catch (err) {
    // 回数取得に失敗しても保存自体は続行する（可用性優先）。上限は保険的な位置づけ。
    console.error("チェック回数の取得に失敗（保存は続行）:", err);
  }

  try {
    const docRef = await db.collection("checkins").add({
      userId,
      answeredAt: FieldValue.serverTimestamp(),
      source: "daily_check",
      answers: {
        workload: answers.workload,
        mood: answers.mood,
        support: answers.support,
      },
      aiFeedback: "",
      checkQuestion: "",
      checkAnswer: "",
    });

    return NextResponse.json({ checkinId: docRef.id }, { status: 201 });
  } catch (err) {
    console.error("checkins への保存に失敗:", err);
    return NextResponse.json(
      { error: "保存中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
