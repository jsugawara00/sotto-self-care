// STEP2 の中核：checkins の新規作成(onCreate)をトリガーに、
//  1) 直近N回分の checkins を取得（データの器＝Firestore）
//  2) care-policy.md を読み込み（判断の物差し＝1つのmdファイル）
//  3) Claude API で縦断フィードバックを生成 → aiFeedback に書き戻し
//  4) 前回比の急変（引っかかり）があれば、非刺激的な確認質問を生成 → checkQuestion に書き戻し
// AI生成はここ＝Cloud Functions 側だけで行う（試作の方針を継承）。
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import type { Answers, HistoryEntry } from "./types";
import { loadCarePolicy } from "./carePolicy";
import { detectSuddenChange, detectBackgroundGap } from "./trigger";
import {
  SYSTEM_PROMPT,
  buildLongitudinalPrompt,
  buildCheckQuestionPrompt,
  buildBackgroundGapQuestionPrompt,
  buildCheckReplyPrompt,
  buildSafetyClassifyPrompt,
  CRISIS_REPLY,
} from "./prompt";
import { loadLabTemplate, loadStressTemplate } from "./labTemplates";
import {
  HEALTH_PARSE_SYSTEM_PROMPT,
  buildHealthParsePrompt,
} from "./healthPrompt";
import {
  STRESS_PARSE_SYSTEM_PROMPT,
  buildStressParsePrompt,
} from "./stressPrompt";

initializeApp();

// Claude API キーはサーバー側のみで保持する。
// 値は `firebase functions:secrets:set ANTHROPIC_API_KEY` で登録する（試作と共通）。
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// 縦断RAGの入力ウィンドウ：直近N回（仮に5。TODO.md参照）
const HISTORY_WINDOW = 5;

// 品質重視で opus を採用（試作の実測でhaikuは短文の脱字があったため）。
// コスト・速度を優先する場合は "claude-haiku-4-5-20251001" に1行で切替可。
const MODEL = "claude-opus-4-8";

// 1〜4 の整数バリデーション
function isValidScore(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4;
}

// Claude API を呼び、テキスト部分だけを取り出す
async function generateText(
  anthropic: Anthropic,
  userPrompt: string,
  system: string = SYSTEM_PROMPT
): Promise<string> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

// ===== STEP3：健診書類の読取り（企画書8-2） =====
//
// 設計方針：
//  - 書類ファイルはどこにも保存しない。この関数の中で Claude に渡して抽出結果だけを返す
//    （「未使用ならデータは残らない」の徹底。保存は本人が内容を確認してから別APIで行う）。
//  - 抽出は config-driven：knowledge/lab-templates/{templateId}.md の定義に従う。
//  - 書類は「データ」であって「指示」ではない（プロンプトに明記・企画書9章）。
//  - 拾うのは「精密検査要フラグ」と「注意事項」のみ。数値・グレードは抽出しない。

// 書類読取りの累計回数上限（1ユーザー・課金暴走の保険。チェック上限50回と同趣旨）
const PARSE_LIMIT = 20;
// 受け付けるファイル（base64で約8MBまで）
const MAX_FILE_BASE64_CHARS = 11_000_000;
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

