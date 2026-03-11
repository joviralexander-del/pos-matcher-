import { useState, useCallback, useRef, useEffect } from "react";

// ─── LOAD SheetJS ─────────────────────────────────────────────────────────────
function useSheetJS() {
  const [ready, setReady] = useState(!!window.XLSX);
  useEffect(() => {
    if (window.XLSX) { setReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, []);
  return ready;
}

// ─── TEXT NORMALIZATION ───────────────────────────────────────────────────────
const REMOVE_WORDS = [
  "FARMACIA","FARM","BOTICA","DROGUERIA","DRG","PHARMA",
  "SUCURSAL","FARMACEUTICA","FARMACÉUTICA","DISPENSARIO","DISPENSARY",
  "FAR"
];

function removeAccents(str) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normHeader(h) {
  return removeAccents(String(h || "").toUpperCase().trim());
}

function normalizeText(text) {
  if (!text) return "";
  let s = String(text).toUpperCase();
  s = removeAccents(s);
  s = s.replace(/[^A-Z0-9\s]/g, " ");
  REMOVE_WORDS.forEach(w => {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), " ");
  });
  s = expandAbbrev(s);
  return s.replace(/\s+/g, " ").trim();
}

const TEXT_EXPANSIONS = [
  [/\bHOS\b/g,  "HOSPITAL"],
  [/\bHOSP\b/g, "HOSPITAL"],
  [/\bCLIN\b/g, "CLINICA"],
  [/\bPARQ\b/g, "PARQUE"],
  [/\bAV\b/g,   "AVENIDA"],
  [/\bCDLA\b/g, "CIUDADELA"],
  [/\bPQ\b/g,   "PARQUE"],
  [/\bSTO\b/g,  "SANTO"],
  [/\bSTA\b/g,  "SANTA"],
];

function expandAbbrev(s) {
  for (const [re, val] of TEXT_EXPANSIONS) s = s.replace(re, val);
  return s.replace(/\s+/g, " ").trim();
}

// ─── ALIAS DICTIONARY ─────────────────────────────────────────────────────────
const CHAIN_ALIASES = [
  { from: /^ECO\b/,               to: "ECONOMICA" },
  { from: /^ECONOMIA\b/,          to: "ECONOMICA" },
  { from: /^MEDI\b/,              to: "MEDICITY" },
  { from: /^MDI\b/,               to: "MEDICITY" },
  { from: /^METRORED\b/,          to: "PAF MTR" },
  { from: /^CA\b/,                to: "CRUZ AZUL" },
  { from: /^FARMACIA BP\b/,       to: "BP" },
  { from: /^PH\b/,                to: "PHARMACYS" },
  { from: /^COM\b/,               to: "COMUNITARIA" },
  { from: /^MAY DIFARMES\b/,      to: "MAY DIFARMES" },
  { from: /^DIFARMES\b/,          to: "MAY DIFARMES" },
  { from: /^PAF \w+ DIFARMES\b/,  to: "MAY DIFARMES" },
];

