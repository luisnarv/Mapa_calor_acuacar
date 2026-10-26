"use client";

import React from "react";

// Con cientos de opciones no se pintan todas: se muestran las primeras que cuadran con
// lo escrito y se invita a seguir escribiendo.
const MAX_VISIBLES = 80;

const sinTildes = (t) =>
  (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Lista con buscador y casillas para elegir varias opciones, dentro de la propia
 * pestaña (no en un desplegable): quien analiza varios técnicos quiere verlos marcados
 * mientras lee el detalle. Los elegidos van primero para poder quitarlos sin buscarlos.
 *
 * @param {string} etiqueta Qué se elige («Técnico», «Gestor»); también nombra el buscador.
 * @param {{valor: number, texto: string, extra?: string}[]} opciones
 * @param {number[]} elegidos Los `valor` marcados.
 * @param {(elegidos: number[]) => void} onCambio
 */
export default function SelectorMultiple({ etiqueta, opciones, elegidos, onCambio }) {
  const [busca, setBusca] = React.useState("");
  const marcados = React.useMemo(() => new Set(elegidos), [elegidos]);

  const { visibles, total } = React.useMemo(() => {
    const q = sinTildes(busca.trim());
    const cuadran = opciones.filter((o) => marcados.has(o.valor) || !q || sinTildes(o.texto).includes(q));
    cuadran.sort(
      (a, b) =>
        Number(marcados.has(b.valor)) - Number(marcados.has(a.valor)) ||
        a.texto.localeCompare(b.texto, "es")
    );
    return { visibles: cuadran.slice(0, MAX_VISIBLES), total: cuadran.length };
  }, [opciones, busca, marcados]);

  const alternar = (valor) =>
    onCambio(marcados.has(valor) ? elegidos.filter((v) => v !== valor) : [...elegidos, valor]);

  return (
    <div className="sm-wrap">
      <div className="sm-head">
        <label>{etiqueta}</label>
        {elegidos.length > 0 && (
          <button type="button" className="sm-quitar" onClick={() => onCambio([])}>
            Quitar todos ({elegidos.length})
          </button>
        )}
      </div>
      <input
        type="search"
        className="sm-buscar"
        placeholder={`Buscar ${etiqueta.toLowerCase()}…`}
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        aria-label={`Buscar ${etiqueta.toLowerCase()}`}
      />
      <div className="sm-lista">
        {visibles.map((o) => {
          const on = marcados.has(o.valor);
          return (
            <label key={o.valor} className={`sm-item${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => alternar(o.valor)} />
              <span className="sm-nombre">{o.texto}</span>
              {o.extra && <span className="sm-extra">{o.extra}</span>}
            </label>
          );
        })}
        {!total && <div className="sm-vacio">Ninguno coincide.</div>}
      </div>
      {total > MAX_VISIBLES && (
        <div className="sm-vacio">
          Mostrando {MAX_VISIBLES} de {total.toLocaleString("es-CO")}: escribe para acotar.
        </div>
      )}
    </div>
  );
}
