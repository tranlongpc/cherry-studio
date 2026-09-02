import { renderBackgroundActivity } from '@cherrystudio/ui-native/background-activity/ios';
import { createLiveActivity } from 'expo-widgets';

import type { PaintingActivityProps } from '@/shared/backgroundActivity/painting';

export default createLiveActivity<PaintingActivityProps>(
  'PaintingActivity',
  renderBackgroundActivity,
);
