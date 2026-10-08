// League template: 32 city-only teams with ORIGINAL colour schemes (no real club names/branding).
// Two conferences x four divisions x four teams. `primary` = jersey, `secondary` = trim/numbers,
// `helmet` = helmet shell. Colours are picked for contrast on green turf.

export const CONFERENCES = ['Atlantic', 'Pacific'];
export const DIVISIONS = ['North', 'East', 'South', 'West'];

/** @type {{id:string, city:string, abbr:string, conf:number, div:number, primary:string, secondary:string, helmet:string}[]} */
export const TEAM_TEMPLATES = [
  // Atlantic North
  { id: 'BOS', city: 'Boston', abbr: 'BOS', conf: 0, div: 0, primary: '#1e6b3a', secondary: '#f2e6c8', helmet: '#f2e6c8' },
  { id: 'NYC', city: 'New York', abbr: 'NY', conf: 0, div: 0, primary: '#e2552a', secondary: '#1a1a1a', helmet: '#1a1a1a' },
  { id: 'BUF', city: 'Buffalo', abbr: 'BUF', conf: 0, div: 0, primary: '#6b2fa0', secondary: '#f5c518', helmet: '#f5c518' },
  { id: 'PIT', city: 'Pittsburgh', abbr: 'PIT', conf: 0, div: 0, primary: '#3f8fd0', secondary: '#ffffff', helmet: '#ffffff' },
  // Atlantic East
  { id: 'PHI', city: 'Philadelphia', abbr: 'PHI', conf: 0, div: 1, primary: '#b3122e', secondary: '#f0f0f0', helmet: '#b3122e' },
  { id: 'BAL', city: 'Baltimore', abbr: 'BAL', conf: 0, div: 1, primary: '#f28c28', secondary: '#2b2b6b', helmet: '#2b2b6b' },
  { id: 'WAS', city: 'Washington', abbr: 'WAS', conf: 0, div: 1, primary: '#3a56c5', secondary: '#e8e8e8', helmet: '#e8e8e8' },
  { id: 'CHA', city: 'Charlotte', abbr: 'CHA', conf: 0, div: 1, primary: '#00a19a', secondary: '#1b1b1b', helmet: '#1b1b1b' },
  // Atlantic South
  { id: 'MIA', city: 'Miami', abbr: 'MIA', conf: 0, div: 2, primary: '#d6336c', secondary: '#ffd23f', helmet: '#ffd23f' },
  { id: 'ATL', city: 'Atlanta', abbr: 'ATL', conf: 0, div: 2, primary: '#2e8b3a', secondary: '#c8c8c8', helmet: '#c8c8c8' },
  { id: 'TPA', city: 'Tampa', abbr: 'TPA', conf: 0, div: 2, primary: '#ff7a1a', secondary: '#0b4d40', helmet: '#0b4d40' },
  { id: 'NOL', city: 'New Orleans', abbr: 'NO', conf: 0, div: 2, primary: '#5a1f9c', secondary: '#9be05a', helmet: '#9be05a' },
  // Atlantic West
  { id: 'CHI', city: 'Chicago', abbr: 'CHI', conf: 0, div: 3, primary: '#c62828', secondary: '#202020', helmet: '#202020' },
  { id: 'DET', city: 'Detroit', abbr: 'DET', conf: 0, div: 3, primary: '#455a64', secondary: '#ff7043', helmet: '#ff7043' },
  { id: 'CLE', city: 'Cleveland', abbr: 'CLE', conf: 0, div: 3, primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' },
  { id: 'IND', city: 'Indianapolis', abbr: 'IND', conf: 0, div: 3, primary: '#7a5230', secondary: '#ffd59a', helmet: '#ffd59a' },
  // Pacific North
  { id: 'SEA', city: 'Seattle', abbr: 'SEA', conf: 1, div: 0, primary: '#8a1c3c', secondary: '#f3d9a4', helmet: '#f3d9a4' },
  { id: 'POR', city: 'Portland', abbr: 'POR', conf: 1, div: 0, primary: '#2d6a4f', secondary: '#e9c46a', helmet: '#2d6a4f' },
  { id: 'MIN', city: 'Minneapolis', abbr: 'MIN', conf: 1, div: 0, primary: '#1d3557', secondary: '#a8dadc', helmet: '#a8dadc' },
  { id: 'DEN', city: 'Denver', abbr: 'DEN', conf: 1, div: 0, primary: '#3d9970', secondary: '#111111', helmet: '#111111' },
  // Pacific East
  { id: 'KCY', city: 'Kansas City', abbr: 'KC', conf: 1, div: 1, primary: '#2a6fdb', secondary: '#ffb703', helmet: '#ffb703' },
  { id: 'STL', city: 'St. Louis', abbr: 'STL', conf: 1, div: 1, primary: '#9b2226', secondary: '#e9d8a6', helmet: '#e9d8a6' },
  { id: 'NSH', city: 'Nashville', abbr: 'NSH', conf: 1, div: 1, primary: '#f4a261', secondary: '#264653', helmet: '#264653' },
  { id: 'MEM', city: 'Memphis', abbr: 'MEM', conf: 1, div: 1, primary: '#6c757d', secondary: '#ff006e', helmet: '#ff006e' },
  // Pacific South
  { id: 'DAL', city: 'Dallas', abbr: 'DAL', conf: 1, div: 2, primary: '#c9184a', secondary: '#ffffff', helmet: '#ffffff' },
  { id: 'HOU', city: 'Houston', abbr: 'HOU', conf: 1, div: 2, primary: '#14213d', secondary: '#fca311', helmet: '#fca311' },
  { id: 'SAT', city: 'San Antonio', abbr: 'SA', conf: 1, div: 2, primary: '#7b2cbf', secondary: '#e0e0e0', helmet: '#e0e0e0' },
  { id: 'OKC', city: 'Oklahoma City', abbr: 'OKC', conf: 1, div: 2, primary: '#e85d04', secondary: '#03045e', helmet: '#e85d04' },
  // Pacific West
  { id: 'LAX', city: 'Los Angeles', abbr: 'LA', conf: 1, div: 3, primary: '#ffbe0b', secondary: '#3a0ca3', helmet: '#3a0ca3' },
  { id: 'SFO', city: 'San Francisco', abbr: 'SF', conf: 1, div: 3, primary: '#006d77', secondary: '#ffddd2', helmet: '#ffddd2' },
  { id: 'SDG', city: 'San Diego', abbr: 'SD', conf: 1, div: 3, primary: '#48cae4', secondary: '#023e8a', helmet: '#023e8a' },
  { id: 'PHX', city: 'Phoenix', abbr: 'PHX', conf: 1, div: 3, primary: '#d00000', secondary: '#ffba08', helmet: '#ffba08' },
];

export function teamTemplate(id) {
  return TEAM_TEMPLATES.find((t) => t.id === id) || null;
}
