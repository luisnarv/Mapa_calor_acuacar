"use client";

import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
if (typeof window !== "undefined") {
  window.L = L;
}
import "leaflet.heat";
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";

import { useTheme, riskColor as riskColorOf, BASEMAP } from "@/lib/theme";

const CAPAS_FRONTERA = ["boundary_country_z0-4", "boundary_country_z5-", "boundary_state"];

function ocultarFronteraMaritima(gl) {
  for (const capa of CAPAS_FRONTERA) {
    if (!gl.getLayer(capa)) continue;
    const filtro = gl.getFilter(capa);
    if (!filtro || JSON.stringify(filtro).includes('"maritime"')) continue;
    gl.setFilter(capa, ["all", filtro, ["!=", ["get", "maritime"], 1]]);
  }
}

/** Aclara los nombres de calle y de barrio del estilo oscuro.
 *
 * Se recorren los símbolos del estilo en vez de nombrar las capas una por una:
 * OpenFreeMap puede renombrarlas o agregar otras, y una lista fija dejaría
 * etiquetas grises sin que nadie se entere. Se descartan los símbolos que no
 * dibujan texto, que son solo icono.
 */
function aclararEtiquetas(gl) {
  const estilo = gl.getStyle();
  if (!estilo?.layers) return;
  const { texto, halo, grosorHalo } = BASEMAP.etiquetasOscuro;
  for (const capa of estilo.layers) {
    if (capa.type !== "symbol" || !capa.layout?.["text-field"]) continue;
    gl.setPaintProperty(capa.id, "text-color", texto);
    gl.setPaintProperty(capa.id, "text-halo-color", halo);
    gl.setPaintProperty(capa.id, "text-halo-width", grosorHalo);
  }
}

// Los retoques de color se aplican sobre el estilo ya cargado en vez de
// hospedar una copia propia del JSON: así OpenFreeMap sigue sirviendo el estilo
// y nosotros solo pisamos los colores que nos interesan.
function ajustarBasemap(gl, tema) {
  if (tema !== "light") {
    ocultarFronteraMaritima(gl);
    aclararEtiquetas(gl);
    return;
  }
  for (const [capa, color] of Object.entries(BASEMAP.coloresClaro)) {
    const def = gl.getLayer(capa);
    if (!def) continue;
    const prop =
      def.type === "background"
        ? "background-color"
        : def.type === "fill"
          ? "fill-color"
          : "line-color";
    gl.setPaintProperty(capa, prop, color);
  }
}

