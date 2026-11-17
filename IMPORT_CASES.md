# Import cases

Generated from `src/shared/importCases.ts` by `npm run docs:cases`. Do not edit by hand.

## Rows rejected

| Code | Where | Type | What the user sees | What to do | Default |
| --- | --- | --- | --- | --- | --- |
| ROW-01 | Master only | Row rejected | Missing beneficiary | Fill the beneficiary name and import again |  |
| ROW-02 | Transactions only | Row rejected | Missing beneficiary for a new account | Add the name, or save the account in master first |  |
| ROW-03 | Master and transactions | Row rejected | Account number required | Fill the account number |  |
| ROW-04 | Master and transactions | Row rejected | Invalid IFSC | Correct the 11-character IFSC |  |
| ROW-05 | Master and transactions | Row rejected | Account number shown as 1.2E+15 style: Excel already lost its digits | Format the column as Text, retype the number and save again |  |
| ROW-06 | Transactions only | Row rejected | Amount missing, invalid, too large or over 2 decimals | Correct the amount |  |
| ROW-07 | Transactions only | Row rejected | Missing or unreadable date | Correct the date |  |

## Accounts needing a decision

| Code | Where | Type | What the user sees | What to do | Default |
| --- | --- | --- | --- | --- | --- |
| ACC-01 | Master and transactions | Needs a decision | Differs from master | Choose keep or update per field | keep master |
| ACC-02 | Master and transactions | Needs a decision | Rows of one account disagree | Pick the correct value per field |  |
| ACC-03 | Master and transactions | Needs a decision | Looks like an existing or earlier account | Skip it, or add it as new | master: skip, tx: add as new |
| ACC-04 | Master only | Information | Saved earlier as a one-off; added to master | None |  |
| ACC-05 | Master and transactions | Needs a decision | Long account number (16+ digits), not verified | Check it against the source, then choose Use as shown or Skip | skip |

## Transaction cases

| Code | Where | Type | What the user sees | What to do | Default |
| --- | --- | --- | --- | --- | --- |
| TXN-01 | Transactions only | Information | Same reference already saved | None, nothing added |  |
| TXN-02 | Transactions only | Needs a decision | Reference can link to a saved transaction | Link or add as new |  |
| TXN-03 | Transactions only | Needs a decision | Blank reference matches a saved transaction | Treat as the same or add as new |  |
| TXN-04 | Transactions only | Information | Both have references, none shared: genuine twin | None, added |  |
| TXN-05 | Transactions only | Needs a decision | Duplicate inside the file | Keep or drop the later row |  |
| TXN-06 | Transactions only | Needs a decision | Amount is zero | Confirm or skip |  |
| TXN-07 | Transactions only | Needs a decision | High value | Confirm the amount |  |

## Whole file

| Code | Where | Type | What the user sees | What to do | Default |
| --- | --- | --- | --- | --- | --- |
| FILE-01 | Master and transactions | Information | This file was already imported | Import again only if intended |  |
