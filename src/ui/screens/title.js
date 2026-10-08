// Placeholder title screen (replaced by the UI module).
import { h } from '../dom.js';

export class TitleScreen {
  constructor(app) {
    this.app = app;
  }

  mount(root) {
    root.appendChild(h('div.screen', { style: { alignItems: 'center', justifyContent: 'center', gap: '16px' } },
      h('h1.title-xl', 'Pocket Gridiron'),
      h('p.dim', 'Loading...'),
    ));
  }

  unmount() {}
}
