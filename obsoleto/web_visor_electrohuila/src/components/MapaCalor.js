"use client";

/**
 * El mapa. Todo lo que dibuja Leaflet vive aquí.
 *
 * Reconstruido del visor SCR que sirvió de referencia, con la misma receta:
 *
 *  - **Basemap vectorial** de OpenFreeMap servido por maplibre-gl dentro de
 *    Leaflet (`@maplibre/maplibre-gl-leaflet`). Teselas vectoriales y no de
 *    imagen para que los nombres de calle se lean en cualquier zoom y para que
 *    el estilo se pueda recolorear por tema sin volver a pedir nada.
 *  - **Cuatro panes** con z-index fijo, de abajo arriba: calor, puntos,
 *    vectores (polígonos y marcadores) y selección. Sin esto el mapa de calor
 *    tapa los polígonos o al revés, según el orden en que se agreguen.
 *  - **Mapa de calor**: una capa `leaflet.heat` por estado (efectiva, fallida,
 *    perdida) con su propia rampa de color, para que se lea *qué* se concentra
 *    y no solo *cuánto*.
 *  - **Puntos sueltos en un canvas propio**: 400.000 `circleMarker` de Leaflet
 *    matan el navegador. Un solo canvas que se redibuja en `moveend` aguanta
 *    todo el histórico, con tope de 8.000 puntos pintados por cuadro.
 *  - **Marcadores por municipio**: radio según volumen, color según índice de
 *    riesgo, y un aro que late cuando el municipio pasa el umbral de foco.
 *
 * Lo que cambia respecto al original: la unidad de agregación es el municipio
 * (ver README — no hay geometría de barrio que cubra el área de Acuacar) y
 * la capa de «órdenes por ejecutar» no existe, porque este proyecto solo lee el
 * histórico.
 */

import { useEffect, useRef, useState } from "react";
// El orden importa: `leafletGlobal` deja `window.L` puesto y `leaflet.heat`, que
// es un plugin de los que se cuelgan del global, lo necesita al evaluarse.
import L from "@/lib/leafletGlobal";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";

import { BASEMAP, riskColor, useTheme } from "@/lib/tema";

// Encuadre de arranque, por si el payload no trae geometría: el centro del
// Cartagena. Lo normal es que el mapa se ajuste al territorio con `fitBounds`.
const CENTRO = [10.4, -75.5];
const ZOOM = 11;

// Margen en píxeles alrededor del territorio al encuadrar.
const MARGEN = 24;

// maplibre-gl saca la URL de su worker de `import.meta.url`; con el bundler de
// Next esa URL no es http(s) y la biblioteca devuelve una cadena vacía, así que
// el worker nunca carga y el basemap se queda en negro. Se apunta al que copia
// `scripts/copiar-worker-maplibre.mjs` en el postinstall.
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

/**
 * Punto de saturación del mapa de calor para un conjunto de puntos.
 *
 * `leaflet.heat` necesita saber qué densidad pinta del color más intenso. Con
 * un valor fijo, Neiva satura siempre y el resto del departamento nunca, así
 * que se calcula sobre los propios puntos: se agrupan en celdas del tamaño que
 * el radio del calor ocupa EN EL TERRENO al zoom actual, y se toma el
 * percentil 98 de esa distribución.
 *
 * Que la celda dependa del zoom es lo que hace que el calor se lea igual de
 * lejos que de cerca: al acercarse, la misma mancha cubre menos terreno, hay
 * menos puntos por celda, y el umbral baja con ella. Por eso hay que recalcular
 * en cada `zoomend`.
 */
function saturacion(puntos, map, radio) {
  if (puntos.length < 50) return Math.max(2, puntos.length);

  // Cuántos grados cubre el radio del calor a este zoom.
  const centro = map.getCenter();
  const p = map.latLngToContainerPoint(centro);
  const borde = map.containerPointToLatLng([p.x + radio, p.y + radio]);
  const dLat = Math.abs(borde.lat - centro.lat) || 1e-4;
  const dLon = Math.abs(borde.lng - centro.lng) || 1e-4;

  const celdas = new Map();
  for (const [la, lo] of puntos) {
    const k = `${Math.round(la / dLat)}:${Math.round(lo / dLon)}`;
    celdas.set(k, (celdas.get(k) || 0) + 1);
  }
  const v = [...celdas.values()].sort((a, b) => a - b);
  return Math.max(3, v[Math.min(v.length - 1, Math.floor(v.length * 0.98))]);
}

