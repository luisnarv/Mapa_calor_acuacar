// maplibre resuelve la URL de su worker con `import.meta.url`, y al empaquetar
// con Turbopack eso no es una URL http(s): la función devuelve cadena vacía, el
// worker no arranca y el mapa se queda en blanco sin lanzar ningún error. La
// salida es servir el worker desde public/ y apuntarle con setWorkerUrl().
// Se copia en cada `npm install` para que no envejezca frente a node_modules.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const destino = join(raiz, "public", "maplibre");
// El worker importa el bundle compartido por ruta relativa, así que los dos
// tienen que quedar en la misma carpeta.
const archivos = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

await mkdir(destino, { recursive: true });
for (const a of archivos) {
  await copyFile(join(raiz, "node_modules", "maplibre-gl", "dist", a), join(destino, a));
}
console.log(`maplibre: worker copiado a public/maplibre/ (${archivos.length} archivos)`);
