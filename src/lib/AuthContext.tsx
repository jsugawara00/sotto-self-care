"use client";

// Firebase Auth（Googleプロバイダ）のログイン状態＋ユーザープロフィール(role)をアプリ全体で共有する。
//
// 招待ゲート（指示書STEP1-2）：
//   Googleログイン成功後、/api/bootstrap を呼ぶ。サーバー側で招待レコードを確認し、
//   招待済みメールのときだけ users/{uid} が作成される。招待が無ければ 403 が返り、
//   このコンテキストは status="unaffiliated"（所属なし）として扱う（users は作られない）。
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { doc, onSnapshot, type Unsubscribe } from "firebase/firestore";
import { auth, db } from "./firebase";
import type { UserProfile } from "./types";

export type AuthStatus =
  | "loading" // 認証状態・所属確認が確定するまで
  | "signedOut" // 未ログイン
  | "unaffiliated" // ログイン済みだが招待が無い（所属なし）
  | "ready"; // ログイン済み＋users/{uid} あり

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  profile: UserProfile | null; // users/{uid}。ready のときのみ非null
  error: string; // bootstrap 失敗時などの表示用メッセージ
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState("");
  const profileUnsubRef = useRef<Unsubscribe | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      // 前のユーザーのプロフィール監視を解除
      profileUnsubRef.current?.();
      profileUnsubRef.current = null;

      setUser(firebaseUser);
      setProfile(null);
      setError("");

      if (!firebaseUser) {
        setStatus("signedOut");
        return;
      }

      setStatus("loading");
      try {
        // 招待ゲート：サーバー側で招待確認＋users 作成（既存なら何もしない）
        const idToken = await firebaseUser.getIdToken();
        const res = await fetch("/api/bootstrap", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}` },
        });

        if (res.status === 403) {
          setStatus("unaffiliated");
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "所属確認に失敗しました。");
        }

        // users/{uid} を監視（ロール変更・オンボーディング完了が即座に反映される）
        profileUnsubRef.current = onSnapshot(
          doc(db, "users", firebaseUser.uid),
          (snap) => {
            if (snap.exists()) {
              setProfile(snap.data() as UserProfile);
              setStatus("ready");
            }
          },
          (err) => {
            console.error("プロフィールの監視に失敗:", err);
          }
        );
      } catch (err) {
        console.error("所属確認に失敗:", err);
        setError(
          err instanceof Error ? err.message : "所属確認に失敗しました。"
        );
        setStatus("unaffiliated");
      }
    });
    return () => {
      profileUnsubRef.current?.();
      unsubscribe();
    };
  }, []);

  const loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    // アカウント選択を毎回出す（招待メールと別アカウントで入ってしまう事故を減らす）
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  };

  const logout = async () => {
    await signOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{ status, user, profile, error, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth は AuthProvider の内側で使ってください。");
  }
  return ctx;
}
