"use client";

// 期間指定レポート（STEP4・企画書8-5③）。admin / owner 向け。
// 期間を指定して実施状況と再検査の集計を表示し、CSVダウンロードとブラウザ印刷ができる。
// 内容は企画書7章の可視範囲のみ（実施の有無まで。回答内容・診断数値・健診の中身は含めない）。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/AuthContext";
import { ROLE_LABELS } from "@/lib/types";

type ReportData = {
  from: string;
  to: string;
  total: number;
  done: number;
  rows: { name: string; roleLabel: string; count: number }[];
  reexam: { required: number; done: number } | null;
};

// "YYYY-MM-DD"（端末のローカル暦＝JST想定）
function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rateLabel(done: number, total: number): string {
  return total > 0 ? `${Math.round((done / total) * 100)}%` : "—";
}

// CSVの値（カンマ・引用符・改行を含みうるもの）を安全にエスケープ
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function AdminReportPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const today = new Date();
  const [from, setFrom] = useState(
    toDateInput(new Date(today.getFullYear(), today.getMonth(), 1))
  );
  const [to, setTo] = useState(toDateInput(today));
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  const loadReport = async () => {
    setError("");
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(
        `/api/admin/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${idToken}` } }
      );
      const data = (await res.json().catch(() => ({}))) as
        | ReportData
        | { error?: string };
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "レポートの取得に失敗しました。"
        );
      }
      setReport(data as ReportData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "レポートの取得に失敗しました。"
      );
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    if (!report) return;
    const lines: string[] = [];
    lines.push(`期間,${report.from} 〜 ${report.to}`);
    lines.push("");
    lines.push("ストレスチェック実施状況");
    lines.push(`対象者数,${report.total}`);
    lines.push(`実施者数,${report.done}`);
    lines.push(`実施率,${rateLabel(report.done, report.total)}`);
    lines.push("");
    lines.push("氏名,ロール,期間内の実施回数,実施有無");
    report.rows.forEach((r) => {
      lines.push(
        [
          csvCell(r.name),
          csvCell(r.roleLabel),
          r.count,
          r.count > 0 ? "実施" : "未実施",
        ].join(",")
      );
    });
    if (report.reexam) {
      lines.push("");
      lines.push("再検査（期間内に保存された健診記録）");
      lines.push(`要再検査,${report.reexam.required}`);
      lines.push(`完了,${report.reexam.done}`);
      lines.push(`完了率,${rateLabel(report.reexam.done, report.reexam.required)}`);
    }
    // Excel で文字化けしないよう BOM 付き UTF-8
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sotto-report_${report.from}_${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main style={{ maxWidth: 760 }}>
      <div className="topbar no-print">
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
        <div className="no-print">
          <h1>期間指定レポート</h1>
          <p className="muted">
            期間を指定して、実施状況と再検査の集計を出力します。
            回答内容や健診の中身は含まれません（実施・完了の有無まで）。
          </p>

          {error && <div className="error">{error}</div>}

          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label>
              開始日{" "}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              終了日{" "}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={loading}
              onClick={() => void loadReport()}
            >
              {loading ? "集計中…" : "集計する"}
            </button>
          </div>
        </div>

        {report && (
          <div style={{ marginTop: 16 }}>
            <h2>
              レポート（{report.from} 〜 {report.to}）
            </h2>

            <h3 style={{ marginTop: 12 }}>ストレスチェック実施状況</h3>
            <div className="stat-grid">
              <div className="stat-box">
                <span className="stat-num">{report.total}</span>
                <span className="stat-label">対象者</span>
              </div>
              <div className="stat-box">
                <span className="stat-num">{report.done}</span>
                <span className="stat-label">実施者</span>
              </div>
              <div className="stat-box">
                <span className="stat-num">
                  {rateLabel(report.done, report.total)}
                </span>
                <span className="stat-label">実施率</span>
              </div>
            </div>
            <table className="report-table">
              <thead>
                <tr>
                  <th>氏名</th>
                  <th>ロール</th>
                  <th>期間内の実施回数</th>
                  <th>実施有無</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>{r.roleLabel}</td>
                    <td>{r.count}</td>
                    <td>{r.count > 0 ? "実施" : "未実施"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {report.reexam && (
              <>
                <h3 style={{ marginTop: 16 }}>
                  再検査（期間内に保存された健診記録）
                </h3>
                <div className="stat-grid">
                  <div className="stat-box">
                    <span className="stat-num">{report.reexam.required}</span>
                    <span className="stat-label">要再検査</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num">{report.reexam.done}</span>
                    <span className="stat-label">完了</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-num">
                      {rateLabel(report.reexam.done, report.reexam.required)}
                    </span>
                    <span className="stat-label">完了率</span>
                  </div>
                </div>
              </>
            )}

            <div className="no-print" style={{ marginTop: 14, display: "flex", gap: 10 }}>
              <button className="btn-sm" onClick={downloadCsv}>
                CSVダウンロード
              </button>
              <button className="btn-sm" onClick={() => window.print()}>
                印刷する
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card no-print" style={{ marginTop: 20 }}>
        <p style={{ margin: 0 }}>
          <Link className="link" href="/admin">
            管理者トップへ戻る
          </Link>
        </p>
      </div>
    </main>
  );
}
