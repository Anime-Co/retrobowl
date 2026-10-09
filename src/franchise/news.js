// News (MECHANICS §7.6): between games, 0-2 press questions or player messages with 2-3 choices.
// Each choice visibly shifts fans, team morale, one player's morale, CC or owner confidence.
// All wording is original. Also league headlines for the news feed (see feed.js).

import { NEWS, TRAIT_EFFECTS } from './config.js';
import { fullName, shortName, stars, POS_LABELS } from './players.js';
import { clamp } from '../core/util.js';
import { roster, findPlayer, userTeam, teamById, newId, fail } from './state.js';
import { addXp } from './progression.js';
import { refreshUserRatings } from './squad.js';
import { addHeadline } from './feed.js';
import { recordText, gameWinner } from './league.js';

/**
 * @typedef {Object} NewsEffects
 * @property {number} [fans]
 * @property {number} [teamMorale]
 * @property {number} [cc]
 * @property {number} [jobSecurity]
 * @property {{id:string, delta:number}[]} [players]   morale changes
 * @property {{id:string, weeks:number}} [injury]       injury weeks change
 * @property {{id:string, amount:number}} [xp]
 */

const ch = (label, reply, effects) => ({ label, reply, effects });
const pm = (p, delta) => ({ players: [{ id: p.id, delta }] });
const name = (p) => fullName(p);

