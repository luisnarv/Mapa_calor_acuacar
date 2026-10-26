"use client";

import React, { useState } from "react";

import { riskColor as riskColorOf, riskInk } from "@/lib/theme";
import { CON_PAGO, idRec } from "@/lib/resultadoCobros";

// Carga operativa de COBROS: cuánto trabajo cae en cada barrio y quién lo atiende.
// Todos los barrios, ordenables y con buscador. Un clic abre el detalle del barrio.
export default function CargaCobros({ A, st, dim, onSelectBarrio, P, V }) {
  const [q, setQ] = useState("");
  const [orden, setOrden] = useState({ col: "tot", asc: false });

  const num = (v) => Math.round(v).toLocaleString("es-CO");
  const pct = (v) => v.toFixed(1).replace(".", ",");

  const pagoIds = new Set([idRec(dim, CON_PAGO)].filter((i) => i >= 0));
  const conPago = new Map();
  const I = A.IDX || [];
  for (let j = 0; j < I.length; j++) {
    const i = I[j];
    if (pagoIds.has(st.RG_RAW[i])) conPago.set(st.B_raw[i], (conPago.get(st.B_raw[i]) || 0) + 1);
  }

  const buscado = q.trim().toLowerCase();
  const filas = [...A.barrio.entries()]
    .filter(([b, o]) => o.tot >= st.minOrders && (!buscado || dim.barrios[b].toLowerCase().includes(buscado)))
    .map(([b, o]) => {
      const pago = conPago.get(b) || 0;
      return {
        b,
        o,
        barrio: dim.barrios[b].split(" | ")[1],
        muni: dim.barrios[b].split(" | ")[0],
        tot: o.tot,
        efPct: o.efPct,
        pe: o.pe,
        gestores: o.tec.size,
        planes: o.brig.size,
        porGestor: o.tec.size ? o.tot / o.tec.size : 0,
        pago,
        pctPago: o.tot ? (pago / o.tot) * 100 : 0,
        risk: o.risk ?? -1,
      };
    })
    .sort((x, y) => {
      const a = x[orden.col];
      const c = typeof a === "string" ? a.localeCompare(y[orden.col], "es") : a - y[orden.col];
      return orden.asc ? c : -c;
    });

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

  return (
    <div>
      <div className="mc-h">
        <input
          className="cc-q"
          placeholder="Buscar barrio…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
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
            {th("gestores", V.tecnicos || "Gestores")}
            {th("planes", V.brigadas || "Planes")}
            {th("porGestor", "Gest. por gestor")}
            {th("pago", "Con pago")}
            {th("pctPago", "% con pago")}
            {th("risk", "Riesgo")}
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.b} className="clk" onClick={() => onSelectBarrio(f.b)}>
              <td>{f.barrio}</td>
              <td className="dim">{f.muni}</td>
              <td className="num">{num(f.tot)}</td>
              <td className="num">{pct(f.efPct)}%</td>
              <td className="num bad">{num(f.pe)}</td>
              <td className="num">{f.gestores}</td>
              <td className="num">{f.planes}</td>
              <td className="num">{num(f.porGestor)}</td>
              <td className="num">{num(f.pago)}</td>
              <td className="num">{pct(f.pctPago)}%</td>
              <td className="num">
                <span
                  className="pill"
                  style={{ background: riskColorOf(P, f.o.risk), color: riskInk(P, f.o.risk) }}
                  title={f.o.pequena ? "Muestra pequeña: menos de 30 gestiones" : undefined}
                >
                  {f.o.prio ?? "—"} · {f.o.risk ?? "—"}
                  {f.o.pequena ? "*" : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!filas.length && <p className="empty">Ningún barrio coincide con la búsqueda y los filtros.</p>}
      <p className="gv-nota">
        * Muestra pequeña (menos de 30 gestiones). Gest. por gestor = gestiones del barrio entre los
        gestores distintos que lo atendieron. Con pago = pago total, abono o acuerdo de pago.
      </p>
    </div>
  );
}
