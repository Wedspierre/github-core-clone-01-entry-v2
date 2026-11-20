// Entry point: start the forge on an ephemeral port, tell the trial harness
// where it lives, then wait until the harness says the trial is done.

import { start } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  if (ENV_URL === '') return;
  const response = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw new Error(`register failed: HTTP ${response.status}`);
}

async function waitForDone(): Promise<void> {
  if (ENV_URL === '') return;
  for (;;) {
    const response = await fetch(`${ENV_URL}/done`);
    if (response.ok) {
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    }
    await sleep(250);
  }
}

const port = await start(0);
await register(port);
await waitForDone();
process.exit(0);
