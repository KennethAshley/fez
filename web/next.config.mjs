/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/docs', destination: 'https://docs.fez.chat', permanent: true },
      { source: '/docs/:path*', destination: 'https://docs.fez.chat/:path*', permanent: true },
      // Retired pages: the front page carries the pitch now. Temporary, so
      // an old link lands somewhere useful without freezing the decision.
      ...['/bazaar', '/whitepaper', '/mine', '/roadmap'].map((source) => ({ source, destination: '/', permanent: false })),
    ];
  },
};

export default config;
