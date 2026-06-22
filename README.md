# Yardi ETL Import Tool

A Next.js (App Router) app that converts a **RealPage** raw budget export (`.xlsx`/`.xls`)
into a **Yardi-ready ETL CSV**, using a **Monday.com** board as the property-mapping source.
Deploys to **Vercel** with a serverless proxy that hides the Monday API key and avoids CORS.

## How it works

1. **Pick the budget year** (2026 / 2027). The app fetches the matching Monday board
   (`"<year> Budget Status"`) via `/api/monday` and reads each item's **Budgeting ID**
   (RealPage code) and **PMS** (Yardi code) columns into a mapping.
2. **Upload the RealPage export.** Parsed client-side with SheetJS:
   - Row 1 = fiscal-year per month column (may roll over to the next calendar year mid-row)
   - Row 2 = month numbers (may not start at 1)
   - Row 3+ = data: col B = RealPage code, col C = GL account, cols D–O = 12 monthly values
3. **Validation** runs automatically:
   - Unmapped RealPage properties (not in Monday)
   - Mapped properties with a blank Yardi (PMS) ID
   - Balance-sheet GL accounts (code starts with `1` or `2`) carrying non-zero values
   - All-zero rows (excluded from export; count shown)
4. **Resolve unmapped properties** inline — enter a Yardi ID and **Save to Monday**
   (creates/updates the board item by matching on Budgeting ID). Validation re-runs.
5. **Export ETL CSV** once there are no blocking errors. Revenue accounts
   (GL `< 20000000`) are sign-inverted; all-zero rows are dropped.

### Export format

| | |
|---|---|
| Row 1 | `FinBudgets` in column A |
| Row 2 | `TranNum, BookNum, Year, Property, Account, MtdBudget1…MtdBudget12` |
| Data | one row per GL account per property (Yardi code, raw numeric values) |

## Local development

```bash
npm install
cp .env.example .env.local   # then set MONDAY_API_KEY
npm run dev
```

Open http://localhost:3000.

## Environment variables

| Name | Description |
|------|-------------|
| `MONDAY_API_KEY` | Monday.com API token (Monday > Admin/Developers > API). |

## Deploy to Vercel

1. Push this folder to a Git repo and import it into Vercel (framework auto-detected as Next.js).
2. In **Project Settings → Environment Variables**, add `MONDAY_API_KEY`.
3. Deploy. The Monday board ID is always looked up by name at request time — nothing is hardcoded.
