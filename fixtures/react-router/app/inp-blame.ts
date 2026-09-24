// app/inp-blame.ts, imported first in app/entry.client.tsx so it runs before react-dom loads
import { install } from "react-inp-blame";

// Every build. For the dev server alone, wrap the call in `if (import.meta.env.DEV)`.
install({ overlay: "query" }); // the badge only on request, such as ?inp-blame in the URL
