// 最初の全権(owner)を用意する運用スクリプト（初期セットアップ専用）。
// 招待は owner/admin しか発行できないため、最初の1人だけはこのスクリプトで
// 「owner ロールの招待」を直接作成する（鶏と卵の解決）。
//  - まだログインしていないメールアドレス → owner 招待を作成（以後は通常のログインフローでOK）
//  - 既に users にいるメールアドレス → role を owner に更新
//
// 認証は .env.local（FIREBASE_ADMIN_*）から読み込む（試作の setAdmin.ts と同方式）。
//
// 実行方法（functions ディレクトリで）:
//   npm run set-owner -- user@example.com
import { readFileSync } from "fs";
import { resolve } from "path";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function loadEnvLocal(): Record<string, string> {
  const candidates = [
    resolve(__dirname, "../../.env.local"),
    resolve(process.cwd(), "../.env.local"),
    resolve(process.cwd(), ".env.local"),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8");
      const env: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        env[m[1]] = v;
      }
      return env;
    } catch {
      // 次の候補へ
    }
  }
  throw new Error(".env.local が見つかりません。");
}

async function main() {
  const emailArg = process.argv[2];
  if (!emailArg) {
    console.error("使い方: npm run set-owner -- <email>");
    process.exit(1);
  }
  const email = emailArg.toLowerCase();

  const env = loadEnvLocal();
  const projectId = env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("FIREBASE_ADMIN_* が .env.local に揃っていません。");
  }
  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }

  const db = getFirestore();

  // 既に所属済みなら role を owner に更新
  const userSnap = await db
    .collection("users")
    .where("email", "==", email)
    .limit(1)
    .get();
  if (!userSnap.empty) {
    const doc = userSnap.docs[0];
    const before = (doc.data() as { role?: string }).role ?? null;
    await doc.ref.update({
      role: "owner",
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection("auditLogs").add({
      action: "role_change",
      actorId: "system:set-owner",
      targetUserId: doc.id,
      before: { role: before },
      after: { role: "owner" },
      timestamp: FieldValue.serverTimestamp(),
    });
    console.log(`${email}（uid: ${doc.id}）の role を owner に更新しました。`);
    return;
  }

  // まだいない場合は owner 招待を作成（本人が Google でログインすると所属が確定する）
  await db.collection("invitations").doc(email).set({
    email,
    role: "owner",
    status: "pending",
    invitedBy: "system:set-owner",
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.collection("auditLogs").add({
    action: "invitation_created",
    actorId: "system:set-owner",
    targetUserId: email,
    before: null,
    after: { email, role: "owner", status: "pending" },
    timestamp: FieldValue.serverTimestamp(),
  });
  console.log(
    `${email} 宛の owner 招待を作成しました。このメールアドレスの Google アカウントでログインすると所属が確定します。`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("owner 設定に失敗しました:", err);
    process.exit(1);
  });
