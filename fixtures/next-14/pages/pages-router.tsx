import { SlowList } from '../app/slow-list';
// A Pages Router page beside the App Router one: its client entry is webpack's `main`, not `main-app`.
export default function PagesRouterPage() { return <main><SlowList /></main>; }
