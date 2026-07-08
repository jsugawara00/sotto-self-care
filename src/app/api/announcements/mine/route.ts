// 自分宛ての未確認の案内（STEP4・企画書8-4）。home のお知らせ表示用。
// 「確認しました」を押すと一覧から消える＝状態から導出・対応後に自動消滅（notice-bar の型）。
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { ROLE_LABELS, type Announcement } from "@/lib/types";

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }
  const { uid } = authResult.value;

  const db = getAdminDb();

  try {
    const snap = await db
      .collection("announcements")
      .where("recipientIds", "array-contains", uid)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    const items = snap.docs
      .filter((d) => !(d.data() as Announcement).ackedIds.includes(uid))
      .map((d) => {
        const a = d.data() as Announcement;
        return {
          id: d.id,
          title: a.title,
          body: a.body,
          senderName: a.senderName,
          senderRoleLabel: ROLE_LABELS[a.senderRole],
          createdAt:
            a.createdAt && typeof a.createdAt === "object" && "toDate" in a.createdAt
              ? (a.createdAt as { toDate: () => Date }).toDate().toISOString()
              : null,
        };
      });

    return NextResponse.json({ items });
  } catch (err) {
    console.error("自分宛て案内の取得に失敗:", err);
    return NextResponse.json(
      { error: "お知らせの取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
