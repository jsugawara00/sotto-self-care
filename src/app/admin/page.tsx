"use client";

// 管理者トップ（指示書STEP2-1・2-2）。admin / owner 向け。
//  - ストレスチェックの周期設定（組織単位・orgSettings/default）
//  - 現在の周期に対する「実施済み／未実施」のユーザー数の表示
// 個別の回答内容・スコアはこの画面（および admin ロール全般）からは見えない。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import {
  CHECK_CYCLES,
  CYCLE_LABELS,
  ROLE_LABELS,
  type CheckCycle,
  type HealthFeatureSettings,
  type OrgSettings,
} from "@/lib/types";

type Stats = {
  cycle: CheckCycle;
  periodStart: string;
  total: number;
  done: number;
  notDone: number;
  // 再検査の集計（健康管理が有効な場合のみ。件数だけで中身・個人は見えない）
  reexam: { required: number; done: number } | null;
};

// 率の表示（分母0のときは「—」）
function rateLabel(done: number, total: number): string {
  return total > 0 ? `${Math.round((done / total) * 100)}%` : "—";
}

export default function AdminTopPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [cycle, setCycle] = useState<CheckCycle | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingCycle, setSavingCycle] = useState(false);
  // 健康管理機能の企業側スイッチ（STEP3・二重オプトイン。デフォルトOFF）
  const [healthEnabled, setHealthEnabled] = useState<boolean | null>(null);
  const [savingHealth, setSavingHealth] = useState(false);

  const isAdminish = profile?.role === "admin" || profile?.role === "owner";

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (profile && !(profile.role === "admin" || profile.role === "owner")) {
      router.replace("/");
    }
  }, [status, profile, router]);

  // 周期設定を監視
  useEffect(() => {
    if (status !== "ready" || !isAdminish) return;
    const unsub = onSnapshot(
      doc(db, "orgSettings", "default"),
      (snap) => {
        if (snap.exists()) {
          setCycle((snap.data() as OrgSettings).checkCycle);
        } else {
          setCycle("weekly"); // 未設定時の表示上の初期値（保存はまだしない）
        }
      },
      (err) => {
        console.error("周期設定の取得に失敗:", err);
      }
    );
    return () => unsub();
  }, [status, isAdminish]);

  // 健康管理機能のスイッチを監視
  useEffect(() => {
    if (status !== "ready" || !isAdminish) return;
    const unsub = onSnapshot(
      doc(db, "orgSettings", "healthFeature"),
      (snap) => {
        setHealthEnabled(
          snap.exists() &&
            (snap.data() as HealthFeatureSettings).enabled === true
        );
      },
      (err) => {
        console.error("健康管理設定の取得に失敗:", err);
      }
    );
    return () => unsub();
  }, [status, isAdminish]);

  // 実施状況を取得（集計はサーバーAPI＝個別回答は返らない）
  const loadStats = useCallback(async () => {
    if (!user) return;
    setStatsLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/stats", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "集計の取得に失敗しました。");
      }
      setStats((await res.json()) as Stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "集計の取得に失敗しました。");
    } finally {
      setStatsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (status !== "ready" || !isAdminish) return;
    void loadStats();
  }, [status, isAdminish, loadStats]);

  if (status !== "ready" || !user || !profile || !isAdminish) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  // 周期の変更（Rules 側で admin/owner のみ書き込み可）
  const handleCycleChange = async (next: CheckCycle) => {
    setError("");
    setSavingCycle(true);
    try {
      await setDoc(doc(db, "orgSettings", "default"), {
        checkCycle: next,
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      });
      // 周期が変わると集計対象期間も変わるため取り直す
      await loadStats();
    } catch (err) {
      console.error("周期設定の保存に失敗:", err);
      setError("周期設定の保存に失敗しました。");
    } finally {
      setSavingCycle(false);
    }
  };

  return (
    <main style={{ maxWidth: 760 }}>
      <div className="topbar">
        <span className="brand">
          <span className="brand-dot" />
          そっと。
          <span className="role-tag">{ROLE_LABELS[profile.role]}</span>
        </span>
        <button className="link" onClick={() => logout()}>
          ログアウト
        </button>
      </div>

      <div className="card">
        <h1>ストレスチェック実施状況</h1>
        <p className="muted">
          現在の周期（{stats ? CYCLE_LABELS[stats.cycle] : "…"}）での実施状況です。
          個別の回答内容は表示されません。
        </p>

        {error && <div className="error">{error}</div>}

        {statsLoading ? (
          <p className="muted">
            <span className="spinner" />
            集計中…
          </p>
        ) : stats ? (
          <>
            <div className="stat-grid">
              <div className="stat-box">
                <span className="stat-num">{stats.total}</span>
                <span className="stat-label">対象者</span>
              </div>
              <div className="stat-box">
                <span className="stat-num">{stats.done}</span>
                <span className="stat-label">実施済み</span>
              </div>
              <div className={`stat-box${stats.notDone > 0 ? " warn" : ""}`}>
                <span className="stat-num">{stats.notDone}</span>
                <span className="stat-label">未実施</span>
              </div>
              <div className="stat-box">
                <span className="stat-num">{rateLabel(stats.done, stats.total)}</span>
                <span className="stat-label">実施率</span>
              </div>
            </div>
            {/* 再検査完了率（企画書8-5①）：件数と率のみ。誰が・何の検査かは見えない */}
            {stats.reexam && (
              <>
                <h2 style={{ marginTop: 18 }}>再検査の状況</h2>
                <div className="stat-grid">
                  <div className="stat-box">
                    <span className="stat-num">{stats.reexam.required}</span>
                    <span className="stat-label">要再検査</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num">{stats.reexam.done}</span>
                    <span className="stat-label">完了</span>
                  </div>
                  <div
                    className={`stat-box${
                      stats.reexam.required > stats.reexam.done ? " warn" : ""
                    }`}
                  >
                    <span className="stat-num">
                      {rateLabel(stats.reexam.done, stats.reexam.required)}
                    </span>
                    <span className="stat-label">完了率</span>
                  </div>
                </div>
              </>
            )}
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              集計期間の開始：
              {new Date(stats.periodStart).toLocaleString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}
              （対象＝一覧に載せている担当者・総務）
            </p>
            <button className="btn-sm" onClick={() => void loadStats()}>
              集計を更新
            </button>
          </>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>チェックの周期設定</h2>
        <p className="muted">
          組織全体のストレスチェックの周期を設定します。変更すると実施状況の集計対象期間も変わります。
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select
            value={cycle ?? "weekly"}
            disabled={savingCycle || cycle === null}
            onChange={(e) => handleCycleChange(e.target.value as CheckCycle)}
            aria-label="チェックの周期"
          >
            {CHECK_CYCLES.map((c) => (
              <option key={c} value={c}>
                {CYCLE_LABELS[c]}
              </option>
            ))}
          </select>
          {savingCycle && <span className="spinner" />}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>健康管理機能</h2>
        <p className="muted">
          健診書類の読取りと再検査フローの機能です。組織で有効化し、さらに本人が希望した
          場合にだけ使われます（二重オプトイン）。管理者には完了の有無のみが見え、
          書類の内容・領収書は見えません。
        </p>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={healthEnabled ?? false}
            disabled={savingHealth || healthEnabled === null}
            onChange={async (e) => {
              const next = e.target.checked;
              setError("");
              setSavingHealth(true);
              try {
                await setDoc(doc(db, "orgSettings", "healthFeature"), {
                  enabled: next,
                  updatedBy: user.uid,
                  updatedAt: serverTimestamp(),
                });
              } catch (err) {
                console.error("健康管理設定の保存に失敗:", err);
                setError("健康管理機能の設定の保存に失敗しました。");
              } finally {
                setSavingHealth(false);
              }
            }}
          />
          健康管理機能を有効にする
          {savingHealth && <span className="spinner" />}
        </label>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>管理メニュー</h2>
        <p style={{ marginBottom: 8 }}>
          <Link className="link" href="/admin/users">
            従業員一覧（ロール・招待の管理）
          </Link>
        </p>
        <p style={{ marginBottom: 8 }}>
          <Link className="link" href="/announcements">
            一括案内の送信・確認状況
          </Link>
        </p>
        <p style={{ marginBottom: 8 }}>
          <Link className="link" href="/admin/report">
            期間指定レポート（CSV・印刷）
          </Link>
        </p>
        <p style={{ margin: 0 }}>
          <Link className="link" href="/mypage">
            マイページ
          </Link>
        </p>
      </div>
    </main>
  );
}
