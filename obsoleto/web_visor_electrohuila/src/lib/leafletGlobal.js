// `leaflet.heat` es un plugin de los de antes: no importa nada, se cuelga del
// `L` global. Este módulo lo deja puesto y por eso hay que importarlo ANTES que
// el plugin — los módulos ES se evalúan en el orden en que se declaran sus
// imports, así que el orden de las dos líneas en MapaCalor.js no es cosmético.
import L from "leaflet";

if (typeof window !== "undefined" && !window.L) window.L = L;

export default L;
