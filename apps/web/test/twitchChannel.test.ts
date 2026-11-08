import { describe, expect, it } from 'vitest';
import { twitchChannel } from '../src/lib/twitchChannel';

describe('Twitch channel input', () => {
  it.each([
    [' Sydney_Smash ', 'sydney_smash'],
    ['XqC', 'xqc'],
    ['https://www.TWITCH.TV/Sydney_Smash/?tt_content=link#about', 'sydney_smash'],
    ['https://twitch.tv/Sydney_Smash', 'sydney_smash'],
    ['twitch.tv/Sydney_Smash', 'sydney_smash'],
    ['sydney_smash_tournament01', 'sydney_smash_tournament01'],
  ])('normalises %s', (input, channel) => {
    expect(twitchChannel(input)).toBe(channel);
  });

  it.each([
    '',
    'sydney smash',
    'a'.repeat(26),
    'http://www.twitch.tv/sydney_smash',
    'https://www.twitch.tv:444/sydney_smash',
    'https://www.twitch.tv.evil.test/sydney_smash',
    'https://evil.test/www.twitch.tv/sydney_smash',
    'https://evil.test@www.twitch.tv/sydney_smash',
    'https://www.twitch.tv@evil.test/sydney_smash',
    'https://www.twitch.tv/videos/123',
    'https://www.twitch.tv/sydney_smash/../other',
    'https://www.twitch.tv/sydney%2fsmash',
    '//www.twitch.tv/sydney_smash',
    'javascript:alert(1)',
  ])('rejects %s', (input) => {
    expect(twitchChannel(input)).toBe('');
  });
});
