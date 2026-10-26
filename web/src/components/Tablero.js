"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ChevronRight, X } from "lucide-react";

import isesSymbol from "../../public/ises-symbol.png";

import Topbar from "@/components/Topbar";
import RiskSpine from "@/components/RiskSpine";
import DetailsPanel from "@/components/DetailsPanel";
import Dock from "@/components/Dock";
import { useTheme, riskColor, usarRampaCobros } from "@/lib/theme";
import { cacheGet, cachePut, cacheClear } from "@/lib/monthCache";

// Dynamic import for Leaflet map to avoid window undefined pre-render issues
const LeafletMap = dynamic(() => import("@/components/LeafletMap"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        background: "var(--map-bg)",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--dim)"
      }}
    >
      Cargando visor cartográfico...
    </div>
  )
});


// Cómo se dibuja la capa del cargue. Va en un componente porque el panel de capas
// existe dos veces —diseño Enfoque y Clásico— y son idénticos.
//
// No hay un interruptor de encendido: apagar los cuatro modos ya deja la capa sin
// dibujar, así que una casilla más solo daba dos formas de hacer lo mismo.
function CapasCargue({ layers, onLayers, V = {} }) {
  const casilla = (clave, texto) => (
    <label className="lay">
      <input
        type="checkbox"
        checked={layers[clave]}
        onChange={(e) => onLayers({ ...layers, [clave]: e.target.checked })}
      />
      {texto}
    </label>
  );

  return (
    <div className="lgrp">
      <h4>{V.ordenes || "Órdenes"} por ejecutar</h4>
      {casilla("cargueMarkers", "Marcadores por barrio")}
      {casilla("cargueHeat", "Mapa de calor")}
      {casilla("cargueGps", "GPS reales")}
      {casilla("cargueApprox", "Ubicaciones aproximadas")}
      <p className="lay-nota">
        Los <b>marcadores</b> resumen cuántas hay por barrio. <b>GPS reales</b> y{" "}
        <b>aproximadas</b> filtran los puntos sueltos según lo fina que sea su
        ubicación.
      </p>
    </div>
  );
}

// Con menos gestiones que esto la categoría de un barrio se marca como "muestra
// pequeña": se muestra igual, pero una sola gestión puede cambiarla.
const MUESTRA_PEQUENA = 30;

const NIVELES_SCR = [[15, "0–30 · Bajo"], [45, "31–60 · Medio"], [80, "61–100 · Alto"]];
const NIVELES_COBROS = [
  [15, "0–30 · Bajo"],
  [45, "31–60 · Medio"],
  [70, "61–80 · Alto"],
  [90, "81–100 · Crítico"],
];

