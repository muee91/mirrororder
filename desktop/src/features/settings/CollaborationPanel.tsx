import { useEffect, useMemo, useState } from "react";
import {
  DesktopClient,
  type CollaborationPayload,
  type CollaborationRole,
  type CollaborationStatus,
  type CollaborationUser,
} from "../../api/desktop";
import { HostConnectionError } from "../../api/host";

interface Props { baseUrl: string }

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function CollaborationPanel({ baseUrl }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<CollaborationPayload | null>(null);
  const [busyUserId, setBusyUserId] = useState("");
  const [message, setMessage] = useState("正在读取团队访问状态…");

  async function reload(): Promise<void> {
    try {
      const next = await client.collaboration();
      setPayload(next);
      setMessage(`desktop_collaboration.v1 · ${next.users.length} users · ${next.audit.length} audit rows`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(); }, [client]);

  async function update(user: CollaborationUser, values: { role?: CollaborationRole; status?: CollaborationStatus }): Promise<void> {
    setBusyUserId(user.user_id);
    setMessage(`正在更新 ${user.nickname || user.user_id}…`);
    try {
      const next = await client.updateCollaborator(user.user_id, values);
      setPayload(next);
      setMessage(`团队权限已更新 · ${next.users.length} users`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyUserId("");
    }
  }

  return (
    <div className="production-panel status-card collaboration-card">
      <div className="parse-heading">
        <div>
          <p className="eyebrow">Host-local Team Access</p>
          <h3>团队用户 / 权限 / 审计</h3>
        </div>
        <button type="button" className="secondary" onClick={() => void reload()}>刷新</button>
      </div>
      <p className="production-note">{message}</p>
      <div className="collaboration-users">
        {(payload?.users ?? []).length ? (payload?.users ?? []).map((user) => (
          <article className={`collaboration-user ${user.status === "disabled" ? "is-disabled" : ""}`} key={user.user_id}>
            <div className="collaboration-user-main">
              <strong>{user.nickname || "未命名用户"}</strong>
              <span>{user.user_id} · {user.device_count} devices</span>
              <small>{user.last_seen_at || "never seen"} · {user.last_ip || "no ip"}</small>
            </div>
            <label>
              <span>角色</span>
              <select
                value={user.role}
                disabled={busyUserId === user.user_id}
                onChange={(event) => void update(user, { role: event.target.value as CollaborationRole })}
              >
                <option value="viewer">viewer</option>
                <option value="reviewer">reviewer</option>
                <option value="manager">manager</option>
              </select>
            </label>
            <label>
              <span>状态</span>
              <select
                value={user.status}
                disabled={busyUserId === user.user_id}
                onChange={(event) => void update(user, { status: event.target.value as CollaborationStatus })}
              >
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
          </article>
        )) : <p className="empty-copy">还没有浏览器团队身份。Team Web 首次连接后，Python Core 会创建 pseudonymous browser identity。</p>}
      </div>
      <details className="collaboration-audit">
        <summary>访问审计 · {payload?.audit.length ?? 0}</summary>
        <div>
          {(payload?.audit ?? []).slice(0, 80).map((row, index) => (
            <p key={`${row.at}-${row.user_id}-${index}`}>
              <strong>{row.event}</strong>
              <span>{row.nickname || row.user_id} · {row.role} · {row.ip || "no ip"} · device …{row.device_id}</span>
              <small>{row.at}</small>
            </p>
          ))}
        </div>
      </details>
      <p className="production-note">角色与停用状态由现有 `CollaborationAccessStore` 校验并记录 audit；Desktop 只提供 Host-local 管理界面，不定义新的权限层级。</p>
    </div>
  );
}
