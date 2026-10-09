// Shared JSDoc type contracts. This file has no runtime code; it documents the data that flows
// between modules. Keep it in sync with docs/ARCHITECTURE.md. Import types with
//   /** @typedef {import('../types.js').Player} Player */

/**
 * @typedef {'QB'|'RB'|'WR'|'TE'|'OL'|'DL'|'LB'|'DB'|'K'} Position
 */

/**
 * A rostered or prospective player (franchise layer). Attribute keys depend on position; see
 * src/franchise/players.js ATTRS. Raw attribute values use the scale in docs/MECHANICS.md.
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} first
 * @property {string} last
 * @property {Position} pos
 * @property {number} age
 * @property {number} number          jersey number
 * @property {Object<string, number>} attrs
 * @property {number} xp              experience toward next level
 * @property {number} level
 * @property {number} morale          0..100
 * @property {number} condition       0..100 (fatigue/fitness)
 * @property {{weeks:number, type:string}|null} injury
 * @property {{salary:number, years:number}} contract   salary in $K per season
 * @property {string[]} traits
 * @property {Object<string, number>} season   season stat totals
 * @property {Object<string, number>} career   career stat totals
 * @property {boolean} [rookie]
 */

/**
 * League team. AI teams are abstract (ratings only); the user team also has `roster`.
 * @typedef {Object} Team
 * @property {string} id
 * @property {string} city
 * @property {string} abbr
 * @property {number} conf
 * @property {number} div
 * @property {{primary:string, secondary:string, helmet:string}} colors
 * @property {number} off             offense rating (scale per MECHANICS.md)
 * @property {number} def             defense rating
 * @property {{w:number, l:number, t:number, pf:number, pa:number, divW:number, divL:number, confW:number, confL:number, streak:number}} record
 * @property {Player[]} [roster]      user team only
 */

/**
 * @typedef {Object} Game
 * @property {string} id
 * @property {number} week            1-based; playoff rounds continue numbering
 * @property {string} home            team id
 * @property {string} away            team id
 * @property {boolean} played
 * @property {number} homeScore
 * @property {number} awayScore
 * @property {boolean} [playoff]
 * @property {string} [round]         'wildcard'|'divisional'|'conference'|'final'
 * @property {boolean} [ot]
 */

/**
 * Root persisted state (localStorage). Everything the franchise needs lives here.
 * @typedef {Object} Save
 * @property {number} version
 * @property {number} seed
 * @property {number} rngState
 * @property {number} nextId
 * @property {{name:string, wins:number, losses:number, ties:number, titles:number, seasons:number}} coach
 * @property {string} userTeamId
 * @property {Team[]} teams
 * @property {{year:number, week:number, phase:'regular'|'playoffs'|'offseason', schedule:Game[]}} season
 * @property {number} cc              coaching credits
 * @property {number} salaryCap       $K
 * @property {{stadium:number, training:number, rehab:number}} facilities
 * @property {number} fans            0..100 fan support
 * @property {number} jobSecurity     0..100 owner confidence
 * @property {{oc:Object|null, dc:Object|null}} staff
 * @property {Player[]} freeAgents
 * @property {Object|null} draft
 * @property {{id:string, week:number, title:string, body:string, choices?:Object[], resolved?:boolean}[]} news
 * @property {Object[]} history
 */

/**
 * Normalized squad handed to the play engine. Built by franchise/squad.js from the user's roster
 * (star players fill their slots; empty slots get generic fillers) or from an AI team's ratings.
 * All skill values are 0..1 (0.5 = league-average starter). The engine never reads raw attrs.
 * @typedef {Object} SquadPlayer
 * @property {string|null} id         franchise Player id (null for generic fillers)
 * @property {string} name            short display name ("J. SMITH")
 * @property {number} number
 * @property {Position} pos
 * @property {number} speed
 * @property {number} strength
 * @property {number} hands           catching
 * @property {number} arm             QB arm strength
 * @property {number} accuracy        QB accuracy
 * @property {number} blocking
 * @property {number} passRush
 * @property {number} coverage
 * @property {number} tackling
 * @property {number} elusiveness
 * @property {number} kickPower
 * @property {number} kickAccuracy
 * @property {number} stamina         0..1 current energy multiplier
 */

