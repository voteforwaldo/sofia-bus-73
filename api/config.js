export default async function handler(_req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({
    sentryDsn: process.env.SENTRY_DSN ?? null,
    productionUrl: "https://sofia-bus-73.vercel.app",
  });
}
