// TEMPORARY stand-in for the 'match' screen so the franchise loop can be played end to end.
// Quick sim = franchise simulateUserGame(); Auto-play = the match logic engine (gives a box score).
// The real MatchScreen (src/match/MatchScreen.js) replaces this registration.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { Match, autoPlayMatch } from '../../match/logic/index.js';
import { btn, screenHeader } from './common.js';

export class MatchStubScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.gameId = params.gameId;
  }

  mount(root) {
    const app = this.app;
    const save = app.save;
    const game = save && F.userGameThisWeek(save);
    if (!game || game.played || (this.gameId && game.id !== this.gameId)) { setTimeout(() => app.go(save ? 'hub' : 'title'), 0); return; }
    const opp = F.opponentOf(save, game);
    root.appendChild(h('div.screen.stub', h('div.wrap',
      screenHeader(app, { title: 'Match (temporary)', onBack: () => app.go('hub') }),
      h('section.panel',
        h('p', `${F.userTeam(save).city} ${game.home === save.userTeamId ? 'vs' : 'at'} ${opp.city}`),
        h('p.dim', 'The playable match screen is not plugged in yet. Pick how to resolve this game:'),
        h('div.btn-col',
          btn(app, 'Auto-play (match engine)', () => this.play('auto'), { kind: 'primary', id: 'stub-auto', sfx: 'whistle' }),
          btn(app, 'Quick sim', () => this.play('sim'), { id: 'stub-sim', sfx: 'whistle' }),
        ),
      ),
    )));
  }

  unmount() {}

  play(kind) {
    const app = this.app;
    const save = app.save;
    let result;
    try {
      if (kind === 'auto') {
        const setup = F.matchSetup(save);
        const s = app.settings;
        const m = new Match({ ...setup, settings: { quarterMinutes: s.quarterMinutes, difficultyStep: setup.difficultyStep, wind: s.wind } });
        result = autoPlayMatch(m, { seed: setup.seed });
      } else {
        result = F.simulateUserGame(save);
      }
      const summary = F.applyUserGameResult(save, result);
      app.persist();
      app.go('postGame', { gameId: result.gameId, result, summary });
    } catch (e) {
      console.error(e);
      toast('Could not finish the game');
    }
  }
}