export const parseHealthDocument = onCall(
  {
    region: "asia-northeast1",
    secrets: [ANTHROPIC_API_KEY],
    cors: true,
    memory: "512MiB", // base64の書類を扱うため既定(256MiB)から増量
    timeoutSeconds: 120,
  },
  async (request) => {
    // 1) 認証（Firebase Auth トークンは onCall が検証済み）＋所属確認
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const db = getFirestore();
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      throw new HttpsError("permission-denied", "この組織に所属していません。");
    }

    // 2) 二重オプトインの確認（企業側スイッチ＋本人オプトイン）
    const featureSnap = await db
      .collection("orgSettings")
      .doc("healthFeature")
      .get();
    if (featureSnap.data()?.enabled !== true) {
      throw new HttpsError(
        "failed-precondition",
        "健康管理機能は現在有効になっていません。"
      );
    }
    const linkRef = db.collection("healthLinks").doc(uid);
    const linkSnap = await linkRef.get();
    if (linkSnap.data()?.optIn !== true) {
      throw new HttpsError(
        "failed-precondition",
        "健康管理機能の利用を開始してから書類を読み取ってください。"
      );
    }

    // 3) 回数上限（課金暴走の保険。読取りの試行でカウントする）
    const parseCount = (linkSnap.data()?.parseCount as number | undefined) ?? 0;
    if (parseCount >= PARSE_LIMIT) {
      throw new HttpsError(
        "resource-exhausted",
        "書類読取りの回数上限に達しました。管理者にお問い合わせください。"
      );
    }

    // 4) 入力のバリデーション
    const { fileBase64, mimeType, templateId } = request.data as {
      fileBase64?: unknown;
      mimeType?: unknown;
      templateId?: unknown;
    };
    if (
      typeof fileBase64 !== "string" ||
      fileBase64.length === 0 ||
      fileBase64.length > MAX_FILE_BASE64_CHARS
    ) {
      throw new HttpsError(
        "invalid-argument",
        "ファイルが空か、サイズが大きすぎます（8MBまで）。"
      );
    }
    if (
      typeof mimeType !== "string" ||
      !ALLOWED_MIME_TYPES.includes(mimeType as AllowedMime)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "PDFまたは画像（JPEG/PNG/WebP）のみ読み取れます。"
      );
    }
    const tplId = typeof templateId === "string" ? templateId : "generic";
    const template = loadLabTemplate(tplId);
    if (!template) {
      throw new HttpsError("invalid-argument", "指定のテンプレがありません。");
    }

    await linkRef.update({
      parseCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 5) Claude で抽出（書類は保存しない・この呼び出しの中で使い切る）
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const fileBlock: Anthropic.ContentBlockParam =
      mimeType === "application/pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: fileBase64,
            },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/webp",
              data: fileBase64,
            },
          };

    let raw = "";
    try {
      // 注意：claude-opus-4-8 では temperature 等のサンプリングパラメータは廃止済み
      // （送ると400）。誤転記対策はプロンプト側の指示で行う。
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: HEALTH_PARSE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [fileBlock, { type: "text", text: buildHealthParsePrompt(template) }],
          },
        ],
      });
      raw = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    } catch (err) {
      logger.error("書類読取りのAPI呼び出しに失敗しました。", err);
      throw new HttpsError("internal", "書類の読取りに失敗しました。時間をおいて再度お試しください。");
    }

    // 6) 応答の検証（機微情報のためログには内容を残さない）。
    // JSONのみ出力するようプロンプトで指示しているが、対象外の書類を渡されたとき等に
    // 文章を混ぜて返すことがあるため、応答の中のJSONオブジェクト部分だけを取り出して解釈する。
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      try {
        if (start === -1 || end <= start) throw new Error("JSONが見つからない");
        parsed = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        logger.error("書類読取りの応答がJSONとして解釈できませんでした。", {
          uid,
          templateId: tplId,
          responseLength: raw.length,
        });
        throw new HttpsError("internal", "書類の読取り結果を解釈できませんでした。再度お試しください。");
      }
    }
    if (parsed.error === "not_health_document") {
      throw new HttpsError(
        "invalid-argument",
        "健康診断の結果通知書として読み取れませんでした。書類をご確認ください。"
      );
    }
    if (typeof parsed.reexamRequired !== "boolean") {
      throw new HttpsError("internal", "書類の読取り結果が不完全でした。再度お試しください。");
    }
    const notes =
      typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 500) : "";
    const examDate =
      typeof parsed.examDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.examDate)
        ? parsed.examDate
        : "";

    logger.info("健診書類を読み取りました（内容はログに残しません）。", {
      uid,
      templateId: tplId,
      reexamRequired: parsed.reexamRequired,
      notesLength: notes.length,
      hasExamDate: examDate.length > 0,
    });

    // 保存はしない：本人が画面で内容を確認してから /api/health/record で確定保存する
    return {
      reexamRequired: parsed.reexamRequired,
      notes,
      examDate,
      templateId: tplId,
    };
  }
);

// ===== ストレスチェック結果の取込読取り（設計確定 2026-07-07・TODO.md参照） =====
//
// 過去のストレスチェック結果書類から「3軸の1〜4正規化＋実施日」だけを抽出して返す。
// 書類は保存しない。保存は本人が確認・訂正してから /api/checkins/import で行う。
// 健康管理のオプトインとは独立（セルフケア領域の機能のため、所属ユーザーなら誰でも使える）。

// 取込読取りの累計回数上限（1ユーザー・課金暴走の保険。users.importCount で管理）
const IMPORT_PARSE_LIMIT = 20;

