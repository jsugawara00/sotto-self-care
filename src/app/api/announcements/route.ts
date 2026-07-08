// 一括案内（STEP4・企画書8-4①③）。送信＝hr / admin / owner。
//  POST … 案内を作成して宛先を送信時点で確定（全員 or 今周期の未実施者のみ）
//  GET  … 送信済み一覧＋確認の完了有無（企画書7章「通知＝完了有無まで」）
// announcements はクライアント直アクセス不可（Rules全面deny）＝すべてこのAPI経由。
// 「メッセージは記録される」（8-4③）＝announcements ドキュメント自体が記録。
// 監査ログには本文を入れない（admin/owner も閲覧できる auditLogs には機微を入れない原則）。
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { writeAudit } from "@/lib/health";
import { getCheckTargets } from "@/lib/orgStats";
import type { Announcement, AnnouncementAudience } from "@/lib/types";

const MAX_TITLE_LENGTH = 50;
const MAX_BODY_LENGTH = 500;
const LIST_LIMIT = 20;

export async function POST(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["hr", "admin", "owner"]);
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
  const { title, body: text, audience } = body as {
    title?: unknown;
    body?: unknown;
    audience?: unknown;
  };

  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (trimmedTitle.length === 0 || trimmedText.length === 0) {
    return NextResponse.json(
      { error: "タイトルと本文を入力してください。" },
      { status: 400 }
    );
  }
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `タイトルは${MAX_TITLE_LENGTH}文字以内で入力してください。` },
      { status: 400 }
    );
  }
  if (trimmedText.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { error: `本文は${MAX_BODY_LENGTH}文字以内で入力してください。` },
      { status: 400 }
    );
  }
  if (audience !== "all" && audience !== "not_done") {
    return NextResponse.json({ error: "宛先の指定が不正です。" }, { status: 400 });
  }

  const db = getAdminDb();

  try {
    // 宛先を送信時点で確定（個人指定は作らない）。送信者自身には送らない（仮決め）。
    const { targets, doneIds } = await getCheckTargets(db);
    const recipientIds = [...targets.keys()].filter((uid) => {
      if (uid === actor.uid) return false;
      if (audience === "not_done" && doneIds.has(uid)) return false;
      return true;
    });
    if (recipientIds.length === 0) {
      return NextResponse.json(
        { error: "宛先に該当する人がいません。" },
        { status: 400 }
      );
    }

    const announcement: Announcement = {
      title: trimmedTitle,
      body: trimmedText,
      audience: audience as AnnouncementAudience,
      senderId: actor.uid,
      senderName: actor.profile.displayName,
      senderRole: actor.profile.role,
      recipientIds,
      ackedIds: [],
      createdAt: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection("announcements").add(announcement);

    // 監査ログ（企画書9章「通知」の証跡。本文・タイトルは入れない）
    await writeAudit(db, {
      action: "announcement_sent",
      actorId: actor.uid,
      targetUserId: "(broadcast)",
      before: null,
      after: {
        announcementId: ref.id,
        audience,
        recipientCount: recipientIds.length,
      },
    });

    return NextResponse.json({ ok: true, id: ref.id });
  } catch (err) {
    console.error("案内の送信に失敗:", err);
    return NextResponse.json(
      { error: "案内の送信中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["hr", "admin", "owner"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  const db = getAdminDb();

  try {
    const snap = await db
      .collection("announcements")
      .orderBy("createdAt", "desc")
      .limit(LIST_LIMIT)
      .get();

    // 宛先の表示名を解決（完了有無の一覧表示用。回答内容等の機微は含まれない）
    const uids = new Set<string>();
    snap.docs.forEach((d) => {
      (d.data() as Announcement).recipientIds.forEach((uid) => uids.add(uid));
    });
    const names = new Map<string, string>();
    await Promise.all(
      [...uids].map(async (uid) => {
        const userSnap = await db.collection("users").doc(uid).get();
        names.set(
          uid,
          userSnap.exists
            ? ((userSnap.data() as { displayName?: string }).displayName ?? "(不明)")
            : "(退職等で削除済み)"
        );
      })
    );

    const items = snap.docs.map((d) => {
      const a = d.data() as Announcement;
      const acked = new Set(a.ackedIds);
      return {
        id: d.id,
        title: a.title,
        body: a.body,
        audience: a.audience,
        senderName: a.senderName,
        createdAt:
          a.createdAt && typeof a.createdAt === "object" && "toDate" in a.createdAt
            ? (a.createdAt as { toDate: () => Date }).toDate().toISOString()
            : null,
        recipients: a.recipientIds.map((uid) => ({
          name: names.get(uid) ?? "(不明)",
          acked: acked.has(uid),
        })),
        ackedCount: a.ackedIds.length,
        recipientCount: a.recipientIds.length,
      };
    });

    return NextResponse.json({ items });
  } catch (err) {
    console.error("案内一覧の取得に失敗:", err);
    return NextResponse.json(
      { error: "案内一覧の取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
