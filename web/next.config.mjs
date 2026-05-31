import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next stops inferring it from C:\Users\tcsde
  // (there are multiple package-lock.json files on this machine).
  outputFileTracingRoot: __dirname,
  // Hide the floating Next.js dev indicator/logo overlay.
  devIndicators: false,
}

export default nextConfig
