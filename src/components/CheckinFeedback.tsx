"use client";

// 縦断フィードバック＋確認チャットの表示（指示書STEP2-5・2-6）。
// 本人トップと結果画面の両方で使う。
//  - aiFeedback：Cloud Functions が生成する縦断フィードバック（過去比較）
//  - checkQuestion：引っかかりがあるときだけ生成される「そっと問い返す」1問
//  - 返答は保存できれば十分（複雑な会話継続はSTEP2では作らない）
import { useState } from "react";
import type { User } from "firebase/auth";
import type { Checkin } from "@/lib/types";

const MAX_ANSWER_LENGTH = 300;

export function CheckinFeedback({
  checkinId,
  checkin,
  user,
}: {
  checkinId: string;
  checkin: Checkin;
  user: User;
}) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleReply = async () => {
    setError("");
    const text = answer.trim();
    if (!text) {
      setError("返答を入力してください。");
      return;
    }
    setSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/checkins/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ checkinId, answer: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "送信に失敗しました。");
      }
      // 表示の更新は親側の onSnapshot に任せる
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {checkin.aiFeedback ? (
        <div className="feedback-box">{checkin.aiFeedback}</div>
      ) : (
        <p className="muted">
          <span className="spinner" />
          フィードバックを生成しています…（少し時間がかかることがあります）
        </p>
      )}

      {checkin.checkQuestion && (
        <div className="gentle-ask">
          <div className="ask-head">ひとつだけ、聞かせてください</div>
          <p style={{ margin: "0 0 10px" }}>{checkin.checkQuestion}</p>

          {checkin.checkAnswer ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                あなたの返答：{checkin.checkAnswer}
              </p>
              {/* 返しの一言（Functions が生成。1往復半で静かに閉じる＝続きの入力欄は出さない） */}
              {checkin.checkReply && (
                <p style={{ margin: "10px 0 0" }}>{checkin.checkReply}</p>
              )}
            </>
          ) : (
            <>
              {error && <div className="error">{error}</div>}
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={MAX_ANSWER_LENGTH}
                placeholder="無理のない範囲で、ひとことで大丈夫です（任意）"
                style={{ minHeight: 72 }}
              />
              <button
                className="secondary"
                style={{ width: "auto" }}
                onClick={handleReply}
                disabled={submitting}
              >
                {submitting && <span className="spinner" />}
                返答を送る
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
