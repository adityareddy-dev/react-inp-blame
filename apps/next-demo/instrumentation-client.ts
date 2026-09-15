// Next.js runs this file before the application's frontend code. The open question this
// app exists to answer: is that before react-dom evaluates and registers with the hook?
// The index module has no side effects on import, so calling install() here is the
// right shape for Next; the /auto entry is for bundlers where import order is explicit.
import { install } from 'react-inp-blame';

install({ threshold: 16, walkBudget: 100000, debugGlobal: true, devtoolsTrack: true, overlay: true });
