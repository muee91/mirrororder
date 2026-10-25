import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnection, type ReviewModelPayload, errorMessage } from "../../api/host";
import { SlatePlacementPools } from "./SlatePlacementPools";

interface Props {
  baseUrl: string;
  projectId: string;
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
 * entire Desktop Slate page. GoldenSlateWorkbench keeps the helper inside a
 * collapsed <details>; only mount the old Review workload after that details is
 * actually opened, so the primary Slate canvas does not issue duplicate Review
 * reads or construct placement pools in the background.
 */
export function SlateWorkbench(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const details = host?.closest("details");
    if (!(details instanceof HTMLDetailsElement)) {
      setExpanded(true);
      return;
    }
    const sync = () => setExpanded(details.open);
    sync();
    details.addEventListener("toggle", sync);
    return () => details.removeEventListener("toggle", sync);
  }, []);

  return <div ref={hostRef} className="golden-review-helper-host">{expanded ? <SlateWorkbenchContent {...props} /> : null}</div>;
}

function SlateWorkbenchContent({ baseUrl, projectId }: Props) {
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