/** Caja que envuelve una lista de pares [lat, lon]. */
function cajaDePuntos(puntos) {
  let s = 90, n = -90, o = 180, e = -180;
  for (const [la, lo] of puntos || []) {
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo < o) o = lo;
    if (lo > e) e = lo;
  }
  return n > s && e > o ? [[s, o], [n, e]] : null;
}

/** Caja que envuelve todos los polígonos de una capa `{r: anillos}`. */
function cajaDe(poligonos) {
  let s = 90, n = -90, o = 180, e = -180;
  for (const poli of poligonos || []) {
    for (const anillos of poli.r) {
      for (const anillo of anillos) {
        for (const [la, lo] of anillo) {
          if (la < s) s = la;
          if (la > n) n = la;
          if (lo < o) o = lo;
          if (lo > e) e = lo;
        }
      }
    }
  }
  return n > s && e > o ? [[s, o], [n, e]] : null;
}


export default function MapaCalor({
  A,
  st,
  dim,
  geo,
  onSelectUnidad,
  dayLabel
}) {
  const contenedor = useRef(null);
  const mapa = useRef(null);
  const capaVectores = useRef(null);
  const capaMarcadores = useRef(null);
  const capaPuntos = useRef(null);
  const capasCalor = useRef({});
  const capaBase = useRef(null);
  // Un ÚNICO renderer de canvas para todos los vectores. Crear uno nuevo en
  // cada redibujado dejaba los anteriores colgados del mapa: al hacer zoom
  // intentaban repintarse sobre un canvas ya retirado y reventaban.
  const lienzo = useRef(null);
  // Vuelve a calibrar el calor cuando cambia el zoom. Se guarda para poder
  // soltar el listener antes de volver a dibujar.
  const recalibrar = useRef(null);

  const { theme, palette } = useTheme();

  // En desarrollo React monta, desmonta y vuelve a montar (StrictMode). Cada
  // montaje crea un mapa nuevo, así que el efecto que dibuja las capas tiene
  // que volver a correr: sin esta señal quedaba dibujando sobre el mapa
  // anterior, ya destruido.
  const [generacion, setGeneracion] = useState(0);

  // El efecto de montaje corre una sola vez; lee la geografía por referencia
  // para no tener que declararla como dependencia y rehacer el mapa.
  const geoRef = useRef(geo);
  useEffect(() => { geoRef.current = geo; }, [geo]);

  // El dibujo del canvas y los tooltips corren fuera de React (los llama
  // Leaflet en `moveend`), así que necesitan la versión viva del estado.
  const paletaViva = useRef(palette);
  const temaVivo = useRef(theme);
  const stVivo = useRef(st);
  useEffect(() => { paletaViva.current = palette; }, [palette]);
  useEffect(() => { temaVivo.current = theme; }, [theme]);
  useEffect(() => { stVivo.current = st; });

  const etiquetas = dim.etiquetas || {};
  const n0 = (v) => Math.round(v).toLocaleString("es-CO");
  const n1 = (v) => v.toFixed(1).replace(".", ",");
  const colorRiesgo = (r) => riskColor(palette, r);
  const nombreUnidad = (i) => (dim.barrios[i] || "").split(" | ")[1] || "";
  const nombrePadre = (i) => (dim.barrios[i] || "").split(" | ")[0] || "";
  const centroUnidad = (i) => geo.bc?.[i];

  /** "Reconexión (a los 3 días)" — los días solo aparecen si los hay. */
  const actividadTexto = (i) => {
    const s = stVivo.current;
    const nombre = dim.actividades?.[s.AC_raw[i]] ?? "—";
    const dias = s.DR_raw?.[i];
    if (dias == null || dias < 0) return nombre;
    const cuando = dias === 0 ? "el mismo día"
      : dias === 1 ? "al día siguiente"
      : `a los ${n0(dias)} días`;
    return `${nombre} (${cuando})`;
  };


  /** Ficha de un registro suelto, con la trazabilidad de su clasificación. */
  function abrirFichaRegistro(i) {
    const s = stVivo.current;
    const map = mapa.current;
    const P = paletaViva.current;
    const g = s.GR_raw[i];
    const hora = String(Math.floor((s.M_raw[i] % 1440) / 60)).padStart(2, "0");
    const min = String(s.M_raw[i] % 60).padStart(2, "0");
    const motivo = dim.motivoTexto?.[s.MO_raw[i]] || dim.motivos?.[s.MO_raw[i]] || "—";

    L.popup({ className: "ord-pop", maxWidth: 320, closeButton: true, autoPan: true })
      .setLatLng([s.lat(i), s.lon(i)])
      .setContent(`
        <div class="op-h" style="border-color:${P.st[g]}">
          <b>${etiquetas.orden || "Documento"} ${s.ORD_raw[i] || "—"}</b>
          <span class="op-e" style="color:${P.stText[g]}">${dim.estados[s.E_raw[i]]}</span>
        </div>
        <table class="op-t">
          <tbody>
            <tr><td>${etiquetas.nic || "Cuenta"}</td><td class="mono">${s.NIC_raw?.[i] || "—"}</td></tr>
            <tr><td>${etiquetas.unidad || "Barrio"}</td><td>${nombreUnidad(s.B_raw[i])} · Zona ${nombrePadre(s.B_raw[i])}</td></tr>
            <tr><td>Fecha</td><td>${dayLabel(s.DAY_raw[i])} a las ${hora}:${min}</td></tr>
            <tr><td>${etiquetas.tecs || "Funcionario"}</td><td>${dim.tecs[s.T_raw[i]]}</td></tr>
            <tr><td>${etiquetas.tipos || "Clase"}</td><td>${dim.tipos[s.O_raw[i]]}</td></tr>
            <tr><td>${etiquetas.tarifas || "Estrato"}</td><td>${dim.tarifas[s.F_raw[i]]}</td></tr>
            <tr><td>${etiquetas.susps || "Ubicación"}</td><td>${dim.susps[s.U_raw[i]]}</td></tr>
            <tr><td>${etiquetas.actividades || "Actividad"}</td><td>${actividadTexto(i)}</td></tr>
            <tr><td>${etiquetas.operaciones || "Operación"}</td><td>${dim.operaciones?.[s.OP_raw[i]] ?? "—"}</td></tr>
            <tr><td>${etiquetas.brigadas || "Brigada"}</td><td>${dim.brigadas?.[s.BR_raw[i]] ?? "—"}</td></tr>
          </tbody>
        </table>

        <div class="op-trz">
          <h5>Por qué quedó así</h5>
          <table class="op-t">
            <tbody>
              <tr><td>${etiquetas.causas || "Observación"}</td><td>${dim.causas[s.C_raw[i]]}</td></tr>
              <tr><td>${etiquetas.brigs || "Proceso"}</td><td>${dim.brigs[s.G_raw[i]]}</td></tr>
              <tr><td>${etiquetas.subs || "Suspensión en"}</td><td>${dim.subs[s.S_raw[i]]}</td></tr>
              <tr><td>Estado</td><td>${dim.estadosOrden?.[s.X_raw[i]] ?? "—"}</td></tr>
              <tr><td>Regla</td><td class="mono">${dim.reglas?.[s.RG_raw[i]] ?? "—"}</td></tr>
              <tr><td>Ubicación</td><td>${motivo}</td></tr>
            </tbody>
          </table>
        </div>

        <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px;">
          <button class="op-b" data-b="${s.U_unidad[i]}">Ver solo ${nombreUnidad(s.U_unidad[i])}</button>
        </div>
      `)
      .openOn(map);
  }

  /* ------------------------------------------------------------------ */
  /* 1. Creación del mapa (una sola vez)                                */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!contenedor.current) return;

    try {
      setWorkerUrl(WORKER_URL);
    } catch {
      /* si la versión de maplibre no lo expone, usa el suyo */
    }

    const map = L.map(contenedor.current, { zoomControl: false, preferCanvas: true })
      .setView(CENTRO, ZOOM);
    mapa.current = map;
    L.control.zoom({ position: "bottomright" }).addTo(map);

    // El área de Acuacar no cabe en un centro y un zoom fijos: se ajusta a
    // los límites reales que trae el payload y ese encuadre queda como tope de
    // alejamiento, para que no se pueda perder el territorio de vista.
    //
    // Hay que esperar a que el contenedor tenga tamaño: con 0x0 píxeles la
    // proyección de Leaflet devuelve NaN y `setMaxBounds` revienta.
    // Dos cajas distintas, a propósito:
    //   · la del territorio completo marca hasta dónde se puede desplazar y
    //     alejar — incluye San Vicente del Caguán, enorme y casi vacío;
    //   · la de los centroides es donde están de verdad los datos, y es la que
    //     se usa para encuadrar. Encuadrar sobre el territorio dejaba el Cartagena
    //     ocupando un tercio de la pantalla.
    const cajaTerritorio = cajaDe(geoRef.current?.bp);
    const caja = cajaDePuntos(geoRef.current?.bc) || cajaTerritorio;
    let encuadrado = false;
    // Mientras el usuario no haya movido el mapa, cada cambio de tamaño vuelve
    // a encuadrar: el panel lateral y la ventana se acomodan después del primer
    // pintado, y un encuadre calculado con el contenedor a medio crecer deja el
    // territorio diminuto.
    let tocado = false;
    let programatico = false;
    map.on("dragstart", () => { tocado = true; });
    map.on("zoomstart", () => { if (!programatico) tocado = true; });

    const encuadrar = () => {
      if (!caja || (encuadrado && tocado)) return false;
      // El contenedor tiene que medir algo antes de encuadrar. Con menos que
      // el doble del margen, `fitBounds` calcula un zoom infinito y a partir
      // de ahí todas las proyecciones de Leaflet devuelven NaN.
      const tam = map.getSize();
      if (tam.x < MARGEN * 4 || tam.y < MARGEN * 4) return false;
      const zoom = map.getBoundsZoom(caja, false, [MARGEN, MARGEN]);
      if (!Number.isFinite(zoom)) return false;
      programatico = true;
      map.fitBounds(caja, { padding: [MARGEN, MARGEN], animate: false });
      const limite = L.latLngBounds(cajaTerritorio || caja).pad(0.25);
      map.setMaxBounds(limite);
      map.setMinZoom(Math.max(
        4, map.getBoundsZoom(limite, false, [MARGEN, MARGEN]) - 1));
      programatico = false;
      const primera = !encuadrado;
      encuadrado = true;
      return primera;
    };

    capaBase.current = L.maplibreGL({ style: BASEMAP[temaVivo.current] }).addTo(map);
    const gl = capaBase.current.getMaplibreMap();
    gl.on("styleimagemissing", (e) => {
      // OpenFreeMap tiene una referencia rota a wood-pattern en su sprite.
      if (e.id === "wood-pattern") {
        gl.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      }
    });
    gl.on("styledata", () => recolorearBasemap(gl, temaVivo.current));

    // Orden de pintado. Leaflet usa 400 para los overlays, así que estos cuatro
    // quedan por encima del basemap y entre ellos en el orden que se quiere.
    const panes = [["heat", 410], ["pts", 420], ["vec", 430], ["sel", 440]];
    for (const [nombre, z] of panes) {
      map.createPane(nombre);
      map.getPane(nombre).style.zIndex = z;
    }

    lienzo.current = L.canvas({ pane: "vec", padding: 0.3 });
    capaVectores.current = L.layerGroup().addTo(map);
    capaMarcadores.current = L.layerGroup().addTo(map);

    // --- Canvas de puntos sueltos --------------------------------------
    const CapaPuntos = L.Layer.extend({
      onAdd(m) {
        this._c = L.DomUtil.create("canvas", "pt-canvas");
        this._c.style.pointerEvents = "none";
        m.getPane("pts").appendChild(this._c);
        m.on("moveend zoomend resize", this._draw, this);
        this._reset();
        this._draw();
      },
      onRemove(m) {
        m.off("moveend zoomend resize", this._draw, this);
        this._c.remove();
      },
      setPoints(pts) {
        this._pts = pts;
        if (this._c) {
          this._reset();
          this._draw();
        }
      },
      _reset() {
        const size = map.getSize();
        this._c.width = size.x;
        this._c.height = size.y;
        L.DomUtil.setPosition(this._c, map.containerPointToLayerPoint([0, 0]));
      },
      _draw() {
        if (!this._c) return;
        const s = stVivo.current;
        this._reset();
        const ctx = this._c.getContext("2d");
        ctx.clearRect(0, 0, this._c.width, this._c.height);
        if (!this._pts || !this._pts.length) return;

        const z = map.getZoom();
        const b = map.getBounds();
        const r = z >= 15 ? 5 : z >= 13 ? 4 : 3;
        ctx.globalAlpha = z >= 14 ? 0.9 : 0.65;

        const sur = b.getSouth(), norte = b.getNorth();
        const oeste = b.getWest(), este = b.getEast();
        const colores = paletaViva.current.st;
        ctx.strokeStyle = paletaViva.current.pointStroke;
        ctx.lineWidth = 1;

        let pintados = 0;
        for (const i of this._pts) {
          const la = s.lat(i), lo = s.lon(i);
          if (isNaN(la) || isNaN(lo) || la < sur || la > norte || lo < oeste || lo > este) continue;
          const p = map.latLngToContainerPoint([la, lo]);
          ctx.fillStyle = colores[s.E_raw[i]];
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, 6.283);
          ctx.fill();
          ctx.stroke();
          // Tope de seguridad: más allá de 8.000 puntos por cuadro el canvas
          // deja de aportar información y empieza a costar fluidez.
          if (++pintados >= 8000) break;
        }
        ctx.globalAlpha = 1;
      }
    });
    capaPuntos.current = new CapaPuntos();

    // --- Clic sobre el canvas: busca el punto más cercano ---------------
    const alHacerClic = (ev) => {
      const s = stVivo.current;
      const botonUnidad = ev.target.closest(".op-b");
      if (botonUnidad) {
        ev.stopPropagation();
        map.closePopup();
        if (botonUnidad.dataset.b) onSelectUnidad(+botonUnidad.dataset.b);
        return;
      }
      if (!map.hasLayer(capaPuntos.current) || !capaPuntos.current._pts?.length) return;

      const caja = map.getContainer().getBoundingClientRect();
      const x = ev.clientX - caja.left;
      const y = ev.clientY - caja.top;
      if (x < 0 || y < 0 || x > caja.width || y > caja.height) return;

      const objetivo = L.point(x, y);
      const vista = map.getBounds();
      let mejor = -1;
      let dist = 144; // 12 px de radio de captura
      for (const i of capaPuntos.current._pts) {
        const la = s.lat(i), lo = s.lon(i);
        if (isNaN(la) || isNaN(lo) || !vista.contains([la, lo])) continue;
        const p = map.latLngToContainerPoint([la, lo]);
        const d = (p.x - objetivo.x) ** 2 + (p.y - objetivo.y) ** 2;
        if (d < dist) { dist = d; mejor = i; }
      }
      if (mejor < 0) return;
      ev.stopPropagation();
      abrirFichaRegistro(mejor);
    };
    document.addEventListener("click", alHacerClic, true);

    // Leaflet mide mal el contenedor si el layout aún se está acomodando.
    let muerto = false;
    const revisarTamano = () => {
      if (muerto || !map._mapPane) return;
      map.invalidateSize({ animate: false });
      // Cuando el contenedor por fin mide algo, se encuadra y se pide un
      // redibujado: las capas que se intentaron añadir con el mapa a 0x0 no
      // llegaron a pintarse.
      if (encuadrar()) setGeneracion((n) => n + 1);
    };
    encuadrar();
    const raf = requestAnimationFrame(revisarTamano);
    const t1 = setTimeout(revisarTamano, 200);
    const t2 = setTimeout(revisarTamano, 600);
    let observador = null;
    let rafObs = null;
    if (typeof ResizeObserver !== "undefined" && contenedor.current) {
      let pendiente = false;
      observador = new ResizeObserver(() => {
        if (pendiente) return;
        pendiente = true;
        rafObs = requestAnimationFrame(() => { pendiente = false; revisarTamano(); });
      });
      observador.observe(contenedor.current);
    }

    setGeneracion((n) => n + 1);

    return () => {
      muerto = true;
      document.removeEventListener("click", alHacerClic, true);
      cancelAnimationFrame(raf);
      if (rafObs) cancelAnimationFrame(rafObs);
      clearTimeout(t1);
      clearTimeout(t2);
      if (observador) observador.disconnect();

      // El orden del desmontaje importa. `map.remove()` suelta sus capas en un
      // orden cualquiera: si le toca primero al renderer de canvas, los
      // polígonos que se quiten después le piden un repintado con su lienzo ya
      // destruido y revienta. Se vacían primero los vectores, luego se quita
      // el renderer y al final el mapa.
      capaVectores.current?.clearLayers();
      capaMarcadores.current?.clearLayers();
      Object.values(capasCalor.current).forEach((c) => {
        if (c && map.hasLayer(c)) map.removeLayer(c);
      });
      if (capaPuntos.current && map.hasLayer(capaPuntos.current)) {
        map.removeLayer(capaPuntos.current);
      }
      if (recalibrar.current) {
        map.off("zoomend", recalibrar.current);
        recalibrar.current = null;
      }
      if (lienzo.current && map.hasLayer(lienzo.current)) map.removeLayer(lienzo.current);
      map.remove();

      mapa.current = null;
      lienzo.current = null;
      capasCalor.current = {};
    };
    // Se monta una sola vez: los cambios de datos y de tema los aplican los
    // efectos de abajo, que no vuelven a crear el mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ */
  /* 2. Redibujado de capas: polígonos, calor, puntos y marcadores       */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapa.current;
    if (!map || !lienzo.current) return;
    // Sin tamaño, `leaflet.heat` falla al leer su canvas. Se espera al
    // siguiente `generacion`, que dispara el control de tamaño.
    const tam = map.getSize();
    if (!tam.x || !tam.y) return;

    if (recalibrar.current) {
      map.off("zoomend", recalibrar.current);
      recalibrar.current = null;
    }
    capaVectores.current.clearLayers();
    capaMarcadores.current.clearLayers();
    Object.values(capasCalor.current).forEach((c) => { if (c) map.removeLayer(c); });
    capasCalor.current = {};

    const renderer = lienzo.current;
    const P = palette;

    // --- Zonas operativas ---------------------------------------------
    if (st.layers.zpoly && geo.zp) {
      for (const z of geo.zp) {
        if (st.zona !== "" && dim.zonas[+st.zona] !== z.n) continue;
        L.polygon(z.r, {
          color: z.c || "#fff", weight: 2.2, opacity: 0.7,
          fillColor: z.c || "#fff", fillOpacity: 0.08, renderer
        })
          .bindTooltip(
            `<b>Zona ${z.n}</b><span class="tt-m">Zona operativa de Acuacar</span>`,
            { sticky: true, className: "tt" }
          )
          .addTo(capaVectores.current);
      }
    }

    // --- Perímetros urbanos y centros poblados -------------------------
    if (st.layers.mpoly && geo.mp) {
      const muniSel = st.muni === "" ? null : dim.munis[+st.muni];
      for (const p of geo.mp) {
        if (muniSel && p.m !== muniSel) continue;
        L.polygon(p.r, {
          color: P.perimetroStroke, weight: 1.2, opacity: 0.7,
          fill: false, dashArray: "4,3", renderer
        })
          .bindTooltip(
            `<b>${p.n}</b><span class="tt-m">${p.m} · perímetro urbano</span>`,
            { sticky: true, className: "tt" }
          )
          .addTo(capaVectores.current);
      }
    }

    // --- Municipios: el polígono de la unidad, coloreado por riesgo ----
    if ((st.layers.bpoly || st.selUnidad != null) && geo.bp) {
      const sel = st.selUnidad;
      for (const poli of geo.bp) {
        if (sel != null) {
          if (poli.b !== sel) continue;
        } else if (poli.b >= 0) {
          if (st.zona !== "" && dim.b_zona[poli.b] !== +st.zona) continue;
          if (st.muni !== "" && dim.b_muni[poli.b] !== +st.muni) continue;
        }
        const elegido = sel != null && poli.b === sel;
        const agg = poli.b >= 0 ? A.barrio.get(poli.b) : null;
        const color = agg ? colorRiesgo(agg.risk) : P.none;
        L.polygon(poli.r, {
          color: elegido ? P.markerSel : color,
          weight: elegido ? 2.6 : 1.1,
          opacity: elegido ? 0.95 : 0.65,
          fillColor: color,
          fillOpacity: elegido ? 0.18 : agg ? 0.12 : 0,
          interactive: !!agg,
          renderer
        })
          .bindTooltip(
            `<b>${poli.n}</b><span class="tt-m">Zona ${poli.m} · Barrio</span>` +
            (agg
              ? `<span class="tt-r" style="color:${riskColor(P, agg.risk, true)}">Riesgo ${agg.risk ?? "—"}</span>
                 <span>${n0(agg.tot)} registros · ${n1(agg.efPct)}% ejecutadas</span>
                 <span class="tt-p">sobre ${n0(agg.den)} que había que ejecutar</span>`
              : `<span class="tt-w">sin registros en el filtro actual</span>`),
            { sticky: true, className: "tt" }
          )
          .on("click", () => { if (poli.b >= 0) onSelectUnidad(poli.b); })
          .addTo(capaVectores.current);
      }
    }

    // --- Puntos: calor, canvas y marcadores ---------------------------
    const est = st.est;
    if (!est.some(Boolean)) {
      if (map.hasLayer(capaPuntos.current)) map.removeLayer(capaPuntos.current);
      return;
    }

    // Qué puntos entran. `gps` y `approx` filtran por la calidad de la
    // coordenada, y ese filtro vale también para el mapa de calor: con el 61 %
    // de los registros en el centroide de su municipio, un calor que los
    // incluyera sin avisar dibujaría 42 manchas donde no hay nada.
    // Una pila de puntos por grupo operativo: el calor colorea por grupo
    // aunque el filtro sea por resultado, para no superponer ocho rampas.
    const calor = dim.grupos.map(() => []);
    const sueltos = [];
    // Cuántos registros pasa el filtro cada municipio: es lo que dimensiona su
    // marcador, y se cuenta aquí para que coincida exacto con lo dibujado.
    const visiblesPorUnidad = new Map();
    const IDX = A.IDX || [];
    for (let j = 0; j < IDX.length; j++) {
      const i = IDX[j];
      const e = st.E_raw[i];
      if (!est[e]) continue;
      const g = st.GR_raw[i];
      const u = st.U_unidad[i];
      visiblesPorUnidad.set(u, (visiblesPorUnidad.get(u) || 0) + 1);
      if (st.selUnidad != null && st.U_unidad[i] !== st.selUnidad) continue;
      const aprox = st.AP_raw[i] === 1;
      if (aprox ? !st.layers.approx : !st.layers.gps) continue;

      if (st.layers.heat) {
        const la = st.lat(i), lo = st.lon(i);
        // La suspensión ejecutada pesa menos: es el grupo más numeroso y, sin
        // esto, su mancha tapa a las que no se pudieron ejecutar, que es justo
        // lo que se quiere ver.
        if (!isNaN(la) && !isNaN(lo)) calor[g].push([la, lo, g === 0 ? 0.6 : 1]);
      }
      sueltos.push(i);
    }

    if (st.layers.heat && L.heatLayer) {
      const radio = st.selUnidad != null ? 25 : 14;
      const difuso = st.selUnidad != null ? 15 : 20;
      for (let g = 0; g < calor.length; g++) {
        if (!calor[g].length) continue;
        capasCalor.current[g] = L.heatLayer(calor[g], {
          radius: radio, blur: difuso,
          max: saturacion(calor[g], map, radio),
          minOpacity: 0.42,
          // `maxZoom` en leaflet.heat NO es el zoom máximo: es el zoom a partir
          // del cual cada punto pesa 1. Por debajo, el peso se divide entre
          // 2^(maxZoom - zoom), así que un valor fijo dejaba el calor casi
          // invisible a escala departamental. Fijarlo al zoom actual lo deja
          // siempre en 1 y la intensidad la gobierna solo `max`.
          maxZoom: map.getZoom(),
          gradient: P.heat[g] || P.heat[P.heat.length - 1], pane: "heat"
        }).addTo(map);
      }

      // Al cambiar el zoom, la celda de referencia cambia de tamaño en el
      // terreno: se recalculan umbral y peso para que el color siga
      // significando lo mismo.
      recalibrar.current = () => {
        const z = map.getZoom();
        const r = stVivo.current.selUnidad != null ? 25 : 14;
        for (let g = 0; g < calor.length; g++) {
          const capa = capasCalor.current[g];
          if (!capa || !calor[g].length) continue;
          capa.setOptions({ max: saturacion(calor[g], map, r), maxZoom: z });
        }
      };
      map.on("zoomend", recalibrar.current);
    }

    if (st.layers.puntos && sueltos.length) {
      if (!map.hasLayer(capaPuntos.current)) capaPuntos.current.addTo(map);
      capaPuntos.current.setPoints(sueltos);
    } else if (map.hasLayer(capaPuntos.current)) {
      map.removeLayer(capaPuntos.current);
    }

    // --- Marcadores por municipio -------------------------------------
    if (st.layers.markers) {
      const sel = st.selUnidad;
      // Son 41 municipios y Neiva pesa la mitad del histórico: con un radio
      // absoluto todos saturaban el tope y el mapa dejaba de decir nada. El
      // tamaño se mide contra el municipio más cargado del filtro actual.
      let mayor = 1;
      for (const v of visiblesPorUnidad.values()) if (v > mayor) mayor = v;
      for (const [b, o] of A.barrio) {
        if (sel != null && b !== sel) continue;
        const centro = centroUnidad(b);
        if (!centro) continue;
        const visibles = visiblesPorUnidad.get(b) || 0;
        if (!visibles) continue;

        const elegido = sel != null && b === sel;
        const foco = o.risk != null && o.risk >= st.hotspot;
        const radio = 5 + 15 * Math.sqrt(visibles / mayor);
        const color = colorRiesgo(o.risk);
        const texto =
          `<b>${nombreUnidad(b)}</b><span class="tt-m">Zona ${nombrePadre(b)}</span>
           <span class="tt-r" style="color:${riskColor(P, o.risk, true)}">Riesgo ${o.risk ?? "—"}</span>
           <span>${n0(o.tot)} registros · ${n1(o.efPct)}% ejecutadas</span>
           <span>${n0(o.ef)} ejecutadas · ${n0(o.fa)} no fue posible</span>
           <span class="tt-p">${n0(o.pe)} fuera del alcance (no procedía o sin información)</span>` +
          (visibles !== o.tot
            ? `<span class="tt-p">mostrando ${n0(visibles)} de ${n0(o.tot)} en el filtro actual</span>`
            : "");

        // Un círculo invisible más grande recibe el ratón: el marcador
        // pintado es pequeño y apuntarle sería un ejercicio de precisión.
        const zonaClic = L.circleMarker(centro, {
          radius: Math.max(radio + 6, 12), opacity: 0, fillOpacity: 0,
          renderer, bubblingMouseEvents: false
        });
        zonaClic.bindTooltip(texto, { className: "tt", direction: "top" });
        zonaClic.on("click", () => onSelectUnidad(b));
        capaMarcadores.current.addLayer(zonaClic);

        if (elegido) {
          capaMarcadores.current.addLayer(L.circleMarker(centro, {
            radius: radio + 9, color: P.markerHalo || P.markerSel, weight: 2,
            opacity: 0.9, fill: false, renderer, interactive: false,
            className: "mk-hot"
          }));
        }

        capaMarcadores.current.addLayer(L.circleMarker(centro, {
          radius: elegido ? radio + 2 : radio,
          color: elegido || foco ? P.markerSel : color,
          weight: elegido ? 3 : foco ? 2.5 : 1.5,
          fillColor: color, fillOpacity: elegido ? 0.9 : 0.6,
          renderer, interactive: false,
          className: foco && !elegido ? "mk-hot" : ""
        }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generacion, A, st.layers, st.est, st.hotspot, st.selUnidad, st.zona,
      st.muni, st.agrupar, theme]);

  /* ------------------------------------------------------------------ */
  /* 3. Cambio de tema: se cambia el estilo del basemap y se repinta     */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!mapa.current) return;
    if (capaBase.current) capaBase.current.getMaplibreMap().setStyle(BASEMAP[theme]);
    if (capaPuntos.current?._c) capaPuntos.current._draw();
  }, [theme]);

  /* ------------------------------------------------------------------ */
  /* 4. Vuelo a la unidad seleccionada                                  */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapa.current;
    if (!map || st.selUnidad == null) return;
    const centro = geo.bc?.[st.selUnidad];
    if (centro) map.flyTo(centro, 11, { duration: 0.6 });  // marca el mapa como tocado
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.selUnidad, st.agrupar]);

  const vacio = !(st.est || []).some(Boolean);

  return (
    <div id="mapwrap">
      <div ref={contenedor} id="map" style={{ height: "100%", width: "100%" }} />
      <div id="mapEmpty" style={{ display: vacio ? "block" : "none" }}>
        <b>Ningún resultado seleccionado</b>
        <p>
          Marca al menos un resultado en el panel de capas para dibujar los
          registros en el mapa.
        </p>
      </div>
    </div>
  );
}

/**
 * Positron viene tan desaturado que en el visor se leía apagado. Se le sube el
 * fondo y se le devuelve color al agua y al verde, dejando las vías neutras
 * para que no compitan con el mapa de calor. Solo aplica al tema claro; el
 * estilo oscuro trae su propia paleta.
 */
function recolorearBasemap(gl, theme) {
  if (theme !== "light") return;
  for (const [capa, color] of Object.entries(BASEMAP.coloresClaro)) {
    const def = gl.getLayer(capa);
    if (!def) continue;
    const prop =
      def.type === "background" ? "background-color" :
      def.type === "fill" ? "fill-color" : "line-color";
    try {
      gl.setPaintProperty(capa, prop, color);
    } catch {
      /* el estilo cambió de nombres: no es crítico, el mapa igual se ve */
    }
  }
}
