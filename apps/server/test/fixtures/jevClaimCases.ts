type Case = {
  label: string;
  autoApprove: boolean;
  state: {
    account: { name: string; email: string };
    profile: { name: string; company: string | null };
  };
  mockConfidence: number;
  mockProbabilities: [number, number, number, number, number];
};

export const jevClaimCases: Case[] = [
  {
    label: 'Exact full name with a shortened personal email handle',
    autoApprove: true,
    state: {
      account: { name: 'Nora Vale', email: 'nvale52@personal.example' },
      profile: { name: 'Nora Vale', company: null },
    },
    mockConfidence: 0.91,
    mockProbabilities: [0, 0, 0, 0.05, 0.95],
  },
  {
    label: 'Gaming handle with the full player name in the mailbox',
    autoApprove: true,
    state: {
      account: { name: 'OrbitInASock', email: 'devon.raine83@personal.example' },
      profile: { name: 'Devon Raine', company: null },
    },
    mockConfidence: 0.84,
    mockProbabilities: [0, 0, 0, 0.1, 0.9],
  },
  {
    label: 'Initial in the profile corroborated by the account and mailbox',
    autoApprove: true,
    state: {
      account: { name: 'Mira Keane', email: 'mkeane17@personal.example' },
      profile: { name: 'Mira K', company: 'Example Studio' },
    },
    mockConfidence: 0.83,
    mockProbabilities: [0, 0, 0, 0.1, 0.9],
  },
  {
    label: 'Distinctive nickname backed by the same name in a custom domain mailbox',
    autoApprove: true,
    state: {
      account: { name: 'Pippinplayspools', email: 'pippin@tilt.example' },
      profile: { name: 'Pippin', company: null },
    },
    mockConfidence: 0.85,
    mockProbabilities: [0, 0, 0, 0.09, 0.91],
  },
  {
    label: 'Shared given name and a short handle with no surname evidence',
    autoApprove: false,
    state: {
      account: { name: 'Sam', email: 'samster81@personal.example' },
      profile: { name: 'Sam Voss', company: null },
    },
    mockConfidence: 0.81,
    mockProbabilities: [0, 0, 0.88, 0.12, 0],
  },
  {
    label: 'Numbered profile with an ambiguous first name and initial',
    autoApprove: false,
    state: {
      account: { name: 'Jamie Patel', email: 'jpatel17@personal.example' },
      profile: { name: 'Jamie P (2)', company: 'Example Studio' },
    },
    mockConfidence: 0.66,
    mockProbabilities: [0, 0, 0.04, 0.15, 0.81],
  },
  {
    label: 'Common first name and contradictory surnames',
    autoApprove: false,
    state: {
      account: { name: 'Nora Bell', email: 'nbell52@personal.example' },
      profile: { name: 'Nora Vale', company: null },
    },
    mockConfidence: 0.91,
    mockProbabilities: [0.95, 0.05, 0, 0, 0],
  },
  {
    label: 'Same company with otherwise unrelated account details',
    autoApprove: false,
    state: {
      account: { name: 'Ellis Hart', email: 'ehart@example.com' },
      profile: { name: 'Devon Raine', company: 'Example' },
    },
    mockConfidence: 0.86,
    mockProbabilities: [0.08, 0.92, 0, 0, 0],
  },
];
