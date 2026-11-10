import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HostConnection,
  HostConnectionError,
  type ReviewModelPayload,
} from "../../api/host";

export type ReviewModelLoadState = "loading" | "ready" | "error";

export function reviewModelErrorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function reviewWriteNeedsRefresh(error: unknown): boolean {
  return error instanceof HostConnectionError && (error.status === 409 || error.message.includes("请刷新"));
}

export function useReviewModelSnapshot(baseUrl: string, projectId: string) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [loadState, setLoadState] = useState<ReviewModelLoadState>("loading");
  const [model, setModel] = useState<ReviewModelPayload | null>(null);
  const [message, setMessage] = useState("正在读取制作状态…");
  // Every load gets a monotonically increasing token. A project switch or a
  // newer manual refresh must not let an older response overwrite the current
  // workspace snapshot.
  const loadToken = useRef(0);

  const refresh = useCallback(async (): Promise<ReviewModelPayload> => {
    const token = ++loadToken.current;
    const next = await connection.refreshReviewModel(projectId);
    if (token === loadToken.current) {
      setModel(next);
      setLoadState("ready");
      setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    }
    return next;
  }, [connection, projectId]);

  useEffect(() => {
    const token = ++loadToken.current;
    setLoadState("loading");
    setMessage("正在读取制作状态…");
    void connection.reviewModel(projectId).then((next) => {
      if (token !== loadToken.current) return;
      setModel(next);
      setLoadState("ready");
      setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    }).catch((error: unknown) => {
      if (token !== loadToken.current) return;
      setLoadState("error");
      setMessage(reviewModelErrorMessage(error));
    });
    return () => {
      // Invalidate any response still in flight for the previous project or
      // Host. The request itself is shared/cached, but its state update is not.
      loadToken.current += 1;
    };
  }, [connection, projectId]);

  return {
    connection,
    loadState,
    message,
    model,
    refresh,
  };
}
