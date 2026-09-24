// app/inp-blame.ts, imported first in app/root.tsx so it runs before any route loads react-dom
import { install } from "react-inp-blame";

// Every build. For the dev server alone, wrap the call in `if (import.meta.env.DEV)`.
install({ overlay: "query" }); // the badge only on request, such as ?inp-blame in the URL
