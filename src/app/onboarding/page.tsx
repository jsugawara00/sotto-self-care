"use client";

// 初回オンボーディング画面（指示書STEP1-3）。1画面のみ。
// 氏名・メールは Google から自動取得済み。本人が入力するのは表示名の調整だけ
// （自由入力は必要最小限に絞る方針）。以降はマイページでいつでも編集できる。
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";

const MAX_NAME_LENGTH = 50;

export default function OnboardingPage() {
  const { status, user, profile } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // アクセス制御：未ログイン→/login、オンボーディング済み→トップへ
  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (profile?.onboarded) {
      router.replace("/");
    }
  }, [status, profile, router]);

  // Google から取得した氏名を初期値にする
  useEffect(() => {
    if (profile && displayName === "") {
      setDisplayName(profile.displayName);
    }
    // 初期値の反映のみが目的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (status !== "ready" || !user || !profile || profile.onboarded) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const name = displayName.trim();
    if (!name) {
      setError("表示名を入力してください。");
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      setError(`表示名は${MAX_NAME_LENGTH}文字以内で入力してください。`);
      return;
    }
    setSubmitting(true);
    try {
      // Security Rules 側で displayName / onboarded 以外の更新は禁止されている
      await updateDoc(doc(db, "users", user.uid), {
        displayName: name,
        onboarded: true,
        updatedAt: serverTimestamp(),
      });
      router.replace("/");
    } catch (err) {
      console.error("プロフィールの保存に失敗:", err);
      setError("保存に失敗しました。もう一度お試しください。");
      setSubmitting(false);
    }
  };

  return (
    <main>
      <div className="app-header-center">
        <span className="brand brand-lg">
          <span className="brand-dot" />
          そっと。
        </span>
      </div>
      <div className="card">
        <h1>はじめまして</h1>
        <p className="muted">
          プロフィールを確認してください。氏名とメールアドレスは Google
          アカウントから取得しています。表示名はあとからマイページでいつでも変更できます。
        </p>

        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="email">メールアドレス（変更不可）</label>
          <input id="email" type="email" value={profile.email} disabled />

          <label htmlFor="displayName">表示名</label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="name"
          />

          <button className="primary" type="submit" disabled={submitting}>
            {submitting && <span className="spinner" />}
            この内容ではじめる
          </button>
        </form>
      </div>
    </main>
  );
}
