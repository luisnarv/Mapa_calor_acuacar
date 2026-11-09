/** @type {import('next').NextConfig} */
const nextConfig = {
  // El Dockerfile fija NEXT_OUTPUT=standalone para generar una imagen mínima;
  // sin la variable (npm run dev/build local, Vercel) todo sigue igual.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // El visor es estático: lee los JSON de `public/scr/`; el ETL es quien habla con
  // PostgreSQL.
  reactStrictMode: true,
  // Dirección del backend del asistente, tal como la usa el navegador. Sin el
  // prefijo NEXT_PUBLIC_ Next no la pasa al navegador por sí solo: se expone aquí
  // y queda escrita en el JavaScript al compilar (es una dirección, no un secreto).
  env: { ACUACAR_API_URL: process.env.ACUACAR_API_URL || "" },
  // Puente hacia el backend del asistente. El servidor solo habla HTTP y Vercel
  // sirve por HTTPS, así que el navegador bloquearía la llamada directa (contenido
  // mixto). Con `ACUACAR_API_URL=/backend` el navegador llama a su propio
  // dominio y Next reenvía al servidor. `BACKEND_URL` cambia el destino.
  async rewrites() {
    const destino = (process.env.BACKEND_URL || "http://52.88.48.137/mapa-acuacar").replace(/\/+$/, "");
    return [{ source: "/backend/:path*", destination: `${destino}/:path*` }];
  },
};

export default nextConfig;
