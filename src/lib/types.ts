// アプリ全体で共有する型定義（リメイク版）

// 4段階ロール（指示書STEP1-4。正式名称は憲章フェーズで確定＝仮）
//  member（担当者）… 自分のデータのみ
//  hr（総務）……… STEP3で再検査の受領確認等に使用（権限定義のみ先行）
//  admin（管理者）… 実施状況・一覧の閲覧のみ（個別回答・診断数値は不可視）
//  owner（全権）…… ロールの付与／剥奪
export type Role = "member" | "hr" | "admin" | "owner";

export const ROLES: Role[] = ["member", "hr", "admin", "owner"];

// ロールの序列（自己昇格禁止の判定に使用）
export const ROLE_RANK: Record<Role, number> = {
  member: 0,
  hr: 1,
  admin: 2,
  owner: 3,
};

export const ROLE_LABELS: Record<Role, string> = {
  member: "担当者",
  hr: "総務",
  admin: "管理者",
  owner: "全権",
};

// users/{uid} のドキュメント構造
export type UserProfile = {
  email: string;
  displayName: string;
  role: Role;
  listed: boolean; // 従業員一覧に載せる／載せない
  onboarded: boolean; // 初回オンボーディング完了フラグ
  demoExempt?: boolean; // 使用制限の免除フラグ（運用アカウント=Toika/Jump 等は従来上限を維持。一般のお試しは縮小上限）
  createdAt?: unknown; // Firestore Timestamp
  updatedAt?: unknown;
};

// invitations/{emailLower} のドキュメント構造（指示書STEP1-2）
export type Invitation = {
  email: string;
  role: Role; // role初期値
  status: "pending" | "accepted";
  invitedBy: string; // 発行者 uid
  createdAt?: unknown;
  acceptedAt?: unknown;
  acceptedUid?: string;
};

// auditLogs のドキュメント構造（指示書STEP1-5／企画書9章：書類受領・完了承認も証跡を残す）
export type AuditLog = {
  action:
    | "role_change"
    | "listed_change"
    | "invitation_created"
    | "health_record_saved" // 健診書類の抽出結果を本人が保存（書類受領）
    | "reexam_submitted" // 再検査の受診日＋領収書を本人が提出
    | "reexam_approved" // 総務が受領確認して完了確定
    | "reexam_returned" // 総務が差し戻し（理由コメントは機微になりうるためログには入れない）
    | "health_data_deleted" // 本人のオプトイン解除による健康データ削除
    | "announcement_sent"; // 一括案内の送信（企画書9章「通知」の証跡。本文は announcements 側が記録を担う）
  actorId: string;
  targetUserId: string; // 招待発行時は招待メールアドレス
  before: unknown;
  after: unknown;
  timestamp?: unknown;
};

// ストレスチェックの周期（指示書STEP2-1）
export type CheckCycle = "daily" | "weekly" | "monthly" | "yearly";

export const CHECK_CYCLES: CheckCycle[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
];

export const CYCLE_LABELS: Record<CheckCycle, string> = {
  daily: "毎日",
  weekly: "毎週",
  monthly: "毎月",
  yearly: "毎年",
};

// orgSettings/default のドキュメント構造（今回は単一組織想定）
export type OrgSettings = {
  checkCycle: CheckCycle;
  updatedBy?: string;
  updatedAt?: unknown;
};

// 3問の回答スコア（各 1〜4・試作から継承）
export type Answers = {
  workload: number; // 仕事のストレス要因（高いほど負担が大きい）
  mood: number; // 心身のストレス反応（高いほど心身が好調）
  support: number; // 周囲のサポート（高いほどサポートが得られている）
};

// ===== STEP3：健康管理（書類読取り・再検査フロー）＝企画書8-2・8-3・9章 =====

// 再検査の進行状態（企画書8-3のフロー＋STEP4の差し戻し）
//  none      … 再検査フラグなし（指導区分5が検出されていない）
//  pending   … 精密検査要を検出＝未完了（受診と提出待ち）
//  submitted … 本人が受診日＋領収書を提出済み（総務の受領確認待ち）
//  returned  … 総務が差し戻し（理由コメント付き・本人の再提出待ち。領収書は削除済み）
//  done      … 総務が承認して完了確定（領収書は削除済み）
export type ReexamStatus = "none" | "pending" | "submitted" | "returned" | "done";

export const REEXAM_STATUS_LABELS: Record<ReexamStatus, string> = {
  none: "対象なし",
  pending: "未完了（受診をお願いします）",
  submitted: "提出済み（総務の確認待ち）",
  returned: "差し戻し（再提出をお願いします）",
  done: "完了",
};

