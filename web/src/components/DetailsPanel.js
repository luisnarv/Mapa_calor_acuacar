"use client";

import React, { useState } from "react";
import { Info, Star } from "lucide-react";

import { useTheme, riskColor as riskColorOf, riskInk } from "@/lib/theme";
import SelectorMultiple from "@/components/SelectorMultiple";

export default function DetailsPanel({
  st,
  A,
  Asel,
  AselTec,
  ELIG,
  dim,
  geo,
  dayLabel,
  recommend,
  zoneAvg,
  actionsFor,
  onFilterChange,
  onSelectBarrio,
  V = {}
}) {
  // Controla si el panel de detalles está desplegado u oculto (empieza oculto)
  const [collapsed, setCollapsed] = useState(true);
  const { palette: P } = useTheme();

  const num = (val) => Math.round(val).toLocaleString("es-CO");
  const pct = (val) => val.toFixed(1).replace(".", ",");
  // En cobros la base trae "NOMBRE - cédula": en pantalla basta el nombre.
  const gestor = (n) => (V.sinAjuste ? n.replace(/\s*-\s*\d+\s*$/, "").trim() : n);
  const delta = (v, ref) => {
    const d = v - ref;
    const cls = d > 0 ? "ok" : "bad";
    return (
      <span className={`dl ${Math.abs(d) < 3 ? "" : cls}`}>
        {d >= 0 ? "+" : ""}
        {pct(d)} pp
      </span>
    );
  };

  const riskColor = (r) => riskColorOf(P, r);

  /* Estados: relleno de marca para barras y leyendas */
  const ST_COLOR = P.st;

  const barrioName = (b) => dim.barrios[b].split(" | ")[1];
  const barrioMuni = (b) => dim.barrios[b].split(" | ")[0];

  const miniTable = (rows, heads) => {
    if (!rows.length) return <p className="empty">Sin datos.</p>;
    return (
      <table className="mt">
        <thead>
          <tr>
            {heads.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx} className={cIdx ? "num" : ""}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const topList = (map_, k = 5) => {
    return [...map_.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  };

  // --- 1. BARRIO / GLOBAL PANEL ---
  // `AA` y `EE` son los datos sobre los que se calcula: todos, o solo los barrios elegidos
  // (`multi`) cuando se ven acumulados.
  const renderBarrioDe = (b, AA, EE, multi = null) => {
    const A = AA;
    const ELIG = EE;

    // GLOBAL OVERVIEW
    if (b == null) {
      const badTot = A.tot - A.ef;
      const causes = [...A.causa.entries()]
        .filter(([c]) => dim.causas[c] !== "Efectiva")
        .sort((x, y) => y[1] - x[1]);
      const topRisky = ELIG.slice()
        .sort((x, y) => (y[1].risk ?? -1) - (x[1].risk ?? -1))
        .slice(0, multi ? 10 : 5);
      const subRows = [...A.sub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

      return (
        <>
          <div className="pb-head" style={{ marginBottom: "12px" }}>
            <div
              className="pb-risk"
              style={{
                background: "var(--badge-bg)",
                width: "38px",
                height: "38px",
                fontSize: "14px",
                flex: "0 0 38px",
                color: "var(--badge-tx)",
                fontWeight: "600"
              }}
            >
              {multi ? multi.n : "GLO"}
            </div>
            <div>
              <h2>{multi ? "Resumen acumulado" : "Resumen de Operación"}</h2>
              <span className="pb-sub">
                {multi
                  ? multi.nombres
                  : <>
                      {st.zona === "" ? "Todo el departamento" : "Zona: " + dim.zonas[+st.zona]}{" "}
                      &middot; {st.muni === "" ? "Todos los municipios" : dim.munis[+st.muni]}
                    </>}
              </span>
            </div>
          </div>

          <div className="mini-grid tres" style={{ marginBottom: "14px" }}>
            <div className="mini">
              <span>Total</span>
              <b>{num(A.tot)}</b>
            </div>
            <div className="mini">
              <span>Efectivas</span>
              <b className="ok">{num(A.ef)}</b>
            </div>
            <div className="mini">
              <span>Perdidas</span>
              <b className="bad">{num(A.pe)}</b>
            </div>
          </div>

          <h3>{multi ? "Efectividad acumulada" : "Efectividad Global"}</h3>
          <table className="cmp" style={{ marginBottom: "14px" }}>
            <tbody>
              <tr>
                <td>Efectividad bruta</td>
                <td className="num">{pct(A.efPct)}%</td>
              </tr>
              {!V.sinAjuste && (
              <tr>
                <td>Efectividad ajustada</td>
                <td className="num ok" style={{ fontWeight: "600" }}>
                  {pct(A.efAdj)}%
                </td>
              </tr>
              )}
              <tr>
                <td>Tasa de pérdida</td>
                <td className="num bad">{pct(A.pePct)}%</td>
              </tr>
            </tbody>
          </table>

          <h3>
            {multi ? "Barrios elegidos" : "Barrios con mayor riesgo"}{" "}
            <span className="hint">clic para analizar</span>
          </h3>
          {topRisky.length ? (
            <table className="mt rk" style={{ marginBottom: "14px" }}>
              <thead>
                <tr>
                  <th>Barrio</th>
                  <th>Municipio</th>
                  <th className="num">Riesgo</th>
                </tr>
              </thead>
              <tbody>
                {topRisky.map(([bIdx, o]) => (
                  <tr
                    key={bIdx}
                    className="clk"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectBarrio(bIdx);
                    }}
                  >
                    <td>{barrioName(bIdx)}</td>
                    <td className="dim">{barrioMuni(bIdx)}</td>
                    <td className="num">
                      <span
                        className="pill"
                        style={{ background: riskColor(o.risk), color: riskInk(P, o.risk) }}
                      >
                        {o.risk}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty" style={{ marginBottom: "14px" }}>
              Sin barrios con muestra suficiente.
            </p>
          )}

          <h3>
            Motivos de no efectividad <span className="hint">{num(badTot)} {V.ordenesMin || "ordenes"}</span>
          </h3>
          <div className="causes" style={{ marginBottom: "14px" }}>
            {causes.slice(0, 5).map(([c, n]) => {
              const p = badTot ? (n / badTot) * 100 : 0;
              const ctrl = dim.causa_ctrl[c] === 1;
              return (
                <div key={c} className="cz">
                  <span className="cz-n">
                    {dim.causas[c]}{" "}
                    {!ctrl && (
                      <em title="Fuera del control de la operación">
                        no controlable
                      </em>
                    )}
                  </span>
                  <i>
                    <b
                      style={{
                        width: `${p}%`,
                        background: ctrl ? P.series[1] : P.serieRef
                      }}
                    ></b>
                  </i>
                  <span className="cz-v">
                    {pct(p)}% <em>{num(n)}</em>
                  </span>
                </div>
              );
            })}
            {!causes.length && (
              <p className="empty" style={{ marginBottom: "14px" }}>
                Sin {V.ordenesMin || "ordenes"} no efectivas.
              </p>
            )}
          </div>

          <h3>
            Distribución de trabajo realizado <span className="hint">efectivas</span>
          </h3>
          {A.ef
            ? miniTable(
                subRows.map(([s, n]) => [
                  dim.subs[s],
                  num(n),
                  pct((n / A.ef) * 100) + "%"
                ]),
                [V.subaccion || "Subacción", V.ordenes || "Órdenes", "Part."]
              )
            : <p className="empty">Sin datos.</p>}

          {!multi && (
            <p
              className="hint"
              style={{ marginTop: "16px", lineHeight: "1.45", color: "var(--dim)" }}
            >
              * Selecciona un barrio en la columna de riesgo o haz clic en cualquier
              círculo del mapa para ver el diagnóstico específico de esa zona.
            </p>
          )}
        </>
      );
    }

    // SPECIFIC BARRIO OVERVIEW
    const o = A.barrio.get(b);
    if (!o) {
      return (
        <p className="empty">
          Ese barrio no tiene {V.ordenesMin || "ordenes"} con los filtros actuales.
        </p>
      );
    }

    const z = zoneAvg(dim.b_zona[b]);
    const zonaN = dim.zonas[dim.b_zona[b]];

    const causes = [...o.causa.entries()]
      .filter(([c]) => dim.causas[c] !== "Efectiva")
      .sort((x, y) => y[1] - x[1]);
    const badTot = o.tot - o.ef;

    const acts = actionsFor(b, o, z);
    const recT = recommend(b, st.tipo === "" ? -1 : +st.tipo, "tec").slice(0, 3);

    // local effective technicians
    const localTechs = [...o.tecEf.entries()]
      .map(([t, s]) => {
        const den = s.tot - s.noCtrl;
        return {
          t,
          tot: s.tot,
          ef: s.ef,
          efAdj: den > 0 ? (s.ef / den) * 100 : 0,
          den
        };
      })
      .filter((r) => r.tot >= 3)
      .sort((a, b) => b.efAdj - a.efAdj);

    return (
      <>
        <div className="pb-head">
          <div
            className="pb-risk"
            style={{ background: riskColor(o.risk), color: riskInk(P, o.risk) }}
          >
            {o.risk ?? "—"}
          </div>
          <div>
            <h2>{barrioName(b)}</h2>
            <span className="pb-sub">
              {barrioMuni(b)} · {zonaN} · Prioridad{" "}
              <b style={{ color: riskColorOf(P, o.risk, true) }}>
                {o.prio ?? "muestra insuficiente"}
              </b>
            </span>
          </div>
        </div>

        <div className="mini-grid tres">
          <div className="mini">
            <span>Total</span>
            <b>{num(o.tot)}</b>
          </div>
          <div className="mini">
            <span>Efectivas</span>
            <b className="ok">{num(o.ef)}</b>
          </div>
          <div className="mini">
            <span>Perdidas</span>
            <b className="bad">{num(o.pe)}</b>
          </div>
        </div>

        <h3>Comparación contra la zona {zonaN}</h3>
        <table className="cmp">
          <thead>
            <tr>
              <th></th>
              <th>Barrio</th>
              <th>Zona</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Efectividad</td>
              <td>{pct(o.efPct)}%</td>
              <td>{pct(z.efPct)}%</td>
              <td>{delta(o.efPct, z.efPct)}</td>
            </tr>
            {!V.sinAjuste && (
            <tr>
              <td>Efectividad ajustada</td>
              <td>{pct(o.efAdj)}%</td>
              <td>{pct(z.efAdj)}%</td>
              <td>{delta(o.efAdj, z.efAdj)}</td>
            </tr>
            )}
            <tr>
              <td>% Perdidas</td>
              <td>{pct(o.pePct)}%</td>
              <td>{pct(z.pePct)}%</td>
              <td>{delta(z.pePct, o.pePct)}</td>
            </tr>
          </tbody>
        </table>

        {o.risk != null && V.riesgoPorPromedio && (
          <>
            <h3>
              Categoría de riesgo <span className="hint">frente al promedio</span>
            </h3>
            <p className="gv-nota" style={{ fontSize: "11.5px", color: "var(--mut)", lineHeight: 1.5 }}>
              Pierde el <b>{pct(o.pePct)}%</b> de sus visitas: <b>{pct(o.mult)}×</b> el promedio de la
              operación ({pct(A.pePct)}%). Categoría{" "}
              <b style={{ color: riskColorOf(P, o.risk, true) }}>{o.prio}</b>.
              {o.pequena && (
                <>
                  {" "}
                  <em>
                    Muestra pequeña ({num(o.tot)} {V.ordenesMin || "ordenes"}): una sola gestión puede
                    cambiar la categoría.
                  </em>
                </>
              )}
            </p>
          </>
        )}

        {o.risk != null && !V.riesgoPorPromedio && (
          <>
            <h3>
              Composición del índice de riesgo <span className="hint">(0-100)</span>
            </h3>
            <div className="parts">
              {[
                ["% perdidas", o.parts.pe, V.pesos.pe],
                ["Volumen", o.parts.vol, V.pesos.vol],
                ["Tendencia", o.parts.tr, V.pesos.tr],
                ["Desempeño histórico", o.parts.hist, V.pesos.hist]
              ].filter(([, , w]) => w > 0).map(([l, v, w]) => [l, v, w * 100]).map(([l, v, mx]) => (
                <div key={l} className="part">
                  <span>{l}</span>
                  <i>
                    <b style={{ width: `${(v / mx) * 100}%` }}></b>
                  </i>
                  <em>
                    {v.toFixed(1)}/{mx}
                  </em>
                </div>
              ))}
            </div>
          </>
        )}

        <h3>
          Acciones recomendadas{" "}
          <span className="hint" title="Sugerencias automáticas derivadas de reglas operativas sobre los datos del barrio (causas, efectividad, tendencia). No usan IA.">
            generadas por reglas operativas
          </span>
        </h3>
        <div className="acts">
          {acts.map((a, idx) => (
            <div key={idx} className={`act ${a.lvl}`}>
              <b>{a.t}</b>
              <p dangerouslySetInnerHTML={{ __html: a.d }} />
            </div>
          ))}
        </div>

        <h3>
          Motivos de no efectividad <span className="hint">{num(badTot)} {V.ordenesMin || "ordenes"}</span>
        </h3>
        <div className="causes">
          {causes.map(([c, n]) => {
            const p = badTot ? (n / badTot) * 100 : 0;
            const ctrl = dim.causa_ctrl[c] === 1;
            return (
              <div key={c} className="cz">
                <span className="cz-n">
                  {dim.causas[c]}{" "}
                  {!ctrl && (
                    <em title="Fuera del control de la operación">
                      no controlable
                    </em>
                  )}
                </span>
                <i>
                  <b
                    style={{
                      width: `${p}%`,
                      background: ctrl ? P.series[1] : P.serieRef
                    }}
                  ></b>
                </i>
                <span className="cz-v">
                  {pct(p)}% <em>{num(n)}</em>
                </span>
              </div>
            );
          })}
          {!causes.length && <p className="empty">Sin {V.ordenesMin || "ordenes"} no efectivas.</p>}
        </div>

        <h3>{V.tecnico || "Técnico"} recomendado aquí</h3>
        {recT.length ? (
          <div className="recs">
            {recT.map((r, i) => (
              <div key={i} className={`rec ${i === 0 ? "best" : ""}`}>
                <div className="rec-h">
                  <b>{gestor(r.name)}</b>
                  <span 
                    className={`conf ${r.conf.toLowerCase()}`}
                    title={`La confianza estadística se calcula según la cantidad de ${V.ordenesMin || "ordenes"} comparables:\n• Alta: 30 o más ${V.ordenesMin || "ordenes"}\n• Media: 10 a 29 ${V.ordenesMin || "ordenes"}\n• Baja: menos de 10 ${V.ordenesMin || "ordenes"}`}
                    style={{ cursor: "help", textDecoration: "underline dotted", display: "inline-flex", alignItems: "center", gap: "2px" }}
                  >
                    Confianza {r.conf} <Info size={11} strokeWidth={2.2} style={{ opacity: 0.8 }} aria-hidden="true" />
                  </span>
                </div>
                <div className="rec-m">
                  <span>
                    <b>{pct(r.efAdj)}%</b> {V.sinAjuste ? "efectividad" : "efect. ajustada"}
                  </span>
                  <span>
                    <b>{num(r.den)}</b> {V.ordenesMin || "ordenes"} comparables
                  </span>
                  <span>
                    Última:{" "}
                    {r.last >= 0
                      ? dayLabel(Math.floor(r.last / 1440))
                      : "—"}
                  </span>
                </div>
                <div className="rec-s">Base: {r.scope}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">
            Muestra insuficiente para recomendar con fiabilidad en este barrio.
          </p>
        )}

        <h3>
          {V.tecnicos || "Técnicos"} más efectivos aquí <span className="hint">en este barrio</span>
        </h3>
        {localTechs.length
          ? miniTable(
              localTechs
                .slice(0, 6)
                .map((r) => [
                  gestor(dim.tecs[r.t]),
                  num(r.tot),
                  pct(r.efAdj) + "%"
                ]),
              [V.tecnico || "Técnico", V.ordenes || "Órdenes", V.sinAjuste ? "Efectividad aquí" : "Efect. aj. aquí"]
            )
          : <p className="empty">Ningún {V.tecnicoMin || "técnico"} tiene ≥3 {V.ordenesMin || "ordenes"} aquí.</p>}

        <h3>
          Trabajo efectivo realizado <span className="hint">para saber qué distribuir</span>
        </h3>
        {o.ef
          ? miniTable(
              topList(o.subEf, 6).map(([s, n]) => [
                dim.subs[s],
                num(n),
                pct((n / o.ef) * 100) + "%"
              ]),
              ["Acción ejecutada", V.ordenes || "Órdenes", "Part."]
            )
          : <p className="empty">Sin {V.ordenesMin || "ordenes"} efectivas en este barrio.</p>}

        <h3>{V.brigadas || "Brigadas"} asignadas</h3>
        {miniTable(
          topList(o.brig, 5).map(([g, c]) => [
            dim.brigs[g],
            num(c),
            pct((c / o.tot) * 100) + "%"
          ]),
          [V.brigada || "Brigada", V.ordenes || "Órdenes", "Part."]
        )}

        <h3>{V.tiposOs || "Tipos de orden"}</h3>
        {miniTable(
          topList(o.tipo, 5).map(([t, c]) => [
            dim.tipos[t],
            num(c),
            pct((c / o.tot) * 100) + "%"
          ]),
          [V.tipoOs || "Tipo OS", V.ordenes || "Órdenes", "Part."]
        )}

        {V.suspension !== false && (
          <>
            <h3>Tipos de suspensión</h3>
            {miniTable(
              topList(o.susp, 5).map(([u, c]) => [
                dim.susps[u],
                num(c),
                pct((c / o.tot) * 100) + "%"
              ]),
              ["Suspensión", V.ordenes || "Órdenes", "Part."]
            )}
          </>
        )}

        <h3>
          {V.subacciones || "Subacciones"} en no efectivas <span className="hint">{num(badTot)} {V.ordenesMin || "ordenes"}</span>
        </h3>
        {miniTable(
          topList(o.sub, 6).map(([sx, c]) => [
            dim.subs[sx],
            num(c),
            badTot ? pct((c / badTot) * 100) + "%" : "—"
          ]),
          [V.subaccion || "Subacción", "No efect.", "Part."]
        )}

        <h3>
          Causales en efectivas <span className="hint">distribución de lo ejecutado</span>
        </h3>
        {miniTable(
          topList(o.efTipo || new Map(), 5).map(([t, c]) => [
            dim.tipos[t],
            num(c),
            pct(o.ef ? (c / o.ef) * 100 : 0) + "%"
          ]),
          [V.tipoOs || "Tipo OS", "Efectivas", "Part."]
        )}

        <h3>
          {V.subacciones || "Subacciones"} en efectivas <span className="hint">qué se ejecutó</span>
        </h3>
        {miniTable(
          topList(o.subEf || new Map(), 6).map(([sx, c]) => [
            dim.subs[sx],
            num(c),
            pct(o.ef ? (c / o.ef) * 100 : 0) + "%"
          ]),
          [V.subaccion || "Subacción", "Efectivas", "Part."]
        )}
      </>
    );
  };

  // --- 2. TECNICO PANEL ---
  const renderBarrio = () => {
    const sel = st.barrios || [];
    if (sel.length < 2 || !Asel) return renderBarrioDe(st.selBarrio, A, ELIG);

    // Varios barrios: lo acumulado, o cada uno por separado.
    const elegidos = new Set(sel);
    const modo = st.vistaMulti === "separado" ? "separado" : "acumulado";
    const nombres = sel.length <= 3 ? sel.map(barrioName).join(", ") : `${sel.length} barrios seleccionados`;
    return (
      <>
        <div className="multi-modo" role="tablist" aria-label="Cómo ver los barrios elegidos">
          {[["acumulado", "Acumulado"], ["separado", "Por separado"]].map(([valor, texto]) => (
            <button
              key={valor}
              type="button"
              role="tab"
              aria-selected={modo === valor}
              className={`mm-seg${modo === valor ? " on" : ""}`}
              onClick={() => onFilterChange("vistaMulti", valor)}
            >
              {texto}
            </button>
          ))}
        </div>

        {modo === "acumulado"
          ? renderBarrioDe(null, Asel, ELIG.filter(([b]) => elegidos.has(b)), { n: sel.length, nombres })
          : sel.map((b, i) => (
              <details key={b} className="multi-b" open={i === 0}>
                <summary>
                  {barrioName(b)} <span className="dim">{barrioMuni(b)}</span>
                </summary>
                {renderBarrioDe(b, A, ELIG)}
              </details>
            ))}
      </>
    );
  };

  // El análisis de un técnico, o el acumulado de varios: `o` es su agregado y `R` su recorrido.
  const cuerpoTecnico = (o) => {
    let body = null;
    if (o) {
      const mainBrigList = [...o.brig.entries()].sort((a, b) => b[1] - a[1]);
      const mainBrig = mainBrigList.length ? mainBrigList[0][0] : null;
      const bo = mainBrig ? A.brig.get(mainBrig) : null;
      const brigName = mainBrig ? dim.brigs[mainBrig] : "—";
      const barrios = [...o.barrios]
        .map((b) => [barrioName(b), A.barrio.get(b)])
        .filter((x) => x[1]);

      body = (
        <>
          <div className="mini-grid tres">
            <div className="mini">
              <span>{V.ordenes || "Órdenes"}</span>
              <b>{num(o.tot)}</b>
            </div>
            <div className="mini">
              <span>Efectivas · {num(o.ef)}</span>
              <b className="ok">{pct(o.efPct)}%</b>
            </div>
            <div className="mini">
              <span>Perdidas · {num(o.pe)}</span>
              <b className="bad">{pct(o.pePct)}%</b>
            </div>
          </div>
          {!V.sinAjuste && (
            <div className="mini-grid" style={{ gridTemplateColumns: "1fr" }}>
              <div className="mini">
                <span>Efect. ajustada</span>
                <b className="ok">{pct(o.efAdj)}%</b>
              </div>
            </div>
          )}

          <h3>Distribución de resultados</h3>
          <div className="dist-bar">
            <i style={{ width: `${o.efPct}%`, background: ST_COLOR[0] }} title="Efectivas"></i>
            <i style={{ width: `${o.pePct}%`, background: ST_COLOR[2] }} title="Perdidas"></i>
          </div>
          <div className="dist-leg">
            <span>
              <i style={{ background: ST_COLOR[0] }}></i> Efectivas <b>{pct(o.efPct)}%</b>
            </span>
            <span>
              <i style={{ background: ST_COLOR[2] }}></i> Perdidas <b>{pct(o.pePct)}%</b>
            </span>
          </div>

          <h3>Comparación</h3>
          {bo && (
            <table className="cmp">
              <thead>
                <tr>
                  <th></th>
                  <th>{V.tecnico || "Técnico"}</th>
                  <th>{V.brigada || "Brigada"} {brigName}</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {!V.sinAjuste && (
                <tr>
                  <td>Efectividad ajustada</td>
                  <td>{pct(o.efAdj)}%</td>
                  <td>{pct(bo.efAdj)}%</td>
                  <td>{delta(o.efAdj, bo.efAdj)}</td>
                </tr>
                )}
                <tr>
                  <td>Efectividad bruta</td>
                  <td>{pct(o.efPct)}%</td>
                  <td>{pct(bo.efPct)}%</td>
                  <td>{delta(o.efPct, bo.efPct)}</td>
                </tr>
              </tbody>
            </table>
          )}

          <h3>{V.brigadas || "Brigadas"} con {V.sinAjuste ? "los" : "las"} que trabaja</h3>
          {miniTable(
            [...o.brig.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([g, c]) => [
                dim.brigs[g],
                num(c),
                pct((c / o.tot) * 100) + "%"
              ]),
            [V.brigada || "Brigada", V.ordenes || "Órdenes", "Part."]
          )}

          <h3>
            Barrios atendidos <span className="hint">{barrios.length}</span>
          </h3>
          {miniTable(
            barrios
              .sort((a, b) => b[1].tot - a[1].tot)
              .slice(0, 12)
              .map(([nm, bo]) => [nm, num(bo.tot), pct(bo.efPct) + "%"]),
            ["Barrio", V.ordenes || "Órdenes", "Efect."]
          )}

          <h3>Motivos de no efectividad</h3>
          {miniTable(
            topList(o.causa, 8)
              .filter(([c]) => dim.causas[c] !== "Efectiva")
              .slice(0, 6)
              .map(([c, n]) => [
                dim.causas[c],
                num(n),
                dim.causa_ctrl[c] ? "controlable" : "no controlable"
              ]),
            ["Causa", V.ordenes || "Órdenes", ""]
          )}
        </>
      );
    }

    return body;
  };

  const renderTecnico = () => {
    // Los elegidos que siguen con órdenes con los filtros actuales.
    const sel = (st.tecs || []).filter((t) => A.tec.has(t));
    const opciones = [...A.tec.entries()]
      .sort((a, b) => b[1].tot - a[1].tot)
      .map(([t, o]) => ({ valor: t, texto: gestor(dim.tecs[t]), extra: num(o.tot) }));

    let body;
    if (!sel.length) {
      body = (
        <p className="empty">
          Selecciona uno o varios {V.tecnicosMin || "técnicos"} para ver su cobertura, recorrido y desempeño.
        </p>
      );
    } else if (sel.length === 1 || !AselTec) {
      body = cuerpoTecnico(A.tec.get(sel[0]));
    } else {
      // Varios: lo acumulado, o cada uno por separado.
      const modo = st.vistaMultiTec === "separado" ? "separado" : "acumulado";
      const grupo = {
        tot: AselTec.tot, ef: AselTec.ef, fa: AselTec.fa, pe: AselTec.pe,
        efPct: AselTec.efPct, faPct: AselTec.faPct, pePct: AselTec.pePct, efAdj: AselTec.efAdj,
        brig: new Map([...AselTec.brig].map(([g, x]) => [g, x.tot])),
        barrios: new Set(AselTec.barrio.keys()),
        causa: AselTec.causa
      };
      body = (
        <>
          <div className="multi-modo" role="tablist" aria-label="Cómo ver los elegidos">
            {[["acumulado", "Acumulado"], ["separado", "Por separado"]].map(([valor, texto]) => (
              <button
                key={valor}
                type="button"
                role="tab"
                aria-selected={modo === valor}
                className={`mm-seg${modo === valor ? " on" : ""}`}
                onClick={() => onFilterChange("vistaMultiTec", valor)}
              >
                {texto}
              </button>
            ))}
          </div>
          {modo === "acumulado"
            ? cuerpoTecnico(grupo)
            : sel.map((t, i) => (
                <details key={t} className="multi-b" open={i === 0}>
                  <summary>{gestor(dim.tecs[t])}</summary>
                  {cuerpoTecnico(A.tec.get(t))}
                </details>
              ))}
        </>
      );
    }

    return (
      <>
        <SelectorMultiple
          etiqueta={V.tecnico || "Técnico"}
          opciones={opciones}
          elegidos={sel}
          onCambio={(lista) => onFilterChange("tecs", lista)}
        />
        {body}
      </>
    );
  };

  // --- 3. RECOMENDADOR PANEL ---
  const renderRecomendador = () => {
    const bopts = [...A.barrio.entries()]
      .sort((a, b) => b[1].tot - a[1].tot)
      .map(([b]) => (
        <option key={b} value={b}>
          {barrioName(b)} — {barrioMuni(b)}
        </option>
      ));

    const topts = dim.tipos.map((t, i) => (
      <option key={i} value={i}>
        {t}
      </option>
    ));

    let body = (
      <p className="empty">
        Elige un barrio y un {V.tipoOsMin || "tipo de orden"} para recibir la asignación sugerida.
      </p>
    );

    if (st.selBarrio != null) {
      const tp = st.tipo === "" ? -1 : +st.tipo;
      const rt = recommend(st.selBarrio, tp, "tec");
      const rb = recommend(st.selBarrio, tp, "brig");

      const card = (r, i, kind) => (
        <div key={i} className={`rec ${i === 0 ? "best" : ""}`}>
          <div className="rec-h">
            <b style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              {i === 0 && (
                <Star size={12} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
              )}
              {gestor(r.name)}
            </b>
            <span 
              className={`conf ${r.conf.toLowerCase()}`}
              title={`La confianza estadística se calcula según la cantidad de ${V.ordenesMin || "ordenes"} comparables:\n• Alta: 30 o más ${V.ordenesMin || "ordenes"}\n• Media: 10 a 29 ${V.ordenesMin || "ordenes"}\n• Baja: menos de 10 ${V.ordenesMin || "ordenes"}`}
              style={{ cursor: "help", textDecoration: "underline dotted", display: "inline-flex", alignItems: "center", gap: "2px" }}
            >
              Confianza {r.conf} <Info size={11} strokeWidth={2.2} style={{ opacity: 0.8 }} aria-hidden="true" />
            </span>
          </div>
          <div className="rec-m">
            <span>
              <b>{pct(r.efAdj)}%</b> {V.sinAjuste ? "efectividad" : "efect. ajustada"}
            </span>
            <span>
              <b>{num(r.den)}</b> {V.ordenesMin || "ordenes"} comparables
            </span>
            <span>
              <b>{num(r.pe)}</b> perdidas
            </span>
            <span>
              Última:{" "}
              {r.last >= 0 ? dayLabel(Math.floor(r.last / 1440)) : "—"}
            </span>
          </div>
          <div className="rec-s">
            Base: {r.scope} &middot; puntaje Wilson {pct(r.score)}
          </div>
        </div>
      );

      body = (
        <>
          <h3>{V.tecnico || "Técnico"} recomendado</h3>
          {rt.length ? (
            <div className="recs">
              {rt.slice(0, 4).map((r, i) => card(r, i, "tec"))}
            </div>
          ) : (
            <p className="empty">
              Muestra insuficiente: no hay suficientes {V.ordenesMin || "ordenes"} comparables para recomendar con fiabilidad.
            </p>
          )}

          <h3>{V.brigada || "Brigada"} {V.sinAjuste ? "recomendado" : "recomendada"}</h3>
          {rb.length ? (
            <div className="recs">
              {rb.slice(0, 3).map((r, i) => card(r, i, "brig"))}
            </div>
          ) : (
            <p className="empty">Muestra insuficiente.</p>
          )}

          <p className="hint">
            El puntaje usa el <b>límite inferior de Wilson (95%)</b> sobre la
            efectividad{V.sinAjuste ? "." : ` ajustada. Las causas fuera de control no penalizan al ${V.tecnicoMin || "técnico"}.`}
          </p>
        </>
      );
    }

    return (
      <>
        <div className="sel-wrap">
          <label>Barrio</label>
          <select
            id="recBarrio"
            value={st.selBarrio ?? ""}
            onChange={(e) =>
              onFilterChange("selBarrio", e.target.value === "" ? null : +e.target.value)
            }
          >
            <option value="">— elegir —</option>
            {bopts}
          </select>
        </div>
        <div className="sel-wrap">
          <label>{V.tipoOs || "Tipo de orden"}</label>
          <select
            id="recTipo"
            value={st.tipo}
            onChange={(e) => onFilterChange("tipo", e.target.value)}
          >
            <option value="">Todos</option>
            {topts}
          </select>
        </div>
        {body}
      </>
    );
  };

  const renderNic = () => {
    const nicVal = st.selNic;
    if (!nicVal) {
      return (
        <p className="empty">
          Ningún NIC seleccionado. Haz clic en un punto GPS real en el mapa para ver su historial detallado.
        </p>
      );
    }

    const {
      E_raw, C_raw, S_raw, T_raw, DAY_raw, M_raw, ORD_raw, B_raw, NIC_raw,
      GEST_RAW, RG_RAW, COB_RAW, G_raw, months, availableMonths
    } = st;
    const history = [];

    if (NIC_raw) {
      const N = NIC_raw.length;
      const targetNic = String(nicVal).trim();
      for (let i = 0; i < N; i++) {
        if (String(NIC_raw[i]).trim() === targetNic) {
          history.push({
            idx: i,
            ord: ORD_raw[i],
            est: E_raw[i],
            gest: dim.gests && GEST_RAW ? dim.gests[GEST_RAW[i]] : null,
            resultado: dim.resultados && RG_RAW ? dim.resultados[RG_RAW[i]] : null,
            cobranza: dim.cobranza && COB_RAW ? dim.cobranza[COB_RAW[i]] : null,
            plan: dim.brigs && G_raw ? dim.brigs[G_raw[i]] : null,
            causa: dim.causas ? dim.causas[C_raw[i]] : null,
            sub: dim.subs ? dim.subs[S_raw[i]] : null,
            tec: gestor(dim.tecs[T_raw[i]]),
            m: M_raw[i],
            day: DAY_raw[i],
            barrio: barrioName(B_raw[i]),
            muni: barrioMuni(B_raw[i])
          });
        }
      }
    }

    history.sort((a, b) => b.m - a.m);
    const latest = history[0] || {};
    const clientInfo = { ...latest };

    const esCobros = V.conFallidas === false;

    const tableRows = history.map((h) => {
      const hh = String(Math.floor((h.m % 1440) / 60)).padStart(2, "0");
      const mm = String(h.m % 60).padStart(2, "0");
      const estClass = h.est === 0 ? "ok" : h.est === 1 ? "warn" : "bad";

      if (esCobros) {
        return [
          <span className="mono" style={{ fontSize: "10.5px" }}>{h.ord || "—"}</span>,
          <span style={{ display: "block", fontSize: "10.5px", lineHeight: "1.2" }}>
            <b style={{ color: "var(--tx)" }}>{h.plan || "—"}</b>
            {h.sub && h.sub !== h.plan && <span style={{ display: "block", fontSize: "9.5px", color: "var(--dim)", marginTop: "1px" }}>{h.sub}</span>}
          </span>,
          <span className={estClass} style={{ fontWeight: "600", fontSize: "10.5px", lineHeight: "1.2" }}>
            {h.resultado || h.gest || (dim.estados && dim.estados[h.est]) || "—"}
            {h.cobranza && h.cobranza !== "Sin dato" && (
              <span style={{ display: "block", fontSize: "9.5px", fontWeight: 400, color: "var(--dim)", marginTop: "1px" }}>
                {h.cobranza}
              </span>
            )}
          </span>,
          `${dayLabel(h.day)} ${hh}:${mm}`,
          h.tec
        ];
      }

      return [
        <span className="mono" style={{ fontSize: "10.5px" }}>{h.ord || "—"}</span>,
        <span className={estClass} style={{ fontWeight: "600" }}>
          {h.gest || dim.estados[h.est]}
          {h.gest && <span style={{ display: "block", fontSize: "10px", fontWeight: 400, color: "var(--dim)" }}>{dim.estados[h.est]}</span>}
        </span>,
        `${dayLabel(h.day)} ${hh}:${mm}`,
        <span style={{ display: "block", fontSize: "10px", lineHeight: "1.1" }}>
          <b>{h.causa}</b>
          <span style={{ display: "block", color: "var(--dim)", marginTop: "2px" }}>{h.sub}</span>
        </span>,
        h.tec
      ];
    });

    const tableHeads = esCobros
      ? [V.orden || "Orden", "Plan de acción", "Resultado gestión", "Fecha/Hora", V.tecnico || "Gestor"]
      : [V.orden || "Orden", "Estado", "Fecha/Hora", "Clasificación", V.tecnico || "Técnico"];

    return (
      <>
        <div className="pb-head" style={{ marginBottom: "14px" }}>
          <div
            className="pb-risk"
            style={{
              background: "var(--badge-bg)",
              width: "38px",
              height: "38px",
              fontSize: "13px",
              flex: "0 0 38px",
              color: "var(--badge-tx)",
              fontWeight: "600"
            }}
          >
            NIC
          </div>
          <div>
            <h2 style={{ fontSize: "15px" }}>NIC {nicVal}</h2>
            <span className="pb-sub">
              {clientInfo.barrio || "—"} &middot; {clientInfo.muni || "—"}
            </span>
          </div>
        </div>

        {/* Métricas operativas del NIC: Plan de acción, Resultado de la gestión */}
        <div className="mini-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginBottom: "14px" }}>
          <div className="mini">
            <span>Plan de acción</span>
            <b style={{ fontSize: "12px", whiteSpace: "normal", wordBreak: "break-word" }}>
              {clientInfo.plan || clientInfo.sub || "—"}
            </b>
            {clientInfo.sub && clientInfo.plan && clientInfo.sub !== clientInfo.plan && (
              <span style={{ fontSize: "9px", marginTop: "2px", textTransform: "none", color: "var(--dim)" }}>
                {clientInfo.sub}
              </span>
            )}
          </div>
          <div className="mini">
            <span>Resultado gestión</span>
            <b
              style={{ fontSize: "12px", whiteSpace: "normal", wordBreak: "break-word" }}
              className={clientInfo.est === 0 ? "ok" : clientInfo.est === 1 ? "warn" : "bad"}
            >
              {clientInfo.resultado || clientInfo.gest || (dim.estados && dim.estados[clientInfo.est]) || "—"}
            </b>
            {clientInfo.cobranza && clientInfo.cobranza !== "Sin dato" && (
              <span style={{ fontSize: "9px", marginTop: "2px", textTransform: "none", color: "var(--dim)" }}>
                {clientInfo.cobranza}
              </span>
            )}
          </div>
        </div>

        {/* 3. Conteo de Visitas */}
        <div className="mini-grid tres" style={{ marginBottom: "14px" }}>
          <div className="mini">
            <span>Visitas</span>
            <b>{history.length}</b>
          </div>
          <div className="mini">
            <span>Efectivas</span>
            <b className="ok">{history.filter(h => h.est === 0).length}</b>
          </div>
                    <div className="mini">
            <span>Perdidas</span>
            <b className="bad">{history.filter(h => h.est === 2).length}</b>
          </div>
        </div>

        <h3>Historial de {V.ordenes || "Órdenes"}</h3>
        <div className="tbl-wrap" style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--pan2)", maxHeight: "400px" }}>
          {miniTable(tableRows, tableHeads)}
        </div>
      </>
    );
  };

  return (
    <aside id="right">
      <div className="ph">
        <button
          className={`ptab ${st.tab === "barrio" ? "on" : ""}`}
          onClick={() => onFilterChange("tab", "barrio")}
        >
          Análisis de barrio
        </button>
        <button
          className={`ptab ${st.tab === "tecnico" ? "on" : ""}`}
          onClick={() => onFilterChange("tab", "tecnico")}
        >
          Cobertura del {V.tecnicoMin || "técnico"}
        </button>
        <button
          className={`ptab ${st.tab === "recomendador" ? "on" : ""}`}
          onClick={() => onFilterChange("tab", "recomendador")}
        >
          Recomendador
        </button>
        {st.selNic && (
          <button
            className={`ptab ${st.tab === "nic" ? "on" : ""}`}
            onClick={() => onFilterChange("tab", "nic")}
          >
            Historial del NIC
          </button>
        )}
      </div>
      <div id="panelBody">
        {st.tab === "barrio" && renderBarrio()}
        {st.tab === "tecnico" && renderTecnico()}
        {st.tab === "recomendador" && renderRecomendador()}
        {st.tab === "nic" && renderNic()}
      </div>
    </aside>
  );
}