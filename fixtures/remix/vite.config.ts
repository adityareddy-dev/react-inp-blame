// vite.config.ts
import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { inpBlame } from "react-inp-blame/vite";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

export default defineConfig({
  plugins: [
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_singleFetch: true,
        v3_lazyRouteDiscovery: true,
      },
    }),
    tsconfigPaths(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: "query" }, // the badge only on request, such as ?inp-blame in the URL
      entry: "app/root.tsx",         // Remix writes its own HTML, so the install goes first in the root route
    }),
  ],
});