export const parseStressDocument = onCall(
  {
    region: "asia-northeast1",
    secrets: [ANTHROPIC_API_KEY],
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (request) => {
    // 1) 認証＋所属確認
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const db = getFirestore();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("permission-denied", "この組織に所属していません。");
    }

    // 2) 回数上限（読取りの試行でカウント）
    const importCount =
      (userSnap.data()?.importCount as number | undefined) ?? 0;
    if (importCount >= IMPORT_PARSE_LIMIT) {
      throw new HttpsError(
        "resource-exhausted",
        "取込の読取り回数の上限に達しました。管理者にお問い合わせください。"
      );
    }

    // 3) 入力のバリデーション（健診読取りと同じ制限）
    const { fileBase64, mimeType, templateId } = request.data as {
      fileBase64?: unknown;
      mimeType?: unknown;
      templateId?: unknown;
    };
    if (
      typeof fileBase64 !== "string" ||
      fileBase64.length === 0 ||
      fileBase64.length > MAX_FILE_BASE64_CHARS
    ) {
      throw new HttpsError(
        "invalid-argument",
        "ファイルが空か、サイズが大きすぎます（8MBまで）。"
      );
    }
    if (
      typeof mimeType !== "string" ||
      !ALLOWED_MIME_TYPES.includes(mimeType as AllowedMime)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "PDFまたは画像（JPEG/PNG/WebP）のみ読み取れます。"
      );
    }
    const tplId = typeof templateId === "string" ? templateId : "generic";
    const template = loadStressTemplate(tplId);
    if (!template) {
      throw new HttpsError("invalid-argument", "指定のテンプレがありません。");
    }

    await userRef.update({
      importCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 4) Claude で抽出（書類は保存しない）
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const fileBlock: Anthropic.ContentBlockParam =
      mimeType === "application/pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: fileBase64,
            },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/webp",
              data: fileBase64,
            },
          };

    let raw = "";
    try {
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: STRESS_PARSE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              fileBlock,
              { type: "text", text: buildStressParsePrompt(template) },
            ],
          },
        ],
      });
      raw = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    } catch (err) {
      logger.error("ストレスチェック読取りのAPI呼び出しに失敗しました。", err);
      throw new HttpsError(
        "internal",
        "書類の読取りに失敗しました。時間をおいて再度お試しください。"
      );
    }

    // 5) 応答の検証（内容はログに残さない）
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      try {
        if (start === -1 || end <= start) throw new Error("JSONが見つからない");
        parsed = JSON.parse(jsonText.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
      } catch {
        logger.error("ストレスチェック読取りの応答が解釈できませんでした。", {
          uid,
          templateId: tplId,
          responseLength: raw.length,
        });
        throw new HttpsError(
          "internal",
          "書類の読取り結果を解釈できませんでした。再度お試しください。"
        );
      }
    }
    if (parsed.error === "not_stress_check") {
      throw new HttpsError(
        "invalid-argument",
        "ストレスチェックの結果書類として読み取れませんでした。書類をご確認ください。"
      );
    }
    if (
      !isValidScore(parsed.workload) ||
      !isValidScore(parsed.mood) ||
      !isValidScore(parsed.support)
    ) {
      throw new HttpsError(
        "internal",
        "書類の読取り結果が不完全でした。再度お試しください。"
      );
    }
    const examDate =
      typeof parsed.examDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.examDate)
        ? parsed.examDate
        : "";
    // 特徴の要約（数値を貯めずに言葉で持つ＝設計②。含めるかどうかは本人が確認画面で選ぶ）
    const highlights =
      typeof parsed.highlights === "string"
        ? parsed.highlights.trim().slice(0, 300)
        : "";

    logger.info("ストレスチェック結果を読み取りました（内容はログに残しません）。", {
      uid,
      templateId: tplId,
      hasExamDate: examDate.length > 0,
      highlightsLength: highlights.length,
    });

    return {
      workload: parsed.workload,
      mood: parsed.mood,
      support: parsed.support,
      examDate,
      highlights,
      templateId: tplId,
    };
  }
);

