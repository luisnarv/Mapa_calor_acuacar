"use client";

import React from "react";
import { ChevronRight, MapPin, Search } from "lucide-react";

import { sinTildes } from "@/components/SelectorMultiple";

// Con cientos de barrios no se pintan todos: se muestran los primeros que cuadran y se
// invita a escribir, igual que SelectorMultiple.
const MAX_BARRIOS = 300;

const num = (n) => (n || 0).toLocaleString("es-CO");
const nombreBarrio = (bkey) => (bkey || "").split(" | ").pop();

/**
 * Zona › Municipio › Corregimiento › Barrio en un solo control.
 *
 * Reemplaza las píldoras sueltas de zona y barrio. Todo se aplica al instante, sin botón
 * «Aplicar», como el resto de filtros de la barra.
 *
 * Las opciones salen de `avail`, que cuenta las órdenes de cada valor bajo el resto de
 * filtros (los Map `zona`, `muni`, `corr` y `barrio`): solo se ofrece lo que tiene datos.
 *
 * Acuacar tiene un solo municipio (Cartagena): la columna de municipio se oculta y, sin ella,
 * el corregimiento y los barrios están disponibles desde el principio. El corregimiento sale
 * del GPS contra `corregimientos.geojson`; sin él (payload viejo) también se oculta.
 *
 * @param {object} st Estado del tablero (`zona`, `muni`, `corr`, `barrios`).
 * @param {object} dim Catálogos (`zonas`, `munis`, `corrs`, `barrios`).
 * @param {object} avail Conteos por opción bajo los demás filtros.
 * @param {(clave: string, valor: string) => void} onFilterChange Aplica la cascada del tablero.
 * @param {(lista: number[]) => void} onBarrios Deja la selección de barrios en `lista`.
 */
