"use client";

import React, { useState } from "react";

import { PERDIDA, SIN_RECAUDO, idDe, idRec } from "@/lib/resultadoCobros";

// Motivos de COBROS: por qué una gestión quedó «No efectiva» y por qué una efectiva
// quedó «sin recaudo», con la causa más fina que sale del texto del gestor. Elegir un motivo
// deja en el mapa solo esas gestiones.
export default function MotivosCobros({ A, st, dim, onFilterChange, P }) {
  const [vista, setVista] = useState("perdidas");

  const num = (v) => Math.round(v).toLocaleString("es-CO");
  const pct = (v) => v.toFixed(1).replace(".", ",");

  // Las perdidas son «Contacto no efectivo» (resultado gestión); lo «sin recaudo» sale de la otra
  // dimensión, la del recaudo.
  const porRecaudo = vista !== "perdidas";
  const estadoId = porRecaudo ? idRec(dim, SIN_RECAUDO) : idDe(dim, PERDIDA);
  const estados = porRecaudo ? st.RG_RAW : st.GEST_RAW;
  const campo = vista === "perdidas" ? "C" : "CA";
  const nombres = vista === "perdidas" ? dim.causas : dim.anoms;
  const arr = vista === "perdidas" ? st.C_raw : st.CA_RAW;
  const sel = st.causaSel;
  const agresivoId = dim.subcausas.indexOf("Usuario agresivo");

  const causas = new Map();
  const detalle = new Map();
  let total = 0;
  let agresivos = 0;
  const I = A.IDX || [];
  for (let j = 0; j < I.length; j++) {
    const i = I[j];
    if (st.SC_RAW[i] === agresivoId) agresivos++;
    if (estados[i] !== estadoId) continue;
    total++;
    causas.set(arr[i], (causas.get(arr[i]) || 0) + 1);
    if (sel && sel.campo === campo && sel.x === estadoId && sel.fx === (porRecaudo ? "R" : "G") && arr[i] === sel.id) {
      detalle.set(st.SC_RAW[i], (detalle.get(st.SC_RAW[i]) || 0) + 1);
    }
  }
  const filas = [...causas.entries()].sort((a, b) => b[1] - a[1]);
  const delTipo = sel && sel.campo === campo && sel.x === estadoId && sel.fx === (porRecaudo ? "R" : "G");
  const totalSel = delTipo ? causas.get(sel.id) || 0 : 0;

  const elegir = (nuevo) => {
    const igual = sel && sel.campo === nuevo.campo && sel.id === nuevo.id && sel.x === nuevo.x;
    onFilterChange("causaSel", igual ? null : nuevo);
    // Sin la capa de puntos no habría nada que ver en el mapa.
    if (!igual && !st.layers.gps) onFilterChange("layers", { ...st.layers, gps: true });
  };

  const cambiarVista = (v) => {
    setVista(v);
    onFilterChange("causaSel", null);
  };

  return (
    <div className="mc">
      <div className="mc-l">
        <div className="mc-h">
          <span className="vt-sw" role="group" aria-label="Tipo de motivo">
            <button className={vista === "perdidas" ? "on" : ""} onClick={() => cambiarVista("perdidas")}>
              Visitas fallidas
            </button>
            <button className={vista === "sinpago" ? "on" : ""} onClick={() => cambiarVista("sinpago")}>
              Efectivas sin recaudo
            </button>
          </span>
          <span className="mc-t">{num(total)} gestiones</span>
          {sel && (
            <button className="btn" onClick={() => onFilterChange("causaSel", null)}>
              Ver todas en el mapa
            </button>
          )}
        </div>
        <div className="causes">
          {filas.map(([c, n]) => {
            const p = total ? (n / total) * 100 : 0;
            const ctrl = vista === "perdidas" ? dim.causa_ctrl[c] === 1 : true;
            const activa = delTipo && sel.id === c;
            return (
              <div
                key={c}
                className={`cz cz-click${activa ? " sel" : ""}`}
                onClick={() => elegir({ campo, id: c, x: estadoId, fx: porRecaudo ? "R" : "G" })}
                title="Ver solo estas gestiones en el mapa"
              >
                <span className="cz-n">
                  {nombres[c]}{" "}
                  {!ctrl && <em title="Fuera del control de la operación">no controlable</em>}
                </span>
                <i>
                  <b style={{ width: `${p}%`, background: ctrl ? P.series[1] : P.serieRef }}></b>
                </i>
                <span className="cz-v">
                  {pct(p)}% <em>{num(n)}</em>
                </span>
              </div>
            );
          })}
          {!filas.length && <p className="empty">Sin gestiones de este tipo con los filtros actuales.</p>}
        </div>
      </div>

      <div className="mc-r">
        {delTipo ? (
          <>
            <b className="mc-rt">Detalle según el acta · {nombres[sel.id]}</b>
            {[...detalle.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([s, n]) => (
                <div key={s} className="mc-d">
                  <span>{dim.subcausas[s]}</span>
                  <b>
                    {pct((n / totalSel) * 100)}% <em>{num(n)}</em>
                  </b>
                </div>
              ))}
          </>
        ) : (
          <p className="gv-nota">Elige un motivo para ver su detalle según lo que escribió el gestor.</p>
        )}
        {agresivoId >= 0 && (
          <button
            className={`mc-ag${sel && sel.campo === "SC" ? " sel" : ""}`}
            onClick={() => elegir({ campo: "SC", id: agresivoId, x: null })}
            title="Ver en el mapa las gestiones con menciones de agresión"
          >
            Usuario agresivo (en observaciones): <b>{num(agresivos)}</b> gestiones
          </button>
        )}
      </div>
    </div>
  );
}
