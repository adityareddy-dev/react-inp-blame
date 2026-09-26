/** A route handler that takes `?ms=` on the server before it answers, as a slow API does. */
export async function GET(request: Request): Promise<Response> {
  const ms = Number(new URL(request.url).searchParams.get('ms') ?? 400);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return Response.json({ rows: 300 });
}
