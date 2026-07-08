// STEP3：健康管理のサーバー側共通ヘルパ（API Route から使用。クライアントには出さない）。
// PII分離（企画書9章）：healthLinks/{uid} が uid→仮名ID（healthId）の唯一のマッピング。
// healthRecords / receipts は healthId のみで引き、uid・氏名・メールを持たせない。
import { randomBytes } from "crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { AuditLog, HealthLink } from "./types";

// 仮名ID：ランダム32桁hex（推測・逆算不可。uidやメールから導出しない）
export function newHealthId(): string {
  return randomBytes(16).toString("hex");
}

// 二重オプトインの企業側スイッチ（orgSettings/healthFeature）
export async function isHealthFeatureEnabled(db: Firestore): Promise<boolean> {
  const snap = await db.collection("orgSettings").doc("healthFeature").get();
  return snap.data()?.enabled === true;
}

export async function getHealthLink(
  db: Firestore,
  uid: string
): Promise<HealthLink | null> {
  const snap = await db.collection("healthLinks").doc(uid).get();
  return snap.exists ? (snap.data() as HealthLink) : null;
}

// healthId の逆引き（総務の承認時に監査ログへ対象者を記録するために使用）
export async function findUidByHealthId(
  db: Firestore,
  healthId: string
): Promise<string | null> {
  const snap = await db
    .collection("healthLinks")
    .where("healthId", "==", healthId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

// 監査ログ（企画書9章：書類受領・完了承認は証跡を残す）。
// auditLogs は admin/owner も閲覧できるため、機微な内容（notes・領収書等）は入れない。
export async function writeAudit(
  db: Firestore,
  entry: Omit<AuditLog, "timestamp">
): Promise<void> {
  await db.collection("auditLogs").add({
    ...entry,
    timestamp: FieldValue.serverTimestamp(),
  });
}
