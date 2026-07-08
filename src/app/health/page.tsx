"use client";

// 健康管理（本人向け・STEP3・企画書8-2/8-3）。
//  - 二重オプトイン：組織が有効化 かつ 本人が利用開始、で初めて使える（デフォルトOFF）。
//  - 書類読取り：ファイルは保存されない。抽出結果を本人が確認してから保存（確かめる思想）。
//  - 再検査フロー：精密検査要の検出 → 受診日＋領収書の提出 → 総務の承認で完了。
//  - 機微データはクライアント直読み不可。表示もすべてAPI経由（PII分離・企画書9章）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import { fns } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { compressImageToBase64, fileToBase64 } from "@/lib/fileUtils";
import {
  REEXAM_STATUS_LABELS,
  ROLE_LABELS,
  type ParsedHealthDocument,
  type ReexamStatus,
} from "@/lib/types";

type HealthMe = {
  featureEnabled: boolean;
  optIn: boolean;
  record: {
    reexamRequired: boolean;
    notes: string;
    examDate: string;
    templateId: string;
    reexamStatus: ReexamStatus;
    visitDate: string;
    returnComment: string;
    submittedAt: string | null;
    approvedAt: string | null;
  } | null;
  hasReceipt: boolean;
};

// 健診書類（読取り用）：PDFはそのまま・画像は軽い圧縮（精度優先）
const DOC_MAX_BASE64 = 10_500_000;
// 領収書：Firestoreに収める強めの圧縮
const RECEIPT_MAX_BASE64 = 900_000;

