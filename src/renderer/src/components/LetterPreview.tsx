import { useLayoutEffect, useRef, useState } from "react";
import type { DocMapping, OutputPlan } from "@shared/types";
import { useLetterPreview } from "@/lib/useLetterPreview";
import DocPreview, { type DocTags } from "@/components/DocPreview";
import { WORDS } from "@shared/words";

const PX_PER_PT = 96 / 72;

/** The real letter, scaled to the width of its box, with the report table where the layout puts it. */
export default function LetterPreview({
  source,
  plan,
  mapped = false,
  mapping,
  tags,
}: {
  source: Uint8Array | number; // the file's bytes, or a stored template's id
  plan: OutputPlan;
  mapped?: boolean;
  mapping?: DocMapping[]; // unsaved finished letter: its choices
  tags?: DocTags; // template preview: show {tags} as chips
}) {
  const { shown, error, note } = useLetterPreview(
    source,
    plan,
    mapped,
    mapping,
  );
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setWidth(Math.floor(el.clientWidth));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // fit the page to the box: page width is in points
  // 16px for the desk padding + a few px so the page never touches the edge
  const zoom = shown
    ? Math.min(1, Math.max(0.2, (width - 24) / (shown.page.width * PX_PER_PT)))
    : 1;

  return (
    <div className="lp">
      <div className="lp-bar">
        <span className="muted">{note}</span>
      </div>
      {tags && (
        <div className="lp-bar">
          <span className="muted">{WORDS.preview.tagsLegend}</span>
        </div>
      )}
      <div className="lp-box" ref={box}>
        {error ? (
          <div className="notice">{error}</div>
        ) : shown && width > 0 ? (
          <DocPreview model={shown} zoom={zoom} tags={tags} />
        ) : (
          <p className="muted">Reading the file…</p>
        )}
      </div>
    </div>
  );
}