/** Event templates. weight(ctx) > 0 makes a template eligible; make(ctx) builds the event. */
export const TEMPLATES = [
  {
    id: 'hot-streak', kind: 'press',
    weight: (c) => (c.post && c.streak >= 3 ? 4 : 0),
    make: (c) => ({
      title: 'On a roll',
      body: `That's ${c.streak} straight wins. A radio host wants to know if ${c.team.city} should start planning a parade.`,
      choices: [
        ch('"Book the floats."', 'The sound bite runs all week. The city is buzzing.', { fans: 4, teamMorale: 1 }),
        ch('"We haven\'t won anything yet."', 'The locker room likes the level head.', { teamMorale: 3 }),
        c.top
          ? ch('"Ask the players. They did this."', `${name(c.top.p)} soaks up the spotlight.`, { fans: 1, ...pm(c.top.p, 6) })
          : ch('"Ask the players. They did this."', 'The players enjoy the credit.', { teamMorale: 2 }),
      ],
    }),
  },
  {
    id: 'cold-streak', kind: 'press',
    weight: (c) => (c.post && c.streak <= -3 ? 4 : 0),
    make: (c) => ({
      title: 'Skid talk',
      body: `${-c.streak} losses in a row. A columnist asks whether the job has gotten away from you.`,
      choices: [
        ch('"That\'s on me, and I\'ll fix it."', 'The players appreciate you taking the heat.', { teamMorale: 4, fans: -1 }),
        ch('"Some guys need to look in the mirror."', 'It stings in the locker room, but the fans like the fire.', { teamMorale: -5, fans: 2, jobSecurity: 1 }),
        ch('"We\'re closer than the record says."', 'Nobody outside the building believes it.', { fans: -2, teamMorale: 1 }),
      ],
    }),
  },
  {
    id: 'blowout-win', kind: 'press',
    weight: (c) => (c.post && c.margin >= 21 ? 3 : 0),
    make: (c) => ({
      title: 'Piling on?',
      body: `The ${c.opp.city} coach grumbled that you kept throwing deep while up big in a ${c.score} win.`,
      choices: [
        ch('"Sixty minutes. Every week."', 'Your fans love the attitude.', { fans: 3, teamMorale: 2 }),
        ch('"Fair point. We could have eased off."', 'The league office appreciates the tone.', { fans: -1, jobSecurity: 1 }),
        ch('"Our backups needed the reps."', 'The second string feels trusted.', { teamMorale: 2 }),
      ],
    }),
  },
  {
    id: 'blowout-loss', kind: 'press',
    weight: (c) => (c.post && c.margin <= -21 ? 3 : 0),
    make: (c) => ({
      title: 'Long afternoon',
      body: `A ${c.score} defeat to ${c.opp.city}. What went wrong out there?`,
      choices: [
        ch('"Everything. The film session will be long."', 'The honesty plays well upstairs.', { teamMorale: -2, jobSecurity: 2 }),
        ch('"They were better today. Simple as that."', 'Fans wanted more fight than that.', { fans: -2, teamMorale: 2 }),
        ch('"One bad game. We move on."', 'The room exhales.', { teamMorale: 1 }),
      ],
    }),
  },
  {
    id: 'close-win', kind: 'press',
    weight: (c) => (c.post && c.margin > 0 && c.margin <= 3 ? 2 : 0),
    make: (c) => ({
      title: 'Down to the wire',
      body: `Another finish that had fans chewing their nails. Was it nerve or luck against ${c.opp.city}?`,
      choices: [
        ch('"Nerve. We drill those moments."', 'Confidence is contagious.', { fans: 2, teamMorale: 1 }),
        ch('"Luck. We have to close games earlier."', 'The players take the point.', { teamMorale: 2 }),
        ch('"The crowd won that one for us."', 'The stands will be louder next week.', { fans: 4 }),
      ],
    }),
  },
  {
    id: 'close-loss', kind: 'press',
    weight: (c) => (c.post && c.margin < 0 && c.margin >= -3 ? 2 : 0),
    make: (c) => ({
      title: 'So close',
      body: `A ${c.score} loss decided late. Reporters want to talk about the final drive.`,
      choices: [
        ch('"I\'d make every call again."', 'The players like that you backed them.', { teamMorale: 2, fans: -1 }),
        ch('"I got that one wrong."', 'Fans respect the honesty; the owner frowns.', { fans: 2, jobSecurity: -1 }),
        ch('"The ball bounced their way."', 'A shrug and a short answer.', { teamMorale: 1 }),
      ],
    }),
  },
  {
    id: 'star-turn', kind: 'press',
    weight: (c) => (c.post && c.top ? 3 : 0),
    make: (c) => ({
      title: 'Star turn',
      playerId: c.top.p.id,
      body: `${name(c.top.p)} ${c.top.line}. Is he the best ${POS_LABELS[c.top.p.pos].toLowerCase()} in the league right now?`,
      choices: [
        ch('"Best I\'ve ever coached."', 'He grins ear to ear. A few teammates roll their eyes.', { teamMorale: -2, ...pm(c.top.p, 8) }),
        ch('"He\'s great, but this is a team."', 'The whole roster feels seen.', { teamMorale: 3, ...pm(c.top.p, 2) }),
        ch('"He has another level to reach."', 'He takes it as a challenge and stays late after practice.', { ...pm(c.top.p, -3), xp: { id: c.top.p.id, amount: 30 } }),
      ],
    }),
  },
  {
    id: 'rivalry', kind: 'press',
    weight: (c) => (c.rival ? 3 : 0),
    make: (c) => ({
      title: 'Rivalry week',
      body: `${c.next.city} is up next. Their fans have already printed shirts with your face on them.`,
      choices: [
        ch('"Circle the date. We\'re coming."', 'The rivalry gets a little hotter.', { fans: 4, teamMorale: 1 }),
        ch('"It\'s one game on a long schedule."', 'Calm and focused.', { teamMorale: 1 }),
        ch('"Plenty of respect for that building."', 'Your own fans wanted more bite.', { fans: -2, teamMorale: 2 }),
      ],
    }),
  },
  {
    id: 'injury', kind: 'press',
    weight: (c) => (c.injured ? 4 : 0),
    make: (c) => ({
      title: 'Next man up',
      playerId: c.injured.p.id,
      body: `${name(c.injured.p)} will miss about ${c.injured.weeks >= 20 ? 'the rest of the season' : `${c.injured.weeks} weeks`} (${c.injured.p.injury ? c.injured.p.injury.type.toLowerCase() : 'injury'}). How do you cope?`,
      choices: [
        ch('"Somebody gets a shot. Let\'s see who grabs it."', 'The backups are fired up.', { teamMorale: 3 }),
        ch('"Losing him hurts. No sugar-coating it."', 'He appreciates it; the rest of the room feels the gloom.', { teamMorale: -2, ...pm(c.injured.p, 5) }),
        ch('"We\'ll look at the free-agent market."', 'Fans like the urgency.', { fans: 2, teamMorale: -1 }),
      ],
    }),
  },
  {
    id: 'qb-ints', kind: 'press',
    weight: (c) => (c.qbInts ? 4 : 0),
    make: (c) => ({
      title: 'Giveaways',
      playerId: c.qbInts.p.id,
      body: `${name(c.qbInts.p)} threw ${c.qbInts.n} interceptions. Is he still your quarterback?`,
      choices: [
        ch('"Without question."', 'He walks a little taller at practice.', { fans: -2, ...pm(c.qbInts.p, 7) }),
        ch('"He has to protect the football. Period."', 'Message received, loudly.', { fans: 2, teamMorale: 1, ...pm(c.qbInts.p, -6) }),
        ch('"A couple of those were on the receivers."', 'The receivers are not thrilled.', { teamMorale: -3, ...pm(c.qbInts.p, 4) }),
      ],
    }),
  },
  {
    id: 'leaky-defense', kind: 'press',
    weight: (c) => (c.post && c.them >= 31 ? 3 : 0),
    make: (c) => ({
      title: 'Open season',
      body: `${c.them} points allowed. Are changes coming on defense?`,
      choices: [
        ch('"Full pads in practice this week."', 'Sore bodies, happy fans.', { teamMorale: -2, fans: 2 }),
        ch('"Then the offense will outscore people."', 'Bold. The owner raises an eyebrow.', { fans: 1, teamMorale: 1, jobSecurity: -1 }),
        ch('"Small fixes. Nobody is panicking."', 'The defense appreciates the trust.', { teamMorale: 2 }),
      ],
    }),
  },
  {
    id: 'playoff-race', kind: 'press',
    weight: (c) => (c.post && c.inRace ? 2 : 0),
    make: () => ({
      title: 'Stretch run',
      body: 'With the season winding down, a reporter asks if this is a playoff team.',
      choices: [
        ch('"Save some January dates."', 'Ticket sales spike.', { fans: 4, jobSecurity: -1 }),
        ch('"Only thinking about next week."', 'Business as usual.', { teamMorale: 2 }),
      ],
    }),
  },
  {
    id: 'rookie', kind: 'press',
    weight: (c) => (c.rookieStar ? 3 : 0),
    make: (c) => ({
      title: 'Rookie on the rise',
      playerId: c.rookieStar.p.id,
      body: `${name(c.rookieStar.p)} ${c.rookieStar.line} and played like a veteran. How high is his ceiling?`,
      choices: [
        ch('"Sky high. Remember the name."', 'The kid is beaming.', { fans: 1, ...pm(c.rookieStar.p, 8) }),
        ch('"Still plenty to learn."', 'He hears it and spends extra hours in the film room.', { ...pm(c.rookieStar.p, -2), xp: { id: c.rookieStar.p.id, amount: 25 } }),
      ],
    }),
  },
  {
    id: 'tickets', kind: 'press',
    weight: (c) => (c.post ? 1 : 0),
    make: () => ({
      title: 'Ticket prices',
      body: "Season-ticket holders are grumbling about this year's price hike.",
      choices: [
        ch('"Roll it back. The fans come first." (1 CC)', 'Cheers from the cheap seats.', { fans: 4, cc: -1 }),
        ch('"Winning teams cost money."', 'The front office pockets a little extra.', { fans: -3, cc: 1 }),
      ],
    }),
  },
  {
    id: 'owner', kind: 'press',
    weight: (c) => (c.js < 40 ? 3 : 0),
    make: () => ({
      title: 'Word from upstairs',
      body: 'The owner told reporters he "expects to see progress soon."',
      choices: [
        ch('"He\'s right. We\'ll deliver."', 'The owner likes the accountability.', { jobSecurity: 3, teamMorale: -1 }),
        ch('"We\'re building something. It takes time."', 'The players rally behind you; the owner is less sure.', { jobSecurity: -2, teamMorale: 3 }),
        ch('"I don\'t answer to rumors."', 'It comes off as prickly.', { fans: -1 }),
      ],
    }),
  },
  {
    id: 'kicker', kind: 'press',
    weight: (c) => (c.kick ? 2 : 0),
    make: (c) => {
      const { p, made, att } = c.kick;
      if (made < att) {
        return {
          title: 'Special teams',
          playerId: p.id,
          body: `${name(p)} went ${made} for ${att} on field goals. Any concerns?`,
          choices: [
            ch('"He\'s our guy. He\'ll bounce back."', 'He hits every kick in practice the next day.', pm(p, 6)),
            ch('"Every job is open for competition."', 'The room notices.', { teamMorale: 1, ...pm(p, -6) }),
          ],
        };
      }
      return {
        title: 'Automatic',
        playerId: p.id,
        body: `${name(p)} was perfect on ${made} field goals. Is he the most reliable leg around?`,
        choices: [
          ch('"Money. Every time."', 'He might frame this quote.', { fans: 1, ...pm(p, 5) }),
          ch('"That\'s his job."', 'Fair enough.', { teamMorale: 1, ...pm(p, -2) }),
        ],
      };
    },
  },
  {
    id: 'preseason', kind: 'press',
    weight: (c) => (c.preseason ? 10 : 0),
    make: (c) => ({
      title: 'Season preview',
      body: `The predictions are out and most experts have ${c.team.city} somewhere in the pack. Your take?`,
      choices: [
        ch('"We win the division."', 'Bold words. Everyone will remember them.', { fans: 5, jobSecurity: -2 }),
        ch('"Better than last year. Count on it."', 'Measured and confident.', { fans: 2, teamMorale: 1 }),
        ch('"Ask me again in December."', 'The players like the focus.', { teamMorale: 1 }),
      ],
    }),
  },
  {
    id: 'midseason', kind: 'press',
    weight: (c) => (c.post && !c.playoff && (c.week === 8 || c.week === 9) ? 2 : 0),
    make: (c) => ({
      title: 'Halfway mark',
      body: `Halfway through the season at ${c.record}. Grade the first half.`,
      choices: [
        ch('"A. Look at the standings."', 'The team feels good about itself.', { fans: 2, teamMorale: 2, jobSecurity: -1 }),
        ch('"Incomplete. Ask me later."', 'Noncommittal, but fine.', { teamMorale: 1 }),
        ch('"C at best. We\'re better than this."', 'Upstairs likes the standard you set.', { teamMorale: -2, jobSecurity: 2 }),
      ],
    }),
  },
  {
    id: 'upset', kind: 'press',
    weight: (c) => (c.upset ? 3 : 0),
    make: (c) => ({
      title: 'Giant killers',
      body: `Few gave ${c.team.city} a chance against ${c.opp.city}. What changed?`,
      choices: [
        ch('"Nothing. We expected to win."', 'Swagger suits this team.', { teamMorale: 3, fans: 2 }),
        ch('"The players believed when nobody else did."', 'The locker room is electric.', { teamMorale: 4 }),
        ch('"We got some breaks. We\'ll take them."', 'Humble. The owner nods along.', { fans: 1, jobSecurity: 1 }),
      ],
    }),
  },
  {
    id: 'shutout', kind: 'press',
    weight: (c) => (c.post && c.won && c.them === 0 ? 3 : 0),
    make: (c) => ({
      title: 'Zero on the board',
      body: `A shutout against ${c.opp.city}. Who gets the game ball?`,
      choices: [
        ch('"The whole defense."', 'Eleven guys share one football.', { teamMorale: 4 }),
        c.defStar
          ? ch(`"${shortName(c.defStar)}."`, `${name(c.defStar)} keeps the ball in his locker.`, { teamMorale: 1, ...pm(c.defStar, 8) })
          : ch('"The coordinators."', 'The staff appreciates it.', { teamMorale: 2 }),
        ch('"The fans. That noise was a twelfth man."', 'The crowd will be even louder next time.', { fans: 4 }),
      ],
    }),
  },
  // ---------------------------------------------------------------- player messages
  {
    id: 'touches', kind: 'message',
    weight: (c) => (c.lowTouch ? 4 : 0),
    make: (c) => ({
      title: 'Wants the ball',
      playerId: c.lowTouch.id,
      body: `${name(c.lowTouch)}: "Coach, I barely touched the ball today. Give me a chance and I'll make plays."`,
      choices: [
        ch('"You\'ll get your touches."', 'He leaves the office smiling.', pm(c.lowTouch, 6)),
        ch('"Everybody has a role. Play yours."', 'He nods, not entirely convinced.', { teamMorale: 1, ...pm(c.lowTouch, -2) }),
        ch('"Earn it in practice."', 'The veterans approve; he does not.', { teamMorale: 2, ...pm(c.lowTouch, -6) }),
      ],
    }),
  },
  {
    id: 'contract-year', kind: 'message',
    weight: (c) => (c.contractYear ? 2 : 0),
    make: (c) => ({
      title: 'Contract year',
      playerId: c.contractYear.id,
      body: `${name(c.contractYear)} is in the last year of his deal and wants to know where he stands.`,
      choices: [
        ch('"You\'re part of our future."', 'He feels wanted.', pm(c.contractYear, 7)),
        ch('"We\'ll talk after the season."', 'He was hoping for more.', pm(c.contractYear, -4)),
        ch('"Here\'s a bonus for your patience." (1 CC)', 'He is thrilled.', { cc: -1, ...pm(c.contractYear, 12) }),
      ],
    }),
  },
  {
    id: 'mentor', kind: 'message',
    weight: (c) => (c.vet && c.rookie ? 2 : 0),
    make: (c) => ({
      title: 'Mentor',
      playerId: c.rookie.id,
      body: `${name(c.vet)} offered to take rookie ${name(c.rookie)} under his wing.`,
      choices: [
        ch('"Great idea. Make it happen."', 'The two are inseparable at practice.', { players: [{ id: c.vet.id, delta: 3 }, { id: c.rookie.id, delta: 5 }], xp: { id: c.rookie.id, amount: 20 } }),
        ch('"Let the kid find his own way."', 'The rookie feels a little lost.', pm(c.rookie, -3)),
      ],
    }),
  },
  {
    id: 'family', kind: 'message',
    weight: (c) => (c.any ? 1 : 0),
    make: (c) => ({
      title: 'Family first',
      playerId: c.any.id,
      body: `${name(c.any)} asks for a couple of days away to be with his family.`,
      choices: [
        ch('"Of course. Take the time."', 'He returns refreshed and grateful.', { teamMorale: 1, ...pm(c.any, 8) }),
        ch('"We need you at practice."', 'He shows up, but his mind is elsewhere.', { teamMorale: 1, ...pm(c.any, -7) }),
      ],
    }),
  },
  {
    id: 'charity', kind: 'message',
    weight: (c) => (c.star ? 1 : 0),
    make: (c) => ({
      title: 'Community camp',
      playerId: c.star.id,
      body: `${name(c.star)} wants the team to back his youth football camp.`,
      choices: [
        ch('"Count us in." (1 CC)', 'Local news loves it.', { cc: -1, fans: 3, ...pm(c.star, 5) }),
        ch('"Not this year."', 'He is disappointed.', pm(c.star, -3)),
      ],
    }),
  },
  {
    id: 'callout', kind: 'message',
    weight: (c) => (c.post && c.lost && c.star ? 2 : 0),
    make: (c) => ({
      title: 'Frustration boils over',
      playerId: c.star.id,
      body: `${name(c.star)} told reporters some teammates "aren't pulling their weight."`,
      choices: [
        ch('"He\'s allowed to be frustrated."', 'He feels backed; others feel blamed.', { teamMorale: -4, ...pm(c.star, 5) }),
        ch('"Keep it in the building next time."', 'The room appreciates it.', { teamMorale: 3, ...pm(c.star, -6) }),
        ch('"He\'s right, and they know it."', 'Fans eat it up.', { teamMorale: -2, fans: 2, ...pm(c.star, 3) }),
      ],
    }),
  },
  {
    id: 'rush-back', kind: 'message',
    weight: (c) => (c.longInjured ? 2 : 0),
    make: (c) => ({
      title: 'Itching to return',
      playerId: c.longInjured.id,
      body: `${name(c.longInjured)} says he is ready to play through the pain.`,
      choices: [
        ch('"Love it. Let\'s speed up the rehab."', 'He is back on the practice field early.', { injury: { id: c.longInjured.id, weeks: -1 }, ...pm(c.longInjured, 3) }),
        ch('"Rest. Your health comes first."', 'Frustrated, but he listens.', { teamMorale: 1, ...pm(c.longInjured, -3) }),
      ],
    }),
  },
  {
    id: 'team-dinner', kind: 'message',
    weight: (c) => (c.post && c.won && c.streak >= 2 ? 2 : 0),
    make: () => ({
      title: 'Team dinner',
      body: 'The captains want to celebrate the run with a team dinner.',
      choices: [
        ch('"Dinner\'s on me." (1 CC)', 'Steaks all round. Spirits are high.', { cc: -1, teamMorale: 6 }),
        ch('"Celebrate when the season is done."', 'A few groans.', { teamMorale: -2 }),
      ],
    }),
  },
  {
    id: 'endorsement', kind: 'message',
    weight: (c) => (c.star ? 1.5 : 0),
    make: (c) => ({
      title: 'Lights, camera',
      playerId: c.star.id,
      body: `${name(c.star)} landed a local TV commercial. The shoot would cost him a practice day.`,
      choices: [
        ch('"Go for it. Good for the brand."', 'The ad is everywhere by the weekend.', { fans: 2, teamMorale: -1, ...pm(c.star, 6) }),
        ch('"Football first."', 'He grumbles but shows up.', pm(c.star, -5)),
      ],
    }),
  },
  {
    id: 'social', kind: 'message',
    weight: (c) => (c.any ? 1 : 0),
    make: (c) => ({
      title: 'Late-night post',
      playerId: c.any.id,
      body: `${name(c.any)} got into a heated online argument with a fan after the game.`,
      choices: [
        ch('"Fine him."', 'Fans approve of the discipline.', { fans: 3, ...pm(c.any, -6) }),
        ch('"I stand by my player."', 'He is grateful; some fans are not.', { fans: -3, ...pm(c.any, 5) }),
        ch('"Delete it and move on."', 'Quietly handled.', { fans: 1, ...pm(c.any, -1) }),
      ],
    }),
  },
  {
    id: 'film', kind: 'message',
    weight: (c) => (c.young ? 1 : 0),
    make: (c) => ({
      title: 'Extra film',
      playerId: c.young.id,
      body: `${name(c.young)} wants extra film sessions with the coordinators.`,
      choices: [
        ch('"Book the room."', 'He soaks it all up.', { xp: { id: c.young.id, amount: 30 }, ...pm(c.young, 3) }),
        ch('"Rest matters too."', 'He shrugs and heads home.', pm(c.young, -1)),
      ],
    }),
  },
  {
    id: 'unhappy', kind: 'message',
    weight: (c) => (c.unhappy ? 4 : 0),
    make: (c) => ({
      title: 'Sulking',
      playerId: c.unhappy.id,
      body: `${name(c.unhappy)} skipped a meeting and has been sulking at practice.`,
      choices: [
        ch('"Sit down with him one-on-one."', 'A long talk clears the air.', pm(c.unhappy, 8)),
        ch('"Bench threat. Shape up."', 'The rest of the team takes note.', { teamMorale: 2, ...pm(c.unhappy, -5) }),
        ch('"Upgrade the players\' lounge." (1 CC)', 'New couches and a coffee machine work wonders.', { cc: -1, teamMorale: 4 }),
      ],
    }),
  },
];

