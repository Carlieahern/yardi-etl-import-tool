// Pure helpers for parsing the RealPage export, validating it against the
// Monday mapping, and generating the Yardi ETL CSV. No React / framework deps.

import * as XLSX from "xlsx";
import Papa from "papaparse";

export const REVENUE_THRESHOLD = 20000000; // GL codes below this get sign-inverted.
const MONTH_COL_START = 3; // Column D (zero-based index 3).
const MONTH_COL_COUNT = 12;

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// Zip row 1 (years) and row 2 (months) into 12 { month, year } objects.
// The year for each column comes from row 1 when present; when a year cell is
// blank (e.g. merged cells) we carry the previous year forward and roll it over
// to the next calendar year whenever the month sequence wraps past December.
export function buildMonthYearMap(yearCells, monthCells) {
  const baseYear =
    yearCells.map(toInt).find((v) => v != null) ?? new Date().getFullYear();

  const map = [];
  let lastYear = baseYear;
  let prevMonth = null;

  for (let i = 0; i < MONTH_COL_COUNT; i++) {
    const month = toInt(monthCells[i]);
    let year = toInt(yearCells[i]);

    if (year == null) {
      year = lastYear;
      if (prevMonth != null && month != null && month < prevMonth) {
        year = lastYear + 1;
      }
    }

    map.push({ month, year });
    if (year != null) lastYear = year;
    if (month != null) prevMonth = month;
  }

  return map;
}

// Parse an uploaded .xlsx/.xls ArrayBuffer into structured property data.
export function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });

  if (rows.length < 3) {
    throw new Error(
      "File does not have the expected layout (year row, month row, then data)."
    );
  }

  const slice12 = (row) => {
    const out = [];
    for (let i = 0; i < MONTH_COL_COUNT; i++) {
      out.push(row[MONTH_COL_START + i]);
    }
    return out;
  };

  const yearCells = slice12(rows[0]);
  const monthCells = slice12(rows[1]);
  const periods = buildMonthYearMap(yearCells, monthCells);

  // Group data rows (index 2+) by RealPage property code (column B / index 1).
  const propMap = new Map();
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    const rpId = row[1] != null ? String(row[1]).trim() : "";
    const gl = row[2] != null ? String(row[2]).trim() : "";
    if (!rpId && !gl) continue; // skip fully empty rows
    if (!rpId) continue; // a GL with no property can't be exported

    const values = slice12(row).map(toNum);
    const zeroCount = values.filter((v) => v === 0).length;
    const isZeroRow = zeroCount === MONTH_COL_COUNT;

    const entry = {
      rpId,
      gl,
      values,
      zeroCount,
      isZeroRow,
    };

    if (!propMap.has(rpId)) propMap.set(rpId, { rpId, rows: [] });
    propMap.get(rpId).rows.push(entry);
  }

  const properties = Array.from(propMap.values());
  return { periods, properties, yearCells, monthCells };
}

// Run all validation checks. mapping is [{ rpId, yardiId }].
export function validate(parsed, mapping) {
  const mapByRp = new Map();
  for (const m of mapping) mapByRp.set(String(m.rpId).trim(), m.yardiId);

  const unmappedRp = [];
  const balanceSheetErrors = [];
  let totalRows = 0;
  let excludedRows = 0;

  for (const prop of parsed.properties) {
    if (!mapByRp.has(prop.rpId)) {
      if (!unmappedRp.includes(prop.rpId)) unmappedRp.push(prop.rpId);
    }
    for (const row of prop.rows) {
      totalRows += 1;
      if (row.isZeroRow) excludedRows += 1;

      // Balance sheet GL (starts with 1 or 2) with any non-zero monthly value.
      const firstChar = row.gl.charAt(0);
      if ((firstChar === "1" || firstChar === "2") && !row.isZeroRow) {
        balanceSheetErrors.push({ rpId: prop.rpId, gl: row.gl });
      }
    }
  }

  // Yardi IDs that are blank in Monday for properties present in the file.
  const unmappedYardi = [];
  for (const prop of parsed.properties) {
    const yardiId = mapByRp.get(prop.rpId);
    if (mapByRp.has(prop.rpId) && (!yardiId || String(yardiId).trim() === "")) {
      if (!unmappedYardi.includes(prop.rpId)) unmappedYardi.push(prop.rpId);
    }
  }

  const checks = {
    unmappedRp,
    unmappedYardi,
    balanceSheetErrors,
    totalProperties: parsed.properties.length,
    totalRows,
    excludedRows,
  };

  // Blocking errors: unmapped RP props, blank Yardi IDs, balance-sheet values.
  checks.hasBlockingErrors =
    unmappedRp.length > 0 ||
    unmappedYardi.length > 0 ||
    balanceSheetErrors.length > 0;

  return checks;
}

// Build the ETL export rows (array of arrays) ready for CSV.
export function buildExportRows(parsed, mapping, config) {
  const { budgetYear, bookNum } = config;
  const mapByRp = new Map();
  for (const m of mapping) mapByRp.set(String(m.rpId).trim(), m.yardiId);

  const header = [
    "TranNum",
    "BookNum",
    "Year",
    "Property",
    "Account",
    "MtdBudget1",
    "MtdBudget2",
    "MtdBudget3",
    "MtdBudget4",
    "MtdBudget5",
    "MtdBudget6",
    "MtdBudget7",
    "MtdBudget8",
    "MtdBudget9",
    "MtdBudget10",
    "MtdBudget11",
    "MtdBudget12",
  ];

  const dataRows = [];
  let tranNum = 1;

  for (const prop of parsed.properties) {
    const yardiId = mapByRp.get(prop.rpId);
    for (const row of prop.rows) {
      if (row.isZeroRow) continue; // exclude all-zero rows

      const glNum = toInt(row.gl) ?? 0;
      const invert = glNum < REVENUE_THRESHOLD;
      const monthly = row.values.map((v) => (invert ? v * -1 : v));

      dataRows.push([
        tranNum,
        bookNum,
        budgetYear,
        yardiId,
        row.gl,
        ...monthly,
      ]);
      tranNum += 1;
    }
  }

  return { titleRow: ["FinBudgets"], header, dataRows };
}

export function generateCsv(parsed, mapping, config) {
  const { titleRow, header, dataRows } = buildExportRows(parsed, mapping, config);
  const aoa = [titleRow, header, ...dataRows];
  return Papa.unparse(aoa, { newline: "\r\n" });
}
