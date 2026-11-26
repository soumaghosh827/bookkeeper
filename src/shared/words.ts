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
      label: "Letter with table",
      hint: "One Word file. The table goes where you put it in the letter. If you did not, it goes at the end.",
    },
    two_page: {
      label: "Letter + table on a new page",
      hint: "One Word file. The letter comes first. The table follows on a new page, even if you typed it in the middle of the letter.",
    },
    letter_excel: {
      label: "Letter + Excel table",
      hint: "Two files: the Word letter without a table, and the table in an Excel file.",
    },
    // finished letter: same four names as everywhere else
    mapped: {
      label: {
        one_page: "Letter with table",
        two_page: "Letter + table on a new page",
        letter_excel: "Letter + Excel table",
      },
      hint: {
        one_page:
          "One Word file. The table goes where your finished letter has it.",
        two_page:
          "One Word file. The table moves to the end of your letter, on a new page.",
        letter_excel:
          "Two files: the Word letter without a table, and the table in an Excel file.",
      },
    },
    // shown on a new prepared template before a layout is picked
    choose: "Choose a layout…",
    chooseHint: "Choose where the table goes. Required before saving.",
  },

  // Note under each output in the plan preview
  note: {
    word: {
      inline:
        "Table goes where you put it in the letter (at the end if you did not)",
      new_page: "Table goes after the letter, on a new page",
      none: "Letter only, no table",
    },
    mappedWord: {
      inline: "Table stays where it is in your finished letter",
      new_page: "Table moves to the end of your letter, on a new page",
      none: "Letter without a table",
    },
    excel: "Table only. Row 1 blank, optional title in row 2, then the table",
  },

  // Entry screen: dropdown group headers and the "Makes:" hint (same for both flows)
  entry: {
    letterTable: "Letter with table",
    letterNewPage: "Letter + table on a new page",
    letterExcel: "Letter + Excel table",
    letterOnly: "Letter only",
    excelOnly: "Excel table only",
    none: "No output",
    makes: "Makes:",
    word: "Word letter",
    excel: "Excel file",
  },

  // Note in the Word preview dialog
  preview: {
    tagsLegend:
      "Indigo labels are replaced with the app's data. Amber labels are not known to the app, so check the spelling.",
    inline:
      "Sample table shown where you put it in the letter (at the end if you did not).",
    mappedInline:
      "Sample table shown where the table is in your finished letter.",
    mappedNoMarker:
      "You did not choose a table in your letter, so the table is added at the end.",
    mappedNewPage:
      "Sample table shown on a new page at the end of your finished letter.",
    new_page: "Sample table shown on a new page after the letter.",
    noTableExcel:
      "The letter has no table. The table goes to a separate Excel file.",
    noTable: "The letter has no table.",
    openLarger: "Open larger",
  },

  // "Placeholders you can use in the Word file" help list: [what to type, what it does]
  placeholders: [
    [
      "{total} {total_words} {count} {today} {ref_no} {cheque_no}",
      "Figures the app works out ({total}, {total_words}, {count}), and the report’s Date ({today}), Reference no ({ref_no}) and Cheque no ({cheque_no}) from the list panel. {today} is today unless you change the report date. The app adds “Rs.” before {total} and “Rupees” before {total_words}, so do not type them.",
    ],
    [
      "{payee} {bank} {branch} {account_no} {ifsc} {amount} {amount_words} {date} {reference_no} {utr} {notes}",
      "Details of the FIRST transaction in the list. Use these for a letter about one payment. The app adds “Rs.” before {amount} and “Rupees” before {amount_words}, so do not type them.",
    ],
    [
      "{@table}",
      "The table made by the app. Type it alone in its own paragraph where the table should go. If you do not type it, the table goes at the end of the letter. For “Letter + table on a new page”, the table moves to the end of the letter on a new page. Lines you typed below it stay in the letter.",
    ],
    [
      "Your own texts, e.g. {signatory_name}",
      "Add your own texts below, with a name and its words. You can change them here any time.",
    ],
  ] as [string, string][],

  // Errors in the user's Word file ({tags} that are broken). %1 and %2 are replaced with the tag names.
  errors: {
    unclosed_tag:
      'The tag "{%1" has no closing }. Add the } in your Word file.',
    unopened_tag:
      'There is a } after "%1" with no { before it. Add the { or delete the }.',
    rawAlone:
      'The tag "{@%1}" must be alone in its own paragraph, with no other words or spaces. Move it to its own line.',
    loopOpen:
      'The tag "{#%1}" starts a repeating section. This app does not use those. Delete it from your Word file.',
    loopClose:
      'The tag "{/%1}" ends a repeating section that never started. Delete it from your Word file.',
    loopMismatch:
      'The tags "{#%1}" and "{/%2}" do not match. This app does not use repeating sections. Delete them from your Word file.',
    other:
      "The Word file has a problem with its { } tags. Check that every { has a } and nothing else is inside them.",
  },
};
