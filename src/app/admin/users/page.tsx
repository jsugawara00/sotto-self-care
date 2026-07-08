"use client";

// 従業員一覧画面（指示書STEP1-5）。admin / owner 向け。
//  - 行ごとの「ロール切替セレクト」（変更できるのは owner のみ。admin は閲覧のみ）
//  - 「一覧に載せる／載せないトグル」（admin / owner）
//  - 招待の発行（メールアドレス＋role初期値）
// ガードレール（確認ダイアログ・管理者ゼロ禁止・自己昇格禁止）はサーバーAPIでも強制される。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import {
  ROLE_LABELS,
  ROLES,
  type Invitation,
  type Role,
  type UserProfile,
} from "@/lib/types";

type UserRow = UserProfile & { id: string };
type InvitationRow = Invitation & { id: string };

// 招待時に指定できる role初期値（owner は招待では付与しない＝仮決め）
const INVITABLE_ROLES: Role[] = ["member", "hr", "admin"];

export default function AdminUsersPage() {
  const { status, user, profile, logout } = useAuth();
  const router = useRouter();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [error, setError] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // 招待フォーム
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviting, setInviting] = useState(false);

  const isAdminish = profile?.role === "admin" || profile?.role === "owner";
  const isOwner = profile?.role === "owner";

  // アクセス制御：admin / owner 以外は入口ページへ
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

  // users / invitations を監視（Rules 側で admin/owner のみ read 可）
  useEffect(() => {
    if (status !== "ready" || !isAdminish) return;
    const unsubUsers = onSnapshot(
      query(collection(db, "users"), orderBy("email")),
      (snap) => {
        setUsers(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserProfile) }))
        );
      },
      (err) => {
        console.error("ユーザー一覧の取得に失敗:", err);
        setError("ユーザー一覧の取得に失敗しました。");
      }
    );
    const unsubInvites = onSnapshot(
      collection(db, "invitations"),
      (snap) => {
        setInvitations(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Invitation) }))
        );
      },
      (err) => {
        console.error("招待一覧の取得に失敗:", err);
      }
    );
    return () => {
      unsubUsers();
      unsubInvites();
    };
  }, [status, isAdminish]);

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

  // API 呼び出し共通（IDトークン付き POST）
  const callApi = async (path: string, body: object): Promise<void> => {
    const idToken = await user.getIdToken();
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "操作に失敗しました。");
    }
  };

  // ロール切替（確認ダイアログ＝指示書STEP1-5 ガードレール）
  const handleRoleChange = async (target: UserRow, newRole: Role) => {
    setError("");
    const confirmed = window.confirm(
      `${target.displayName}（${target.email}）のロールを「${ROLE_LABELS[target.role]}」から「${ROLE_LABELS[newRole]}」に変更します。よろしいですか？\n\n※ この変更は監査ログに記録されます。`
    );
    if (!confirmed) return;
    setBusyUserId(target.id);
    try {
      await callApi("/api/admin/users/role", {
        targetUserId: target.id,
        role: newRole,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "ロール変更に失敗しました。");
    } finally {
      setBusyUserId(null);
    }
  };

  // 一覧に載せる／載せないトグル
  const handleListedToggle = async (target: UserRow) => {
    setError("");
    setBusyUserId(target.id);
    try {
      await callApi("/api/admin/users/listed", {
        targetUserId: target.id,
        listed: !target.listed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "変更に失敗しました。");
    } finally {
      setBusyUserId(null);
    }
  };

  // 招待の発行
  const handleInvite = async () => {
    setError("");
    setInviteMessage("");
    const email = inviteEmail.trim().toLowerCase();
    if (!email) {
      setError("招待するメールアドレスを入力してください。");
      return;
    }
    setInviting(true);
    try {
      await callApi("/api/admin/invitations", { email, role: inviteRole });
      setInviteMessage(`${email} に「${ROLE_LABELS[inviteRole]}」として招待を発行しました。`);
      setInviteEmail("");
      setInviteRole("member");
    } catch (err) {
      setError(err instanceof Error ? err.message : "招待の発行に失敗しました。");
    } finally {
      setInviting(false);
    }
  };

  const pendingInvitations = invitations.filter((i) => i.status === "pending");

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
        <div className="topbar" style={{ marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>従業員一覧</h1>
          <Link className="link" href="/admin">
            ← 管理トップへ
          </Link>
        </div>
        <p className="muted">
          ロールの変更ができるのは全権のみです。変更・招待はすべて監査ログに記録されます。
        </p>

        {error && <div className="error">{error}</div>}

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>氏名 / メール</th>
                <th>ロール</th>
                <th>一覧に載せる</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.displayName}
                    {u.id === user.uid && (
                      <span className="role-tag">自分</span>
                    )}
                    <br />
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {u.email}
                    </span>
                  </td>
                  <td>
                    <select
                      value={u.role}
                      disabled={!isOwner || busyUserId === u.id}
                      onChange={(e) =>
                        handleRoleChange(u, e.target.value as Role)
                      }
                      aria-label={`${u.displayName} のロール`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn-sm"
                      disabled={busyUserId === u.id}
                      onClick={() => handleListedToggle(u)}
                    >
                      {u.listed ? "載せる ✓" : "載せない"}
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    ユーザーがいません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>招待を発行する</h2>
        <p className="muted">
          招待したメールアドレスの Google アカウントでログインした人だけが、この組織に参加できます。
        </p>

        {inviteMessage && <div className="status-done">{inviteMessage}</div>}

        <label htmlFor="inviteEmail">メールアドレス</label>
        <input
          id="inviteEmail"
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="taro@example.com"
        />

        <label htmlFor="inviteRole">ロール初期値</label>
        <div style={{ marginBottom: 16 }}>
          <select
            id="inviteRole"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as Role)}
          >
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <button className="primary" onClick={handleInvite} disabled={inviting}>
          {inviting && <span className="spinner" />}
          招待を発行する
        </button>

        {pendingInvitations.length > 0 && (
          <>
            <h2 style={{ marginTop: 24 }}>未使用の招待</h2>
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>メールアドレス</th>
                    <th>ロール初期値</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvitations.map((inv) => (
                    <tr key={inv.id}>
                      <td>{inv.email}</td>
                      <td>{ROLE_LABELS[inv.role]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
