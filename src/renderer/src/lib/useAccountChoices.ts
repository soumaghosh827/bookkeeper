import { useCallback, useState } from "react";
import type { AccField } from "@shared/types";

export type FieldChoices = Record<string, Partial<Record<AccField, string>>>;

/**
 * Per-account import choices shared by both import screens:
 * - dec: key -> decision (keep / update / add / skip / import ...)
 * - fc:  key -> field -> explicitly chosen value
 * Untouched entries are not stored, so they keep following the bulk rule.
 */
export function useAccountChoices<D extends string = string>() {
  const [dec, setDec] = useState<Record<string, D>>({});
  const [fc, setFc] = useState<FieldChoices>({});

  const setDecision = useCallback(
    (key: string, v: string) =>
      setDec((s) => {
        const n = { ...s };
        if (v) n[key] = v as D;
        else delete n[key];
        return n;
      }),
    [],
  );

  const setChoice = useCallback(
    (key: string, field: AccField, value: string) =>
      setFc((s) => {
        const acc = { ...(s[key] ?? {}) };
        if (value) acc[field] = value;
        else delete acc[field];
        const next = { ...s };
        if (Object.keys(acc).length) next[key] = acc;
        else delete next[key];
        return next;
      }),
    [],
  );

  const reset = useCallback(() => {
    setDec({});
    setFc({});
  }, []);

  return { dec, fc, setDecision, setChoice, reset };
}
