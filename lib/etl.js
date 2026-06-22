// Pure helpers for parsing the RealPage export, validating it against the
// Monday mapping, and generating the Yardi ETL CSV. No React / framework deps.

import * as XLSX from "xlsx";
import Papa from "papaparse";

// Raw RealPage export layout (no header rows; data starts on row 1):
//   Col A (index 0) = RealPage property code
//   Col B (index 1) = GL account code
//   Cols C-N (index 2-13) = 12 monthly budget values
const RP_COL = 0;
const GL_COL = 1;
const MONTH_COL_START = 2; // Column C
const MONTH_COL_COUNT = 12;

function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// Derive the 12 { month, year } periods from the fiscal start month and the
// budget (starting) year, rolling the year forward after December. The raw
// export has no year/month header rows, so periods are computed, not read.
// (Display only — the export uses the single budget year + positional months.)
export function deriveMonthYearMap(fiscalStart, budgetYear) {
  const map = [];
  let month = Number(fiscalStart) || 1;
  let year = Number(budgetYear);
  for (let i = 0; i < MONTH_COL_COUNT; i++) {
    map.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return map;
}

// Parse an uploaded .xlsx/.xls/.xlsm ArrayBuffer into structured property data.
export function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });

  const slice12 = (row) => {
    const out = [];
    for (let i = 0; i < MONTH_COL_COUNT; i++) {
      out.push(row[MONTH_COL_START + i]);
    }
    return out;
  };

  // Group data rows by RealPage property code (column A).
  const propMap = new Map();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rpId = row[RP_COL] != null ? String(row[RP_COL]).trim() : "";
    const gl = row[GL_COL] != null ? String(row[GL_COL]).trim() : "";
    if (!rpId || !gl) continue; // skip blanks / totals without a GL

    const values = slice12(row).map(toNum);
    const zeroCount = values.filter((v) => v === 0).length;
    const isZeroRow = zeroCount === MONTH_COL_COUNT;

    const glFirst = gl.charAt(0);
    const isBalanceSheet = glFirst === "1" || glFirst === "2";
    const needsSignSwitch = glFirst === "1"; // only 1-accounts flip sign
    const hasPositive = values.some((v) => v > 0);
    // Balance-sheet accounts must be budgeted negative. Any positive value is
    // a budgeting error.
    const isBalanceError = isBalanceSheet && hasPositive;

    const entry = {
      rpId,
      gl,
      values,
      zeroCount,
      isZeroRow,
      glFirst,
      isBalanceSheet,
      needsSignSwitch,
      isBalanceError,
    };

    if (!propMap.has(rpId)) {
      propMap.set(rpId, { rpId, rows: [], balanceErrorGls: [] });
    }
    const prop = propMap.get(rpId);
    prop.rows.push(entry);
    if (isBalanceError) prop.balanceErrorGls.push(gl);
  }

  const properties = Array.from(propMap.values()).map((p) => ({
    ...p,
    hasBalanceError: p.balanceErrorGls.length > 0,
  }));

  return { properties };
}

// Run all validation checks. mapping is [{ rpId, yardiId, name }].
export function validate(parsed, mapping) {
  const mapByRp = new Map();
  for (const m of mapping) {
    mapByRp.set(String(m.rpId).trim(), { yardiId: m.yardiId, name: m.name });
  }

  const unmappedRp = [];
  const unmappedYardi = [];
  const balanceErrors = []; // { rpId, name, gls }
  let totalRows = 0;
  let excludedRows = 0;
  let exportablePropertyCount = 0;

  for (const prop of parsed.properties) {
    const entry = mapByRp.get(prop.rpId);

    if (!entry) {
      if (!unmappedRp.includes(prop.rpId)) unmappedRp.push(prop.rpId);
    } else if (!entry.yardiId || String(entry.yardiId).trim() === "") {
      if (!unmappedYardi.includes(prop.rpId)) unmappedYardi.push(prop.rpId);
    }

    totalRows += prop.rows.length;

    if (prop.hasBalanceError) {
      // Whole property is excluded when any 1/2 GL is budgeted positive.
      excludedRows += prop.rows.length;
      balanceErrors.push({
        rpId: prop.rpId,
        name: entry?.name || "",
        yardiId: entry?.yardiId || "",
        gls: prop.balanceErrorGls,
      });
    } else {
      excludedRows += prop.rows.filter((row) => row.isZeroRow).length;
      // Counts toward the export if it has at least one non-zero row.
      if (prop.rows.some((row) => !row.isZeroRow)) exportablePropertyCount += 1;
    }
  }

  const checks = {
    unmappedRp,
    unmappedYardi,
    balanceErrors,
    totalProperties: parsed.properties.length,
    totalRows,
    excludedRows,
    excludedProperties: balanceErrors.length,
    exportableRows: totalRows - excludedRows,
    exportablePropertyCount,
    fileCount: Math.max(
      1,
      Math.ceil(exportablePropertyCount / PROPERTIES_PER_FILE)
    ),
  };

  // Only unmapped properties block the export (no valid Yardi code to write).
  // Balance-sheet errors don't block — those properties are simply excluded
  // and flagged so they can be sent back to the property for correction.
  checks.hasBlockingErrors =
    unmappedRp.length > 0 || unmappedYardi.length > 0;

  return checks;
}

