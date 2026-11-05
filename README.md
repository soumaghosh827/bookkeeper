# BookKeeper

Offline Electron + React desktop app: bulk transaction entry, Excel export, Word letters/bills.
Encrypted SQLite (SQLCipher) with a two-key scheme (password + recovery key).

## Run
```
npm install        # postinstall rebuilds the native SQLite module for Electron
npm run dev
npm run typecheck
npm run dist:win   # Windows installer
```

## The 3-step workflow
1. **Master** (tab name is editable: double-click the tab). Unique accounts: beneficiary, account no, bank, branch, IFSC, remarks (+ custom columns).
   Fill it by Excel import or paste. Duplicates are flagged (same account no = strong warning, same name + IFSC = soft).
   Every cell is editable by double-click / F2, with no time lock. This is the ONLY place these fields can be edited.
2. **Entry**. Left: vertical form. Each box searches only its own master column; picking a row fills and locks the five account fields.
   Right: the report list (S.No, Beneficiary, Amount). Saving a transaction writes it to the DB and adds it to the list.
   Rows can be removed (Undo toast), existing transactions can be added, then pick a template and Generate.
   Typed accounts not in master get a "Save this account to master" checkbox (ticked by default; unticked = one-off account).
3. **Transactions**. Filterable and sortable on every column (`>5000`, `100..500`, `>=01/04/2026`). Editable: reference no, date, amount,
   UTR, notes and custom columns. Deletable only within 48 hours. Select rows -> "Add to report list". Export the filtered rows to Excel.

Payee, bank, branch, account no and IFSC are NOT stored on transactions. They are read live from master, so a master edit
fixes every transaction.

## Reports (Word)
Templates tab: upload a .docx designed in Word with `{placeholders}`. Placeholder list is shown in the app. Flow: Generate -> summary +
"Save report to database" checkbox (ticked) -> Save As. Cancelling the dialog writes nothing. Saved reports are linked to their
transactions, so the Entry list and the Transactions table show which transactions already have a report.

## Layout
- `src/main`      backend. `db/migrations.ts` (single v1 schema), `services/*` (accounts, transactions, masterImport, reports, templates...), `ipc.ts`
- `src/preload`   locked-down bridge (`window.api`)
- `src/shared`    field keys, API contract (`types.ts`), business rules (`rules.ts`), formatting (`format.ts`)
- `src/renderer`  React UI. `styles/` = design tokens + CSS (see STYLE_GUIDE.md)

## Dev-phase database rule
`migrations.ts` holds ONE schema. Any schema change: edit it, then delete `bookkeeper.db*` and `keystore.json` from
`%APPDATA%\BookKeeper` (dev may use `%APPDATA%\bookkeeper`) and restart. Before the first real release, freeze it as version 1
and switch to append-only migrations.

## Known limits / next
- Excel account numbers are read as displayed text. Format the column as Text in Excel to keep leading zeros on long numbers.
- Amount edits in the report list with a "pending amount edits" log: planned, not built.
- Recovery key "skipped" flow, auto-lock on idle, restore-from-backup, installer polish: not built.
- This code was written without running it. Run `npm run typecheck` and `npm run dev` first; send me any error text.
