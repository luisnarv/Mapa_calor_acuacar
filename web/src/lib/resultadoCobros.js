// Las dos dimensiones de una gestión de COBROS, tal como las escribe el ETL.
// Los nombres viven aquí para no repetirlos en cada tabla; si la BD cambia una
// etiqueta se corrige aquí y en `etl/etl/taxonomy.py`, que las produce.
//
// 1. Resultado gestión (`dim.gests`, `pts.x`; BD `resultado_reportado`): el filtro de la barra
//    superior y lo que separa Efectiva de Perdida.
export const PERDIDA = "Contacto no efectivo";

// 2. Recaudo (`dim.resultados`, `pts.rg`; BD `resultado_gestion`): el submenú de
//    «Efectivas» y las columnas «con pago» / «sin recaudo».
export const CON_PAGO = "Efectiva con pago";
export const SIN_RECAUDO = "Efectiva sin recaudo";
export const SIN_VALIDAR = "Efectiva sin validar";

/** Índice de un resultado de gestión en `dim.gests` (-1 si ese payload no lo trae). */
export const idDe = (dim, nombre) => (dim.gests ? dim.gests.indexOf(nombre) : -1);

/** Índice de un valor de recaudo en `dim.resultados` (-1 si ese payload no lo trae). */
export const idRec = (dim, nombre) => (dim.resultados ? dim.resultados.indexOf(nombre) : -1);
