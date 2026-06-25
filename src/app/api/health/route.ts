export async function GET() {
  return Response.json({
    ok: true,
    app: "plusim",
    ts: new Date().toISOString(),
  });
}
