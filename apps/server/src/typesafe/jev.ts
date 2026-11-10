export const jevModel = 'jev-1.14.0';

export async function requestJev(key: string, state: object, questions: object): Promise<unknown> {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: jevModel, state, questions }),
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
  });
  if (response.ok) return response.json();
  await response.body?.cancel();
  return null;
}