// ===== チャットの返し（2本目のコア・設計合意 2026-07-07） =====
//
// 本人が確認チャットに返答（checkAnswer）を書いたら、受け止めの一言（checkReply）を
// 1回だけ生成して書き戻す。会話は「1問 → 返答 → 返し」の1往復半で静かに閉じる。
// 愚痴のはけ口にしない・感情を煽らない（care-policy のトーン規範にも明記済み）。
export const replyToCheckAnswer = onDocumentUpdated(
  {
    document: "checkins/{checkinId}",
    secrets: [ANTHROPIC_API_KEY],
    region: "asia-northeast1",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || !event.data) return;

    // 「返答がいま書かれた」更新にだけ反応する
    // （aiFeedback・checkQuestion の書き戻しや取込データでは動かない）
    const answer = after.checkAnswer as string | undefined;
    const answerBefore = before.checkAnswer as string | undefined;
    if (!answer || answerBefore) return;
    if (typeof after.checkReply === "string" && after.checkReply.length > 0) {
      return; // 多重実行の保険
    }
    if (after.source === "imported") return;
    const question = (after.checkQuestion as string | undefined) ?? "";
    if (!question) return;

    try {
      const carePolicy = loadCarePolicy();
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      // 安全判定（ダークサイド設計・方針合意 2026-07-07）。
      // 判定に失敗した場合はキーワードの保険で危機側に倒す。自動通報はどこにもしない。
      let category: "crisis" | "hostile" | "normal" = "normal";
      try {
        const raw = await generateText(
          anthropic,
          buildSafetyClassifyPrompt(answer.slice(0, 300)),
          "あなたは安全判定の分類器です。指示されたJSONのみを出力します。"
        );
        const jsonText = raw
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/, "");
        const start = jsonText.indexOf("{");
        const end = jsonText.lastIndexOf("}");
        const parsed = JSON.parse(
          start !== -1 && end > start ? jsonText.slice(start, end + 1) : jsonText
        ) as { category?: string };
        if (parsed.category === "crisis" || parsed.category === "hostile") {
          category = parsed.category;
        }
      } catch (err) {
        logger.error("安全判定に失敗したため、キーワードの保険に切り替えます。", err);
        const crisisKeywords = [
          "死にたい",
          "消えたい",
          "いなくなりたい",
          "自殺",
          "自傷",
          "死のう",
          "終わりにしたい",
        ];
        if (crisisKeywords.some((k) => answer.includes(k))) {
          category = "crisis";
        }
      }

      // 危機：AI生成を使わず、推敲済みの固定の安全メッセージを返して閉じる
      if (category === "crisis") {
        await event.data.after.ref.update({ checkReply: CRISIS_REPLY });
        logger.info(
          "危機のサインを検知し、固定の安全メッセージを返しました（内容はログに残しません）。",
          { checkinId: event.params.checkinId }
        );
        return;
      }
      if (category === "hostile") {
        logger.info("攻撃的な内容と判定（専用ルールで返しを生成します）。", {
          checkinId: event.params.checkinId,
        });
      }

      const reply = await generateText(
        anthropic,
        buildCheckReplyPrompt({
          question,
          answer: answer.slice(0, 300),
          feedback: (after.aiFeedback as string | undefined) ?? "",
          carePolicy,
          hostile: category === "hostile",
        })
      );
      if (!reply) {
        logger.error("チャットの返しの応答が空でした。", {
          checkinId: event.params.checkinId,
        });
        return;
      }
      await event.data.after.ref.update({ checkReply: reply });
      logger.info("チャットの返しを書き戻しました。", {
        checkinId: event.params.checkinId,
      });
    } catch (err) {
      // 返しの失敗は返答の保存自体を巻き込まない（返しが無くても成立する設計）
      logger.error("チャットの返しの生成に失敗しました。", err);
    }
  }
);

