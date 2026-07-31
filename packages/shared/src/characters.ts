/**
 * The Ultimate fighter roster, shared by the server (validating what gets
 * stored) and the web app (the picker and the head icons next to a player).
 *
 * One list in one place: a slug that never changes is what the database holds
 * and what names the icon file, so renaming a display label never orphans
 * stored rows or breaks an image path.
 *
 * Head icons live at `/characters/<slug>.png` in the web app's public
 * directory; see tools/fetch-character-icons. The UI degrades to a text chip
 * when an icon is missing, so an incomplete icon set is never a broken page.
 */

export interface Character {
  /** Stable identifier — stored in the DB and used as the icon filename. */
  slug: string;
  /** Display label. */
  name: string;
  /**
   * Alternate spellings the icon fetcher matches on, for fighters whose wiki
   * file name differs from their display name.
   */
  aka?: string[];
}

/**
 * Roster order follows the in-game fighter numbering, so the picker reads the
 * way the character select screen does rather than alphabetically — players
 * look for their main by position, not by spelling.
 *
 * Transformation fighters (Pokémon Trainer, Pyra/Mythra) appear both combined
 * and individually: "I main PT" and "I main Charizard" are both things people
 * say, and each has its own head icon.
 */
export const CHARACTERS: Character[] = [
  { slug: 'mario', name: 'Mario' },
  { slug: 'donkey-kong', name: 'Donkey Kong' },
  { slug: 'link', name: 'Link' },
  { slug: 'samus', name: 'Samus' },
  { slug: 'dark-samus', name: 'Dark Samus' },
  { slug: 'yoshi', name: 'Yoshi' },
  { slug: 'kirby', name: 'Kirby' },
  { slug: 'fox', name: 'Fox' },
  { slug: 'pikachu', name: 'Pikachu' },
  { slug: 'luigi', name: 'Luigi' },
  { slug: 'ness', name: 'Ness' },
  { slug: 'captain-falcon', name: 'Captain Falcon' },
  { slug: 'jigglypuff', name: 'Jigglypuff' },
  { slug: 'peach', name: 'Peach' },
  { slug: 'daisy', name: 'Daisy' },
  { slug: 'bowser', name: 'Bowser' },
  { slug: 'ice-climbers', name: 'Ice Climbers' },
  { slug: 'sheik', name: 'Sheik' },
  { slug: 'zelda', name: 'Zelda' },
  { slug: 'dr-mario', name: 'Dr. Mario', aka: ['Dr Mario', 'DrMario'] },
  { slug: 'pichu', name: 'Pichu' },
  { slug: 'falco', name: 'Falco' },
  { slug: 'marth', name: 'Marth' },
  { slug: 'lucina', name: 'Lucina' },
  { slug: 'young-link', name: 'Young Link' },
  { slug: 'ganondorf', name: 'Ganondorf' },
  { slug: 'mewtwo', name: 'Mewtwo' },
  { slug: 'roy', name: 'Roy' },
  { slug: 'chrom', name: 'Chrom' },
  { slug: 'mr-game-and-watch', name: 'Mr. Game & Watch', aka: ['Mr Game & Watch', 'GameAndWatch', 'Game & Watch'] },
  { slug: 'meta-knight', name: 'Meta Knight' },
  { slug: 'pit', name: 'Pit' },
  { slug: 'dark-pit', name: 'Dark Pit' },
  { slug: 'zero-suit-samus', name: 'Zero Suit Samus' },
  { slug: 'wario', name: 'Wario' },
  { slug: 'snake', name: 'Snake' },
  { slug: 'ike', name: 'Ike' },
  { slug: 'pokemon-trainer', name: 'Pokémon Trainer', aka: ['Pokemon Trainer', 'PokemonTrainer'] },
  { slug: 'squirtle', name: 'Squirtle' },
  { slug: 'ivysaur', name: 'Ivysaur' },
  { slug: 'charizard', name: 'Charizard' },
  { slug: 'diddy-kong', name: 'Diddy Kong' },
  { slug: 'lucas', name: 'Lucas' },
  { slug: 'sonic', name: 'Sonic' },
  { slug: 'king-dedede', name: 'King Dedede' },
  { slug: 'olimar', name: 'Olimar' },
  { slug: 'lucario', name: 'Lucario' },
  { slug: 'rob', name: 'R.O.B.', aka: ['ROB', 'R.O.B'] },
  { slug: 'toon-link', name: 'Toon Link' },
  { slug: 'wolf', name: 'Wolf' },
  { slug: 'villager', name: 'Villager' },
  { slug: 'mega-man', name: 'Mega Man', aka: ['Megaman'] },
  { slug: 'wii-fit-trainer', name: 'Wii Fit Trainer' },
  { slug: 'rosalina-and-luma', name: 'Rosalina & Luma', aka: ['Rosalina', 'RosalinaAndLuma', 'Rosalina and Luma'] },
  { slug: 'little-mac', name: 'Little Mac' },
  { slug: 'greninja', name: 'Greninja' },
  { slug: 'mii-brawler', name: 'Mii Brawler' },
  { slug: 'mii-swordfighter', name: 'Mii Swordfighter' },
  { slug: 'mii-gunner', name: 'Mii Gunner' },
  { slug: 'palutena', name: 'Palutena' },
  { slug: 'pac-man', name: 'Pac-Man', aka: ['PacMan', 'Pac Man'] },
  { slug: 'robin', name: 'Robin' },
  { slug: 'shulk', name: 'Shulk' },
  { slug: 'bowser-jr', name: 'Bowser Jr.', aka: ['Bowser Jr', 'BowserJr'] },
  { slug: 'duck-hunt', name: 'Duck Hunt' },
  { slug: 'ryu', name: 'Ryu' },
  { slug: 'ken', name: 'Ken' },
  { slug: 'cloud', name: 'Cloud' },
  { slug: 'corrin', name: 'Corrin' },
  { slug: 'bayonetta', name: 'Bayonetta' },
  { slug: 'inkling', name: 'Inkling' },
  { slug: 'ridley', name: 'Ridley' },
  { slug: 'simon', name: 'Simon' },
  { slug: 'richter', name: 'Richter' },
  { slug: 'king-k-rool', name: 'King K. Rool', aka: ['King K Rool', 'KingKRool'] },
  { slug: 'isabelle', name: 'Isabelle' },
  { slug: 'incineroar', name: 'Incineroar' },
  { slug: 'piranha-plant', name: 'Piranha Plant' },
  { slug: 'joker', name: 'Joker' },
  { slug: 'hero', name: 'Hero' },
  { slug: 'banjo-and-kazooie', name: 'Banjo & Kazooie', aka: ['Banjo', 'BanjoAndKazooie', 'Banjo and Kazooie'] },
  { slug: 'terry', name: 'Terry' },
  { slug: 'byleth', name: 'Byleth' },
  { slug: 'min-min', name: 'Min Min' },
  { slug: 'steve', name: 'Steve' },
  { slug: 'sephiroth', name: 'Sephiroth' },
  { slug: 'pyra', name: 'Pyra' },
  { slug: 'mythra', name: 'Mythra' },
  { slug: 'kazuya', name: 'Kazuya' },
  { slug: 'sora', name: 'Sora' },
];

/** How many characters one player may pin. Keeps the leaderboard row legible. */
export const MAX_CHARACTERS_PER_PLAYER = 4;

const BY_SLUG = new Map(CHARACTERS.map((character) => [character.slug, character]));

export function isCharacterSlug(slug: string): boolean {
  return BY_SLUG.has(slug);
}

export function characterBySlug(slug: string): Character | undefined {
  return BY_SLUG.get(slug);
}

/** Display label for a slug, falling back to the raw slug for unknown values. */
export function characterName(slug: string): string {
  return BY_SLUG.get(slug)?.name ?? slug;
}
