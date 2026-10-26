"use client";

import React, { useState } from "react";
import { ChevronRight } from "lucide-react";

import { riskColor as riskColorOf, riskInk } from "@/lib/theme";
import { CON_PAGO, PERDIDA, idDe, idRec } from "@/lib/resultadoCobros";

const LIMITE_GESTIONES = 200;

// Jerarquía de COBROS: barrio > plan > gestor > gestiones. Cada nivel baja un paso
// con un clic; la ruta de arriba sube. Del último nivel se salta al historial del NIC.
export default function JerarquiaCobros({ A, st, dim, dayLabel, onFilterChange, onSelectNic, P, V }) {
  const [q, setQ] = useState("");
  const [orden, setOrden] = useState({ col: "tot", asc: false });
  const [tec, setTec] = useState(null);

  const num = (v) => Math.round(v).toLocaleString("es-CO");
  const pct = (v) => v.toFixed(1).replace(".", ",") + "%";
  const nombreDe = (g) => g.replace(/\s*-\s*\d+\s*$/, "").trim();

  const bsel = st.jerBarrio;
  const gsel = st.jerBrig;
  const barrioName = (b) => dim.barrios[b].split(" | ")[1];
  const barrioMuni = (b) => dim.barrios[b].split(" | ")[0];

  const vfId = idDe(dim, PERDIDA);
  const pagoIds = new Set([idRec(dim, CON_PAGO)].filter((i) => i >= 0));
  const I = A.IDX || [];

  const subir = (barrio, plan) => {
    onFilterChange("jerBarrio", barrio);
    onFilterChange("jerBrig", plan);
    setTec(null);
  };

  const crumb = (
    <div className="jer-crumb">
      <button className={`jc ${bsel == null ? "on" : ""}`} onClick={() => subir(null, null)}>
        Todos los barrios
      </button>
      {bsel != null && (
        <>
          <span className="jc-sep" aria-hidden="true"><ChevronRight size={12} strokeWidth={2.2} /></span>
          <button className={`jc ${gsel == null ? "on" : ""}`} onClick={() => subir(bsel, null)}>
            {barrioName(bsel)}
          </button>
        </>
      )}
      {gsel != null && (
        <>
          <span className="jc-sep" aria-hidden="true"><ChevronRight size={12} strokeWidth={2.2} /></span>
          <button className={`jc ${tec == null ? "on" : ""}`} onClick={() => setTec(null)}>
            {dim.brigs[gsel]}
          </button>
        </>
      )}
      {tec != null && (
        <>
          <span className="jc-sep" aria-hidden="true"><ChevronRight size={12} strokeWidth={2.2} /></span>
          <button className="jc on" disabled>{nombreDe(dim.tecs[tec])}</button>
        </>
      )}
    </div>
  );

  const th = (col, texto, numerica = true) => (
    <th
      className={numerica ? "num" : ""}
      style={{ cursor: "pointer", whiteSpace: "nowrap" }}
      onClick={() => setOrden((o) => ({ col, asc: o.col === col ? !o.asc : false }))}
    >
      {texto}
      {orden.col === col ? (orden.asc ? " ↑" : " ↓") : ""}
    </th>
  );
  const ordenar = (filas) =>
    filas.sort((x, y) => {
      const a = x[orden.col];
      const c = typeof a === "string" ? a.localeCompare(y[orden.col], "es") : a - y[orden.col];
      return orden.asc ? c : -c;
    });

  let cuerpo;

  if (bsel == null) {
    // Nivel 1: barrios
    const conPago = new Map();
    for (let j = 0; j < I.length; j++) {
      const i = I[j];
      if (pagoIds.has(st.RG_RAW[i])) conPago.set(st.B_raw[i], (conPago.get(st.B_raw[i]) || 0) + 1);
    }
    const buscado = q.trim().toLowerCase();
    const filas = ordenar(
      [...A.barrio.entries()]
        .filter(([b, o]) => o.tot >= st.minOrders && (!buscado || dim.barrios[b].toLowerCase().includes(buscado)))
        .map(([b, o]) => ({
          b,
          o,
          barrio: barrioName(b),
          muni: barrioMuni(b),
          tot: o.tot,
          efPct: o.efPct,
          pe: o.pe,
          pctPago: o.tot ? ((conPago.get(b) || 0) / o.tot) * 100 : 0,
          gestores: o.tec.size,
          planes: o.brig.size,
          risk: o.risk ?? -1,
        }))
    );
    cuerpo = (
      <>
        <div className="mc-h">
          <input className="cc-q" placeholder="Buscar barrio…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="mc-t">{num(filas.length)} barrios</span>
        </div>
        <table className="mt rk">
          <thead>
            <tr>
              {th("barrio", "Barrio", false)}
              {th("muni", "Municipio", false)}
              {th("tot", V.ordenes || "Gestiones")}
              {th("efPct", "Efect.")}
              {th("pe", "Perdidas")}
              {th("pctPago", "% con pago")}
              {th("gestores", V.tecnicos || "Gestores")}
              {th("planes", V.brigadas || "Planes")}
              {th("risk", "Riesgo")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.b} className="clk" onClick={() => onFilterChange("jerBarrio", f.b)}>
                <td>{f.barrio}</td>
                <td className="dim">{f.muni}</td>
                <td className="num">{num(f.tot)}</td>
                <td className="num">{pct(f.efPct)}</td>
                <td className="num bad">{num(f.pe)}</td>
                <td className="num">{pct(f.pctPago)}</td>
                <td className="num">{f.gestores}</td>
                <td className="num">{f.planes}</td>
                <td className="num">
                  <span
                    className="pill"
                    style={{ background: riskColorOf(P, f.o.risk), color: riskInk(P, f.o.risk) }}
                    title={f.o.pequena ? "Muestra pequeña: menos de 30 gestiones" : undefined}
                  >
                    {f.o.prio ?? "—"}
                    {f.o.pequena ? "*" : ""}
                  </span>
                </td>
                <td className="num go"><ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="gv-nota">* Muestra pequeña (menos de 30 gestiones).</p>
      </>
    );
  } else if (gsel == null) {
    // Nivel 2: planes dentro del barrio
    const porPlan = new Map();
    for (let j = 0; j < I.length; j++) {
      const i = I[j];
      if (st.B_raw[i] !== bsel) continue;
      let o = porPlan.get(st.G_raw[i]);
      if (!o) porPlan.set(st.G_raw[i], (o = { tot: 0, vf: 0, pago: 0 }));
      o.tot++;
      if (st.GEST_RAW[i] === vfId) o.vf++;
      else if (pagoIds.has(st.RG_RAW[i])) o.pago++;
    }
    const totBarrio = [...porPlan.values()].reduce((a, o) => a + o.tot, 0);
    if (!porPlan.size) return <p className="empty">Sin datos en este barrio.</p>;
    cuerpo = (
      <table className="mt rk">
        <thead>
          <tr>
            <th>{V.brigada || "Plan"}</th>
            <th className="num">{V.ordenes || "Gestiones"}</th>
            <th className="num">Participación</th>
            <th className="num">Efect.</th>
            <th className="num">Perdidas</th>
            <th className="num">% con pago</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {[...porPlan.entries()]
            .sort((a, b) => b[1].tot - a[1].tot)
            .map(([g, o]) => (
              <tr key={g} className="clk" onClick={() => onFilterChange("jerBrig", g)}>
                <td>{dim.brigs[g]}</td>
                <td className="num">{num(o.tot)}</td>
                <td className="num">{pct((o.tot / totBarrio) * 100)}</td>
                <td className="num">{pct(((o.tot - o.vf) / o.tot) * 100)}</td>
                <td className="num bad">{num(o.vf)}</td>
                <td className="num">{pct((o.pago / o.tot) * 100)}</td>
                <td className="num go"><ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" /></td>
              </tr>
            ))}
        </tbody>
      </table>
    );
  } else if (tec == null) {
    // Nivel 3: gestores del plan en ese barrio
    const porTec = new Map();
    for (let j = 0; j < I.length; j++) {
      const i = I[j];
      if (st.B_raw[i] !== bsel || st.G_raw[i] !== gsel) continue;
      let o = porTec.get(st.T_raw[i]);
      if (!o) porTec.set(st.T_raw[i], (o = { tot: 0, vf: 0, pago: 0 }));
      o.tot++;
      if (st.GEST_RAW[i] === vfId) o.vf++;
      else if (pagoIds.has(st.RG_RAW[i])) o.pago++;
    }
    cuerpo = (
      <table className="mt rk">
        <thead>
          <tr>
            <th>{V.tecnico || "Gestor"}</th>
            <th className="num">{V.ordenes || "Gestiones"}</th>
            <th className="num">Efect.</th>
            <th className="num">Perdidas</th>
            <th className="num">Con pago</th>
            <th className="num">% con pago</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {[...porTec.entries()]
            .sort((a, b) => b[1].tot - a[1].tot)
            .map(([t, o]) => (
              <tr key={t} className="clk" onClick={() => setTec(t)}>
                <td>{nombreDe(dim.tecs[t])}</td>
                <td className="num">{num(o.tot)}</td>
                <td className="num">{pct(((o.tot - o.vf) / o.tot) * 100)}</td>
                <td className="num bad">{num(o.vf)}</td>
                <td className="num">{num(o.pago)}</td>
                <td className="num">{pct((o.pago / o.tot) * 100)}</td>
                <td className="num go"><ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" /></td>
              </tr>
            ))}
        </tbody>
      </table>
    );
  } else {
    // Nivel 4: gestiones de ese gestor; un clic abre el historial del NIC
    const filas = [];
    for (let j = 0; j < I.length; j++) {
      const i = I[j];
      if (st.B_raw[i] === bsel && st.G_raw[i] === gsel && st.T_raw[i] === tec) filas.push(i);
    }
    filas.sort((a, b) => st.M_raw[b] - st.M_raw[a]);
    cuerpo = (
      <>
        <table className="mt rk">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>NIC</th>
              <th>Resultado gestión</th>
              <th>Recaudo</th>
              <th>Causa</th>
              <th>Detalle del acta</th>
            </tr>
          </thead>
          <tbody>
            {filas.slice(0, LIMITE_GESTIONES).map((i) => {
              const hh = String(Math.floor((st.M_raw[i] % 1440) / 60)).padStart(2, "0");
              const mm = String(st.M_raw[i] % 60).padStart(2, "0");
              return (
                <tr key={i} className="clk" onClick={() => onSelectNic(st.NIC_raw[i])} title="Ver el historial de este NIC">
                  <td>{dayLabel(st.DAY_raw[i])} {hh}:{mm}</td>
                  <td className="mono">{st.NIC_raw[i]}</td>
                  <td className={st.GEST_RAW[i] === vfId ? "bad" : ""}>{dim.gests[st.GEST_RAW[i]]}</td>
                  <td>{dim.resultados[st.RG_RAW[i]]}</td>
                  <td>{dim.anoms[st.CA_RAW[i]]}</td>
                  <td className="dim">{dim.subcausas[st.SC_RAW[i]]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="gv-nota">
          {num(filas.length)} gestiones
          {filas.length > LIMITE_GESTIONES ? `; se muestran las ${LIMITE_GESTIONES} más recientes` : ""}.
        </p>
      </>
    );
  }

  return (
    <>
      {crumb}
      <div className="jer-body" style={{ marginTop: "8px" }}>{cuerpo}</div>
    </>
  );
}