// --------------------------------------------------------------------------------- context

function statLine(p, s) {
  if (!s) return null;
  if (p.pos === 'QB' && (s.passYds || 0) >= 280) return `threw for ${s.passYds} yards and ${s.passTd || 0} TD`;
  if ((s.rushYds || 0) >= 110) return `ran for ${s.rushYds} yards`;
  if ((s.recYds || 0) >= 110) return `caught ${s.rec || 0} passes for ${s.recYds} yards`;
  if ((s.passTd || 0) + (s.rushTd || 0) + (s.recTd || 0) >= 3) return `scored ${(s.passTd || 0) + (s.rushTd || 0) + (s.recTd || 0)} touchdowns`;
  if ((s.sacks || 0) >= 2) return `piled up ${s.sacks} sacks`;
  if ((s.defInt || 0) >= 2) return `picked off ${s.defInt} passes`;
  if ((s.tackles || 0) >= 10) return `made ${s.tackles} tackles`;
  return null;
}

function nextUserOpponent(save) {
  const g = save.season.schedule.find((x) => !x.played && (x.home === save.userTeamId || x.away === save.userTeamId));
  if (!g) return null;
  return teamById(save, g.home === save.userTeamId ? g.away : g.home);
}

/**
 * Context for template selection.
 * @param {Object} info  {post?, preseason?, game?, won, lost, margin, us, them, oppId, stats, injuries, starters}
 */
