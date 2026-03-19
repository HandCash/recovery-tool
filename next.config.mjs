/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "ordinals.gorillapool.io" },
      { protocol: "https", hostname: "res.cloudinary.com" },
    ],
  },
}

export default nextConfig
