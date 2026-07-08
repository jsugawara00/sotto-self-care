"use client";

// 入口ページ：認証状態とロールに応じて各画面へ振り分けるだけの画面。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthContext";

export default function IndexPage() {
  const { status, profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    if (status === "signedOut" || status === "unaffiliated") {
      router.replace("/login");
      return;
    }
    if (!profile) return;
    if (!profile.onboarded) {
      router.replace("/onboarding");
    } else if (profile.role === "admin" || profile.role === "owner") {
      router.replace("/admin");
    } else {
      router.replace("/home");
    }
  }, [status, profile, router]);

  return (
    <main>
      <div className="center">
        <span className="spinner" />
        読み込み中…
      </div>
    </main>
  );
}