export function newsContext(save, rng, info = {}) {
  const team = userTeam(save);
  const r = roster(save);
  const healthy = r.filter((p) => !p.injury);
  const stats = info.stats || {};
  const starters = new Set(info.starters || []);
  const pickOf = (arr) => (arr.length ? rng.pick(arr) : null);
  const c = {
    save,
    team,
    post: !!info.post,
    preseason: !!info.preseason,
    playoff: save.season.phase === 'playoffs',
    week: save.season.week,
    won: !!info.won,
    lost: !!info.lost,
    margin: info.margin || 0,
    us: info.us || 0,
    them: info.them || 0,
    score: `${info.us || 0}-${info.them || 0}`,
    opp: info.oppId ? teamById(save, info.oppId) : null,
    streak: save.season.phase === 'regular' ? team.record.streak : 0,
    record: recordText(team.record),
    js: save.jobSecurity,
    fans: save.fans,
  };
  if (c.post && c.opp) {
    // Top performer and rookie standout
    let best = null;
    for (const p of r) {
      const line = statLine(p, stats[p.id]);
      if (!line) continue;
      const s = stats[p.id];
      const v = (s.passYds || 0) / 4 + (s.rushYds || 0) + (s.recYds || 0) + 20 * ((s.passTd || 0) + (s.rushTd || 0) + (s.recTd || 0))
        + 15 * (s.sacks || 0) + 20 * (s.defInt || 0) + 3 * (s.tackles || 0);
      if (!best || v > best.v) best = { p, line, v };
      if (p.rookie && !c.rookieStar) c.rookieStar = { p, line };
    }
    if (best) c.top = { p: best.p, line: best.line };
    const qb = r.find((p) => p.pos === 'QB' && stats[p.id] && (stats[p.id].int || 0) >= 2);
    if (qb) c.qbInts = { p: qb, n: stats[qb.id].int };
    const k = r.find((p) => p.pos === 'K' && stats[p.id] && (stats[p.id].fgAtt || 0) >= 2 && ((stats[p.id].fgAtt - stats[p.id].fgMade) >= 2 || stats[p.id].fgMade >= 3));
    if (k) c.kick = { p: k, made: stats[k.id].fgMade || 0, att: stats[k.id].fgAtt || 0 };
    const low = healthy.filter((p) => ['RB', 'WR', 'TE'].includes(p.pos) && starters.has(p.id)
      && ((stats[p.id] && ((stats[p.id].rushAtt || 0) + (stats[p.id].rec || 0))) || 0) < 2);
    c.lowTouch = pickOf(low);
    const inj = (info.injuries || []).map((x) => ({ p: findPlayer(save, x.playerId), weeks: x.weeks })).filter((x) => x.p && x.weeks >= 2);
    c.injured = inj.length ? inj[0] : null;
    const oppT = c.opp;
    c.upset = c.won && oppT.off + oppT.def >= team.off + team.def + 1;
    const defs = healthy.filter((p) => ['DL', 'LB', 'DB'].includes(p.pos)).sort((a, b) => stars(b) - stars(a));
    c.defStar = defs[0] || null;
  }
  const next = nextUserOpponent(save);
  c.next = next;
  c.rival = !!(next && next.conf === team.conf && next.div === team.div && save.season.phase === 'regular');
  c.inRace = save.season.phase === 'regular' && save.season.week >= 11 && team.record.w >= team.record.l - 1;
  c.contractYear = pickOf(healthy.filter((p) => p.contract.years === 1 && stars(p) >= 2.5));
  c.vet = pickOf(healthy.filter((p) => p.age >= 30));
  c.rookie = pickOf(healthy.filter((p) => p.rookie));
  c.unhappy = pickOf(r.filter((p) => p.morale < 32));
  c.star = pickOf(healthy.filter((p) => stars(p) >= 3));
  c.any = pickOf(healthy);
  c.young = pickOf(healthy.filter((p) => p.age <= 25));
  c.longInjured = pickOf(r.filter((p) => p.injury && p.injury.weeks >= 2 && p.injury.weeks < 20));
  return c;
}