function stripSuffix(name) {
  return String(name || "")
    .replace(/,\s*[A-Za-z]{1,4}\d{2,4}\s*$/i, "")
    .replace(/\s+[A-Za-z]{1,3}\d{3,4}\s*$/i, "")
    .replace(/\s*#?\s*0*(\d{1,3})\s*[-–]\s*/g, " ")
    .replace(/\s+[A-Z]\.\w+(\s+\d+)?.*$/i, "")
    .replace(/\bCUE\b/g, "")
    .replace(/\bUIO\b/g, "")
    .replace(/\bGYE\b/g, "")
    .replace(/\bAMB\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function applyAliases(normName) {
  let s = normName;
  for (const { from, to } of CHAIN_ALIASES) {
    if (from.test(s)) {
      s = s.replace(from, to).replace(/\s+/g, " ").trim();
      break;
    }
  }
  return s;
}

function similarity(a, b) {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const m = na.length, n = nb.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = na[i - 1] === nb[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return Math.round((1 - dp[m][n] / Math.max(m, n)) * 100);
}

// ─── COLUMN DETECTION ─────────────────────────────────────────────────────────
const NAME_COLS = ["NOMBRE LOCAL","FARMACIA","PUNTO DE VENTA","CLIENTE","ESTABLECIMIENTO","NOMBRE CLIENTE","LOCAL","NOMBRE"];
const CITY_COLS = ["CIUDAD","CANTON","CANTÓN","CITY"];
const PROV_COLS = ["PROVINCIA VENTA","PROVINCIA","PROVINCE","PROV"];
const ADDR_COLS = ["DIRECCION","DIRECCIÓN","ADDRESS","DIR","DOMICILIO"];

function detectCol(headers, candidates) {
  const normalizedHeaders = headers.map(h => ({ raw: h, norm: normHeader(h) }));

  for (const c of candidates) {
    const target = normHeader(c);
    const found = normalizedHeaders.find(h => h.norm === target);
    if (found) return found.raw;
  }
  for (const c of candidates) {
    const target = normHeader(c);
    const found = normalizedHeaders.find(h => h.norm.includes(target));
    if (found) return found.raw;
  }
  return null;
}

// ─── FILE PARSERS ─────────────────────────────────────────────────────────────
function parseCSVText(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g, "").trim());

  return lines.slice(1).map(line => {
    const vals = line.split(sep).map(v => v.replace(/^"|"$/g, "").trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

function parseExcelBuffer(buffer, sheetIndex = 0) {
  const XLSX = window.XLSX;
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[sheetIndex];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const row = rawRows[i];
    const nonEmpty = row.filter(c => c !== "" && c !== null && c !== undefined);
    if (
      nonEmpty.length >= 3 &&
      nonEmpty.every(c => typeof c === "string" && !String(c).includes("\n") && String(c).length < 60)
    ) {
      headerRowIdx = i;
      break;
    }
  }

  const headers = rawRows[headerRowIdx].map(h => String(h).trim());
  const rows = rawRows.slice(headerRowIdx + 1)
    .filter(row => row.some(c => c !== "" && c !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ""; });
      return obj;
    });

  return { rows, sheetNames: wb.SheetNames };
}

function readFileAsync(file) {
  return new Promise((resolve, reject) => {
    const isExcel = /\.(xlsx|xls|xlsm)$/i.test(file.name);
    const reader = new FileReader();
    if (isExcel) {
      reader.onload = e => resolve({ type: "excel", data: new Uint8Array(e.target.result), name: file.name });
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = e => resolve({ type: "csv", data: e.target.result, name: file.name });
      reader.onerror = reject;
      reader.readAsText(file, "utf-8");
    }
  });
}

// ─── SUFFIX CONFLICT ──────────────────────────────────────────────────────────
const ROMAN_TO_NUM = { I:"1",II:"2",III:"3",IV:"4",V:"5",VI:"6",VII:"7",VIII:"8",IX:"9",X:"10" };

function extractSuffix(name) {
  const words = String(name || "").trim().split(/\s+/);
  if (!words.length) return null;
  const last = words[words.length - 1];
  if (/^[0-9]+[A-Z]?$/.test(last)) return last;
  if (/^[IVX]+$/.test(last) && ROMAN_TO_NUM[last]) return ROMAN_TO_NUM[last];
  if (/^[A-Z]$/.test(last)) return last;
  return null;
}

function normSuffix(s) {
  return s ? (ROMAN_TO_NUM[s] || s) : null;
}

function suffixConflict(provName, gdcName) {
  const sp = normSuffix(extractSuffix(provName));
  const sg = normSuffix(extractSuffix(gdcName));
  if (sp && !sg) return true;
  if (!sp || !sg) return false;
  if (sp === sg) return false;
  if (sg.startsWith(sp) || sp.startsWith(sg)) return false;
  return true;
}

// ─── CHAIN COMPATIBILITY MAP ──────────────────────────────────────────────────
const CHAIN_MAP = [
  { prefix: /^ECONOMICA\b/,    allowed: ["ECONOMICA"] },
  { prefix: /^MEDICITY\b/,     allowed: ["MEDICITY"] },
  { prefix: /^PAF MTR\b/,      allowed: ["PAF MTR"] },
  { prefix: /^MAY BOYACA\b/,   allowed: ["MAY BOYACA"] },
  { prefix: /^MAY FARMAYOR\b/, allowed: ["MAY FARMAYOR"] },
  { prefix: /^MAY DIFARMES\b/, allowed: ["MAY DIFARMES"] },
  { prefix: /^SANASANA\b/,     allowed: ["SANASANA", "FYBECA"] },
  { prefix: /^FYBECA\b/,       allowed: ["FYBECA", "SANASANA"] },
  { prefix: /^CRUZ AZUL\b/,    allowed: ["CRUZ AZUL"] },
  { prefix: /^BP\b/,           allowed: ["BP"] },
  { prefix: /^PHARMACYS\b/,    allowed: ["PHARMACYS"] },
  { prefix: /^COMUNITARIA\b/,  allowed: ["COMUNITARIA"] },
  { prefix: /^DIFARMES\b/,     allowed: ["DIFARMES"] },
];

function chainAllowed(normProvName, normGdcName) {
  for (const { prefix, allowed } of CHAIN_MAP) {
    if (prefix.test(normProvName)) {
      return allowed.some(a => normGdcName.includes(a));
    }
  }
  return true;
}

// ─── WORD OVERLAP ─────────────────────────────────────────────────────────────
const GENERIC_WORDS = new Set([
  "ECONOMICA","MEDICITY","SANASANA","FYBECA","CRUZ","AZUL","PAF","MTR",
  "PHARMACYS","BP","COMUNITARIA","DIFARMES","MAY","DR","METRORED",
  "QUITO","GUAYAQUIL","AMBATO","RIOBAMBA","CUENCA","MANTA","LOJA",
  "PORTOVIEJO","IBARRA","ESMERALDAS","MACHALA","LATACUNGA","SANTO",
  "BABAHOYO","AZOGUES","TULCAN","GUARANDA","TENA","PUYO","MACAS",
  "ZAMORA","NUEVA","LAGO","AGRIO","ALAUSI","DAULE","DURAN","CAYAMBE",
  "OTAVALO","PILLARO","PELILEO","SALCEDO","PUJILI","SAQUISILI",
  "SANGOLQUI","RUMINAHUI","TUMBACO","CUMBAYA","CONOCOTO","SACHA",
  "COCA","ORELLANA","QUININDE","SANTODOMINGO","HUAQUILLAS","PASAJE",
  "SANTA","ROSA","MILAGRO","NARANJAL","PLAYAS","GENERAL","PEDRO",
  "CIUDAD","AV","AVENIDA","CALLE","CDLA","CIUDADELA","HOSP","HOSPITAL",
  "CLINICA","IESS","PARQ","PARQUE","CC","CENTRO","COMERCIAL","NORTE","SUR","ESTE","OESTE",
]);

function wordOverlapRatio(a, b) {
  const bSet = new Set(String(b || "").split(" ").filter(w => w.length > 1));
  const meaningful = String(a || "").split(" ").filter(w => w.length > 1 && !GENERIC_WORDS.has(w));
  if (meaningful.length === 0) return 1.0;
  const shared = meaningful.filter(w => bSet.has(w)).length;
  return shared / meaningful.length;
}

// ─── PROVIDER DETECTION ───────────────────────────────────────────────────────
function getProviderConfig(provName, headers) {
  const fileNameNorm = normHeader(provName || "");
  const hset = new Set(headers.map(normHeader));

  const isGPF =
    fileNameNorm.includes("GPF") ||
    (hset.has("NOMBRE LOCAL") && hset.has("COD LOCAL") && hset.has("CIUDAD"));

  const isFarmaenlace =
    fileNameNorm.includes("FARMAENLACE") ||
    (hset.has("FARMACIA") && hset.has("PROVINCIA VENTA"));

  return {
    isGPF,
    isFarmaenlace,
  };
}

function resolveColumn(headers, exactLabel, fallback = null) {
  const exact = headers.find(h => normHeader(h) === normHeader(exactLabel));
  return exact || fallback;
}

// ─── PREPROCESS GDC ───────────────────────────────────────────────────────────
function preprocessGDC(gdc) {
  const byCity = new Map();
  const byProv = new Map();

  const preparedRows = gdc.map((row, idx) => {
    const puntoVenta = String(row["PUNTO DE VENTA"] || "");
    const ciudad = String(row["CIUDAD"] || "");
    const provincia = String(row["PROVINCIA"] || row["PROVINCIA VENTA"] || row["PROV"] || "");
    const direccion = String(row["DIRECCIÓN"] || row["DIRECCION"] || "");

    const prepared = {
      ...row,
      __idx: idx,
      __name: puntoVenta,
      __normName: normalizeText(puntoVenta),
      __city: ciudad,
      __normCity: normalizeText(ciudad),
      __prov: provincia,
      __normProv: normalizeText(provincia),
      __addr: direccion,
      __normAddr: normalizeText(direccion),
    };

    if (prepared.__normCity) {
      if (!byCity.has(prepared.__normCity)) byCity.set(prepared.__normCity, []);
      byCity.get(prepared.__normCity).push(prepared);
    }

    if (prepared.__normProv) {
      if (!byProv.has(prepared.__normProv)) byProv.set(prepared.__normProv, []);
      byProv.get(prepared.__normProv).push(prepared);
    }

    return prepared;
  });

  return { rows: preparedRows, byCity, byProv };
}

// ─── MATCHING ENGINE ──────────────────────────────────────────────────────────
function matchRecord(record, preparedGdc, colMap) {
  const rawName = stripSuffix(record[colMap.name] || "");
  const normName = applyAliases(normalizeText(rawName));

  if (/OFICINA MATRIZ/i.test(rawName)) {
    return {
      "COD POS": null,
      "PUNTO DE VENTA": "— OFICINA MATRIZ (ignorada)",
      MATCH_SCORE: 0,
      TIPO_MATCH: "NO_MATCH"
    };
  }

  const normCity = normalizeText(record[colMap.city] || "");
  const normProv = normalizeText(record[colMap.prov] || "");
  const normAddr = normalizeText(record[colMap.addr] || "");

  let pool = preparedGdc.rows;
  let geoFiltered = false;

  if (normCity && preparedGdc.byCity.has(normCity)) {
    pool = preparedGdc.byCity.get(normCity);
    geoFiltered = true;
  } else if (normProv && preparedGdc.byProv.has(normProv)) {
    pool = preparedGdc.byProv.get(normProv);
    geoFiltered = true;
  }

  let best = null;
  let bestScore = 0;
  let bestType = "NO_MATCH";

  for (const g of pool) {
    const gName = g.__normName;
    const gCity = g.__normCity;
    const gProv = g.__normProv;
    const gAddr = g.__normAddr;

    const cityMatch = normCity ? normCity === gCity : true;
    const provMatch = normProv ? normProv === gProv : true;
    const geoMatch = geoFiltered ? true : (normCity ? cityMatch : normProv ? provMatch : true);

    if (!chainAllowed(normName, gName)) continue;
    if (suffixConflict(normName, gName)) continue;

    if (normName === gName && geoMatch) {
      return { ...g, MATCH_SCORE: 100, TIPO_MATCH: "EXACT_MATCH" };
    }

    const nameSim = similarity(normName, gName);
    const overlap = wordOverlapRatio(normName, gName);

    if (nameSim >= 85 && overlap >= 0.6 && geoMatch) {
      const score = Math.min(99, Math.round(nameSim * 0.85 + 14));
      if (score > bestScore) {
        bestScore = score;
        best = g;
        bestType = "FUZZY_MATCH";
      }
    }

    if (normAddr && gAddr) {
      const addrSim = similarity(normAddr, gAddr);
      if (addrSim >= 80 && geoMatch) {
        const score = Math.round(addrSim * 0.7 + 20);
        if (score > bestScore) {
          bestScore = score;
          best = g;
          bestType = "ADDRESS_MATCH";
        }
      }
    }

    const aiOverlapThreshold = geoFiltered ? 0.6 : 0.8;
    if (normName && gName && nameSim >= 65 && overlap >= aiOverlapThreshold && geoMatch) {
      const aiScore = Math.round(overlap * 80 + 10);
      if (aiScore >= 59 && aiScore > bestScore) {
        bestScore = aiScore;
        best = g;
        bestType = "AI_MATCH";
      }
    }
  }

  if (best) return { ...best, MATCH_SCORE: bestScore, TIPO_MATCH: bestType };
  return { "COD POS": null, "PUNTO DE VENTA": null, MATCH_SCORE: 0, TIPO_MATCH: "NO_MATCH" };
}

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const csv = [
    keys.join(";"),
    ...rows.map(r => keys.map(k => `"${(r[k] ?? "")}"`).join(";"))
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ─── ICONS ────────────────────────────────────────────────────────────────────
const IconUpload = () => (
  <svg width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0L8 8m4-4l4 4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconDownload = () => (
  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconDB = () => (
  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <ellipse cx="12" cy="5" rx="9" ry="3"/>
    <path d="M3 5v4c0 1.657 4.03 3 9 3s9-1.343 9-3V5M3 9v4c0 1.657 4.03 3 9 3s9-1.343 9-3V9M3 13v4c0 1.657 4.03 3 9 3s9-1.343 9-3v-4"/>
  </svg>
);

// ─── BADGE ────────────────────────────────────────────────────────────────────
const BADGE_CLR = {
  EXACT_MATCH:"#22c55e",
  FUZZY_MATCH:"#f59e0b",
  ADDRESS_MATCH:"#3b82f6",
  AI_MATCH:"#a855f7",
  NO_MATCH:"#ef4444"
};

const Badge = ({ type }) => {
  const c = BADGE_CLR[type] || "#64748b";
  return (
    <span style={{
      background:`${c}20`,
      color:c,
      border:`1px solid ${c}50`,
      borderRadius:4,
      padding:"2px 8px",
      fontSize:10,
      fontWeight:600,
      fontFamily:"'DM Mono',monospace",
      whiteSpace:"nowrap"
    }}>
      {type}
    </span>
  );
};

// ─── METRIC CARD ──────────────────────────────────────────────────────────────
const MetricCard = ({ label, value, color, pct }) => (
  <div style={{ background:"#0f172a", border:`1px solid ${color}25`, borderRadius:10, padding:"13px 15px" }}>
    <div style={{ fontSize:24, fontWeight:700, color, fontFamily:"'DM Mono',monospace" }}>{value}</div>
    {pct !== undefined && (
      <div style={{ height:3, background:"#1e293b", borderRadius:2, margin:"6px 0" }}>
        <div style={{ height:3, width:`${pct}%`, background:color, borderRadius:2, transition:"width 0.6s" }}/>
      </div>
    )}
    <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:1 }}>{label}</div>
  </div>
);

// ─── DROP ZONE ────────────────────────────────────────────────────────────────
function DropZone({ label, sublabel, onFile, loaded, color, accept, tag }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  const handle = useCallback(file => { if (file) onFile(file); }, [onFile]);

  return (
    <div
      onClick={() => ref.current.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
      style={{
        border:`2px dashed ${drag ? color : loaded ? color : "#334155"}`,
        borderRadius:12,
        padding:"24px 18px",
        cursor:"pointer",
        textAlign:"center",
        background: loaded ? `${color}10` : drag ? `${color}06` : "#0a1020",
        transition:"all 0.2s"
      }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display:"none" }} onChange={e => handle(e.target.files[0])} />
      <div style={{ color: loaded ? color : "#475569", marginBottom:8 }}>
        {loaded
          ? <svg width="22" height="22" fill="none" stroke={color} strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : <IconUpload />}
      </div>
      <div style={{ fontFamily:"'DM Mono',monospace", fontSize:12, color: loaded ? color : "#94a3b8", fontWeight:600 }}>{label}</div>
      <div style={{ fontSize:10, color:"#475569", marginTop:4 }}>{sublabel}</div>
      {tag && <div style={{ marginTop:8, fontSize:10, color, fontFamily:"'DM Mono',monospace" }}>{tag}</div>}
    </div>
  );
}

// ─── SHEET SELECTOR ───────────────────────────────────────────────────────────
function SheetSelector({ sheets, selected, onChange }) {
  if (!sheets || sheets.length <= 1) return null;
  return (
    <div style={{ display:"flex", gap:6, alignItems:"center", marginTop:8, flexWrap:"wrap" }}>
      <span style={{ fontSize:10, color:"#475569", fontFamily:"'DM Mono',monospace" }}>HOJA:</span>
      {sheets.map((s, i) => (
        <button
          key={s}
          onClick={e => { e.stopPropagation(); onChange(i); }}
          style={{
            background: selected===i ? "#6366f120" : "none",
            border:`1px solid ${selected===i ? "#6366f1" : "#334155"}`,
            color: selected===i ? "#6366f1" : "#64748b",
            borderRadius:5,
            padding:"2px 10px",
            fontSize:11,
            cursor:"pointer",
            fontFamily:"'DM Mono',monospace"
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const xlsxReady = useSheetJS();

  const [gdcData, setGdcData]       = useState(null);
  const [gdcName, setGdcName]       = useState(null);
  const [provRaw, setProvRaw]       = useState(null);
  const [provData, setProvData]     = useState(null);
  const [provName, setProvName]     = useState(null);
  const [provSheets, setProvSheets] = useState(null);
  const [provSheet, setProvSheet]   = useState(0);
  const [provType, setProvType]     = useState(null);
  const [results, setResults]       = useState(null);
  const [noMatch, setNoMatch]       = useState(null);
  const [metrics, setMetrics]       = useState(null);
  const [colMap, setColMap]         = useState(null);
  const [processing, setProcessing] = useState(false);
  const [tab, setTab]               = useState("results");
  const [page, setPage]             = useState(0);
  const [progress, setProgress]     = useState(0);

  const PAGE_SIZE = 20;

  const handleGDC = useCallback(async (file) => {
    const r = await readFileAsync(file);
    let rows;
    if (r.type === "excel") {
      rows = parseExcelBuffer(r.data, 0).rows;
    } else {
      rows = parseCSVText(r.data);
    }
    setGdcData(rows);
    setGdcName(file.name);
    setResults(null);
    setNoMatch(null);
    setMetrics(null);
  }, []);

  const handleProv = useCallback(async (file) => {
    const r = await readFileAsync(file);
    setProvRaw(r);
    setProvName(file.name);
    setProvType(r.type);
    setResults(null);
    setNoMatch(null);
    setMetrics(null);

    if (r.type === "excel") {
      const parsed = parseExcelBuffer(r.data, 0);
      setProvData(parsed.rows);
      setProvSheets(parsed.sheetNames);
      setProvSheet(0);
    } else {
      setProvData(parseCSVText(r.data));
      setProvSheets(null);
      setProvSheet(0);
    }
  }, []);

  const handleSheetChange = useCallback((idx) => {
    if (!provRaw || provRaw.type !== "excel") return;
    const parsed = parseExcelBuffer(provRaw.data, idx);
    setProvData(parsed.rows);
    setProvSheet(idx);
    setResults(null);
    setNoMatch(null);
    setMetrics(null);
  }, [provRaw]);

  const process = async () => {
    if (!gdcData || !provData || !provData.length) return;

    setProcessing(true);
    setProgress(0);

    await new Promise(r => setTimeout(r, 30));

    const headers = Object.keys(provData[0] || {});
    const providerCfg = getProviderConfig(provName, headers);

    let detected = {
      name: detectCol(headers, NAME_COLS) || headers[0],
      city: detectCol(headers, CITY_COLS),
      prov: detectCol(headers, PROV_COLS),
      addr: detectCol(headers, ADDR_COLS),
    };

    if (providerCfg.isGPF) {
      detected = {
        ...detected,
        name: resolveColumn(headers, "NOMBRE LOCAL", detected.name),
        city: resolveColumn(headers, "CIUDAD", detected.city),
      };
    }

    if (providerCfg.isFarmaenlace) {
      detected = {
        ...detected,
        name: resolveColumn(headers, "Farmacia", detected.name),
        prov: resolveColumn(headers, "Provincia Venta", detected.prov),
        city: null,
      };
    }

    setColMap(detected);

    const preparedGdc = preprocessGDC(gdcData);

    const seen = new Set();
    const uniqueRecords = [];
    const resultByKey = new Map();

    for (const rec of provData) {
      const rawName = rec[detected.name] || "";
      const rawGeo = rec[detected.city] || rec[detected.prov] || "";
      const key = [
        applyAliases(normalizeText(stripSuffix(rawName))),
        normalizeText(rawGeo)
      ].join("__");

      if (!seen.has(key)) {
        seen.add(key);
        uniqueRecords.push({ rec, key });
      }
    }

    const matched = [];
    const unmatched = [];
    let exact = 0, fuzzy = 0, address = 0, ai = 0, none = 0;
    const total = provData.length;
    const BATCH = 300;

    for (let i = 0; i < uniqueRecords.length; i += BATCH) {
      const batch = uniqueRecords.slice(i, i + BATCH);

      for (const { rec, key } of batch) {
        const r = matchRecord(rec, preparedGdc, detected);
        resultByKey.set(key, r);
      }

      setProgress(Math.min(100, Math.round(((i + batch.length) / uniqueRecords.length) * 100)));
      await new Promise(r => setTimeout(r, 0));
    }

    for (const rec of provData) {
      const rawName = rec[detected.name] || "";
      const rawGeo = rec[detected.city] || rec[detected.prov] || "";
      const key = [
        applyAliases(normalizeText(stripSuffix(rawName))),
        normalizeText(rawGeo)
      ].join("__");

      const r = resultByKey.get(key) || { "COD POS": null, MATCH_SCORE: 0, TIPO_MATCH: "NO_MATCH" };

      const brickRaw = r["BRICK"] || "";
      const brickNum = /^\d+/.test(brickRaw) ? brickRaw.match(/^\d+/)[0] : brickRaw;

      const {
        __idx, __name, __normName, __city, __normCity, __prov, __normProv, __addr, __normAddr,
        ...cleanR
      } = r;

      const enriched = { ...rec, ...cleanR, BRICK: brickNum };

      if (r.TIPO_MATCH === "NO_MATCH") {
        none++;
        unmatched.push(enriched);
      } else {
        if (r.TIPO_MATCH === "EXACT_MATCH") exact++;
        else if (r.TIPO_MATCH === "FUZZY_MATCH") fuzzy++;
        else if (r.TIPO_MATCH === "ADDRESS_MATCH") address++;
        else if (r.TIPO_MATCH === "AI_MATCH") ai++;
        matched.push(enriched);
      }
    }

    setResults([...matched, ...unmatched]);
    setNoMatch(unmatched);
    setMetrics({
      total,
      unique: uniqueRecords.length,
      exact,
      fuzzy,
      address,
      ai,
      none,
      coverage: total ? Math.round(((total - none) / total) * 100) : 0,
    });

    setProcessing(false);
    setProgress(0);
    setTab("results");
    setPage(0);
  };

  const displayRows = tab === "results" ? (results || []) : (noMatch || []);
  const totalPages  = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const pageRows    = displayRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const provCols    = provData ? Object.keys(provData[0] || {}).slice(0, 5) : [];
  const coverageColor = !metrics ? "#64748b"
    : metrics.coverage >= 80 ? "#22c55e"
    : metrics.coverage >= 60 ? "#f59e0b"
    : "#ef4444";

  return (
    <div style={{ minHeight:"100vh", background:"#020617", color:"#e2e8f0", fontFamily:"'DM Sans','Segoe UI',sans-serif", display:"flex", flexDirection:"column" }}>

      <div style={{ borderBottom:"1px solid #1e293b", padding:"16px 26px", display:"flex", alignItems:"center", gap:14, background:"linear-gradient(90deg,#020617,#0f172a)" }}>
        <div style={{ width:40, height:40, borderRadius:10, background:"linear-gradient(135deg,#0ea5e9,#6366f1)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <IconDB />
        </div>
        <div>
          <div style={{ fontWeight:700, fontSize:17 }}>POS <span style={{ color:"#0ea5e9" }}>Matcher</span></div>
          <div style={{ fontSize:10, color:"#475569", fontFamily:"'DM Mono',monospace" }}>CONCILIACIÓN FARMACÉUTICA · BASE GDC · v2.0</div>
        </div>
        <div style={{ display:"flex", gap:5, marginLeft:14 }}>
          {["CSV",".XLSX",".XLS","Multi-Hoja"].map(f => (
            <span key={f} style={{ background:"#0f172a", border:"1px solid #1e293b", color:"#334155", borderRadius:4, padding:"2px 7px", fontSize:9, fontFamily:"'DM Mono',monospace" }}>{f}</span>
          ))}
        </div>

        {!xlsxReady && (
          <span style={{ marginLeft:"auto", fontSize:10, color:"#f59e0b", fontFamily:"'DM Mono',monospace" }}>
            ⟳ cargando soporte Excel…
          </span>
        )}

        {metrics && (
          <div style={{ marginLeft:"auto", background: metrics.coverage>=80?"#052e16": metrics.coverage>=60?"#1c1917":"#1f0707", border:`1px solid ${coverageColor}40`, borderRadius:8, padding:"7px 14px", display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontSize:21, fontWeight:700, fontFamily:"'DM Mono',monospace", color:coverageColor }}>{metrics.coverage}%</span>
            <span style={{ fontSize:9, color:"#64748b" }}>COBERTURA</span>
          </div>
        )}
      </div>

      <div style={{ flex:1, padding:"20px 26px", maxWidth:1440, width:"100%", margin:"0 auto" }}>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:18 }}>
          <div>
            <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:1, marginBottom:7 }}>📋 Base Maestra GDC</div>
            <DropZone
              label={gdcName || "Cargar GDC — CSV o Excel"}
              sublabel="COD POS · PUNTO DE VENTA · CIUDAD · DIRECCIÓN"
              onFile={handleGDC}
              loaded={!!gdcData}
              color="#0ea5e9"
              accept=".csv,.txt,.xlsx,.xls"
            />
            {gdcData && <div style={{ fontSize:10, color:"#0ea5e9", marginTop:5, fontFamily:"'DM Mono',monospace" }}>✓ {gdcData.length.toLocaleString()} registros</div>}
          </div>

          <div>
            <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:1, marginBottom:7 }}>
              📦 Archivo Proveedor
              <span style={{ marginLeft:8, background:"#6366f115", border:"1px solid #6366f130", color:"#6366f1", borderRadius:4, padding:"1px 7px", fontSize:9 }}>CSV · XLSX · XLS</span>
            </div>
            <DropZone
              label={provName || "Cargar Proveedor — CSV o Excel"}
              sublabel="Estructura heterogénea · Múltiples hojas soportadas"
              onFile={handleProv}
              loaded={!!provData}
              color="#6366f1"
              accept=".csv,.txt,.xlsx,.xls,.xlsm"
              tag={provType === "excel" ? "📊 Formato Excel detectado" : null}
            />
            {provData && <div style={{ fontSize:10, color:"#6366f1", marginTop:5, fontFamily:"'DM Mono',monospace" }}>✓ {provData.length.toLocaleString()} registros · hoja: <b>{provSheets?.[provSheet] || "CSV"}</b></div>}
            <SheetSelector sheets={provSheets} selected={provSheet} onChange={handleSheetChange} />
          </div>
        </div>

        {colMap && (
          <div style={{ background:"#0a1020", border:"1px solid #1e293b", borderRadius:10, padding:"9px 16px", marginBottom:16, display:"flex", gap:18, flexWrap:"wrap", alignItems:"center" }}>
            <span style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:1 }}>Columnas detectadas:</span>
            {[{ k:"NOMBRE", v:colMap.name, c:"#0ea5e9" },{ k:"CIUDAD", v:colMap.city, c:"#22c55e" },{ k:"PROVINCIA", v:colMap.prov, c:"#f59e0b" },{ k:"DIRECCIÓN", v:colMap.addr, c:"#a855f7" }].map(({ k,v,c }) => (
              <div key={k} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <span style={{ fontSize:9, color:"#334155", fontFamily:"'DM Mono',monospace" }}>{k}</span>
                <span style={{ background: v ? `${c}15` : "#1e293b", color: v ? c : "#334155", border:`1px solid ${v ? c+"40" : "#1e293b"}`, borderRadius:4, padding:"1px 8px", fontSize:11, fontFamily:"'DM Mono',monospace" }}>{v || "—"}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap", alignItems:"center" }}>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <button
              onClick={process}
              disabled={!gdcData || !provData || processing || !xlsxReady}
              style={{
                background: gdcData && provData && xlsxReady ? "linear-gradient(135deg,#0ea5e9,#6366f1)" : "#1e293b",
                color: gdcData && provData && xlsxReady ? "#fff" : "#475569",
                border:"none",
                borderRadius:8,
                padding:"10px 24px",
                fontSize:12,
                fontWeight:700,
                cursor: gdcData && provData && xlsxReady ? "pointer" : "not-allowed",
                fontFamily:"'DM Mono',monospace",
                letterSpacing:0.5
              }}
            >
              {processing ? `⟳ PROCESANDO… ${progress}%` : "▶  EJECUTAR CONCILIACIÓN"}
            </button>

            {processing && (
              <div style={{ height:4, background:"#1e293b", borderRadius:2, width:220 }}>
                <div style={{ height:4, width:`${progress}%`, background:"linear-gradient(90deg,#0ea5e9,#6366f1)", borderRadius:2, transition:"width 0.3s" }}/>
              </div>
            )}
          </div>

          {results && <>
            <button
              onClick={() => exportCSV(results, "pos_resultado_final.csv")}
              style={{ background:"#0f172a", border:"1px solid #22c55e40", color:"#22c55e", borderRadius:8, padding:"10px 16px", fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5, fontFamily:"'DM Mono',monospace" }}
            >
              <IconDownload /> Dataset Final
            </button>

            <button
              onClick={() => exportCSV(noMatch, "farmacias_no_encontradas.csv")}
              style={{ background:"#0f172a", border:"1px solid #ef444440", color:"#ef4444", borderRadius:8, padding:"10px 16px", fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5, fontFamily:"'DM Mono',monospace" }}
            >
              <IconDownload /> Sin Coincidencia ({noMatch.length})
            </button>
          </>}
        </div>

        {metrics && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:10, marginBottom:20 }}>
            <MetricCard label="Total" value={metrics.total} color="#94a3b8" pct={100}/>
            <MetricCard label="Exact" value={metrics.exact} color="#22c55e" pct={Math.round(metrics.exact/metrics.total*100)}/>
            <MetricCard label="Fuzzy" value={metrics.fuzzy} color="#f59e0b" pct={Math.round(metrics.fuzzy/metrics.total*100)}/>
            <MetricCard label="Address" value={metrics.address} color="#3b82f6" pct={Math.round(metrics.address/metrics.total*100)}/>
            <MetricCard label="AI Match" value={metrics.ai} color="#a855f7" pct={Math.round(metrics.ai/metrics.total*100)}/>
            <MetricCard label="Sin Match" value={metrics.none} color="#ef4444" pct={Math.round(metrics.none/metrics.total*100)}/>
            <MetricCard label="Cobertura" value={`${metrics.coverage}%`} color={coverageColor} pct={metrics.coverage}/>
          </div>
        )}

        {results && (
          <div style={{ background:"#0a1020", border:"1px solid #1e293b", borderRadius:12, overflow:"hidden" }}>
            <div style={{ display:"flex", borderBottom:"1px solid #1e293b" }}>
              {[{ id:"results", label:`Resultados (${results.length})`, c:"#0ea5e9" }, { id:"nomatch", label:`Sin Coincidencia (${noMatch.length})`, c:"#ef4444" }].map(t => (
                <button
                  key={t.id}
                  onClick={() => { setTab(t.id); setPage(0); }}
                  style={{ background:"none", border:"none", padding:"11px 18px", cursor:"pointer", fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:600, color: tab===t.id?t.c:"#475569", borderBottom: tab===t.id?`2px solid ${t.c}`:"2px solid transparent" }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#020617" }}>
                    {provCols.map(c => (
                      <th key={c} style={{ padding:"9px 13px", textAlign:"left", color:"#334155", fontFamily:"'DM Mono',monospace", fontSize:10, textTransform:"uppercase", letterSpacing:0.8, whiteSpace:"nowrap", borderBottom:"1px solid #1e293b" }}>
                        {c}
                      </th>
                    ))}
                    <th style={{ padding:"9px 13px", color:"#0ea5e9", fontFamily:"'DM Mono',monospace", fontSize:10, textTransform:"uppercase", borderBottom:"1px solid #1e293b", whiteSpace:"nowrap" }}>COD POS</th>
                    <th style={{ padding:"9px 13px", color:"#334155", fontFamily:"'DM Mono',monospace", fontSize:10, textTransform:"uppercase", borderBottom:"1px solid #1e293b" }}>SCORE</th>
                    <th style={{ padding:"9px 13px", color:"#334155", fontFamily:"'DM Mono',monospace", fontSize:10, textTransform:"uppercase", borderBottom:"1px solid #1e293b" }}>TIPO</th>
                    <th style={{ padding:"9px 13px", color:"#334155", fontFamily:"'DM Mono',monospace", fontSize:10, textTransform:"uppercase", borderBottom:"1px solid #1e293b", whiteSpace:"nowrap" }}>PdV GDC</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, i) => (
                    <tr key={i} style={{ borderBottom:"1px solid #0d1520", background: i%2===0 ? "#0a1020" : "#0d1626" }}>
                      {provCols.map(c => (
                        <td key={c} style={{ padding:"8px 13px", color:"#94a3b8", maxWidth:150, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {row[c] || "—"}
                        </td>
                      ))}
                      <td style={{ padding:"8px 13px", fontFamily:"'DM Mono',monospace", color: row["COD POS"] ? "#0ea5e9" : "#334155", fontWeight:700 }}>{row["COD POS"] || "—"}</td>
                      <td style={{ padding:"8px 13px", fontFamily:"'DM Mono',monospace", color: row.MATCH_SCORE>=88 ? "#22c55e" : row.MATCH_SCORE>=70 ? "#f59e0b" : "#ef4444" }}>{row.MATCH_SCORE ? `${row.MATCH_SCORE}%` : "—"}</td>
                      <td style={{ padding:"8px 13px" }}><Badge type={row.TIPO_MATCH}/></td>
                      <td style={{ padding:"8px 13px", color:"#475569", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{row["PUNTO DE VENTA"] || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 14px", borderTop:"1px solid #1e293b", justifyContent:"flex-end" }}>
                <button onClick={() => setPage(p => Math.max(0,p-1))} disabled={page===0} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", padding:"3px 12px", borderRadius:5, cursor:"pointer", fontSize:12 }}>←</button>
                <span style={{ fontSize:11, color:"#475569", fontFamily:"'DM Mono',monospace" }}>{page+1} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages-1,p+1))} disabled={page===totalPages-1} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", padding:"3px 12px", borderRadius:5, cursor:"pointer", fontSize:12 }}>→</button>
              </div>
            )}
          </div>
        )}

        {!results && (
          <div style={{ textAlign:"center", padding:"52px 0", color:"#1e293b" }}>
            <div style={{ fontSize:42, marginBottom:12 }}>⬡</div>
            <div style={{ fontFamily:"'DM Mono',monospace", fontSize:13, color:"#334155" }}>Carga la Base GDC y el archivo proveedor para iniciar</div>
            <div style={{ fontSize:11, marginTop:6, color:"#1e293b" }}>CSV · XLSX · XLS · XLSM — con soporte multi-hoja</div>
            <div style={{ display:"flex", gap:10, justifyContent:"center", marginTop:16 }}>
              {["Exact ≥ 100%","Fuzzy ≥ 88%","Address ≥ 80%","AI ≥ 60%"].map(t => (
                <span key={t} style={{ background:"#0a1020", border:"1px solid #1e293b", borderRadius:6, padding:"3px 12px", fontSize:10, color:"#334155", fontFamily:"'DM Mono',monospace" }}>{t}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ borderTop:"1px solid #0a1020", padding:"9px 26px", fontSize:9, color:"#1e293b", fontFamily:"'DM Mono',monospace", display:"flex", justifyContent:"space-between" }}>
        <span>POS MATCHER v2.0 · PHARMA DATA ENGINEERING</span>
        <span>CSV · XLSX · XLS · MULTI-SHEET · FUZZY ≥88% · ADDRESS ≥80%</span>
      </div>
    </div>
  );
}