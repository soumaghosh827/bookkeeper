import { useEffect, useMemo, useState } from "react";
import type { DocMapping, DocModel, OutputPlan } from "@shared/types";
import {
  hasTableMarker,
  withLayout,
  wordPlacement,
} from "@shared/layoutPreview";
import { WORDS } from "@shared/words";

/**
 * Loads a Word file for previewing and shows the report table where the plan puts it.
 * `source` = the file's bytes, or the id of a stored template. `mapping` = an unsaved finished letter's choices:
 * the letter is then shown with them applied, as the saved template will hold it.
 * It reloads only when `source` or `mapping` changes; a different plan just redraws the table.
 */
export function useLetterPreview(
  source: Uint8Array | number,
  plan?: OutputPlan,
  mapped = false,
  mapping?: DocMapping[],
) {
  const [model, setModel] = useState<DocModel | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    setModel(null);
    setError("");
    (mapping
      ? window.api.templates.inspectMapped(source, mapping)
      : window.api.templates.inspect(source)
    )
      .then((r) => {
        if (stale) return;
        if (r.ok && r.data) setModel(r.data);
        else setError(r.error ?? "Could not read this file");
      })
      .catch((e) => {
        if (!stale)
          setError((e as Error).message || "Could not read this file");
      });
    return () => {
      stale = true;
    };
  }, [source, mapping]);

  const placement = plan ? wordPlacement(plan) : null;
  const shown = useMemo(
    () =>
      model && plan && placement ? withLayout(model, plan, placement) : model,
    [model, plan, placement],
  );
  const note =
    !plan || !placement
      ? ""
      : placement === "inline"
        ? mapped
          ? model && !hasTableMarker(model)
            ? WORDS.preview.mappedNoMarker
            : WORDS.preview.mappedInline
          : WORDS.preview.inline
        : placement === "new_page"
          ? mapped
            ? WORDS.preview.mappedNewPage
            : WORDS.preview.new_page
          : plan.outputs.some((o) => o.kind === "xlsx")
            ? WORDS.preview.noTableExcel
            : WORDS.preview.noTable;

  return { shown, error, note };
}
