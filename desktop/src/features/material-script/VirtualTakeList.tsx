import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ReviewTakeGroup } from "../../api/host";
import { TakeCard } from "./TakeCard";
import { TAKE_ROW_HEIGHT, virtualRange } from "./model";

export { DRAG_TAKE_MIME, episodeLabel, mappingLabel, mappingSourceLabel } from "./TakeCard";

export function VirtualTakeList({
  takes,
  selectedGroupId,
  onSelect,
  onDragBegin,
  onDragFinish,
}: {
  takes: ReviewTakeGroup[];
  selectedGroupId: string | null;
  onSelect: (take: ReviewTakeGroup) => void;
  onDragBegin: (groupId: string) => void;
  onDragFinish: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewportHeight(Math.max(TAKE_ROW_HEIGHT, node.clientHeight || 720));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !selectedGroupId) return;
    const index = takes.findIndex((take) => take.group_id === selectedGroupId);
    if (index < 0) return;
    const top = index * TAKE_ROW_HEIGHT;
    if (top < node.scrollTop || top + TAKE_ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      node.scrollTop = Math.max(0, top - TAKE_ROW_HEIGHT);
      setScrollTop(node.scrollTop);
    }
  }, [selectedGroupId, takes]);

  function handleNavigation(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey || takes.length === 0) return;
    const currentIndex = Math.max(0, takes.findIndex((take) => take.group_id === selectedGroupId));
    let nextIndex = currentIndex;
    if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "ArrowDown") nextIndex = Math.min(takes.length - 1, currentIndex + 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = takes.length - 1;
    else return;
    event.preventDefault();
    const next = takes[nextIndex];
    if (next) onSelect(next);
  }

  const range = virtualRange(takes.length, scrollTop, viewportHeight);
  const visible = takes.slice(range.start, range.end);

  return (
    <div
      className="take-virtual-scroll"
      ref={viewportRef}
      tabIndex={0}
      aria-keyshortcuts="ArrowUp ArrowDown Home End"
      title="↑/↓ 切换 Take · Home/End 跳到首尾"
      onKeyDown={handleNavigation}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label={`素材 Take，共 ${takes.length} 条`}
    >
      <div className="take-virtual-canvas" style={{ height: takes.length * TAKE_ROW_HEIGHT }}>
        {visible.map((take, offset) => (
          <div
            className="virtual-take-row"
            key={take.group_id}
            style={{ transform: `translateY(${(range.start + offset) * TAKE_ROW_HEIGHT}px)` }}
          >
            <TakeCard
              take={take}
              selected={take.group_id === selectedGroupId}
              onSelect={() => onSelect(take)}
              onDragBegin={onDragBegin}
              onDragFinish={onDragFinish}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
