"use client";

// 本人トップページ（指示書STEP2-6）。
//  - 現在の周期での実施済み／未実施の表示（周期は orgSettings に従う）
//  - 直近の縦断フィードバックと（該当時のみ）確認チャットの質問を表示
//  - 試作の onSnapshot パターンを踏襲（Functions の書き戻しが自動で反映される）
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { currentPeriodStart } from "@/lib/cycle";
import {
  CYCLE_LABELS,
  ROLE_LABELS,
  type CheckCycle,
  type Checkin,
  type HealthFeatureSettings,
  type OrgSettings,
  type ReexamStatus,
} from "@/lib/types";
import { CheckinFeedback } from "@/components/CheckinFeedback";

export default function MemberHomePage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [cycle, setCycle] = useState<CheckCycle>("weekly");
  const [latest, setLatest] = useState<{ id: string; data: Checkin } | null>(
    null
  );
  const [loadingCheckin, setLoadingCheckin] = useState(true);
  // チェック完了後はカードを畳む（見たいときだけ開く）。未返答の確認チャットがあるときは畳まない
  const [showCheckDetail, setShowCheckDetail] = useState(false);
  // 健康管理（STEP3）：企業側スイッチと、自分の健診記録（トップの「気づきの窓」用）。
  // トップは毎日目にする場所なので、管理用語ではなく励ましの言葉に変換して表示する。
  const [healthEnabled, setHealthEnabled] = useState(false);
  const [healthRecord, setHealthRecord] = useState<{
    reexamStatus: ReexamStatus;
    notes: string;
  } | null>(null);
  // 総務向け：受領確認待ちの件数（機微データはAPI経由のみのため取得式。失敗時はnullのまま非表示）
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  // 自分宛ての未確認の一括案内（STEP4）。「確認しました」で消える＝状態導出・自動消滅
  const [announcements, setAnnouncements] = useState<
    {
      id: string;
      title: string;
      body: string;
      senderName: string;
      senderRoleLabel: string;
    }[]
  >([]);
  const [ackingId, setAckingId] = useState<string | null>(null);

  // アクセス制御：未ログイン→/login、admin/owner→/admin、未オンボーディング→/onboarding
  useEffect(() => {
    if (status === "loading") return;
    if (status !== "ready") {
      router.replace("/login");
      return;
    }
    if (!profile) return;
    if (!profile.onboarded) {
      router.replace("/onboarding");
    } else if (profile.role === "admin" || profile.role === "owner") {
      router.replace("/admin");
    }
  }, [status, profile, router]);

  // 組織の周期設定を監視
  useEffect(() => {
    if (status !== "ready") return;
    const unsub = onSnapshot(doc(db, "orgSettings", "default"), (snap) => {
      if (snap.exists()) {
        setCycle((snap.data() as OrgSettings).checkCycle);
      }
    });
    return () => unsub();
  }, [status]);

  // 健康管理の企業側スイッチを監視（STEP3・二重オプトイン）
  useEffect(() => {
    if (status !== "ready") return;
    const unsub = onSnapshot(doc(db, "orgSettings", "healthFeature"), (snap) => {
      setHealthEnabled(
        snap.exists() &&
          (snap.data() as HealthFeatureSettings).enabled === true
      );
    });
    return () => unsub();
  }, [status]);

  // 自分の健診記録を取得（機微データは直読み不可のためAPI経由。補助表示なので失敗は無視）
  useEffect(() => {
    if (status !== "ready" || !user || !healthEnabled) {
      setHealthRecord(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/health/me", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          record: { reexamStatus: ReexamStatus; notes: string } | null;
        };
        if (!cancelled) setHealthRecord(data.record ?? null);
      } catch {
        // 気づきの窓は補助情報。取得失敗で画面を止めない
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, user, healthEnabled]);

  // 総務のみ：受領確認待ちの件数を取得（開いたとき時点の値。詳細は /hr で）
  useEffect(() => {
    if (
      status !== "ready" ||
      !user ||
      !healthEnabled ||
      profile?.role !== "hr"
    ) {
      setPendingCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/hr/reexams", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          items: { reexamStatus: string }[];
        };
        if (!cancelled) {
          setPendingCount(
            data.items.filter((i) => i.reexamStatus === "submitted").length
          );
        }
      } catch {
        // バッジは補助情報。取得失敗で画面を止めない
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, user, healthEnabled, profile?.role]);

  // 自分宛ての未確認の案内を取得（announcements は直読み不可のためAPI経由。失敗は無視）
  useEffect(() => {
    if (status !== "ready" || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/announcements/mine", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          items: {
            id: string;
            title: string;
            body: string;
            senderName: string;
            senderRoleLabel: string;
          }[];
        };
        if (!cancelled) setAnnouncements(data.items);
      } catch {
        // お知らせは補助情報。取得失敗で画面を止めない
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, user]);

  // 「確認しました」（1タップ応答＝報告の仕組み化。送信側には完了有無だけが伝わる）
  const handleAck = async (id: string) => {
    if (!user) return;
    setAckingId(id);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/announcements/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setAnnouncements((prev) => prev.filter((a) => a.id !== id));
      }
    } catch {
      // 失敗時はそのまま表示を残す（次回開いたときに再挑戦できる）
    } finally {
      setAckingId(null);
    }
  };

  // 自分の直近チェックを監視（Rules：checkins は本人のみ read 可）
  useEffect(() => {
    if (status !== "ready" || !user) return;
    // 取込データ（source: "imported"）はフィードバックを持たないため表示対象にしない。
    // 混ざっても選べるよう多めに取得し、直近のセルフチェックを選ぶ。
    const q = query(
      collection(db, "checkins"),
      where("userId", "==", user.uid),
      orderBy("answeredAt", "desc"),
      limit(10)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const d = snap.docs.find(
          (docSnap) => (docSnap.data() as Checkin).source !== "imported"
        );
        if (!d) {
          setLatest(null);
        } else {
          setLatest({ id: d.id, data: d.data() as Checkin });
        }
        setLoadingCheckin(false);
      },
      (err) => {
        console.error("チェック履歴の取得に失敗:", err);
        setLoadingCheckin(false);
      }
    );
    return () => unsub();
  }, [status, user]);

  const isMemberish =
    profile && (profile.role === "member" || profile.role === "hr");

  if (status !== "ready" || !user || !profile || !profile.onboarded || !isMemberish) {
    return (
      <main>
        <div className="center">
          <span className="spinner" />
          読み込み中…
        </div>
      </main>
    );
  }

  // 現在の周期内に回答済みか
  const periodStart = currentPeriodStart(cycle);
  const answeredAt = latest?.data.answeredAt;
  const doneThisPeriod =
    answeredAt instanceof Timestamp &&
    answeredAt.toDate().getTime() >= periodStart.getTime();

  // 確認チャットの質問に未返答なら、畳まずに見せ続ける（そっと問いかけたものを隠さない）
  const needsReply =
    !!latest &&
    latest.data.checkQuestion.length > 0 &&
    !latest.data.checkAnswer;
  const checkExpanded = needsReply || showCheckDetail;

  return (
    <main>
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

      {/* お知らせバナー（STEP4）：アクションできるお知らせだけを最上部で目立たせる。
          状態から導出するため、対応が済むと自動で消える（消し忘れなし）。 */}
      {healthRecord?.reexamStatus === "returned" && (
        <div className="notice-bar">
          <span>
            🔔 総務からお知らせが届いています。健康管理のページで内容をご確認ください。
          </span>
          <Link className="link" href="/health">
            確認する
          </Link>
        </div>
      )}
      {profile.role === "hr" && (pendingCount ?? 0) > 0 && (
        <div className="notice-bar">
          <span>🔔 再検査の受領確認待ちが {pendingCount} 件あります。</span>
          <Link className="link" href="/hr">
            確認する
          </Link>
        </div>
      )}

      {/* 一括案内（STEP4・企画書8-4）：バナーと同じ配色のブロックで本文まで表示。
          「確認しました」で消える（＝報告の仕組み化。送信側には完了有無だけが伝わる） */}
      {announcements.map((a) => (
        <div key={a.id} className="notice-box" style={{ margin: "0 0 14px" }}>
          <strong>🔔 {a.title}</strong>
          <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{a.body}</p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              {a.senderName}（{a.senderRoleLabel}）より
            </span>
            <button
              className="btn-sm"
              disabled={ackingId === a.id}
              onClick={() => void handleAck(a.id)}
            >
              {ackingId === a.id ? "送信中…" : "確認しました"}
            </button>
          </div>
        </div>
      ))}

      <div className="card">
        <h1>ようこそ、{profile.displayName} さん</h1>

        {loadingCheckin ? (
          <p className="muted">
            <span className="spinner" />
            状況を確認中…
          </p>
        ) : doneThisPeriod && latest ? (
          <>
            {/* 完了後は一行に畳む（アコーディオン）。未返答の確認チャットがあるときは開いたまま */}
            <div
              role="button"
              aria-expanded={checkExpanded}
              onClick={() => {
                if (!needsReply) setShowCheckDetail((v) => !v);
              }}
              style={{
                cursor: needsReply ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div className="status-done" style={{ flex: 1, margin: 0 }}>
                今回（{CYCLE_LABELS[cycle]}）のチェックは完了しています ✓
              </div>
              {!needsReply && (
                <span className="link" style={{ whiteSpace: "nowrap" }}>
                  {checkExpanded ? "たたむ" : "ひらく"}
                </span>
              )}
            </div>
            {checkExpanded && (
              <div style={{ marginTop: 12 }}>
                <CheckinFeedback
                  checkinId={latest.id}
                  checkin={latest.data}
                  user={user}
                />
                <div style={{ marginTop: 14 }}>
                  <Link className="link" href="/check">
                    もう一度チェックする
                  </Link>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="status-todo">
              今回（{CYCLE_LABELS[cycle]}）のチェックはまだです
            </div>
            <p className="muted">
              ほんの30秒。今の状態を3つの質問で振り返ってみませんか。
              無理のない範囲で大丈夫です。
            </p>
            <Link href="/check">
              <button className="primary">チェックをする</button>
            </Link>
            {latest && (
              <div style={{ marginTop: 20 }}>
                <p className="muted" style={{ marginBottom: 4 }}>
                  前回のふりかえり：
                </p>
                <CheckinFeedback
                  checkinId={latest.id}
                  checkin={latest.data}
                  user={user}
                />
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 20 }}>
          <Link className="link" href="/mypage">
            マイページ
          </Link>
        </div>

        <p className="muted" style={{ marginTop: 20, fontSize: "0.82rem" }}>
          このチェックとフィードバックは医療的な診断ではありません。フィードバックはAIが作成しているため、実情に合わないことがあります。気になる状態が続く場合は、産業医や専門家への相談をご検討ください。
        </p>
      </div>

      {healthEnabled && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>健康管理</h2>

          {/* 気づきの窓：管理用語（未完了・未受診）を使わず、励ましの言葉で。
              受診の報告（提出）後はお知らせを消す。記録が無ければ静かに空欄。 */}
          {healthRecord?.reexamStatus === "pending" && (
            <div className="feedback-box">
              健診の結果に、少しだけ気にかけてほしいお知らせがありました。
              体のことを確かめる時間を、無理のない範囲で予定に入れてみませんか。
            </div>
          )}

          {/* 差し戻しのお知らせは最上部のバナーに一本化（このカード内では重複表示しない） */}

          {healthRecord && healthRecord.notes.length > 0 && (
            <div style={{ marginTop: healthRecord.reexamStatus === "pending" ? 10 : 0 }}>
              <p className="muted" style={{ marginBottom: 4 }}>
                日頃のケアのヒント：
              </p>
              <div className="feedback-box" style={{ whiteSpace: "pre-wrap" }}>
                {healthRecord.notes}
              </div>
            </div>
          )}

          {healthRecord &&
            healthRecord.notes.length === 0 &&
            healthRecord.reexamStatus === "none" && (
              <div className="feedback-box">
                今回の結果で特に気になる点はありませんでした。
                これからも、ご自身のペースで健康を大切にお過ごしください。
              </div>
            )}

          <p style={{ margin: "10px 0 0" }}>
            <Link className="link" href="/health">
              健診書類の読取り・再検査の報告
            </Link>
          </p>
        </div>
      )}

      {profile.role === "hr" && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>総務メニュー</h2>
          {healthEnabled && pendingCount !== null && pendingCount > 0 && (
            <div className="status-todo">
              受領確認待ち：{pendingCount}件
            </div>
          )}
          {healthEnabled && pendingCount === 0 && (
            <p className="muted" style={{ margin: "0 0 8px" }}>
              確認待ちの提出はありません。
            </p>
          )}
          {healthEnabled && (
            <p style={{ margin: "8px 0 0" }}>
              <Link className="link" href="/hr">
                再検査の受領確認・承認
              </Link>
            </p>
          )}
          <p style={{ margin: "8px 0 0" }}>
            <Link className="link" href="/announcements">
              一括案内の送信・確認状況
            </Link>
          </p>
        </div>
      )}
    </main>
  );
}
