import { useState, useCallback } from "react";

const C = {
  yellow: "#F5C518", amber: "#F0A030", darkAmber: "#E8901A",
  black: "#1A1A1A", gray: "#4A4A4A", muted: "#8A8A8A",
  border: "#F0E4B8", bgLight: "#FFFBF0", bgCard: "#FFFFFF", bgPage: "#F7F5F0",
  green: "#16a34a", greenBg: "#f0fdf4", greenBorder: "#bbf7d0",
  red: "#dc2626", redBg: "#fef2f2", redBorder: "#fecaca",
  orange: "#F97316", orangeBg: "#fff7ed", orangeBorder: "#fed7aa",
  blue: "#2563eb", blueBg: "#eff6ff", blueBorder: "#bfdbfe",
};

// ── HELPERS ─────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(Math.abs(n));
}

async function siigoFetch(token, endpoint, params = {}) {
  const qs = new URLSearchParams({ endpoint, ...params }).toString();
  const res = await fetch(`/api/proxy?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  });
  return res.json();
}

async function fetchAll(token, endpoint, params = {}) {
  let all = [], page = 1, total = 1;
  while (all.length < total) {
    const data = await siigoFetch(token, endpoint, { ...params, page, page_size: 100 });
    const results = data?.results || [];
    total = data?.pagination?.total_results || results.length;
    all = [...all, ...results];
    if (results.length < 100) break;
    page++;
  }
  return all;
}

// ── ANÁLISIS M1-M5 ───────────────────────────────────────
function analizarM1(journals) {
  const balances = {};
  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code || "";
      if (!code) return;
      const grupo = code[0];
      if (!balances[code]) balances[code] = { code, grupo, debits: 0, credits: 0, desc: item.description || "" };
      if (item.account?.movement === "Debit") balances[code].debits += item.value || 0;
      else balances[code].credits += item.value || 0;
    });
  });

  const cuentas = Object.values(balances).map(c => ({
    ...c,
    saldo: c.debits - c.credits,
    saldoAbs: Math.abs(c.debits - c.credits)
  }));

  // Cuentas de resultado (4,5,6,7) deben estar en cero al cierre
  const resultado = cuentas.filter(c => ["4","5","6","7"].includes(c.grupo));
  const noZero = resultado.filter(c => Math.abs(c.saldo) > 100);

  // Saldos contrarios a naturaleza
  const activos = cuentas.filter(c => ["1"].includes(c.grupo) && c.saldo < -100);
  const pasivos = cuentas.filter(c => ["2","3"].includes(c.grupo) && c.saldo > 100);
  const contrarios = [...activos, ...pasivos];

  return { cuentas, resultado, noZero, contrarios, total: cuentas.length };
}

function analizarM2(journals) {
  const CUENTAS_IMP = {
    "2365": "ReteFuente por pagar",
    "2367": "ReteICA por pagar",
    "2368": "ReteIVA por pagar",
    "2408": "IVA por pagar",
    "2404": "ICA por pagar",
    "2205": "IVA descontable",
  };

  const saldos = {};
  Object.keys(CUENTAS_IMP).forEach(k => { saldos[k] = { debits: 0, credits: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (saldos[code]) {
        if (item.account?.movement === "Debit") saldos[code].debits += item.value || 0;
        else saldos[code].credits += item.value || 0;
      }
    });
  });

  const resultado = Object.entries(saldos).map(([code, v]) => ({
    code,
    nombre: CUENTAS_IMP[code],
    saldo: v.credits - v.debits,
    debits: v.debits,
    credits: v.credits,
    tieneMovimiento: v.debits > 0 || v.credits > 0,
  }));

  const iva = resultado.find(r => r.code === "2408");
  const alertas = resultado.filter(r => r.tieneMovimiento && r.saldo < 0);

  return { resultado, iva, alertas };
}

function analizarM3(journals) {
  const ANTICIPOS = ["1330", "1120"];
  const CXP = ["2205", "2335", "2206"];

  const porTercero = {};

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      const tercero = item.customer?.identification || item.supplier?.identification || "SIN_TERCERO";
      const val = item.value || 0;
      const es_anticipo = ANTICIPOS.includes(code);
      const es_cxp = CXP.includes(code);
      if (!es_anticipo && !es_cxp) return;

      if (!porTercero[tercero]) porTercero[tercero] = { tercero, anticipos: 0, cxp: 0, cuenta_anticipo: "", cuenta_cxp: "" };

      if (es_anticipo) {
        const mov = item.account?.movement;
        porTercero[tercero].anticipos += mov === "Debit" ? val : -val;
        porTercero[tercero].cuenta_anticipo = code;
      }
      if (es_cxp) {
        const mov = item.account?.movement;
        porTercero[tercero].cxp += mov === "Credit" ? val : -val;
        porTercero[tercero].cuenta_cxp = code;
      }
    });
  });

  const lista = Object.values(porTercero).filter(t => t.anticipos > 100 || t.cxp > 100);
  const neteables = lista.filter(t => t.anticipos > 100 && t.cxp > 100);
  const anticiposSolos = lista.filter(t => t.anticipos > 100 && t.cxp <= 100);
  const totalAnticipo = lista.reduce((s, t) => s + t.anticipos, 0);
  const totalNeto = neteables.reduce((s, t) => s + Math.min(t.anticipos, t.cxp), 0);

  return { lista, neteables, anticiposSolos, totalAnticipo, totalNeto };
}

function analizarM4(journals, pilaData) {
  const NOMINA = { "2370": "Nómina por pagar", "2380": "Cesantías", "2610": "Prestaciones", "2620": "Pensiones", "2630": "Seguridad social" };
  const saldos = {};
  Object.keys(NOMINA).forEach(k => { saldos[k] = { debits: 0, credits: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (saldos[code]) {
        if (item.account?.movement === "Debit") saldos[code].debits += item.value || 0;
        else saldos[code].credits += item.value || 0;
      }
    });
  });

  const resultado = Object.entries(saldos).map(([code, v]) => ({
    code, nombre: NOMINA[code],
    saldo: v.credits - v.debits,
    tieneMovimiento: v.debits > 0 || v.credits > 0,
  }));

  const totalContable = resultado.reduce((s, r) => s + (r.tieneMovimiento ? r.saldo : 0), 0);
  const diferencia = pilaData ? Math.abs(totalContable - pilaData.total) : null;
  const pctDif = pilaData && pilaData.total > 0 ? (diferencia / pilaData.total) * 100 : null;

  return { resultado, totalContable, diferencia, pctDif, tienePila: !!pilaData };
}

function analizarM5(journals) {
  const PROVISIONES = {
    "1592": { nombre: "Depreciación acumulada", tipo: "activo", pctMensual: null },
    "2615": { nombre: "Vacaciones", tipo: "pasivo", pctMensual: 4.17 },
    "2610": { nombre: "Prima de servicios", tipo: "pasivo", pctMensual: 8.33 },
    "2620": { nombre: "Cesantías", tipo: "pasivo", pctMensual: 8.33 },
    "2625": { nombre: "Intereses cesantías", tipo: "pasivo", pctMensual: 1.0 },
  };

  const movimientos = {};
  Object.keys(PROVISIONES).forEach(k => { movimientos[k] = { debits: 0, credits: 0, count: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (movimientos[code]) {
        if (item.account?.movement === "Debit") movimientos[code].debits += item.value || 0;
        else movimientos[code].credits += item.value || 0;
        movimientos[code].count++;
      }
    });
  });

  const resultado = Object.entries(PROVISIONES).map(([code, meta]) => ({
    code, ...meta,
    debits: movimientos[code].debits,
    credits: movimientos[code].credits,
    count: movimientos[code].count,
    tieneMovimiento: movimientos[code].count > 0,
    saldo: movimientos[code].credits - movimientos[code].debits,
  }));

  const faltantes = resultado.filter(r => !r.tieneMovimiento);
  const registradas = resultado.filter(r => r.tieneMovimiento);

  return { resultado, faltantes, registradas };
}

// ── COMPONENTES UI ───────────────────────────────────────
function JASLogo() {
  return (
    <svg width="130" height="32" viewBox="0 0 130 36" fill="none">
      <circle cx="8" cy="28" r="5" fill="#F0A030"/>
      <rect x="17" y="16" width="8" height="18" rx="4" fill="#F0A030"/>
      <rect x="29" y="6" width="8" height="28" rx="4" fill="#F5C518"/>
      <text x="42" y="22" fontFamily="'Nunito',sans-serif" fontWeight="700" fontSize="18" fill="#1A1A1A" letterSpacing="2">JAS</text>
      <text x="42" y="32" fontFamily="'Nunito',sans-serif" fontWeight="300" fontSize="7.5" fill="#4A4A4A">Control Contable</text>
    </svg>
  );
}

function Semaforo({ estado }) {
  const cfg = {
    ok: { bg: C.greenBg, color: C.green, border: C.greenBorder, label: "✓ OK" },
    alerta: { bg: C.redBg, color: C.red, border: C.redBorder, label: "⚠ Alerta" },
    revisar: { bg: C.orangeBg, color: C.orange, border: C.orangeBorder, label: "Revisar" },
    cargando: { bg: C.blueBg, color: C.blue, border: C.blueBorder, label: "Cargando..." },
    pendiente: { bg: "#f9fafb", color: C.muted, border: "#e5e7eb", label: "Pendiente" },
  };
  const s = cfg[estado] || cfg.pendiente;
  return <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20 }}>{s.label}</span>;
}

function Card({ children, style }) {
  return <div style={{ background: C.bgCard, border: `1.5px solid ${C.border}`, borderRadius: 12, ...style }}>{children}</div>;
}

function Section({ title, subtitle, estado, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card style={{ marginBottom: 12, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", background: C.bgLight, border: "none", cursor: "pointer", fontFamily: "'Nunito',sans-serif", textAlign: "left" }}>
        <div style={{ display: "flex", align: "center", gap: 10, alignItems: "center" }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.black }}>{title}</span>
            {subtitle && <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{subtitle}</span>}
          </div>
          {estado && <Semaforo estado={estado}/>}
        </div>
        <span style={{ color: C.muted, fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "16px 18px" }}>{children}</div>}
    </Card>
  );
}

function Row({ label, hint, valor, estado, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.black }}>{label}</p>
        {hint && <p style={{ margin: 0, fontSize: 11, color: C.muted }}>{hint}</p>}
        {children}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginTop: 2 }}>
        {valor && <span style={{ fontSize: 12, fontWeight: 700, color: C.gray, fontFamily: "monospace" }}>{valor}</span>}
        {estado && <Semaforo estado={estado}/>}
      </div>
    </div>
  );
}

function AlertBox({ tipo, title, children }) {
  const cfg = {
    red: { bg: C.redBg, border: C.redBorder, color: C.red },
    orange: { bg: C.orangeBg, border: C.orangeBorder, color: C.orange },
    green: { bg: C.greenBg, border: C.greenBorder, color: C.green },
    blue: { bg: C.blueBg, border: C.blueBorder, color: C.blue },
  };
  const s = cfg[tipo] || cfg.blue;
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: "10px 14px", margin: "10px 0 0", fontSize: 12 }}>
      {title && <p style={{ fontWeight: 700, color: s.color, margin: "0 0 4px" }}>{title}</p>}
      <div style={{ color: C.gray }}>{children}</div>
    </div>
  );
}

function inputSt(active) {
  return { padding: "9px 12px", fontSize: 13, border: `1.5px solid ${active ? C.amber : C.border}`, borderRadius: 8, fontFamily: "'Nunito',sans-serif", fontWeight: 300, outline: "none", width: "100%", boxSizing: "border-box", background: C.bgCard };
}

// ── APP PRINCIPAL ────────────────────────────────────────
export default function App() {
  const [creds, setCreds] = useState({ username: "", access_key: "" });
  const [token, setToken] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMsg, setAuthMsg] = useState(null);

  const now = new Date();
  const [periodo, setPeriodo] = useState({
    inicio: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    fin: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, "0")}`,
  });

  const [analizando, setAnalizando] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [resultados, setResultados] = useState(null);
  const [pilaInput, setPilaInput] = useState({ total: "", detalle: "" });

  async function autenticar() {
    if (!creds.username || !creds.access_key) return;
    setAuthLoading(true);
    setAuthMsg(null);
    try {
      const res = await fetch("/api/proxy?endpoint=v1/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: creds.username, access_key: creds.access_key })
      });
      const data = await res.json();
      if (data.access_token) {
        setToken(data.access_token);
        setAuthMsg({ ok: true, text: "✓ Conectado a Siigo. Configura el período y ejecuta el análisis." });
      } else {
        setAuthMsg({ ok: false, text: data.Errors?.[0]?.Message || data.message || JSON.stringify(data) });
      }
    } catch (e) {
      setAuthMsg({ ok: false, text: e.message });
    }
    setAuthLoading(false);
  }

  async function ejecutarAnalisis() {
    if (!token) return;
    setAnalizando(true);
    setResultados(null);

    try {
      setProgreso("Cargando comprobantes contables...");
      const journals = await fetchAll(token, "v1/journals", {
        created_start: periodo.inicio,
        created_end: periodo.fin,
      });

      setProgreso("Cargando facturas de compra...");
      const purchases = await fetchAll(token, "v1/purchases", {
        created_start: periodo.inicio,
        created_end: periodo.fin,
      });

      setProgreso("Cargando facturas de venta...");
      const invoices = await fetchAll(token, "v1/invoices", {
        date_start: periodo.inicio,
        date_end: periodo.fin,
      });

      setProgreso("Cargando recibos de caja...");
      const receipts = await fetchAll(token, "v1/vouchers", {
        created_start: periodo.inicio,
        created_end: periodo.fin,
      });

      setProgreso("Ejecutando módulos de control...");
      const pilaData = pilaInput.total ? { total: parseFloat(pilaInput.total.replace(/[^0-9.]/g, "")) } : null;

      const m1 = analizarM1(journals);
      const m2 = analizarM2(journals);
      const m3 = analizarM3(journals);
      const m4 = analizarM4(journals, pilaData);
      const m5 = analizarM5(journals);

      setResultados({
        journals, purchases, invoices, receipts,
        m1, m2, m3, m4, m5,
        periodo,
        resumen: {
          journals: journals.length,
          purchases: purchases.length,
          invoices: invoices.length,
          receipts: receipts.length,
        }
      });
    } catch (e) {
      setAuthMsg({ ok: false, text: "Error en análisis: " + e.message });
    }

    setProgreso("");
    setAnalizando(false);
  }

  const btnSt = (disabled) => ({
    padding: "10px 24px", fontSize: 13, fontWeight: 700,
    background: disabled ? "#e5e7eb" : C.yellow,
    color: disabled ? C.muted : C.black,
    border: "none", borderRadius: 8, cursor: disabled ? "default" : "pointer",
    fontFamily: "'Nunito',sans-serif", opacity: disabled ? 0.6 : 1,
  });

  const r = resultados;

  return (
    <div style={{ minHeight: "100vh", background: C.bgPage, fontFamily: "'Nunito',sans-serif", fontWeight: 300, padding: "0 1rem 4rem" }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ background: C.bgLight, border: `1px solid ${C.border}`, padding: "12px 20px", borderRadius: "0 0 16px 16px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 2px 12px rgba(245,197,24,0.08)" }}>
          <JASLogo/>
          {token && <span style={{ fontSize: 11, background: C.greenBg, color: C.green, border: `1px solid ${C.greenBorder}`, padding: "3px 10px", borderRadius: 20, fontWeight: 600 }}>● Conectado a Siigo</span>}
        </div>
        <div style={{ height: 3, background: `linear-gradient(90deg,${C.amber},${C.yellow},${C.amber})`, borderRadius: 2, margin: "0 0 20px" }}/>

        {/* Auth */}
        <Section title="Autenticación" subtitle="Credenciales Siigo Nube" defaultOpen={!token}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Usuario API</label>
              <input type="email" value={creds.username} onChange={e => setCreds(c => ({ ...c, username: e.target.value }))} placeholder="usuario@empresa.com" style={inputSt(creds.username)}/>
            </div>
            <div>
              <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Access Key</label>
              <input type="password" value={creds.access_key} onChange={e => setCreds(c => ({ ...c, access_key: e.target.value }))} onKeyDown={e => e.key === "Enter" && autenticar()} style={inputSt(creds.access_key)}/>
            </div>
          </div>
          <button onClick={autenticar} disabled={authLoading || !creds.username || !creds.access_key} style={btnSt(authLoading || !creds.username || !creds.access_key)}>
            {authLoading ? "Conectando..." : "Conectar con Siigo"}
          </button>
          {authMsg && (
            <div style={{ marginTop: 10, padding: "10px 14px", background: authMsg.ok ? C.greenBg : C.redBg, border: `1px solid ${authMsg.ok ? C.greenBorder : C.redBorder}`, borderRadius: 8, fontSize: 12, color: authMsg.ok ? C.green : C.red }}>
              {authMsg.text}
            </div>
          )}
        </Section>

        {token && (
          <>
            {/* Período + Ejecutar */}
            <Card style={{ padding: "16px 18px", marginBottom: 12 }}>
              <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, color: C.amber, marginBottom: 14 }}>Período de análisis</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, alignItems: "end" }}>
                <div>
                  <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Fecha inicio</label>
                  <input type="date" value={periodo.inicio} onChange={e => setPeriodo(p => ({ ...p, inicio: e.target.value }))} style={inputSt(true)}/>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Fecha fin</label>
                  <input type="date" value={periodo.fin} onChange={e => setPeriodo(p => ({ ...p, fin: e.target.value }))} style={inputSt(true)}/>
                </div>
                <button onClick={ejecutarAnalisis} disabled={analizando} style={{ ...btnSt(analizando), width: "100%", padding: "10px 16px" }}>
                  {analizando ? progreso || "Analizando..." : "▶ Ejecutar control"}
                </button>
              </div>

              {/* PILA input */}
              <div style={{ marginTop: 14, padding: "12px 14px", background: C.bgLight, borderRadius: 8, border: `1px solid ${C.border}` }}>
                <p style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>M4 — Total planilla PILA pagada del período (opcional)</p>
                <input type="text" value={pilaInput.total} onChange={e => setPilaInput(p => ({ ...p, total: e.target.value }))} placeholder="Ej: 12480000" style={{ ...inputSt(pilaInput.total), width: 220 }}/>
              </div>
            </Card>

            {/* Resumen de datos cargados */}
            {r && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
                {[
                  ["Comprobantes", r.resumen.journals],
                  ["Fact. compra", r.resumen.purchases],
                  ["Fact. venta", r.resumen.invoices],
                  ["Recibos caja", r.resumen.receipts],
                ].map(([label, val]) => (
                  <div key={label} style={{ background: C.bgLight, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
                    <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.black, fontFamily: "monospace" }}>{val.toLocaleString()}</p>
                    <p style={{ margin: "4px 0 0", fontSize: 11, color: C.muted }}>{label}</p>
                  </div>
                ))}
              </div>
            )}

            {/* M1 */}
            {r && (
              <Section
                title="M1 — Cuentas de balance"
                subtitle="Verificación de cierre"
                estado={r.m1.noZero.length === 0 && r.m1.contrarios.length === 0 ? "ok" : r.m1.contrarios.length > 0 ? "alerta" : "revisar"}
                defaultOpen={r.m1.noZero.length > 0 || r.m1.contrarios.length > 0}
              >
                <Row label="Cuentas analizadas" valor={`${r.m1.total}`} estado="ok"/>
                <Row
                  label="Cuentas de resultado sin cerrar (grupos 4,5,6,7)"
                  hint="Deben estar en cero al cierre del período"
                  valor={`${r.m1.noZero.length} cuentas`}
                  estado={r.m1.noZero.length === 0 ? "ok" : "revisar"}
                >
                  {r.m1.noZero.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {r.m1.noZero.slice(0, 10).map(c => (
                        <div key={c.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ color: C.gray }}>Cta {c.code}</span>
                          <span style={{ color: C.orange, fontFamily: "monospace" }}>{fmt(c.saldo)}</span>
                        </div>
                      ))}
                      {r.m1.noZero.length > 10 && <p style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>...y {r.m1.noZero.length - 10} más</p>}
                    </div>
                  )}
                </Row>
                <Row
                  label="Saldos contrarios a naturaleza"
                  hint="Activos en crédito o pasivos en débito"
                  valor={`${r.m1.contrarios.length} cuentas`}
                  estado={r.m1.contrarios.length === 0 ? "ok" : "alerta"}
                >
                  {r.m1.contrarios.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {r.m1.contrarios.slice(0, 8).map(c => (
                        <div key={c.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ color: C.gray }}>Cta {c.code} (Grupo {c.grupo})</span>
                          <span style={{ color: C.red, fontFamily: "monospace" }}>{fmt(c.saldo)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Row>
                {r.m1.contrarios.length > 0 && (
                  <AlertBox tipo="red" title="Saldos incorrectos detectados">
                    Hay {r.m1.contrarios.length} cuentas con saldo contrario a su naturaleza. Revisar si son errores de codificación o asientos incompletos.
                  </AlertBox>
                )}
                {r.m1.noZero.length === 0 && r.m1.contrarios.length === 0 && (
                  <AlertBox tipo="green" title="Balance en orden">
                    Todas las cuentas de resultado cerraron correctamente y no hay saldos contrarios a la naturaleza.
                  </AlertBox>
                )}
              </Section>
            )}

            {/* M2 */}
            {r && (
              <Section
                title="M2 — Control de impuestos"
                subtitle="ReteFuente, ReteICA, ReteIVA, IVA, ICA"
                estado={r.m2.alertas.length === 0 ? "ok" : "alerta"}
                defaultOpen={r.m2.alertas.length > 0}
              >
                {r.m2.resultado.map(imp => (
                  <Row
                    key={imp.code}
                    label={`Cta ${imp.code} — ${imp.nombre}`}
                    hint={imp.tieneMovimiento ? `Débitos: ${fmt(imp.debits)} · Créditos: ${fmt(imp.credits)}` : "Sin movimiento en el período"}
                    valor={imp.tieneMovimiento ? fmt(imp.saldo) : "—"}
                    estado={!imp.tieneMovimiento ? "pendiente" : imp.saldo >= 0 ? "ok" : "alerta"}
                  />
                ))}
                {r.m2.alertas.length > 0 && (
                  <AlertBox tipo="red" title={`${r.m2.alertas.length} cuenta(s) con saldo negativo`}>
                    {r.m2.alertas.map(a => `Cta ${a.code} (${a.nombre}): ${fmt(a.saldo)}`).join(" · ")}. Verificar si hay retenciones sin contabilizar o notas de crédito pendientes.
                  </AlertBox>
                )}
                {r.m2.alertas.length === 0 && r.m2.resultado.some(r => r.tieneMovimiento) && (
                  <AlertBox tipo="green" title="Impuestos en orden">
                    Todas las cuentas de impuesto tienen saldo positivo. Sin alertas.
                  </AlertBox>
                )}
              </Section>
            )}

            {/* M3 */}
            {r && (
              <Section
                title="M3 — Anticipos vs cuentas por pagar"
                subtitle="Cruces posibles por tercero"
                estado={r.m3.anticiposSolos.length > 0 ? "revisar" : r.m3.neteables.length > 0 ? "ok" : "ok"}
                defaultOpen={r.m3.lista.length > 0}
              >
                <Row label="Terceros con anticipo activo" valor={`${r.m3.lista.length}`} estado={r.m3.lista.length > 0 ? "revisar" : "ok"}/>
                <Row label="Netos posibles (anticipo + CxP mismo tercero)" valor={`${r.m3.neteables.length} terceros`} estado={r.m3.neteables.length > 0 ? "ok" : "pendiente"}/>
                <Row label="Total anticipo neto posible" valor={fmt(r.m3.totalNeto)} estado={r.m3.totalNeto > 0 ? "ok" : "pendiente"}/>

                {r.m3.neteables.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: C.muted, marginBottom: 8 }}>Terceros neteables</p>
                    {r.m3.neteables.slice(0, 10).map(t => (
                      <div key={t.tercero} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                        <span style={{ color: C.gray }}>NIT {t.tercero}</span>
                        <div style={{ display: "flex", gap: 12 }}>
                          <span style={{ color: C.blue }}>Anticipo: {fmt(t.anticipos)}</span>
                          <span style={{ color: C.orange }}>CxP: {fmt(t.cxp)}</span>
                          <span style={{ color: C.green, fontWeight: 700 }}>Neto: {fmt(Math.min(t.anticipos, t.cxp))}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {r.m3.anticiposSolos.length > 0 && (
                  <AlertBox tipo="orange" title={`${r.m3.anticiposSolos.length} anticipos sin CxP correspondiente`}>
                    Estos terceros tienen anticipo pero no tienen cuenta por pagar registrada. Verificar si hay entrega pendiente o si el anticipo debe reintegrarse.
                  </AlertBox>
                )}
                {r.m3.lista.length === 0 && (
                  <AlertBox tipo="green" title="Sin anticipos pendientes">Sin anticipos activos en el período analizado.</AlertBox>
                )}
              </Section>
            )}

            {/* M4 */}
            {r && (
              <Section
                title="M4 — Nómina y planilla PILA"
                subtitle="Causación vs planilla pagada"
                estado={!r.m4.tienePila ? "pendiente" : r.m4.pctDif < 1 ? "ok" : "alerta"}
                defaultOpen={true}
              >
                {r.m4.resultado.map(nr => (
                  <Row
                    key={nr.code}
                    label={`Cta ${nr.code} — ${nr.nombre}`}
                    hint={nr.tieneMovimiento ? `Saldo causado en el período` : "Sin movimiento"}
                    valor={nr.tieneMovimiento ? fmt(nr.saldo) : "—"}
                    estado={nr.tieneMovimiento ? "ok" : "pendiente"}
                  />
                ))}
                <Row
                  label="Total causado en contabilidad"
                  valor={fmt(r.m4.totalContable)}
                  estado={r.m4.totalContable > 0 ? "ok" : "pendiente"}
                />
                {!r.m4.tienePila ? (
                  <AlertBox tipo="blue" title="Ingresa el total de la planilla PILA">
                    Para hacer el cruce completo, ingresa el valor total de la planilla PILA pagada en el campo de arriba y ejecuta el análisis nuevamente.
                  </AlertBox>
                ) : (
                  <>
                    <Row label="Total planilla PILA ingresada" valor={fmt(pilaInput.total)} estado="ok"/>
                    <Row
                      label="Diferencia PILA vs contabilidad"
                      valor={fmt(r.m4.diferencia)}
                      estado={r.m4.pctDif < 1 ? "ok" : "alerta"}
                    />
                    {r.m4.pctDif >= 1 ? (
                      <AlertBox tipo="red" title={`Diferencia del ${r.m4.pctDif?.toFixed(2)}%`}>
                        La diferencia supera el 1%. Verificar si hay empleados no incluidos en la planilla o causaciones incorrectas.
                      </AlertBox>
                    ) : (
                      <AlertBox tipo="green" title="Planilla PILA cuadra">La diferencia es menor al 1%. Nómina en orden.</AlertBox>
                    )}
                  </>
                )}
              </Section>
            )}

            {/* M5 */}
            {r && (
              <Section
                title="M5 — Provisiones"
                subtitle="Depreciación, vacaciones, prima, cesantías"
                estado={r.m5.faltantes.length === 0 ? "ok" : r.m5.faltantes.length >= 3 ? "alerta" : "revisar"}
                defaultOpen={r.m5.faltantes.length > 0}
              >
                {r.m5.resultado.map(p => (
                  <Row
                    key={p.code}
                    label={`Cta ${p.code} — ${p.nombre}`}
                    hint={p.tieneMovimiento
                      ? `${p.count} movimiento(s) · Débitos: ${fmt(p.debits)} · Créditos: ${fmt(p.credits)}`
                      : "Sin movimiento en el período"}
                    valor={p.tieneMovimiento ? fmt(p.saldo) : "—"}
                    estado={p.tieneMovimiento ? "ok" : "alerta"}
                  />
                ))}
                {r.m5.faltantes.length > 0 && (
                  <AlertBox tipo="red" title={`${r.m5.faltantes.length} provisión(es) sin registrar`}>
                    {r.m5.faltantes.map(f => `Cta ${f.code} — ${f.nombre}`).join(", ")}. Registrar antes de cerrar el período.
                  </AlertBox>
                )}
                {r.m5.faltantes.length === 0 && (
                  <AlertBox tipo="green" title="Todas las provisiones registradas">
                    Depreciación, vacaciones, prima, cesantías e intereses tienen movimiento en el período.
                  </AlertBox>
                )}
              </Section>
            )}

            {/* Resumen ejecutivo */}
            {r && (
              <Card style={{ padding: "16px 18px", marginTop: 8 }}>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, color: C.amber, marginBottom: 14 }}>Resumen ejecutivo del período</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    ["M1 Balance", r.m1.noZero.length === 0 && r.m1.contrarios.length === 0 ? "ok" : r.m1.contrarios.length > 0 ? "alerta" : "revisar"],
                    ["M2 Impuestos", r.m2.alertas.length === 0 ? "ok" : "alerta"],
                    ["M3 Anticipos", r.m3.anticiposSolos.length > 0 ? "revisar" : "ok"],
                    ["M4 PILA", !r.m4.tienePila ? "pendiente" : r.m4.pctDif < 1 ? "ok" : "alerta"],
                    ["M5 Provisiones", r.m5.faltantes.length === 0 ? "ok" : r.m5.faltantes.length >= 3 ? "alerta" : "revisar"],
                  ].map(([label, estado]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: C.bgLight, borderRadius: 8, border: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.black }}>{label}</span>
                      <Semaforo estado={estado}/>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}

        {!token && !authMsg && (
          <div style={{ textAlign: "center", padding: "3rem", color: C.muted, fontSize: 13 }}>
            Ingresa tus credenciales arriba para conectarte a Siigo y ejecutar el control contable.
          </div>
        )}
      </div>
    </div>
  );
}
