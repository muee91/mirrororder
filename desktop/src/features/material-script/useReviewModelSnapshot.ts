import { useCallback, useEffect, useMemo, useState } from "react";
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

  const refresh = useCallback(async (): Promise<ReviewModelPayload> => {
    const next = await connection.reviewModel(projectId);
    setModel(next);
    setLoadState("ready");
    setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    return next;
  }, [connection, projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setMessage("正在读取制作状态…");
    void connection.reviewModel(projectId).then((next) => {
      if (cancelled) return;
      setModel(next);
      setLoadState("ready");
      setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadState("error");
      setMessage(reviewModelErrorMessage(error));
    });
    return () => {
      cancelled = true;
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
