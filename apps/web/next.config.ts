import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @clinicas/shared e distribuido como fonte compilada do monorepo, nao publicado.
  transpilePackages: ['@clinicas/shared'],
}

export default nextConfig
