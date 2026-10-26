"use client";

/**
 * Tema del visor: la paleta y el estilo del basemap.
 *
 * La paleta vive dos veces, a propósito:
 *  - en CSS (`globals.css`) para todo lo que se pinta con hojas de estilo;
 *  - aquí, en JS, para lo que se pinta en canvas / Leaflet, donde `var(--x)`
 *    no se resuelve (mapa de calor, puntos GPS, polígonos, tooltips inyectados).
 * Los valores deben mantenerse sincronizados con `globals.css`.
 */

import { useCallback, useSyncExternalStore } from "react";

export const STORAGE_KEY = "eh-mapa-theme";
export const THEME_EVENT = "eh-mapa-theme-change";

/* Colores de marca — únicos permitidos para rellenos en el tema claro */
export const BRAND = {
  verde: "#78BE20",
  lima: "#B5BD00",
  verdeMedio: "#509E2F",
  verdeOscuro: "#38764C",
  grisMedio: "#97999B",
  grisClaro: "#E0E0E0"
};

/* Tokens del modo oscuro — superficies azul medianoche, marca en azul cielo.
   El verde queda reservado para «suspensión efectiva». */
export const DARK = {
  base: "#0A1A2F",
  surface: "#102A4A",
  card: "#0F2744",
  elev: "#16355C",
  line: "#1E3A5F",
  borderStrong: "#2C5482",
  text1: "#F2F7FF",
  text2: "#C9DAEE",
  text3: "#85A3C4",
  acento: "#4A9EE8",
  activo: "#3B8AD9",
  acentoFondo: "#143A63",
  ok: "#2BD98C",
  alerta: "#F0C040",
  critico: "#FF5A5F",
  perdida: "#FF7A7E"
};

// Basemap — OpenFreeMap: teselas vectoriales de OpenStreetMap, sin API key ni
// marca de agua. Positron es el mismo estilo que usaba CARTO antes de cobrarlo,
// y de ahí salen los nombres de calle y de barrio.
export const BASEMAP = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
  // Positron viene tan desaturado que en el visor se leía apagado. Se aclaran
  // fondo y manzanas, y se le devuelve color al agua y al verde. Las vías
  // quedan neutras a propósito: ahí van los marcadores y el mapa de calor.
  // Solo aplica al tema claro; el estilo oscuro trae su propia paleta.
  coloresClaro: {
    background: "#FBFBF9",
    landuse_residential: "#F4F4F0",
    building: "#EFEFE9",
    water: "#C6DEEC",
    waterway: "#AECFE2",
    park: "#DCEBD1",
    landcover_wood: "#D2E5C5"
  }
};

export const PALETTES = {
  light: {
    name: "light",
    none: BRAND.grisMedio,

    /* Un color por GRUPO operativo, en el orden de `dim.grupos`:
       ejecutada · no fue posible · no procedía · sin información.
       `st` es el relleno y `stText` la variante con contraste AA para texto. */
    st: [BRAND.verdeMedio, "#C0392B", BRAND.lima, BRAND.grisMedio],
    stText: ["#3E7B24", "#A5301F", "#6E7300", "#5F6663"],
    stInk: ["#14201A", "#FFFFFF", "#14201A", "#FFFFFF"],

    /* Semáforo del índice de riesgo: bajo · medio · alto */
    riesgo: [BRAND.verdeMedio, BRAND.lima, "#C0392B"],
    riesgoText: ["#3E7B24", "#6E7300", "#A5301F"],
    riesgoInk: ["#14201A", "#14201A", "#FFFFFF"],

    ink: "#FFFFFF",
    mapBg: "#EDF0E8",
    overlay: "rgba(255,255,255,.95)",
    pointStroke: "rgba(255,255,255,.85)",
    markerSel: BRAND.verdeOscuro,
    limitStroke: BRAND.verdeOscuro,
    perimetroStroke: "#5F6663",

    /* Una rampa por grupo: el mapa de calor superpone una capa por cada grupo
       que tenga registros marcados en el panel. */
    heat: [
      { 0.35: "#CFE3B4", 0.65: BRAND.verde, 1.0: BRAND.verdeOscuro },
      { 0.35: "#F0BDB5", 0.65: "#D9584A", 1.0: "#8E2418" },
      { 0.35: "#E8EAA8", 0.65: BRAND.lima, 1.0: "#7E8400" },
      { 0.35: "#DCDCDC", 0.65: "#A7ACA8", 1.0: "#6F7275" }
    ]
  },

  dark: {
    name: "dark",
    none: DARK.text3,

    st: [DARK.ok, DARK.critico, DARK.alerta, DARK.text3],
    stText: [DARK.ok, DARK.perdida, DARK.alerta, DARK.text2],
    stInk: [DARK.base, DARK.base, DARK.base, DARK.base],

    riesgo: [DARK.ok, DARK.alerta, DARK.critico],
    riesgoText: [DARK.ok, DARK.alerta, DARK.perdida],
    riesgoInk: [DARK.base, DARK.base, DARK.base],

    ink: "#FFFFFF",
    mapBg: DARK.base,
    overlay: "rgba(10,26,47,.94)",
    pointStroke: "rgba(10,26,47,.75)",
    markerSel: DARK.text1,
    markerHalo: DARK.acento,
    limitStroke: DARK.acento,
    perimetroStroke: DARK.text3,

    heat: [
      { 0.35: "#0E3A2C", 0.65: "#1E8A64", 1.0: "#2BD98C" },
      { 0.35: "#7A1A1E", 0.65: "#C93B41", 1.0: "#FF5A5F" },
      { 0.35: "#5C4712", 0.65: "#C09526", 1.0: "#F0C040" },
      { 0.35: "#243B55", 0.65: "#55708F", 1.0: "#85A3C4" }
    ]
  }
};

export const DEFAULT_THEME = "dark";

/* ---------- store mínimo, sincronizado con <html data-theme> ---------- */

function readDom() {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function getSnapshot() {
  return readDom();
}

function getServerSnapshot() {
  return DEFAULT_THEME;
}

function subscribe(cb) {
  window.addEventListener(THEME_EVENT, cb);
  return () => window.removeEventListener(THEME_EVENT, cb);
}

export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* almacenamiento no disponible: el tema simplemente no persiste */
  }
  window.dispatchEvent(new Event(THEME_EVENT));
  return next;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((t) => applyTheme(t), []);
  const toggle = useCallback(() => applyTheme(readDom() === "light" ? "dark" : "light"), []);
  return { theme, palette: PALETTES[theme] || PALETTES[DEFAULT_THEME], setTheme, toggle };
}

/* ---------- helpers de color de datos ---------- */

/** Color del índice de riesgo (0–100). `text: true` da la variante con contraste AA.
 *
 * Tiene su propia escala y no reutiliza `st`: ahí los colores identifican
 * grupos operativos, y aquí representan un semáforo de bajo a alto. */
export function riskColor(p, r, text = false) {
  if (r == null) return p.none;
  const band = r >= 61 ? 2 : r >= 31 ? 1 : 0;
  return (text ? p.riesgoText : p.riesgo)[band];
}

/** Color de tinta legible sobre un relleno de riesgo. */
export function riskInk(p, r) {
  if (r == null) return p.ink;
  return p.riesgoInk[r >= 61 ? 2 : r >= 31 ? 1 : 0];
}
