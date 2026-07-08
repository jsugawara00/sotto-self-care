"use client";

// ログイン画面（指示書STEP1-1・1-2）。
// 認証は Firebase Auth ＋ Google プロバイダのみ。招待されていないメールアドレスで
// ログインした場合は「所属なし」として弾く（users は作成されない）。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthContext";

export default function LoginPage() {
  const { status, user, error, loginWithGoogle, logout } = useAuth();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState("");

  // 所属確認まで済んだユーザーは入口ページ経由で各画面へ
  useEffect(() => {
    if (status === "ready") {
      router.replace("/");
    }
  }, [status, router]);

  const handleLogin = async () => {
    setLoginError("");
    setSubmitting(true);
    try {
      await loginWithGoogle();
      // 遷移は status の変化に任せる
    } catch (err) {
      // ポップアップを閉じた場合などはエラー表示しない
      const code = (err as { code?: string })?.code ?? "";
      if (
        code !== "auth/popup-closed-by-user" &&
        code !== "auth/cancelled-popup-request"
      ) {
        setLoginError("ログインに失敗しました。もう一度お試しください。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          確認中…
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="app-header-center">
        <span className="brand brand-lg">
          <span className="brand-dot" />
          そっと。
        </span>
      </div>
      <div className="card">
        {status === "unaffiliated" ? (
          <>
            <h1>所属が確認できませんでした</h1>
            <p className="muted">
              {user?.email} は、この組織に招待されていないアカウントです。
              管理者から招待を受けたメールアドレスの Google
              アカウントでログインし直してください。
            </p>
            {error && <div className="error">{error}</div>}
            <button className="primary" onClick={() => logout()}>
              別のアカウントでログインし直す
            </button>
          </>
        ) : (
          <>
            <h1>ログイン</h1>
            <p className="muted">
              このアプリは招待制です。組織の管理者から招待を受けたメールアドレスの
              Google アカウントでログインしてください。
            </p>
            {loginError && <div className="error">{loginError}</div>}
            <button
              className="google"
              onClick={handleLogin}
              disabled={submitting}
            >
              {submitting && <span className="spinner" />}
              Google でログイン
            </button>
            <p className="muted" style={{ marginTop: 16, fontSize: "0.8rem" }}>
              招待されていないアカウントでは利用できません（「所属なし」と表示されます）。
            </p>
          </>
        )}
      </div>
    </main>
  );
}
