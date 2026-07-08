// 過去のストレスチェック結果の取込保存（設計確定 2026-07-07・TODO.md参照）。
// parseStressDocument は読取りだけ。本人が確認・訂正した値をこのAPIで checkins に保存する。
// source: "imported" を付けるため、Functions のフィードバック生成はスキップされ、
// 次回のセルフチェック時に縦断RAGの履歴として自然に参照される。
import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";

function isValidScore(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// セルフチェックと合算の累計上限（課金・暴走の保険。checkins/route.ts と同値）
const PER_USER_CHECKIN_LIMIT = 50;

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
  const { workload, mood, support, examDate, importNote } = body as {
    workload?: unknown;
    mood?: unknown;
    support?: unknown;
    examDate?: unknown;
    importNote?: unknown;
  };
  if (!isValidScore(workload) || !isValidScore(mood) || !isValidScore(support)) {
    return NextResponse.json(
      { error: "値が不正です（各項目は1〜4で指定してください）。" },
      { status: 400 }
    );
  }
  // 特徴の要約（任意）。読取り結果を本人が同意して含めたもののみ
  if (importNote !== undefined && typeof importNote !== "string") {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  const note = typeof importNote === "string" ? importNote.trim().slice(0, 300) : "";
  if (typeof examDate !== "string" || !DATE_RE.test(examDate)) {
    return NextResponse.json(
      { error: "実施日を入力してください。" },
      { status: 400 }
    );
  }
  // 実施日はJST正午として記録（縦断RAGの並び順に使うため日付だけあればよい）
  const answeredAt = new Date(`${examDate}T12:00:00+09:00`);
  if (Number.isNaN(answeredAt.getTime()) || answeredAt.getTime() > Date.now()) {
    return NextResponse.json(
      { error: "実施日が正しくありません（未来の日付は指定できません）。" },
      { status: 400 }
    );
  }

  const db = getAdminDb();

  try {
    // 累計上限＋同じ実施日の二重取込を1回の取得でチェック
    const snap = await db
      .collection("checkins")
      .where("userId", "==", userId)
      .orderBy("answeredAt", "desc")
      .limit(PER_USER_CHECKIN_LIMIT)
      .get();
    if (snap.size >= PER_USER_CHECKIN_LIMIT) {
      return NextResponse.json(
        { error: "記録数の上限に達しました。管理者にお問い合わせください。" },
        { status: 429 }
      );
    }
    const duplicated = snap.docs.some((d) => {
      const data = d.data();
      const at = data.answeredAt as Timestamp | undefined;
      return (
        data.source === "imported" &&
        at instanceof Timestamp &&
        at.toDate().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) ===
          examDate
      );
    });
    if (duplicated) {
      return NextResponse.json(
        { error: "同じ実施日の取込がすでにあります。" },
        { status: 409 }
      );
    }

    await db.collection("checkins").add({
      userId,
      answeredAt: Timestamp.fromDate(answeredAt),
      source: "imported",
      answers: { workload, mood, support },
      aiFeedback: "",
      checkQuestion: "",
      checkAnswer: "",
      ...(note ? { importNote: note } : {}),
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("取込の保存に失敗:", err);
    return NextResponse.json(
      { error: "保存中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