export default function FiltroUbicacion({ st, dim, avail, onFilterChange, onBarrios }) {
  const [abierto, setAbierto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const cajaRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const buscaRef = React.useRef(null);
  // Distancia del panel al borde superior: se mide bajo la barra al abrir. El panel es
  // `fixed` y centrado porque anclado a la píldora (que está a la izquierda) se salía por
  // la derecha en pantallas de ~1000 px y dejaba parte sin verse.
  const [arriba, setArriba] = React.useState(48);

  const barrios = React.useMemo(() => st.barrios || [], [st.barrios]);
  const puestoZona = st.zona !== "";
  const puestoMuni = st.muni !== "";
  const puestoCorr = st.corr !== "";
  const puesto = puestoZona || puestoMuni || puestoCorr || barrios.length > 0;

  // Una columna con una sola opción no filtra nada: se oculta.
  const hayMuni = (dim.munis?.length || 0) > 1;
  const hayCorr = (dim.corrs?.length || 0) > 1;
  // Sin columna de municipio no hay nada que elegir antes de corregimiento y barrio.
  const listo = puestoMuni || !hayMuni;

  let c = 0;
  const colZona = c++;
  const colMuni = hayMuni ? c++ : -1;
  const colCorr = hayCorr ? c++ : -1;
  const colBarrio = c++;
  const columnas = c;

  const cerrar = React.useCallback((devolverFoco = true) => {
    setAbierto(false);
    setBusca("");
    if (devolverFoco) cajaRef.current?.querySelector(".hd-pill")?.focus();
  }, []);

  // Clic fuera cierra; en captura, para que el clic que abre otra píldora no se pierda.
  React.useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => {
      if (!cajaRef.current?.contains(e.target)) cerrar(false);
    };
    document.addEventListener("mousedown", fuera, true);
    return () => document.removeEventListener("mousedown", fuera, true);
  }, [abierto, cerrar]);

  React.useLayoutEffect(() => {
    if (!abierto) return;
    const medir = () => {
      const caja = cajaRef.current?.getBoundingClientRect();
      if (caja) setArriba(Math.round(caja.bottom) + 6);
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [abierto]);

  // `preventScroll`: sin él, enfocar el buscador desplaza la página si el panel aún no está
  // donde va, y se ve como un salto al abrir.
  React.useEffect(() => {
    if (abierto) buscaRef.current?.focus({ preventScroll: true });
  }, [abierto]);

  const q = sinTildes(busca.trim());
  const cuadra = (texto) => !q || sinTildes(texto).includes(q);

  const opciones = (nombres, conteos) =>
    nombres
      .map((texto, valor) => ({ valor, texto, n: conteos.get(valor) }))
      .filter((o) => o.n > 0 && cuadra(o.texto));

  const zonas = opciones(dim.zonas, avail.zona);
  const munis = hayMuni ? opciones(dim.munis, avail.muni) : [];
  const corrs = hayCorr && listo ? opciones(dim.corrs, avail.corr) : [];

  const { barriosOp, barriosTotal } = React.useMemo(() => {
    if (!listo) return { barriosOp: [], barriosTotal: 0 };
    const elegidos = new Set(barrios);
    const todos = [...avail.barrio.entries()]
      .map(([valor, n]) => ({ valor, n, texto: nombreBarrio(dim.barrios[valor]) }))
      .filter((o) => elegidos.has(o.valor) || cuadra(o.texto))
      .sort((a, b) => a.texto.localeCompare(b.texto, "es"));
    return { barriosOp: todos.slice(0, MAX_BARRIOS), barriosTotal: todos.length };
    // `cuadra` depende solo de `q`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail.barrio, dim.barrios, listo, barrios, q]);

  // Ruta de lo elegido: «C05 › BAYUNCA › Bocagrande». Con varios barrios el último tramo se
  // resume en «N barrios».
  const ruta = [
    puestoZona ? dim.zonas[+st.zona] : null,
    puestoMuni && hayMuni ? dim.munis[+st.muni] : null,
    puestoCorr ? dim.corrs?.[+st.corr] : null,
    barrios.length > 1 ? `${barrios.length} barrios` : barrios.length === 1 ? nombreBarrio(dim.barrios[barrios[0]]) : null
  ].filter(Boolean);

  // Pie: órdenes y barrios de la selección más específica. Cada conteo de `avail` ya trae
  // aplicados los demás niveles, así que el del nivel más profundo es el de la selección.
  const resumen = React.useMemo(() => {
    let ordenes;
    if (barrios.length) ordenes = barrios.reduce((a, b) => a + (avail.barrio.get(b) || 0), 0);
    else if (puestoCorr) ordenes = avail.corr.get(+st.corr) || 0;
    else if (puestoMuni) ordenes = avail.muni.get(+st.muni) || 0;
    else if (puestoZona) ordenes = avail.zona.get(+st.zona) || 0;
    else ordenes = [...avail.zona.values()].reduce((a, n) => a + n, 0);

    // Los barrios con órdenes, no el catálogo entero: debe coincidir con lo que se ve en la columna.
    const nBarrios = barrios.length || avail.barriosSel.size;
    return { ordenes, nBarrios };
  }, [avail, barrios, st.zona, st.muni, st.corr, puestoZona, puestoMuni, puestoCorr]);

  const limpiar = () => {
    // Quitar la zona limpia en cascada municipio, corregimiento y barrios.
    onFilterChange("zona", "");
  };

  const alternarBarrio = (b) =>
    onBarrios(barrios.includes(b) ? barrios.filter((x) => x !== b) : [...barrios, b]);

  // Teclado: ↑ ↓ dentro de la columna, ← → entre columnas, Esc cierra.
  const filasDe = (col) => [...panelRef.current.querySelectorAll(`[data-col="${col}"]`)];
  const teclas = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return;
    }
    const actual = e.target.dataset?.col;
    if (e.key === "ArrowDown" && e.target === buscaRef.current) {
      e.preventDefault();
      filasDe(0)[0]?.focus();
      return;
    }
    if (actual === undefined) return;
    const col = +actual;
    const filas = filasDe(col);
    const i = filas.indexOf(e.target);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      filas[i + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const destino = col + (e.key === "ArrowRight" ? 1 : -1);
      const lista = destino >= 0 && destino < columnas ? filasDe(destino) : [];
      (lista.find((f) => f.classList.contains("on")) || lista[0])?.focus();
    } else if (e.key === "Enter" && e.target.type === "checkbox") {
      e.preventDefault();
      e.target.click();
    }
  };

  const fila = (col, o, activa, onClick) => (
    <button
      key={o.valor}
      type="button"
      data-col={col}
      className={`ub-fila${activa ? " on" : ""}`}
      aria-pressed={activa}
      onClick={onClick}
    >
      <span className="ub-nombre">{o.texto}</span>
      <span className="ub-n">{num(o.n)}</span>
      <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );

  const filaTodas = (col, texto, activa, onClick) => (
    <button
      type="button"
      data-col={col}
      className={`ub-fila${activa ? " on" : ""}`}
      aria-pressed={activa}
      onClick={onClick}
    >
      <span className="ub-nombre">{texto}</span>
    </button>
  );

  return (
    <div className="hd-f" ref={cajaRef}>
      <button
        type="button"
        className={`hd-pill ub-pill${puesto ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={abierto}
        onClick={() => (abierto ? cerrar(false) : setAbierto(true))}
      >
        <MapPin size={13} strokeWidth={2.2} aria-hidden="true" />
        <span className="hd-pill-k">Ubicación</span>
        {puesto && <span className="hd-pill-v">: {ruta.join(" › ")}</span>}
      </button>

      {/* Quitar es un botón aparte, como en FiltroPildora: abrir y limpiar no se pelean el clic. */}
      {puesto && (
        <button
          type="button"
          className="hd-pill-x"
          aria-label="Quitar el filtro de ubicación"
          onClick={(e) => {
            e.stopPropagation();
            limpiar();
          }}
        />
      )}

      {abierto && (
        <div
          className="hd-pop ub-pop"
          role="dialog"
          aria-label="Ubicación"
          ref={panelRef}
          onKeyDown={teclas}
          style={{ top: arriba }}
        >
          <div className="ub-buscar">
            <Search size={13} strokeWidth={2.2} aria-hidden="true" />
            <input
              ref={buscaRef}
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar zona, municipio, corregimiento o barrio…"
              aria-label="Buscar ubicación"
            />
          </div>

          <div className="ub-cols" style={{ gridTemplateColumns: `repeat(${columnas}, minmax(0,1fr))` }}>
            <div className="ub-col">
              <div className="ub-head">Zona ({zonas.length})</div>
              <div className="ub-lista">
                {filaTodas(colZona, "Todas las zonas", !puestoZona, () => onFilterChange("zona", ""))}
                {zonas.map((o) =>
                  fila(colZona, o, puestoZona && +st.zona === o.valor, () => onFilterChange("zona", String(o.valor)))
                )}
              </div>
            </div>

            {hayMuni && (
              <div className="ub-col">
                <div className="ub-head">Municipio ({munis.length})</div>
                <div className="ub-lista">
                  {filaTodas(colMuni, "Todos los municipios", !puestoMuni, () => onFilterChange("muni", ""))}
                  {munis.map((o) =>
                    fila(colMuni, o, puestoMuni && +st.muni === o.valor, () => onFilterChange("muni", String(o.valor)))
                  )}
                </div>
              </div>
            )}

            {hayCorr && (
              <div className="ub-col">
                <div className="ub-head">Corregimiento ({corrs.length})</div>
                <div className="ub-lista">
                  {listo ? (
                    <>
                      {filaTodas(colCorr, hayMuni ? "Todo el municipio" : "Todos los corregimientos", !puestoCorr, () =>
                        onFilterChange("corr", "")
                      )}
                      {corrs.map((o) =>
                        fila(colCorr, o, puestoCorr && +st.corr === o.valor, () => onFilterChange("corr", String(o.valor)))
                      )}
                    </>
                  ) : (
                    <div className="ub-vacio">Elige un municipio.</div>
                  )}
                </div>
              </div>
            )}

            <div className="ub-col">
              <div className="ub-head">
                <span>Barrio ({barriosTotal})</span>
                {barrios.length > 0 && (
                  <button type="button" className="sm-quitar" onClick={() => onBarrios([])}>
                    Quitar todos ({barrios.length})
                  </button>
                )}
              </div>
              <div className="ub-lista">
                {listo ? (
                  barriosOp.map((o) => {
                    const on = barrios.includes(o.valor);
                    return (
                      <label key={o.valor} className={`sm-item${on ? " on" : ""}`}>
                        <input
                          type="checkbox"
                          data-col={colBarrio}
                          checked={on}
                          onChange={() => alternarBarrio(o.valor)}
                        />
                        <span className="sm-nombre">{o.texto}</span>
                        <span className="sm-extra">{num(o.n)}</span>
                      </label>
                    );
                  })
                ) : (
                  <div className="ub-vacio">Elige un municipio para ver sus barrios.</div>
                )}
                {listo && barriosTotal > MAX_BARRIOS && (
                  <div className="ub-vacio">
                    Mostrando {MAX_BARRIOS} de {num(barriosTotal)}: escribe para acotar.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="ub-pie">
            <span>
              {num(resumen.ordenes)} órdenes · {num(resumen.nBarrios)} barrios en la selección
            </span>
            {puesto && (
              <button type="button" className="ub-limpiar" onClick={limpiar}>
                Limpiar ubicación
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
