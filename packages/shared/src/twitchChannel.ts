const channelName = /^[a-z0-9_]{1,25}$/i;
const channelUrl = /^(?:https:\/\/)?(?:www\.)?twitch\.tv\/([a-z0-9_]{1,25})\/?(?:[?#]\S*)?$/i;

/** Keep only the login. All outgoing links use the fixed Twitch origin. */
export function twitchChannel(input: string) {
  const value = input.trim();
  return (channelName.test(value) ? value : channelUrl.exec(value)?.[1])?.toLowerCase() ?? '';
}
