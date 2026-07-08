"use client";

// マイページ（指示書STEP1-3）。オンボーディング後もプロフィールをいつでも編集できる。
// あわせて「過去のストレスチェック結果の取り込み」の入口を置く
// （低頻度操作は設定置き場へ＝設計確定 2026-07-07・TODO.md参照）。
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, fns } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { compressImageToBase64, fileToBase64 } from "@/lib/fileUtils";
import {
  ROLE_LABELS,
  type Checkin,
  type ParsedStressCheck,
} from "@/lib/types";

const MAX_NAME_LENGTH = 50;
// 読取り用ファイルの上限（/health の健診読取りと同じ）
const DOC_MAX_BASE64 = 10_500_000;

// 3軸の表示ラベルと選択肢（1〜4の意味を言葉で添える）
const AXIS_DEFS = [
  {
    key: "workload" as const,
    label: "仕事の負担",
    options: ["1（軽い）", "2（やや軽い）", "3（やや大きい）", "4（大きい）"],
  },
  {
    key: "mood" as const,
    label: "心身の調子",
    options: ["1（つらい）", "2（やや不調）", "3（まずまず）", "4（好調）"],
  },
  {
    key: "support" as const,
    label: "周囲のサポート",
    options: ["1（少ない）", "2（やや少ない）", "3（まずまず）", "4（十分）"],
  },
];

