/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/docs', destination: 'https://docs.fez.chat', permanent: true },
      { source: '/docs/:path*', destination: 'https://docs.fez.chat/:path*', permanent: true },
    ];
  },
};

export default config;
