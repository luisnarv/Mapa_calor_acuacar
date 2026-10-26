"use client";

import React, { useEffect, useMemo, useState } from "react";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// "Octubre de 2026" -> "2026-10". Los filtros del tablero guardan la etiqueta.
const claveDeEtiqueta = (etiqueta) => {
  const [mes, , anio] = etiqueta.split(" ");
  const i = MESES.indexOf(mes);
  return i < 0 ? null : `${anio}-${String(i + 1).padStart(2, "0")}`;
};

const etiquetaCorta = (clave) => {
  const [anio, mes] = clave.split("-");
  return `${MESES[+mes - 1].slice(0, 3)} ${anio}`;
};

const mesAnterior = (clave) => {
  const [anio, mes] = clave.split("-").map(Number);
  return mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, "0")}`;
};

// La base trae "NOMBRE APELLIDO - 1002031754": la cédula sobra en una tabla de lectura.
const nombreDe = (gestor) => gestor.replace(/\s*-\s*\d+\s*$/, "").trim();

const METRICAS = [
  { id: "recaudo", texto: "Recaudo" },
  { id: "deuda", texto: "Deuda" },
  { id: "cuentas", texto: "Cuentas efectivas" },
  { id: "pctRecaudo", texto: "% Recaudo / deuda" },
];

// `ranking` la usa el menú Ranking: misma tabla, con posición, cuentas con pago y
// clic por gestor; en lugar del gráfico muestra `lateral`.
const MUESTRA_MINIMA = 30;

export default function VistaGestores({ tabla, palette: P, ranking = false, lateral = null, onPick, seleccion = null }) {
  const [orden, setOrden] = useState({ col: ranking ? "pctPago" : "recaudo", asc: false });
  const [metrica, setMetrica] = useState("recaudo");

  // La tabla llega ya calculada y filtrada desde el tablero (mismos filtros que el mapa).
  const vista = useMemo(() => {
    if (!tabla) return null;
    const filas = tabla.filas
      .filter((o) => o.gestionadas > 0)
      .map((o) => ({
        g: o.completo,
        completo: o.completo,
        nombre: nombreDe(o.completo),
        cuentas: o.ef,
        deuda: o.deuda,
        recaudo: o.recaudo,
        pago: o.pago,
        sinValidar: o.sinValidar,
        gestionadas: o.gestionadas,
        sinRecaudo: o.ef - o.pago,
        // % de recaudo = recaudo / deuda de las cuentas con gestión efectiva de ese mes.
        // Tope de 100: si un gestor cobró más de lo facturado (deuda vieja), el % muestra 100 y el
        // «Recaudo» en pesos sigue mostrando el total real.
        pctAct: o.aDeuda > 0 ? Math.min((o.aRec / o.aDeuda) * 100, 100) : null,
        pctAnt: o.pDeuda > 0 ? Math.min((o.pRec / o.pDeuda) * 100, 100) : null,
        pctPago: o.gestionadas ? (o.pago / o.gestionadas) * 100 : null,
      }));
    const suma = (k) => filas.reduce((a, o) => a + o[k], 0);
    const prom = (k) => {
      const v = filas.map((o) => o[k]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const total = {
      cuentas: suma("cuentas"),
      deuda: suma("deuda"),
      recaudo: suma("recaudo"),
      pago: suma("pago"),
      sinRecaudo: suma("sinRecaudo"),
      sinValidar: suma("sinValidar"),
      gestionadas: suma("gestionadas"),
      pctAnt: prom("pctAnt"),
      pctAct: prom("pctAct"),
    };
    return {
      filas, total, actual: tabla.actual, anterior: tabla.anterior, hayAnterior: tabla.hayAnterior,
      provisionalActual: tabla.provisionalActual, ignoraGestion: tabla.ignoraGestion,
    };
  }, [tabla]);

  if (!vista) return <p className="empty">Cargando…</p>;
  if (!vista.filas.length) return <p className="empty">Ningún gestor con cuentas gestionadas con los filtros actuales.</p>;

  const num = (v) => Math.round(v).toLocaleString("es-CO");
  const dinero = (v) => "$" + Math.round(v).toLocaleString("es-CO");
  // Sin potencial de cobro (meses que aún no lo traen o cuentas con 0) no se muestra «$0».
  const deuda = (v) => (v > 0 ? dinero(v) : "—");
  const pct = (v) => (v == null ? "—" : v.toFixed(1).replace(".", ",") + "%");

  // En el ranking un % sobre pocas cuentas no vale: los de muestra corta van al fondo.
  const valor = (o) =>
    ranking && orden.col === "pctPago" && o.gestionadas < MUESTRA_MINIMA ? -1 : o[orden.col] ?? -1;
  const filas = [...vista.filas].sort((a, b) => {
    const x = orden.col === "nombre" ? a.nombre : valor(a);
    const y = orden.col === "nombre" ? b.nombre : valor(b);
    const c = typeof x === "string" ? x.localeCompare(y, "es") : x - y;
    return orden.asc ? c : -c;
  });

  // «Sin validar» solo existe mientras la BD tenga acuerdos sin evaluar: sin ellos, no se muestra.
  const hayValidar = vista.total.sinValidar > 0;

  const cabecera = (col, texto, num_ = true) => (
    <th
      className={num_ ? "num" : ""}
      style={{ cursor: "pointer", whiteSpace: "nowrap" }}
      onClick={() => setOrden((o) => ({ col, asc: o.col === col ? !o.asc : false }))}
    >
      {texto}
      {orden.col === col ? (orden.asc ? " ↑" : " ↓") : ""}
    </th>
  );

  // Gráfico: los 12 primeros según la métrica elegida.
  const valorDe = (o) => (metrica === "pctRecaudo" ? o.pctAct ?? 0 : o[metrica] ?? 0);
  const top = [...vista.filas].sort((a, b) => valorDe(b) - valorDe(a)).slice(0, 12);
  const maximo = Math.max(...top.map(valorDe), 1);
  const formato = metrica === "recaudo" ? dinero : metrica === "deuda" ? deuda : metrica === "cuentas" ? num : pct;

  return (
    <div className="gv">
      <div className="gv-t">
        <table className="mt">
          <thead>
            <tr>
              {ranking && <th className="num">#</th>}
              {cabecera("nombre", "Gestor", false)}
              {cabecera("cuentas", "Cuentas con gestión efectiva")}
              {cabecera("deuda", "Deuda")}
              {cabecera("recaudo", "Recaudo")}
              {cabecera("pctAnt", `% Recaudo ${etiquetaCorta(vista.anterior)}`)}
              {cabecera("pctAct", `% Recaudo ${etiquetaCorta(vista.actual)}${vista.provisionalActual ? " (prov.)" : ""}`)}
              {ranking && cabecera("pago", "Con pago")}
              {ranking && cabecera("sinRecaudo", "Sin recaudo")}
              {ranking && hayValidar && cabecera("sinValidar", "Sin validar")}
              {ranking && cabecera("pctPago", "% con pago")}
            </tr>
          </thead>
          <tbody>
            {filas.map((o, i) => (
              <tr
                key={o.g}
                className={ranking ? `rk-fila${seleccion === o.completo ? " sel" : ""}` : undefined}
                onClick={ranking && onPick ? () => onPick(o.completo) : undefined}
                title={ranking ? "Ver solo las gestiones de este gestor en el mapa" : undefined}
              >
                {ranking && <td className="num">{i + 1}</td>}
                <td>{o.nombre}</td>
                <td className="num">{num(o.cuentas)}</td>
                <td className="num">{deuda(o.deuda)}</td>
                <td className="num">{dinero(o.recaudo)}</td>
                <td className="num">{pct(o.pctAnt)}</td>
                <td className="num">{pct(o.pctAct)}</td>
                {ranking && <td className="num">{num(o.pago)}</td>}
                {ranking && <td className="num">{num(o.sinRecaudo)}</td>}
                {ranking && hayValidar && <td className="num">{num(o.sinValidar)}</td>}
                {ranking && (
                  <td className="num">
                    {pct(o.pctPago)}
                    {o.gestionadas < MUESTRA_MINIMA ? "*" : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="gv-total">
              {ranking && <td></td>}
              <td>Total ({filas.length} gestores)</td>
              <td className="num">{num(vista.total.cuentas)}</td>
              <td className="num">{deuda(vista.total.deuda)}</td>
              <td className="num">{dinero(vista.total.recaudo)}</td>
              <td className="num">{pct(vista.total.pctAnt)}</td>
              <td className="num">{pct(vista.total.pctAct)}</td>
              {ranking && <td className="num">{num(vista.total.pago)}</td>}
              {ranking && <td className="num">{num(vista.total.sinRecaudo)}</td>}
              {ranking && hayValidar && <td className="num">{num(vista.total.sinValidar)}</td>}
              {ranking && (
                <td className="num">
                  {pct(vista.total.gestionadas ? (vista.total.pago / vista.total.gestionadas) * 100 : null)}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
        <p className="gv-nota">
          Cuentas con gestión efectiva = «Efectiva con pago» + «Efectiva sin recaudo». Deuda y recaudo son de esas
          cuentas; la deuda es el potencial de cobro del mes (p_cobro_hoy). El % Recaudo del mes elegido es la suma del recaudo de sus cuentas
          / la suma de p_cobro_hoy (solo cuentas con potencial); el del mes anterior usa esas mismas cuentas:
          su recaudo del mes previo / p_cobro_ant. Se calcula con los totales, no cuenta por cuenta, y se muestra
          con tope de 100 % (el total es el promedio de los gestores). Solo septiembre y octubre de 2026 traen potencial de cobro: en los demás meses
          la deuda y el % salen vacíos. Recaudo de la vista v_aire_cobros_nic_mes.
          {vista.provisionalActual && " (prov.) = el mes en curso aún no cierra: puede subir."}
          {vista.ignoraGestion && " El filtro «Gestión» no aplica a esta tabla (la vista no trae el tipo de gestión)."}
          {vista.ignoraResultado && " El filtro «Resultado gestión» y «Resultado cobranza» tampoco aplican a esta tabla (la vista no trae esas columnas)."}
          {ranking && (
            <>
              {" "}
              {hayValidar && "«Sin validar» (acuerdos aún sin validar) no está en las cuentas efectivas. "}* Menos de {MUESTRA_MINIMA}{" "}
              cuentas gestionadas: el porcentaje se calcula pero no entra al orden.
            </>
          )}
        </p>
      </div>

      {ranking ? (
        lateral && <div className="gv-c">{lateral}</div>
      ) : (
      <div className="gv-c">
        <div className="gv-ch">
          <b>Top 12 gestores</b>
          <select value={metrica} onChange={(e) => setMetrica(e.target.value)}>
            {METRICAS.map((m) => (
              <option key={m.id} value={m.id}>{m.texto}</option>
            ))}
          </select>
        </div>
        {top.map((o) => (
          <div key={o.g} className="gv-b" title={`${o.nombre}: ${formato(valorDe(o))}`}>
            <span className="gv-n">{o.nombre}</span>
            <i>
              {metrica === "pctRecaudo" && o.pctAnt != null && (
                <b style={{ width: `${(o.pctAnt / maximo) * 100}%`, background: P.serieRef, height: 4 }}></b>
              )}
              <b style={{ width: `${(valorDe(o) / maximo) * 100}%`, background: P.series[1] }}></b>
            </i>
            <span className="gv-v">{formato(valorDe(o))}</span>
          </div>
        ))}
        {metrica === "pctRecaudo" && (
          <p className="gv-nota">
            Barra gruesa: {etiquetaCorta(vista.actual)} · barra fina: {etiquetaCorta(vista.anterior)}
          </p>
        )}
      </div>
      )}
    </div>
  );
}