/**
 * Generate 0-2 events (or exactly one preseason event) and push them to save.news.
 * @returns {Object[]} new events
 */
export function generateEvents(save, rng, info = {}) {
  const ctx = newsContext(save, rng, info);
  const count = info.preseason ? 1 : rng.weightedIndex(NEWS.eventCountWeights);
  const recent = new Set((save.news || []).slice(-4).map((n) => n.template));
  let pool = TEMPLATES.map((t) => ({ t, w: t.weight(ctx) })).filter((x) => x.w > 0 && !recent.has(x.t.id));
  if (info.preseason) pool = pool.filter((x) => x.t.id === 'preseason');
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = rng.weightedIndex(pool.map((x) => x.w));
    const { t } = pool[idx];
    pool.splice(idx, 1);
    const ev = t.make(ctx);
    const event = {
      id: newId(save, 'n'),
      kind: t.kind,
      template: t.id,
      year: save.season.year,
      week: save.season.week,
      title: ev.title,
      body: ev.body,
      playerId: ev.playerId || null,
      choices: ev.choices.map((c) => ({ label: c.label, reply: c.reply, effects: c.effects })),
      resolved: false,
      choice: null,
      reply: null,
    };
    save.news.push(event);
    out.push(event);
  }
  trimNews(save);
  return out;
}