export const generateFeedbackOnCheckin = onDocumentCreated(
  {
    document: "checkins/{checkinId}",
    secrets: [ANTHROPIC_API_KEY],
    region: "asia-northeast1", // Firestore(asia-northeast1)とリージョンを揃える
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("スナップショットが空のため処理を中断します。");
      return;
    }

    const data = snap.data();
    const answers = data.answers as Answers | undefined;
    const userId = data.userId as string | undefined;

    // 取込データ（過去のストレスチェック結果）にはフィードバックを生成しない
    // （設計確定 2026-07-07：取込は履歴を豊かにするのが目的。次回チェック時に縦断RAGが参照する）
    if (data.source === "imported") {
      logger.info("取込データのためフィードバック生成をスキップします。", {
        checkinId: event.params.checkinId,
      });
      return;
    }

    // すでにフィードバックが生成済みなら何もしない（多重実行の保険）
    if (typeof data.aiFeedback === "string" && data.aiFeedback.length > 0) {
      logger.info("aiFeedback は既に存在するためスキップします。", {
        checkinId: event.params.checkinId,
      });
      return;
    }

    // 回答内容のバリデーション
    if (
      !userId ||
      !answers ||
      !isValidScore(answers.workload) ||
      !isValidScore(answers.mood) ||
      !isValidScore(answers.support)
    ) {
      logger.error("answers が不正のため処理を中断します。", {
        checkinId: event.params.checkinId,
      });
      return;
    }

    const db = getFirestore();

    try {
      // 1) 縦断RAG：対象ユーザーの直近N回分を取得（今回の分は除く）
      const historySnap = await db
        .collection("checkins")
        .where("userId", "==", userId)
        .orderBy("answeredAt", "desc")
        .limit(HISTORY_WINDOW + 1)
        .get();

      // 履歴（セルフチェック＋取込データ）。imported の区別はトリガー判定に使う
      const historyItems: { entry: HistoryEntry; imported: boolean }[] =
        historySnap.docs
          .filter((d) => d.id !== event.params.checkinId)
          .slice(0, HISTORY_WINDOW)
          .flatMap((d) => {
            const h = d.data();
            const a = h.answers as Answers | undefined;
            const at = h.answeredAt as Timestamp | undefined;
            if (
              !a ||
              !isValidScore(a.workload) ||
              !isValidScore(a.mood) ||
              !isValidScore(a.support)
            ) {
              return [];
            }
            const note =
              typeof h.importNote === "string" && h.importNote.length > 0
                ? h.importNote.slice(0, 300)
                : undefined;
            // 確認チャットでそのとき本人が話した内容（背景情報として語りに活かす）
            const chatAnswer =
              typeof h.checkAnswer === "string" && h.checkAnswer.length > 0
                ? h.checkAnswer.slice(0, 300)
                : undefined;
            return [
              {
                entry: {
                  answeredAt: at
                    ? at.toDate().toLocaleDateString("ja-JP", {
                        timeZone: "Asia/Tokyo",
                      })
                    : "日時不明",
                  answers: a,
                  ...(note ? { note } : {}),
                  ...(chatAnswer ? { chatAnswer } : {}),
                },
                imported: h.source === "imported",
              },
            ];
          });
      const history: HistoryEntry[] = historyItems.map((i) => i.entry);

      // 2) 判断の物差し（care-policy.md）を読み込む
      const carePolicy = loadCarePolicy();

      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      // 3) 縦断フィードバックの生成
      const feedback = await generateText(
        anthropic,
        buildLongitudinalPrompt({ current: answers, history, carePolicy })
      );
      if (!feedback) {
        logger.error("Claude API の応答が空でした（縦断フィードバック）。");
        return;
      }

      // 4) 確認チャット：2つのトリガー（優先順）
      //   a. 前回のセルフチェックと比べた急変（既存・STEP2-5）
      //   b. 取込資料と今回の回答の食い違い（コア設計②の拡張。今回はじめて現れた軸のみ）
      // どちらも該当しても質問は1つだけ（そっと、の思想）。
      let checkQuestion = "";
      const previousDaily =
        historyItems.find((i) => !i.imported)?.entry.answers ?? null;
      const importedItem = historyItems.find((i) => i.imported);
      const trigger = detectSuddenChange(previousDaily, answers);
      const backgroundGaps = detectBackgroundGap(
        importedItem?.entry.answers ?? null,
        previousDaily,
        answers
      );
      if (trigger.triggered && previousDaily) {
        logger.info("確認チャットのトリガー条件に該当（前回比の急変）。", {
          checkinId: event.params.checkinId,
          changedAxes: trigger.changedAxes,
        });
        try {
          checkQuestion = await generateText(
            anthropic,
            buildCheckQuestionPrompt({
              current: answers,
              previous: previousDaily,
              feedback, // フィードバックと角度をずらす（愚痴のはけ口にしない・感情を煽らない）
              carePolicy,
            })
          );
        } catch (err) {
          // 質問の生成失敗はフィードバック本体を巻き込まない
          logger.error("確認質問の生成に失敗しました。", err);
        }
      } else if (backgroundGaps.length > 0) {
        logger.info("確認チャットのトリガー条件に該当（取込資料との食い違い）。", {
          checkinId: event.params.checkinId,
          gapAxes: backgroundGaps.map((g) => g.axis),
        });
        try {
          checkQuestion = await generateText(
            anthropic,
            buildBackgroundGapQuestionPrompt({
              current: answers,
              gaps: backgroundGaps,
              note: importedItem?.entry.note,
              feedback, // フィードバックと角度をずらす（愚痴のはけ口にしない・感情を煽らない）
              carePolicy,
            })
          );
        } catch (err) {
          logger.error("確認質問の生成に失敗しました（食い違い）。", err);
        }
      }

      await snap.ref.update({ aiFeedback: feedback, checkQuestion });

      logger.info("フィードバックを書き戻しました。", {
        checkinId: event.params.checkinId,
        historyCount: history.length,
        hasCheckQuestion: checkQuestion.length > 0,
      });
    } catch (err) {
      logger.error("フィードバック生成中にエラーが発生しました。", err);
      // 画面側で気づけるようにはせず、aiFeedback を空のまま残して再試行可能性を残す（試作と同方針）。
    }
  }
);
