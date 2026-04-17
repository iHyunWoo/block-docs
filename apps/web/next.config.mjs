import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // StrictMode double-invokes effects which mounts Y.Doc
                          // twice in dev — harmless but very noisy.
  experimental: {},
  // Next 14 moved serverComponentsExternalPackages under the top-level option.
  transpilePackages: [],
  images: {
    remotePatterns: [{ protocol: "http", hostname: "**" }, { protocol: "https", hostname: "**" }],
  },
  webpack: (config, { isServer }) => {
    // Force a single Yjs instance. Without this, Next.js splits yjs between
    // the React Server Component bundle and the client bundle (or simply
    // duplicates on HMR), producing "Yjs was already imported" warnings and —
    // more importantly — two Y.Doc constructors that don't share the internal
    // ObservableV2 class, so `doc.on('update', fn)` silently emits to the
    // wrong dispatcher. See https://github.com/yjs/yjs/issues/438.
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      yjs$: path.resolve(__dirname, "node_modules/yjs/dist/yjs.mjs"),
    };
    if (!isServer) {
      // Mark yjs as a shared singleton chunk.
      config.optimization = config.optimization ?? {};
      config.optimization.splitChunks = config.optimization.splitChunks || {};
      config.optimization.splitChunks.cacheGroups = {
        ...(config.optimization.splitChunks.cacheGroups ?? {}),
        yjs: {
          test: /[\\/]node_modules[\\/]yjs[\\/]/,
          name: "yjs",
          chunks: "all",
          enforce: true,
        },
      };
    }
    return config;
  },
};

export default nextConfig;
