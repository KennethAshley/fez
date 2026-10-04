/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      // Decision models now have an independent website and repository.
      ...['model', 'playground', 'train'].map((path) => ({
        source: `/${path}/:path*`,
        destination: `https://zils.ai/${path}/:path*`,
        permanent: true,
      })),
      { source: '/docs', destination: 'https://docs.fez.chat', permanent: true },
      { source: '/docs/:path*', destination: 'https://docs.fez.chat/:path*', permanent: true },
      // The Sidecar/agent-network page is the CLI page now.
      { source: '/network', destination: '/cli', permanent: true },
      // Retired pages: the front page carries the pitch now. Temporary, so
      // an old link lands somewhere useful without freezing the decision.
      ...['/bazaar', '/whitepaper', '/mine', '/roadmap'].map((source) => ({ source, destination: '/', permanent: false })),
    ];
  },
};

export default config;
