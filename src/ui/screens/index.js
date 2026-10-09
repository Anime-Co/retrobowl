// Screen registry. Each screen module exports a class; register it here under a stable name.
import { TitleScreen } from './title.js';
import { NewGameScreen } from './newGame.js';
import { HubScreen } from './hub.js';
import { PostGameScreen } from './postGame.js';
import { OffseasonScreen } from './offseason.js';
import { FiredScreen } from './fired.js';
import { SettingsScreen } from './settings.js';
import { HelpScreen } from './help.js';
import { MatchScreen } from '../../match/MatchScreen.js';

export function registerScreens(app) {
  app.register('title', TitleScreen);
  app.register('newGame', NewGameScreen);
  app.register('hub', HubScreen);
  app.register('postGame', PostGameScreen);
  app.register('offseason', OffseasonScreen);
  app.register('fired', FiredScreen);
  app.register('settings', SettingsScreen);
  app.register('help', HelpScreen);
  app.register('match', MatchScreen);
}
