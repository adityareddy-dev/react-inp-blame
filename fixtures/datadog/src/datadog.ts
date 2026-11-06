import { datadogRum } from '@datadog/browser-rum';
import { onINP } from 'web-vitals/attribution';
import './recipe';

datadogRum.init({
  applicationId: '00000000-0000-0000-0000-000000000000',
  clientToken: 'pub00000000000000000000000000000000',
  site: 'datadoghq.com',
  service: 'datadog-recipe-fixture',
  sessionSampleRate: 100,
  trackViewsManually: true,
  sessionReplaySampleRate: 0,
  compressIntakeRequests: false,
  proxy: '/rum',
});

datadogRum.startView('slow-click');

declare global {
  interface Window {
    startNextRumView: () => void;
    inpReports: { id: string; value: number }[];
  }
}
window.startNextRumView = () => datadogRum.startView('after-click');
// Keep callback snapshots without changing the published recipe.
window.inpReports = [];
onINP(({ id, value }) => window.inpReports.push({ id, value }));
