/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // /standings, /history and /my-roster all merged into the league page at /.
  // Managers were told to bookmark the app and add it to their home screen, so
  // some of those saved links point at the old routes — redirect rather than
  // 404 them. Permanent: these paths are not coming back.
  async redirects() {
    return [
      { source: "/standings", destination: "/", permanent: true },
      { source: "/history", destination: "/", permanent: true },
      { source: "/my-roster", destination: "/", permanent: true },
    ];
  },
};

module.exports = nextConfig;
