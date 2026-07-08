// API Route 共通の本人確認ヘルパ。
// Authorization: Bearer <IDトークン> を検証し、必要なら users/{uid}（ロール）も取得する。
import { getAdminAuth, getAdminDb } from "./firebaseAdmin";
import type { Role, UserProfile } from "./types";

export type Verified = {
  uid: string;
  email: string | null;
};

export type VerifiedWithProfile = Verified & {
  profile: UserProfile;
};

// IDトークンを検証して uid / email を返す。失敗時は null。
export async function verifyBearer(request: Request): Promise<Verified | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(match[1]);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    return null;
  }
}

// IDトークン検証＋users/{uid} 取得。roles を指定した場合はロールも確認する。
// 失敗理由は status で区別（401=未認証、403=権限なし）。
export async function verifyBearerWithRole(
  request: Request,
  roles?: Role[]
): Promise<
  | { ok: true; value: VerifiedWithProfile }
  | { ok: false; status: 401 | 403; error: string }
> {
  const verified = await verifyBearer(request);
  if (!verified) {
    return { ok: false, status: 401, error: "認証に失敗しました。再度ログインしてください。" };
  }
  const snap = await getAdminDb().collection("users").doc(verified.uid).get();
  if (!snap.exists) {
    return { ok: false, status: 403, error: "この組織に所属していません。" };
  }
  const profile = snap.data() as UserProfile;
  if (roles && !roles.includes(profile.role)) {
    return { ok: false, status: 403, error: "この操作を行う権限がありません。" };
  }
  return { ok: true, value: { ...verified, profile } };
}
