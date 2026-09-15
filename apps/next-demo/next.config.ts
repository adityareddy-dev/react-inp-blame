import { withInpBlame } from 'react-inp-blame/next';

// withInpBlame adds the displayName loader (Turbopack rule + webpack rule), so the production
// report says "Sidebar > NavItem" instead of the minifier's "n". The runtime half is the one
// import in instrumentation-client.ts.
export default withInpBlame({});
