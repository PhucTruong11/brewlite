import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Only read account/sender metadata. This command never sends an email.
try {
  const config = parseEnv(
    readFileSync(resolve(import.meta.dirname, '..', '.env.production'), 'utf8'),
  );
  const apiKey = config.BREVO_API_KEY?.trim();
  const senderEmail = config.BREVO_SENDER_EMAIL?.trim();
  if (
    config.MAIL_PROVIDER?.trim().toLowerCase() !== 'brevo' ||
    !apiKey ||
    !senderEmail
  ) {
    throw new Error(
      'Set MAIL_PROVIDER=brevo, BREVO_API_KEY and BREVO_SENDER_EMAIL in backend/.env.production.',
    );
  }
  if (apiKey.startsWith('xsmtpsib-')) {
    throw new Error(
      'BREVO_API_KEY contains an SMTP key. Generate a key from the API keys tab, then replace this value.',
    );
  }
  const responses = await Promise.all(
    ['account', 'senders'].map((resource) =>
      fetch('https://api.brevo.com/v3/' + resource, {
        headers: { 'api-key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }),
    ),
  );
  if (responses.some((response) => !response.ok)) {
    const failures = await Promise.all(
      responses.map(async (response) => {
        const body = await response.json().catch(() => ({}));
        const message = typeof body.message === 'string' ? body.message : '';
        return {
          status: response.status,
          category: /\bip\b|ip address|unrecogni[sz]ed/i.test(message)
            ? 'IP_RESTRICTION'
            : /key.*(?:not found|invalid|expired)|invalid.*key/i.test(message)
              ? 'INVALID_API_KEY'
              : 'AUTHORIZATION_REJECTED',
        };
      }),
    );
    console.error(
      JSON.stringify({
        ok: false,
        accountStatus: responses[0].status,
        sendersStatus: responses[1].status,
        apiKeyFormat: apiKey.startsWith('xsmtpsib-')
          ? 'SMTP_KEY'
          : apiKey.startsWith('xkeysib-')
            ? 'BREVO_API_KEY'
            : 'OTHER',
        hasWhitespace: /\s/.test(apiKey),
        hasAngleBrackets: /^<|>$/.test(apiKey),
        failures,
      }),
    );
    process.exitCode = 1;
  } else {
    const [account, senderList] = await Promise.all(
      responses.map((response) => response.json()),
    );
    const sender = senderList.senders?.find(
      (entry) => entry.email?.toLowerCase() === senderEmail.toLowerCase(),
    );
    const result = {
      apiKeyValid: true,
      senderFound: Boolean(sender),
      senderActive: sender?.active === true,
      transactionalEmailEnabled: account.relay?.enabled ?? null,
    };
    console.log(JSON.stringify(result));
    if (!result.senderActive || result.transactionalEmailEnabled === false)
      process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      code: error?.name,
      message:
        error?.constructor === Error
          ? error.message
          : 'Brevo configuration check failed; credentials were not printed.',
    }),
  );
  process.exitCode = 1;
}