/**
 * @typedef {Object} TeamLook
 * @property {string} abbr
 * @property {string} city
 * @property {string} primary
 * @property {string} secondary
 * @property {string} helmet
 */

/**
 * @typedef {Object} Squad
 * @property {TeamLook} look
 * @property {{QB:SquadPlayer, RB:SquadPlayer, WR:SquadPlayer[], TE:SquadPlayer, OL:SquadPlayer[], K:SquadPlayer}} offense
 * @property {{DL:SquadPlayer[], LB:SquadPlayer[], DB:SquadPlayer[]}} defense
 * @property {number} offRating        0..1 overall (for sims)
 * @property {number} defRating        0..1 overall
 */

/**
 * Input to the on-field engine for one play.
 * @typedef {Object} PlaySetup
 * @property {'scrimmage'|'fg'|'pat'|'kick_return'} kind   (2-pt try = 'scrimmage' from the 2 with twoPoint:true)
 * @property {boolean} [twoPoint]
 * @property {number} losX            world x of line of scrimmage (10 = own goal line, 110 = opp goal)
 * @property {number} firstDownX      world x of line to gain (>=110 means goal to go)
 * @property {number} hashY           world y where the ball is spotted
 * @property {number} down            1..4 (informational for AI aggression)
 * @property {Squad} offense          user team
 * @property {Squad} defense          opponent
 * @property {number} difficulty      0 easy, 1 normal, 2 hard
 * @property {{x:number, y:number}} wind   mph components (+x = toward opponent goal)
 * @property {number} seed            rng seed for this play
 * @property {number} [clockLeft]     seconds left in the quarter (for UI only)
 * @property {'clear'|'rain'|'snow'} weather
 * @property {number} difficultyStep  1..16 internal difficulty (MECHANICS 5.5)
 * @property {number} quarter         1..4 (5 = OT); kicker/QB fatigue scales with game progress
 * @property {number} gameProgress    0..1 fraction of the game elapsed (stamina fade)
 */

/**
 * Engine output when a play ends.
 * @typedef {Object} PlayResult
 * @property {'tackle'|'oob'|'incomplete'|'td'|'interception'|'sack'|'safety'|'fumble'|'fg_good'|'fg_miss'|'pat_good'|'pat_miss'|'kick_blocked'|'touchback'|'return_td'} outcome
 * @property {number} endX            world x where the next play is spotted (offense perspective)
 * @property {number} endY            world y of the dead ball (for hash selection)
 * @property {number} yards           net yards relative to the line of scrimmage
 * @property {number} elapsed         seconds of play time
 * @property {boolean} clockStops     incomplete / out of bounds / score / turnover
 * @property {boolean} turnover
 * @property {number} [turnoverX]     for interceptions: world x where the defense takes over (offense frame)
 * @property {'pass'|'run'|'kick'|'return'} type
 * @property {string|null} passer     franchise ids (null for fillers)
 * @property {string|null} receiver
 * @property {string|null} rusher
 * @property {string|null} kicker
 * @property {Object<string, Object<string, number>>} stats   per franchise player id: {passAtt, passCmp, passYds, passTd, int, rushAtt, rushYds, rushTd, rec, recYds, recTd, fgAtt, fgMade, patAtt, patMade, sacked}
 * @property {string[]} highlights    short text lines for the play-by-play ticker
 */

/**
 * Result of a whole match, consumed by franchise.applyGameResult().
 * @typedef {Object} MatchResult
 * @property {string} gameId
 * @property {number} userScore
 * @property {number} oppScore
 * @property {boolean} ot
 * @property {Object<string, Object<string, number>>} stats   per user player id
 * @property {{quarter:number, text:string, team:'user'|'opp'}[]} log
 */

export {};
