/**
 * Send the signed application to Apple, and wait for it to come back stapled.
 *
 * Runs only when the credentials are actually present. A local build with no
 * Apple account should produce a working application, not an error -- so this
 * says plainly that it is skipping and why, rather than failing the build or,
 * worse, succeeding quietly and leaving somebody to discover on another
 * machine that Gatekeeper will not open it.
 *
 * The credentials are the developer's and are read from the environment. They
 * are never written to a file here, never logged, and never committed.
 * Either:
 *   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER   (an App Store Connect key)
 * or:
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 */
exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") {
    return;
  }

  const env = process.env;
  const byKey =
    env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
      ? {
          appleApiKey: env.APPLE_API_KEY,
          appleApiKeyId: env.APPLE_API_KEY_ID,
          appleApiIssuer: env.APPLE_API_ISSUER,
        }
      : undefined;
  const byPassword =
    env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
      ? {
          appleId: env.APPLE_ID,
          appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: env.APPLE_TEAM_ID,
        }
      : undefined;

  const credentials = byKey ?? byPassword;
  if (credentials === undefined) {
    console.log(
      "\n  Not notarising: no Apple credentials in the environment.\n" +
        "  The application is built and will run on this machine. On anybody\n" +
        "  else's, Gatekeeper will refuse it until it is signed and notarised.\n" +
        "  See app/README.md: either an App Store Connect key or an Apple ID\n" +
        "  with an app-specific password, three variables each.\n",
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  console.log(`  Notarising ${appName}.app — this takes a few minutes.`);
  const { notarize } = await import("@electron/notarize");
  await notarize({ appPath: `${appOutDir}/${appName}.app`, ...credentials });
  console.log("  Notarised and stapled.");
};