export default function HealthPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [me, setMe] = useState<HealthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 読取り結果（保存前の本人確認用。保存かやり直しで消える）
  const [parsed, setParsed] = useState<ParsedHealthDocument | null>(null);
  const [parsing, setParsing] = useState(false);
  const docInputRef = useRef<HTMLInputElement>(null);

  // 再検査の提出フォーム
  const [visitDate, setVisitDate] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
    }
  }, [status, router]);

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

  const loadMe = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await callApi("/api/health/me");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "取得に失敗しました。");
      }
      setMe((await res.json()) as HealthMe);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [callApi]);

  useEffect(() => {
    if (status !== "ready") return;
    void loadMe();
  }, [status, loadMe]);

  if (status !== "ready" || !user || !profile) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  // 本人オプトインの開始／停止
  const handleOptIn = async (next: boolean) => {
    setError("");
    if (!next) {
      const confirmed = window.confirm(
        "健康管理機能の利用を停止します。保存されている健診の記録・領収書はすべて削除され、元に戻せません。よろしいですか？"
      );
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const res = await callApi("/api/health/optin", {
        method: "POST",
        body: JSON.stringify({ optIn: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "更新に失敗しました。");
      }
      setParsed(null);
      await loadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  // 書類の読取り（ファイルは保存されず、この場で抽出結果だけが返る）
  const handleParse = async (file: File) => {
    setError("");
    setParsed(null);
    setParsing(true);
    try {
      let fileBase64: string;
      let mimeType: string;
      if (file.type === "application/pdf") {
        fileBase64 = await fileToBase64(file);
        mimeType = "application/pdf";
        if (fileBase64.length > DOC_MAX_BASE64) {
          throw new Error("PDFのサイズが大きすぎます（8MBまで）。");
        }
      } else {
        const compressed = await compressImageToBase64(file, {
          maxDim: 2200,
          quality: 0.9,
          maxBase64Chars: DOC_MAX_BASE64,
        });
        fileBase64 = compressed.base64;
        mimeType = compressed.mimeType;
      }

      const parseFn = httpsCallable<
        { fileBase64: string; mimeType: string; templateId: string },
        ParsedHealthDocument
      >(fns, "parseHealthDocument");
      const result = await parseFn({ fileBase64, mimeType, templateId: "generic" });
      setParsed(result.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "書類の読取りに失敗しました。"
      );
    } finally {
      setParsing(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  };

  // 抽出結果の確定保存（本人が内容を確認してから）
  const handleSaveRecord = async () => {
    if (!parsed) return;
    setError("");
    setBusy(true);
    try {
      const res = await callApi("/api/health/record", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "保存に失敗しました。");
      }
      setParsed(null);
      await loadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  // 再検査の受診報告（受診日＋領収書）。
  // 領収書は写真（自動圧縮）またはPDF（電子領収書想定・上限内のみ）を受け付ける。
  const handleSubmitReexam = async () => {
    if (!visitDate || !receiptFile) {
      setError("受診日と領収書のファイルを指定してください。");
      return;
    }
    setError("");
    setBusy(true);
    try {
      let base64: string;
      let mimeType: string;
      if (receiptFile.type === "application/pdf") {
        base64 = await fileToBase64(receiptFile);
        mimeType = "application/pdf";
        if (base64.length > RECEIPT_MAX_BASE64) {
          throw new Error(
            "PDFのサイズが大きいため添付できませんでした（約650KBまで）。お手数ですが、書類を写真に撮って添付してください。"
          );
        }
      } else {
        const compressed = await compressImageToBase64(receiptFile, {
          maxDim: 1600,
          quality: 0.8,
          maxBase64Chars: RECEIPT_MAX_BASE64,
        });
        base64 = compressed.base64;
        mimeType = compressed.mimeType;
      }
      const res = await callApi("/api/health/reexam", {
        method: "POST",
        body: JSON.stringify({
          visitDate,
          receiptBase64: base64,
          mimeType,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "提出に失敗しました。");
      }
      setVisitDate("");
      setReceiptFile(null);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
      await loadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提出に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const record = me?.record ?? null;

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
        <h1>健康管理</h1>
        <p className="muted">
          健康診断の結果通知書から「精密検査のお願い」と「注意事項」だけを読み取り、
          再検査の受診をそっと後押しします。検査の数値は読み取りません。
        </p>

        {error && <div className="error">{error}</div>}

        {loading || !me ? (
          <p className="muted">
            <span className="spinner" />
            読み込み中…
          </p>
        ) : !me.featureEnabled ? (
          <p className="muted">
            この機能は現在、組織で有効になっていません。利用したい場合は管理者にご相談ください。
          </p>
        ) : !me.optIn ? (
          <>
            <p>
              この機能はあなたが希望した場合にだけ使われます（利用しない間、健康に関する
              データは一切保存されません）。読み取った内容はあなたと総務だけが確認でき、
              管理者には完了したかどうかしか見えません。
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handleOptIn(true)}
            >
              健康管理機能を利用する
            </button>
          </>
        ) : (
          <p className="muted">
            利用中です。いつでも下の「利用を停止する」からやめられます（データは削除されます）。
          </p>
        )}
      </div>

      {me?.featureEnabled && me.optIn && (
        <>
          <div className="card" style={{ marginTop: 20 }}>
            <h2>健診書類の読取り</h2>
            <p className="muted">
              結果通知書（PDFまたは写真）を選ぶと内容を読み取ります。ファイルそのものは
              保存されません。読み取った内容はあなたが確認してから保存されます。
            </p>
            <input
              ref={docInputRef}
              type="file"
              accept="application/pdf,image/*"
              disabled={parsing || busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleParse(f);
              }}
              aria-label="健診書類のファイル"
            />
            {parsing && (
              <p className="muted">
                <span className="spinner" />
                読み取り中…（少し時間がかかります）
              </p>
            )}

            {parsed && (
              <div className="feedback-box" style={{ marginTop: 12 }}>
                <p style={{ marginTop: 0 }}>
                  <strong>読み取った内容の確認</strong>（違っていれば保存せずに読み取り直せます）
                </p>
                <p>
                  精密検査のお願い：
                  <strong>{parsed.reexamRequired ? "あり" : "なし"}</strong>
                  <button
                    className="btn-sm"
                    style={{ marginLeft: 10 }}
                    disabled={busy}
                    onClick={() =>
                      setParsed({ ...parsed, reexamRequired: !parsed.reexamRequired })
                    }
                  >
                    {parsed.reexamRequired ? "「なし」に直す" : "「あり」に直す"}
                  </button>
                </p>
                <p className="muted" style={{ fontSize: "0.8rem", marginTop: 0 }}>
                  文字がかすれている書類などでは読み取りが揺れることがあります。
                  書類と違うときは、ここで直してから保存してください。
                </p>
                <p>健診の受診日：{parsed.examDate || "（読み取れませんでした）"}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  注意事項：{parsed.notes || "（記載なし）"}
                </p>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void handleSaveRecord()}
                  >
                    この内容で保存
                  </button>
                  <button
                    className="btn-sm"
                    disabled={busy}
                    onClick={() => setParsed(null)}
                  >
                    破棄する
                  </button>
                </div>
                {record && (
                  <p className="muted" style={{ marginBottom: 0 }}>
                    ※ 保存すると、いまの記録（再検査の進行状況を含む）は新しい内容で上書きされます。
                  </p>
                )}
              </div>
            )}
          </div>

          {record && (
            <div className="card" style={{ marginTop: 20 }}>
              <h2>いまの記録</h2>

              {/* 差し戻しのお知らせはカードの先頭・ホームのバナーと同じ配色（目で見つけられるように） */}
              {record.reexamStatus === "returned" && (
                <div className="notice-box">
                  <p style={{ marginTop: 0, fontWeight: 600 }}>
                    🔔 総務からのお知らせ
                  </p>
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {record.returnComment || "（記載なし）"}
                  </p>
                  <p style={{ marginBottom: 0 }}>
                    お手数ですが、下の「受診の報告（再提出）」からもう一度提出をお願いします。
                  </p>
                </div>
              )}

              <p>健診の受診日：{record.examDate || "（不明）"}</p>
              <p style={{ whiteSpace: "pre-wrap" }}>
                注意事項：{record.notes || "（記載なし）"}
              </p>
              <p>
                再検査：
                <strong>{REEXAM_STATUS_LABELS[record.reexamStatus]}</strong>
              </p>

              {record.reexamStatus === "pending" && (
                <div className="feedback-box">
                  <p style={{ marginTop: 0 }}>
                    精密検査のお願いが出ています。受診がまだでしたら、無理のない範囲で
                    予定を立ててみませんか。受診したら、受診日と領収書をここから提出してください。
                  </p>
                </div>
              )}

              {(record.reexamStatus === "pending" ||
                record.reexamStatus === "submitted" ||
                record.reexamStatus === "returned") && (
                <div style={{ marginTop: 12 }}>
                  <h3 style={{ marginBottom: 8 }}>
                    {record.reexamStatus === "submitted"
                      ? "提出内容の差し替え"
                      : record.reexamStatus === "returned"
                        ? "受診の報告（再提出）"
                        : "受診の報告"}
                  </h3>
                  {record.reexamStatus === "submitted" && (
                    <p className="muted">
                      {record.visitDate} 受診分を提出済みです。総務の確認をお待ちください。
                      内容を間違えた場合は、ここから再提出すると差し替えられます。
                    </p>
                  )}
                  <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
                    <label>
                      受診日：
                      <input
                        type="date"
                        value={visitDate}
                        disabled={busy}
                        onChange={(e) => setVisitDate(e.target.value)}
                      />
                    </label>
                    <label>
                      領収書（写真またはPDF）：
                      <input
                        ref={receiptInputRef}
                        type="file"
                        accept="image/*,application/pdf"
                        disabled={busy}
                        onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={busy || !visitDate || !receiptFile}
                      onClick={() => void handleSubmitReexam()}
                    >
                      提出する
                    </button>
                    <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
                      領収書は総務だけが確認でき、完了の確認が済むとすぐに削除されます。
                    </p>
                  </div>
                </div>
              )}

              {record.reexamStatus === "done" && (
                <p className="muted">
                  再検査の確認が完了しています。おつかれさまでした。
                </p>
              )}
            </div>
          )}

          <div className="card" style={{ marginTop: 20 }}>
            <h2>利用の停止</h2>
            <p className="muted">
              健康管理機能の利用をやめると、保存されている健診の記録・領収書はすべて削除されます。
            </p>
            <button
              className="btn-sm"
              disabled={busy}
              onClick={() => void handleOptIn(false)}
            >
              利用を停止する
            </button>
          </div>
        </>
      )}

      <p style={{ marginTop: 20 }}>
        <Link className="link" href="/home">
          ホームに戻る
        </Link>
      </p>

      <p className="muted" style={{ fontSize: "0.8rem" }}>
        この読取りと表示は医療的な診断ではありません。読取りはAIが行っているため、
        書類の内容と異なることがあります。内容に不安がある場合は、
        医師や産業医にご相談ください。
      </p>
    </main>
  );
}