function trimNews(save) {
  const resolved = save.news.filter((n) => n.resolved);
  if (resolved.length <= NEWS.keepResolved) return;
  const drop = new Set(resolved.slice(0, resolved.length - NEWS.keepResolved).map((n) => n.id));
  save.news = save.news.filter((n) => !drop.has(n.id));
}

/** Unresolved events waiting for an answer. */
export function pendingNews(save) {
  return (save.news || []).filter((n) => !n.resolved);
}

const sign = (v) => (v > 0 ? `+${v}` : `${v}`);

/**
 * Human-readable effect lines, e.g. ["Fans +3", "J. SMITH morale -6", "CC -1"].
 * @param {NewsEffects} effects
 */
export function effectsText(save, effects) {
  const out = [];
  if (effects.fans) out.push(`Fans ${sign(effects.fans)}`);
  if (effects.teamMorale) out.push(`Team morale ${sign(effects.teamMorale)}`);
  for (const pe of effects.players || []) {
    const p = findPlayer(save, pe.id);
    if (p) out.push(`${shortName(p)} morale ${sign(pe.delta)}`);
  }
  if (effects.cc) out.push(`CC ${sign(effects.cc)}`);
  if (effects.jobSecurity) out.push(`Owner ${sign(effects.jobSecurity)}`);
  if (effects.injury) {
    const p = findPlayer(save, effects.injury.id);
    if (p) out.push(`${shortName(p)} injury ${sign(effects.injury.weeks)} wk`);
  }
  if (effects.xp) {
    const p = findPlayer(save, effects.xp.id);
    if (p) out.push(`${shortName(p)} XP ${sign(effects.xp.amount)}`);
  }
  return out;
}

