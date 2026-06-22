"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseWorkbook,
  validate,
  generateCsvFiles,
  deriveMonthYearMap,
  PROPERTIES_PER_FILE,
} from "@/lib/etl";

const CURRENT_YEAR = 2026;
// Set `available: false` for any year whose Monday board doesn't exist yet.
const YEARS = [
  { year: 2026, available: true },
  { year: 2027, available: false },
];
const BOOK_OPTIONS = [
  { value: 0, label: "Cash (0)" },
  { value: 1, label: "Accrual (1)" },
  { value: 1000, label: "Both (1000)" },
];

export default function Home() {
  // ---- Config / year selection ----
  const [selectedYear, setSelectedYear] = useState(CURRENT_YEAR);
  const [budgetYear, setBudgetYear] = useState(CURRENT_YEAR);
  const [bookNum, setBookNum] = useState(1);
  const [fiscalStart, setFiscalStart] = useState(1);

  // ---- Monday mapping ----
  const [mapping, setMapping] = useState([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingError, setMappingError] = useState("");

  // ---- File / parsed data ----
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  // ---- Unmapped resolution ----
  const [yardiInputs, setYardiInputs] = useState({}); // rpId -> value
  const [savingRp, setSavingRp] = useState({}); // rpId -> bool
  const [saveStatus, setSaveStatus] = useState({}); // rpId -> {ok, msg}

  const boardName = `${selectedYear} Budget Status`;

  // Fetch the Monday mapping for the selected year's board.
  const fetchMapping = useCallback(async (year) => {
    setMappingLoading(true);
    setMappingError("");
    try {
      const res = await fetch("/api/monday", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch",
          boardName: `${year} Budget Status`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load mapping.");
      setMapping(data.mapping || []);
    } catch (err) {
      setMapping([]);
      setMappingError(err.message);
    } finally {
      setMappingLoading(false);
    }
  }, []);

  // Initial load + whenever the year toggle changes.
  useEffect(() => {
    fetchMapping(selectedYear);
    setBudgetYear(selectedYear);
  }, [selectedYear, fetchMapping]);

  // Re-run validation any time parsed data or mapping changes.
  const checks = useMemo(() => {
    if (!parsed) return null;
    return validate(parsed, mapping);
  }, [parsed, mapping]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setParseError("");
    setFileName(file.name);
    setSaveStatus({});
    try {
      const buf = await file.arrayBuffer();
      const result = parseWorkbook(buf);
      setParsed(result);
      // Seed Yardi inputs for any unmapped RP codes.
      setYardiInputs({});
    } catch (err) {
      setParsed(null);
      setParseError(err.message || "Could not parse the file.");
    }
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      handleFile(file);
    },
    [handleFile]
  );

  const saveToMonday = useCallback(
    async (rpId) => {
      const yardiId = (yardiInputs[rpId] || "").trim();
      if (!yardiId) {
        setSaveStatus((s) => ({
          ...s,
          [rpId]: { ok: false, msg: "Enter a Yardi ID first." },
        }));
        return;
      }
      setSavingRp((s) => ({ ...s, [rpId]: true }));
      setSaveStatus((s) => ({ ...s, [rpId]: null }));
      try {
        const res = await fetch("/api/monday", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update",
            boardName,
            rpId,
            yardiId,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Save failed.");
        // Update local mapping so validation re-runs and removes the row.
        setMapping((prev) => {
          const existing = prev.find((m) => m.rpId === rpId);
          const next = prev.filter((m) => m.rpId !== rpId);
          next.push({ rpId, yardiId, name: existing?.name || rpId });
          return next;
        });
        setSaveStatus((s) => ({
          ...s,
          [rpId]: { ok: true, msg: data.created ? "Created in Monday" : "Saved" },
        }));
      } catch (err) {
        setSaveStatus((s) => ({
          ...s,
          [rpId]: { ok: false, msg: err.message },
        }));
      } finally {
        setSavingRp((s) => ({ ...s, [rpId]: false }));
      }
    },
    [yardiInputs, boardName]
  );

  const downloadCsv = useCallback((csv, name) => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const onExport = useCallback(() => {
    if (!parsed) return;
    const files = generateCsvFiles(parsed, mapping, {
      budgetYear: Number(budgetYear),
      bookNum: Number(bookNum),
      fiscalStart: Number(fiscalStart),
    });

    if (files.length === 1) {
      downloadCsv(files[0].csv, `yardi-etl-${budgetYear}.csv`);
      return;
    }

    // >10 properties: download a batch of files, staggered so the browser
    // doesn't drop the rapid-fire downloads.
    files.forEach((file, i) => {
      const name = `yardi-etl-${budgetYear}-part${i + 1}of${files.length}.csv`;
      setTimeout(() => downloadCsv(file.csv, name), i * 400);
    });
  }, [parsed, mapping, budgetYear, bookNum, fiscalStart, downloadCsv]);

  const canExport =
    parsed && checks && !checks.hasBlockingErrors && !mappingLoading;

  return (
    <div className="wrap">
      {/* Header */}
      <div className="app-header">
        <div>
          <h1>Yardi ETL Import Tool</h1>
          <div className="subtitle">
            Convert a RealPage budget export into a Yardi-ready ETL CSV.
          </div>
        </div>
        <div className="year-toggle">
          {YEARS.map(({ year, available }) => (
            <button
              key={year}
              className={selectedYear === year ? "active" : ""}
              disabled={!available}
              title={available ? undefined : `${year} Budget Status board not ready yet`}
              onClick={() => available && setSelectedYear(year)}
            >
              {year}
              {!available ? " (soon)" : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Mapping status banner */}
      {mappingLoading && (
        <div className="banner info">
          <span className="spinner" style={{ borderTopColor: "#1f55c4" }} />{" "}
          Loading property mapping from “{boardName}”…
        </div>
      )}
      {mappingError && !mappingLoading && (
        <div className="banner error">
          Could not load Monday mapping: {mappingError}{" "}
          <button
            className="btn secondary"
            style={{ marginLeft: 8, padding: "4px 10px" }}
            onClick={() => fetchMapping(selectedYear)}
          >
            Retry
          </button>
        </div>
      )}
      {!mappingLoading && !mappingError && (
        <div className="banner info">
          Loaded {mapping.length} property mappings from “{boardName}”.
        </div>
      )}

      {/* Config bar */}
      <div className="panel">
        <h2>Configuration</h2>
        <div className="config-grid">
          <div className="field">
            <label>Budget Year</label>
            <input
              type="number"
              value={budgetYear}
              onChange={(e) => setBudgetYear(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Budget Book</label>
            <select
              value={bookNum}
              onChange={(e) => setBookNum(e.target.value)}
            >
              {BOOK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Fiscal Year Start Month</label>
            <input
              type="number"
              min={1}
              max={12}
              value={fiscalStart}
              onChange={(e) => setFiscalStart(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* File upload */}
      <div className="panel">
        <h2>Upload RealPage Export</h2>
        <div
          className={`dropzone ${dragging ? "drag" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div>
            <strong>Drag &amp; drop</strong> an .xlsx / .xls file here, or click to
            browse.
          </div>
          <div className="hint">
            Col A = RealPage code, Col B = GL account, Cols C–N = 12 monthly
            values (no header rows).
          </div>
          {fileName && <div className="filename">{fileName}</div>}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.xlsm"
            style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
        {parseError && (
          <div className="banner error" style={{ marginTop: 14 }}>
            {parseError}
          </div>
        )}
        {parsed && (
          <div className="export-note" style={{ marginTop: 12 }}>
            Periods (from fiscal start {fiscalStart}, year {budgetYear}):{" "}
            {deriveMonthYearMap(fiscalStart, budgetYear)
              .map((p) => `${p.month}/${p.year}`)
              .join(" · ")}
          </div>
        )}
      </div>

      {/* Validation panel */}
      {checks && (
        <div className="panel">
          <h2>Validation</h2>

          <CheckRow
            status={checks.unmappedRp.length === 0 ? "pass" : "error"}
            title="RealPage properties mapped in Monday"
            detail={
              checks.unmappedRp.length === 0
                ? "All RP property codes in the file have a Monday mapping."
                : `${checks.unmappedRp.length} unmapped RP code(s) — resolve below.`
            }
            list={checks.unmappedRp}
          />

          <CheckRow
            status={checks.unmappedYardi.length === 0 ? "pass" : "error"}
            title="Yardi IDs present in Monday"
            detail={
              checks.unmappedYardi.length === 0
                ? "Every mapped property has a Yardi (PMS) code."
                : `${checks.unmappedYardi.length} mapped property(ies) have a blank Yardi ID.`
            }
            list={checks.unmappedYardi}
          />

          <CheckRow
            status={checks.balanceErrors.length === 0 ? "pass" : "error"}
            title="Balance-sheet GLs (1 / 2) budgeted correctly"
            detail={
              checks.balanceErrors.length === 0
                ? "All GL codes starting with 1 or 2 are budgeted negative."
                : `${checks.balanceErrors.length} propert${
                    checks.balanceErrors.length === 1 ? "y is" : "ies are"
                  } budgeted wrong (1/2 GL with a positive value). The entire property is excluded — go reject the budget in Monday.`
            }
            list={checks.balanceErrors.map(
              (e) =>
                `${e.name || e.rpId}${
                  e.name ? ` (RP ${e.rpId})` : ""
                } — bad GL(s): ${e.gls.join(", ")}`
            )}
          />

          <CheckRow
            status={checks.excludedRows > 0 ? "warn" : "pass"}
            title="Zero-budget rows"
            detail={
              checks.excludedRows > 0
                ? `${checks.excludedRows} all-zero row(s) will be excluded from the export.`
                : "No all-zero rows found."
            }
          />
        </div>
      )}

      {/* Unmapped resolution */}
      {checks && checks.unmappedRp.length > 0 && (
        <div className="panel">
          <h2>Resolve Unmapped Properties</h2>
          <div className="export-note" style={{ marginBottom: 14 }}>
            Enter the Yardi ID for each RealPage code and save it to the “
            {boardName}” board.
          </div>
          {checks.unmappedRp.map((rpId) => {
            const status = saveStatus[rpId];
            return (
              <div className="unmapped-row" key={rpId}>
                <div className="field">
                  <label>RealPage Code</label>
                  <input type="text" value={rpId} readOnly />
                </div>
                <div className="field">
                  <label>Yardi ID</label>
                  <input
                    type="text"
                    placeholder="e.g. ab1234"
                    value={yardiInputs[rpId] || ""}
                    onChange={(e) =>
                      setYardiInputs((s) => ({ ...s, [rpId]: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <button
                    className="btn"
                    disabled={savingRp[rpId]}
                    onClick={() => saveToMonday(rpId)}
                  >
                    {savingRp[rpId] ? (
                      <>
                        <span className="spinner" /> Saving…
                      </>
                    ) : (
                      "Save to Monday"
                    )}
                  </button>
                  {status && (
                    <div
                      className={`inline-status ${status.ok ? "ok" : "bad"}`}
                      style={{ marginTop: 6 }}
                    >
                      {status.msg}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary stats */}
      {checks && (
        <div className="panel">
          <h2>Summary</h2>
          <div className="stats-grid">
            <div className="stat">
              <div className="num">{checks.totalProperties}</div>
              <div className="label">Properties</div>
            </div>
            <div className="stat">
              <div className="num">{checks.totalRows}</div>
              <div className="label">GL Rows</div>
            </div>
            <div className="stat warn">
              <div className="num">{checks.excludedRows}</div>
              <div className="label">Rows Excluded</div>
            </div>
            <div className="stat danger">
              <div className="num">{checks.excludedProperties}</div>
              <div className="label">Properties Flagged</div>
            </div>
          </div>
        </div>
      )}

      {/* Export */}
      {parsed && (
        <div className="panel">
          <h2>Export</h2>
          <div className="btn-row">
            <button className="btn" disabled={!canExport} onClick={onExport}>
              {canExport && checks.fileCount > 1
                ? `Export ${checks.fileCount} ETL CSVs`
                : "Export ETL CSV"}
            </button>
            <span className="export-note">
              {canExport
                ? `${checks.exportableRows} row(s) across ${
                    checks.exportablePropertyCount
                  } propert${
                    checks.exportablePropertyCount === 1 ? "y" : "ies"
                  }` +
                  (checks.fileCount > 1
                    ? ` will be split into ${checks.fileCount} files of ≤${PROPERTIES_PER_FILE} properties each`
                    : " will be written") +
                  (checks.excludedProperties > 0
                    ? `; ${checks.excludedProperties} flagged propert${
                        checks.excludedProperties === 1 ? "y" : "ies"
                      } excluded.`
                    : ".")
                : "Resolve unmapped properties above to enable export."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckRow({ status, title, detail, list }) {
  const badge =
    status === "pass" ? "Pass" : status === "warn" ? "Warning" : "Error";
  return (
    <div className={`check-row ${status}`}>
      <span className="badge">{badge}</span>
      <div className="body">
        <div className="title">{title}</div>
        <div className="detail">
          {detail}
          {list && list.length > 0 && (
            <ul>
              {list.slice(0, 30).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
              {list.length > 30 && <li>…and {list.length - 30} more</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
