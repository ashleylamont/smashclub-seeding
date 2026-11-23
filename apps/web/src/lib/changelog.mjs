const releaseVersion = /^(\d+\.\d+\.\d+)\n/;
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
      const version = index > 0 && releaseVersion.exec(section)?.[0];
      return version
        ? `${version}\n${groupReleaseNotes(section.slice(version.length))}\n\n`
        : section;
    })
    .join('## ');
}

function releaseHighlights(notes) {
  const leadsByGroup = new Map(releaseGroupHeadings.map((heading) => [heading, []]));
  for (const lead of notes.match(/^- .+$/gm) ?? []) {
    const kind = categoryPrefix.exec(lead)?.[1];
    const heading = groups.find(({ categories }) => categories.includes(kind))?.heading;
    const summary = formatEntry(lead, [], kind).split('\n')[0];
    leadsByGroup.get(heading ?? otherChanges).push(summary);
  }
  // Use the same public-first ordering as the full notes. A maintenance-only
  // release still has a specific change the reader can see.
  const [features, fixes, ...other] = leadsByGroup.values();
  const highlights = [...features, ...fixes].slice(0, 2);
  return (highlights.length ? highlights : other.flat().slice(0, 1)).join('\n');
}

export function readChangelog(markdown) {
  const releases = [];
  const archive = [];
  const anchorCounts = new Map();
  for (const section of markdown.split(/^## /m).slice(1)) {
    const match = releaseVersion.exec(section);
    if (!match) {
      archive.push(`## ${section}`);
      continue;
    }
    const [, version] = match;
    const notes = section.slice(match[0].length).trim();
    const firstTier = releaseTier.exec(notes);
    const introduction = firstTier ? notes.slice(0, firstTier.index).trim() : '';
    const details = firstTier ? notes.slice(firstTier.index) : notes;
    // Match the existing Markdown heading IDs, including duplicate slug suffixes.
    const baseAnchor = version.replaceAll('.', '');
    const count = anchorCounts.get(baseAnchor) ?? 0;
    anchorCounts.set(baseAnchor, count + 1);
    releases.push({
      version,
      anchor: count ? `${baseAnchor}-${count}` : baseAnchor,
      highlights: introduction || releaseHighlights(details),
      notes: groupReleaseNotes(details),
    });
  }
  return { releases, archive: archive.join('') };
}
