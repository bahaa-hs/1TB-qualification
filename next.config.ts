import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite is a builtin, but Next's bundler needs to be told not to try to
  // resolve it into the server bundle.
  serverExternalPackages: ["node:sqlite"],

  // Keep build outputs in separate directories per purpose.
  //
  // Everything defaults to .next, which has bitten twice:
  //
  //  1. `next build` while `next dev` was running left a half-overwritten
  //     directory — chunks 404 and pages 500 with "Cannot find module
  //     './611.js'".
  //  2. `next build` while `next start` was *serving* replaced the directory
  //     underneath it. `next start` caches its build manifest at boot, so it
  //     kept handing browsers chunk URLs that no longer existed and the page
  //     died with an opaque "client-side exception". Only the pages whose code
  //     changed break, which makes it look like a bug in that feature.
  //
  // NODE_ENV is "development" only under `next dev`. OUTREACH_DIST_DIR is for
  // verification builds run while a real server is up:
  //
  //     OUTREACH_DIST_DIR=.next-verify npm run build
  //
  distDir:
    process.env.OUTREACH_DIST_DIR ??
    (process.env.NODE_ENV === "development" ? ".next-dev" : ".next"),
};

export default nextConfig;
