# Yardi ETL Import Tool

A Next.js (App Router) app that converts a **RealPage** raw budget export (`.xlsx`/`.xls`)
into a **Yardi-ready ETL CSV**, using a **Monday.com** board as the property-mapping source.
Deploys to **Vercel** with a serverless proxy that hides the Monday API key and avoids CORS.

## How it works

1. **Pick the budget year** (2026 / 2027). The app fetches the matching Monday board
   (`"<year> Budget Status"`) via `/api/monday` and reads each item's **Budgeting ID**
   (RealPage code) and **PMS ID** (Yardi code) columns into a mapping.
2. **Upload the RealPage export** (`.xlsx` / `.xls` / `.xlsm`). Parsed client-side
   with SheetJS. No header rows — data starts on row 1:
   - Col A = RealPage property code
   - Col B = GL account code
   - Cols C–N = 12 monthly budget values
3. **Validation** runs automatically:
   - Unmapped RealPage properties (not in Monday) — **blocks export**
   - Mapped properties with a blank Yardi (PMS ID) — **blocks export**
   - Balance-sheet GLs (code starts with `1` or `2`) must be budgeted **negative**.
     If any such GL is budgeted **positive**, the **entire property** is flagged
     (with its Monday property name) and excluded from the export.
   - All-zero rows (excluded from export; count shown)
4. **Resolve unmapped properties** inline — enter a Yardi ID and **Save to Monday**
   (creates/updates the board item by matching on Budgeting ID). Validation re-runs.
5. **Export ETL CSV.** Sign handling on export:
   - GL starts with **1** → sign switched (negative → positive)
   - GL starts with **2** → kept as-is (stays negative)
   - all other GLs → kept as-is

   **Month alignment & year split:** the 12 fiscal-ordered values are placed into
   their calendar-month columns based on the Fiscal Start Month (e.g. start = 4 →
   first value lands in `MtdBudget4`). When a fiscal year crosses December, each GL
   becomes two rows: one with `Year` = the start year (Apr–Dec data, Jan–Mar = 0)
   and one with `Year` = the next year (Jan–Mar data, Apr–Dec = 0). All-zero rows
   and flagged properties are dropped.
   If more than 10 exportable properties are present, the export is split into
   multiple CSV files of ≤10 properties each (`...-part1of3.csv`, etc.), with
   `TranNum` restarting at 1 in each file.

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
