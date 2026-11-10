import type { SheetChoice } from "@shared/types";

/** Sheet dropdown for Excel imports. Shown only when the file has more than one sheet. */
export default function SheetPicker({
  sheets,
  value,
  disabled,
  onChange,
}: {
  sheets: SheetChoice[] | undefined;
  value: string | undefined;
  disabled?: boolean;
  onChange: (name: string) => void;
}) {
  if (!sheets || sheets.length < 2) return null;
  return (
    <p style={{ margin: "0 0 10px" }}>
      <label>
        Sheet{" "}
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {sheets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
              {s.hidden ? " (hidden)" : ""}
              {s.recommended ? " · Most compatible headers" : ""}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}
