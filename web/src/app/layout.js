import "./globals.css";

export const metadata = {
  title: "Centro Operativo · Mapa SCR — Acuacar Cartagena",
  description: "Visor de efectividad y pérdidas de SCR en Cartagena, ISES | ACUACAR",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#78BE20" },
    { media: "(prefers-color-scheme: dark)", color: "#14201A" },
  ],
};

// Fija el tema antes del primer pintado para evitar el parpadeo de color.
const THEME_INIT = `(function(){try{
var t=localStorage.getItem('ises-theme');
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
            Montserrat (y luego Poppins) toman el relevo con el mismo carácter geométrico. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
