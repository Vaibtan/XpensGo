import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

/** Production Next.js settings shared by local and OpenNext builds. */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

/** Next.js configuration consumed by the framework build. */
export default nextConfig;

void initOpenNextCloudflareForDev();
