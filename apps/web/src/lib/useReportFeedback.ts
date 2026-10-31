import { useState } from 'react';

type Feedback = {
  identity: string;
  pending: boolean;
  message: string;
  error: string;
  sent: 'approved' | 'pending' | null;
};
/** Scores are drafts; response feedback belongs only to the credential that sent it. */
export function useReportFeedback(identity: string) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const current = feedback?.identity === identity ? feedback : null;
  const update = (value: Partial<Omit<Feedback, 'identity'>>) => {
    setFeedback((previous) =>
      previous?.identity === identity ? { ...previous, ...value } : previous,
    );
  };
  return {
    pending: current?.pending ?? false,
    message: current?.message ?? '',
    error: current?.error ?? '',
    sent: current?.sent ?? null,
    begin: () => setFeedback({ identity, pending: true, message: '', error: '', sent: null }),
    update,
  };
}
