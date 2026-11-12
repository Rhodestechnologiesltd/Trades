/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@trades/shared'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'Permissions-Policy', value: 'geolocation=(self), camera=()' },
    ] }];
  },
};
export default nextConfig;
