import { useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload } from "../../api/host";
import { SlatePlacementPools } from "./SlatePlacementPools";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem("mirrororder.productionActor")?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Compatibility-sized adapter for the placement helper that used to own the
 * entire Desktop Slate page. The primary production canvas is now
 * GoldenSlateWorkbench. Keeping this export avoids duplicating Review placement
 * logic while the helper is embedded below the Golden Slate table.
 */
export function SlateWorkbench({ baseUrl, projectId }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [message, setMessage] = useState("正在读取 Review placement…");

  async function reload(): Promise<void> {
    try {
      const next = await host.reviewModel(projectId);
      setReview(next);
      setMessage(`Review r${next.revisions.review}`);
    } catch (error) {
      setMessage(errorMessage(error));
      throw error;
    }
  }

  useEffect(() => {
    void reload().catch(() => undefined);
    // host is memoized by baseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, projectId]);

  return (
    <section aria-label="Review 归集辅助">
      {!review ? <p className="golden-placement-empty">{message}</p> : (
        <SlatePlacementPools
          baseUrl={baseUrl}
          projectId={projectId}
          review={review}
          actor={storedActor()}
          onChanged={reload}
        />
      )}
    </section>
  );
}
