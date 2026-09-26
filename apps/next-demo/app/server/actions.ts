'use server';

/** A Server Action that takes `ms` on the server, as a save that waits on a database does. */
export async function save(ms: number): Promise<{ rows: number }> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { rows: 300 };
}