export default function LeafletMap({
  A,
  st,
  dim,
  geo,
  onSelectBarrio,
  onSelectNic,
  onFilterChange,
  dayLabel,
  ordenes,
  V = {}
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);

  // Layers refs so we can update them without recreating the map
  const hullLayerRef = useRef(null);
  const markerLayerRef = useRef(null);
  const ptLayerRef = useRef(null);
  const cargueLayerRef = useRef(null);
  const heatLayersRef = useRef({ 0: null, 1: null, 2: null });
  const basemapRef = useRef(null);
  const cargueHeatRef = useRef(null);

  // Paleta corporativa: el mapa pinta en canvas/Leaflet, donde var(--x) no se
  // resuelve, así que los colores vienen del módulo de tema.
  const { theme, palette: P } = useTheme();
  // Los dibujos en canvas y los popups viven fuera del render de React: leen la
  // paleta por referencia para no reconstruir el mapa en cada cambio de tema.
  const paletteRef = useRef(P);
  useEffect(() => {
    paletteRef.current = P;
  }, [P]);
  const temaRef = useRef(theme);
  useEffect(() => {
    temaRef.current = theme;
  }, [theme]);

  // El canvas de puntos GPS y el hit-test se definen UNA sola vez (en el effect
  // de init) y viven fuera del render de React. Sin este ref usarían un `st`
  // congelado del primer render: al cambiar de mes se hace lazy-load, rawArrays
  // se reconstruye y los índices se corren, así que `st.lat(i)` daba NaN y los
  // puntos no se actualizaban. Este ref siempre apunta al `st` vigente.
  const stRef = useRef(st);
  useEffect(() => {
    stRef.current = st;
  });

  const num = (val) => Math.round(val).toLocaleString("es-CO");
  const pct = (val) => val.toFixed(1).replace(".", ",");
  const riskColor = (r) => riskColorOf(P, r);

  const barrioName = (b) => dim.barrios[b].split(" | ")[1];
  const barrioMuni = (b) => dim.barrios[b].split(" | ")[0];

  // 1. Map Initialization
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Initialize leaflet map
    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      preferCanvas: true
    }).setView([10.40, -75.50], 12);

    mapRef.current = map;

    L.control.zoom({ position: "bottomright" }).addTo(map);

    // Sin esto maplibre deduce la URL de su worker de `import.meta.url`, que
    // al empaquetar con Turbopack no es http(s): se queda en cadena vacía, el
    // worker no arranca y el mapa sale en blanco sin lanzar ningún error. El
    // archivo lo deja en public/ el postinstall.
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    // El plugin lo cuelga de `tilePane`, debajo de los paneles de datos, y
    // publica en el control de Leaflet la atribución que declara el estilo.
    basemapRef.current = L.maplibreGL({
      style: BASEMAP[theme]
    }).addTo(map);
    // `isStyleLoaded()` sigue en false mientras saltan estos eventos, pero las
    // capas ya existen: por eso se pisa el color aquí y no se espera a `load`,
    // que con este estilo no llega a tiempo. Reaplicar de más es inocuo. El
    // manejador vive lo que el mapa y cubre también el cambio de tema, que
    // vuelve a disparar `styledata` al reemplazar el estilo.
    const gl = basemapRef.current.getMaplibreMap();
    gl.on("styledata", () => ajustarBasemap(gl, temaRef.current));

    // Panes
    map.createPane("heat");
    map.getPane("heat").style.zIndex = 410;
    map.createPane("pts");
    map.getPane("pts").style.zIndex = 420;
    map.createPane("vec");
    map.getPane("vec").style.zIndex = 430;
    // Las órdenes por ejecutar van encima de todo: son el trabajo de hoy, y si
    // el histórico las tapara habría que apagar capas para verlas.
    map.createPane("cargue");
    map.getPane("cargue").style.zIndex = 440;

    // Groups
    hullLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    cargueLayerRef.current = L.layerGroup().addTo(map);

    // Canvas Point Layer
    const vecRenderer = L.canvas({ pane: "vec", padding: 0.3 });

    const PointLayer = L.Layer.extend({
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
      setPoints(arr) {
        this._pts = arr;
        if (this._c) {
          this._reset();
          this._draw();
        }
      },
      _reset() {
        const s = map.getSize();
        this._c.width = s.x;
        this._c.height = s.y;
        const p = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._c, p);
      },
      _draw() {
        if (!this._c) return;
        const st = stRef.current; // usa siempre el estado vigente, no el capturado en init
        this._reset();
        const ctx = this._c.getContext("2d");
        ctx.clearRect(0, 0, this._c.width, this._c.height);
        if (!this._pts || !this._pts.length) {
          const aviso = document.getElementById("mapCap");
          if (aviso) aviso.style.display = "none";
          return;
        }

        const z = map.getZoom();
        const b = map.getBounds();
        const r = z >= 15 ? 5 : z >= 13 ? 4 : 3;
        ctx.globalAlpha = z >= 14 ? 0.9 : 0.65;

        const south = b.getSouth();
        const north = b.getNorth();
        const west = b.getWest();
        const east = b.getEast();

        const palette = paletteRef.current.st;
        ctx.strokeStyle = paletteRef.current.pointStroke;
        ctx.lineWidth = 1;

        // Tope de rendimiento. Se cuenta sobre los puntos visibles en el encuadre
        // (al acercar, caben todos) y las perdidas tienen prioridad: son pocas y son
        // lo que importa, así que nunca se recortan; el recorte cae sobre las
        // demás, muestreadas a paso parejo para no sesgar hacia las más antiguas.
        const MAX_POINTS = 8000;
        const visibles = [];
        let perdidas = 0;
        for (const i of this._pts) {
          const lat = st.lat(i);
          const lon = st.lon(i);
          if (isNaN(lat) || isNaN(lon)) continue;
          if (lat < south || lat > north || lon < west || lon > east) continue;
          visibles.push(i);
          if (st.E_raw[i] === 2) perdidas++;
        }
        const presupuesto = Math.max(0, MAX_POINTS - perdidas);
        const otras = visibles.length - perdidas;
        const paso = otras > presupuesto ? otras / presupuesto : 1;

        const pintar = (i) => {
          const p = map.latLngToContainerPoint([st.lat(i), st.lon(i)]);
          ctx.fillStyle = palette[st.E_raw[i]];
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, 6.283);
          ctx.fill();
          ctx.stroke();
        };
        // Las perdidas van al final para que queden encima de las demás.
        let drawn = 0;
        let acum = 0;
        for (const i of visibles) {
          if (st.E_raw[i] === 2) continue;
          acum += 1;
          if (acum < paso) continue;
          acum -= paso;
          pintar(i);
          drawn++;
        }
        for (const i of visibles) {
          if (st.E_raw[i] === 2) {
            pintar(i);
            drawn++;
          }
        }
        const aviso = document.getElementById("mapCap");
        if (aviso) {
          aviso.style.display = drawn < visibles.length ? "block" : "none";
          aviso.textContent = `Mostrando ${drawn.toLocaleString("es-CO")} de ${visibles.length.toLocaleString("es-CO")} puntos · acerca el mapa para ver el resto`;
        }
        ctx.globalAlpha = 1.0;
      }
    });

    ptLayerRef.current = new PointLayer();

    // Map flyto click listener for popup buttons and individual GPS hit tests
    const handleMapClick = (domEv) => {
      const st = stRef.current; // estado vigente para el hit-test y el popup
      // 1. Click on POPUP buttons
      const opBtn = domEv.target.closest(".op-b");
      if (opBtn) {
        domEv.stopPropagation();
        map.closePopup();
        if (opBtn.dataset.b) {
          onSelectBarrio(+opBtn.dataset.b);
        }
        return;
      }

      const opNic = domEv.target.closest(".op-n");
      if (opNic) {
        domEv.stopPropagation();
        map.closePopup();
        if (opNic.dataset.nic) {
          onSelectNic(opNic.dataset.nic);
        }
        return;
      }

      // 2. Individual GPS points hit test
      if (!map.hasLayer(ptLayerRef.current) || !ptLayerRef.current._pts || !ptLayerRef.current._pts.length) return;
      const rect = map.getContainer().getBoundingClientRect();
      const cx = domEv.clientX - rect.left;
      const cy = domEv.clientY - rect.top;
      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) return;

      const clickPt = L.point(cx, cy);
      const bounds = map.getBounds();
      let best = -1;
      let bestDist = 144; // 12px hit box radius squared

      for (const i of ptLayerRef.current._pts) {
        const la = st.lat(i);
        const lo = st.lon(i);
        if (isNaN(la) || isNaN(lo)) continue;
        if (!bounds.contains([la, lo])) continue;
        const p = map.latLngToContainerPoint([la, lo]);
        const dist = (p.x - clickPt.x) ** 2 + (p.y - clickPt.y) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }

      if (best < 0) return;
      domEv.stopPropagation();

      // Renders the single order popup
      const i = best;
      const e = st.E_raw[i];
      const hh = String(Math.floor((st.M_raw[i] % 1440) / 60)).padStart(2, "0");
      const mm = String(st.M_raw[i] % 60).padStart(2, "0");
      const ctrl = e === 0 ? true : dim.causa_ctrl[st.C_raw[i]] === 1;
      const PC = paletteRef.current;

      L.popup({ className: "ord-pop", maxWidth: 300, closeButton: true, autoPan: true })
        .setLatLng([st.lat(i), st.lon(i)])
        .setContent(`
          <div class="op-h" style="border-color:${PC.st[e]}">
            <b>${V.orden || "Orden"} ${st.ORD_raw[i] || "—"}</b>
            <span class="op-e" style="color:${PC.stText[e]}">${dim.estados[e]}</span>
          </div>
          <table class="op-t">
            <tbody>
              ${dim.gests && st.GEST_RAW ? `<tr><td>Resultado gestión</td><td><b>${dim.gests[st.GEST_RAW[i]]}</b></td></tr>` : ""}
              ${dim.resultados && st.RG_RAW ? `<tr><td>Recaudo</td><td>${dim.resultados[st.RG_RAW[i]]}</td></tr>` : ""}
              <tr><td>NIC</td><td class="mono">${st.NIC_raw ? st.NIC_raw[i] : "—"}</td></tr>
              <tr><td>${V.conFallidas === false ? "Motivo" : "Causa"}</td><td>${
                V.conFallidas === false && st.CA_RAW ? dim.anoms[st.CA_RAW[i]] : dim.causas[st.C_raw[i]]
              } ${ctrl ? "" : '<em class="op-nc">no controlable</em>'}</td></tr>
              ${
                V.conFallidas === false && st.SC_RAW && dim.subcausas[st.SC_RAW[i]] !== "Sin detalle"
                  ? `<tr><td>Según el acta</td><td>${dim.subcausas[st.SC_RAW[i]]}</td></tr>`
                  : ""
              }
              <tr><td>${V.subaccion || "Subacción"}</td><td>${dim.subs[st.S_raw[i]]}</td></tr>
              <tr><td>${V.tecnico || "Técnico"}</td><td>${
                V.conFallidas === false ? dim.tecs[st.T_raw[i]].replace(/\s*-\s*\d+\s*$/, "") : dim.tecs[st.T_raw[i]]
              }</td></tr>
              <tr><td>${V.brigada || "Brigada"}</td><td>${dim.brigs[st.G_raw[i]]}</td></tr>
              <tr><td>${V.tipoOs || "Tipo OS"}</td><td>${dim.tipos[st.O_raw[i]]}</td></tr>
              ${V.suspension ? `<tr><td>Suspensión</td><td>${dim.susps[st.U_raw[i]]}</td></tr>` : ""}
              <tr><td>Tarifa</td><td>${dim.tarifas[st.F_raw[i]]}</td></tr>
              <tr><td>Barrio</td><td>${barrioName(st.B_raw[i])} · ${barrioMuni(st.B_raw[i])}</td></tr>
              <tr><td>Ejecutada</td><td>${dayLabel(st.DAY_raw[i])} a las ${hh}:${mm}</td></tr>
              <tr><td>Ubicación</td><td>${st.APPROX_raw[i] ? "aproximada" : "GPS real"}</td></tr>
            </tbody>
          </table>
          <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px;">
            <button class="op-b" data-b="${st.B_raw[i]}">Ver análisis de ${barrioName(
              st.B_raw[i]
            )}</button>
            <button class="op-n" data-nic="${st.NIC_raw ? st.NIC_raw[i] : ""}">Ver historial de este NIC</button>
          </div>
        `)
        .openOn(map);
    };

    document.addEventListener("click", handleMapClick, true);

    // Ensure the map fills its container. Leaflet measures the container when
    // the map is created; if the container isn't at its final size yet (flex/grid
    // layout still settling) the map renders smaller than it should, leaving grey
    // gaps. We also re-measure whenever the container resizes — e.g. when the
    // details or layers panels are collapsed/expanded and the map area grows.
    // Bandera para no tocar el mapa tras desmontarlo. En StrictMode (dev) el
    // efecto se monta → limpia (map.remove(), que borra los panes) → remonta;
    // un invalidate() rezagado sobre el mapa removido leía map._mapPane
    // (undefined) y lanzaba "Cannot read properties of undefined (_leaflet_pos)".
    let destroyed = false;
    const invalidate = () => {
      if (destroyed || !map._mapPane) return;
      map.invalidateSize({ animate: false });
    };

    // Initial corrections after the first paints (covers the "not full size on
    // load" case).
    const raf = requestAnimationFrame(invalidate);
    const t1 = setTimeout(invalidate, 200);
    const t2 = setTimeout(invalidate, 600);

    // React to any later size change of the map container.
    let ro = null;
    let roRaf = null;
    if (typeof ResizeObserver !== "undefined" && mapContainerRef.current) {
      let pending = false;
      ro = new ResizeObserver(() => {
        // Defer to the next frame to avoid "ResizeObserver loop" warnings.
        if (pending) return;
        pending = true;
        roRaf = requestAnimationFrame(() => {
          pending = false;
          invalidate();
        });
      });
      ro.observe(mapContainerRef.current);
    }

    // Clean up
    return () => {
      destroyed = true;
      document.removeEventListener("click", handleMapClick, true);
      cancelAnimationFrame(raf);
      if (roRaf) cancelAnimationFrame(roRaf);
      clearTimeout(t1);
      clearTimeout(t2);
      if (ro) ro.disconnect();
      map.remove();
    };
  }, []);

  // 2. Redraw vectors and layers when state changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear old vector layers
    hullLayerRef.current.clearLayers();
    markerLayerRef.current.clearLayers();

    // Clear old heat layers
    Object.values(heatLayersRef.current).forEach((layer) => {
      if (layer) map.removeLayer(layer);
    });
    heatLayersRef.current = { 0: null, 1: null, 2: null };

    const vecRenderer = L.canvas({ pane: "vec", padding: 0.3 });

    // --- A. Draw boundaries (zpoly, mpoly and bpoly) ---
    if (st.layers.zpoly && geo.zp) {
      for (const z of geo.zp) {
        // Filter zones by active zona filter
        if (st.zona !== "") {
          const selZoneName = dim.zonas[+st.zona].toLowerCase();
          if (!selZoneName.includes(z.n.toLowerCase())) continue;
        }
        L.polygon(z.r, {
          color: z.c || "#fff",
          weight: 2.2,
          opacity: 0.7,
          fillColor: z.c || "#fff",
          fillOpacity: 0.08,
          renderer: vecRenderer
        })
          .bindTooltip(`<b>Zona ${z.n}</b><span class="tt-m">Límite operativo de zona</span>`, { sticky: true, className: "tt" })
          .addTo(hullLayerRef.current);
      }
    }

    if (st.layers.mpoly && geo.mp) {
      for (const m of geo.mp) {
        const mName = m.n.toLowerCase();
        // Filter by selected muni
        if (st.muni !== "") {
          const selMuniName = dim.munis[+st.muni].toLowerCase();
          if (mName !== selMuniName) continue;
        }
        // Filter by selected zone
        if (st.zona !== "") {
          const mIdx = dim.munis.findIndex(name => name.toLowerCase() === mName);
          if (mIdx >= 0) {
            let hasBarrioInZone = false;
            for (let b = 0; b < dim.barrios.length; b++) {
              if (dim.b_muni[b] === mIdx && dim.b_zona[b] === +st.zona) {
                hasBarrioInZone = true;
                break;
              }
            }
            if (!hasBarrioInZone) continue;
          }
        }
        L.polygon(m.r, {
          color: P.limitStroke,
          weight: 1.4,
          opacity: 0.6,
          fill: false,
          dashArray: "5,4",
          renderer: vecRenderer
        })
          .bindTooltip(`<b>${m.n}</b>`, { sticky: true, className: "tt" })
          .addTo(hullLayerRef.current);
      }
    }

    // Corregimientos y veredas: referencia rural, sin filtros (la base no las trae).
    for (const [capa, clave, etiqueta] of [["cpoly", "cp", "Corregimiento"], ["vpoly", "vp", "Vereda"]]) {
      if (!st.layers[capa] || !geo[clave]) continue;
      for (const c of geo[clave]) {
        L.polygon(c.r, {
          color: P.limitStroke,
          weight: 1,
          opacity: 0.5,
          fill: false,
          dashArray: capa === "cpoly" ? "2,4" : "1,5",
          renderer: vecRenderer
        })
          .bindTooltip(`<b>${c.n}</b><span class="tt-m">${etiqueta}</span>`, { sticky: true, className: "tt" })
          .addTo(hullLayerRef.current);
      }
    }

    if ((st.layers.bpoly || st.barrios?.length) && geo.bp) {
      const sel = st.barrios?.length ? new Set(st.barrios) : null;
      for (const p of geo.bp) {
        // Con barrios seleccionados, dibujar ÚNICAMENTE sus límites (aunque la
        // capa de límites o la de marcadores por barrio estén desactivadas).
        if (sel) {
          if (!sel.has(p.b)) continue;
        } else if (p.b >= 0) {
          // Filter by selected zone
          if (st.zona !== "" && dim.b_zona[p.b] !== +st.zona) continue;
          // Filter by selected muni
          if (st.muni !== "" && dim.b_muni[p.b] !== +st.muni) continue;
        } else {
          // Unlinked polygons: filter by name
          if (st.muni !== "") {
            const selMuniName = dim.munis[+st.muni].toLowerCase();
            if (p.m.toLowerCase() !== selMuniName) continue;
          }
          if (st.zona !== "") {
            const muniIdx = dim.munis.findIndex(name => name.toLowerCase() === p.m.toLowerCase());
            if (muniIdx >= 0) {
              let hasBarrioInZone = false;
              for (let b = 0; b < dim.barrios.length; b++) {
                if (dim.b_muni[b] === muniIdx && dim.b_zona[b] === +st.zona) {
                  hasBarrioInZone = true;
                  break;
                }
              }
              if (!hasBarrioInZone) continue;
            }
          }
        }

        const isSel = sel != null && p.b === sel;
        const o = p.b >= 0 ? A.barrio.get(p.b) : null;
        const dudoso = p.b >= 0 && p.cf < 0.6;
        const col = o && !dudoso ? riskColor(o.risk) : P.none;
        const usable = !!o;
        const distinto = o && barrioName(p.b).trim().toUpperCase() !== p.n.trim().toUpperCase();

        L.polygon(p.r, {
          color: isSel ? P.markerSel : col,
          weight: isSel ? 2.6 : dudoso ? 1 : 1.1,
          opacity: isSel ? 0.95 : dudoso ? 0.45 : 0.65,
          fillColor: col,
          fillOpacity: isSel ? 0.18 : o && !dudoso ? 0.12 : 0,
          dashArray: isSel ? null : dudoso ? "3,3" : null,
          interactive: usable,
          renderer: vecRenderer
        })
          .bindTooltip(
            `<b>${p.n}</b><span class="tt-m">${p.m} · límite catastral</span>` +
              (o
                ? `<span class="tt-r" style="color:${riskColorOf(P, o.risk, true)}">Riesgo ${V.riesgoPorPromedio && o.prio ? o.prio + " · " : ""}${
                    o.risk ?? "—"
                  }</span>
                <span>${num(o.tot)} ${V.ordenesMin || "ordenes"} · ${pct(o.efPct)}% efectividad</span>` +
                  (distinto
                    ? `<span class="tt-l">datos bajo el nombre <b>${barrioName(
                        p.b
                      )}</b></span>`
                    : "") +
                  (dudoso
                    ? `<span class="tt-w">enlace dudoso · solo ${Math.round(
                        p.cf * 100
                      )}% de sus ${V.ordenesMin || "ordenes"} caen aquí</span>`
                    : "")
                : ""),
            { sticky: true, className: "tt" }
          )
          .on("click", () => {
            if (p.b >= 0) onSelectBarrio(p.b);
          })
          .addTo(hullLayerRef.current);
      }
    }

    // --- A bis. Barrios sin visitar: polígonos sin ninguna orden (NIC)
    // enlazada (b === -1). Se resaltan en amarillo fuerte. ---
    if (st.layers.sinNic && geo.bp) {
      // Los geojson traen el municipio con tilde ("SANTO TOMÁS") y la base sin ella.
      const norm = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const selMuni = st.muni !== "" ? norm(dim.munis[+st.muni]) : null;
      // Zona de cada municipio, por el barrio con datos que más pesa. Sin esto, al filtrar
      // una zona todos los polígonos de las demás salían como «sin visitar».
      let zonaDeMuni = null;
      if (st.zona !== "") {
        const cuenta = new Map();
        for (let b = 0; b < dim.barrios.length; b++) {
          const k = norm(dim.munis[dim.b_muni[b]]) + "|" + dim.b_zona[b];
          cuenta.set(k, (cuenta.get(k) || 0) + 1);
        }
        zonaDeMuni = new Map();
        for (const [k, n] of cuenta) {
          const [m, z] = k.split("|");
          if (!zonaDeMuni.has(m) || n > zonaDeMuni.get(m).n) zonaDeMuni.set(m, { z: +z, n });
        }
      }
      for (const p of geo.bp) {
        // Sin visitar = ninguna gestión dentro del filtro actual (mes, año, zona...):
        // un polígono sin barrio enlazado, o enlazado pero sin puntos en lo que se ve.
        if (p.b !== -1 && A.barrio.has(p.b)) continue;
        if (selMuni && norm(p.m) !== selMuni) continue;
        if (zonaDeMuni && zonaDeMuni.get(norm(p.m))?.z !== +st.zona) continue;
        L.polygon(p.r, {
          color: P.sinNic,
          weight: 1.4,
          opacity: 0.95,
          fillColor: P.sinNic,
          fillOpacity: 0.4,
          renderer: vecRenderer
        })
          .bindTooltip(
            `<b>${p.n}</b><span class="tt-m">${p.m} · sin ${V.ordenesMin || "ordenes"} registradas</span>`,
            { sticky: true, className: "tt" }
          )
          .addTo(hullLayerRef.current);
      }
    }

    // --- B. Draw order layers (heat and points) ---
    const vis = st.est;
    const hayVis = vis[0] || vis[1] || vis[2];

    if (hayVis) {
      const sets = [[], [], []];
      const pts = [];
      const I = A.IDX || [];
      const selSet = st.barrios?.length ? new Set(st.barrios) : null;
      // Con gestores (técnicos) elegidos, sus puntos y nada más: el catálogo de técnicos va
      // por orden, así que se compara el índice de cada visita.
      const selTec = st.tecs?.length ? new Set(st.tecs) : null;

      for (let j = 0; j < I.length; j++) {
        const i = I[j];
        const e = st.E_raw[i];
        if (!vis[e]) continue;
        if (st.causaPasa && !st.causaPasa(i)) continue;
        if (selSet && !selSet.has(st.B_raw[i])) continue;
        if (selTec && !selTec.has(st.T_raw[i])) continue;
        if (st.layers.heat) {
          const lt = st.lat(i);
          const ln = st.lon(i);
          if (!isNaN(lt) && !isNaN(ln)) {
            sets[e].push([lt, ln, e === 0 ? 0.6 : 1.0]);
          }
        }
        if ((st.layers.gps && !st.APPROX_raw[i]) || (st.layers.approx && st.APPROX_raw[i])) {
          pts.push(i);
        }
      }

      // Draw Heatmaps
      if (st.layers.heat && L.heatLayer) {
        // Rampas de calor de marca: efectivas (verde) · perdidas (peligro)
        const grads = P.heat;
        const techo = [28, 14, 6];
        const heatRadius = selSet ? 25 : 14;
        const heatBlur = selSet ? 15 : 20;

        for (const e of [0, 1, 2]) {
          if (sets[e].length) {
            heatLayersRef.current[e] = L.heatLayer(sets[e], {
              radius: heatRadius,
              blur: heatBlur,
              max: techo[e],
              minOpacity: 0.42,
              maxZoom: 13,
              gradient: grads[e],
              pane: "heat"
            }).addTo(map);
          }
        }
      }

      // Draw Canvas Points
      if (pts.length) {
        if (!map.hasLayer(ptLayerRef.current)) ptLayerRef.current.addTo(map);
        ptLayerRef.current.setPoints(pts);
      } else {
        if (map.hasLayer(ptLayerRef.current)) map.removeLayer(ptLayerRef.current);
      }

      // --- C. Draw Barrio Circle Markers ---
      if (st.layers.markers) {
        // Si hay un barrio seleccionado desde la cola de triaje (o el mapa),
        // dibujamos SOLO ese barrio y lo remarcamos; si no hay selección,
        // se muestran todos como de costumbre.
        for (const [b, o] of A.barrio) {
          if (selSet && !selSet.has(b)) continue;
          // Con gestores elegidos solo salen los barrios donde trabajaron. La burbuja conserva
          // las cifras de TODO el barrio: el agregado por barrio no se parte por gestor.
          if (selTec && ![...selTec].some((t) => o.tec.has(t))) continue;

          const c = geo.bc[b];
          if (!c) continue;
          const efVis = (st.efOcultas || []).reduce((a, id) => a - (o.efGest?.get(id) || 0), o.ef);
          const n = (vis[0] ? efVis : 0) + (vis[1] ? o.fa : 0) + (vis[2] ? o.pe : 0);
          if (!n) continue;

          const isSel = !!selSet && selSet.has(b);
          const hot = o.risk != null && o.risk >= st.hotspot;
          const rad = Math.min(20, 7 + Math.sqrt(n) * 0.7);
          const col = riskColor(o.risk);

          const tip =
            `<b>${barrioName(b)}</b><span class="tt-m">${barrioMuni(b)}</span>
            <span class="tt-r" style="color:${riskColorOf(P, o.risk, true)}">Riesgo ${V.riesgoPorPromedio && o.prio ? o.prio + " · " : ""}${o.risk ?? "—"}</span>
            <span>${num(o.tot)} ${V.ordenesMin || "ordenes"} · ${pct(o.efPct)}% efectividad</span>
            <span>${num(o.pe)} perdidas</span>` +
            (n !== o.tot ? `<span class="tt-p">mostrando ${num(n)} de ${num(o.tot)} en el filtro actual</span>` : "");

          const hitR = Math.max(rad + 6, 12);
          const hit = L.circleMarker(c, {
            radius: hitR,
            opacity: 0,
            fillOpacity: 0,
            renderer: vecRenderer,
            bubblingMouseEvents: false
          });

          hit.bindTooltip(tip, { className: "tt", direction: "top" });
          hit.on("click", () => onSelectBarrio(b));
          markerLayerRef.current.addLayer(hit);

          // Halo de resalte para el barrio seleccionado
          if (isSel) {
            const halo = L.circleMarker(c, {
              radius: rad + 9,
              color: P.markerHalo || P.markerSel,
              weight: 2,
              opacity: 0.9,
              fill: false,
              renderer: vecRenderer,
              interactive: false,
              className: "mk-hot"
            });
            markerLayerRef.current.addLayer(halo);
          }

          // Visible circle
          const mk = L.circleMarker(c, {
            radius: isSel ? rad + 2 : rad,
            color: isSel || hot ? P.markerSel : col,
            weight: isSel ? 3 : hot ? 2.5 : 1.5,
            fillColor: col,
            fillOpacity: isSel ? 0.9 : 0.6,
            renderer: vecRenderer,
            interactive: false,
            className: hot && !isSel ? "mk-hot" : ""
          });
          markerLayerRef.current.addLayer(mk);
        }
      }
    } else {
      if (map.hasLayer(ptLayerRef.current)) map.removeLayer(ptLayerRef.current);
    }
  }, [A, st.layers, st.est, st.causaSel, st.efOcultas, st.hotspot, st.barrios, st.tecs, theme]);

  // 2 bis. Órdenes POR EJECUTAR del archivo cargado en el chat.
  //
  // Capa aparte del histórico y con su propio color: estas órdenes no tienen
  // estado ni causa —todavía no se han ejecutado—, así que pintarlas con el
  // semáforo de efectiva/fallida/perdida diría algo que no se sabe.
  //
  // Los tres orígenes se distinguen por relleno y no por color, para que la capa
  // se lea como una sola cosa con precisiones distintas: una coincidencia por
  // vía no puede parecer un GPS tomado en la puerta.
  useEffect(() => {
    const map = mapRef.current;
    const capa = cargueLayerRef.current;
    if (!map || !capa) return;

    capa.clearLayers();
    // El calor no es un Layer del grupo: se quita del mapa aparte.
    if (cargueHeatRef.current) {
      map.removeLayer(cargueHeatRef.current);
      cargueHeatRef.current = null;
    }
    // Sin ningún modo activo no hay capa que dibujar.
    const dibuja =
      st.layers.cargueMarkers ||
      st.layers.cargueHeat ||
      st.layers.cargueGps ||
      st.layers.cargueApprox;
    if (!ordenes?.puntos?.length || !dibuja) return;

    const color = P.cargue;

    // GPS real = tomado en el suministro o en esa misma dirección; lo demás es
    // una aproximación por cuadra o por vía. Es la división que el histórico
    // hace con APPROX_raw, solo que aquí la precisión viene en cuatro escalones.
    const esReal = (o) => o.origen === "nic" || o.origen === "exacta";

    // Igual que en el histórico, GPS/aproximadas solo mandan sobre los puntos
    // sueltos: el calor y los marcadores resumen todo lo que hay.
    const sueltos = ordenes.puntos.filter(
      (o) => (st.layers.cargueGps && esReal(o)) || (st.layers.cargueApprox && !esReal(o))
    );

    if (st.layers.cargueHeat && L.heatLayer) {
      cargueHeatRef.current = L.heatLayer(
        ordenes.puntos.map((o) => [o.lat, o.lon, 1.0]),
        {
          radius: 14,
          blur: 20,
          // Mismo techo que las fallidas del histórico: son volúmenes parecidos
          // y así las dos capas se leen a la misma escala.
          max: 14,
          minOpacity: 0.42,
          maxZoom: 13,
          gradient: P.heatCargue,
          pane: "heat"
        }
      ).addTo(map);
    }

    if (st.layers.cargueMarkers) {
      // Se agrupa por el nombre del barrio que trae cada orden y el centro sale
      // del promedio de sus propios puntos: los centroides del histórico están
      // indexados por posición, y cruzarlos por nombre fallaría justo en los
      // barrios con etapas, que son los que más órdenes traen.
      const porBarrio = new Map();
      for (const o of ordenes.puntos) {
        const clave = o.barrio || "Sin barrio";
        const acc = porBarrio.get(clave) || { n: 0, reales: 0, lat: 0, lon: 0, muni: o.municipio };
        acc.n += 1;
        acc.reales += esReal(o) ? 1 : 0;
        acc.lat += o.lat;
        acc.lon += o.lon;
        porBarrio.set(clave, acc);
      }

      const rendererCargue = L.canvas({ pane: "cargue", padding: 0.3 });
      for (const [nombre, acc] of porBarrio) {
        const centro = [acc.lat / acc.n, acc.lon / acc.n];
        const rad = Math.min(20, 7 + Math.sqrt(acc.n) * 0.7);
        L.circleMarker(centro, {
          radius: rad,
          color,
          weight: 1.5,
          fillColor: color,
          fillOpacity: 0.55,
          renderer: rendererCargue
        })
          .bindTooltip(
            `<b>${nombre}</b>` +
              (acc.muni ? `<span class="tt-m">${acc.muni}</span>` : "") +
              `<span>${acc.n.toLocaleString("es-CO")} por ejecutar</span>` +
              `<span>${acc.reales.toLocaleString("es-CO")} con GPS real</span>`,
            { className: "tt", direction: "top" }
          )
          .addTo(capa);
      }
    }
    // Los puntos sueltos van en blanco y sin icono: a 18 px el foco se
    // emborronaba, y lo que hay que distinguir de un vistazo es la precisión de
    // la ubicación, que se lee en el relleno. Sobre el mosaico claro el blanco
    // solo no se ve, así que el contorno lo saca del fondo.
    const punto = P.carguePunto;
    const linea = P.carguePuntoLinea;
    // Relleno sólido = GPS tomado en esa misma puerta. Translúcido = cerca.
    // Punteado = solo la calle correcta.
    const solido = { fondo: punto, borde: `1.5px solid ${linea}`, opacidad: 1 };
    const estilo = {
      nic: solido,
      exacta: solido,
      cuadra: { fondo: punto, borde: `1.5px solid ${linea}`, opacidad: 0.68 },
      via: { fondo: "transparent", borde: `1.5px dashed ${linea}`, opacidad: 0.85 }
    };
    const precision = {
      nic: "GPS real de este suministro",
      exacta: "GPS real de esta misma dirección",
      cuadra: "otra placa de la misma cuadra (~32 m)",
      via: "sobre la misma vía (~41 m)"
    };

    for (const o of sueltos) {
      const s = estilo[o.origen] || estilo.via;
      // Los colores van en línea y no en una clase de CSS porque salen de la
      // paleta en JS, que es la única que conoce el tema vigente.
      const icono = L.divIcon({
        className: "cargue-foco",
        html:
          `<span style="background:${s.fondo};border:${s.borde};` +
          `opacity:${s.opacidad}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        popupAnchor: [0, -7]
      });

      L.marker([o.lat, o.lon], { icon: icono, pane: "cargue", riseOnHover: true })
        .bindPopup(
          `
          <div class="op-h" style="border-color:${color}">
            <b>${V.orden || "Orden"} ${o.orden}</b>
            <span class="op-e" style="color:${P.cargueText}">Por ejecutar</span>
          </div>
          <table class="op-t">
            <tbody>
              <tr><td>NIC</td><td class="mono">${o.nic || "—"}</td></tr>
              <tr><td>Dirección</td><td>${o.direccion || "—"}</td></tr>
              <tr><td>Barrio</td><td>${o.barrio || "—"}${
                o.municipio ? ` · ${o.municipio}` : ""
              }</td></tr>
              <tr><td>${V.tecnico || "Técnico"}</td><td>${o.tecnico || "—"}</td></tr>
              <tr><td>${V.tipoOs || "Tipo OS"}</td><td>${o.tipo_os || "—"}</td></tr>
              <tr><td>Ubicación</td><td>${precision[o.origen] || "—"}</td></tr>
            </tbody>
          </table>
        `,
          { className: "ord-pop", maxWidth: 300 }
        )
        .addTo(capa);
    }
  }, [ordenes, st.layers, theme]);

  // 3. Cambio de tema: se cambia el estilo del basemap y se repintan los puntos
  useEffect(() => {
    if (!mapRef.current) return;
    if (basemapRef.current) basemapRef.current.getMaplibreMap().setStyle(BASEMAP[theme]);
    if (ptLayerRef.current && ptLayerRef.current._c) ptLayerRef.current._draw();
  }, [theme]);

  // Al filtrar varios barrios el mapa los encuadra todos (uno solo se centra como el enfocado).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !st.barrios?.length || st.selBarrio != null) return;
    const centros = st.barrios.map((b) => geo.bc[b]).filter(Boolean);
    if (!centros.length) return;
    if (centros.length === 1) map.flyTo(centros[0], 15, { duration: 0.6 });
    else map.fitBounds(centros, { padding: [60, 60], maxZoom: 15, duration: 0.6 });
  }, [st.barrios]);

  // Handle map flyTo when a neighborhood selection is triggered
  useEffect(() => {
    const map = mapRef.current;
    if (!map || st.selBarrio == null) return;
    const c = geo.bc[st.selBarrio];
    if (c) {
      map.flyTo(c, 15, { duration: 0.6 });
    }
  }, [st.selBarrio]);

  // Con las órdenes del archivo dibujadas el mapa NO está vacío, aunque el
  // histórico esté todo apagado: el aviso contradecía lo que se veía en pantalla.
  const dibujandoCargue =
    ordenes?.puntos?.length > 0 &&
    (st.layers.cargueMarkers ||
      st.layers.cargueHeat ||
      st.layers.cargueGps ||
      st.layers.cargueApprox);
  const mapaVacio = !st.est.some(Boolean) && !dibujandoCargue;

  // Con alguna casilla marcada puede no quedar nada que dibujar: filtros que dejan
  // cero gestiones del estado elegido (p. ej. «Contacto no efectivo» con Perdidas oculto).
  const sinResultados = React.useMemo(() => {
    if (!st.est.some(Boolean) || dibujandoCargue) return false;
    const I = A.IDX || [];
    for (let j = 0; j < I.length; j++) {
      const i = I[j];
      if (st.est[st.E_raw[i]] && (!st.causaPasa || st.causaPasa(i))) return false;
    }
    return true;
  }, [A, st.est, st.causaSel, st.efOcultas, dibujandoCargue]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="mapwrap">
      <div ref={mapContainerRef} id="map" style={{ height: "100%", width: "100%" }} />
      <div id="mapCap" />
      <div id="mapEmpty" style={{ display: mapaVacio || sinResultados ? "block" : "none" }}>
        {mapaVacio ? (
          <>
            <b>Ninguna {V.ordenMin || "orden"} seleccionada</b>
            <p>
              Marca al menos un tipo de {V.ordenMin || "orden"} —{" "}
              perdidas o efectivas — para dibujarlas en el
              mapa.
            </p>
          </>
        ) : (
          <>
            <b>Sin {V.ordenesMin || "ordenes"} con estos filtros</b>
            <p>
              Ninguna {V.ordenMin || "orden"} cumple los filtros y los tipos marcados. Quita un filtro o marca otro tipo
              de {V.ordenMin || "orden"}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}