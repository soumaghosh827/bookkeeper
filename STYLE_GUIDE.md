# Style guide: carrying the look forward

All visual decisions live in `src/renderer/src/styles/`:

| File | Purpose | Edit when |
|---|---|---|
| `tokens.css` | Colours, type scale, spacing, radius, shadows, row height, dark theme, compact density | re-skinning, adding a theme |
| `base.css` | Element defaults: inputs, buttons (`primary` `danger` `ghost` `small` `icon`), links, scrollbar | changing control look globally |
| `layout.css` | App shell, nav, toolbar, `.card`, `.panel`, `.field`, `.row`, modal, toast, popover, `.notice` | changing structure/containers |
| `grid.css` | Data grid + suggestion panel | changing tables |
| `screens.css` | Per-screen layout (entry, import, templates, settings) | adding a screen |
| `index.css` | Import order | adding a file |

## Rules
1. **No hard-coded colours or sizes in components.** Use `var(--token)`. If a value is missing, add a token first.
2. Themes only override tokens: copy the `[data-theme="dark"]` block, rename it, add `{ id, label }` to `lib/theme.ts` (`THEMES`).
   Settings -> Appearance lists it automatically. Density works the same way (`[data-density]`, `DENSITIES`).
3. Re-brand = change `--brand*` and `--ink*` in `tokens.css` (nothing else).
4. Reuse before inventing. Building blocks:
   - Page = `<section class="screen">` containing `.toolbar` then content.
   - Form = `.field` (label above input), `.row` (side by side), `.fgrid` (2-column grid).
   - Container = `.panel` (header / `.body` / footer) or `.card`.
   - Message = `.notice` (+ `.ok`, `.bad`), toast via `useToast()`.
   - Modal = `<Modal>` component; confirmations = `AskDialog`, `ConfirmDialog`.
   - Table = `DataGrid` (server-side sort/filter/edit) or `.pv` (small static table).
5. Numbers: use `.num` or `font-variant-numeric: tabular-nums` so columns align.
6. Row height: JS reads `--row-h` (`lib/theme.ts: rowHeight()`). Never set row heights in px elsewhere.
7. Focus: never remove outlines; `--focus` and `--ring` define the focus look.
8. Fonts are system fonts (offline, CSP `default-src 'self'`). To bundle a font, place it under `src/renderer/src/assets/`, add `@font-face` in `base.css`, and change `--font-ui`.

## Design intent
Ledger-green brand on a calm blue-grey surface, dark ink navigation, monospace for account numbers and IFSC, tabular figures for money.
Dense but readable: 34px rows (28px compact), 13.5px body text.
