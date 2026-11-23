const releaseTier = /^### (?:Major|Minor|Patch) Changes[ \t]*$/m;
const categoryPrefix = /^- (?:\d{1,2} [A-Za-z]+ \d{4} · )?\*\*([^*]+)\*\* · /;
const generatedSource =
  /^- (\d{1,2} [A-Za-z]+ \d{4}) · (.+?) ((?:\[#\d+\]\(https:\/\/github\.com\/[^)]+\/pull\/\d+\) · )?\[build [\da-f]{7}\]\(https:\/\/github\.com\/[^)]+\/commit\/[\da-f]{40}\))$/;

const otherChanges = 'Other changes';
const groups = [
  { heading: 'New and improved', categories: ['Milestone', 'Feature', 'Improvement'] },
  { heading: 'Fixes', categories: ['Fix'] },
  { heading: otherChanges, categories: [] },
  { heading: 'Maintenance', categories: ['Maintenance'] },
];
export const releaseGroupHeadings = groups.map(({ heading }) => heading);

function formatEntry(first, details, redundantCategory) {
  const source = generatedSource.exec(first);
  const lead = source ? `- ${source[2]}` : first;
  const summary = redundantCategory ? lead.replace(`**${redundantCategory}** · `, '') : lead;
  const provenance = source ? ['', `  *${source[1]} · ${source[3]}*`] : [];
  return [summary, ...details, ...provenance].join('\n');
}

// Changesets writes one top-level bullet per note and indents its continuation
// Markdown. If a release has a different structure, keep its original layout.
export function groupReleaseNotes(markdown) {
  const notes = markdown.trim();
  const [intro, ...tiers] = notes.split(releaseTier);
  const entriesByGroup = new Map(releaseGroupHeadings.map((heading) => [heading, []]));
  for (const tier of tiers) {
    for (const entry of tier.trim().split(/(?=^- )/m)) {
      const lines = entry.trimEnd().split('\n');
      const [first, ...details] = lines;
      if (
        !first.startsWith('- ') ||
        details.some((line) => line.trim() && !/^(?: {2}|\t)/.test(line))
      ) {
        return notes;
      }
      const kind = categoryPrefix.exec(first)?.[1];
      const group = groups.find(({ categories }) => categories.includes(kind));
      const redundantCategory = group?.categories.length === 1 ? kind : undefined;
      entriesByGroup
        .get(group?.heading ?? otherChanges)
        .push(formatEntry(first, details, redundantCategory));
    }
  }
  if (![...entriesByGroup].some(([heading, entries]) => heading !== otherChanges && entries.length))
    return notes;

  const sections = [intro.trim()];
  for (const [heading, entries] of entriesByGroup) {
    if (entries.length) sections.push(`### ${heading}\n\n${entries.join('\n\n')}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

export function formatChangelog(markdown) {
  return markdown
    .split(/^## /m)
    .map((section, index) => {
      const version = index > 0 && /^\d+\.\d+\.\d+\n/.exec(section)?.[0];
      return version
        ? `${version}\n${groupReleaseNotes(section.slice(version.length))}\n\n`
        : section;
    })
    .join('## ');
}
