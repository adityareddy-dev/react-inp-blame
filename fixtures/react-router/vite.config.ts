// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { inpBlame } from "react-inp-blame/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: "query" }, // the badge only on request, such as ?inp-blame in the URL
      entry: "app/root.tsx",         // React Router writes its own HTML, so the install goes first in the root route
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
