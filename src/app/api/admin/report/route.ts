// 期間指定レポート（STEP4・企画書8-5③）。admin / owner のみ。
// 内容は企画書7章の可視範囲そのまま：実施状況（誰が実施したかの有無まで）と
// 再検査の件数・完了率のみ。回答内容・診断数値・健診の中身は一切含めない。
// CSV生成・印刷はクライアント側（/admin/report）で行い、このAPIは集計データだけを返す。
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import { isHealthFeatureEnabled } from "@/lib/health";
import { TARGET_ROLES } from "@/lib/orgStats";
import { ROLE_LABELS, type HealthRecord, type UserProfile } from "@/lib/types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD"（JSTの暦日）→ その日のJST 0:00 を UTC の Date で返す
function jstDayStart(date: string): Date {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - JST_OFFSET_MS);
}

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["admin", "owner"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json(
      { error: "期間の指定が不正です。" },
      { status: 400 }
    );
  }
  const start = jstDayStart(from);
  const endExclusive = new Date(jstDayStart(to).getTime() + 24 * 60 * 60 * 1000);
  if (start.getTime() >= endExclusive.getTime()) {
    return NextResponse.json(
      { error: "終了日は開始日以降にしてください。" },
      { status: 400 }
    );
  }
  if (endExclusive.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return NextResponse.json(
      { error: `期間は${MAX_RANGE_DAYS}日以内で指定してください。` },
      { status: 400 }
    );
  }

  const db = getAdminDb();

  try {
    // 集計対象は現時点の対象者（listed=true の担当者・総務）。
    // 過去時点の在籍・一覧掲載は追跡していないため（仮決め・小規模前提）。
    const usersSnap = await db
      .collection("users")
      .where("listed", "==", true)
      .get();
    const targets = new Map<string, UserProfile>();
    usersSnap.docs.forEach((d) => {
      const profile = d.data() as UserProfile;
      if (TARGET_ROLES.includes(profile.role)) targets.set(d.id, profile);
    });

    // 期間内のセルフチェック実施回数（userId と source しか読まない）
    const checkinsSnap = await db
      .collection("checkins")
      .where("answeredAt", ">=", start)
      .where("answeredAt", "<", endExclusive)
      .select("userId", "source")
      .get();
    const counts = new Map<string, number>();
    checkinsSnap.docs.forEach((d) => {
      const data = d.data() as { userId?: string; source?: string };
      if (data.source === "imported") return;
      if (data.userId && targets.has(data.userId)) {
        counts.set(data.userId, (counts.get(data.userId) ?? 0) + 1);
      }
    });

    const rows = [...targets.entries()]
      .map(([uid, profile]) => ({
        name: profile.displayName,
        roleLabel: ROLE_LABELS[profile.role],
        count: counts.get(uid) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
    const doneCount = rows.filter((r) => r.count > 0).length;

    // 再検査（健康管理が有効な場合のみ）。対象＝期間内に保存された健診記録（仮決め）。
    // 仮名IDの件数集計のみ＝個人には結びつかない。
    let reexam: { required: number; done: number } | null = null;
    if (await isHealthFeatureEnabled(db)) {
      const recordsSnap = await db
        .collection("healthRecords")
        .where("createdAt", ">=", start)
        .where("createdAt", "<", endExclusive)
        .select("reexamRequired", "reexamStatus")
        .get();
      const requiredDocs = recordsSnap.docs.filter(
        (d) =>
          (d.data() as Pick<HealthRecord, "reexamRequired">).reexamRequired === true
      );
      reexam = {
        required: requiredDocs.length,
        done: requiredDocs.filter(
          (d) =>
            (d.data() as Pick<HealthRecord, "reexamStatus">).reexamStatus === "done"
        ).length,
      };
    }

    return NextResponse.json({
      from,
      to,
      total: targets.size,
      done: doneCount,
      rows,
      reexam,
    });
  } catch (err) {
    console.error("レポートの集計に失敗:", err);
    return NextResponse.json(
      { error: "レポートの集計中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
