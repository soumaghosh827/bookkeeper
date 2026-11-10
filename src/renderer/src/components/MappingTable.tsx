import { customKey, type ColumnMapping } from "@shared/types";

export interface FieldOption {
  key: string;
  label: string;
}

/** "Match columns" table: one row per column of the file, with a dropdown for the field it goes to. */
export default function MappingTable({
  headers,
  mapping,
  onChange,
  fields,
  custom = [],
  allowNew = false,
  heading = "Column in your file",
}: {
  headers: string[];
  mapping: ColumnMapping;
  onChange: (mapping: ColumnMapping) => void;
  fields: FieldOption[]; // built-in fields
  custom?: FieldOption[]; // existing custom columns
  allowNew?: boolean; // offer "New column “<header>”" (creates a custom column)
  heading?: string;
}) {
  // choosing a field for one column frees it from any other column
  const setCol = (i: number, v: string) =>
    onChange(
      mapping.map((x, j) => (j === i ? v || null : v && x === v ? null : x)),
    );

  return (
    <table className="maptable">
      <thead>
        <tr>
          <th>{heading}</th>
          <th>Goes to</th>
        </tr>
      </thead>
      <tbody>
        {headers.map((h, i) => {
          const newKey = allowNew ? customKey(h) : "";
          const exists = custom.some((c) => c.key === newKey);
          return (
            <tr key={i}>
              <td>
                <strong>{h}</strong>
              </td>
              <td>
                <select
                  value={mapping[i] ?? ""}
                  onChange={(e) => setCol(i, e.target.value)}
                >
                  <option value="">Skip this column</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                  {custom.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label} (custom)
                    </option>
                  ))}
                  {allowNew && !exists && (
                    <option value={newKey}>New column “{h}”</option>
                  )}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
