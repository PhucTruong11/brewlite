import { Logger } from '@nestjs/common';
import { EmailService } from './email.service.js';

const { createTransport, sendMail } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));
vi.mock('nodemailer', () => ({ createTransport }));

describe('EmailService delivery providers', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const recipient = 'customer@example.com';
  const otp = '482917';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('MAIL_PROVIDER', undefined);
    vi.stubEnv('MAIL_HOST', 'smtp.example.com');
    vi.stubEnv('MAIL_PORT', '587');
    vi.stubEnv('MAIL_USER', 'local@example.com');
    vi.stubEnv('MAIL_PASSWORD', 'smtp-test-password');
    vi.stubEnv('MAIL_FROM', '"BrewLite Local" <local@example.com>');
    vi.stubEnv('BREVO_API_KEY', 'brevo-test-key');
    vi.stubEnv('BREVO_SENDER_EMAIL', 'sender@example.com');
    vi.stubEnv('BREVO_SENDER_NAME', 'BrewLite');
    createTransport.mockReturnValue({ sendMail });
    sendMail.mockResolvedValue({ accepted: [recipient], rejected: [] });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps SMTP as the default with the existing local settings', async () => {
    const service = new EmailService();
    expect(await service.sendOtpEmail(recipient, otp)).toBe(true);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'local@example.com', pass: 'smtp-test-password' },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"BrewLite Local" <local@example.com>',
        to: recipient,
        html: expect.stringContaining(otp),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses implicit TLS when SMTP is configured on port 465', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'smtp');
    vi.stubEnv('MAIL_PORT', '465');
    const service = new EmailService();
    expect(await service.sendOtpEmail(recipient, otp)).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );
  });

  it('sends OTP through the Brevo HTTPS API without opening SMTP', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'brevo');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messageId: 'accepted-message' }), {
        status: 201,
      }),
    );
    const service = new EmailService();
    expect(await service.sendOtpEmail(recipient, otp)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'api-key': 'brevo-test-key',
        'content-type': 'application/json',
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(options!.body as string)).toMatchObject({
      sender: { email: 'sender@example.com', name: 'BrewLite' },
      to: [{ email: recipient }],
      subject: expect.stringContaining('BrewLite'),
      htmlContent: expect.stringContaining(otp),
    });
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([400, 401, 429, 500])(
    'reports Brevo HTTP %i as a failed delivery',
    async (status) => {
      vi.stubEnv('MAIL_PROVIDER', 'brevo');
      fetchMock.mockResolvedValue(new Response('provider error', { status }));
      expect(await new EmailService().sendOtpEmail(recipient, otp)).toBe(false);
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it('does not report success for a malformed Brevo acknowledgement', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'brevo');
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    expect(await new EmailService().sendOtpEmail(recipient, otp)).toBe(false);
  });

  it('reports an HTTP timeout without logging OTPs, credentials or provider error details', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'brevo');
    fetchMock.mockRejectedValue(
      new Error('Timed out: ' + otp + ' brevo-test-key ' + recipient),
    );
    expect(await new EmailService().sendOtpEmail(recipient, otp)).toBe(false);
    const logs = JSON.stringify([
      vi.mocked(Logger.prototype.error).mock.calls,
      vi.mocked(Logger.prototype.log).mock.calls,
    ]);
    for (const secret of [otp, 'brevo-test-key', recipient])
      expect(logs).not.toContain(secret);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports SMTP rejection and removes the former OTP log fallback', async () => {
    sendMail.mockRejectedValue(
      new Error('SMTP details: ' + otp + ' smtp-test-password'),
    );
    expect(await new EmailService().sendOtpEmail(recipient, otp)).toBe(false);
    const logs = JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls);
    expect(logs).not.toContain(otp);
    expect(logs).not.toContain('smtp-test-password');
  });

  it('reports an unaccepted SMTP recipient as a failed delivery', async () => {
    sendMail.mockResolvedValue({ accepted: [], rejected: [recipient] });
    expect(await new EmailService().sendOtpEmail(recipient, otp)).toBe(false);
  });

  it.each(['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'])(
    'fails at startup when %s is missing in Brevo mode',
    (variable) => {
      vi.stubEnv('MAIL_PROVIDER', 'brevo');
      vi.stubEnv(variable, '');
      expect(() => new EmailService()).toThrow(
        'BREVO_API_KEY and BREVO_SENDER_EMAIL are required',
      );
      expect(createTransport).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown providers instead of silently falling back to SMTP', () => {
    vi.stubEnv('MAIL_PROVIDER', 'unknown');
    expect(() => new EmailService()).toThrow(
      'MAIL_PROVIDER must be smtp or brevo',
    );
    expect(createTransport).not.toHaveBeenCalled();
  });
});
