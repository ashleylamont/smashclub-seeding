/**
 * Deterministic pseudonymisation for local development.
 *
 * The club's real data contains colleagues' names. The project's convention is
 * that real names never enter the repository — the legacy test fixtures were
 * scrubbed to game characters for the same reason. This maps each distinct real
 * identity to a stable Super Smash Bros. character name in order of first
 * appearance, so dev data and screenshots are realistic but shareable.
 */

const CHARACTERS = [
  'Mario', 'Donkey Kong', 'Link', 'Samus Aran', 'Dark Samus', 'Yoshi', 'Kirby', 'Fox McCloud',
  'Pikachu', 'Luigi', 'Ness', 'Captain Falcon', 'Jigglypuff', 'Peach', 'Daisy', 'Bowser',
  'Ice Climbers', 'Sheik', 'Zelda', 'Dr Mario', 'Pichu', 'Falco Lombardi', 'Marth', 'Lucina',
  'Young Link', 'Ganondorf', 'Mewtwo', 'Roy', 'Chrom', 'Mr Game and Watch', 'Meta Knight', 'Pit',
  'Dark Pit', 'Zero Suit Samus', 'Wario', 'Snake', 'Ike', 'Pokemon Trainer', 'Diddy Kong', 'Lucas',
  'Sonic', 'King Dedede', 'Olimar', 'Lucario', 'ROB', 'Toon Link', 'Wolf', 'Villager',
  'Mega Man', 'Wii Fit Trainer', 'Rosalina', 'Little Mac', 'Greninja', 'Palutena', 'Pac-Man',
  'Robin', 'Shulk', 'Bowser Jr', 'Duck Hunt', 'Ryu', 'Ken', 'Cloud Strife', 'Corrin', 'Bayonetta',
  'Inkling', 'Ridley', 'Simon Belmont', 'Richter', 'King K Rool', 'Isabelle', 'Incineroar',
  'Piranha Plant', 'Joker', 'Hero', 'Banjo and Kazooie', 'Terry Bogard', 'Byleth', 'Min Min',
  'Steve', 'Sephiroth', 'Pyra', 'Mythra', 'Kazuya', 'Sora', 'Waluigi', 'Krystal', 'Dixie Kong',
  'Geno', 'Shadow', 'Knuckles', 'Tails', 'Bandana Dee', 'Rayman', 'Crash Bandicoot', 'Spyro',
  'Lloyd Irving', 'Phoenix Wright', 'Ashley', 'Chibi Robo', 'Elma', 'Isaac', 'Andy',
];

export class Pseudonymiser {
  private readonly assigned = new Map<string, string>();

  /** Stable pseudonym for a real name; identical inputs always map alike. */
  get(realName: string): string {
    const key = realName.trim().toLowerCase();
    const existing = this.assigned.get(key);
    if (existing) return existing;
    const index = this.assigned.size;
    const name =
      index < CHARACTERS.length
        ? CHARACTERS[index]!
        : `${CHARACTERS[index % CHARACTERS.length]!} ${Math.floor(index / CHARACTERS.length) + 1}`;
    this.assigned.set(key, name);
    return name;
  }

  get size(): number {
    return this.assigned.size;
  }
}

/** Character-icon slug for a pseudonym, for the leaderboard avatars. */
export function characterSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
