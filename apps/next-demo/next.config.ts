import { withInpBlame } from 'react-inp-blame/next';

// withInpBlame adds react-inp-blame/next-client to instrumentationClientInject, which installs the
// library before hydration, and the displayName loader, so the production report says "Sidebar >
// NavItem" instead of the minifier's "n". By default it adds both to `next dev` only; this app checks
// production builds as well, so it asks for every run. The tests read reports through the debug global.
export default withInpBlame({}, { enabled: true, runtime: { debugGlobal: true } });