// healthLinks/{uid}：uid と仮名ID（healthId）のマッピング（企画書9章 PII分離）。
// クライアントからは読み書き不可（Rules全面deny）。アクセスはすべてサーバーAPI経由。
export type HealthLink = {
  healthId: string; // ランダム生成の仮名ID
  optIn: boolean; // 本人オプトイン（二重オプトインの本人側）
  parseCount: number; // 書類読取りの累計回数（課金暴走の保険）
  createdAt?: unknown;
  updatedAt?: unknown;
};

// healthRecords/{healthId}：機微データ本体。uid・氏名・メールは一切持たせない
// （単体漏洩では個人に結びつかない）。クライアント直アクセス不可。
export type HealthRecord = {
  reexamRequired: boolean; // 指導区分5（精密検査要）フラグ。グレードそのものは保持しない
  notes: string; // 書類の注意事項テキスト（抽出結果・本人確認済みのもの）
  examDate: string; // 健診の受診日 "YYYY-MM-DD"（不明なら空文字）
  templateId: string; // 読取りに使った検査機関テンプレのID
  reexamStatus: ReexamStatus;
  visitDate: string; // 再検査の受診日（本人入力・"YYYY-MM-DD"）
  returnComment?: string; // 差し戻し理由（総務の一言・本人向け表示用。auditLogs には入れない）
  submittedAt?: unknown;
  approvedAt?: unknown;
  returnedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

// receipts/{healthId}：領収書（写真またはPDF・base64）。総務の受領確認まで一時保持し、
// 承認と同時に削除する（企画書8-3：完了確認後すぐ削除／閲覧は総務限定）。
export type Receipt = {
  data: string; // base64（写真は圧縮済み・PDFは上限650KB程度まで）
  mimeType: string;
  size: number; // 元ファイルのバイト数
  uploadedAt?: unknown;
};

// orgSettings/healthFeature：二重オプトインの企業側スイッチ（デフォルトOFF）
export type HealthFeatureSettings = {
  enabled: boolean;
  updatedBy?: string;
  updatedAt?: unknown;
};

// 書類読取り（Cloud Functions parseHealthDocument）の抽出結果。
// 保存前に本人が内容を確認してから /api/health/record へ送る（確かめる思想）。
export type ParsedHealthDocument = {
  reexamRequired: boolean;
  notes: string;
  examDate: string;
  templateId: string;
};

// ストレスチェック結果書類の読取り結果（parseStressDocument）。
// 本人が確認・訂正してから /api/checkins/import で保存する。
export type ParsedStressCheck = {
  workload: number;
  mood: number;
  support: number;
  examDate: string; // "YYYY-MM-DD" or ""
  highlights: string; // 際立つ尺度の短い要約（数値は持たず言葉で。なければ空文字）
  templateId: string;
};

// ===== STEP4：通知・報告（企画書8-4） =====

// 一括案内の宛先種別（送信時点で宛先を確定する。個人指定は作らない＝狙い撃ちを防ぐ）
//  all      … 集計対象者（一覧に載せている担当者・総務）全員
//  not_done … 今周期のチェック未実施者のみ（リマインド用途）
export type AnnouncementAudience = "all" | "not_done";

export const AUDIENCE_LABELS: Record<AnnouncementAudience, string> = {
  all: "対象者全員",
  not_done: "今周期のセルフチェック未実施者のみ",
};

// announcements/{id}：一括案内（企画書8-4①②③）。
// クライアント直アクセスは Rules で全面禁止＝読み書きはすべてサーバーAPI経由。
// 「メッセージは記録される」（8-4③ ハラスメント抑止思想）＝このドキュメント自体が記録。
export type Announcement = {
  title: string; // 上限50字
  body: string; // 上限500字
  audience: AnnouncementAudience;
  senderId: string;
  senderName: string; // 受信者への表示用（送信時点の表示名）
  senderRole: Role; // 受信者への表示用
  recipientIds: string[]; // 送信時点で確定した宛先 uid（送信者自身は含めない）
  ackedIds: string[]; // 「確認しました」済みの uid（＝報告の仕組み化。完了有無まで）
  createdAt?: unknown;
};

// checkins コレクションのドキュメント構造
// source: daily_check＝アプリ内のセルフチェック／imported＝過去のストレスチェック結果の取込
export type Checkin = {
  userId: string;
  answeredAt: unknown; // Firestore Timestamp
  source: "daily_check" | "imported";
  answers: Answers;
  aiFeedback: string; // 縦断フィードバック（Functions が後から追記）
  checkQuestion: string; // 確認チャットの質問（該当時のみ Functions が追記）
  checkAnswer: string; // 確認チャットへの本人の返答（任意）
  checkReply?: string; // 返答への「返しの一言」（Functions が後から追記。1往復半で閉じる）
  importNote?: string; // 取込時に本人が同意した「特徴の要約」（imported のみ・任意）
};
