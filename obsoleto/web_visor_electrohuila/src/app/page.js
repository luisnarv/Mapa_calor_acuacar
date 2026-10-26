"use client";

/**
 * Visor del mapa de calor de Acuacar.
 *
 * Esta página carga el payload que produce el ETL y se encarga de tres motores,
 * los mismos del visor que sirvió de referencia:
 *
 *  1. **Filtrado** (`IDX`): los registros viven en TypedArrays y el filtro
 *     produce un `Int32Array` de índices. Con 400.000 registros en memoria, un
 *     `Array.filter` sobre objetos no da.
 *  2. **Agregación** (`A`): un solo recorrido del filtro arma los totales por
 *     municipio, funcionario y causal. Todo lo que el mapa muestra sale de ahí.
 *  3. **Índice de riesgo** (`ELIG`): 0–100 por municipio, combinando registros
 *     perdidos, fallidos, volumen, tendencia e historial del funcionario. Es lo
 *     que colorea marcadores y polígonos.
 *
 * Los meses se descargan perezosamente: al abrir solo llega el mes en curso
 * (`data.json`); el resto son archivos aparte que se piden al seleccionarlos.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";

import BarraFiltros from "@/components/BarraFiltros";
import PanelCapas from "@/components/PanelCapas";
import { cacheClear, cacheGet, cachePut } from "@/lib/cacheMeses";

// Leaflet toca `window` al importarse, así que el mapa entra sin SSR.
const MapaCalor = dynamic(() => import("@/components/MapaCalor"), {
  ssr: false,
  loading: () => (
    <div style={{
      background: "var(--map-bg)", height: "100%", display: "flex",
      alignItems: "center", justifyContent: "center", color: "var(--dim)"
    }}>
      Cargando visor cartográfico…
    </div>
  )
});

export default function Home() {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [capasColapsadas, setCapasColapsadas] = useState(false);

  // Carga perezosa por mes.
  const mesesCargados = useRef(new Set());
  const mesesEnVuelo = useRef(new Set());
  const [mesesBajando, setMesesBajando] = useState([]);
  const [refrescando, setRefrescando] = useState(false);
  const [resultadoRefresco, setResultadoRefresco] = useState(null);

  const [st, setSt] = useState({
    zona: "",
    muni: "",
    brig: "",
    tipo: "",
    oper: "",
    activ: "",
    // Por qué se agrupa el mapa: barrios/municipios oficiales.
    agrupar: "municipio",
    minOrders: 200,
    hotspot: 60,
    selUnidad: null,
    // Un booleano por resultado del diccionario. Se dimensiona al cargar el
    // payload, porque cuántos resultados hay lo decide el diccionario.
    est: [],
    months: [],
    layers: {
      // El proyecto es el mapa de calor: arranca encendido.
      heat: true,
      markers: true,
      puntos: false,
      // Solo el GPS real entra por defecto. Las ubicaciones aproximadas son el
      // centroide del municipio: útiles para contar, engañosas para un calor
      // que se lee como densidad en el terreno.
      gps: true,
      approx: true,
      zpoly: false,
      bpoly: true,
      mpoly: false
    }
  });

  /* ------------------------------------------------------------------ */
  /* Carga inicial                                                       */
  /* ------------------------------------------------------------------ */
  const aplicarEntrada = useCallback((res) => {
    setData(res);
    const manifiesto = res.meta?.months || [];
    const reciente = manifiesto.find((m) => m.recent);
    mesesCargados.current = new Set(reciente ? [reciente.key] : []);
    mesesEnVuelo.current = new Set();
    setSt((prev) => ({
      ...prev,
      selUnidad: null,
      est: (res.dim?.estados || []).map(() => true),
      months: reciente ? [reciente.label] : []
    }));
  }, []);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      await cacheClear(); // FORCED CACHE CLEAR to fix broken data
      let res = await cacheGet("data.json");
      if (!res) {
        const r = await fetch("/data.json");
        if (!r.ok) throw new Error(`data.json respondió ${r.status}`);
        res = await r.json();
        cachePut("data.json", res);
      }
      if (cancelado) return;
      aplicarEntrada(res);
      setCargando(false);
    })().catch((err) => {
      console.error("No se pudo cargar data.json", err);
      if (!cancelado) {
        setError(
          "No se pudo cargar data.json. Genera el payload con " +
          "`python etl/run_etl.py` antes de abrir el visor."
        );
        setCargando(false);
      }
    });
    return () => { cancelado = true; };
  }, [aplicarEntrada]);

  // Cuando la selección incluye un mes que no está en memoria, se descarga y se
  // fusiona con lo que ya hay.
  useEffect(() => {
    if (!data) return;
    const manifiesto = data.meta?.months || [];
    const porEtiqueta = new Map(manifiesto.map((m) => [m.label, m]));
    const faltan = (st.months || [])
      .map((l) => porEtiqueta.get(l))
      .filter((m) => m && m.file && !m.recent &&
        !mesesCargados.current.has(m.key) && !mesesEnVuelo.current.has(m.key));
    if (!faltan.length) return;

    faltan.forEach((m) => mesesEnVuelo.current.add(m.key));
    setMesesBajando((prev) => [...new Set([...prev, ...faltan.map((m) => m.label)])]);

    Promise.all(faltan.map(async (m) => {
      let pts = await cacheGet(m.file);
      if (!pts) {
        const j = await fetch("/" + m.file).then((r) => r.json());
        pts = j.pts;
        cachePut(m.file, pts);
      }
      return { m, pts };
    }))
      .then((resultados) => {
        setData((prev) => {
          if (!prev) return prev;
          // Un solo `concat` por columna con todos los meses a la vez: en
          // cadena creaba un array intermedio por mes, y con 21 meses eso son
          // 300 copias de arrays de cientos de miles de elementos.
          const fusion = {};
          for (const clave of Object.keys(prev.pts)) {
            fusion[clave] = prev.pts[clave].concat(
              ...resultados.map(({ pts }) => pts[clave])
            );
          }
          return { ...prev, pts: fusion };
        });
        resultados.forEach(({ m }) => {
          mesesCargados.current.add(m.key);
          mesesEnVuelo.current.delete(m.key);
        });
        setMesesBajando((prev) => prev.filter((l) => !faltan.some((m) => m.label === l)));
      })
      .catch((err) => {
        console.error("No se pudo cargar un mes", err);
        faltan.forEach((m) => mesesEnVuelo.current.delete(m.key));
        setMesesBajando((prev) => prev.filter((l) => !faltan.some((m) => m.label === l)));
      });
  }, [st.months, data]);

  /* ------------------------------------------------------------------ */
  /* Arrays crudos                                                       */
  /* ------------------------------------------------------------------ */
  const raw = useMemo(() => {
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
      M: Int32Array.from(P.m),
      CI: Int16Array.from(P.ci || new Array(P.e.length).fill(0)),
      OP: Uint8Array.from(P.op || new Array(P.e.length).fill(0)),
      AC: Uint8Array.from(P.ac || new Array(P.e.length).fill(0)),
      DR: Int16Array.from(P.dr || new Array(P.e.length).fill(-1)),
      BR: Uint8Array.from(P.br || new Array(P.e.length).fill(0)),
      AP: Uint8Array.from(P.ap || new Array(P.e.length).fill(0)),
      // Trazabilidad: grupo operativo, estado crudo, regla y motivo de ubicación.
      GR: Uint8Array.from(P.gr || new Array(P.e.length).fill(0)),
      X: Uint8Array.from(P.x || new Array(P.e.length).fill(0)),
      RG: Uint8Array.from(P.rg || new Array(P.e.length).fill(0)),
      MO: Uint8Array.from(P.mo || new Array(P.e.length).fill(0)),
      ORD: P.n,
      NIC: P.nic,
      LA: Int32Array.from(P.la),
      LO: Int32Array.from(P.lo),
      DAY: (() => {
        const n = P.e.length;
        const a = new Int16Array(n);
        for (let i = 0; i < n; i++) a[i] = Math.floor(P.m[i] / 1440);
        return a;
      })()
    };
  }, [data]);

  // El mes de cada registro como entero, calculado UNA vez por dataset.
  //
  // El truco está en resolver el mes POR DÍA y no por registro: son ~630 días
  // de histórico contra 420.000 registros, así que se crean 630 `Date` en vez
  // de 420.000. Con el histórico completo cargado, la diferencia es de varios
  // segundos de bloqueo cada vez que cambia la selección de meses.
  const mapaMeses = useMemo(() => {
    if (!data || !raw) return { idx: null, claveAIdx: new Map() };
    const DAY = raw.DAY;
    const n = DAY.length;
    let maxDia = 0;
    for (let i = 0; i < n; i++) if (DAY[i] > maxDia) maxDia = DAY[i];

    const claveAIdx = new Map();
    const porDia = new Int16Array(maxDia + 1);
    const D0 = new Date(data.meta.fecha_min + "T00:00:00");
    for (let d = 0; d <= maxDia; d++) {
      const x = new Date(D0.getTime() + d * 86400000);
      const k = x.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
      const cap = k.charAt(0).toUpperCase() + k.slice(1);
      let mi = claveAIdx.get(cap);
      if (mi === undefined) {
        mi = claveAIdx.size;
        claveAIdx.set(cap, mi);
      }
      porDia[d] = mi;
    }

    const idx = new Int16Array(n);
    for (let i = 0; i < n; i++) idx[i] = porDia[DAY[i]];
    return { idx, claveAIdx };
  }, [data, raw]);

  const availableMonths = useMemo(() => {
    if (!data?.meta?.months) return [];
    return data.meta.months.map((m) => ({
      key: m.label, ym: m.key, n: m.n, recent: !!m.recent
    }));
  }, [data]);

  const lat = useCallback(
    (i) => (raw && data ? raw.LA[i] / 1e5 + data.meta.lat0 : 0), [raw, data]);
  const lon = useCallback(
    (i) => (raw && data ? raw.LO[i] / 1e5 + data.meta.lon0 : 0), [raw, data]);

  /* ------------------------------------------------------------------ */
  /* 1. Filtrado                                                         */
  /* ------------------------------------------------------------------ */
  const IDX = useMemo(() => {
    if (!data || !raw) return new Int32Array(0);
    const { DAY, B, G, O, OP, AC } = raw;
    const n = DAY.length;
    const zi = st.zona === "" ? -1 : +st.zona;
    const mi = st.muni === "" ? -1 : +st.muni;
    const gi = st.brig === "" ? -1 : +st.brig;
    const oi = st.tipo === "" ? -1 : +st.tipo;
    const pi = st.oper === "" ? -1 : +st.oper;
    const ai = st.activ === "" ? -1 : +st.activ;
    const mesesActivos = st.months?.length
      ? new Set(st.months.map((k) => mapaMeses.claveAIdx.get(k)).filter((v) => v !== undefined))
      : null;

    const out = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (mesesActivos && !mesesActivos.has(mapaMeses.idx[i])) continue;
      const b = B[i];
      if (zi >= 0 && data.dim.b_zona[b] !== zi) continue;
      if (mi >= 0 && data.dim.b_muni[b] !== mi) continue;
      if (gi >= 0 && G[i] !== gi) continue;
      if (oi >= 0 && O[i] !== oi) continue;
      if (pi >= 0 && OP[i] !== pi) continue;
      if (ai >= 0 && AC[i] !== ai) continue;
      out[k++] = i;
    }
    return out.subarray(0, k);
  }, [data, raw, mapaMeses, st.zona, st.muni, st.brig, st.tipo,
      st.oper, st.activ, st.months]);

  // Opciones disponibles en cascada: cada filtro se evalúa SIN sí mismo, para
  // que elegir un valor no borre los demás de su propia lista.
  const avail = useMemo(() => {
    const res = {
      zona: new Set(), muni: new Set(), brig: new Set(),
      tipo: new Set(), oper: new Set(), activ: new Set()
    };
    if (!data || !raw) return res;
    const { B, G, O, OP, AC, DAY } = raw;
    const n = DAY.length;
    const zi = st.zona === "" ? -1 : +st.zona;
    const mi = st.muni === "" ? -1 : +st.muni;
    const gi = st.brig === "" ? -1 : +st.brig;
    const oi = st.tipo === "" ? -1 : +st.tipo;
    const pi = st.oper === "" ? -1 : +st.oper;
    const ai = st.activ === "" ? -1 : +st.activ;
    const mesesActivos = st.months?.length
      ? new Set(st.months.map((k) => mapaMeses.claveAIdx.get(k)).filter((v) => v !== undefined))
      : null;

    for (let i = 0; i < n; i++) {
      if (mesesActivos && !mesesActivos.has(mapaMeses.idx[i])) continue;
      const b = B[i];
      const z = data.dim.b_zona[b];
      const m = data.dim.b_muni[b];
      const g = G[i];
      const o = O[i];
      const pp = OP[i];
      const aa = AC[i];
      // Cada filtro se evalúa sin sí mismo, para que elegir un valor no borre
      // los demás de su propia lista.
      const zOk = zi < 0 || z === zi, mOk = mi < 0 || m === mi;
      const gOk = gi < 0 || g === gi, oOk = oi < 0 || o === oi;
      const pOk = pi < 0 || pp === pi;
      const aOk = ai < 0 || aa === ai;
      if (mOk && gOk && oOk && pOk && aOk) res.zona.add(z);
      if (zOk && gOk && oOk && pOk && aOk) res.muni.add(m);
      if (zOk && mOk && oOk && pOk && aOk) res.brig.add(g);
      if (zOk && mOk && gOk && pOk && aOk) res.tipo.add(o);
      if (zOk && mOk && gOk && oOk && aOk) res.oper.add(pp);
      if (zOk && mOk && gOk && oOk && pOk) res.activ.add(aa);
    }
    return res;
  }, [data, raw, mapaMeses, st.zona, st.muni, st.brig, st.tipo,
      st.oper, st.activ, st.months]);

  /* ------------------------------------------------------------------ */
  /* 2. Agregación                                                       */
  /* ------------------------------------------------------------------ */
  const A = useMemo(() => {
    const vacio = {
      tot: 0, ef: 0, fa: 0, pe: 0, den: 0,
      efPct: 0, efAdj: 0, pePct: 0, faPct: 0,
      barrio: new Map(), tec: new Map(), IDX: new Int32Array(0)
    };
    if (!data || !raw || !IDX.length) return vacio;

    const { GR, B, T, M, DAY } = raw;
    const U = B;
    // Qué grupos cuentan como ejecutado y cuáles entran al denominador de la
    // efectividad lo decide el ETL (ver eh_etl/homologacion.py); aquí solo se
    // aplica, para que el mapa y el ETL no puedan discrepar.
    const NUM = data.dim.grupoNumerador || [];
    const DEN = data.dim.grupoDenominador || [];

    // `ef` = ejecutadas · `fa` = no fue posible · `pe` = fuera del alcance
    // (no procedía o sin información). `den` = ef + fa.
    const agg = {
      tot: IDX.length, ef: 0, fa: 0, pe: 0,
      barrio: new Map(), tec: new Map()
    };

    const nuevo = () => ({
      tot: 0, ef: 0, fa: 0, pe: 0,
      tec: new Map(), day: new Map(), last: -1
    });
    const bump = (mapa, k) => {
      let o = mapa.get(k);
      if (!o) { o = nuevo(); mapa.set(k, o); }
      return o;
    };
    const cnt = (mapa, k) => mapa.set(k, (mapa.get(k) || 0) + 1);

    for (let j = 0; j < IDX.length; j++) {
      const i = IDX[j];
      const g = GR[i];
      const b = U[i];
      const t = T[i];
      const d = DAY[i];

      const esEf = NUM[g] === 1;
      const enDen = DEN[g] === 1;

      if (esEf) agg.ef++; else if (enDen) agg.fa++; else agg.pe++;

      for (const [mapa, clave] of [[agg.barrio, b], [agg.tec, t]]) {
        const o = bump(mapa, clave);
        o.tot++;
        if (esEf) o.ef++; else if (enDen) o.fa++; else o.pe++;
        let od = o.day.get(d);
        if (!od) { od = [0, 0, 0]; o.day.set(d, od); }
        od[esEf ? 0 : enDen ? 1 : 2]++;
        if (M[i] > o.last) o.last = M[i];
      }
      cnt(agg.barrio.get(b).tec, t);
    }

    const pct = (x, y) => (y ? (x / y) * 100 : 0);
    for (const mapa of [agg.barrio, agg.tec]) {
      for (const o of mapa.values()) {
        o.den = o.ef + o.fa;
        // La efectividad se mide solo contra las órdenes que había que
        // ejecutar: las de «no procedía» y «sin información» quedan fuera.
        o.efPct = pct(o.ef, o.den);
        o.efAdj = o.efPct;
        o.faPct = pct(o.fa, o.den);
        o.pePct = pct(o.pe, o.tot);
      }
    }
    agg.den = agg.ef + agg.fa;
    agg.efPct = pct(agg.ef, agg.den);
    agg.efAdj = agg.efPct;
    agg.faPct = pct(agg.fa, agg.den);
    agg.pePct = pct(agg.pe, agg.tot);

    // --- Índice de riesgo (0–100) por municipio ----------------------
    // Va dentro de esta misma memo, y no en una aparte, porque escribe en
    // los objetos que acaba de construir: calcularlo fuera obligaría a
    // mutar un valor que ya salió de un hook.
    calcularRiesgo(agg, st.minOrders);

    agg.IDX = IDX;
    return agg;
  }, [IDX, raw, data, st.minOrders, st.agrupar]);


  /* ------------------------------------------------------------------ */
  /* Handlers                                                            */
  /* ------------------------------------------------------------------ */
  const dayLabel = useCallback((d) => {
    const base = new Date((data ? data.meta.fecha_min : "2025-01-01") + "T00:00:00");
    const x = new Date(base.getTime() + d * 86400000);
    return x.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
  }, [data]);

  const onFilterChange = useCallback((clave, valor) => {
    setSt((prev) => {
      const next = { ...prev, [clave]: valor };
      // Cascada: cambiar zona invalida el barrio elegido dentro de ella.
      if (clave === "zona") { next.muni = ""; next.selUnidad = null; }
      if (clave === "agrupar") { next.selUnidad = null; }
      if (clave === "muni") { next.selUnidad = null; }
      if (clave === "brig" || clave === "months") { next.selUnidad = null; }
      return next;
    });
  }, []);

  // Limpieza automática si el barrio seleccionado queda huérfano con los demás filtros
  useEffect(() => {
    if (st.muni !== "" && avail.muni.size > 0 && !avail.muni.has(+st.muni)) {
      setSt((prev) => ({ ...prev, muni: "" }));
    }
  }, [avail, st.muni]);

  const onSelectUnidad = useCallback((b) => {
    // Segundo clic sobre el mismo barrio → quitar la selección.
    setSt((prev) => ({ ...prev, selUnidad: prev.selUnidad === b ? null : b }));
  }, []);

  const onReset = useCallback(() => {
    setSt((prev) => ({
      ...prev,
      zona: "", muni: "", brig: "", tipo: "", oper: "", activ: "",
      agrupar: "municipio", minOrders: 200, hotspot: 60, selUnidad: null,
      months: (() => {
        const reciente = availableMonths.find((m) => m.recent);
        return reciente ? [reciente.key] : availableMonths.map((m) => m.key);
      })()
    }));
  }, [availableMonths]);

  // Borra la caché local, suelta de memoria todo menos el mes en curso y vuelve
  // a pedirlo fresco (con cache-buster para saltarse también la caché HTTP).
  const onRefresh = useCallback(async () => {
    if (refrescando) return;
    setRefrescando(true);
    setResultadoRefresco(null);
    try {
      await cacheClear();
      const res = await fetch(`/data.json?t=${Date.now()}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
      cachePut("data.json", res);
      aplicarEntrada(res);
      setResultadoRefresco("ok");
    } catch (err) {
      console.error("No se pudo actualizar", err);
      setResultadoRefresco("error");
    } finally {
      setRefrescando(false);
    }
  }, [refrescando, aplicarEntrada]);

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  if (error) {
    return (
      <div className="loader-screen">
        <div className="loader-title">NO HAY DATOS QUE MOSTRAR</div>
        <p style={{ color: "var(--mut)", maxWidth: 520, textAlign: "center" }}>{error}</p>
      </div>
    );
  }

  if (cargando || !data || !raw) {
    return (
      <div className="loader-screen">
        <div className="loader-badge">
          <span className="loader-ring-bg" aria-hidden="true" />
          <span className="loader-ring" aria-hidden="true" />
          <img src="/ises-symbol.png" alt="Logo" className="loader-logo" />
        </div>
        <div className="loader-title">CARGANDO MAPA DE CALOR</div>
        <div className="loader-bar" role="progressbar" aria-label="Cargando información">
          <span className="loader-bar-fill" />
        </div>
      </div>
    );
  }

  // Lo que el mapa necesita del estado, más los arrays crudos que consulta para
  // dibujar y para armar las fichas.
  const stCompleto = {
    ...st,
    totalLoaded: raw.E.length,
    fechaMin: data.meta.fecha_min,
    fechaMax: data.meta.fecha_max,
    generated: data.meta.generated,
    lat,
    lon,
    B_raw: raw.B, E_raw: raw.E, T_raw: raw.T, G_raw: raw.G, O_raw: raw.O,
    C_raw: raw.C, S_raw: raw.S, U_raw: raw.U, F_raw: raw.F, M_raw: raw.M,
    DAY_raw: raw.DAY, AP_raw: raw.AP, ORD_raw: raw.ORD, NIC_raw: raw.NIC,
    CI_raw: raw.CI, OP_raw: raw.OP, BR_raw: raw.BR, AC_raw: raw.AC, DR_raw: raw.DR,
    // El array que define la unidad de agregación activa.
    U_unidad: raw.B,
    GR_raw: raw.GR, X_raw: raw.X, RG_raw: raw.RG, MO_raw: raw.MO
  };

  return (
    <div id="app">
      <BarraFiltros
        st={stCompleto}
        dim={data.dim}
        avail={avail}
        onFilterChange={onFilterChange}
        onReset={onReset}
        availableMonths={availableMonths}
        loadingMonths={mesesBajando}
        onRefresh={onRefresh}
        refreshing={refrescando}
        refreshResult={resultadoRefresco}
      />

      <main id="main">
        <section id="center">
          <MapaCalor
            A={A}
            st={stCompleto}
            dim={data.dim}
            geo={data.geo}
            onSelectUnidad={onSelectUnidad}
            dayLabel={dayLabel}
          />

          {st.selUnidad != null && (
            <button
              type="button"
              className="btn-quitar-sel"
              onClick={() => onFilterChange("selUnidad", null)}
              title="Mostrar todos los barrios"
            >
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
              Ver todos los barrios
            </button>
          )}

          <PanelCapas
            st={st}
            dim={data.dim}
            onFilterChange={onFilterChange}
            colapsado={capasColapsadas}
            onColapsar={() => setCapasColapsadas((v) => !v)}
            cobertura={data.meta.ubicacion}
          />
        </section>
      </main>
    </div>
  );
}

/**
 * Índice de riesgo 0–100 por municipio, sobre el resultado de la agregación.
 *
 * Cuatro componentes con peso fijo —la proporción de órdenes que no se pudo
 * ejecutar (65 %), el volumen (15 %), la tendencia (10 %) y el historial de los
 * funcionarios que atienden el municipio (10 %)— cada uno normalizado contra el
 * percentil 90 del propio período. Referencias relativas y no umbrales fijos:
 * un umbral fijo envejece con los datos.
 *
 * La proporción se mide sobre las órdenes que había que ejecutar, no sobre el
 * total: un municipio donde la mitad de las órdenes se cerraron porque el
 * usuario pagó no es un municipio con problemas operativos.
 *
 * Solo entran los municipios con al menos `minimo` registros en el filtro
 * actual; al resto se le deja `risk = null` y el mapa los pinta en gris.
 */
function calcularRiesgo(A, minimo) {
  const elegibles = [];
  for (const [b, o] of A.barrio) {
    if (o.tot >= minimo) elegibles.push([b, o]);
  }

  const dias = [...A.barrio.values()].flatMap((o) => [...o.day.keys()]);
  const mitad = dias.length
    ? Math.floor((Math.min(...dias) + Math.max(...dias)) / 2)
    : 0;
  const pct = (a, b) => (b ? (a / b) * 100 : 0);

  // Tendencia: cuánto subió el porcentaje de no efectivas en la segunda mitad
  // del período. Con menos de 3 registros por mitad no se afirma nada.
  for (const [, o] of elegibles) {
    let m1 = 0, n1 = 0, m2 = 0, n2 = 0;
    for (const [d, v] of o.day) {
      const malas = v[1] + v[2];
      const total = v[0] + v[1] + v[2];
      if (d <= mitad) { m1 += malas; n1 += total; } else { m2 += malas; n2 += total; }
    }
    o.trend = n2 >= 3 && n1 >= 3 ? pct(m2, n2) - pct(m1, n1) : 0;

    // Historial de los funcionarios que atienden el municipio, ponderado por
    // cuántos registros aporta cada uno.
    let num = 0, den = 0;
    for (const [t, c] of o.tec) {
      const to = A.tec.get(t);
      if (to && to.den > 0) { num += to.efAdj * c; den += c; }
    }
    o.histTec = den ? num / den : 0;
  }

  const cuantil = (ordenado, q) => {
    if (!ordenado.length) return 0;
    const p = (ordenado.length - 1) * q;
    const lo = Math.floor(p), hi = Math.ceil(p);
    return ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (p - lo);
  };
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const serie = (f) => elegibles.map(([, o]) => f(o)).sort((a, b) => a - b);

  // Referencias relativas al propio período: el percentil 90 de cada
  // componente. Un umbral fijo envejecería con los datos.
  // Antes había dos términos —perdidas y fallidas— que con la clasificación del
  // diccionario miden lo mismo: la proporción que no se pudo ejecutar. Se
  // fusionan en uno con el peso de los dos (65 %).
  const refNoEjec = Math.max(cuantil(serie((o) => o.faPct), 0.9), 2);
  const refVo = Math.max(cuantil(serie((o) => o.tot), 0.9), 1);
  const refTr = Math.max(
    cuantil(serie((o) => o.trend).filter((v) => v > 0), 0.9) || 10, 5);
  const hist = serie((o) => o.histTec);
  const hBueno = cuantil(hist, 0.9);
  const hMalo = cuantil(hist, 0.1);

  for (const [, o] of A.barrio) { o.risk = null; o.prio = null; }
  for (const [, o] of elegibles) {
    const rNoEjec = clamp01(o.faPct / refNoEjec);
    const rVo = clamp01(o.tot / refVo);
    const rTr = clamp01(o.trend / refTr);
    const rHi = hBueno > hMalo ? 1 - clamp01((o.histTec - hMalo) / (hBueno - hMalo)) : 0;
    o.risk = Math.round(
      100 * (0.65 * rNoEjec + 0.15 * rVo + 0.1 * rTr + 0.1 * rHi));
    o.prio = o.risk >= 61 ? "Alta" : o.risk >= 31 ? "Media" : "Baja";
  }
}
