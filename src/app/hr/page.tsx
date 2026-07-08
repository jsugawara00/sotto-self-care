"use client";

// 総務（hr）向け：再検査の受領確認・承認（STEP3・企画書8-3）。
//  - 一覧には受領確認に必要な情報だけを出す（本人の注意事項・所見は出さない＝最小権限）。
//  - 領収書の閲覧は総務限定。承認するとサーバー側で領収書は即削除され、「完了」の事実だけ残る。
//  - 承認は確認ダイアログ付き（自動完了にしない＝誤送信防止・証跡）。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/AuthContext";
import {
  REEXAM_STATUS_LABELS,
  ROLE_LABELS,
  type ReexamStatus,
} from "@/lib/types";

type ReexamRow = {
  healthId: string;
  displayName: string;
  reexamStatus: ReexamStatus;
  examDate: string;
  visitDate: string;
  returnComment: string;
  submittedAt: string | null;
  approvedAt: string | null;
  hasReceipt: boolean;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export default function HrReexamsPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [items, setItems] = useState<ReexamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  // 開いている領収書（healthId → データURL。写真またはPDF）
  const [receipt, setReceipt] = useState<{
    healthId: string;
    url: string;
    isPdf: boolean;
  } | null>(null);

  const isHr = profile?.role === "hr";

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (profile && !isHr) {
      router.replace("/");
    }
  }, [status, profile, isHr, router]);

  const callApi = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      if (!user) throw new Error("ログインが必要です。");
      const idToken = await user.getIdToken();
      return fetch(path, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    },
    [user]
  );

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await callApi("/api/hr/reexams");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "一覧の取得に失敗しました。");
      }
      const data = (await res.json()) as { items: ReexamRow[] };
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "一覧の取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [callApi]);

  useEffect(() => {
    if (status !== "ready" || !isHr) return;
    void loadList();
  }, [status, isHr, loadList]);

  if (status !== "ready" || !user || !profile || !isHr) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  // 領収書の表示（総務限定・API経由）
  const handleShowReceipt = async (row: ReexamRow) => {
    setError("");
    if (receipt?.healthId === row.healthId) {
      setReceipt(null); // 開いているものをもう一度押したら閉じる
      return;
    }
    setBusyId(row.healthId);
    try {
      const res = await callApi(
        `/api/hr/reexams/receipt?healthId=${row.healthId}`
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "領収書の取得に失敗しました。");
      }
      const data = (await res.json()) as { data: string; mimeType: string };
      setReceipt({
        healthId: row.healthId,
        url: `data:${data.mimeType};base64,${data.data}`,
        isPdf: data.mimeType === "application/pdf",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "領収書の取得に失敗しました。");
    } finally {
      setBusyId("");
    }
  };

  // 差し戻し（STEP4）：理由の一言を添えて本人に戻す。汎用チャットは作らない＝1回だけの型。
  // 差し戻すと領収書はサーバー側で削除され、本人が新しい領収書で再提出する。
  const handleReturn = async (row: ReexamRow) => {
    setError("");
    const comment = window.prompt(
      `${row.displayName} さんの提出（受診日：${row.visitDate}）を差し戻します。\n` +
        `理由をひとことで入力してください（200文字まで・本人の画面に表示されます）。\n\n` +
        `※ 差し戻すと領収書は削除され、本人に再提出をお願いする状態になります。\n` +
        `※ この差し戻しは監査ログに記録されます（理由の文章はログには残りません）。`
    );
    if (comment === null) return; // キャンセル
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      setError("差し戻しの理由を入力してください。");
      return;
    }
    setBusyId(row.healthId);
    try {
      const res = await callApi("/api/hr/reexams/return", {
        method: "POST",
        body: JSON.stringify({ healthId: row.healthId, comment: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "差し戻しに失敗しました。");
      }
      setReceipt(null);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "差し戻しに失敗しました。");
    } finally {
      setBusyId("");
    }
  };

  // 受領確認→完了承認（確認ダイアログ＋承認後は領収書が削除される）
  const handleApprove = async (row: ReexamRow) => {
    setError("");
    const confirmed = window.confirm(
      `${row.displayName} さんの再検査（受診日：${row.visitDate}）を「完了」として承認します。\n承認すると領収書は削除され、元に戻せません。よろしいですか？\n\n※ この承認は監査ログに記録されます。`
    );
    if (!confirmed) return;
    setBusyId(row.healthId);
    try {
      const res = await callApi("/api/hr/reexams/approve", {
        method: "POST",
        body: JSON.stringify({ healthId: row.healthId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "承認に失敗しました。");
      }
      setReceipt(null);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "承認に失敗しました。");
    } finally {
      setBusyId("");
    }
  };

  return (
    <main style={{ maxWidth: 860 }}>
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
        <h1>再検査の受領確認</h1>
        <p className="muted">
          提出された受診日と領収書を確認し、「完了」を承認します。
          承認すると領収書はすぐに削除され、完了の事実だけが記録に残ります。
        </p>

        {error && <div className="error">{error}</div>}

        {loading ? (
          <p className="muted">
            <span className="spinner" />
            読み込み中…
          </p>
        ) : items.length === 0 ? (
          <p className="muted">再検査の対象者はいません。</p>
        ) : (
          <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>氏名</th>
                <th>状態</th>
                <th>健診日</th>
                <th>受診日</th>
                <th>提出日</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.healthId}>
                  <td>{row.displayName}</td>
                  <td>{REEXAM_STATUS_LABELS[row.reexamStatus]}</td>
                  <td>{row.examDate || "—"}</td>
                  <td>{row.visitDate || "—"}</td>
                  <td>{formatDate(row.submittedAt)}</td>
                  <td>
                    {row.reexamStatus === "submitted" ? (
                      <span style={{ display: "inline-flex", gap: 8 }}>
                        <button
                          className="btn-sm"
                          disabled={busyId === row.healthId || !row.hasReceipt}
                          onClick={() => void handleShowReceipt(row)}
                        >
                          {receipt?.healthId === row.healthId
                            ? "領収書を閉じる"
                            : "領収書を見る"}
                        </button>
                        <button
                          className="primary btn-sm"
                          disabled={busyId === row.healthId}
                          onClick={() => void handleApprove(row)}
                        >
                          完了として承認
                        </button>
                        <button
                          className="btn-sm"
                          disabled={busyId === row.healthId}
                          onClick={() => void handleReturn(row)}
                        >
                          差し戻す
                        </button>
                      </span>
                    ) : row.reexamStatus === "done" ? (
                      <span className="muted">
                        {formatDate(row.approvedAt)} 承認済み
                      </span>
                    ) : row.reexamStatus === "returned" ? (
                      <span className="muted">
                        再提出待ち
                        {row.returnComment && (
                          <>
                            <br />
                            <span style={{ fontSize: "0.8rem" }}>
                              伝えた理由：{row.returnComment}
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="muted">提出待ち</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {receipt && (
          <div style={{ marginTop: 16 }}>
            <p className="muted" style={{ marginBottom: 6 }}>
              領収書（閲覧は総務のみ・承認後に削除されます）：
            </p>
            {receipt.isPdf ? (
              <iframe
                src={receipt.url}
                title="提出された領収書（PDF）"
                style={{
                  width: "100%",
                  height: 600,
                  borderRadius: 8,
                  border: "1px solid #ccc",
                }}
              />
            ) : (
              /* base64のデータURL表示のため next/image は使わない */
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={receipt.url}
                alt="提出された領収書"
                style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #ccc" }}
              />
            )}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button className="btn-sm" onClick={() => void loadList()}>
            一覧を更新
          </button>
        </div>
      </div>

      <p style={{ marginTop: 20 }}>
        <Link className="link" href="/home">
          ホームに戻る
        </Link>
      </p>
    </main>
  );
}
