"use client";

import React, { useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

import { useTheme, riskColor as riskColorOf, riskInk } from "@/lib/theme";

export default function RiskSpine({
  ELIG,
  st,
  dim,
  onFilterChange,
  onSelectBarrio,
  onToggleBarrio,
  V = {}
}) {
  const [q, setQ] = useState("");
  const { palette: P } = useTheme();

  const num = (val) => Math.round(val).toLocaleString("es-CO");
  const pct = (val) => val.toFixed(1).replace(".", ",");

  const riskColor = (r) => riskColorOf(P, r);

  const barrioName = (b) => dim.barrios[b].split(" | ")[1];
  const barrioMuni = (b) => dim.barrios[b].split(" | ")[0];

  // Filtering based on search query
  let rows = ELIG.slice();
  if (q) {
    rows = rows.filter(([b]) =>
      dim.barrios[b].toLowerCase().includes(q.toLowerCase())
    );
  }

  // Sorting
  // En cobros todos los barrios entran: dentro de cada nivel van primero los de
  // muestra suficiente y luego los de más perdidas, para que un barrio de 1 gestión
  // perdida no quede por encima de uno grande del mismo nivel.
  const nivel = (r) => (r >= 81 ? 3 : r >= 61 ? 2 : r >= 31 ? 1 : 0);
  const porNivel = (x, y) =>
    nivel(y[1].risk ?? -1) - nivel(x[1].risk ?? -1) ||
    Number(x[1].pequena) - Number(y[1].pequena) ||
    (y[1].risk ?? -1) - (x[1].risk ?? -1) ||
    y[1].pe - x[1].pe;
  const sortFns = {
    risk: V.riesgoPorPromedio ? porNivel : (x, y) => (y[1].risk ?? -1) - (x[1].risk ?? -1),
    tot: (x, y) => y[1].tot - x[1].tot,
    pe: (x, y) => y[1].pePct - x[1].pePct,
    fa: (x, y) => y[1].faPct - x[1].faPct,
    ef: (x, y) => x[1].efAdj - y[1].efAdj
  };
  rows.sort(sortFns[st.spineSort] || sortFns.risk);

  const hsCount = rows.filter(([, o]) => o.risk >= st.hotspot).length;

  const ctx = [];
  if (st.zona !== "") ctx.push(dim.zonas[+st.zona]);
  if (st.muni !== "") ctx.push(dim.munis[+st.muni]);
  if (st.brig !== "") ctx.push(dim.brigs[+st.brig]);
  if (st.tipo !== "") ctx.push(dim.tipos[+st.tipo]);

  return (
    <aside id="left">
      <div className="lh">
        <h3>
          Cola de triaje por riesgo <em id="hotCount">{hsCount}</em>
        </h3>
        <p>Barrios ordenados por índice de riesgo operativo. Lo más crítico, siempre arriba.</p>
        <input
          id="spineSearch"
          placeholder="Buscar barrio…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="lctl">
        <div className="f">
          <label>Mín. {V.ordenesMin || "ordenes"}</label>
          <input
            type="number"
            id="minOrders"
            value={st.minOrders}
            min="1"
            max="500"
            onChange={(e) => onFilterChange("minOrders", +e.target.value)}
          />
          <small className="lctl-nota">
            Mínimo para que un barrio entre a la cola
          </small>
        </div>
        <div className="f rgw">
          <label>
            Umbral hotspot · <span id="hotLabel">{st.hotspot}</span>
          </label>
          <input
            type="range"
            id="hotspot"
            min="10"
            max="95"
            value={st.hotspot}
            onChange={(e) => onFilterChange("hotspot", +e.target.value)}
          />
          <small className="lctl-nota">
            Riesgo desde el cual un barrio se marca como crítico
          </small>
        </div>
      </div>

      <div className="lctl" style={{ paddingTop: "6px" }}>
        <label
          className="lay"
          style={{ fontSize: "11px" }}
          title="Excluye del riesgo y del ranking las causas que la operación no puede evitar"
        >
          <input
            type="checkbox"
            id="adjToggle"
            checked={st.adjusted}
            onChange={(e) => onFilterChange("adjusted", e.target.checked)}
          />
          Riesgo sobre pérdidas <b style={{ color: "var(--cu2)" }}>controlables</b>
        </label>
      </div>

      <div className="lctl">
        <div className="f" style={{ flex: 1 }}>
          <label>Ordenar por</label>
          <select
            id="spineSort"
            value={st.spineSort}
            onChange={(e) => onFilterChange("spineSort", e.target.value)}
          >
            <option value="risk">Riesgo ↓</option>
            <option value="tot">{V.ordenes || "Órdenes"} ↓</option>
            <option value="pe">% Perdidas ↓</option>
            <option value="ef">Efectividad ↑</option>
          </select>
        </div>
      </div>

      <div id="spineCount">
        {ctx.length ? (
          <b className="flt">{ctx.join(" · ")}</b>
        ) : (
          <span className="flt-off">Toda la operación</span>
        )}{" "}
        · {rows.length} barrios · ≥{st.minOrders} {V.ordenesMin || "ordenes"}
      </div>

      {st.barrios?.length > 0 && (
        <div className="sp-sel">
          <span>
            <b>{st.barrios.length}</b> {st.barrios.length === 1 ? "barrio seleccionado" : "barrios seleccionados"}
          </span>
          <button type="button" onClick={() => onFilterChange("activeTab", "detalle")}>
            Ver detalle
          </button>
          <button type="button" onClick={() => onFilterChange("selBarrio", null)}>
            Quitar
          </button>
        </div>
      )}

      <div id="spine">
        {rows.slice(0, 400).map(([b, o]) => {
          const hot = o.risk >= st.hotspot;
          const efW = (o.ef / o.tot) * 100;
          const peW = (o.pe / o.tot) * 100;
          const tr =
            o.trend > 2 ? (
              <span className="tr up">
                <TrendingUp size={11} strokeWidth={2.4} aria-hidden="true" /> {pct(o.trend)}pp
              </span>
            ) : o.trend < -2 ? (
              <span className="tr dn">
                <TrendingDown size={11} strokeWidth={2.4} aria-hidden="true" />{" "}
                {pct(Math.abs(o.trend))}pp
              </span>
            ) : (
              ""
            );

          return (
            <div
              key={b}
              className={`sp-row${hot ? " hot" : ""}${
                st.barrios?.includes(b) ? " sel" : ""
              }`}
              onClick={() => onSelectBarrio(b)}
            >
              {/* Varios barrios: la casilla suma o quita este barrio de la selección; el
                  clic en la tarjeta sigue enfocando solo este. */}
              <input
                type="checkbox"
                className="sp-chk"
                checked={!!st.barrios?.includes(b)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleBarrio(b)}
                aria-label={`Seleccionar ${barrioName(b)} junto con otros barrios`}
                title="Seleccionar varios barrios"
              />
              <div
                className="sp-risk"
                style={{ background: riskColor(o.risk), color: riskInk(P, o.risk) }}
              >
                {o.risk}
              </div>
              <div className="sp-body">
                <div className="sp-t">
                  {hot && <span className="dot"></span>}
                  {barrioName(b)}
                  <span className="sp-m">{barrioMuni(b)}</span>
                </div>
                <div className="sp-bar">
                  <i style={{ width: `${efW}%`, background: P.st[0] }}></i>
                  <i style={{ width: `${peW}%`, background: P.st[2] }}></i>
                </div>
                <div className="sp-f">
                  {o.prio && V.riesgoPorPromedio && <b className="sp-cat">{o.prio}</b>}
                  <span>{num(o.tot)} {o.tot === 1 ? V.ordenMin || "orden" : V.ordenesMin || "ordenes"}</span>
                  <span className="sp-pe">{pct(o.pePct)}% perdidas</span>
                  {o.mult != null && <span>{pct(o.mult)}× prom.</span>}
                  {o.pequena && (
                    <em
                      className="sp-ms"
                      title="Menos de 30 gestiones: una sola gestión puede cambiar su categoría"
                    >
                      muestra pequeña
                    </em>
                  )}
                  {tr}
                </div>
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <p className="empty">
            Ningún barrio alcanza el mínimo de {st.minOrders} {V.ordenesMin || "ordenes"} con los
            filtros actuales. Baja el umbral o amplía el rango de fechas.
          </p>
        )}
      </div>
    </aside>
  );
}
