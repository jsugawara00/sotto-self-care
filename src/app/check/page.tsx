"use client";

// 簡易チェック画面（試作から継承）。3問に回答して送信すると API Route 経由で checkins に保存する。
// 保存後の縦断フィードバック・確認チャットの生成は Cloud Functions が行う。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/AuthContext";
import { QUESTIONS, type QuestionKey } from "@/lib/questions";

export default function CheckPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [answers, setAnswers] = useState<Partial<Record<QuestionKey, number>>>({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 未ログインならログイン画面へ。管理者は管理画面へ。
  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (profile && (profile.role === "admin" || profile.role === "owner")) {
      router.replace("/admin");
    }
  }, [status, profile, router]);

  if (status !== "ready" || !user) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  const allAnswered = QUESTIONS.every((q) => answers[q.key] !== undefined);

  const handleSubmit = async () => {
    setError("");
    if (!allAnswered) {
      setError("すべての質問に回答してください。");
      return;
    }
    setSubmitting(true);
    try {
      // ID トークンを取得し、API Route に渡してサーバー側で本人確認する
      const idToken = await user.getIdToken();
      const res = await fetch("/api/checkins", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          answers: {
            workload: answers.workload,
            mood: answers.mood,
            support: answers.support,
          },
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "保存に失敗しました。");
      }

      const { checkinId } = (await res.json()) as { checkinId: string };
      router.push(`/result/${checkinId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました。");
      setSubmitting(false);
    }
  };

  return (
    <main>
      <div className="topbar">
        <Link className="link" href="/home">
          ← トップへ戻る
        </Link>
        <button className="link" onClick={() => logout()}>
          ログアウト
        </button>
      </div>

      <div className="card">
        <h1>今回の簡易チェック</h1>
        <p className="muted">3つの質問に、いまの状態に最も近いものを選んでください。</p>

        {error && <div className="error">{error}</div>}

        {QUESTIONS.map((q) => (
          <div className="question" key={q.key}>
            <span className="domain-tag">{q.domain}</span>
            <h2>{q.text}</h2>
            {q.options.map((opt) => {
              const selected = answers[q.key] === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`option${selected ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name={q.key}
                    value={opt.value}
                    checked={selected}
                    onChange={() =>
                      setAnswers((prev) => ({ ...prev, [q.key]: opt.value }))
                    }
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        ))}

        <button
          className="primary"
          onClick={handleSubmit}
          disabled={submitting || !allAnswered}
        >
          {submitting && <span className="spinner" />}
          回答を送信する
        </button>
      </div>
    </main>
  );
}