export const ETL_HEADER = [
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

// Default max properties per exported CSV file (Yardi import batch size).
export const PROPERTIES_PER_FILE = 10;

// Properties that will actually appear in the export: not flagged for a
// balance-sheet error, and with at least one non-zero (kept) row.
export function exportableProperties(parsed) {
  return parsed.properties
    .filter((p) => !p.hasBalanceError)
    .map((p) => ({ ...p, exportRows: p.rows.filter((r) => !r.isZeroRow) }))
    .filter((p) => p.exportRows.length > 0);
}

function dataRowsForChunk(chunk, mapByRp, config, periods) {
  const { bookNum } = config;
  const dataRows = [];
  let tranNum = 1; // TranNum restarts at 1 in each file (separate import).

  for (const prop of chunk) {
    const entry = mapByRp.get(prop.rpId);
    const yardiId = entry ? entry.yardiId : "";

    for (const row of prop.exportRows) {
      // GLs starting with 1 flip sign (negative -> positive); everything
      // else (incl. 2-accounts) passes through unchanged.
      const signed = row.needsSignSwitch
        ? row.values.map((v) => (v === 0 ? 0 : -v))
        : row.values;

      // Place each fiscal-ordered value into its calendar month slot
      // (MtdBudget1-12), grouped by the calendar year it falls in. A fiscal
      // year that crosses December therefore produces one row per year.
      const byYear = new Map(); // year -> 12-slot array
      for (let i = 0; i < periods.length; i++) {
        const { month, year } = periods[i];
        if (!byYear.has(year)) byYear.set(year, new Array(12).fill(0));
        byYear.get(year)[month - 1] = signed[i];
      }

      const years = Array.from(byYear.keys()).sort((a, b) => a - b);
      for (const year of years) {
        const monthly = byYear.get(year);
        if (monthly.every((v) => v === 0)) continue; // drop all-zero year rows
        dataRows.push([tranNum, bookNum, year, yardiId, row.gl, ...monthly]);
        tranNum += 1;
      }
    }
  }
  return dataRows;
}

// Build the export file data (no CSV stringify), splitting into batches of at
// most `propertiesPerFile` properties. Returns [{ propertyCount, dataRows }].
export function buildExportFiles(
  parsed,
  mapping,
  config,
  propertiesPerFile = PROPERTIES_PER_FILE
) {
  const mapByRp = new Map();
  for (const m of mapping) {
    mapByRp.set(String(m.rpId).trim(), { yardiId: m.yardiId, name: m.name });
  }

  const periods = deriveMonthYearMap(config.fiscalStart, config.budgetYear);
  const props = exportableProperties(parsed);
  const size = propertiesPerFile > 0 ? propertiesPerFile : props.length || 1;

  const chunks = [];
  for (let i = 0; i < props.length; i += size) {
    chunks.push(props.slice(i, i + size));
  }
  if (chunks.length === 0) chunks.push([]); // always produce at least one file

  return chunks.map((chunk) => {
    const dataRows = dataRowsForChunk(chunk, mapByRp, config, periods);
    return { propertyCount: chunk.length, dataRows };
  });
}

function fileToCsv(dataRows) {
  const aoa = [["FinBudgets"], ETL_HEADER, ...dataRows];
  return Papa.unparse(aoa, { newline: "\r\n" });
}

// Generate one or more Yardi ETL CSV strings. Returns [{ csv, propertyCount, rowCount }].
export function generateCsvFiles(
  parsed,
  mapping,
  config,
  propertiesPerFile = PROPERTIES_PER_FILE
) {
  return buildExportFiles(parsed, mapping, config, propertiesPerFile).map(
    (f) => ({
      csv: fileToCsv(f.dataRows),
      propertyCount: f.propertyCount,
      rowCount: f.dataRows.length,
    })
  );
}

// Single-file convenience (no splitting).
export function generateCsv(parsed, mapping, config) {
  return generateCsvFiles(parsed, mapping, config, Infinity)[0].csv;
}
