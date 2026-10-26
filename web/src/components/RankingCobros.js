"use client";

import React from "react";

import VistaGestores from "@/components/VistaGestores";
import { CON_PAGO, PERDIDA, idDe, idRec } from "@/lib/resultadoCobros";

// Ranking de COBROS: la misma tabla por gestor de Tendencias (con posición y
// cuentas con pago) y, al lado, el desempeño por plan. Un clic en un gestor deja
// en el mapa solo sus gestiones.
export default function RankingCobros({ A, st, dim, onFilterChange, P, V }) {
  const num = (v) => Math.round(v).toLocaleString("es-CO");
  const pct = (v) => v.toFixed(1).replace(".", ",") + "%";

  const vfId = idDe(dim, PERDIDA);
  const pagoIds = new Set([idRec(dim, CON_PAGO)].filter((i) => i >= 0));

  // Planes: gestiones, perdidas (VF) y gestiones con pago, sobre lo que hay filtrado.
  const planes = new Map();
  const I = A.IDX || [];
  for (let j = 0; j < I.length; j++) {
    const i = I[j];
    let o = planes.get(st.G_raw[i]);
    if (!o) {
      o = { tot: 0, vf: 0, pago: 0 };
      planes.set(st.G_raw[i], o);
    }
    o.tot++;
    if (st.GEST_RAW[i] === vfId) o.vf++;
    if (pagoIds.has(st.RG_RAW[i])) o.pago++;
  }
  const filasPlan = [...planes.entries()].sort(
    (a, b) => b[1].pago / b[1].tot - a[1].pago / a[1].tot
  );

  const sel = st.causaSel && st.causaSel.campo === "T" ? st.causaSel : null;

  const elegir = (nombre) => {
    const id = dim.tecs.indexOf(nombre);
    if (id < 0) return;
    const igual = sel && sel.id === id;
    onFilterChange("causaSel", igual ? null : { campo: "T", id });
    // Sin la capa de puntos no habría nada que ver en el mapa.
    if (!igual && !st.layers.gps) onFilterChange("layers", { ...st.layers, gps: true });
  };

  const lateral = (
    <>
      <div className="gv-ch">
        <b>{V.brigadas || "Planes"} · desempeño</b>
      </div>
      <table className="mt">
        <thead>
          <tr>
            <th>{V.brigada || "Plan"}</th>
            <th className="num">{V.ordenes || "Gestiones"}</th>
            <th className="num">Efect. bruta</th>
            <th className="num">Perdidas</th>
            <th className="num">Con pago</th>
            <th className="num">% con pago</th>
          </tr>
        </thead>
        <tbody>
          {filasPlan.map(([g, o]) => (
            <tr key={g}>
              <td>{dim.brigs[g]}</td>
              <td className="num">{num(o.tot)}</td>
              <td className="num">{pct(((o.tot - o.vf) / o.tot) * 100)}</td>
              <td className="num">{num(o.vf)}</td>
              <td className="num">{num(o.pago)}</td>
              <td className="num">{pct((o.pago / o.tot) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gv-nota">
        Efectividad bruta: gestiones que no fueron perdidas (VF). Las perdidas cuentan todas,
        también las que no dependen del gestor.
      </p>
    </>
  );

  return (
    <VistaGestores
      tabla={st.tablaGestores}
      dim={dim}
      palette={P}
      ranking
      lateral={lateral}
      onPick={elegir}
      seleccion={sel ? dim.tecs[sel.id] : null}
    />
  );
}
