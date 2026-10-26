"use client";

import React from "react";
import { ChevronDown, X } from "lucide-react";

/**
 * Un filtro como píldora, con sus dos estados en el mismo elemento.
 *
 * Sin valor muestra solo su nombre («Zona ▾»); con valor muestra «Zona: Norte ×»
 * en acento. Antes esto eran dos cosas —un `<select>` y, aparte, un chip que
 * repetía lo elegido—, así que lo puesto se leía dos veces y quitarlo obligaba a
 * volver al select y buscar la opción «Todas».
 *
 * El precio de dejar el `<select>` nativo es que hay que reponer a mano lo que
 * regalaba: teclado, Esc, foco y roles. Va todo aquí para no repetirlo cinco
 * veces.
 */
export default function FiltroPildora({
  etiqueta,
  valor,
  opciones,
  onElegir,
  vacio = "Todas"
}) {
  const [abierto, setAbierto] = React.useState(false);
  const [marcado, setMarcado] = React.useState(-1);
  const cajaRef = React.useRef(null);
  const listaRef = React.useRef(null);

  const puesto = valor !== "" && valor != null;
  // Con 0 o 1 valores posibles filtrar no cambia nada: la píldora se apaga (si ya hay un
  // valor puesto sigue activa, para poder quitarlo).
  const sinElegir = !puesto && opciones.length <= 1;
  const elegida = puesto ? opciones.find((o) => String(o.valor) === String(valor)) : null;

  const cerrar = React.useCallback((devolverFoco = true) => {
    setAbierto(false);
    setMarcado(-1);
    if (devolverFoco) cajaRef.current?.querySelector("button")?.focus();
  }, []);

  // Un clic fuera cierra. Se escucha en captura para que el mismo clic que abre
  // otra píldora no cierre y reabra en el orden equivocado.
  React.useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => {
      if (!cajaRef.current?.contains(e.target)) cerrar(false);
    };
    document.addEventListener("mousedown", fuera, true);
    return () => document.removeEventListener("mousedown", fuera, true);
  }, [abierto, cerrar]);

  // Al abrir, el foco entra en la lista para que las flechas funcionen de una.
  React.useEffect(() => {
    if (abierto) listaRef.current?.focus();
  }, [abierto]);

  const elegir = (v) => {
    onElegir(v);
    cerrar();
  };

  const teclas = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const paso = e.key === "ArrowDown" ? 1 : -1;
      const total = opciones.length + 1; // +1 por la opción «todas»
      setMarcado((i) => (i + paso + total) % total);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setMarcado(e.key === "Home" ? 0 : opciones.length);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (marcado === 0) elegir("");
      else if (marcado > 0) elegir(opciones[marcado - 1].valor);
    }
  };

  return (
    <div className="hd-f" ref={cajaRef}>
      <button
        type="button"
        className={`hd-pill ${puesto ? "on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        disabled={sinElegir}
        title={
          sinElegir
            ? opciones.length
              ? `Con los filtros actuales solo hay un valor: ${opciones[0].texto}`
              : "Sin valores con los filtros actuales"
            : undefined
        }
        onClick={() => setAbierto((v) => !v)}
      >
        <span className="hd-pill-k">{etiqueta}</span>
        {puesto && <span className="hd-pill-v">: {elegida?.texto ?? valor}</span>}
        <span className="hd-pill-ic" aria-hidden="true">
          {puesto ? <X size={13} strokeWidth={2.4} /> : <ChevronDown size={13} strokeWidth={2.4} />}
        </span>
      </button>

      {/* Quitar el filtro es un botón aparte encima de la X: si fuera el mismo
          control, abrir la lista y limpiar competirían por el clic. */}
      {puesto && (
        <button
          type="button"
          className="hd-pill-x"
          aria-label={`Quitar el filtro de ${etiqueta.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            onElegir("");
          }}
        />
      )}

      {abierto && (
        <div
          className="hd-pop"
          role="listbox"
          aria-label={etiqueta}
          tabIndex={-1}
          ref={listaRef}
          onKeyDown={teclas}
        >
          <button
            type="button"
            role="option"
            aria-selected={!puesto}
            className={`hd-op ${!puesto ? "sel" : ""} ${marcado === 0 ? "mk" : ""}`}
            onClick={() => elegir("")}
          >
            {vacio}
          </button>
          {opciones.map((o, i) => (
            <button
              key={o.valor}
              type="button"
              role="option"
              aria-selected={String(o.valor) === String(valor)}
              className={`hd-op ${String(o.valor) === String(valor) ? "sel" : ""} ${
                marcado === i + 1 ? "mk" : ""
              }`}
              onClick={() => elegir(o.valor)}
            >
              {o.texto}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
