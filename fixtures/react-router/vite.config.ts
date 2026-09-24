// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { inpBlame } from "react-inp-blame/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    // Component names that survive the minifier. The install is app/inp-blame.ts, since React Router
    // writes its own HTML and the plugin's script has no page to go in.
    inpBlame({ enabled: true, runtime: false }), // production builds too; the default is development only
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