const moraleMult = (p) => ((p.traits || []).includes('hothead') ? TRAIT_EFFECTS.hotheadMorale : 1);

/** Apply effects to the save; returns the effect lines. */
export function applyEffects(save, effects) {
  const lines = effectsText(save, effects);
  if (effects.fans) save.fans = clamp(save.fans + effects.fans, 0, 100);
  if (effects.teamMorale) for (const p of roster(save)) p.morale = clamp(Math.round(p.morale + effects.teamMorale * moraleMult(p)), 0, 100);
  for (const pe of effects.players || []) {
    const p = findPlayer(save, pe.id);
    if (p) p.morale = clamp(Math.round(p.morale + pe.delta * moraleMult(p)), 0, 100);
  }
  if (effects.cc) save.cc = Math.max(0, save.cc + effects.cc);
  if (effects.jobSecurity) save.jobSecurity = clamp(save.jobSecurity + effects.jobSecurity, 0, 100);
  if (effects.injury) {
    const p = findPlayer(save, effects.injury.id);
    if (p && p.injury) {
      p.injury.weeks += effects.injury.weeks;
      if (p.injury.weeks <= 0) p.injury = null;
      refreshUserRatings(save);
    }
  }
  if (effects.xp) {
    const p = findPlayer(save, effects.xp.id);
    if (p) addXp(save, p, effects.xp.amount);
  }
  return lines;
}

