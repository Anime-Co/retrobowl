// Name pools for generated players, coaches and record-book legends. Assembled from common
// given names and surnames; any resemblance to a real athlete is coincidental. Also a jersey
// number picker with conventional ranges per position.

export const FIRST_NAMES = [
  'Aaron', 'Adam', 'Adrian', 'Alan', 'Albert', 'Alex', 'Andre', 'Andrew', 'Angelo', 'Anthony',
  'Antonio', 'Arthur', 'Austin', 'Avery', 'Barry', 'Ben', 'Blake', 'Bobby', 'Brad', 'Brandon',
  'Brent', 'Brett', 'Brian', 'Bruce', 'Bryce', 'Byron', 'Caleb', 'Calvin', 'Cameron', 'Carl',
  'Carlos', 'Carter', 'Casey', 'Cedric', 'Chad', 'Charles', 'Chase', 'Chris', 'Clay', 'Clint',
  'Cody', 'Colby', 'Cole', 'Colin', 'Connor', 'Corey', 'Craig', 'Curtis', 'Dale', 'Dalton',
  'Damon', 'Dan', 'Dante', 'Darius', 'Darnell', 'Darren', 'Dave', 'Dean', 'Derek', 'Devin',
  'Dexter', 'Dominic', 'Don', 'Donovan', 'Drew', 'Dustin', 'Dwayne', 'Dylan', 'Eddie', 'Edgar',
  'Eli', 'Elijah', 'Elliott', 'Emmett', 'Eric', 'Ethan', 'Evan', 'Felix', 'Frank', 'Fred',
  'Gabe', 'Garrett', 'Gary', 'Gavin', 'Glen', 'Grant', 'Greg', 'Hank', 'Harold', 'Hector',
  'Henry', 'Hugo', 'Ian', 'Isaac', 'Isaiah', 'Ivan', 'Jack', 'Jackson', 'Jake', 'Jalen',
  'Jamal', 'James', 'Jared', 'Jason', 'Javier', 'Jay', 'Jeff', 'Jerome', 'Jesse', 'Joel',
  'Joey', 'Johnny', 'Jon', 'Jordan', 'Jorge', 'Joseph', 'Josh', 'Julian', 'Justin', 'Kai',
  'Keith', 'Ken', 'Kendall', 'Kevin', 'Kyle', 'Lamar', 'Lance', 'Larry', 'Lawrence', 'Leon',
  'Leo', 'Levi', 'Logan', 'Lou', 'Lucas', 'Luis', 'Luke', 'Malik', 'Marcus', 'Mario',
  'Mark', 'Marvin', 'Mason', 'Matt', 'Max', 'Micah', 'Miguel', 'Mike', 'Miles', 'Mitch',
  'Nate', 'Neil', 'Nick', 'Noah', 'Nolan', 'Oliver', 'Omar', 'Oscar', 'Owen', 'Parker',
  'Pat', 'Paul', 'Pedro', 'Pete', 'Phil', 'Quentin', 'Quincy', 'Rafael', 'Ray', 'Reggie',
  'Rex', 'Ricky', 'Riley', 'Rob', 'Rodney', 'Roman', 'Ron', 'Ross', 'Roy', 'Russell',
  'Ryan', 'Sam', 'Scott', 'Sean', 'Seth', 'Shane', 'Shawn', 'Simon', 'Spencer', 'Stan',
  'Steve', 'Terrell', 'Terry', 'Theo', 'Tim', 'Toby', 'Todd', 'Tom', 'Tony', 'Travis',
  'Trent', 'Trevor', 'Troy', 'Tyler', 'Tyrone', 'Vance', 'Victor', 'Vince', 'Wade', 'Walter',
  'Warren', 'Wayne', 'Wes', 'Will', 'Xavier', 'Zach', 'Zane',
];

