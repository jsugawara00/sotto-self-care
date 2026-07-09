"use client";

// 一括案内の送信・確認状況（STEP4・企画書8-4）。hr / admin / owner 向け。
//  - タイトル＋本文＋宛先（全員 or 今周期の未実施者のみ）で送信。個人指定は作らない。
//  - 「メッセージは記録されます」のソフト表示（8-4③ ハラスメント抑止思想の波及）。
//  - 送信済み一覧では「確認しました」の完了有無が見える（企画書7章＝完了有無まで）。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/AuthContext";
import {
  AUDIENCE_LABELS,
  ROLE_LABELS,
  type AnnouncementAudience,
} from "@/lib/types";

type AnnouncementItem = {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  senderName: string;
  createdAt: string | null;
  recipients: { name: string; acked: boolean }[];
  ackedCount: number;
  recipientCount: number;
};

const SENDER_ROLES = ["hr", "admin", "owner"];

export default function AnnouncementsPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<AnnouncementAudience>("all");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const [items, setItems] = useState<AnnouncementItem[] | null>(null);

  const canSend = !!profile && SENDER_ROLES.includes(profile.role);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (profile && !SENDER_ROLES.includes(profile.role)) {
      router.replace("/");
    }
  }, [status, profile, router]);

  const loadItems = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/announcements", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "案内一覧の取得に失敗しました。");
      }
      const data = (await res.json()) as { items: AnnouncementItem[] };
      setItems(data.items);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "案内一覧の取得に失敗しました。"
      );
      setItems([]);
    }
  }, [user]);

  useEffect(() => {
    if (status !== "ready" || !canSend) return;
    void loadItems();
  }, [status, canSend, loadItems]);

  if (status !== "ready" || !user || !profile || !canSend) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  const handleSend = async () => {
    setError("");
    setSentMessage("");
    if (title.trim().length === 0 || body.trim().length === 0) {
      setError("タイトルと本文を入力してください。");
      return;
    }
    if (
      !window.confirm(
        `「${AUDIENCE_LABELS[audience]}」に案内を送信します。よろしいですか？`
      )
    ) {
      return;
    }
    setSending(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), audience }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "案内の送信に失敗しました。");
      }
      setTitle("");
      setBody("");
      setAudience("all");
      setSentMessage("案内を送信しました。");
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "案内の送信に失敗しました。");
    } finally {
      setSending(false);
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
        <h1>一括案内</h1>
        <p className="muted">
          健康診断やストレスチェックのご案内・リマインドをまとめて送れます。
          受け取った人が「確認しました」を押すと、下の一覧に反映されます。
        </p>

        {error && <div className="error">{error}</div>}
        {sentMessage && <div className="status-done">{sentMessage}</div>}

        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <label>
            タイトル（50文字まで）
            <input
              type="text"
              value={title}
              maxLength={50}
              disabled={sending}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: "100%", marginTop: 4 }}
            />
          </label>
          <label>
            本文（500文字まで）
            <textarea
              value={body}
              maxLength={500}
              rows={5}
              disabled={sending}
              onChange={(e) => setBody(e.target.value)}
              style={{ width: "100%", marginTop: 4 }}
            />
          </label>
          <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
            💬 受け取る人が安心して読めるよう、優しい言葉を心がけましょう。
          </p>
          <div>
            宛先：
            {(Object.keys(AUDIENCE_LABELS) as AnnouncementAudience[]).map((a) => (
              <label key={a} style={{ marginLeft: 12 }}>
                <input
                  type="radio"
                  name="audience"
                  checked={audience === a}
                  disabled={sending}
                  onChange={() => setAudience(a)}
                />{" "}
                {AUDIENCE_LABELS[a]}
              </label>
            ))}
          </div>
          <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
            対象者＝従業員一覧に載せている担当者・総務。「未実施者のみ」を選ぶと、
            送信した時点でまだ今周期のセルフチェックを行っていない人にだけ届きます。
          </p>
          <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
            このメッセージは記録され、管理者・総務が確認状況とあわせて閲覧できます。
          </p>
          <div>
            <button
              className="primary"
              disabled={sending}
              onClick={() => void handleSend()}
            >
              {sending ? "送信中…" : "送信する"}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>送信済みの案内と確認状況</h2>
        {items === null ? (
          <p className="muted">
            <span className="spinner" />
            読み込み中…
          </p>
        ) : items.length === 0 ? (
          <p className="muted">送信済みの案内はまだありません。</p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              style={{
                borderTop: "1px solid var(--border)",
                padding: "12px 0",
              }}
            >
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ flex: 1 }}>{item.title}</strong>
                <span className="muted" style={{ fontSize: "0.82rem" }}>
                  {item.createdAt
                    ? new Date(item.createdAt).toLocaleString("ja-JP", {
                        timeZone: "Asia/Tokyo",
                      })
                    : ""}
                </span>
              </div>
              <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{item.body}</p>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "4px 0" }}>
                送信者：{item.senderName}／宛先：{AUDIENCE_LABELS[item.audience]}／
                確認済み：{item.ackedCount} / {item.recipientCount} 人
              </p>
              <details>
                <summary className="link" style={{ cursor: "pointer" }}>
                  確認の状況を見る
                </summary>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {item.recipients.map((r, i) => (
                    <li key={i}>
                      {r.name}：{r.acked ? "確認済み ✓" : "未確認"}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ))
        )}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <p style={{ margin: 0 }}>
          <Link className="link" href="/">
            トップへ戻る
          </Link>
        </p>
      </div>
    </main>
  );
}
