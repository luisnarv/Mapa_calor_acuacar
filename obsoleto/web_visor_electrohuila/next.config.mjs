/** @type {import('next').NextConfig} */
const nextConfig = {
  // El visor es estático: lee data.json y los geojson de `public/`. No hay API
  // propia ni proxy a ningún backend — el ETL es quien habla con PostgreSQL.
  reactStrictMode: true,
};

export default nextConfig;
