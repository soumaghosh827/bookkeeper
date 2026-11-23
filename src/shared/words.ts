// All user-facing wording for layouts, notes, badges, previews and placeholder help.
// Edit the text here only. Keep the keys and the {braces} as they are.

export const WORDS = {
  // Templates screen: messages shown while filling a template
  steps: {
    nameTaken:
      "A template with this name already exists. Use a different name.",
    otherMethod: "Use a different method",
    oneTable:
      "Only one table can be replaced. Your earlier table choice was set back to No change.",
  },
  // Layout selector in the Templates tab
  layout: {
    one_page: {
      label: "Table where I put {@table}",
      hint: "One Word file. The table goes where you put {@table} in the letter, or at the end if there is none.",
    },
    two_page: {
      label: "Table on a new page",
      hint: "One Word file. The letter comes first, then the table starts on a new page.",
    },
    letter_excel: {
      label: "Word letter + separate Excel table",
      hint: "Two files: the letter without a table, and the table as an Excel file.",
    },
    // finished letter: its table position is fixed
    mapped: {
      label: {
        one_page: "Letter only",
        two_page: "Letter only",
        letter_excel: "Letter + separate Excel table",
      },
      hint: "Table position: as in your finished letter",
    },
    // shown on a new prepared template before a layout is picked
    choose: "Choose a layout…",
    chooseHint: "Choose where the table goes. Required before saving.",
  },

  // Note under each output in the plan preview
  note: {
    word: {
      inline:
        "Table where I put {@table} (at the end of the letter if the Word file has none)",
      new_page: "Table on its own new page",
      none: "Letter only, no table",
    },
    mappedWord: {
      inline: "Table stays where it is in your finished letter",
      new_page: "Table stays where it is in your finished letter",
      none: "Letter without a table",
    },
    excel: "Table only. Row 1 blank, optional title in row 2, then the table",
  },

  // Short text in the Templates toolbar
  badge: {
    excel: "Excel",
    inline: "Table where I put {@table}",
    new_page: "Table on new page",
    none: "Letter only",
    mappedWithTable: "Letter only",
    mappedNoTable: "Letter",
    empty: "No output",
  },

  // Note in the Word preview dialog
  preview: {
    inline:
      "Sample table shown where {@table} is in the letter (at the end if there is none).",
    mappedInline:
      "Sample table shown where the table is in your finished letter.",
    mappedNoMarker:
      "You did not choose a table in your letter, so the table is added at the end.",
    new_page: "Sample table shown on a new page after the letter.",
    noTableExcel:
      "The letter has no table. The table goes to a separate Excel file.",
    noTable: "The letter has no table.",
    openLarger: "Open larger",
  },

  // "Placeholders you can use in the Word file" help list: [what to type, what it does]
  placeholders: [
    [
      "{total} {total_words} {count} {today} {ref_no}",
      "Totals worked out by the app, plus the report’s Date ({today}) and Reference no ({ref_no}) as entered in the list panel. {today} is the report date, which is today unless you change it. The app adds “Rs.” before {total} and “Rupees” before {total_words} itself, so don’t type them",
    ],
    [
      "{payee} {bank} {branch} {account_no} {ifsc} {amount} {amount_words} {date} {reference_no} {utr} {notes}",
      "Details of the FIRST transaction in the list (useful for a letter about one payment). The app adds “Rs.” before {amount} and “Rupees” before {amount_words} itself, so don’t type them",
    ],
    [
      "{@table}",
      "The table built by the app. Put it alone in its own paragraph where the table should go (after the signatory for the two-page layout). Without it the table goes at the end of the letter",
    ],
    [
      "Your own texts, e.g. {signatory_name}",
      "Add them below as key + value; edit them here whenever they change",
    ],
  ] as [string, string][],
};
