// El ETL le pega la zona al nombre del barrio («VILLA ESTRELLA (C11)») porque cada orden toma
// la zona de su GPS: un mismo barrio que cruza varias zonas queda como varias entradas de
// `dim.barrios`. Para quien mira el tablero es UN barrio, así que aquí se unen por nombre
// (mismo municipio, mismo nombre sin los paréntesis finales: zona o comuna).
//
// No se toca la lógica de los datos: `pts.b` sigue apuntando a la entrada original, y la zona de
// cada orden sigue saliendo de ella (`b0` en rawArrays). Solo se agrega un índice «canónico» por
// grupo para contar, listar, seleccionar y rankear el barrio completo.

const PARENTESIS_FINALES = /(?:\s*\([^()]*\))+\s*$/;

export const sinZona = (nombre) => (nombre || "").replace(PARENTESIS_FINALES, "").trim();

export function agruparBarrios(dim, geo) {
  const raw = dim.barrios;
  const grupos = new Map(); // "MUNI | BASE" -> [índices]
  raw.forEach((bkey, i) => {
    const [muni, ...resto] = bkey.split(" | ");
    const clave = `${muni} | ${sinZona(resto.join(" | "))}`.toUpperCase();
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(i);
  });

  // Entrada canónica: la del polígono (el mapa dibuja uno solo por barrio) y, si no hay, la primera.
  const poligono = new Set((geo?.bp || []).map((p) => p.b).filter((b) => b >= 0));
  const canon = new Array(raw.length);
  const barrios = raw.slice();
  const miembros = new Map(); // canónico -> [índices del grupo]
  for (const [, idxs] of grupos) {
    const c = idxs.find((i) => poligono.has(i)) ?? idxs[0];
    for (const i of idxs) canon[i] = c;
    miembros.set(c, idxs);
    if (idxs.length > 1) {
      const [muni, ...resto] = raw[c].split(" | ");
      barrios[c] = `${muni} | ${sinZona(resto.join(" | "))}`;
    }
  }

  const bp = (geo?.bp || []).map((p) => (p.b >= 0 ? { ...p, b: canon[p.b] } : p));
  return {
    dim: { ...dim, barrios, barrios_raw: raw, b_grupo: canon, b_miembros: miembros },
    geo: geo ? { ...geo, bp } : geo,
  };
}