export const LAST_NAMES = [
  'Adams', 'Alexander', 'Allen', 'Alvarez', 'Anderson', 'Armstrong', 'Bailey', 'Baker', 'Banks', 'Barnes',
  'Bell', 'Bennett', 'Black', 'Boyd', 'Bradley', 'Brooks', 'Brown', 'Bryant', 'Burke', 'Burns',
  'Butler', 'Campbell', 'Carpenter', 'Carroll', 'Carter', 'Castro', 'Chapman', 'Clark', 'Cole', 'Coleman',
  'Collins', 'Cook', 'Cooper', 'Cox', 'Crawford', 'Cruz', 'Cunningham', 'Daniels', 'Davis', 'Dawson',
  'Day', 'Diaz', 'Dixon', 'Duncan', 'Dunn', 'Edwards', 'Elliott', 'Ellis', 'Evans', 'Ferguson',
  'Fields', 'Fisher', 'Fleming', 'Flores', 'Ford', 'Foster', 'Fox', 'Franklin', 'Freeman', 'Garcia',
  'Gardner', 'Gibson', 'Gomez', 'Gonzalez', 'Gordon', 'Graham', 'Grant', 'Gray', 'Green', 'Griffin',
  'Hall', 'Hamilton', 'Hansen', 'Hardy', 'Harper', 'Harris', 'Hart', 'Hawkins', 'Hayes', 'Henderson',
  'Hicks', 'Hill', 'Holland', 'Holmes', 'Howard', 'Hudson', 'Hughes', 'Hunt', 'Hunter', 'Jackson',
  'James', 'Jenkins', 'Jensen', 'Johnson', 'Jones', 'Jordan', 'Keller', 'Kelly', 'Kennedy', 'Kim',
  'King', 'Knight', 'Lane', 'Lawson', 'Lee', 'Lewis', 'Little', 'Long', 'Lopez', 'Lucas',
  'Lynch', 'Marshall', 'Martin', 'Martinez', 'Mason', 'Matthews', 'McCoy', 'McDonald', 'Meyer', 'Miller',
  'Mills', 'Mitchell', 'Moore', 'Morales', 'Morgan', 'Morris', 'Murphy', 'Murray', 'Myers', 'Nelson',
  'Newman', 'Nichols', 'Norris', 'Olson', 'Ortiz', 'Owens', 'Palmer', 'Parker', 'Patel', 'Patterson',
  'Payne', 'Pearson', 'Perez', 'Perry', 'Peters', 'Phillips', 'Pierce', 'Porter', 'Powell', 'Price',
  'Quinn', 'Ramirez', 'Ramos', 'Reed', 'Reyes', 'Reynolds', 'Rhodes', 'Rice', 'Richards', 'Riley',
  'Rivera', 'Roberts', 'Robinson', 'Rodriguez', 'Rogers', 'Ross', 'Russell', 'Ryan', 'Sanchez', 'Sanders',
  'Schmidt', 'Scott', 'Shaw', 'Simmons', 'Simpson', 'Sims', 'Smith', 'Snyder', 'Spencer', 'Stanley',
  'Stephens', 'Stevens', 'Stewart', 'Stone', 'Sullivan', 'Taylor', 'Thomas', 'Thompson', 'Torres', 'Tucker',
  'Turner', 'Wagner', 'Walker', 'Wallace', 'Walsh', 'Ward', 'Warren', 'Washington', 'Watkins', 'Watson',
  'Weaver', 'Webb', 'Wells', 'West', 'Wheeler', 'White', 'Williams', 'Willis', 'Wilson', 'Wood',
  'Woods', 'Wright', 'Young',
];

/** Conventional jersey ranges per position (inclusive). */
export const JERSEY_RANGES = {
  QB: [[1, 19]],
  RB: [[20, 49]],
  WR: [[10, 19], [80, 89]],
  TE: [[80, 89], [40, 49]],
  OL: [[50, 79]],
  DL: [[90, 99], [50, 79]],
  LB: [[40, 59], [90, 99]],
  DB: [[20, 49]],
  K: [[1, 19]],
};

/**
 * Pick a jersey number for a position, avoiding numbers already taken.
 * @param {import('../core/rng.js').Rng} rng
 * @param {string} pos
 * @param {Iterable<number>} [taken]
 * @returns {number}
 */
export function pickJersey(rng, pos, taken = []) {
  const used = taken instanceof Set ? taken : new Set(taken);
  const ranges = JERSEY_RANGES[pos] || [[1, 99]];
  for (const [lo, hi] of ranges) {
    const free = [];
    for (let n = lo; n <= hi; n++) if (!used.has(n)) free.push(n);
    if (free.length) return rng.pick(free);
  }
  const any = [];
  for (let n = 1; n <= 99; n++) if (!used.has(n)) any.push(n);
  return any.length ? rng.pick(any) : rng.int(1, 99);
}

/** Random {first, last} avoiding full names in `takenNames` (a Set of "First Last"). */
export function pickName(rng, takenNames = null) {
  for (let i = 0; i < 20; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    if (!takenNames || !takenNames.has(`${first} ${last}`)) return { first, last };
  }
  return { first: rng.pick(FIRST_NAMES), last: rng.pick(LAST_NAMES) };
}
