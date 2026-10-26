import "./globals.css";

export const metadata = {
  title: "Mapa de calor — Acuacar",
  description:
    "Distribución geográfica de las suspensiones de Acuacar sobre el " +
    "histórico de PostgreSQL y los límites oficiales del Cartagena.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#78BE20" },
    { media: "(prefers-color-scheme: dark)", color: "#0A1A2F" },
  ],
};

// Fija el tema antes del primer pintado para evitar el parpadeo de color.
const TEMA_INICIAL = `(function(){try{
var t=localStorage.getItem('eh-mapa-theme');
if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
document.documentElement.dataset.theme=t;
document.documentElement.style.colorScheme=t;
}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="es" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Gotham es de licencia comercial: si no está instalada en el equipo,
            Montserrat (y luego Poppins) toman el relevo con el mismo carácter
            geométrico. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: TEMA_INICIAL }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
