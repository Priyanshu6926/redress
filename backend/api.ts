/**
 * Redress Backend API: provides endpoints for frontend lookup, incident progress, and evidence bundles.
 */
export async function startServer(port: number = 3001) {
  console.log(`Redress API server listening on port ${port}...`);
}

if (require.main === module) {
  startServer().catch(console.error);
}

