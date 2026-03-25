import { useState } from "react";

const C = {
  yellow: "#F5C518", amber: "#F0A030", darkAmber: "#E8901A",
  black: "#1A1A1A", gray: "#4A4A4A", muted: "#8A8A8A",
  border: "#F0E4B8", bgLight: "#FFFBF0", bgCard: "#FFFFFF", bgPage: "#F7F5F0",
  green: "#16a34a", greenBg: "#f0fdf4", greenBorder: "#bbf7d0",
  red: "#dc2626", redBg: "#fef2f2", redBorder: "#fecaca",
  orange: "#F97316", orangeBg: "#fff7ed", orangeBorder: "#fed7aa",
  blue: "#2563eb", blueBg: "#eff6ff", blueBorder: "#bfdbfe",
};

// ── EXACTAMENTE IGUAL AL SIIGO-EXPLORER QUE FUNCIONA ────
async function siigo(method, path, token, body, params) {
  const p = new URLSearchParams({ endpoint: path, ...(params || {}) }).toString();
  const url = `/api/proxy?${p}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Trae todos los registros del rango de fechas paginando automáticamente
async function fetchAll(token, path, params) {
  let all = [], page = 1, total = 1;
  while (all.length < total) {
    const r = await siigo("GET", path, token, null, { ...params, page, page_size: 100 });
    const results = r.data?.results || [];
    total = r.data?.pagination?.total_results || results.length;
    all = [...all, ...results];
    if (results.length < 100) break;
    page++;
  }
  return all;
}

// ── ANÁLISIS M1 — CUENTAS DE BALANCE ───────────────────
function analizarM1(journals) {
  const saldos = {};
  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code || "";
      if (!code) return;
      if (!saldos[code]) saldos[code] = { code, grupo: code[0], debits: 0, credits: 0 };
      if (item.account?.movement === "Debit") saldos[code].debits += item.value || 0;
      else saldos[code].credits += item.value || 0;
    });
  });

  const cuentas = Object.values(saldos).map(c => ({ ...c, saldo: c.debits - c.credits }));
  const resultado = cuentas.filter(c => ["4","5","6","7"].includes(c.grupo));
  const noZero = resultado.filter(c => Math.abs(c.saldo) > 100);
  const activos = cuentas.filter(c => c.grupo === "1" && c.saldo < -100);
  const pasivos = cuentas.filter(c => ["2","3"].includes(c.grupo) && c.saldo > 100);
  const contrarios = [...activos, ...pasivos];
  return { total: cuentas.length, noZero, contrarios };
}

// ── ANÁLISIS M2 — IMPUESTOS ─────────────────────────────
function analizarM2(journals) {
  const CTAS = {
    "2365": "ReteFuente por pagar",
    "2367": "ReteICA por pagar",
    "2368": "ReteIVA por pagar",
    "2408": "IVA por pagar",
    "2404": "ICA por pagar",
  };
  const saldos = {};
  Object.keys(CTAS).forEach(k => { saldos[k] = { debits: 0, credits: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (saldos[code]) {
        if (item.account?.movement === "Debit") saldos[code].debits += item.value || 0;
        else saldos[code].credits += item.value || 0;
      }
    });
  });

  const resultado = Object.entries(CTAS).map(([code, nombre]) => ({
    code, nombre,
    saldo: saldos[code].credits - saldos[code].debits,
    tieneMovimiento: saldos[code].debits > 0 || saldos[code].credits > 0,
  }));
  const alertas = resultado.filter(r => r.tieneMovimiento && r.saldo < 0);
  return { resultado, alertas };
}

// ── ANÁLISIS M3 — ANTICIPOS VS CXP ─────────────────────
function analizarM3(journals) {
  const ANTICIPOS = ["1330", "1120"];
  const CXP = ["2205", "2335", "2206"];
  const porTercero = {};

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      const tercero = item.customer?.identification || item.supplier?.identification || null;
      if (!tercero) return;
      const val = item.value || 0;
      const esAnticipo = ANTICIPOS.includes(code);
      const esCxp = CXP.includes(code);
      if (!esAnticipo && !esCxp) return;
      if (!porTercero[tercero]) porTercero[tercero] = { tercero, anticipos: 0, cxp: 0 };
      if (esAnticipo) porTercero[tercero].anticipos += item.account?.movement === "Debit" ? val : -val;
      if (esCxp) porTercero[tercero].cxp += item.account?.movement === "Credit" ? val : -val;
    });
  });

  const lista = Object.values(porTercero).filter(t => t.anticipos > 100 || t.cxp > 100);
  const neteables = lista.filter(t => t.anticipos > 100 && t.cxp > 100);
  const solos = lista.filter(t => t.anticipos > 100 && t.cxp <= 100);
  const totalNeto = neteables.reduce((s, t) => s + Math.min(t.anticipos, t.cxp), 0);
  return { lista, neteables, solos, totalNeto };
}

// ── ANÁLISIS M4 — NÓMINA / PILA ────────────────────────
function analizarM4(journals, totalPila) {
  const CTAS = {
    "2370": "Nómina por pagar",
    "2380": "Cesantías",
    "2610": "Prestaciones",
    "2620": "Pensiones",
    "2630": "Seguridad social",
  };
  const saldos = {};
  Object.keys(CTAS).forEach(k => { saldos[k] = { debits: 0, credits: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (saldos[code]) {
        if (item.account?.movement === "Debit") saldos[code].debits += item.value || 0;
        else saldos[code].credits += item.value || 0;
      }
    });
  });

  const resultado = Object.entries(CTAS).map(([code, nombre]) => ({
    code, nombre,
    saldo: saldos[code].credits - saldos[code].debits,
    tieneMovimiento: saldos[code].debits > 0 || saldos[code].credits > 0,
  }));

  const totalContable = resultado.reduce((s, r) => s + (r.tieneMovimiento ? Math.max(r.saldo, 0) : 0), 0);
  const diferencia = totalPila ? Math.abs(totalContable - totalPila) : null;
  const pctDif = totalPila && totalPila > 0 ? (diferencia / totalPila) * 100 : null;
  return { resultado, totalContable, diferencia, pctDif, tienePila: !!totalPila };
}

// ── ANÁLISIS M5 — PROVISIONES ──────────────────────────
function analizarM5(journals) {
  const CTAS = {
    "1592": "Depreciación acumulada",
    "2615": "Vacaciones",
    "2610": "Prima de servicios",
    "2620": "Cesantías",
    "2625": "Intereses cesantías",
  };
  const movs = {};
  Object.keys(CTAS).forEach(k => { movs[k] = { debits: 0, credits: 0, count: 0 }; });

  journals.forEach(j => {
    (j.items || []).forEach(item => {
      const code = item.account?.code?.slice(0, 4) || "";
      if (movs[code]) {
        if (item.account?.movement === "Debit") movs[code].debits += item.value || 0;
        else movs[code].credits += item.value || 0;
        movs[code].count++;
      }
    });
  });

  const resultado = Object.entries(CTAS).map(([code, nombre]) => ({
    code, nombre,
    saldo: movs[code].credits - movs[code].debits,
    tieneMovimiento: movs[code].count > 0,
  }));
  const faltantes = resultado.filter(r => !r.tieneMovimiento);
  return { resultado, faltantes };
}

// ── HELPERS UI ──────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(Math.abs(n || 0));
}

function JASLogo() {
  return (
    <svg width="140" height="32" viewBox="0 0 140 36" fill="none">
      <circle cx="8" cy="28" r="5" fill="#F0A030"/>
      <rect x="17" y="16" width="8" height="18" rx="4" fill="#F0A030"/>
      <rect x="29" y="6" width="8" height="28" rx="4" fill="#F5C518"/>
      <text x="42" y="22" fontFamily="'Nunito',sans-serif" fontWeight="700" fontSize="18" fill="#1A1A1A" letterSpacing="2">JAS</text>
      <text x="42" y="32" fontFamily="'Nunito',sans-serif" fontWeight="300" fontSize="8" fill="#4A4A4A">Control Contable</text>
    </svg>
  );
}

function Pill({ estado }) {
  const cfg = {
    ok:       { bg: C.greenBg,  color: C.green,  border: C.greenBorder,  label: "✓ OK" },
    alerta:   { bg: C.redBg,    color: C.red,    border: C.redBorder,    label: "⚠ Alerta" },
    revisar:  { bg: C.orangeBg, color: C.orange, border: C.orangeBorder, label: "Revisar" },
    pendiente:{ bg: "#f9fafb",  color: C.muted,  border: "#e5e7eb",      label: "Pendiente" },
  };
  const s = cfg[estado] || cfg.pendiente;
  return <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20 }}>{s.label}</span>;
}

function Module({ title, subtitle, estado, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 18px", background: C.bgLight, border: "none", cursor: "pointer", fontFamily: "'Nunito',sans-serif", textAlign: "left" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.black }}>{title}</span>
          {subtitle && <span style={{ fontSize: 12, color: C.muted }}>{subtitle}</span>}
          {estado && <Pill estado={estado}/>}
        </div>
        <span style={{ color: C.muted, fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "14px 18px", background: C.bgCard }}>{children}</div>}
    </div>
  );
}

function CheckRow({ label, hint, valor, estado }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
      <div>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.black }}>{label}</p>
        {hint && <p style={{ margin: 0, fontSize: 11, color: C.muted, marginTop: 2 }}>{hint}</p>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {valor && <span style={{ fontSize: 12, fontFamily: "monospace", color: C.gray }}>{valor}</span>}
        {estado && <Pill estado={estado}/>}
      </div>
    </div>
  );
}

function Alerta({ tipo, title, children }) {
  const cfg = {
    red:    { bg: C.redBg,    border: C.redBorder,    tc: C.red    },
    orange: { bg: C.orangeBg, border: C.orangeBorder, tc: C.orange },
    green:  { bg: C.greenBg,  border: C.greenBorder,  tc: C.green  },
    blue:   { bg: C.blueBg,   border: C.blueBorder,   tc: C.blue   },
  };
  const s = cfg[tipo] || cfg.blue;
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: "10px 14px", marginTop: 12, fontSize: 12 }}>
      {title && <p style={{ fontWeight: 700, color: s.tc, margin: "0 0 4px" }}>{title}</p>}
      <span style={{ color: C.gray }}>{children}</span>
    </div>
  );
}

const inputSt = { padding: "9px 12px", fontSize: 13, border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: "'Nunito',sans-serif", fontWeight: 300, outline: "none", width: "100%", boxSizing: "border-box" };

// ── APP ─────────────────────────────────────────────────
export default function App() {
  const [creds, setCreds] = useState({ username: "", access_key: "" });
  const [token, setToken] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMsg, setAuthMsg] = useState(null);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();

  const [fechas, setFechas] = useState({
    inicio: `${y}-${m}-01`,
    fin: `${y}-${m}-${String(lastDay).padStart(2, "0")}`,
  });

  const [pilaTotal, setPilaTotal] = useState("");
  const [analizando, setAnalizando] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [res, setRes] = useState(null);

  // AUTENTICACIÓN — mismo patrón que siigo-explorer
  async function autenticar() {
    if (!creds.username || !creds.access_key) return;
    setAuthLoading(true);
    setAuthMsg(null);
    try {
      const r = await siigo("POST", "auth", null, {
        username: creds.username,
        access_key: creds.access_key,
      });
      if (r.data?.access_token) {
        setToken(r.data.access_token);
        setAuthMsg({ ok: true, text: "✓ Conexión exitosa. Token válido por 24 horas." });
      } else {
        const msg = r.data?.Errors?.[0]?.Message || r.data?.message || r.data?.error || JSON.stringify(r.data);
        setAuthMsg({ ok: false, text: msg });
      }
    } catch (e) {
      setAuthMsg({ ok: false, text: e.message });
    }
    setAuthLoading(false);
  }

  // ANÁLISIS COMPLETO
  async function ejecutar() {
    if (!token) return;
    setAnalizando(true);
    setRes(null);
    try {
      setProgreso("Cargando comprobantes de diario...");
      const journals = await fetchAll(token, "v1/journals", {
        created_start: fechas.inicio,
        created_end: fechas.fin,
      });

      setProgreso("Cargando facturas de compra...");
      const purchases = await fetchAll(token, "v1/purchases", {
        created_start: fechas.inicio,
        created_end: fechas.fin,
      });

      setProgreso("Cargando facturas de venta...");
      const invoices = await fetchAll(token, "v1/invoices", {
        date_start: fechas.inicio,
        date_end: fechas.fin,
      });

      setProgreso("Cargando recibos de caja...");
      const receipts = await fetchAll(token, "v1/vouchers", {
        created_start: fechas.inicio,
        created_end: fechas.fin,
      });

      setProgreso("Ejecutando módulos M1–M5...");
      const pilaNum = pilaTotal ? parseFloat(pilaTotal.replace(/[^0-9.]/g, "")) : null;

      setRes({
        counts: { journals: journals.length, purchases: purchases.length, invoices: invoices.length, receipts: receipts.length },
        m1: analizarM1(journals),
        m2: analizarM2(journals),
        m3: analizarM3(journals),
        m4: analizarM4(journals, pilaNum),
        m5: analizarM5(journals),
      });
    } catch (e) {
      setAuthMsg({ ok: false, text: "Error: " + e.message });
    }
    setProgreso("");
    setAnalizando(false);
  }

  const btnSt = (dis) => ({
    padding: "10px 24px", fontSize: 13, fontWeight: 700,
    background: dis ? "#e5e7eb" : C.yellow,
    color: dis ? C.muted : C.black,
    border: "none", borderRadius: 8, cursor: dis ? "default" : "pointer",
    fontFamily: "'Nunito',sans-serif", opacity: dis ? 0.6 : 1,
  });

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
        <Module title="Autenticación" subtitle="Credenciales Siigo Nube" defaultOpen={!token}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Usuario API</label>
              <input type="email" value={creds.username} onChange={e => setCreds(c => ({ ...c, username: e.target.value }))} placeholder="usuario@empresa.com" style={inputSt}/>
            </div>
            <div>
              <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Access Key</label>
              <input type="password" value={creds.access_key} onChange={e => setCreds(c => ({ ...c, access_key: e.target.value }))} onKeyDown={e => e.key === "Enter" && autenticar()} style={inputSt}/>
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
        </Module>

        {token && (
          <>
            {/* Período */}
            <div style={{ background: C.bgCard, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", marginBottom: 12 }}>
              <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, color: C.amber, marginBottom: 14 }}>Período de análisis</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Fecha inicio</label>
                  <input type="date" value={fechas.inicio} onChange={e => setFechas(f => ({ ...f, inicio: e.target.value }))} style={inputSt}/>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>Fecha fin</label>
                  <input type="date" value={fechas.fin} onChange={e => setFechas(f => ({ ...f, fin: e.target.value }))} style={inputSt}/>
                </div>
              </div>
              <div style={{ background: C.bgLight, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
                <label style={{ fontSize: 11, color: C.muted, display: "block", marginBottom: 4 }}>M4 — Total planilla PILA pagada del período (opcional)</label>
                <input type="text" value={pilaTotal} onChange={e => setPilaTotal(e.target.value)} placeholder="Ej: 12480000" style={{ ...inputSt, width: 220 }}/>
              </div>
              <button onClick={ejecutar} disabled={analizando} style={{ ...btnSt(analizando), width: "100%" }}>
                {analizando ? (progreso || "Analizando...") : "▶ Ejecutar control M1–M5"}
              </button>
            </div>

            {/* Resumen de datos */}
            {res && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
                {[
                  ["Comprobantes", res.counts.journals],
                  ["Fact. compra", res.counts.purchases],
                  ["Fact. venta", res.counts.invoices],
                  ["Recibos caja", res.counts.receipts],
                ].map(([label, val]) => (
                  <div key={label} style={{ background: C.bgLight, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
                    <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.black, fontFamily: "monospace" }}>{val.toLocaleString()}</p>
                    <p style={{ margin: "4px 0 0", fontSize: 11, color: C.muted }}>{label}</p>
                  </div>
                ))}
              </div>
            )}

            {/* M1 */}
            {res && (
              <Module
                title="M1 — Cuentas de balance"
                subtitle="Cierre de cuentas de resultado"
                estado={res.m1.contrarios.length > 0 ? "alerta" : res.m1.noZero.length > 0 ? "revisar" : "ok"}
                defaultOpen={res.m1.noZero.length > 0 || res.m1.contrarios.length > 0}
              >
                <CheckRow label="Cuentas analizadas" valor={String(res.m1.total)} estado="ok"/>
                <CheckRow
                  label="Cuentas de resultado sin cerrar (grupos 4, 5, 6, 7)"
                  hint="Deben estar en cero al cierre del período"
                  valor={`${res.m1.noZero.length} cuentas`}
                  estado={res.m1.noZero.length === 0 ? "ok" : "revisar"}
                />
                {res.m1.noZero.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {res.m1.noZero.slice(0, 10).map(c => (
                      <div key={c.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ color: C.gray }}>Cta {c.code} (grupo {c.grupo})</span>
                        <span style={{ color: C.orange, fontFamily: "monospace" }}>{fmt(c.saldo)}</span>
                      </div>
                    ))}
                    {res.m1.noZero.length > 10 && <p style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>...y {res.m1.noZero.length - 10} cuentas más</p>}
                  </div>
                )}
                <CheckRow
                  label="Saldos contrarios a naturaleza"
                  hint="Activos con saldo crédito · Pasivos con saldo débito"
                  valor={`${res.m1.contrarios.length} cuentas`}
                  estado={res.m1.contrarios.length === 0 ? "ok" : "alerta"}
                />
                {res.m1.contrarios.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {res.m1.contrarios.slice(0, 8).map(c => (
                      <div key={c.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ color: C.gray }}>Cta {c.code} (grupo {c.grupo})</span>
                        <span style={{ color: C.red, fontFamily: "monospace" }}>{fmt(c.saldo)}</span>
                      </div>
                    ))}
                    <Alerta tipo="red" title="Saldos incorrectos">
                      Hay {res.m1.contrarios.length} cuenta(s) con saldo contrario a su naturaleza. Verificar si son errores de codificación o asientos incompletos.
                    </Alerta>
                  </div>
                )}
                {res.m1.noZero.length === 0 && res.m1.contrarios.length === 0 && (
                  <Alerta tipo="green" title="Balance en orden">Todas las cuentas de resultado cerraron correctamente. Sin saldos contrarios a la naturaleza.</Alerta>
                )}
              </Module>
            )}

            {/* M2 */}
            {res && (
              <Module
                title="M2 — Control de impuestos"
                subtitle="ReteFuente · ReteICA · ReteIVA · IVA · ICA"
                estado={res.m2.alertas.length === 0 ? "ok" : "alerta"}
                defaultOpen={res.m2.alertas.length > 0}
              >
                {res.m2.resultado.map(imp => (
                  <CheckRow
                    key={imp.code}
                    label={`Cta ${imp.code} — ${imp.nombre}`}
                    hint={imp.tieneMovimiento ? "Con movimiento en el período" : "Sin movimiento en el período"}
                    valor={imp.tieneMovimiento ? fmt(imp.saldo) : "—"}
                    estado={!imp.tieneMovimiento ? "pendiente" : imp.saldo >= 0 ? "ok" : "alerta"}
                  />
                ))}
                {res.m2.alertas.length > 0 ? (
                  <Alerta tipo="red" title={`${res.m2.alertas.length} cuenta(s) con saldo negativo`}>
                    {res.m2.alertas.map(a => `Cta ${a.code} (${a.nombre}): ${fmt(a.saldo)}`).join(" · ")}. Verificar retenciones sin contabilizar o notas de crédito pendientes.
                  </Alerta>
                ) : (
                  <Alerta tipo="green" title="Impuestos en orden">Todas las cuentas de impuesto con saldo positivo. Sin alertas.</Alerta>
                )}
              </Module>
            )}

            {/* M3 */}
            {res && (
              <Module
                title="M3 — Anticipos vs cuentas por pagar"
                subtitle="Cruces posibles por tercero"
                estado={res.m3.solos.length > 0 ? "revisar" : res.m3.neteables.length > 0 ? "ok" : "ok"}
                defaultOpen={res.m3.lista.length > 0}
              >
                <CheckRow label="Terceros con anticipo activo" valor={String(res.m3.lista.length)} estado={res.m3.lista.length > 0 ? "revisar" : "ok"}/>
                <CheckRow label="Netos posibles (anticipo + CxP mismo tercero)" valor={`${res.m3.neteables.length} terceros`} estado={res.m3.neteables.length > 0 ? "ok" : "pendiente"}/>
                <CheckRow label="Total neto posible" valor={fmt(res.m3.totalNeto)} estado={res.m3.totalNeto > 0 ? "ok" : "pendiente"}/>
                {res.m3.neteables.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: C.muted, marginBottom: 8 }}>Terceros neteables</p>
                    {res.m3.neteables.slice(0, 10).map(t => (
                      <div key={t.tercero} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                        <span style={{ color: C.gray }}>NIT {t.tercero}</span>
                        <div style={{ display: "flex", gap: 14 }}>
                          <span style={{ color: C.blue }}>Anticipo: {fmt(t.anticipos)}</span>
                          <span style={{ color: C.orange }}>CxP: {fmt(t.cxp)}</span>
                          <span style={{ color: C.green, fontWeight: 700 }}>Neto: {fmt(Math.min(t.anticipos, t.cxp))}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {res.m3.solos.length > 0 && (
                  <Alerta tipo="orange" title={`${res.m3.solos.length} anticipos sin CxP correspondiente`}>
                    Estos terceros tienen anticipo pero no CxP registrada. Verificar si hay entrega pendiente o si el anticipo debe reintegrarse.
                  </Alerta>
                )}
                {res.m3.lista.length === 0 && (
                  <Alerta tipo="green" title="Sin anticipos pendientes">Sin anticipos activos en el período analizado.</Alerta>
                )}
              </Module>
            )}

            {/* M4 */}
            {res && (
              <Module
                title="M4 — Nómina y planilla PILA"
                subtitle="Causación vs planilla pagada"
                estado={!res.m4.tienePila ? "pendiente" : res.m4.pctDif < 1 ? "ok" : "alerta"}
                defaultOpen={true}
              >
                {res.m4.resultado.map(nr => (
                  <CheckRow
                    key={nr.code}
                    label={`Cta ${nr.code} — ${nr.nombre}`}
                    hint={nr.tieneMovimiento ? "Con movimiento en el período" : "Sin movimiento"}
                    valor={nr.tieneMovimiento ? fmt(nr.saldo) : "—"}
                    estado={nr.tieneMovimiento ? "ok" : "pendiente"}
                  />
                ))}
                <CheckRow label="Total causado en contabilidad" valor={fmt(res.m4.totalContable)} estado={res.m4.totalContable > 0 ? "ok" : "pendiente"}/>
                {!res.m4.tienePila ? (
                  <Alerta tipo="blue" title="Ingresa el total PILA para hacer el cruce">
                    Escribe el valor total de la planilla PILA pagada en el campo de arriba y ejecuta el análisis nuevamente.
                  </Alerta>
                ) : (
                  <>
                    <CheckRow label="Total planilla PILA" valor={fmt(parseFloat(pilaTotal))} estado="ok"/>
                    <CheckRow label="Diferencia" valor={fmt(res.m4.diferencia)} estado={res.m4.pctDif < 1 ? "ok" : "alerta"}/>
                    {res.m4.pctDif >= 1 ? (
                      <Alerta tipo="red" title={`Diferencia del ${res.m4.pctDif?.toFixed(2)}%`}>
                        La diferencia supera el 1%. Verificar empleados no incluidos en la planilla o causaciones incorrectas.
                      </Alerta>
                    ) : (
                      <Alerta tipo="green" title="Planilla PILA cuadra">Diferencia menor al 1%. Nómina en orden.</Alerta>
                    )}
                  </>
                )}
              </Module>
            )}

            {/* M5 */}
            {res && (
              <Module
                title="M5 — Provisiones"
                subtitle="Depreciación · Vacaciones · Prima · Cesantías"
                estado={res.m5.faltantes.length === 0 ? "ok" : res.m5.faltantes.length >= 3 ? "alerta" : "revisar"}
                defaultOpen={res.m5.faltantes.length > 0}
              >
                {res.m5.resultado.map(p => (
                  <CheckRow
                    key={p.code}
                    label={`Cta ${p.code} — ${p.nombre}`}
                    hint={p.tieneMovimiento ? "Registrada en el período" : "Sin movimiento en el período"}
                    valor={p.tieneMovimiento ? fmt(p.saldo) : "—"}
                    estado={p.tieneMovimiento ? "ok" : "alerta"}
                  />
                ))}
                {res.m5.faltantes.length > 0 ? (
                  <Alerta tipo="red" title={`${res.m5.faltantes.length} provisión(es) sin registrar`}>
                    {res.m5.faltantes.map(f => `${f.nombre} (Cta ${f.code})`).join(" · ")}. Registrar antes de cerrar el período.
                  </Alerta>
                ) : (
                  <Alerta tipo="green" title="Todas las provisiones registradas">
                    Depreciación, vacaciones, prima, cesantías e intereses tienen movimiento en el período.
                  </Alerta>
                )}
              </Module>
            )}

            {/* Resumen ejecutivo */}
            {res && (
              <div style={{ background: C.bgCard, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", marginTop: 8 }}>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, color: C.amber, marginBottom: 14 }}>Resumen ejecutivo</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    ["M1 — Balance", res.m1.contrarios.length > 0 ? "alerta" : res.m1.noZero.length > 0 ? "revisar" : "ok"],
                    ["M2 — Impuestos", res.m2.alertas.length === 0 ? "ok" : "alerta"],
                    ["M3 — Anticipos", res.m3.solos.length > 0 ? "revisar" : "ok"],
                    ["M4 — PILA", !res.m4.tienePila ? "pendiente" : res.m4.pctDif < 1 ? "ok" : "alerta"],
                    ["M5 — Provisiones", res.m5.faltantes.length === 0 ? "ok" : res.m5.faltantes.length >= 3 ? "alerta" : "revisar"],
                  ].map(([label, estado]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: C.bgLight, borderRadius: 8, border: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.black }}>{label}</span>
                      <Pill estado={estado}/>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {!token && (
          <p style={{ textAlign: "center", padding: "3rem", color: C.muted, fontSize: 13 }}>
            Ingresa tus credenciales arriba para conectarte a Siigo y ejecutar el control contable.
          </p>
        )}
      </div>
    </div>
  );
}
