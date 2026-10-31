import type { Env } from './env.ts';
import { AppError } from './errors.ts';

/** KILL_SWITCH=1 in the environment halts every model call. (Settings-table switch is the stretch admin endpoint.) */
export async function isKilled(env: Pick<Env, 'KILL_SWITCH' | 'DB'>): Promise<boolean> {
  if (env.KILL_SWITCH === '1') return true;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'kill_switch'").first<{ value: string }>();
  return row?.value === '1';
}

export async function assertNotKilled(env: Pick<Env, 'KILL_SWITCH' | 'DB'>): Promise<void> {
  if (await isKilled(env)) throw new AppError('kill_switch_on');
}