/** True when the choice can be afforded (CC). */
export function choiceAvailable(save, choice) {
  return !(choice.effects.cc < 0 && save.cc < -choice.effects.cc);
}

/**
 * Answer a press question / player message.
 * @returns {{ok:true, reply:string, effects:string[]} | {ok:false, reason:string, message:string}}
 */
export function resolveNews(save, newsId, choiceIndex) {
  const ev = (save.news || []).find((n) => n.id === newsId);
  if (!ev) return fail('notFound', 'News item not found.');
  if (ev.resolved) return fail('resolved', 'Already answered.');
  const c = ev.choices[choiceIndex];
  if (!c) return fail('badChoice', 'Invalid choice.');
  if (!choiceAvailable(save, c)) return fail('cc', 'Not enough CC.');
  const lines = applyEffects(save, c.effects);
  ev.resolved = true;
  ev.choice = choiceIndex;
  ev.reply = c.reply;
  trimNews(save);
  return { ok: true, reply: c.reply, effects: lines };
}

/**
 * Events stay open through the following week (so post-game questions can be answered from the
 * hub before the next kickoff), then lapse; ignored player messages cost a little morale.
 */
export function expireNews(save) {
  const key = (n) => n.year * 100 + n.week;
  const now = save.season.year * 100 + save.season.week;
  for (const n of save.news || []) {
    if (n.resolved || key(n) >= now - 1) continue;
    n.resolved = true;
    n.choice = -1;
    n.reply = 'No response.';
    if (n.kind === 'message' && n.playerId) {
      const p = findPlayer(save, n.playerId);
      if (p) p.morale = clamp(p.morale + NEWS.ignoredMessageMorale, 0, 100);
    }
  }
  trimNews(save);
}

/** League headlines for a set of played games (blowouts, upsets, streaks). */
export function leagueHeadlines(save, games) {
  const out = [];
  const others = games.filter((g) => g.played && g.home !== save.userTeamId && g.away !== save.userTeamId);
  if (!others.length) return out;
  const margin = (g) => Math.abs(g.homeScore - g.awayScore);
  const big = [...others].sort((a, b) => margin(b) - margin(a))[0];
  const w = gameWinner(big);
  if (w && margin(big) >= 24) {
    const l = w === big.home ? big.away : big.home;
    const ws = Math.max(big.homeScore, big.awayScore);
    const ls = Math.min(big.homeScore, big.awayScore);
    out.push(addHeadline(save, `${teamById(save, w).city} rout ${teamById(save, l).city} ${ws}-${ls}.`, 'result'));
  }
  for (const g of others) {
    const win = gameWinner(g);
    if (!win) continue;
    const lose = win === g.home ? g.away : g.home;
    const tw = teamById(save, win);
    const tl = teamById(save, lose);
    if (tl.off + tl.def - (tw.off + tw.def) >= 2.2) {
      out.push(addHeadline(save, `Upset! ${tw.city} stun ${tl.city} ${Math.max(g.homeScore, g.awayScore)}-${Math.min(g.homeScore, g.awayScore)}.`, 'result'));
      break;
    }
  }
  if (save.season.phase === 'regular') {
    for (const t of save.teams) {
      if (t.id === save.userTeamId) continue;
      const s = t.record.streak;
      if (s === 6 || s === 9) out.push(addHeadline(save, `${t.city} have won ${s} straight.`, 'streak'));
      else if (s === -6) out.push(addHeadline(save, `${t.city} have dropped ${-s} in a row.`, 'streak'));
    }
  }
  return out;
}