// "2026-10" -> "2026-09"
const mesPrevio = (ym) => {
  const [anio, mes] = ym.split("-").map(Number);
  return mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, "0")}`;
};

// `proceso` lo fija la ruta ("/" = scr, "/cobros" = cobros), no un estado: así cada
// actividad tiene su propia URL y recargar no devuelve al usuario a SCR.
export default function Tablero({ proceso }) {
  const router = useRouter();
  const setProceso = (p) => router.push(p === "cobros" ? "/cobros" : "/");
  // Paleta corporativa para los swatches de capas y la leyenda de riesgo
  const { palette: P } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Antes de pintar a los hijos: la rampa de riesgo de cobros no se parece a ningún estado.
  usarRampaCobros(proceso === "cobros");

  // Pesos del índice de riesgo. En cobros el riesgo es solo dónde la visita no se
  // pudo hacer (perdidas = VF): no hay fallidas, y volumen, tendencia e historial
  // del gestor no cuentan, para que la cola apunte a lo que el gestor no logró visitar.
  const V = useMemo(() => proceso === "cobros" ? {
    conFallidas: false, suspension: false, sinAjuste: true, esteTipo: "esta gestión", riesgoPorPromedio: true, vistaGestores: true, proceso: "cobros",
    pesos: { pe: 1, fa: 0, vol: 0, tr: 0, hist: 0 },
    tecnico: "Gestor", tecnicos: "Gestores", tecnicoMin: "gestor", tecnicosMin: "gestores",
    brigada: "Plan", brigadas: "Planes", brigadaMin: "plan",
    tipoOs: "Gestión", tiposOs: "Gestiones", tipoOsMin: "gestión",
    orden: "Gestión", ordenes: "Gestiones", ordenMin: "gestión", ordenesMin: "gestiones",
    subaccion: "Línea de acción", subacciones: "Líneas de acción",
  } : {
    // Acuacar no tiene «Fallida»: una orden no efectiva se pierde. Los pesos son los de
    // Aire sin el 0.25 de fallidas, repartido en proporción al resto (0.75 -> 1.0).
    conFallidas: false, suspension: false, sinAjuste: false, esteTipo: "este tipo de orden", vistaGestores: false, proceso: "scr",
    pesos: { pe: 0.53, fa: 0, vol: 0.2, tr: 0.14, hist: 0.13 },
    tecnico: "Brigada", tecnicos: "Brigadas", tecnicoMin: "brigada", tecnicosMin: "brigadas",
    brigada: "Contratista", brigadas: "Contratistas", brigadaMin: "contratista",
    tipoOs: "Proceso", tiposOs: "Procesos", tipoOsMin: "proceso",
    orden: "Orden", ordenes: "Órdenes", ordenMin: "orden", ordenesMin: "ordenes",
    subaccion: "Tipo de imposibilidad", subacciones: "Tipos de imposibilidad",
  }, [proceso]);

  // Controla si el panel de capas está desplegado u oculto
  const [layersCollapsed, setLayersCollapsed] = useState(false);

  // Órdenes POR EJECUTAR del archivo que se sube en el chat. Son otra cosa que
  // el histórico: no tienen estado ni causa, solo dónde hay que ir.
  const [cargue, setCargue] = useState(null);
  const [ordenes, setOrdenes] = useState(null);

  // Los puntos del cargue anterior se botan aquí y no en el efecto que los pide:
  // quitar el archivo tiene que vaciar el mapa aunque no haya nada que pedir.
  const handleCargue = useCallback((resumen) => {
    setCargue(resumen);
    setOrdenes(null);
  }, []);

  // Carga perezosa por mes: solo el mes en curso se descarga al inicio; los
  // demás llegan cuando el usuario los selecciona en el filtro.
  const loadedKeysRef = useRef(new Set()); // YYYY-MM ya fusionados
  const inflightKeysRef = useRef(new Set()); // YYYY-MM descargándose ahora
  const [loadingMonths, setLoadingMonths] = useState([]); // labels en descarga (UI)
  const [refreshing, setRefreshing] = useState(false); // botón "Actualizar información"
  const [refreshResult, setRefreshResult] = useState(null); // null | "ok" | "error"

  // App global state
  const [st, setSt] = useState({
    zona: "",
    muni: "",
    brig: "",
    tipo: "",
    act: "",
    gest: "",
    cob: "",
    causaSel: null,
    efOcultas: [],
    d0: 0,
    d1: 60,
    minOrders: proceso === "cobros" ? 1 : 10,
    hotspot: 60,
    adjusted: true,
    // Barrios elegidos en la cola de triaje (índices en dim.barrios). `selBarrio` es el
    // mismo barrio cuando hay uno solo, y null con varios: así todo lo que ya miraba
    // `selBarrio` sigue funcionando.
    barrios: [],
    vistaMulti: "acumulado",
    // Técnicos (gestores en COBROS) elegidos en su pestaña, y cómo verlos.
    vistaMultiTec: "acumulado",
    selBarrio: null,
    tecs: [],
    selNic: null,
    tab: "barrio",
    dock: "tendencias",
    dockCollapsed: false,
    spineSort: "risk",
    est: [true, true, true],
    months: [],
    layout: "enfoque",
    activeTab: "mapa",
    layers: {
      heat: false,
      markers: true,
      gps: false,
      approx: false,
      bpoly: false,
      mpoly: false,
      cpoly: false,
      vpoly: false,
      zpoly: false,
      sinNic: false,
      // Cómo se dibuja el cargue. Su propio juego de casillas: es una capa que se
      // mira A LA VEZ que el histórico, y compartir los controles obligaría a
      // verlas siempre igual. Por defecto, solo los puntos sueltos.
      cargueMarkers: false,
      cargueHeat: false,
      cargueGps: true,
      cargueApprox: true
    },
    // Hierarchy selections
    jerBarrio: null,
    jerBrig: null
  });


  // Aplica el payload del mes en curso (data.json) al estado.
  const applyEntryData = (resData) => {
    setData(resData);

    // Max day of the current month (day slider upper bound)
    const M = resData.pts.m;
    let maxD = 0;
    for (let i = 0; i < M.length; i++) {
      const d = Math.floor(M[i] / 1440);
      if (d > maxD) maxD = d;
    }

    // The recent month is the only one loaded; it is active by default.
    const manifest = (resData.meta && resData.meta.months) || [];
    const recent = manifest.find((m) => m.recent);
    loadedKeysRef.current = new Set();
    inflightKeysRef.current = new Set();
    if (recent) loadedKeysRef.current.add(recent.key);

    setSt((prev) => ({
      ...prev,
      zona: "",
      muni: "",
      brig: "",
      tipo: "",
      act: "",
      gest: "",
      cob: "",
      causaSel: null,
      efOcultas: [],
      d0: 0,
      d1: maxD,
      barrios: [],
      selBarrio: null,
      tecs: [],
      selNic: null,
      months: recent ? [recent.label] : []
    }));
  };

  // Load only the current month on mount. Se intenta la caché local (IndexedDB,
  // TTL 1h) antes de la red, para que recargar dentro de la hora sea instantáneo.
  // El manifiesto (meta.months) lista los demás meses y sus conteos SIN bajarlos;
  // se descargan perezosamente al seleccionarlos.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async () => {
      const cacheKey = `${proceso}/data.json`;
      let resData = await cacheGet(cacheKey);
      if (!resData || (proceso === "cobros" && resData.pts && !resData.pts.sd)) {
        resData = await fetch(`/${proceso}/data.json?t=` + Date.now()).then((r) => r.json());
        cachePut(cacheKey, resData);
      }
      if (cancelled) return;
      applyEntryData(resData);
      setLoading(false);
    })().catch((err) => {
      console.error("Failed to load operational data", err);
    });
    return () => {
      cancelled = true;
    };
  }, [proceso]);

  // Lazy month loader: whenever the selection includes a month that is not yet
  // loaded, download its file and merge it into `data`.
  useEffect(() => {
    if (!data) return;
    const manifest = (data.meta && data.meta.months) || [];
    const byLabel = new Map(manifest.map((m) => [m.label, m]));
    const etiquetas = [...(st.months || [])];
    const need = etiquetas
      .map((lbl) => byLabel.get(lbl))
      .filter(
        (m) =>
          m &&
          m.file &&
          !m.recent &&
          !loadedKeysRef.current.has(m.key) &&
          !inflightKeysRef.current.has(m.key)
      );
    if (!need.length) return;

    need.forEach((m) => inflightKeysRef.current.add(m.key));
    setLoadingMonths((prev) => [...new Set([...prev, ...need.map((m) => m.label)])]);

    Promise.all(
      need.map(async (m) => {
        const cacheKey = `${proceso}/${m.file}`;
        let pts = await cacheGet(cacheKey);
        if (!pts || (proceso === "cobros" && !pts.sd)) {
          const j = await fetch(`/${proceso}/${m.file}?t=` + Date.now()).then((r) => r.json());
          pts = j.pts;
          cachePut(cacheKey, pts);
        }
        return { m, pts };
      })
    )
      .then((results) => {
        setData((prev) => {
          if (!prev) return prev;
          const mergedPts = {};
          const allKeys = new Set(Object.keys(prev.pts));
          results.forEach(({ pts }) => Object.keys(pts || {}).forEach((k) => allKeys.add(k)));
          for (const key of allKeys) {
            let arr = prev.pts[key] || new Array(prev.pts.nic ? prev.pts.nic.length : 0).fill(0);
            for (const { pts } of results) {
              const part = (pts && pts[key]) || new Array(pts && pts.nic ? pts.nic.length : 0).fill(0);
              arr = arr.concat(part);
            }
            mergedPts[key] = arr;
          }
          return { ...prev, pts: mergedPts };
        });
        results.forEach(({ m }) => {
          loadedKeysRef.current.add(m.key);
          inflightKeysRef.current.delete(m.key);
        });
        setLoadingMonths((prev) =>
          prev.filter((lbl) => !need.some((m) => m.label === lbl))
        );
      })
      .catch((err) => {
        console.error("Failed to load month data", err);
        need.forEach((m) => inflightKeysRef.current.delete(m.key));
        setLoadingMonths((prev) =>
          prev.filter((lbl) => !need.some((m) => m.label === lbl))
        );
      });
  }, [st.months, data]);

  // Raw arrays memoized for lightning-fast lookups
  const rawArrays = useMemo(() => {
    if (!data) return null;
    const P = data.pts;
    return {
      E: Uint8Array.from(P.e),
      B: Int16Array.from(P.b),
      T: Int16Array.from(P.t),
      G: Uint8Array.from(P.g),
      O: Uint8Array.from(P.o),
      C: Uint8Array.from(P.c),
      S: Uint8Array.from(P.s),
      U: Uint8Array.from(P.u),
      F: Uint8Array.from(P.f),
      ACT: P.a ? Uint8Array.from(P.a) : null,
      GEST: P.x ? Uint8Array.from(P.x) : null,
      RG: P.rg ? Uint8Array.from(P.rg) : null,
      COB: P.cb ? Uint8Array.from(P.cb) : null,
      CA: P.ca ? Uint8Array.from(P.ca) : null,
      SC: P.sc ? Uint8Array.from(P.sc) : null,
      SD: P.sd ? Float64Array.from(P.sd) : (P.saldo ? Float64Array.from(P.saldo) : null),
      CH: P.ch ? Float64Array.from(P.ch) : (P.cobro_hoy ? Float64Array.from(P.cobro_hoy) : null),
      RC: P.rc ? Float64Array.from(P.rc) : (P.recaudo ? Float64Array.from(P.recaudo) : null),
      M: Int32Array.from(P.m),
      ORD: P.n,
      NIC: P.nic,
      LA: Int32Array.from(P.la),
      LO: Int32Array.from(P.lo),
      APPROX: (() => {
        const N = P.e.length;
        const approx = new Uint8Array(N);
        const cnt = new Map();
        for (let i = 0; i < N; i++) {
          const k = P.la[i] * 100000 + P.lo[i];
          cnt.set(k, (cnt.get(k) || 0) + 1);
        }
        for (let i = 0; i < N; i++) {
          if (cnt.get(P.la[i] * 100000 + P.lo[i]) >= 5) approx[i] = 1;
        }
        return approx;
      })(),
      DAY: (() => {
        const N = P.e.length;
        const arr = new Int16Array(N);
        for (let i = 0; i < N; i++) arr[i] = Math.floor(P.m[i] / 1440);
        return arr;
      })()
    };
  }, [data]);

  const MAXDAY = useMemo(() => {
    if (!rawArrays) return 0;
    let max = 0;
    const arr = rawArrays.DAY;
    const N = arr.length;
    for (let i = 0; i < N; i++) {
      if (arr[i] > max) max = arr[i];
    }
    return max;
  }, [rawArrays]);

  // Mes de cada orden como entero (se calcula UNA vez por dataset, no en cada
  // filtro). Evita crear un Date + toLocaleDateString por punto dentro de los
  // bucles calientes de IDX/avail, que era el mayor cuello de rendimiento.
  const monthMap = useMemo(() => {
    if (!data || !rawArrays) return { idx: null, keyToIdx: new Map() };
    const DAY = rawArrays.DAY;
    const N = DAY.length;
    const idx = new Int16Array(N);
    const keyToIdx = new Map();
    const D0 = new Date(data.meta.fecha_min + "T00:00:00");

    // Precalcular etiqueta por día único (~270) en vez de por punto (688K).
    const dayToLabel = new Map();
    for (let i = 0; i < N; i++) {
      const d = DAY[i];
      if (!dayToLabel.has(d)) {
        const x = new Date(D0.getTime() + d * 86400000);
        const k = x.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
        dayToLabel.set(d, k.charAt(0).toUpperCase() + k.slice(1));
      }
    }

    for (let i = 0; i < N; i++) {
      const cap = dayToLabel.get(DAY[i]);
      let mi = keyToIdx.get(cap);
      if (mi === undefined) {
        mi = keyToIdx.size;
        keyToIdx.set(cap, mi);
      }
      idx[i] = mi;
    }
    return { idx, keyToIdx };
  }, [data, rawArrays]);

  // Lista de meses desde el manifiesto (meta.months): incluye TODOS los meses
  // con su conteo de órdenes, aunque aún no se hayan descargado. `key` es la
  // etiqueta legible para mantener compatibilidad con st.months y monthMap.
  const availableMonths = useMemo(() => {
    if (!data || !data.meta.months) return [];
    const all = data.meta.months;
    const rec = all.find((m) => m.recent);
    const anio = rec ? rec.key.slice(0, 4) : null;
    return all
      .filter((m) => !anio || m.key.startsWith(anio))
      .map((m) => ({
        key: m.label,
        ym: m.key,
        n: m.n,
        recent: !!m.recent
      }));
  }, [data]);

  const lat = (i) => {
    if (!rawArrays || !data) return 0;
    return rawArrays.LA[i] / 1e5 + data.meta.lat0;
  };

  const lon = (i) => {
    if (!rawArrays || !data) return 0;
    return rawArrays.LO[i] / 1e5 + data.meta.lon0;
  };

  // 1. FILTERING ENGINE
  const IDX = useMemo(() => {
    if (!data || !rawArrays) return [];
    const { DAY, B, G, O, ACT, GEST, E, RG, COB } = rawArrays;
    const N = DAY.length;
    // Las casillas de «gestiones a mostrar» (perdidas / efectivas y sus tipos de recaudo) son
    // filtros reales: lo desmarcado no entra en ninguna lista, tabla ni total.
    const ocultas = new Set(st.efOcultas);
    const zi = st.zona === "" ? -1 : +st.zona;
    const mi = st.muni === "" ? -1 : +st.muni;
    const gi = st.brig === "" ? -1 : +st.brig;
    const oi = st.tipo === "" ? -1 : +st.tipo;
    const ai = st.act === "" ? -1 : +st.act;
    const xi = st.gest === "" ? -1 : +st.gest;
    const cbi = st.cob === "" ? -1 : +st.cob;
    const activeMi =
      st.months && st.months.length > 0
        ? new Set(
            st.months.map((k) => monthMap.keyToIdx.get(k)).filter((v) => v !== undefined)
          )
        : null;

    const out = new Int32Array(N);
    let k = 0;
    for (let i = 0; i < N; i++) {
      if (activeMi && !activeMi.has(monthMap.idx[i])) continue;
      if (!st.est[E[i]]) continue;
      if (ocultas.size && E[i] === 0 && RG && ocultas.has(RG[i])) continue;
      const b = B[i];
      if (zi >= 0 && data.dim.b_zona[b] !== zi) continue;
      if (mi >= 0 && data.dim.b_muni[b] !== mi) continue;
      if (gi >= 0 && G[i] !== gi) continue;
      if (oi >= 0 && O[i] !== oi) continue;
      if (ai >= 0 && ACT && ACT[i] !== ai) continue;
      if (xi >= 0 && GEST && GEST[i] !== xi) continue;
      if (cbi >= 0 && COB && COB[i] !== cbi) continue;
      out[k++] = i;
    }
    return out.subarray(0, k);
  }, [data, rawArrays, monthMap, st.zona, st.muni, st.brig, st.tipo, st.act, st.gest, st.cob, st.months, st.est, st.efOcultas]);

  // Tabla por gestor (Tendencias > Por gestor y Ranking). Sale de `gestores.json`, la
  // agregación de `v_aire_cobros_nic_mes` (una fila por cuenta y mes, ya sin duplicados),
  // así que las cifras son las de la vista. Se filtra aquí con zona, municipio, plan y
  // resultado gestión, y con los meses. «Gestión» (tipo de gestión) no está en la vista,
  // por eso no aplica a esta tabla.
  const [gestoresDet, setGestoresDet] = useState(null);
  useEffect(() => {
    if (!V.vistaGestores || gestoresDet || !["tendencias", "ranking"].includes(st.activeTab)) return;
    fetch(`/${proceso}/gestores.json`, { cache: "no-cache" })
      .then((r) => r.json())
      .then(setGestoresDet)
      .catch((err) => console.error("No se pudo cargar gestores.json", err));
  }, [V, proceso, gestoresDet, st.activeTab]);

  const tablaGestores = useMemo(() => {
    if (!V.vistaGestores || !data || !gestoresDet) return null;
    if (!["tendencias", "ranking"].includes(st.activeTab)) return null;
    const G = gestoresDet;
    const dim = data.dim;
    const llave = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    const indiceDe = (lista, valor) => (valor === null ? -1 : lista.findIndex((x) => llave(x) === llave(valor)));
    const pedido = {
      zona: st.zona === "" ? null : dim.zonas[+st.zona],
      muni: st.muni === "" ? null : dim.munis[+st.muni],
      plan: st.brig === "" ? null : dim.brigs[+st.brig],
      // El filtro usa el resultado reportado y la vista solo trae estado_final: no se cruzan.
      estado: null,
    };
    // Las casillas de Capas también filtran esta tabla: «Visita fallida» es la perdida y los
    // tipos de recaudo ocultos solo aplican a las efectivas.
    const iPerdida = G.estados.indexOf("Visita fallida");
    const ocultosG = new Set(st.efOcultas.map((id) => G.resultados.indexOf(dim.resultados[id])));
    const iz = indiceDe(G.zonas, pedido.zona);
    const im = indiceDe(G.municipios, pedido.muni);
    const ip = indiceDe(G.planes, pedido.plan);
    const ie = indiceDe(G.estados, pedido.estado);
    // Un filtro que el archivo no conoce (p. ej. un municipio sin cuentas) no deja filas.
    const sinCoincidencia =
      (pedido.zona !== null && iz < 0) || (pedido.muni !== null && im < 0) ||
      (pedido.plan !== null && ip < 0) || (pedido.estado !== null && ie < 0);

    const ymDe = new Map(availableMonths.map((m) => [m.key, m.ym]));
    const elegidos = new Set(
      (st.months && st.months.length ? st.months : availableMonths.map((m) => m.key))
        .map((l) => ymDe.get(l))
        .filter(Boolean)
    );
    const actual = [...elegidos].sort().at(-1);
    const anterior = actual ? mesPrevio(actual) : null;
    const iSel = new Set([...elegidos].map((ym) => G.meses.indexOf(ym)).filter((i) => i >= 0));
    const iAct = G.meses.indexOf(actual);
    const iAnt = G.meses.indexOf(anterior);

    const idCon = G.resultados.indexOf("Efectiva con pago");
    const idSin = G.resultados.indexOf("Efectiva sin recaudo");
    const idVal = G.resultados.indexOf("Efectiva sin validar");

    const filas = new Map();
    if (!sinCoincidencia) {
      for (const [g, m, z, mu, pl, e, r, cuentas, , recaudo, cobroHoy, cobroAnt, recPotHoy, recPotAnt] of G.filas) {
        const enSel = iSel.has(m);
        // Un gestores.json viejo (sin potencial de cobro) o un vacío cuenta como 0, nunca como NaN.
        const hoy = Number(cobroHoy) || 0;
        const ant = Number(cobroAnt) || 0;
        if (!enSel) continue;
        if (iz >= 0 && z !== iz) continue;
        if (im >= 0 && mu !== im) continue;
        if (ip >= 0 && pl !== ip) continue;
        if (ie >= 0 && e !== ie) continue;
        if (e === iPerdida ? !st.est[2] : !st.est[0]) continue;
        if (e !== iPerdida && ocultosG.has(r)) continue;
        let f = filas.get(g);
        if (!f) {
          f = { completo: G.gestores[g], gestionadas: 0, ef: 0, pago: 0, sinValidar: 0, deuda: 0, recaudo: 0, aDeuda: 0, aRec: 0, pDeuda: 0, pRec: 0 };
          filas.set(g, f);
        }
        const efectiva = r === idCon || r === idSin;
        if (enSel) {
          f.gestionadas += cuentas;
          if (efectiva) {
            f.ef += cuentas;
            f.deuda += hoy;
            f.recaudo += recaudo;
          }
          if (r === idCon) f.pago += cuentas;
          if (r === idVal) f.sinValidar += cuentas;
        }
        // El % de recaudo es la suma total: recaudo de las cuentas que traen potencial / su potencial.
        // El del mes anterior usa esas MISMAS cuentas del gestor en el mes elegido: su recaudo del
        // mes previo contra el p_cobro_ant que traen. Puede pasar de 100 si pagaron más de lo facturado.
        if (efectiva && m === iAct) {
          f.aDeuda += hoy;
          f.aRec += Number(recPotHoy) || 0;
          f.pDeuda += ant;
          f.pRec += Number(recPotAnt) || 0;
        }
      }
    }
    return {
      filas: [...filas.values()],
      actual,
      anterior,
      hayAnterior: iAnt >= 0,
      provisionalActual: G.provisionales.includes(actual),
      ignoraGestion: st.tipo !== "",
      ignoraResultado: st.gest !== "" || st.cob !== "",
    };
  }, [V, data, gestoresDet, availableMonths, st.activeTab, st.months, st.zona, st.muni, st.brig, st.tipo, st.gest, st.cob, st.est, st.efOcultas]);

  // Recalculates available filters in cascade
  const avail = useMemo(() => {
    const res = {
      zona: new Set(),
      muni: new Set(),
      brig: new Set(),
      tipo: new Set(),
      act: new Set(),
      gest: new Set(),
      cob: new Set(),
      // Lo que existe con los filtros de las píldoras, sin mirar las casillas de Capas:
      // sirve para apagar una casilla cuando no hay nada de ese tipo.
      tipos: [0, 0, 0],
      efRec: new Map()
    };
    if (!data || !rawArrays) return res;
    const { B, G, O, ACT, GEST, DAY, E, RG, COB } = rawArrays;
    const ocultas = new Set(st.efOcultas);
    const N = DAY.length;

    // Filter values (independent of the selector itself to avoid lockups)
    const zi = st.zona === "" ? -1 : +st.zona;
    const mi = st.muni === "" ? -1 : +st.muni;
    const gi = st.brig === "" ? -1 : +st.brig;
    const oi = st.tipo === "" ? -1 : +st.tipo;
    const ai = st.act === "" ? -1 : +st.act;
    const xi = st.gest === "" ? -1 : +st.gest;
    const cbi = st.cob === "" ? -1 : +st.cob;
    const activeMi =
      st.months && st.months.length > 0
        ? new Set(
            st.months.map((k) => monthMap.keyToIdx.get(k)).filter((v) => v !== undefined)
          )
        : null;

    for (let i = 0; i < N; i++) {
      if (activeMi && !activeMi.has(monthMap.idx[i])) continue;
      // «x» y «c» son el resultado de gestión y el de cobranza: cada uno cuenta como filtro
      // para todas las demás listas, pero no para la suya.
      const gOk = xi < 0 || !GEST || GEST[i] === xi;
      const cOk = cbi < 0 || !COB || COB[i] === cbi;
      const xOk = gOk && cOk;
      const b = B[i];
      const zVal = data.dim.b_zona[b];
      const mVal = data.dim.b_muni[b];
      const gVal = G[i];
      const oVal = O[i];
      const aVal = ACT ? ACT[i] : -1;

      if (
        xOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) &&
        (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)
      ) {
        res.tipos[E[i]]++;
        if (E[i] === 0 && RG) res.efRec.set(RG[i], (res.efRec.get(RG[i]) || 0) + 1);
      }
      // Las opciones de cada filtro salen solo de lo que las casillas dejan ver.
      if (!st.est[E[i]]) continue;
      if (ocultas.size && E[i] === 0 && RG && ocultas.has(RG[i])) continue;

      // Zona depends on Muni, Brig, Tipo, Act
      if (xOk && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) && (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)) {
        res.zona.add(zVal);
      }
      // Muni depends on Zona, Brig, Tipo, Act
      if (xOk && (zi < 0 || zVal === zi) && (gi < 0 || gVal === gi) && (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)) {
        res.muni.add(mVal);
      }
      // Brig depends on Zona, Muni, Tipo, Act
      if (xOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)) {
        res.brig.add(gVal);
      }
      // Tipo depends on Zona, Muni, Brig, Act
      if (xOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) && (ai < 0 || aVal === ai)) {
        res.tipo.add(oVal);
      }
      // Act depends on Zona, Muni, Brig, Tipo
      if (ACT && xOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) && (oi < 0 || oVal === oi)) {
        res.act.add(aVal);
      }
      // El estado de gestión también se cascadea: solo ofrece los que dejan datos.
      if (GEST && cOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) && (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)) res.gest.add(GEST[i]);
      if (COB && gOk && (zi < 0 || zVal === zi) && (mi < 0 || mVal === mi) && (gi < 0 || gVal === gi) && (oi < 0 || oVal === oi) && (ai < 0 || aVal === ai)) res.cob.add(COB[i]);
    }
    return res;
  }, [data, rawArrays, monthMap, st.zona, st.muni, st.brig, st.tipo, st.act, st.gest, st.cob, st.months, st.est, st.efOcultas]);

  // 2. AGGREGATION ENGINE
  // Es una función de los índices para poder agregar también solo los barrios elegidos
  // (`Asel`, el acumulado del detalle) sin duplicar el cálculo.
  const agregar = useCallback((IDX) => {
    const defaultAgg = {
      tot: 0,
      ef: 0,
      fa: 0,
      pe: 0,
      faCtrl: 0,
      noCtrl: 0,
      efGest: new Map(),
      efPct: 0,
      efAdj: 0,
      pePct: 0,
      faPct: 0,
      tecs: new Set(),
      brigs: new Set(),
      barrio: new Map(),
      tec: new Map(),
      brig: new Map(),
      causa: new Map(),
      sub: new Map(),
      susp: new Map(),
      tipo: new Map(),
      byDay: new Map()
    };
    if (!data || !rawArrays || !IDX.length) return defaultAgg;

    const { E, C, B, T, G, O, S, U, M, DAY, RG } = rawArrays;
    // En cobros toda perdida cuenta, así que ninguna causa se descarta como "no controlable".
    const CTRL = V.sinAjuste ? data.dim.causa_ctrl.map(() => 1) : data.dim.causa_ctrl;

    const A = {
      tot: IDX.length,
      ef: 0,
      fa: 0,
      pe: 0,
      faCtrl: 0,
      noCtrl: 0,
      efGest: new Map(),
      tecs: new Set(),
      brigs: new Set(),
      barrio: new Map(),
      tec: new Map(),
      brig: new Map(),
      causa: new Map(),
      sub: new Map(),
      susp: new Map(),
      tipo: new Map(),
      byDay: new Map()
    };

    const blank = () => ({
      tot: 0,
      ef: 0,
      fa: 0,
      pe: 0,
      faCtrl: 0,
      noCtrl: 0,
      efGest: new Map(),
      causa: new Map(),
      tec: new Map(),
      brig: new Map(),
      tipo: new Map(),
      efTipo: new Map(),
      susp: new Map(),
      sub: new Map(),
      subEf: new Map(),
      day: new Map(),
      barrios: new Set(),
      last: -1,
      tecEf: new Map()
    });

    const bump = (map, key) => {
      let o = map.get(key);
      if (!o) {
        o = blank();
        map.set(key, o);
      }
      return o;
    };

    const cnt = (map, key) => map.set(key, (map.get(key) || 0) + 1);

    for (let j = 0; j < IDX.length; j++) {
      const i = IDX[j];
      const e = E[i];
      const c = C[i];
      const b = B[i];
      const t = T[i];
      const g = G[i];
      const d = DAY[i];

      const ctrl = e === 0 ? 1 : CTRL[c];
      const isNoCtrl = e !== 0 && ctrl === 0;
      const isFaCtrl = e === 1 && ctrl === 1;

      if (e === 0) A.ef++;
      else if (e === 1) A.fa++;
      else A.pe++;

      if (isNoCtrl) A.noCtrl++;
      if (isFaCtrl) A.faCtrl++;

      A.tecs.add(t);
      A.brigs.add(g);
      cnt(A.causa, c);
      cnt(A.sub, S[i]);
      cnt(A.susp, U[i]);
      cnt(A.tipo, O[i]);

      let dd = A.byDay.get(d);
      if (!dd) {
        dd = [0, 0, 0];
        A.byDay.set(d, dd);
      }
      dd[e]++;

      for (const [map, key] of [
        [A.barrio, b],
        [A.tec, t],
        [A.brig, g]
      ]) {
        const o = bump(map, key);
        o.tot++;
        if (e === 0) {
          o.ef++;
          if (RG) o.efGest.set(RG[i], (o.efGest.get(RG[i]) || 0) + 1);
        } else if (e === 1) o.fa++;
        else o.pe++;

        if (isNoCtrl) o.noCtrl++;
        if (isFaCtrl) o.faCtrl++;

        cnt(o.causa, c);
        cnt(o.tipo, O[i]);
        cnt(o.susp, U[i]);
        if (e === 0) cnt(o.efTipo, O[i]);
        if (e !== 0) cnt(o.sub, S[i]);
        else cnt(o.subEf, S[i]);

        let od = o.day.get(d);
        if (!od) {
          od = [0, 0, 0];
          o.day.set(d, od);
        }
        od[e]++;
        if (M[i] > o.last) o.last = M[i];
      }

      const bo = A.barrio.get(b);
      cnt(bo.tec, t);
      cnt(bo.brig, g);

      let te = bo.tecEf.get(t);
      if (!te) {
        te = { ef: 0, tot: 0, noCtrl: 0 };
        bo.tecEf.set(t, te);
      }
      te.tot++;
      if (e === 0) te.ef++;
      if (isNoCtrl) te.noCtrl++;

      const to = A.tec.get(t);
      to.barrios.add(b);
      cnt(to.brig, g);

      const go = A.brig.get(g);
      go.barrios.add(b);
      cnt(go.tec, t);
    }

    const pct = (x, y) => (y ? (x / y) * 100 : 0);

    for (const m of [A.barrio, A.tec, A.brig]) {
      for (const o of m.values()) {
        o.efPct = pct(o.ef, o.tot);
        o.den = o.tot - o.noCtrl;
        o.efAdj = o.den > 0 ? pct(o.ef, o.den) : 0;
        o.pePct = pct(o.pe, o.tot);
        o.faPct = pct(o.fa, o.tot);
        o.faCtrlPct = pct(o.faCtrl, o.tot);
      }
    }
    A.den = A.tot - A.noCtrl;
    A.efPct = pct(A.ef, A.tot);
    A.efAdj = A.den > 0 ? pct(A.ef, A.den) : 0;
    A.pePct = pct(A.pe, A.tot);
    A.faPct = pct(A.fa, A.tot);

    A.IDX = IDX;
    return A;
  }, [rawArrays, data, V]);

  const A = useMemo(() => agregar(IDX), [agregar, IDX]);

  // Lo mismo, solo con las órdenes de los barrios elegidos: es el acumulado del detalle.
  const Asel = useMemo(() => {
    if (!st.barrios || st.barrios.length < 2) return null;
    const sel = new Set(st.barrios);
    const B = rawArrays.B;
    return agregar(IDX.filter((i) => sel.has(B[i])));
  }, [agregar, IDX, rawArrays, st.barrios]);

  // Igual, con las órdenes de los técnicos (gestores) elegidos.
  const AselTec = useMemo(() => {
    if (!st.tecs || st.tecs.length < 2 || !rawArrays) return null;
    const sel = new Set(st.tecs);
    const Tc = rawArrays.T;
    return agregar(IDX.filter((i) => sel.has(Tc[i])));
  }, [agregar, IDX, rawArrays, st.tecs]);

  // 3. RISK ENGINE (0-100)
  const ELIG = useMemo(() => {
    if (!data || !rawArrays || !A.barrio.size) return [];
    const elig = [];
    for (const [b, o] of A.barrio) {
      if (o.tot >= st.minOrders) elig.push([b, o]);
    }

    // Mitad del rango con datos, no de d0..d1 (ver la misma nota en Dock.js).
    let dmin = Infinity;
    let dmax = -Infinity;
    for (const d of A.byDay.keys()) {
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
    }
    const half = Math.floor((dmin + dmax) / 2);
    const pct = (a, b) => (b ? (a / b) * 100 : 0);

    for (const [, o] of elig) {
      let a1 = 0,
        n1 = 0,
        a2 = 0,
        n2 = 0;
      for (const [d, v] of o.day) {
        const bad = v[1] + v[2];
        const tot = v[0] + v[1] + v[2];
        if (d <= half) {
          a1 += bad;
          n1 += tot;
        } else {
          a2 += bad;
          n2 += tot;
        }
      }
      o.trend = n2 >= 3 && n1 >= 3 ? pct(a2, n2) - pct(a1, n1) : 0;
      let num_ = 0,
        den_ = 0;
      for (const [t, c] of o.tec) {
        const to = A.tec.get(t);
        if (to && to.den > 0) {
          num_ += to.efAdj * c;
          den_ += c;
        }
      }
      o.histTec = den_ ? num_ / den_ : 0;
    }

    const quantile = (sorted, q) => {
      if (!sorted.length) return 0;
      const p = (sorted.length - 1) * q,
        lo = Math.floor(p),
        hi = Math.ceil(p);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
    };

    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    const srt = (f) => elig.map(([, o]) => f(o)).sort((a, b) => a - b);
    const faOf = (o) => (st.adjusted ? o.faCtrlPct : o.faPct);
    const refPe = Math.max(quantile(srt((o) => o.pePct), 0.9), 2);
    const refFa = Math.max(quantile(srt(faOf), 0.9), 2);
    const refVo = Math.max(quantile(srt((o) => o.tot), 0.9), 1);
    const refTr = Math.max(
      quantile(
        srt((o) => o.trend).filter((v) => v > 0),
        0.9
      ) || 10,
      5
    );
    const hi = srt((o) => o.histTec);
    const hGood = quantile(hi, 0.9),
      hBad = quantile(hi, 0.1);

    for (const [, o] of A.barrio) {
      o.risk = null;
      o.prio = null;
      o.mult = null;
      o.pequena = false;
    }
    for (const [, o] of elig) {
      if (V.riesgoPorPromedio) {
        // Cobros: el nivel sale de cuántas veces el promedio pierde el barrio, así
        // que no depende de cuál sea el peor ni de cuántos barrios haya. Los cortes
        // (1×, 2×, 3×) caen en 30, 60 y 80 para reutilizar los colores del índice.
        const m = A.pePct > 0 ? o.pePct / A.pePct : 0;
        o.mult = m;
        o.pequena = o.tot < MUESTRA_PEQUENA;
        o.risk =
          m < 1
            ? Math.round(30 * m)
            : m < 2
            ? 31 + Math.round((m - 1) * 29)
            : m < 3
            ? 61 + Math.round((m - 2) * 19)
            : 81 + Math.round((Math.min(m - 3, 3) / 3) * 19);
        o.parts = { pe: o.risk, fa: 0, vol: 0, tr: 0, hist: 0 };
        o.prio = o.risk >= 81 ? "Crítica" : o.risk >= 61 ? "Alta" : o.risk >= 31 ? "Media" : "Baja";
        continue;
      }
      const rPe = clamp01(o.pePct / refPe);
      const rFa = clamp01(faOf(o) / refFa);
      const rVo = clamp01(o.tot / refVo);
      const rTr = clamp01(o.trend / refTr);
      const rHi =
        hGood > hBad ? 1 - clamp01((o.histTec - hBad) / (hGood - hBad)) : 0;
      const W = V.pesos;
      o.risk = Math.round(
        100 * (W.pe * rPe + W.fa * rFa + W.vol * rVo + W.tr * rTr + W.hist * rHi)
      );
      o.parts = {
        pe: 100 * W.pe * rPe,
        fa: 100 * W.fa * rFa,
        vol: 100 * W.vol * rVo,
        tr: 100 * W.tr * rTr,
        hist: 100 * W.hist * rHi
      };
      o.prio = o.risk >= 61 ? "Alta" : o.risk >= 31 ? "Media" : "Baja";
    }

    return elig;
  }, [A, IDX, rawArrays, data, V, st.minOrders, st.hotspot, st.adjusted, st.d0, st.d1]);

  // Zone Average calculations helper
  const zoneAvg = (zonaIdx) => {
    let tot = 0,
      ef = 0,
      pe = 0,
      fa = 0,
      noCtrl = 0;
    if (!data) return { tot, efPct: 0, efAdj: 0, pePct: 0, faPct: 0 };
    for (const [b, o] of A.barrio) {
      if (zonaIdx != null && data.dim.b_zona[b] !== zonaIdx) continue;
      tot += o.tot;
      ef += o.ef;
      pe += o.pe;
      fa += o.fa;
      noCtrl += o.noCtrl;
    }
    const den = tot - noCtrl;
    const pct = (x, y) => (y ? (x / y) * 100 : 0);
    return {
      tot,
      efPct: pct(ef, tot),
      efAdj: den ? pct(ef, den) : 0,
      pePct: pct(pe, tot),
      faPct: pct(fa, tot)
    };
  };

  // Recommended actions generator engine
  const actionsFor = (bIdx, o, z) => {
    const acts = [];
    if (!data || !rawArrays) return acts;
    const { C } = rawArrays;
    const bad = o.tot - o.ef;
    const fam = new Map();

    for (const [c, n] of o.causa) {
      if (data.dim.causas[c] === "Efectiva") continue;
      const f = data.dim.causa_fam[c];
      fam.set(f, (fam.get(f) || 0) + n);
    }
    const f = (k) => fam.get(k) || 0;
    const share = (k) => (bad ? (f(k) / bad) * 100 : 0);
    const n0 = (v) => Math.round(v).toLocaleString("es-CO");
    const n1 = (v) => v.toFixed(1).replace(".", ",");

    if (f("seguridad") > 0 && share("seguridad") >= 30) {
      acts.push({
        lvl: "crit",
        t: "Solicitar acompañamiento policial o gestor social",
        d: `<b>${n0(
          f("seguridad")
        )}</b> ${V.ordenesMin} se perdieron por resistencia o agresión del cliente (${n1(
          share("seguridad")
        )}% de las no efectivas).
            Reasignar al ${V.tecnicoMin} <b>no resuelve esto</b>: la causa es de seguridad, no de competencia. Programa estas visitas con acompañamiento.`
      });
    }
    if (share("comercial") >= 35) {
      acts.push({
        lvl: "warn",
        t: "Sincronizar cartera antes del despacho",
        d: `<b>${n0(
          f("comercial")
        )}</b> ${V.ordenesMin} fallaron porque el cliente ya había pagado. Son visitas evitables:
            depurar la cartera el mismo día del despacho liberaría cerca de <b>${n0(
              f("comercial")
            )}</b> desplazamientos en este barrio.`
      });
    }
    if (share("acceso") >= 12) {
      acts.push({
        lvl: "warn",
        t: "Programar reintentos en franja alterna",
        d: `<b>${n0(
          f("acceso")
        )}</b> ${V.ordenesMin} con acceso impedido o difícil. Reprograma en horario distinto y coordina ingreso
            con portería o administración en multifamiliares.`
      });
    }
    if (share("datos") >= 8) {
      acts.push({
        lvl: "warn",
        t: "Revisar direcciones en catastro",
        d: `<b>${n0(
          f("datos")
        )}</b> ${V.ordenesMin} no se ubicaron (suministro no encontrado, servicio inexistente o predio demolido).
            Enviar a validación de datos antes de volver a despachar.`
      });
    }
    if (share("infra") >= 15) {
      acts.push({
        lvl: "warn",
        t: `Reforzar con ${V.brigadaMin} especializada`,
        d: `<b>${n0(
          f("infra")
        )}</b> ${V.ordenesMin} con imposibilidad técnica o sin medidor. Asigna ${V.brigadaMin} pesada o cuadrilla con canasta
            en lugar de ${V.brigadaMin} liviana.`
      });
    }
    if (o.efAdj < z.efAdj - 8 && o.tot >= st.minOrders) {
      acts.push({
        lvl: "crit",
        t: `Redistribuir carga entre ${V.tecnicosMin}`,
        d: `La efectividad ${V.sinAjuste ? "" : "ajustada "}del barrio (<b>${n1(
          o.efAdj
        )}%</b>) está <b>${n1(
          z.efAdj - o.efAdj
        )} pp</b> por debajo de su zona.
            Aquí sí hay margen operativo: revisa el ranking y reasigna a los ${V.tecnicosMin} con mejor desempeño${V.sinAjuste ? "" : " ajustado"}.`
      });
    }
    if (o.trend > 5) {
      acts.push({
        lvl: "crit",
        t: "Priorizar intervención: deterioro sostenido",
        d: `Las ${V.ordenesMin} no efectivas subieron <b>${n1(
          o.trend
        )} pp</b> en la segunda mitad del período. Interviene antes de que el barrio
            se consolide como crítico.`
      });
    }
    if (o.tec.size <= 2 && o.tot >= 40) {
      acts.push({
        lvl: "info",
        t: `Ampliar cobertura de ${V.tecnicosMin}`,
        d: `Solo <b>${
          o.tec.size
        }</b> ${V.tecnicoMin}(s) atienden <b>${n0(
          o.tot
        )}</b> ${V.ordenesMin}. Un único punto de falla: amplía el pool asignado.`
      });
    }
    if (!acts.length) {
      acts.push({
        lvl: "ok",
        t: "Sin alertas operativas",
        d: "El barrio se comporta dentro de los parámetros de su zona. Mantener el esquema actual de asignación."
      });
    }
    return acts;
  };

  // 4. RECOMMEND ENGINE
  const recommend = (bIdx, tipoIdx, kind) => {
    if (!data || !rawArrays) return [];
    const muni = data.dim.b_muni[bIdx];
    const zona = data.dim.b_zona[bIdx];
    const { B, O, T, G, E, C, M } = rawArrays;
    // En cobros toda perdida cuenta, así que ninguna causa se descarta como "no controlable".
    const CTRL = V.sinAjuste ? data.dim.causa_ctrl.map(() => 1) : data.dim.causa_ctrl;

    const levels = [
      {
        name: `este barrio y ${V.esteTipo}`,
        test: (i) => B[i] === bIdx && (tipoIdx < 0 || O[i] === tipoIdx)
      },
      { name: "este barrio (todos los tipos)", test: (i) => B[i] === bIdx },
      {
        name: `este municipio y ${V.esteTipo}`,
        test: (i) => data.dim.b_muni[B[i]] === muni && (tipoIdx < 0 || O[i] === tipoIdx)
      },
      {
        name: `esta zona y ${V.esteTipo}`,
        test: (i) => data.dim.b_zona[B[i]] === zona && (tipoIdx < 0 || O[i] === tipoIdx)
      }
    ];

    const wilson = (s, n) => {
      if (!n) return 0;
      const z = 1.96,
        p = s / n;
      const d = 1 + (z * z) / n;
      const c = p + (z * z) / (2 * n);
      const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
      return Math.max(0, (c - m) / d);
    };

    const pct = (x, y) => (y ? (x / y) * 100 : 0);

    for (const lv of levels) {
      const agg = new Map();
      for (let j = 0; j < IDX.length; j++) {
        const i = IDX[j];
        if (!lv.test(i)) continue;
        const key = kind === "tec" ? T[i] : G[i];
        let o = agg.get(key);
        if (!o) {
          o = { n: 0, ef: 0, noCtrl: 0, last: -1, pe: 0 };
          agg.set(key, o);
        }
        const ctrl = E[i] === 0 ? 1 : CTRL[C[i]];
        if (E[i] !== 0 && ctrl === 0) o.noCtrl++;
        o.n++;
        if (E[i] === 0) o.ef++;
        if (E[i] === 2) o.pe++;
        if (M[i] > o.last) o.last = M[i];
      }

      const rows = [];
      for (const [key, o] of agg) {
        const den = o.n - o.noCtrl;
        if (den < 3) continue;
        const w = wilson(o.ef, den);
        rows.push({
          key,
          name: kind === "tec" ? data.dim.tecs[key] : data.dim.brigs[key],
          n: o.n,
          den,
          ef: o.ef,
          pe: o.pe,
          efAdj: pct(o.ef, den),
          score: w * 100,
          last: o.last,
          conf:
            den >= 30 && w >= 0.75
              ? "Alta"
              : den >= 10 && w >= 0.55
              ? "Media"
              : "Baja",
          scope: lv.name
        });
      }
      if (rows.length >= 2) {
        rows.sort((a, b) => b.score - a.score);
        return rows;
      }
    }
    return [];
  };

  // Helper date formatter
  const dayLabel = (d) => {
    const D0 = new Date((data ? data.meta.fecha_min : "2026-05-01") + "T00:00:00");
    const x = new Date(D0.getTime() + d * 86400000);
    return x.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
  };

  // State update handler
  const handleFilterChange = (key, value) => {
    // Capas flota sobre el mapa y el panel inferior se come casi todo su alto: al abrir
    // uno de esos menús se pliega (se puede volver a abrir) y vuelve al regresar al mapa.
    if (key === "activeTab") {
      const inferior = ["tendencias", "causas", "ranking", "carga", "jerarquia"].includes(value);
      setLayersCollapsed((c) => (inferior ? true : value === "mapa" ? false : c));
    }
    // Elegir un menú inferior desde el lateral lo abre aunque se hubiera contraído.
    if (key === "activeTab" && ["tendencias", "causas", "ranking", "carga", "jerarquia"].includes(value)) {
      setSt((prev) => (prev.dockCollapsed ? { ...prev, dockCollapsed: false } : prev));
    }
    setSt((prev) => {
      const next = { ...prev, [key]: value };

      if (key === "months") {
        const selIdx = new Set(
          value.map((k) => monthMap.keyToIdx.get(k)).filter((v) => v !== undefined)
        );
        let minD = 99999;
        let maxD = 0;
        const DAY = rawArrays.DAY;
        const MI = monthMap.idx;
        const N = DAY.length;
        for (let i = 0; i < N; i++) {
          if (selIdx.has(MI[i])) {
            if (DAY[i] < minD) minD = DAY[i];
            if (DAY[i] > maxD) maxD = DAY[i];
          }
        }
        if (minD !== 99999) {
          next.d0 = minD;
          next.d1 = maxD;
        }
      }

      // Cascade resets
      if (key === "zona") {
        next.muni = "";
        next.brig = "";
        next.barrios = [];
        next.selBarrio = null;
      }
      if (key === "muni") {
        next.brig = "";
        next.barrios = [];
        next.selBarrio = null;
      }
      if (key === "selBarrio") {
        return conBarrios(next, value == null ? [] : [value]);
      }
      if (key === "minOrders" || key === "adjusted") {
        next.barrios = [];
        next.selBarrio = null;
      }
      return next;
    });
  };

  // Deja la selección en `lista`. Con un solo barrio `selBarrio` lo repite, que es lo que
  // lee todo lo que analiza un barrio; con varios queda null y el detalle pasa a acumulado.
  const conBarrios = (prev, lista) => ({
    ...prev,
    barrios: lista,
    selBarrio: lista.length === 1 ? lista[0] : null,
    jerBarrio: lista.length === 1 ? lista[0] : null,
    ...(lista.length ? { tab: "barrio", jerBrig: null } : {})
  });

  const handleSelectBarrio = (b) => {
    setSt((prev) => {
      // Segundo clic sobre el mismo barrio (si es el único elegido) → quitar la
      // selección y volver a mostrar todos los barrios y sus límites.
      if (prev.barrios.length === 1 && prev.barrios[0] === b) return conBarrios(prev, []);
      return conBarrios(prev, [b]);
    });
  };

  // La casilla de cada barrio en la cola de triaje: suma o quita ese barrio de la selección.
  const handleToggleBarrio = (b) => {
    setSt((prev) =>
      conBarrios(prev, prev.barrios.includes(b) ? prev.barrios.filter((x) => x !== b) : [...prev.barrios, b])
    );
  };

  // Limpia solo los barrios remarcados (sin tocar el resto de filtros)
  const handleClearBarrio = () => {
    setSt((prev) => conBarrios(prev, []));
  };

  // Lo que el usuario tiene filtrado, en nombres. Sin esto el chat responde sobre
  // todo el histórico mientras la persona mira un mes y una zona concretos.
  const vistaParaChat = () => {
    if (!data) return null;
    const dim = data.dim;
    const nombre = (lista, valor) =>
      valor === "" || valor == null ? null : lista[+valor] ?? null;

    // st.months guarda etiquetas ("Agosto de 2026"); el backend espera YYYY-MM.
    const porEtiqueta = new Map((data.meta.months || []).map((m) => [m.label, m.key]));

    return {
      barrio: st.selBarrio != null ? dim.barrios[st.selBarrio] ?? null : null,
      barrios: (st.barrios || []).map((i) => dim.barrios[i]).filter(Boolean),
      tecnicos: (st.tecs || []).map((i) => dim.tecs[i]).filter(Boolean),
      municipio: nombre(dim.munis, st.muni),
      zona: nombre(dim.zonas, st.zona),
      brigada: nombre(dim.brigs, st.brig),
      tipo_os: nombre(dim.tipos, st.tipo),
      actividad: dim.acts ? nombre(dim.acts, st.act) : null,
      proceso,
      meses: (st.months || []).map((l) => porEtiqueta.get(l)).filter(Boolean)
    };
  };


  // El archivo llega sin coordenadas: el backend las resuelve cruzando NIC y
  // dirección contra el histórico que indexa el ETL. Es una sola petición y
  // responde completo — antes esto sondeaba cada 5 s porque geocodificaba
  // contra un servicio externo a una dirección por segundo.
  useEffect(() => {
    if (!cargue?.id) return;

    const api = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
    const controller = new AbortController();
    let cancelado = false;

    (async () => {
      try {
        const res = await fetch(`${api}/api/v1/ordenes/${cargue.id}/puntos?proceso=${proceso}`, {
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
        const datos = await res.json();
        if (!cancelado) setOrdenes(datos);
      } catch (err) {
        if (err.name === "AbortError" || cancelado) return;
        // Sin puntos el mapa simplemente no dibuja la capa; el chat sigue
        // funcionando, así que no se interrumpe nada más por esto.
        console.warn("No se pudieron ubicar las órdenes del cargue:", err.message);
        setOrdenes(null);
      }
    })();

    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [cargue?.id]);

  // El asistente responde con NOMBRES (no conoce el orden de las dimensiones del
  // payload); aquí se traducen a los índices que espera el estado del tablero.
  const handleAccionChat = (accion) => {
    if (!data || !accion) return;
    const dim = data.dim;

    const idxDe = (lista, valor) => {
      if (!valor || !lista) return null;
      const objetivo = String(valor).trim().toLowerCase();
      const i = lista.findIndex((v) => String(v).trim().toLowerCase() === objetivo);
      return i >= 0 ? String(i) : null;
    };

    setSt((prev) => {
      const next = { ...prev };

      // Con barrios resueltos (uno o varios) se abre su análisis.
      let conBarrios = false;
      let conTecnicos = false;

      const zona = idxDe(dim.zonas, accion.zona);
      if (zona !== null) next.zona = zona;
      const muni = idxDe(dim.munis, accion.municipio);
      if (muni !== null) next.muni = muni;
      const brig = idxDe(dim.brigs, accion.brigada);
      if (brig !== null) next.brig = brig;
      const tipo = idxDe(dim.tipos, accion.tipo_os);
      if (tipo !== null) next.tipo = tipo;
      if (dim.acts) {
        const act = idxDe(dim.acts, accion.actividad);
        if (act !== null) next.act = act;
      }

      // Varios barrios: BKEYs, igual que en dim.barrios. Un barrio que el catálogo no
      // conoce se salta en vez de vaciar el tablero.
      if (accion.barrios?.length) {
        const lista = accion.barrios.map((k) => idxDe(dim.barrios, k)).filter((i) => i !== null).map(Number);
        if (lista.length) {
          next.barrios = lista;
          next.selBarrio = lista.length === 1 ? lista[0] : null;
          next.jerBarrio = lista.length === 1 ? lista[0] : null;
          next.tab = "barrio";
          conBarrios = true;
        }
      }

      // Técnicos (gestores en COBROS): nombres de catálogo, igual que en dim.tecs. Uno que el
      // catálogo no conoce se salta en vez de vaciar el análisis.
      if (accion.tecnicos?.length) {
        const lista = accion.tecnicos.map((n) => idxDe(dim.tecs, n)).filter((i) => i !== null).map(Number);
        if (lista.length) {
          next.tecs = lista;
          if (!conBarrios) next.tab = "tecnico";
          conTecnicos = true;
        }
      }

      // Capas que el asistente pide ver (puntos GPS al listar visitas, calor, aproximadas).
      if (accion.capas?.length) {
        const clave = { gps: "gps", calor: "heat", aproximadas: "approx" };
        next.layers = { ...prev.layers };
        for (const c of accion.capas) if (clave[c]) next.layers[clave[c]] = true;
      }

      // El barrio llega como BKEY ("MUNICIPIO | BARRIO"), igual que en dim.barrios.
      const b = idxDe(dim.barrios, accion.barrio);
      if (b !== null) {
        next.barrios = [+b];
        next.selBarrio = +b;
        next.tab = "barrio";
        next.jerBarrio = +b;
        next.jerBrig = null;
        conBarrios = true;
      }

      // st.months guarda etiquetas ("Agosto de 2026"), no claves YYYY-MM.
      if (accion.meses?.length && data.meta.months) {
        const etiquetas = accion.meses
          .map((ym) => data.meta.months.find((m) => m.key === ym)?.label)
          .filter(Boolean);
        if (etiquetas.length) next.months = etiquetas;
      }

      // Con un barrio resuelto se abre su análisis, igual que al hacer clic en el
      // mapa; sin barrio no hay nada que detallar y se deja la vista de mapa.
      next.activeTab = conBarrios || conTecnicos ? "detalle" : "mapa";
      return next;
    });
  };

  const handleReset = () => {
    setSt((prev) => ({
      ...prev,
      zona: "",
      muni: "",
      brig: "",
      tipo: "",
      act: "",
      gest: "",
      cob: "",
      causaSel: null,
      efOcultas: [],
      d0: 0,
      d1: MAXDAY,
      minOrders: proceso === "cobros" ? 1 : 10,
      hotspot: 60,
      adjusted: true,
      est: [true, true, true],
      efOcultas: [],
      barrios: [],
      selBarrio: null,
      tecs: [],
      // Vuelve al mes en curso (mantiene el arranque liviano; los históricos se
      // vuelven a descargar solo si se seleccionan).
      months: (() => {
        const recent = availableMonths.find((m) => m.recent);
        return recent ? [recent.key] : availableMonths.map((m) => m.key);
      })(),
      activeTab: "mapa"
    }));
  };

  // Botón "Actualizar información": borra la caché local, vacía de memoria todos
  // los meses menos el actual, y vuelve a pedir el mes en curso fresco (saltando
  // también la caché HTTP con un cache-buster).
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      await cacheClear();
      setLoadingMonths([]);
      const resData = await fetch(`/${proceso}/data.json?t=` + Date.now(), {
        cache: "no-store"
      }).then((r) => r.json());
      cachePut(`${proceso}/data.json`, resData);
      applyEntryData(resData);
      setRefreshResult("ok");
    } catch (err) {
      console.error("No se pudo actualizar la información", err);
      setRefreshResult("error");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="loader-screen">
        <div className="loader-badge">
          <span className="loader-ring-bg" aria-hidden="true" />
          <span className="loader-ring" aria-hidden="true" />
          <Image
            src={isesSymbol}
            alt="ISES"
            priority
            className="ises-spin loader-logo"
          />
        </div>
        <div className="loader-title">CARGANDO VISOR OPERATIVO</div>
        <div className="loader-bar" role="progressbar" aria-label="Cargando información">
          <span className="loader-bar-fill" />
        </div>
      </div>
    );
  }

  // Inject computed parameters to pass into state
  const computedSt = {
    ...st,
    // Órdenes efectivamente cargadas en memoria (crece al bajar más meses).
    totalLoaded: rawArrays ? rawArrays.E.length : data.meta.total,
    fechaMin: data.meta.fecha_min,
    fechaMax: data.meta.fecha_max,
    generated: data.meta.generated,
    lat,
    lon,
    // Add raw properties needed by Dock hierarchy
    B_raw: rawArrays.B,
    G_raw: rawArrays.G,
    T_raw: rawArrays.T,
    E_raw: rawArrays.E,
    ORD_raw: rawArrays.ORD,
    C_raw: rawArrays.C,
    S_raw: rawArrays.S,
    DAY_raw: rawArrays.DAY,
    M_raw: rawArrays.M,
    APPROX_raw: rawArrays.APPROX,
    O_raw: rawArrays.O,
    U_raw: rawArrays.U,
    F_raw: rawArrays.F,
    NIC_raw: rawArrays.NIC,
    GEST_RAW: rawArrays.GEST,
    RG_RAW: rawArrays.RG,
    COB_RAW: rawArrays.COB,
    SD_raw: rawArrays.SD,
    CH_raw: rawArrays.CH,
    RC_raw: rawArrays.RC,
    availableMonths,
    proceso,
    tablaGestores,
    // Lo que muestra la barra superior (barrios, gestores, fechas) ya filtrado.
    contexto: (() => {
      let dmin = Infinity;
      let dmax = -Infinity;
      for (const d of A.byDay.keys()) {
        if (d < dmin) dmin = d;
        if (d > dmax) dmax = d;
      }
      const iso = (d) => {
        const x = new Date(new Date(data.meta.fecha_min + "T00:00:00").getTime() + d * 86400000);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      };
      return {
        barrios: A.barrio.size,
        gestores: A.tec.size,
        desde: dmin === Infinity ? null : iso(dmin),
        hasta: dmax === -Infinity ? null : iso(dmax),
      };
    })(),
    CA_RAW: rawArrays.CA,
    SC_RAW: rawArrays.SC,
    // Motivo elegido en el panel de causas: el mapa dibuja solo esas gestiones.
    causaPasa: (i) => {
      // Efectivas apagadas en el submenú de Capas («con pago», «sin recaudo»…).
      if (st.efOcultas.length && rawArrays.E[i] === 0 && st.efOcultas.includes(rawArrays.RG[i])) return false;
      const s = st.causaSel;
      if (!s) return true;
      const estados = s.fx === "R" ? rawArrays.RG : rawArrays.GEST;
      if (s.campo === "C") return rawArrays.C[i] === s.id && estados[i] === s.x;
      if (s.campo === "CA") return rawArrays.CA[i] === s.id && estados[i] === s.x;
      if (s.campo === "T") return rawArrays.T[i] === s.id;
      return rawArrays.SC[i] === s.id;
    }
  };

  const handleSelectNic = (nic) => {
    setSt((prev) => ({
      ...prev,
      selNic: nic,
      tab: "nic"
    }));
  };

  // V4 Enfoque Layout Implementation
  if (st.layout === "enfoque") {
    let rightPanelContent = null;
    let bottomPanelContent = null;

    if (st.activeTab === "triaje") {
      rightPanelContent = (
        <aside className="v4-panel triaje-panel" style={{ flex: "0 0 380px", minWidth: "380px", maxWidth: "46%", borderLeft: "1px solid var(--line2)", background: "var(--pan)", overflowY: "auto", position: "relative" }}>
          <RiskSpine
            ELIG={ELIG}
            st={computedSt}
            dim={data.dim}
            onFilterChange={handleFilterChange}
            onSelectBarrio={(b) => {
              handleSelectBarrio(b);
              handleFilterChange("activeTab", "detalle");
            }}
            // Marcar casillas no cambia de pestaña: se eligen varios y luego «Ver detalle».
            onToggleBarrio={handleToggleBarrio}
            V={V}
          />
        </aside>
      );
    } else if (st.activeTab === "detalle") {
      rightPanelContent = (
        <aside className="v4-panel details-panel" style={{ flex: "0 0 380px", minWidth: "380px", maxWidth: "46%", borderLeft: "1px solid var(--line2)", background: "var(--pan)", overflowY: "auto", position: "relative" }}>
          <DetailsPanel
            st={computedSt}
            A={A}
            Asel={Asel}
            AselTec={AselTec}
            ELIG={ELIG}
            dim={data.dim}
            geo={data.geo}
            dayLabel={dayLabel}
            recommend={recommend}
            zoneAvg={zoneAvg}
            actionsFor={actionsFor}
            onFilterChange={handleFilterChange}
            onSelectBarrio={handleSelectBarrio}
            onSelectNic={handleSelectNic}
            V={V}
          />
        </aside>
      );
    } else if (st.activeTab !== "mapa") {
      // Must be a bottom tab: "tendencias", "causas", "ranking", "carga", "jerarquia"
      // In the original dock, 'causas' key corresponds to 'motivos' tab
      const dockTab = st.activeTab === "causas" ? "motivos" : st.activeTab;
      bottomPanelContent = (
        <div className="v4-bottom-dock" style={{ height: st.dockCollapsed ? "auto" : "340px", flex: st.dockCollapsed ? "0 0 auto" : "0 0 340px", borderTop: "1px solid var(--line2)", background: "var(--pan)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Dock
            A={A}
            st={{ ...computedSt, dock: dockTab }}
            dim={data.dim}
            dayLabel={dayLabel}
            onFilterChange={(key, value) => {
              if (key === "dock") {
                const mappedTab = value === "motivos" ? "causas" : value;
                handleFilterChange("activeTab", mappedTab);
              } else if (key === "selBarrio") {
                handleSelectBarrio(value);
                handleFilterChange("activeTab", "detalle");
              } else {
                handleFilterChange(key, value);
              }
            }}
            onSelectBarrio={(b) => {
              handleSelectBarrio(b);
              handleFilterChange("activeTab", "detalle");
            }}
            onSelectNic={(nic) => {
              handleSelectNic(nic);
              handleFilterChange("activeTab", "detalle");
            }}
            V={V}
          />
        </div>
      );
    }

    return (
      <div id="app" className="v4-layout" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--bg)", color: "var(--tx)" }}>
        <Topbar
          st={computedSt}
          dim={data.dim}
          avail={avail}
          onFilterChange={handleFilterChange}
          onReset={handleReset}
          availableMonths={availableMonths}
          loadingMonths={loadingMonths}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          refreshResult={refreshResult}
          proceso={proceso}
          onProceso={setProceso}
        />

        <main id="main" className="v4-main" style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Navigation Left Rail */}
          <nav className="v4-rail" style={{ width: "66px", flex: "0 0 66px", background: "var(--pan)", borderRight: "1px solid var(--line2)", display: "flex", flexDirection: "column", gap: "2px", padding: "8px 0", overflowY: "auto", zIndex: 10 }}>
            {[
              { id: "mapa", label: "Mapa", icon: "🗺️" },
              { id: "triaje", label: "Triaje", icon: "📋" },
              { id: "tendencias", label: "Tendencias", icon: "📈" },
              { id: "causas", label: "Causas", icon: "⚠️" },
              { id: "ranking", label: "Ranking", icon: "🏆" },
              { id: "carga", label: "Carga", icon: "⚡" },
              { id: "jerarquia", label: "Jerarquía", icon: "🌳" },
              { id: "detalle", label: "Detalle", icon: "ℹ️" },
            ].map((dest) => {
              const active = st.activeTab === dest.id;
              return (
                <button
                  key={dest.id}
                  type="button"
                  className={`rail-btn ${active ? "active" : ""}`}
                  onClick={() => handleFilterChange("activeTab", dest.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "100%",
                    minHeight: "44px",
                    padding: "8px 0",
                    background: active ? "var(--cu-deep)" : "transparent",
                    border: "none",
                    borderLeft: active ? "3px solid var(--cu)" : "3px solid transparent",
                    color: active ? "var(--tx)" : "var(--dim)",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    fontFamily: "var(--ff)",
                  }}
                >
                  <span className="rail-icon" style={{ fontSize: "18px", marginBottom: "4px" }}>{dest.icon}</span>
                  <span className="rail-label" style={{ fontSize: "8px", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em" }}>{dest.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Central Map & Bottom Dock Column */}
          <section id="center" className="v4-center-column" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
            <div className="v4-map-container" style={{ flex: 1, minHeight: 0, position: "relative" }}>
              <LeafletMap
                A={A}
                st={computedSt}
                dim={data.dim}
                geo={data.geo}
                onSelectBarrio={(b) => {
                  handleSelectBarrio(b);
                  handleFilterChange("activeTab", "detalle");
                }}
                onSelectNic={(nic) => {
                  handleSelectNic(nic);
                  handleFilterChange("activeTab", "detalle");
                }}
                onFilterChange={handleFilterChange}
                dayLabel={dayLabel}
                ordenes={ordenes}
                V={V}
              />

              {st.causaSel && (
                <button
                  type="button"
                  className="filtro-activo"
                  onClick={() => handleFilterChange("causaSel", null)}
                  title="Quitar el filtro y volver a ver todas las gestiones"
                >
                  Mostrando solo:{" "}
                  <b>
                    {st.causaSel.campo === "C"
                      ? data.dim.causas[st.causaSel.id]
                      : st.causaSel.campo === "CA"
                      ? data.dim.anoms[st.causaSel.id]
                      : st.causaSel.campo === "SC"
                      ? data.dim.subcausas[st.causaSel.id]
                      : data.dim.tecs[st.causaSel.id].replace(/\s*-\s*\d+\s*$/, "")}
                  </b>{" "}
                  <X size={13} strokeWidth={2.4} aria-hidden="true" />
                </button>
              )}

              {st.selBarrio != null && (
                <button
                  type="button"
                  onClick={handleClearBarrio}
                  title="Mostrar todos los barrios y sus límites"
                  style={{
                    position: "absolute",
                    top: "12px",
                    right: "12px",
                    zIndex: 800,
                    display: "flex",
                    alignItems: "center",
                    gap: "7px",
                    padding: "7px 11px",
                    background: "var(--overlay)",
                    border: "1px solid var(--line2)",
                    borderRadius: "var(--r)",
                    color: "var(--cu2)",
                    cursor: "pointer",
                    font: "600 12px var(--ff)",
                    letterSpacing: ".04em",
                    backdropFilter: "blur(6px)",
                    boxShadow: "var(--shadow)"
                  }}
                >
                  <X size={14} strokeWidth={2.4} aria-hidden="true" />
                  Ver todos los barrios
                </button>
              )}

              <div className="v4-layers-overlay" style={{ position: "absolute", top: "12px", left: "12px", zIndex: 800 }}>
                <div id="layers" style={layersCollapsed ? { width: "auto", minWidth: 0, whiteSpace: "nowrap" } : undefined}>
                  <button
                    type="button"
                    onClick={() => setLayersCollapsed((v) => !v)}
                    title={layersCollapsed ? "Mostrar capas" : "Ocultar capas"}
                    aria-expanded={!layersCollapsed}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      margin: layersCollapsed ? 0 : "0 0 8px",
                      color: "var(--cu2)",
                      cursor: "pointer",
                      font: "inherit",
                      fontFamily: "var(--ff)",
                      fontSize: "12px",
                      fontWeight: 700,
                      letterSpacing: ".14em",
                      textTransform: "uppercase"
                    }}
                  >
                    <span>Capas</span>
                    <span
                      style={{
                        display: "flex",
                        transform: layersCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                        transition: "transform .15s ease"
                      }}
                    >
                      <ChevronRight size={13} strokeWidth={2.4} aria-hidden="true" />
                    </span>
                  </button>

                  {!layersCollapsed && (
                    <>
                      <h4>{V.ordenes} a mostrar</h4>
                      <label className="lay">
                        <input
                          type="checkbox"
                          checked={st.est[2]}
                          disabled={avail.tipos[2] === 0}
                          onChange={(e) => {
                            const est = [...st.est];
                            est[2] = e.target.checked;
                            handleFilterChange("est", est);
                          }}
                        />
                        <span className="sw" style={{ background: P.st[2] }}></span>
                        Perdidas
                      </label>
                      <label className="lay">
                        <input
                          type="checkbox"
                          checked={st.est[0]}
                          disabled={avail.tipos[0] === 0}
                          onChange={(e) => {
                            const est = [...st.est];
                            est[0] = e.target.checked;
                            handleFilterChange("est", est);
                          }}
                        />
                        <span className="sw" style={{ background: P.st[0] }}></span>
                        Efectivas
                      </label>
{data.dim.resultados && (
  <div className="lay-sub">
    {data.dim.resultados.map((nombre, id) =>
      nombre === "No efectiva" || !(avail.efRec.get(id) > 0) ? null : (
        <label key={id} className="lay">
          <input
            type="checkbox"
            checked={!st.efOcultas.includes(id)}
            disabled={!st.est[0]}
            onChange={(e) => {
              const resto = st.efOcultas.filter((x) => x !== id);
              handleFilterChange("efOcultas", e.target.checked ? resto : [...resto, id]);
            }}
          />
          {nombre}
        </label>
      )
    )}
  </div>
)}

                      {ordenes && (
  <CapasCargue
    layers={st.layers}
    onLayers={(layers) => handleFilterChange("layers", layers)}
    V={V}
  />
)}

                      <div className="lgrp">
                        <h4>Cómo dibujarlas</h4>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.markers}
                            onChange={(e) => {
                              const layers = { ...st.layers, markers: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Marcadores por barrio
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.heat}
                            onChange={(e) => {
                              const layers = { ...st.layers, heat: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Mapa de calor
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.gps}
                            onChange={(e) => {
                              const layers = { ...st.layers, gps: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          GPS reales
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.approx}
                            onChange={(e) => {
                              const layers = { ...st.layers, approx: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Ubicaciones aproximadas
                        </label>
                        <p className="lay-nota">
                          Los <b>marcadores</b> resumen cada barrio (clic → análisis). Los <b>puntos GPS</b> son {V.ordenesMin} sueltas (clic → detalle).
                        </p>
                      </div>

                      <div className="lgrp">
                        <h4>Límites oficiales</h4>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.zpoly}
                            onChange={(e) => {
                              const layers = { ...st.layers, zpoly: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Zonas
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.bpoly}
                            onChange={(e) => {
                              const layers = { ...st.layers, bpoly: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Barrios
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.mpoly}
                            onChange={(e) => {
                              const layers = { ...st.layers, mpoly: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Municipios
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.cpoly}
                            onChange={(e) => {
                              const layers = { ...st.layers, cpoly: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Corregimientos
                        </label>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.vpoly}
                            onChange={(e) => {
                              const layers = { ...st.layers, vpoly: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          Veredas
                        </label>
                      </div>

                      <div className="lgrp">
                        <h4>Cobertura</h4>
                        <label className="lay">
                          <input
                            type="checkbox"
                            checked={st.layers.sinNic}
                            onChange={(e) => {
                              const layers = { ...st.layers, sinNic: e.target.checked };
                              handleFilterChange("layers", layers);
                            }}
                          />
                          <span className="sw" style={{ background: P.sinNic }}></span>
                          Barrios sin visitar
                        </label>
                        <p className="lay-nota">
                          Barrios (polígonos) sin ninguna {V.ordenMin || "orden"} registrada. Se resaltan en amarillo fuerte.
                        </p>
                      </div>


                      <div className="lgrp" id="legend">
                        <h4>Índice de riesgo</h4>
                        {(V.riesgoPorPromedio ? NIVELES_COBROS : NIVELES_SCR).map(([r, t]) => (
  <div key={t}>
    <i style={{ background: riskColor(P, r) }}></i> {t}
  </div>
))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Dock Content */}
            {bottomPanelContent}
          </section>

          {/* Right Active Panel */}
          {rightPanelContent}
        </main>
      </div>
    );
  }

  // Classic Layout fallback
  return (
    <div id="app">
      <Topbar
        st={computedSt}
        dim={data.dim}
        avail={avail}
        onFilterChange={handleFilterChange}
        onReset={handleReset}
        availableMonths={availableMonths}
        loadingMonths={loadingMonths}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        refreshResult={refreshResult}
        proceso={proceso}
        onProceso={setProceso}
      />


      <main id="main">
        <RiskSpine
          ELIG={ELIG}
          st={computedSt}
          dim={data.dim}
          onFilterChange={handleFilterChange}
          onSelectBarrio={handleSelectBarrio}
          onToggleBarrio={handleToggleBarrio}
          V={V}
        />

        <section id="center">
          <LeafletMap
            A={A}
            st={computedSt}
            dim={data.dim}
            geo={data.geo}
            onSelectBarrio={handleSelectBarrio}
            onSelectNic={handleSelectNic}
            onFilterChange={handleFilterChange}
            dayLabel={dayLabel}
            ordenes={ordenes}
            V={V}
          />

          {st.selBarrio != null && (
            <button
              type="button"
              onClick={handleClearBarrio}
              title="Mostrar todos los barrios y sus límites"
              style={{
                position: "absolute",
                top: "12px",
                right: "12px",
                zIndex: 800,
                display: "flex",
                alignItems: "center",
                gap: "7px",
                padding: "7px 11px",
                background: "var(--overlay)",
                border: "1px solid var(--line2)",
                borderRadius: "var(--r)",
                color: "var(--cu2)",
                cursor: "pointer",
                font: "600 12px var(--ff)",
                letterSpacing: ".04em",
                backdropFilter: "blur(6px)",
                boxShadow: "var(--shadow)"
              }}
            >
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
              Ver todos los barrios
            </button>
          )}

          <div id="layers" style={layersCollapsed ? { width: "auto", minWidth: 0, whiteSpace: "nowrap" } : undefined}>
            <button
              type="button"
              onClick={() => setLayersCollapsed((v) => !v)}
              title={layersCollapsed ? "Mostrar capas" : "Ocultar capas"}
              aria-expanded={!layersCollapsed}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                width: "100%",
                background: "transparent",
                border: "none",
                padding: 0,
                margin: layersCollapsed ? 0 : "0 0 8px",
                color: "var(--cu2)",
                cursor: "pointer",
                font: "inherit",
                fontFamily: "var(--ff)",
                fontSize: "12px",
                fontWeight: 700,
                letterSpacing: ".14em",
                textTransform: "uppercase"
              }}
            >
              <span>Capas</span>
              <span
                style={{
                  display: "flex",
                  transform: layersCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                  transition: "transform .15s ease"
                }}
              >
                <ChevronRight size={13} strokeWidth={2.4} aria-hidden="true" />
              </span>
            </button>

            {!layersCollapsed && (
            <>
            <h4>{V.ordenes} a mostrar</h4>
            <label className="lay">
              <input
                type="checkbox"
                checked={st.est[2]}
                          disabled={avail.tipos[2] === 0}
                onChange={(e) => {
                  const est = [...st.est];
                  est[2] = e.target.checked;
                  handleFilterChange("est", est);
                }}
              />
              <span className="sw" style={{ background: P.st[2] }}></span>
              Perdidas
            </label>
            <label className="lay">
              <input
                type="checkbox"
                checked={st.est[0]}
                          disabled={avail.tipos[0] === 0}
                onChange={(e) => {
                  const est = [...st.est];
                  est[0] = e.target.checked;
                  handleFilterChange("est", est);
                }}
              />
              <span className="sw" style={{ background: P.st[0] }}></span>
              Efectivas
            </label>
{data.dim.resultados && (
  <div className="lay-sub">
    {data.dim.resultados.map((nombre, id) =>
      nombre === "No efectiva" || !(avail.efRec.get(id) > 0) ? null : (
        <label key={id} className="lay">
          <input
            type="checkbox"
            checked={!st.efOcultas.includes(id)}
            disabled={!st.est[0]}
            onChange={(e) => {
              const resto = st.efOcultas.filter((x) => x !== id);
              handleFilterChange("efOcultas", e.target.checked ? resto : [...resto, id]);
            }}
          />
          {nombre}
        </label>
      )
    )}
  </div>
)}

            {ordenes && (
  <CapasCargue
    layers={st.layers}
    onLayers={(layers) => handleFilterChange("layers", layers)}
    V={V}
  />
)}

            <div className="lgrp">
              <h4>Cómo dibujarlas</h4>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.markers}
                  onChange={(e) => {
                    const layers = { ...st.layers, markers: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Marcadores por barrio
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.heat}
                  onChange={(e) => {
                    const layers = { ...st.layers, heat: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Mapa de calor
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.gps}
                  onChange={(e) => {
                    const layers = { ...st.layers, gps: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                GPS reales
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.approx}
                  onChange={(e) => {
                    const layers = { ...st.layers, approx: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Ubicaciones aproximadas
              </label>
              <p className="lay-nota">
                Los <b>marcadores</b> resumen cada barrio (clic → análisis). Los{" "}
                <b>puntos GPS</b> son {V.ordenesMin} sueltas (clic → detalle).
              </p>
            </div>

            <div className="lgrp">
              <h4>Límites oficiales</h4>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.zpoly}
                  onChange={(e) => {
                    const layers = { ...st.layers, zpoly: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Zonas
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.bpoly}
                  onChange={(e) => {
                    const layers = { ...st.layers, bpoly: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Barrios
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.mpoly}
                  onChange={(e) => {
                    const layers = { ...st.layers, mpoly: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Municipios
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.cpoly}
                  onChange={(e) => {
                    const layers = { ...st.layers, cpoly: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Corregimientos
              </label>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.vpoly}
                  onChange={(e) => {
                    const layers = { ...st.layers, vpoly: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                Veredas
              </label>
            </div>

            <div className="lgrp">
              <h4>Cobertura</h4>
              <label className="lay">
                <input
                  type="checkbox"
                  checked={st.layers.sinNic}
                  onChange={(e) => {
                    const layers = { ...st.layers, sinNic: e.target.checked };
                    handleFilterChange("layers", layers);
                  }}
                />
                <span className="sw" style={{ background: P.sinNic }}></span>
                Barrios sin visitar
              </label>
              <p className="lay-nota">
                Barrios (polígonos) sin ninguna {V.ordenMin || "orden"} registrada. Se resaltan en amarillo fuerte.
              </p>
            </div>


            <div className="lgrp" id="legend">
              <h4>Índice de riesgo</h4>
              {(V.riesgoPorPromedio ? NIVELES_COBROS : NIVELES_SCR).map(([r, t]) => (
  <div key={t}>
    <i style={{ background: riskColor(P, r) }}></i> {t}
  </div>
))}
            </div>
            </>
            )}
          </div>

          <Dock
            A={A}
            st={computedSt}
            dim={data.dim}
            dayLabel={dayLabel}
            onFilterChange={handleFilterChange}
            onSelectBarrio={handleSelectBarrio}
            onSelectNic={handleSelectNic}
            V={V}
          />
        </section>

        <DetailsPanel
          st={computedSt}
          A={A}
          Asel={Asel}
          AselTec={AselTec}
          ELIG={ELIG}
          dim={data.dim}
          geo={data.geo}
          dayLabel={dayLabel}
          recommend={recommend}
          zoneAvg={zoneAvg}
          actionsFor={actionsFor}
          onFilterChange={handleFilterChange}
          onSelectBarrio={handleSelectBarrio}
          onSelectNic={handleSelectNic}
          V={V}
        />
      </main>
    </div>
  );
}