import { withInpBlame } from 'react-inp-blame/next';

// withInpBlame adds react-inp-blame/next-client to instrumentationClientInject, which installs the
// library before hydration, and the displayName loader, so the production report says "Sidebar >
// NavItem" instead of the minifier's "n". By default it adds both to `next dev` only; this app checks
// production builds as well, so it asks for every run. The tests read reports through the debug global.
// scripts/next-left-out.mjs sets INP_LEFT_OUT to build it as the default leaves a production build out,
// with 'development' written out so that the build does not print the line that says so.
export default withInpBlame({}, { enabled: process.env.INP_LEFT_OUT ? 'development' : true, runtime: { debugGlobal: true } });
