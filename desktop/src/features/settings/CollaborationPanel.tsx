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
      setMessage(next.users.length ? `${next.users.length} 位团队成员已登记` : "还没有团队成员访问记录");
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
      setMessage("团队权限已更新。");
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
          <p className="eyebrow">团队访问</p>
          <h3>成员与权限</h3>
        </div>
        <button type="button" className="secondary" onClick={() => void reload()}>刷新</button>
      </div>
      <p className="production-note">{message}</p>
      <div className="collaboration-users">
        {(payload?.users ?? []).length ? (payload?.users ?? []).map((user) => (
          <article className={`collaboration-user ${user.status === "disabled" ? "is-disabled" : ""}`} key={user.user_id}>
            <div className="collaboration-user-main">
              <strong>{user.nickname || "未命名成员"}</strong>
              <span>{user.device_count} 台设备 · {user.status === "disabled" ? "已停用" : "可访问"}</span>
              <small>{user.last_seen_at ? `最近访问 ${user.last_seen_at}` : "尚未访问"}{user.last_ip ? ` · ${user.last_ip}` : ""}</small>
            </div>
            <label>
              <span>角色</span>
              <select
                value={user.role}
                disabled={busyUserId === user.user_id}
                onChange={(event) => void update(user, { role: event.target.value as CollaborationRole })}
              >
                <option value="viewer">查看者</option>
                <option value="reviewer">审阅者</option>
                <option value="manager">管理员</option>
              </select>
            </label>
            <label>
              <span>访问</span>
              <select
                value={user.status}
                disabled={busyUserId === user.user_id}
                onChange={(event) => void update(user, { status: event.target.value as CollaborationStatus })}
              >
                <option value="active">允许</option>
                <option value="disabled">停用</option>
              </select>
            </label>
          </article>
        )) : <p className="empty-copy">团队审阅首次连接后会登记浏览器身份；这里随后可以调整访问角色或停用成员。</p>}
      </div>
      <details className="collaboration-audit">
        <summary>访问记录 · {payload?.audit.length ?? 0}</summary>
        <div>
          {(payload?.audit ?? []).slice(0, 80).map((row, index) => (
            <p key={`${row.at}-${row.user_id}-${index}`}>
              <strong>{row.event}</strong>
              <span>{row.nickname || row.user_id} · {row.role} · {row.ip || "未知地址"} · device …{row.device_id}</span>
              <small>{row.at}</small>
            </p>
          ))}
        </div>
      </details>
      <p className="production-note">这些权限只控制 Team Web 访问，不会授予本机最终 Editorial Decision、场记或时间线编辑权威。</p>
    </div>
  );
}
