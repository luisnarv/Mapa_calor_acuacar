/** @type {import('next').NextConfig} */
const nextConfig = {
  // El Dockerfile fija NEXT_OUTPUT=standalone para generar una imagen mínima;
  // sin la variable (npm run dev/build local, Vercel) todo sigue igual.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // El visor es estático: lee los JSON de `public/scr/`. No hay API ni proxy; el ETL
  // es quien habla con PostgreSQL.
  reactStrictMode: true,
};

export default nextConfig;
