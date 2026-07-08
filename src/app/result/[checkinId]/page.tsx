"use client";

// 結果画面。回答内容と、Cloud Functions が書き戻す縦断フィードバック・確認チャットを
// onSnapshot で監視して表示する（試作のパターンを踏襲）。
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { QUESTIONS } from "@/lib/questions";
import type { Checkin } from "@/lib/types";
import { CheckinFeedback } from "@/components/CheckinFeedback";

export default function ResultPage({
  params,
}: {
  params: Promise<{ checkinId: string }>;
}) {
  const { checkinId } = use(params);
  const { status, user, logout } = useAuth();
  const router = useRouter();

  const [checkin, setCheckin] = useState<Checkin | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
    }
  }, [status, router]);

  // 対象の checkin を監視（Rules：本人以外は読めない）
  useEffect(() => {
    if (status !== "ready" || !user) return;
    const unsub = onSnapshot(
      doc(db, "checkins", checkinId),
      (snap) => {
        if (!snap.exists()) {
          setError("この結果は見つかりませんでした。");
          return;
        }
        const data = snap.data() as Checkin;
        if (data.userId !== user.uid) {
          setError("この結果を表示する権限がありません。");
          return;
        }
        setCheckin(data);
      },
      (err) => {
        console.error("結果の取得に失敗:", err);
        setError("結果の取得に失敗しました。");
      }
    );
    return () => unsub();
  }, [status, user, checkinId]);

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
        <h1>今回のふりかえり</h1>

        {error && <div className="error">{error}</div>}

        {!error && !checkin && (
          <p className="muted">
            <span className="spinner" />
            読み込み中…
          </p>
        )}

        {checkin && (
          <>
            {QUESTIONS.map((q) => {
              const score = checkin.answers[q.key];
              const label =
                q.options.find((o) => o.value === score)?.label ?? String(score);
              return (
                <div className="score-row" key={q.key}>
                  <span>{q.domain}</span>
                  <span>{label}</span>
                </div>
              );
            })}

            <div style={{ marginTop: 18 }}>
              <CheckinFeedback
                checkinId={checkinId}
                checkin={checkin}
                user={user}
              />
            </div>

            <p className="muted" style={{ marginTop: 20, fontSize: "0.82rem" }}>
              このフィードバックは医療的な診断ではありません。フィードバックはAIが作成しているため、実情に合わないことがあります。気になる状態が続く場合は、産業医や専門家への相談をご検討ください。
            </p>
          </>
        )}
      </div>
    </main>
  );
}
