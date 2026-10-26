/** @type {import('next').NextConfig} */
const nextConfig = {
  // El visor es estático: lee los JSON de `public/scr/`. No hay API ni proxy; el ETL
  // es quien habla con PostgreSQL.
  reactStrictMode: true,
};

export default nextConfig;
