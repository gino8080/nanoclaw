#!/usr/bin/env npx tsx
import { execSync } from 'child_process';

/**
 * Controlla periodicamente se il portale Genertel è tornato online.
 * In manutenzione reindirizza a https://private.genertel.it/courtesy/it/maintenance-page
 * Quando l'URL finale non è più la maintenance page, considera il sito online e notifica.
 *
 * Uso:
 *   npx tsx scripts/check-genertel.ts              # loop ogni 5 min
 *   npx tsx scripts/check-genertel.ts --interval 10 # loop ogni 10 min
 *   npx tsx scripts/check-genertel.ts --once        # un solo check e exit
 */

const GENERTEL_URL =
  'https://go.genertel.it/pub/cc?_ri_=X0Gzc2X%3DBQjkPkSSSQG0cCkeurMnCFzgd1WuSdHAkdHpw8dSyyRbgykdd6D8haNEyEdACPth1Xzg2SvzgqK3dyJkVXtpKX%3DTSDSCC&_ei_=ERlXWFHtKEyNi7eNWSJ-aLuXQuF7K77uC6rqp72N4geG4KgrqGRCydQIrCJzJyUP_OUrTXmH_IV2-xCh5S40kAA1Tr2WOhrQ1KSS7-VbKT79HCDF0PHPZF7HTOC4nnq1qg_E4tNl1RRPj4vlanXg4FLJ5LsHGd-6qfrSFgsGsJBzGUDNSgNyrAKjpMPuscjqe3Vl1j8HcxuTJIJmYrgdtyFxthfp6MggIAM6oee8tWOsQDvGhlGGaxNuR0pnCTMJE-Q9ouRwFY6ty87Z8UpirPqGrCdHsXYIYOz2RJE.&_di_=tfsas63k81kj9nj23evkstrfte9u5jdp9k7vgjkfj55gc7e4n000';
const MAINTENANCE_MARKER = 'maintenance-page';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

async function checkGenertel(): Promise<{ online: boolean; finalUrl: string }> {
  const res = await fetch(GENERTEL_URL, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GenertelCheck/1)' },
  });
  const finalUrl = res.url || GENERTEL_URL;
  const online = !finalUrl.includes(MAINTENANCE_MARKER);
  return { online, finalUrl };
}

function notifyMacOs(title: string, body: string): void {
  try {
    const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
    execSync(`osascript -e '${script}'`, {
      stdio: 'ignore',
    });
  } catch {
    // ignore se osascript non disponibile (es. Linux)
  }
}

function parseArgs(): { once: boolean; intervalMs: number } {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const intervalIdx = args.indexOf('--interval');
  const intervalMs =
    intervalIdx >= 0 && args[intervalIdx + 1]
      ? Math.max(60_000, parseInt(args[intervalIdx + 1], 10) * 60_000)
      : DEFAULT_INTERVAL_MS;
  return { once, intervalMs };
}

async function run(): Promise<void> {
  const { once, intervalMs } = parseArgs();
  const intervalMin = intervalMs / 60_000;

  console.log(
    `Genertel check: intervallo ${intervalMin} min${once ? ', un solo check' : ''}\n`,
  );

  do {
    const when = new Date().toISOString();
    try {
      const { online, finalUrl } = await checkGenertel();
      if (online) {
        console.log(`[${when}] ✅ ONLINE — ${finalUrl}`);
        notifyMacOs(
          'Genertel online',
          'Il portale è tornato disponibile. Puoi rinnovare l’assicurazione.',
        );
        process.exit(0);
      }
      console.log(`[${when}] ⏳ Ancora in manutenzione — ${finalUrl}`);
    } catch (err) {
      console.error(`[${when}] Errore:`, err instanceof Error ? err.message : err);
    }

    if (once) process.exit(1);
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (true);
}

run();
