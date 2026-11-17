import { IMPORT_CASES, caseLabel, type CaseCode } from "@shared/importCases";

/** Small code badge, e.g. [A03]. Users can quote it. */
export default function CaseTag({ code }: { code: CaseCode }) {
  return (
    <span className="case-tag" title={IMPORT_CASES[code].fix}>
      {caseLabel(code)}
    </span>
  );
}