export default function MyPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ストレスチェック取込：読取り結果（保存前に本人が確認・訂正する）
  const [importParsed, setImportParsed] = useState<ParsedStressCheck | null>(null);
  const [importDate, setImportDate] = useState("");
  const [importParsing, setImportParsing] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importDone, setImportDone] = useState(false);
  // 読み取った「特徴」を一緒に取り込むか（本人の同意＝チェックボックス。既定ON）
  const [importIncludeNote, setImportIncludeNote] = useState(true);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 取り込み済みの記録一覧（本人の checkins は Rules で本人のみ読める）
  const [importedRows, setImportedRows] = useState<
    {
      id: string;
      date: string;
      workload: number;
      mood: number;
      support: number;
      note: string;
    }[]
  >([]);

  // 取り込み済み記録の監視（取込・削除が即座に一覧へ反映される）
  useEffect(() => {
    if (status !== "ready" || !user) return;
    const q = query(
      collection(db, "checkins"),
      where("userId", "==", user.uid),
      orderBy("answeredAt", "desc"),
      limit(50)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: typeof importedRows = [];
        snap.docs.forEach((d) => {
          const data = d.data() as Checkin;
          if (data.source !== "imported") return;
          const at = data.answeredAt;
          rows.push({
            id: d.id,
            date:
              at instanceof Timestamp
                ? at.toDate().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
                : "（日付不明）",
            workload: data.answers.workload,
            mood: data.answers.mood,
            support: data.answers.support,
            note: data.importNote ?? "",
          });
        });
        setImportedRows(rows);
      },
      (err) => {
        console.error("取込記録の取得に失敗:", err);
      }
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, user]);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (profile && displayName === "") {
      setDisplayName(profile.displayName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(false);
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
      await updateDoc(doc(db, "users", user.uid), {
        displayName: name,
        updatedAt: serverTimestamp(),
      });
      setSaved(true);
    } catch (err) {
      console.error("プロフィールの保存に失敗:", err);
      setError("保存に失敗しました。もう一度お試しください。");
    } finally {
      setSubmitting(false);
    }
  };

  // ストレスチェック結果書類の読取り（ファイルは保存されない）
  const handleImportParse = async (file: File) => {
    setImportError("");
    setImportDone(false);
    setImportParsed(null);
    setImportParsing(true);
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
        ParsedStressCheck
      >(fns, "parseStressDocument");
      const result = await parseFn({ fileBase64, mimeType, templateId: "generic" });
      setImportParsed(result.data);
      setImportDate(result.data.examDate);
      setImportIncludeNote(true);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "書類の読取りに失敗しました。"
      );
    } finally {
      setImportParsing(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  // 本人が確認・訂正した値を保存
  const handleImportSave = async () => {
    if (!importParsed) return;
    if (!importDate) {
      setImportError("実施日を入力してください。");
      return;
    }
    setImportError("");
    setImportBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/checkins/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workload: importParsed.workload,
          mood: importParsed.mood,
          support: importParsed.support,
          examDate: importDate,
          importNote:
            importParsed.highlights && importIncludeNote
              ? importParsed.highlights
              : "",
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "保存に失敗しました。");
      }
      setImportParsed(null);
      setImportDone(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setImportBusy(false);
    }
  };

  // 取込記録の削除（誤取込のやり直し用）
  const handleImportDelete = async (row: {
    id: string;
    date: string;
  }) => {
    const confirmed = window.confirm(
      `${row.date} の取込記録を削除します。よろしいですか？`
    );
    if (!confirmed) return;
    setImportError("");
    setImportDone(false);
    setImportBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/checkins/import/delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ checkinId: row.id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "削除に失敗しました。");
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <main>
      <div className="topbar">
        <Link className="link" href="/">
          ← トップへ戻る
        </Link>
        <button className="link" onClick={() => logout()}>
          ログアウト
        </button>
      </div>

      <div className="card">
        <h1>マイページ</h1>
        <p className="muted">
          表示名は変更できます。メールアドレスとロールは管理者側で管理されています。
        </p>

        {error && <div className="error">{error}</div>}
        {saved && <div className="status-done">保存しました ✓</div>}

        <form onSubmit={handleSubmit}>
          <label htmlFor="email">メールアドレス（変更不可）</label>
          <input id="email" type="email" value={profile.email} disabled />

          <label>ロール</label>
          <p style={{ marginTop: 0 }}>
            <span className="role-tag">{ROLE_LABELS[profile.role]}</span>
          </p>

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
            保存する
          </button>
        </form>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>過去のストレスチェックの取り込み</h2>
        <p className="muted">
          会社等で受けたストレスチェックの結果書類（写真またはPDF）を取り込むと、
          日々のチェックのふりかえり（過去との比較）に活かされます。
          書類そのものは保存されず、大づかみな3つの評価と実施日だけが記録されます。
        </p>

        {importError && <div className="error">{importError}</div>}
        {importDone && (
          <div className="status-done">
            取り込みました ✓ 次回のチェックから、ふりかえりに活かされます。
          </div>
        )}

        <input
          ref={importInputRef}
          type="file"
          accept="application/pdf,image/*"
          disabled={importParsing || importBusy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportParse(f);
          }}
          aria-label="ストレスチェック結果のファイル"
        />
        {importParsing && (
          <p className="muted">
            <span className="spinner" />
            読み取り中…（少し時間がかかります）
          </p>
        )}

        {importedRows.length > 0 && (
          <div style={{ margin: "14px 0" }}>
            <p className="muted" style={{ marginBottom: 4 }}>
              取り込み済みの記録：
            </p>
            {importedRows.map((row) => (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0",
                  borderBottom: "1px solid rgba(0,0,0,0.08)",
                }}
              >
                <span style={{ flex: 1 }}>
                  {row.date}　仕事の負担 {row.workload}・心身の調子 {row.mood}・サポート {row.support}
                  {row.note && (
                    <span
                      className="muted"
                      style={{ display: "block", fontSize: "0.82rem" }}
                    >
                      特徴：{row.note}
                    </span>
                  )}
                </span>
                <button
                  className="btn-sm"
                  disabled={importBusy}
                  onClick={() => void handleImportDelete(row)}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}

        {importParsed && (
          <div className="feedback-box" style={{ marginTop: 12 }}>
            <p style={{ marginTop: 0 }}>
              <strong>読み取った内容の確認</strong>
              （書類と違うところは、ここで直してから保存してください）
            </p>
            {AXIS_DEFS.map((axis) => (
              <label key={axis.key} style={{ display: "block", marginBottom: 8 }}>
                {axis.label}：
                <select
                  value={importParsed[axis.key]}
                  disabled={importBusy}
                  onChange={(e) =>
                    setImportParsed({
                      ...importParsed,
                      [axis.key]: Number(e.target.value),
                    })
                  }
                  style={{ marginLeft: 8 }}
                >
                  {axis.options.map((label, i) => (
                    <option key={i} value={i + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label style={{ display: "block", marginBottom: 12 }}>
              実施日：
              <input
                type="date"
                value={importDate}
                disabled={importBusy}
                onChange={(e) => setImportDate(e.target.value)}
                style={{ marginLeft: 8 }}
              />
            </label>
            {importParsed.highlights && (
              <div style={{ marginBottom: 12 }}>
                <p style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>
                  読み取った特徴：{importParsed.highlights}
                </p>
                <label
                  style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
                >
                  <input
                    type="checkbox"
                    checked={importIncludeNote}
                    disabled={importBusy}
                    onChange={(e) => setImportIncludeNote(e.target.checked)}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    この特徴も一緒に取り込む
                    <span className="muted">
                      （ふりかえりの言葉が、あなたの状況に合わせてより具体的になります）
                    </span>
                  </span>
                </label>
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="primary"
                disabled={importBusy || !importDate}
                onClick={() => void handleImportSave()}
              >
                {importBusy && <span className="spinner" />}
                この内容で取り込む
              </button>
              <button
                className="btn-sm"
                disabled={importBusy}
                onClick={() => setImportParsed(null)}
              >
                破棄する
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
