import { useLayoutEffect, useRef, type ReactNode } from "react";
import { StudioIcon } from "../../components/StudioIcons";

export function ReviewCompareDialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (node.showModal) node.showModal();
    else node.setAttribute("open", "");
    return () => { node.close?.(); };
  }, []);
  return <dialog ref={dialog} className="review-compare-dialog" aria-label="多机位同看"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="review-compare-shell">
      <header><h2>{title}</h2><button className="secondary" type="button" onClick={onClose} autoFocus>
        <StudioIcon name="close" size={14} />返回审阅</button></header>
      {children}
    </div>
  </dialog>;
}
