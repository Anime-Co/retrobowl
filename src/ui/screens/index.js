// Screen registry. Each screen module exports a class; register it here under a stable name.
import { TitleScreen } from './title.js';

export function registerScreens(app) {
  app.register('title', TitleScreen);
}
