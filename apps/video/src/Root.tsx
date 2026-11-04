import { Composition } from 'remotion';
import { Demo, DURATION, FPS, H, W } from './Demo';

export const Root = () => (
  <Composition id="PhoneDemo" component={Demo} durationInFrames={DURATION} fps={FPS} width={W} height={H} defaultProps={{ showFinger: true }} />
);
