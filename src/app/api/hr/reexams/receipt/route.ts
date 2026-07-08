// 総務（hr）向け：領収書の閲覧（STEP3・企画書8-3「閲覧は総務限定」）。
// 領収書は承認と同時に削除されるため、閲覧できるのは確認待ちの間だけ。
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { verifyBearerWithRole } from "@/lib/apiAuth";
import type { Receipt } from "@/lib/types";

export async function GET(request: Request) {
  const authResult = await verifyBearerWithRole(request, ["hr"]);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  const healthId = new URL(request.url).searchParams.get("healthId") ?? "";
  if (!/^[0-9a-f]{32}$/.test(healthId)) {
    return NextResponse.json({ error: "指定が不正です。" }, { status: 400 });
  }

  try {
    const snap = await getAdminDb().collection("receipts").doc(healthId).get();
    if (!snap.exists) {
      return NextResponse.json(
        { error: "領収書が見つかりません（承認済みの場合は削除されています）。" },
        { status: 404 }
      );
    }
    const receipt = snap.data() as Receipt;
    return NextResponse.json({
      data: receipt.data,
      mimeType: receipt.mimeType,
    });
  } catch (err) {
    console.error("領収書の取得に失敗:", err);
    return NextResponse.json(
      { error: "取得中にエラーが発生しました。" },
      { status: 500 }
    );
  }
}
