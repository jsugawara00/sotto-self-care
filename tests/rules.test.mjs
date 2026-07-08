// firestore.rules の直接検証（TODO.md 残テスト「Rulesの直接検証」）
// 実行方法（エミュレータを自動起動・終了）:
//   npx firebase emulators:exec --only firestore --project sotto-self-care "node tests/rules.test.mjs"
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "sotto-self-care",
  firestore: { rules: readFileSync("firestore.rules", "utf8") },
});

// ---- シードデータ（Rules を無効化した管理コンテキストで投入）----
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const seed = (path, data) => setDoc(doc(db, path), data);
  await Promise.all([
    seed("users/member1", { email: "m1@example.com", displayName: "Member1", role: "member", listed: true, onboarded: true }),
    seed("users/member2", { email: "m2@example.com", displayName: "Member2", role: "member", listed: true, onboarded: true }),
    seed("users/admin1",  { email: "a1@example.com", displayName: "Admin1",  role: "admin",  listed: false, onboarded: true }),
    seed("users/owner1",  { email: "o1@example.com", displayName: "Owner1",  role: "owner",  listed: false, onboarded: true }),
    seed("checkins/c-member1", { userId: "member1", scores: { mind: 3, body: 3, sleep: 3 }, createdAt: new Date() }),
    seed("checkins/c-member2", { userId: "member2", scores: { mind: 1, body: 1, sleep: 1 }, createdAt: new Date() }),
    seed("invitations/invited@example.com", { email: "invited@example.com", role: "member", used: false }),
    seed("auditLogs/log1", { action: "invite.create", actorUid: "owner1", createdAt: new Date() }),
    seed("orgSettings/default", { checkCycle: "weekly", updatedBy: "owner1", updatedAt: new Date() }),
    seed("orgSettings/healthFeature", { enabled: true, updatedBy: "owner1", updatedAt: new Date() }),
    // STEP3：健康管理の機微データ（PII分離。クライアント直アクセスは全面禁止のはず）
    seed("healthLinks/member1", { healthId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", optIn: true, parseCount: 0 }),
    seed("healthRecords/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { reexamRequired: true, notes: "要精密検査", examDate: "2026-07-01", templateId: "generic", reexamStatus: "submitted", visitDate: "2026-07-05" }),
    seed("receipts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { data: "dGVzdA==", mimeType: "image/jpeg", size: 4 }),
    // STEP4：一括案内（クライアント直アクセスは全面禁止のはず。読み書きはAPI経由のみ）
    seed("announcements/ann1", { title: "健康診断のご案内", body: "今月中に受診をお願いします。", audience: "all", senderId: "admin1", senderName: "Admin1", senderRole: "admin", recipientIds: ["member1", "member2"], ackedIds: [], createdAt: new Date() }),
  ]);
});

const asMember1 = testEnv.authenticatedContext("member1").firestore();
const asMember2 = testEnv.authenticatedContext("member2").firestore();
const asAdmin1  = testEnv.authenticatedContext("admin1").firestore();
const asOwner1  = testEnv.authenticatedContext("owner1").firestore();
const asNobody  = testEnv.authenticatedContext("stranger").firestore(); // ログイン済みだが users なし（所属なし）
const asAnon    = testEnv.unauthenticatedContext().firestore();

// ---- 簡易テストランナー ----
let pass = 0;
const failures = [];
async function test(name, promise) {
  try {
    await promise;
    pass++;
    console.log(`  OK   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  NG   ${name}\n       ${String(e.message).split("\n")[0]}`);
  }
}

console.log("\n[checkins] 個別回答の閲覧範囲（本丸）");
await test("member は自分の checkin を読める",
  assertSucceeds(getDoc(doc(asMember1, "checkins/c-member1"))));
await test("member は他人の checkin を読めない",
  assertFails(getDoc(doc(asMember1, "checkins/c-member2"))));
await test("admin でも個別の checkin は読めない",
  assertFails(getDoc(doc(asAdmin1, "checkins/c-member1"))));
await test("owner でも個別の checkin は読めない",
  assertFails(getDoc(doc(asOwner1, "checkins/c-member1"))));
await test("未ログインは checkin を読めない",
  assertFails(getDoc(doc(asAnon, "checkins/c-member1"))));
await test("member はクライアントから checkin を作成できない（書き込みはサーバーのみ）",
  assertFails(setDoc(doc(asMember1, "checkins/c-new"), { userId: "member1", scores: {} })));
await test("member は自分の checkin も更新できない",
  assertFails(updateDoc(doc(asMember1, "checkins/c-member1"), { scores: { mind: 5 } })));

console.log("\n[users] 権限モデルの背骨");
await test("member は自分の users doc を読める",
  assertSucceeds(getDoc(doc(asMember1, "users/member1"))));
await test("member は他人の users doc を読めない",
  assertFails(getDoc(doc(asMember1, "users/member2"))));
await test("admin は従業員一覧のため他人の users doc を読める",
  assertSucceeds(getDoc(doc(asAdmin1, "users/member1"))));
await test("member は自分の displayName / onboarded を更新できる",
  assertSucceeds(updateDoc(doc(asMember1, "users/member1"),
    { displayName: "新しい名前", onboarded: true, updatedAt: new Date() })));
await test("member は自分の role を変更できない（自己昇格の禁止）",
  assertFails(updateDoc(doc(asMember1, "users/member1"), { role: "owner" })));
await test("member は自分の listed を変更できない",
  assertFails(updateDoc(doc(asMember1, "users/member1"), { listed: false })));
await test("member は自分の email を変更できない",
  assertFails(updateDoc(doc(asMember1, "users/member1"), { email: "x@example.com" })));
await test("owner でもクライアントから他人の role を変更できない（変更はサーバーAPIのみ）",
  assertFails(updateDoc(doc(asOwner1, "users/member1"), { role: "admin" })));
await test("クライアントから users を新規作成できない（招待ゲートAPIのみ）",
  assertFails(setDoc(doc(asNobody, "users/stranger"),
    { email: "s@example.com", displayName: "S", role: "member", listed: true, onboarded: false })));
await test("クライアントから users を削除できない",
  assertFails(deleteDoc(doc(asOwner1, "users/member1"))));
await test("displayName を空文字にはできない",
  assertFails(updateDoc(doc(asMember1, "users/member1"),
    { displayName: "", onboarded: true, updatedAt: new Date() })));

console.log("\n[invitations / auditLogs] 管理者のみ閲覧・書き込みはサーバーのみ");
await test("member は invitations を読めない",
  assertFails(getDoc(doc(asMember1, "invitations/invited@example.com"))));
await test("admin は invitations を読める",
  assertSucceeds(getDoc(doc(asAdmin1, "invitations/invited@example.com"))));
await test("admin でもクライアントから invitations を書けない",
  assertFails(setDoc(doc(asAdmin1, "invitations/new@example.com"), { email: "new@example.com", role: "member", used: false })));
await test("member は auditLogs を読めない",
  assertFails(getDoc(doc(asMember1, "auditLogs/log1"))));
await test("owner は auditLogs を読める",
  assertSucceeds(getDoc(doc(asOwner1, "auditLogs/log1"))));
await test("owner でもクライアントから auditLogs を書けない",
  assertFails(setDoc(doc(asOwner1, "auditLogs/log2"), { action: "x" })));

console.log("\n[orgSettings] 周期設定");
await test("所属ありの member は orgSettings を読める（周期表示用）",
  assertSucceeds(getDoc(doc(asMember1, "orgSettings/default"))));
await test("所属なし（招待未通過）は orgSettings を読めない",
  assertFails(getDoc(doc(asNobody, "orgSettings/default"))));
await test("member は周期を変更できない",
  assertFails(updateDoc(doc(asMember1, "orgSettings/default"),
    { checkCycle: "daily", updatedBy: "member1", updatedAt: new Date() })));
await test("admin は正しい値で周期を変更できる",
  assertSucceeds(updateDoc(doc(asAdmin1, "orgSettings/default"),
    { checkCycle: "daily", updatedBy: "admin1", updatedAt: new Date() })));
await test("admin でも不正な周期の値は書けない",
  assertFails(updateDoc(doc(asAdmin1, "orgSettings/default"),
    { checkCycle: "hourly", updatedBy: "admin1", updatedAt: new Date() })));
await test("admin でも updatedBy を他人に偽装できない",
  assertFails(updateDoc(doc(asAdmin1, "orgSettings/default"),
    { checkCycle: "weekly", updatedBy: "owner1", updatedAt: new Date() })));
await test("orgSettings は削除できない",
  assertFails(deleteDoc(doc(asAdmin1, "orgSettings/default"))));

console.log("\n[orgSettings/healthFeature] 健康管理の企業側スイッチ（STEP3）");
await test("所属ありの member は healthFeature を読める（機能表示の判定用）",
  assertSucceeds(getDoc(doc(asMember1, "orgSettings/healthFeature"))));
await test("所属なしは healthFeature を読めない",
  assertFails(getDoc(doc(asNobody, "orgSettings/healthFeature"))));
await test("member は healthFeature を変更できない",
  assertFails(updateDoc(doc(asMember1, "orgSettings/healthFeature"),
    { enabled: false, updatedBy: "member1", updatedAt: new Date() })));
await test("admin は healthFeature を変更できる",
  assertSucceeds(updateDoc(doc(asAdmin1, "orgSettings/healthFeature"),
    { enabled: false, updatedBy: "admin1", updatedAt: new Date() })));
await test("admin でも enabled 以外の余計なキーは書けない",
  assertFails(updateDoc(doc(asAdmin1, "orgSettings/healthFeature"),
    { enabled: true, extra: "x", updatedBy: "admin1", updatedAt: new Date() })));

console.log("\n[healthLinks / healthRecords / receipts] 機微データはクライアント直アクセス全面禁止（STEP3・PII分離）");
await test("member は自分の healthLinks も直接読めない（アクセスはAPI経由のみ）",
  assertFails(getDoc(doc(asMember1, "healthLinks/member1"))));
await test("member は自分の healthRecords も直接読めない",
  assertFails(getDoc(doc(asMember1, "healthRecords/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))));
await test("hr ロールでも healthRecords を直接読めない（閲覧はAPI経由のみ）",
  assertFails(getDoc(doc(asMember2, "healthRecords/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))));
await test("admin は healthRecords を読めない（診断内容は管理者に不可視）",
  assertFails(getDoc(doc(asAdmin1, "healthRecords/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))));
await test("owner でも receipts（領収書）を読めない（閲覧は総務のAPIのみ）",
  assertFails(getDoc(doc(asOwner1, "receipts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))));
await test("member は healthRecords に書き込めない",
  assertFails(updateDoc(doc(asMember1, "healthRecords/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    { reexamStatus: "done" })));
await test("member は healthLinks を作成できない",
  assertFails(setDoc(doc(asMember2, "healthLinks/member2"),
    { healthId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", optIn: true, parseCount: 0 })));

console.log("\n[announcements] 一括案内はクライアント直アクセス全面禁止（STEP4）");
await test("宛先の member でも announcements を直接読めない（閲覧はAPI経由のみ）",
  assertFails(getDoc(doc(asMember1, "announcements/ann1"))));
await test("admin でも announcements を直接読めない",
  assertFails(getDoc(doc(asAdmin1, "announcements/ann1"))));
await test("member は ackedIds を直接書き換えられない（確認応答はAPI経由のみ）",
  assertFails(updateDoc(doc(asMember1, "announcements/ann1"), { ackedIds: ["member1"] })));
await test("owner でもクライアントから announcements を作成できない（送信はAPI経由のみ）",
  assertFails(setDoc(doc(asOwner1, "announcements/ann2"),
    { title: "x", body: "y", audience: "all", senderId: "owner1", senderName: "Owner1", senderRole: "owner", recipientIds: ["member1"], ackedIds: [], createdAt: new Date() })));

await testEnv.cleanup();

const total = pass + failures.length;
console.log(`\n結果: ${pass}/${total} 件成功`);
if (failures.length > 0) {
  console.log("失敗したテスト:");
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
